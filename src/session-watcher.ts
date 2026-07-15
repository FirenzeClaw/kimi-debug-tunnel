import type { ISessionClient, IStatusClient } from "./types.js";

interface WatchEntry {
  sessionId: string;
  status: "watching" | "done" | "error";
  result: string | null;
  error: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * Background session monitor — subscribes to a session via WebSocket
 * and captures the final response when the turn completes.
 * The coordinating session calls watch(), then later getResult().
 */
export class SessionWatcher {
  private watches = new Map<string, WatchEntry>();
  private sessionClient: ISessionClient;
  private statusClient: IStatusClient;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(sessionClient: ISessionClient, statusClient: IStatusClient) {
    this.sessionClient = sessionClient;
    this.statusClient = statusClient;
  }

  /**
   * Start watching a session. Returns a watch ID immediately.
   * The watcher polls the session status every 3s via WS cache
   * and captures the final text when the turn completes.
   */
  watch(sessionId: string): string {
    const watchId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.watches.set(watchId, {
      sessionId,
      status: "watching",
      result: null,
      error: null,
      createdAt: Date.now(),
      resolvedAt: null,
    });

    // Ensure global polling loop is running
    this.ensurePolling();

    process.stderr.write(`[session-watcher] Watching ${sessionId.slice(0, 12)} → ${watchId}\n`);
    return watchId;
  }

  /**
   * Get the result of a watch. Returns null if still watching.
   */
  getResult(watchId: string): { status: string; result: string | null; error: string | null } | null {
    const entry = this.watches.get(watchId);
    if (!entry) return null;
    if (entry.status === "watching") return null;
    return { status: entry.status, result: entry.result, error: entry.error };
  }

  /**
   * Complete a loop iteration: if the current watch is done, return its result
   * and optionally submit a next instruction + start a new watch.
   * Returns null if still watching.
   *
   * When nextInstruction is provided, submits the prompt first (await),
   * then starts a new watch — guaranteeing the watch captures the new turn,
   * not a stale completion event.
   */
  async continueWatch(
    watchId: string,
    nextInstruction?: string
  ): Promise<{
    ready: boolean;
    result?: string | null;
    next_watch_id?: string;
    error?: string | null;
  } | null> {
    const entry = this.watches.get(watchId);
    if (!entry) return { ready: false, error: "watch not found" };
    if (entry.status === "watching") return null; // not ready yet

    // Clean up the completed watch
    this.watches.delete(watchId);

    const response = {
      ready: true,
      result: entry.result,
      error: entry.error,
    };

    // Auto-submit next instruction and start watching (now properly sequenced)
    if (nextInstruction) {
      const sessionId = entry.sessionId;

      try {
        await this.sessionClient.submitPrompt(sessionId, nextInstruction, { autoApprove: true });
        // Now safe to start watching — the new turn is in flight
        const newWatchId = this.watch(sessionId);
        return { ...response, next_watch_id: newWatchId };
      } catch (err) {
        process.stderr.write(`[session-watcher] continue submit failed: ${(err as Error).message}\n`);
        // Even on failure, try watching (the prompt may have been injected mid-turn)
        const newWatchId = this.watch(sessionId);
        return { ...response, next_watch_id: newWatchId };
      }
    }

    return response;
  }

  /** Clean up completed watches older than 5 minutes. */
  private cleanup(): void {
    const cutoff = Date.now() - 300000;
    for (const [id, entry] of this.watches) {
      if (entry.status !== "watching" && entry.createdAt < cutoff) {
        this.watches.delete(id);
      }
    }
  }

  private ensurePolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.pollAll(), 3000);
  }

  private async pollAll(): Promise<void> {
    const active = [...this.watches.entries()].filter(([, e]) => e.status === "watching");
    if (active.length === 0) {
      // Stop polling when nothing to watch
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
      return;
    }

    this.cleanup();

    for (const [watchId, entry] of active) {
      try {
        // Check WS cache first (zero I/O), fall back to REST
        const cached = this.statusClient.getCachedStatus(entry.sessionId);
        if (cached === "idle" || cached === "aborted" || cached === "awaiting_approval") {
          await this.resolveWatch(watchId, entry);
          continue;
        }

        // If no WS cache hit, try REST status
        const status = await this.statusClient.getSessionStatus(entry.sessionId);

        if (status === "idle" || status === "aborted" || status === "awaiting_approval") {
          await this.resolveWatch(watchId, entry);
        }
      } catch {
        // Polling error — retry next interval
      }
    }
  }

  private async resolveWatch(watchId: string, entry: WatchEntry): Promise<void> {
    try {
      // Fetch the last assistant response using semantic method
      const blocks = await this.sessionClient.getSessionMessages(entry.sessionId, { pageSize: 5, role: "assistant" });

      // Get text from the last assistant message
      let text = "";
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          text = block.text; // last text block wins
        }
      }

      entry.status = "done";
      entry.result = text || "(empty response)";
      entry.resolvedAt = Date.now();
      this.watches.set(watchId, entry);

      process.stderr.write(`[session-watcher] ${watchId} resolved (${text.length} chars)\n`);
    } catch (err) {
      entry.status = "error";
      entry.error = (err as Error).message;
      entry.resolvedAt = Date.now();
      this.watches.set(watchId, entry);
    }
  }
}
