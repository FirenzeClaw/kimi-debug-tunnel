import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { LogEntry, SessionLog } from "./session-manager.js";

function extractPromptText(entry: Record<string, unknown>): string {
  const input = entry.input as Array<{ type: string; text: string }> | undefined;
  if (!input) return "";
  for (const part of input) {
    if (part.type === "text" && part.text) {
      return part.text;
    }
  }
  return "";
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

export async function readSessionLog(
  sessionPath: string,
  sessionId: string,
  options: { afterLine?: number; limit?: number; includeThinking?: boolean } = {}
): Promise<SessionLog | null> {
  const { afterLine = 0, limit = 50, includeThinking = false } = options;

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
            content = truncateText(extractPromptText(entry), 500);
            entryType = "user_prompt";
          } else if (
            entry.type === "context.append_loop_event" &&
            entry.event?.type === "content.part"
          ) {
            if (entry.event.part.type === "text") {
              content = truncateText(entry.event.part.text, 300);
              entryType = "assistant_text";
            } else if (entry.event.part.type === "think") {
              if (!includeThinking) continue;
              content = truncateText(entry.event.part.think, 200);
              entryType = "thinking";
            } else {
              continue;
            }
          } else if (
            entry.type === "context.append_loop_event" &&
            entry.event?.type === "tool.call"
          ) {
            content = `${entry.event.name}(${JSON.stringify(entry.event.args || {})})`;
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

    const recentEntries = entries.slice(-limit);

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
