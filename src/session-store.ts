import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionInfo } from "./session-manager.js";

interface StateJson {
  createdAt: string;
  updatedAt: string;
  title: string;
  agents: Record<string, { type: string; homedir: string }>;
  lastPrompt: string;
}

function extractWorkdir(sessionRelPath: string): string {
  const parts = sessionRelPath.replace(/\\/g, "/").split("/");
  const wdPart = parts.find((p) => p.startsWith("wd_")) || "";
  return wdPart.replace(/^wd_/, "").replace(/_/g, "/");
}

function sessionInfoFromState(sd: string, wd: string, state: StateJson): SessionInfo {
  return {
    id: sd,
    workdir: extractWorkdir(wd),
    title: state.title || "(untitled)",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    agentCount: Object.keys(state.agents || {}).length,
    lastPrompt: state.lastPrompt || "",
  };
}

export class SessionStore {
  private baseDir: string;
  private cache: Map<string, SessionInfo> | null = null;
  private pathCache: Map<string, string> | null = null;

  constructor(kimiCodeHome: string) {
    this.baseDir = join(kimiCodeHome, "sessions");
  }

  private async scan(): Promise<{ sessions: SessionInfo[]; paths: Map<string, string> }> {
    const sessions: SessionInfo[] = [];
    const paths = new Map<string, string>();

    try {
      const workdirs = await readdir(this.baseDir);

      for (const wd of workdirs) {
        if (!wd.startsWith("wd_")) continue;
        const wdPath = join(this.baseDir, wd);
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
            sessions.push(sessionInfoFromState(sd, wd, state));
            paths.set(sd, sessionPath);
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
    return { sessions, paths };
  }

  async listAll(): Promise<SessionInfo[]> {
    const { sessions } = await this.scan();
    return sessions;
  }

  async findById(sessionId: string): Promise<SessionInfo | null> {
    const { sessions } = await this.scan();
    return sessions.find((s) => s.id === sessionId) || null;
  }

  async findPath(sessionId: string): Promise<string | null> {
    const { paths } = await this.scan();
    return paths.get(sessionId) || null;
  }

  invalidateCache(): void {
    this.cache = null;
    this.pathCache = null;
  }
}
