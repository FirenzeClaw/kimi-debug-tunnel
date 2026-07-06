#!/usr/bin/env node
/**
 * Kimi Session Completion Monitor v2
 *
 * Long-lived WebSocket listener that tracks prompt lifecycle on a target session.
 * Writes real-time status to a JSON file for the coordinating session to read.
 *
 * Key features:
 *   - Pre-check via REST API to catch already-completed prompts (race condition fix)
 *   - Timestamped heartbeat so coordinating session knows the script is alive
 *   - Multi-prompt tracking (stays alive across multiple rounds)
 *   - Grace period after completion before status is cleared
 *
 * Usage:
 *   node watch-completion.mjs <session_id> [--output <path>]
 *
 * The coordinating session reads the status file:
 *   {
 *     "sessionId": "xxx",
 *     "status": "connecting" | "watching" | "completed" | "error",
 *     "result": "assistant text...",
 *     "promptId": "prompt_xxx",
 *     "promptCount": 3,
 *     "completedAt": "2026-07-06T...",
 *     "heartbeat": "2026-07-06T...",
 *     "pid": 12345
 *   }
 *
 * Prerequisites:
 *   - Kimi Server running: kimi web --no-open --port 5494
 *   - KIMI_SERVER_TOKEN env var set (or --token argument)
 */

import { WebSocket } from "ws";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionId = args[0];
if (!sessionId) {
  console.error("Usage: node watch-completion.mjs <session_id> [--output <path>]");
  process.exit(1);
}

const outputIdx = args.indexOf("--output");
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "./watch-status.json";

// Ensure output directory exists
try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}

const tokenIdx = args.indexOf("--token");
const token = tokenIdx >= 0 ? args[tokenIdx + 1] : process.env.KIMI_SERVER_TOKEN || "";
const baseUrl = process.env.KIMI_SERVER_URL || "http://127.0.0.1:5494";
const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
const restUrl = baseUrl;

// ── State ───────────────────────────────────────────────────────────────────────

const status = {
  sessionId,
  status: "connecting",
  result: "",
  promptId: "",
  promptCount: 0,
  completedAt: null,
  heartbeat: new Date().toISOString(),
  pid: process.pid,
};

function writeStatus() {
  status.heartbeat = new Date().toISOString();
  try {
    writeFileSync(outputPath, JSON.stringify(status, null, 2), "utf-8");
  } catch {}
}

// Heartbeat every 2 seconds while alive
let heartbeatTimer = setInterval(writeStatus, 2000);

// ── REST helpers ────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const resp = await fetch(`${restUrl}${path}`, {
    headers: {
      Accept: "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.code === 0 ? json.data : null;
}

/**
 * Pre-check: has the session already completed a prompt before we subscribed?
 * Query the last assistant message via REST to catch fast completions.
 */
async function preCheckCompletion() {
  try {
    const msgs = await apiGet(
      `/api/v1/sessions/${sessionId}/messages?page_size=3&role=assistant`
    );
    if (!msgs || !msgs.items || msgs.items.length === 0) return false;

    // Get the last assistant message
    const lastMsg = msgs.items[msgs.items.length - 1];
    const textBlocks = (lastMsg.content || []).filter(
      (b) => b.type === "text" && b.text
    );
    if (textBlocks.length === 0) return false;

    const text = textBlocks.map((b) => b.text).join("");

    // Check if this message is recent (within the last minute — likely a fast completion)
    const msgTime = new Date(lastMsg.created_at).getTime();
    const now = Date.now();
    if (now - msgTime < 120000) {
      status.status = "completed";
      status.result = text;
      status.promptId = lastMsg.prompt_id || "";
      status.promptCount = 1;
      status.completedAt = lastMsg.created_at;
      writeStatus();
      process.stderr.write(
        `[watch] PRE-CHECK: already completed (${text.length} chars, prompt: ${lastMsg.prompt_id?.slice(0, 12) || "?"})\n`
      );
      return true;
    }
  } catch (e) {
    process.stderr.write(`[watch] Pre-check failed: ${e.message}\n`);
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Pre-check for already-completed prompt
  const alreadyDone = await preCheckCompletion();
  if (alreadyDone) {
    process.stderr.write(
      `[watch] Task already completed before watch started. Result written to ${outputPath}.\n`
    );
    process.stderr.write(`[watch] Staying alive for 60s grace period...\n`);
    // Stay alive for 60 seconds so the coordinating session has time to read the result
    setTimeout(() => {
      process.stderr.write("[watch] Grace period ended, exiting.\n");
      process.exit(0);
    }, 60000);
    return;
  }

  // Step 2: Connect WebSocket and wait for prompt.completed
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let helloDone = false;
  let subscribed = false;
  let assistantText = "";
  let currentPromptId = "";
  let promptCount = 0;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "client_hello",
        id: randomUUID(),
        payload: { client_id: "completion-watcher-v2" },
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      const type = frame.type;

      if (type === "server_hello" && !helloDone) {
        helloDone = true;
        ws.send(
          JSON.stringify({
            type: "subscribe",
            id: randomUUID(),
            payload: { session_ids: [sessionId] },
          })
        );
        return;
      }

      if ((type === "subscribe_ack" || type === "ack") && !subscribed) {
        subscribed = true;
        status.status = "watching";
        writeStatus();
        process.stderr.write(
          `[watch] Watching ${sessionId.slice(0, 12)} (output: ${outputPath}, pid: ${process.pid})\n`
        );
        return;
      }

      // ── Track prompt lifecycle ────────────────────────────────────────────

      if (type === "prompt.submitted") {
        promptCount++;
        currentPromptId = frame.payload?.promptId || "";
        assistantText = "";
        status.promptId = currentPromptId;
        status.promptCount = promptCount;
        status.status = "watching";
        status.result = "";
        writeStatus();
        process.stderr.write(
          `[watch] Prompt #${promptCount}: ${currentPromptId.slice(0, 12)} submitted\n`
        );
      }

      if (type === "assistant.delta") {
        assistantText += frame.payload?.delta || "";
      }

      if (type === "prompt.completed") {
        status.status = "completed";
        status.result = assistantText;
        status.completedAt = new Date().toISOString();
        writeStatus();
        process.stderr.write(
          `[watch] COMPLETED #${promptCount}: ${assistantText.length} chars\n`
        );

        // Reset for next prompt after a 10s grace period
        setTimeout(() => {
          if (status.promptId === currentPromptId) {
            status.status = "watching";
            status.result = "";
            status.promptId = "";
            writeStatus();
            process.stderr.write("[watch] Ready for next prompt\n");
          }
        }, 10000);
      }

      if (type === "turn.ended") {
        status.turnReason = frame.payload?.reason || "";
      }
    } catch {
      // Skip
    }
  });

  ws.on("error", (err) => {
    status.status = "error";
    status.error = err.message;
    writeStatus();
    process.stderr.write(`[watch] WS error: ${err.message}\n`);
  });

  ws.on("close", () => {
    clearInterval(heartbeatTimer);
    if (status.status !== "completed" && status.status !== "error") {
      status.status = "disconnected";
      writeStatus();
    }
    process.stderr.write("[watch] Disconnected\n");
  });
}

main().catch((err) => {
  status.status = "error";
  status.error = err.message;
  writeStatus();
  process.stderr.write(`[watch] Fatal: ${err.message}\n`);
  process.exit(1);
});
