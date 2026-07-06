import type { WireClient } from "./wire-client.js";

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
  private wireClient: WireClient;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(wireClient: WireClient) {
    this.wireClient = wireClient;
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
   */
  continueWatch(
    watchId: string,
    nextInstruction?: string
  ): {
    ready: boolean;
    result?: string | null;
    next_watch_id?: string;
    error?: string | null;
  } | null {
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

    // Auto-submit next instruction and start watching
    if (nextInstruction) {
      const sessionId = entry.sessionId;
      // Save original session and switch to task session
      const originalSession = this.wireClient.getSessionId();
      this.wireClient.setSessionId(sessionId);

      // Submit next instruction asynchronously
      this.wireClient.submitPrompt(nextInstruction, { autoApprove: true })
        .then(() => {
          // Start watching the new turn
          const newId = this.watch(sessionId);
          // Store the new watch ID... but we can't return it from an async callback
          // So we handle this synchronously below
        })
        .catch((err) => {
          process.stderr.write(`[session-watcher] continue submit failed: ${err.message}\n`);
        });

      this.wireClient.setSessionId(originalSession);

      // Start watching immediately (the submit happens above, but we start watching now)
      const newWatchId = this.watch(sessionId);
      return { ...response, next_watch_id: newWatchId };
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
        const cached = this.wireClient.getCachedStatus(entry.sessionId);
        if (cached === "idle" || cached === "aborted") {
          await this.resolveWatch(watchId, entry);
          continue;
        }

        // If no WS cache hit, try REST status
        const originalSession = this.wireClient.getSessionId();
        this.wireClient.setSessionId(entry.sessionId);
        const status = await this.wireClient.getSessionStatus();
        this.wireClient.setSessionId(originalSession);

        if (status === "idle" || status === "aborted") {
          await this.resolveWatch(watchId, entry);
        }
      } catch {
        // Polling error — retry next interval
      }
    }
  }

  private async resolveWatch(watchId: string, entry: WatchEntry): Promise<void> {
    try {
      // Fetch the last assistant response
      const originalSession = this.wireClient.getSessionId();
      this.wireClient.setSessionId(entry.sessionId);

      const msgsResp = await this.wireClient.apiGet<{ items: Array<{ content: Array<{ type: string; text?: string }> }> }>(
        `/api/v1/sessions/${entry.sessionId}/messages?page_size=5&role=assistant`
      );

      this.wireClient.setSessionId(originalSession);

      const items = msgsResp?.items || [];
      // Get text from the last assistant message
      let text = "";
      for (let i = items.length - 1; i >= 0; i--) {
        for (const block of items[i].content || []) {
          if (block.type === "text" && block.text) {
            text = block.text;
            break;
          }
        }
        if (text) break;
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
