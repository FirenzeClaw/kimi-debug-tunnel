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
 * - Replaces lone surrogates (U+D800-U+DFFF) with U+FFFD
 * - Replaces control characters (U+0000-U+001F except \\t \\n \\r) with spaces
 * - Collapses multiple consecutive spaces from control char replacement
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/(?<!\\)\\x([0-9a-fA-F]{2})/g, "\\\\x$1")
    .replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, "\\\\u$1")
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/ {2,}/g, " ");
}

// ── Shared wire.jsonl parser (v2.11 — single source of truth) ──────────────────

export interface WireEvent {
  line: number;
  type: "turn.prompt" | "tool.call" | "assistant.text" | "step.end" | "other";
  time: number;
  turnId?: string;
  step?: number;
  // Event-specific payloads
  promptText?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  assistantText?: string;
  finishReason?: string;
  // Raw entry for edge cases
  raw: Record<string, unknown>;
}

/**
 * Parse a raw wire.jsonl entry into a typed WireEvent.
 * Centralizes the JSON.shape → event dispatch that was previously
 * duplicated across readSessionLog, listIORecords, and pollSessionStatus.
 */
export function parseWireEvent(line: string, lineNum: number): WireEvent | null {
  try {
    const entry = JSON.parse(line);
    const time = (entry.time as number) || 0;
    const raw = entry as Record<string, unknown>;

    // turn.prompt
    if (entry.type === "turn.prompt" && time) {
      return {
        line: lineNum,
        type: "turn.prompt",
        time,
        promptText: extractPromptText(raw),
        raw,
      };
    }

    // context.append_loop_event — dispatch on event.type
    if (entry.type === "context.append_loop_event") {
      const event = entry.event as Record<string, unknown> | undefined;
      if (!event) {
        return { line: lineNum, type: "other", time, raw };
      }

      const step = event.step as number | undefined;

      if (event.type === "content.part") {
        const part = event.part as Record<string, string> | undefined;
        if (part?.type === "text" && part.text) {
          return {
            line: lineNum, type: "assistant.text", time,
            step, turnId: String(time),
            assistantText: part.text, raw,
          };
        }
      }

      if (event.type === "tool.call") {
        return {
          line: lineNum, type: "tool.call", time,
          step,
          toolName: event.name as string,
          toolArgs: event.args as Record<string, unknown> | undefined,
          raw,
        };
      }

      if (event.type === "step.end") {
        return {
          line: lineNum, type: "step.end", time,
          finishReason: event.finishReason as string | undefined,
          raw,
        };
      }
    }

    // Fallback for other event types (kept for inclusive scanning)
    return { line: lineNum, type: "other", time, raw };
  } catch {
    return null;
  }
}

/**
 * Read wire.jsonl and parse all lines into an array of WireEvent.
 * Shared by readSessionLog, listIORecords, and pollSessionStatus.
 *
 * @param tailOnly - if > 0, only parse the last N lines (used by pollSessionStatus).
 * @param includeThinking - if true, include "thinking" content.part events as assistant.text.
 */
export async function parseWireJsonl(
  sessionId: string,
  opts: { tailOnly?: number; includeThinking?: boolean } = {}
): Promise<{ events: WireEvent[]; totalLines: number } | null> {
  const { tailOnly = 0, includeThinking = false } = opts;
  const sessionPath = await findSessionPath(sessionId);
  if (!sessionPath) return null;
  const wirePath = join(sessionPath, "agents", "main", "wire.jsonl");

  try {
    const raw = await readFile(wirePath, "utf-8");
    const allLines = raw.split("\n").filter((l) => l.trim());
    const linesToParse = tailOnly > 0 ? allLines.slice(-tailOnly) : allLines;
    const lineOffset = tailOnly > 0 ? allLines.length - linesToParse.length : 0;

    const events: WireEvent[] = [];
    for (let i = 0; i < linesToParse.length; i++) {
      const lineNum = lineOffset + i + 1;
      const event = parseWireEvent(linesToParse[i], lineNum);
      if (event) {
        // For includeThinking: re-dispatch "think" content parts
        if (!includeThinking && event.type === "other") {
          // Check if it's a "think" content part we should skip
          try {
            const entry = JSON.parse(linesToParse[i]);
            if (
              entry.type === "context.append_loop_event" &&
              entry.event?.type === "content.part" &&
              entry.event?.part?.type === "think"
            ) {
              continue; // Skip thinking when not requested
            }
          } catch { /* keep */ }
        }
        events.push(event);
      }
    }

    return { events, totalLines: allLines.length };
  } catch {
    return null;
  }
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
  const parsed = await parseWireJsonl(sessionId, { includeThinking });
  if (!parsed) return null;
  const { events, totalLines } = parsed;

  const entries: LogEntry[] = [];
  let turnId = "";
  let lastTurnPrompt: LogEntry | null = null;
  let lastAssistantText: LogEntry | null = null;
  let lastToolCalls: string[] = [];
  let lastTurnComplete = false;
  let lastTurnFinishReason: string | null = null;
  const currentTurnToolCalls: string[] = [];

  for (const event of events) {
    if (event.line <= afterLine) continue;

    let content = "";
    let entryType: string = event.type;

    switch (event.type) {
      case "turn.prompt": {
        turnId = String(event.time);
        lastTurnPrompt = {
          line: event.line, type: "turn.prompt",
          content: sanitizeText(event.promptText || ""),
          time: event.time, turnId,
        };
        lastAssistantText = null;
        lastToolCalls = [];
        lastTurnComplete = false;
        lastTurnFinishReason = null;
        content = truncateText(sanitizeText(event.promptText || ""), maxContentLength);
        entryType = "user_prompt";
        break;
      }
      case "assistant.text": {
        lastAssistantText = {
          line: event.line, type: "assistant_text",
          content: event.assistantText || "",
          time: event.time, turnId, step: event.step,
        };
        content = truncateText(sanitizeText(event.assistantText || ""), maxContentLength);
        entryType = "assistant_text";
        break;
      }
      case "tool.call": {
        currentTurnToolCalls.push(event.toolName || "unknown");
        if (!lastToolCalls.length) lastToolCalls = [...currentTurnToolCalls];
        content = truncateText(
          sanitizeText(`${event.toolName || "?"}(${JSON.stringify(event.toolArgs || {})})`),
          200
        );
        entryType = "tool_call";
        break;
      }
      case "step.end": {
        lastTurnComplete = event.finishReason === "end_turn";
        lastTurnFinishReason = event.finishReason || null;
        content = `finish: ${event.finishReason || "unknown"}`;
        entryType = "step_end";
        break;
      }
      default:
        continue; // skip untyped/thinking events
    }

    entries.push({
      line: event.line, type: entryType, content,
      time: event.time, turnId, step: event.step,
    });
  }

  const recentEntries = afterLine === 0
    ? entries.slice(0, limit)
    : entries.slice(-limit);

  return {
    sessionId, totalLines, recentEntries,
    lastTurnPrompt, lastAssistantText, lastToolCalls,
    lastTurnComplete, lastTurnFinishReason,
  };
}

// ── IO records ─────────────────────────────────────────────────────────────────

export async function listIORecords(
  sessionId: string,
  options: { limit?: number; maxContentLength?: number } = {}
): Promise<IORecordsResult | null> {
  const { limit = 40, maxContentLength = 2000 } = options;
  const parsed = await parseWireJsonl(sessionId);
  if (!parsed) return null;
  const { events } = parsed;

  const records: IORecord[] = [];
  let turnIndex = 0;
  let stepCount = 0;
  let lastAssistantText = "";

  for (const event of events) {
    if (event.type === "turn.prompt") {
      if (lastAssistantText) {
        records.push({
          turn: turnIndex, type: "assistant",
          content: truncateText(sanitizeText(lastAssistantText), maxContentLength),
          time: 0, stepCount,
        });
        lastAssistantText = "";
      }
      turnIndex++;
      stepCount = 0;
      records.push({
        turn: turnIndex, type: "user",
        content: truncateText(sanitizeText(event.promptText || ""), maxContentLength),
        time: event.time,
      });
    }
    if (event.type === "assistant.text") {
      lastAssistantText = event.assistantText || "";
    }
    if (event.type === "tool.call") {
      stepCount++;
    }
  }

  if (lastAssistantText) {
    records.push({
      turn: turnIndex, type: "assistant",
      content: truncateText(sanitizeText(lastAssistantText), maxContentLength),
      time: 0, stepCount,
    });
  }

  return { sessionId, totalTurns: turnIndex, records: records.slice(-limit) };
}

// ── Status polling ─────────────────────────────────────────────────────────────

export async function pollSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  const parsed = await parseWireJsonl(sessionId, { tailOnly: 20 });
  if (!parsed) return null;
  const { events, totalLines } = parsed;

  let isAwaiting = false;
  let hasError = false;
  let inSwarm = false;
  let lastTurn = 0;
  let toolCallsInTurn = 0;
  let lastEndTurnIdx = -1;
  let lastTurnPromptIdx = -1;
  let lastToolCallIdx = -1;

  for (const event of events) {
    if (event.type === "turn.prompt") { lastTurn++; lastTurnPromptIdx = event.line; }
    if (event.type === "step.end" && event.finishReason === "end_turn") {
      lastEndTurnIdx = event.line;
    }
    if (event.type === "tool.call") { lastToolCallIdx = event.line; toolCallsInTurn++; }

    // Check raw for awaiting/error/swarm — these don't have dedicated WireEvent types
    const typeStr = (event.raw.type as string) || "";
    if (typeStr.includes("awaiting_approval")) isAwaiting = true;
    if (typeStr.includes("error")) hasError = true;
    if (JSON.stringify(event.raw).includes("swarm")) inSwarm = true;
  }

  let state: SessionStatus["state"];
  const alerts: string[] = [];

  if (isAwaiting) {
    state = "awaiting_approval";
    alerts.push("Session 等待工具审批 — auto_mode 可能未生效");
  } else if (lastEndTurnIdx > lastTurnPromptIdx && lastEndTurnIdx >= 0) {
    state = "done";
  } else if (lastEndTurnIdx >= 0 && lastTurnPromptIdx < 0) {
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
    sessionId, state, totalLines, lastTurn, toolCallsInTurn,
    complete: state === "done", alerts,
  };
}
