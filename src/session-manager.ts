import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME ||
  join(process.env.HOME || process.env.USERPROFILE || "C:/Users/FirenzeClaw", ".kimi-code");

export interface SessionInfo {
  id: string;
  workdir: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  agentCount: number;
  lastPrompt: string;
}

interface StateJson {
  createdAt: string;
  updatedAt: string;
  title: string;
  agents: Record<string, { type: string; homedir: string }>;
  lastPrompt: string;
}

function extractWorkdir(sessionRelPath: string): string {
  // session path format: sessions/wd_<workdir_hash>/session_<uuid>
  // We extract the workdir name part after "wd_"
  const parts = sessionRelPath.replace(/\\/g, "/").split("/");
  const wdPart = parts.find((p) => p.startsWith("wd_")) || "";
  return wdPart.replace(/^wd_/, "").replace(/_/g, "/");
}

export async function listSessions(): Promise<SessionInfo[]> {
  const sessionsDir = join(KIMI_CODE_HOME, "sessions");
  const sessions: SessionInfo[] = [];

  try {
    const workdirs = await readdir(sessionsDir);

    for (const wd of workdirs) {
      if (!wd.startsWith("wd_")) continue;
      const wdPath = join(sessionsDir, wd);
      const wdStat = await stat(wdPath);
      if (!wdStat.isDirectory()) continue;

      const sessionDirs = await readdir(wdPath);
      for (const sd of sessionDirs) {
        if (!sd.startsWith("session_") && !sd.startsWith("ses_")) continue;
        const sessionPath = join(wdPath, sd);
        const statePath = join(sessionPath, "state.json");

        try {
          const stateRaw = await readFile(statePath, "utf-8");
          const state: StateJson = JSON.parse(stateRaw);

          sessions.push({
            id: sd,
            workdir: extractWorkdir(wd),
            title: state.title || "(untitled)",
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            agentCount: Object.keys(state.agents || {}).length,
            lastPrompt: state.lastPrompt || "",
          });
        } catch {
          // Skip sessions with unreadable state
        }
      }
    }
  } catch {
    // sessions dir may not exist
  }

  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  return sessions;
}

export async function getSessionInfo(sessionId: string): Promise<SessionInfo | null> {
  const sessionsDir = join(KIMI_CODE_HOME, "sessions");

  try {
    const workdirs = await readdir(sessionsDir);

    for (const wd of workdirs) {
      if (!wd.startsWith("wd_")) continue;
      const wdPath = join(sessionsDir, wd);
      const sessionPath = join(wdPath, sessionId);
      const statePath = join(sessionPath, "state.json");

      try {
        const stateRaw = await readFile(statePath, "utf-8");
        const state: StateJson = JSON.parse(stateRaw);

        return {
          id: sessionId,
          workdir: extractWorkdir(wd),
          title: state.title || "(untitled)",
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          agentCount: Object.keys(state.agents || {}).length,
          lastPrompt: state.lastPrompt || "",
        };
      } catch {
        continue;
      }
    }
  } catch {
    // sessions dir may not exist
  }

  return null;
}

export async function sendPromptToSession(
  sessionId: string,
  prompt: string
): Promise<{ success: boolean; message: string }> {
  const sessionsDir = join(KIMI_CODE_HOME, "sessions");

  try {
    const workdirs = await readdir(sessionsDir);

    for (const wd of workdirs) {
      if (!wd.startsWith("wd_")) continue;
      const sessionPath = join(sessionsDir, wd, sessionId);
      const statePath = join(sessionPath, "state.json");

      try {
        await stat(statePath);
      } catch {
        continue;
      }

      // Write prompt as a new entry in wire.jsonl
      const wirePath = join(sessionPath, "agents", "main", "wire.jsonl");
      const entry = JSON.stringify({
        role: "user",
        content: prompt,
        timestamp: new Date().toISOString(),
        source: "debug-tunnel",
      });

      try {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(wirePath, entry + "\n", "utf-8");
        return {
          success: true,
          message: `Prompt sent to session ${sessionId}`,
        };
      } catch (err) {
        return {
          success: false,
          message: `Failed to write wire file: ${(err as Error).message}`,
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      message: `Failed to access sessions: ${(err as Error).message}`,
    };
  }

  return {
    success: false,
    message: `Session ${sessionId} not found`,
  };
}

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

async function findSessionPath(sessionId: string): Promise<string | null> {
  const sessionsDir = join(KIMI_CODE_HOME, "sessions");

  try {
    const workdirs = await readdir(sessionsDir);

    for (const wd of workdirs) {
      if (!wd.startsWith("wd_")) continue;
      const sessionPath = join(sessionsDir, wd, sessionId);
      try {
        await stat(join(sessionPath, "state.json"));
        return sessionPath;
      } catch {
        continue;
      }
    }
  } catch {
    // sessions dir may not exist
  }

  return null;
}

export async function readSessionLog(
  sessionId: string,
  options: { afterLine?: number; limit?: number; includeThinking?: boolean } = {}
): Promise<SessionLog | null> {
  const { afterLine = 0, limit = 50, includeThinking = false } = options;

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

    // Track the current turn's tool calls
    const currentTurnToolCalls: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;

      try {
        const entry = JSON.parse(lines[i]);

        // Track turn ID
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
            // Reset per-turn state
            lastAssistantText = null;
            lastToolCalls = [];
            lastTurnComplete = false;
            lastTurnFinishReason = null;
          }
        }

        // Track assistant text responses
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

        // Track tool calls
        if (entry.type === "context.append_loop_event" && entry.event?.type === "tool.call") {
          if (lineNum > afterLine) {
            currentTurnToolCalls.push(entry.event.name);
            if (!lastToolCalls.length) {
              lastToolCalls = [...currentTurnToolCalls];
            }
          }
        }

        // Track step end
        if (entry.type === "context.append_loop_event" && entry.event?.type === "step.end") {
          lastTurnComplete = entry.event.finishReason === "end_turn";
          lastTurnFinishReason = entry.event.finishReason || null;
        }

        // Add to entries if after the given line
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
            continue; // Skip uninteresting entries
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

    // Limit entries
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
  } catch (err) {
    return null;
  }
}

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

export function getKimiCodeHome(): string {
  return KIMI_CODE_HOME;
}
