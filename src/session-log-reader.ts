import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findSessionPath } from "./session-store.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

export function extractPromptText(entry: Record<string, unknown>): string {
  const input = entry.input as Array<{ type: string; text: string }> | undefined;
  if (!input) return "";
  for (const part of input) {
    if (part.type === "text" && part.text) {
      return part.text;
    }
  }
  return "";
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Sanitize text to prevent downstream JSON serialization issues.
 * - Double-escapes \\xNN and \\uNNNN sequences (backslash hardening)
 *   to survive a potentially buggy downstream JSON serializer that may
 *   fail to re-escape backslashes before embedding content in a JSON string.
 * - Replaces lone surrogates (U+D800-U+DFFF) with U+FFFD
 * - Replaces control characters (U+0000-U+001F except \\t \\n \\r) with spaces
 * - Collapses multiple consecutive spaces from control char replacement
 */
export function sanitizeText(text: string): string {
  return text
    // Backslash hardening: \xNN → \\xNN, \uNNNN → \\uNNNN
    // Negative lookbehind ensures idempotency: already-hardened \\xNN is not re-hardened.
    // This ensures the content survives at least one missed escape roundtrip:
    // even if a downstream serializer only escapes the first backslash,
    // the second backslash keeps the sequence valid in JSON.
    .replace(/(?<!\\)\\x([0-9a-fA-F]{2})/g, "\\\\x$1")
    .replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, "\\\\u$1")
    // Character-level sanitization
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/ {2,}/g, " ");
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LogEntry {
  line: number;
  type: string;
  content: string;
  time: number;
  turnId?: string;
  step?: number;
}

export interface SessionLog {
  sessionId: string;
  totalLines: number;
  recentEntries: LogEntry[];
  lastTurnPrompt: LogEntry | null;
  lastAssistantText: LogEntry | null;
  lastToolCalls: string[];
  lastTurnComplete: boolean;
  lastTurnFinishReason: string | null;
}

export interface IORecord {
  turn: number;
  type: "user" | "assistant";
  content: string;
  time: number;
  stepCount?: number;
}

export interface IORecordsResult {
  sessionId: string;
  totalTurns: number;
  records: IORecord[];
}

export interface SessionStatus {
  sessionId: string;
  state: "active" | "swarm" | "awaiting_approval" | "done" | "error" | "idle";
  totalLines: number;
  lastTurn: number;
  toolCallsInTurn: number;
  complete: boolean;
  alerts: string[];
}

// ── Log reading ────────────────────────────────────────────────────────────────

export async function readSessionLog(
  sessionId: string,
  options: { afterLine?: number; limit?: number; includeThinking?: boolean; maxContentLength?: number } = {}
): Promise<SessionLog | null> {
  const { afterLine = 0, limit = 50, includeThinking = false, maxContentLength = 500 } = options;

  const sessionPath = await findSessionPath(sessionId);
  if (!sessionPath) return null;

  const wirePath = join(sessionPath, "agents", "main", "wire.jsonl");

  try {
    const raw = await readFile(wirePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    const entries: LogEntry[] = [];
    let turnId = "";
    let lastTurnPrompt: LogEntry | null = null;
    let lastAssistantText: LogEntry | null = null;
    let lastToolCalls: string[] = [];
    let lastTurnComplete = false;
    let lastTurnFinishReason: string | null = null;

    const currentTurnToolCalls: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;

      try {
        const entry = JSON.parse(lines[i]);

        if (entry.type === "turn.prompt" && entry.time) {
          turnId = String(entry.time);
          if (lineNum > afterLine) {
            lastTurnPrompt = {
              line: lineNum,
              type: "turn.prompt",
              content: extractPromptText(entry),
              time: entry.time,
              turnId,
            };
            lastAssistantText = null;
            lastToolCalls = [];
            lastTurnComplete = false;
            lastTurnFinishReason = null;
          }
        }

        if (
          entry.type === "context.append_loop_event" &&
          entry.event?.type === "content.part" &&
          entry.event?.part?.type === "text"
        ) {
          if (lineNum > afterLine) {
            lastAssistantText = {
              line: lineNum,
              type: "assistant_text",
              content: entry.event.part.text,
              time: entry.time,
              turnId,
              step: entry.event.step,
            };
          }
        }

        if (entry.type === "context.append_loop_event" && entry.event?.type === "tool.call") {
          if (lineNum > afterLine) {
            currentTurnToolCalls.push(entry.event.name);
            if (!lastToolCalls.length) {
              lastToolCalls = [...currentTurnToolCalls];
            }
          }
        }

        if (entry.type === "context.append_loop_event" && entry.event?.type === "step.end") {
          lastTurnComplete = entry.event.finishReason === "end_turn";
          lastTurnFinishReason = entry.event.finishReason || null;
        }

        if (lineNum > afterLine) {
          let content = "";
          let entryType = entry.type;

          if (entry.type === "turn.prompt") {
            content = truncateText(sanitizeText(extractPromptText(entry)), maxContentLength);
            entryType = "user_prompt";
          } else if (
            entry.type === "context.append_loop_event" &&
            entry.event?.type === "content.part"
          ) {
            if (entry.event.part.type === "text") {
              content = truncateText(sanitizeText(entry.event.part.text), maxContentLength);
              entryType = "assistant_text";
            } else if (entry.event.part.type === "think") {
              if (!includeThinking) continue;
              content = truncateText(sanitizeText(entry.event.part.think), maxContentLength);
              entryType = "thinking";
            } else {
              continue;
            }
          } else if (
            entry.type === "context.append_loop_event" &&
            entry.event?.type === "tool.call"
          ) {
            content = truncateText(
              sanitizeText(`${entry.event.name}(${JSON.stringify(entry.event.args || {})})`),
              200
            );
            entryType = "tool_call";
          } else if (
            entry.type === "context.append_loop_event" &&
            entry.event?.type === "step.end"
          ) {
            content = `finish: ${entry.event.finishReason || "unknown"}`;
            entryType = "step_end";
          } else {
            continue;
          }

          entries.push({
            line: lineNum,
            type: entryType,
            content,
            time: entry.time || 0,
            turnId,
            step: entry.event?.step,
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    const recentEntries = afterLine === 0
      ? entries.slice(0, limit)
      : entries.slice(-limit);

    return {
      sessionId,
      totalLines: lines.length,
      recentEntries,
      lastTurnPrompt,
      lastAssistantText,
      lastToolCalls,
      lastTurnComplete,
      lastTurnFinishReason,
    };
  } catch {
    return null;
  }
}

// ── IO records ─────────────────────────────────────────────────────────────────

export async function listIORecords(
  sessionId: string,
  options: { limit?: number; maxContentLength?: number } = {}
): Promise<IORecordsResult | null> {
  const { limit = 40, maxContentLength = 2000 } = options;

  const sessionPath = await findSessionPath(sessionId);
  if (!sessionPath) return null;

  const wirePath = join(sessionPath, "agents", "main", "wire.jsonl");

  try {
    const raw = await readFile(wirePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    const records: IORecord[] = [];
    let turnIndex = 0;
    let stepCount = 0;
    let lastAssistantText = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "turn.prompt" && entry.time) {
          if (lastAssistantText) {
            records.push({
              turn: turnIndex,
              type: "assistant",
              content: truncateText(sanitizeText(lastAssistantText), maxContentLength),
              time: 0,
              stepCount,
            });
            lastAssistantText = "";
          }

          turnIndex++;
          stepCount = 0;

          const prompt = sanitizeText(extractPromptText(entry));
          records.push({
            turn: turnIndex,
            type: "user",
            content: truncateText(prompt, maxContentLength),
            time: entry.time,
          });
        }

        if (entry.type === "context.append_loop_event") {
          if (entry.event?.type === "content.part" && entry.event?.part?.type === "text") {
            lastAssistantText = entry.event.part.text;
          }
          if (entry.event?.type === "tool.call") {
            stepCount++;
          }
        }
      } catch {
        // skip
      }
    }

    if (lastAssistantText) {
      records.push({
        turn: turnIndex,
        type: "assistant",
        content: truncateText(sanitizeText(lastAssistantText), maxContentLength),
        time: 0,
        stepCount,
      });
    }

    return {
      sessionId,
      totalTurns: turnIndex,
      records: records.slice(-limit),
    };
  } catch {
    return null;
  }
}

// ── Status polling ─────────────────────────────────────────────────────────────

export async function pollSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  const sessionPath = await findSessionPath(sessionId);
  if (!sessionPath) return null;

  const wirePath = join(sessionPath, "agents", "main", "wire.jsonl");

  try {
    const raw = await readFile(wirePath, "utf-8");
    const allLines = raw.split("\n").filter((l) => l.trim());
    const tailSize = Math.min(allLines.length, 20);
    const recentLines = allLines.slice(-tailSize);

    let isAwaiting = false;
    let hasError = false;
    let inSwarm = false;
    let lastTurn = 0;
    let toolCallsInTurn = 0;
    // Track the line index of the most recent critical events
    let lastEndTurnIdx = -1;
    let lastTurnPromptIdx = -1;
    let lastToolCallIdx = -1;

    for (let i = 0; i < recentLines.length; i++) {
      try {
        const entry = JSON.parse(recentLines[i]);
        const type = entry.type || "";
        // Map recent index back to actual line number
        const actualIdx = allLines.length - tailSize + i;

        if (type === "turn.prompt") { lastTurn++; lastTurnPromptIdx = actualIdx; }
        if (type.includes("awaiting_approval")) isAwaiting = true;
        if (type === "context.append_loop_event") {
          const eventType = entry.event?.type || "";
          if (eventType === "step.end" && entry.event?.finishReason === "end_turn") {
            lastEndTurnIdx = actualIdx;
          }
          if (eventType === "tool.call") { lastToolCallIdx = actualIdx; toolCallsInTurn++; }
        }
        if (type.includes("error")) hasError = true;
        if (JSON.stringify(entry).includes("swarm")) inSwarm = true;
      } catch { /* skip */ }
    }

    let state: SessionStatus["state"];
    const alerts: string[] = [];

    // Priority order: awaiting_approval > done > swarm > active > error > idle
    if (isAwaiting) {
      state = "awaiting_approval";
      alerts.push("Session 等待工具审批 — auto_mode 可能未生效");
    } else if (lastEndTurnIdx > lastTurnPromptIdx && lastEndTurnIdx >= 0) {
      // end_turn happened after the last turn.prompt → turn is truly done
      state = "done";
    } else if (lastEndTurnIdx >= 0 && lastTurnPromptIdx < 0) {
      // first turn, end_turn detected but no follow-up turn.prompt → done
      state = "done";
    } else if (inSwarm) {
      state = "swarm";
    } else if (lastToolCallIdx >= 0 && lastToolCallIdx > lastEndTurnIdx && lastToolCallIdx > lastTurnPromptIdx) {
      state = "active";
    } else if (hasError) {
      state = "error";
      alerts.push("检测到错误条目");
    } else {
      state = "idle";
    }

    return {
      sessionId,
      state,
      totalLines: allLines.length,
      lastTurn,
      toolCallsInTurn,
      complete: state === "done",
      alerts,
    };
  } catch {
    return null;
  }
}
