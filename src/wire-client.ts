/**
 * Kimi Server REST API client with WebSocket push notifications.
 *
 * Uses the local Kimi Code server REST API for commands (submit prompt, create session)
 * and WebSocket event streaming for real-time status changes — eliminating polling.
 *
 * Prerequisites: kimi web --no-open --port <port>
 * Token: printed at startup or available from the web UI URL hash.
 */

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

interface KimiContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  tool_call_id?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

interface KimiMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: KimiContentBlock[];
  created_at: string;
}

interface KimiApiResponse<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

export interface TurnPromptResponse {
  promptId: string;
  finalText: string;
  thinkingText: string;
  status: string;
  messages: KimiContentBlock[];
}

export interface CreateSessionOptions {
  cwd: string;
  title?: string;
  permissionMode?: "manual" | "yolo" | "auto";
  model?: string;
  thinking?: string;
}

// ── WebSocket event types ────────────────────────────────────────────────────────

interface WsFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

interface SessionEvent {
  type: string;
  seq: number;
  epoch: string;
  session_id: string;
  timestamp: string;
  payload: {
    type: string;
    status?: string;
    previous_status?: string;
    current_prompt_id?: string;
    reason?: string;
    turnId?: number;
  };
}

export class WireClient {
  private baseUrl: string;
  private token: string;
  private sessionId: string;
  private connected = false;

  // WebSocket push layer
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private wsClientId: string;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsSubscribedSessions = new Set<string>();
  // Event-driven wait: resolve when status changes to idle
  private statusResolvers = new Map<string, Array<{ resolve: (v: string) => void; reject: (e: Error) => void }>>();
  // WS-pushed session state cache — zero-I/O alternative to wire.jsonl parsing
  private sessionStateCache = new Map<string, { status: string; lastTurnId?: number; lastText?: string; updatedAt: number }>();
  // Optional watch output: write completion status to a file for coordinating session
  private watchOutputPath: string | null = null;
  private watchAssistantText = "";
  private watchPromptCount = 0;

  constructor(sessionId?: string) {
    this.baseUrl =
      process.env.KIMI_SERVER_URL || "http://127.0.0.1:5494";
    this.token =
      process.env.KIMI_SERVER_TOKEN || "";
    this.sessionId = sessionId || "";
    this.wsUrl = this.baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
    this.wsClientId = "tunnel-" + randomUUID().slice(0, 8);
  }

  setSessionId(sessionId: string): void {
    const oldId = this.sessionId;
    this.sessionId = sessionId;
    // Subscribe to new session via WebSocket if already connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN && sessionId && sessionId !== oldId) {
      this.wsSubscribe(sessionId);
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setToken(token: string): void {
    this.token = token;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Session creation
  // ═══════════════════════════════════════════════════════════════════════════════

  async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; title: string }> {
    const body: Record<string, unknown> = {
      metadata: { cwd: options.cwd },
      agent_config: {},
    };
    if (options.title) body.title = options.title;
    if (options.permissionMode) {
      (body.agent_config as Record<string, unknown>).permission_mode = options.permissionMode;
    }
    if (options.model) {
      (body.agent_config as Record<string, unknown>).model = options.model;
    }
    if (options.thinking) {
      (body.agent_config as Record<string, unknown>).thinking = options.thinking;
    }

    const resp = await this.apiPost<{ id: string; title: string }>(
      "/api/v1/sessions",
      body
    );
    process.stderr.write(
      `[wire-client] Created session ${resp.id} (cwd: ${options.cwd}, permission: ${options.permissionMode || "default"})\n`
    );

    // Auto mode is applied per-prompt via the REST API's permission_mode field.
    // We no longer inject /auto as a text prompt — that triggered unwanted LLM processing.

    return { sessionId: resp.id, title: resp.title };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Connection (REST health check + WebSocket handshake)
  // ═══════════════════════════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    if (this.connected) return;

    const maxRetries = 3;
    const retryDelayMs = 2000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const metaResp = await this.apiGet<{
          server_version: string;
          capabilities: Record<string, boolean>;
        }>("/api/v1/meta");
        this.connected = true;
        process.stderr.write(
          `[wire-client] Connected to Kimi server v${metaResp.server_version} (session: ${this.sessionId || "none"})\n`
        );

        // Connect WebSocket for push notifications
        this.wsConnect().catch((err) => {
          process.stderr.write(`[wire-client] WebSocket unavailable, falling back to polling: ${err.message}\n`);
        });

        return;
      } catch (err) {
        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt) {
          if (!this.token) {
            throw new Error(
              `Cannot connect to Kimi server at ${this.baseUrl}. Start with: kimi web --no-open. Then set KIMI_SERVER_TOKEN env var.`
            );
          }
          throw new Error(
            `Cannot connect to Kimi server at ${this.baseUrl}: ${(err as Error).message}`
          );
        }
        process.stderr.write(
          `[wire-client] Connection attempt ${attempt + 1} failed: ${(err as Error).message}. Retrying in ${retryDelayMs}ms...\n`
        );
        await sleep(retryDelayMs);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  isWsConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // WebSocket push layer
  // ═══════════════════════════════════════════════════════════════════════════════

  private async wsConnect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket handshake timeout"));
      }, 10000);

      ws.onopen = () => {
        // Send client_hello
        ws.send(JSON.stringify({
          type: "client_hello",
          id: randomUUID(),
          payload: {
            client_id: this.wsClientId,
          },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const frame: WsFrame = JSON.parse(event.data.toString());

          if (frame.type === "server_hello") {
            clearTimeout(timeout);
            process.stderr.write(`[wire-client] WebSocket connected (${this.wsClientId})\n`);
            if (this.sessionId) this.wsSubscribe(this.sessionId);
            resolve();
            return;
          }

          if (frame.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", id: frame.id }));
            return;
          }

          // Handle direct event frames (not wrapped in session_event)
          // Kimi Server pushes events as direct frame types matching payload.type
          this.handleDirectEvent(frame);
        } catch {
          // Ignore unparseable frames
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection error"));
      };

      ws.onclose = () => {
        this.ws = null;
        // Auto-reconnect after 3s
        if (this.connected) {
          this.wsReconnectTimer = setTimeout(() => {
            process.stderr.write("[wire-client] WebSocket reconnecting...\n");
            this.wsConnect().catch(() => {});
          }, 3000);
        }
      };
    });
  }

  private wsSubscribe(sessionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.wsSubscribedSessions.has(sessionId)) return;

    this.ws.send(JSON.stringify({
      type: "subscribe",
      id: randomUUID(),
      payload: {
        session_ids: [sessionId],
      },
    }));
    this.wsSubscribedSessions.add(sessionId);
    process.stderr.write(`[wire-client] Subscribed to session ${sessionId} via WebSocket\n`);
  }

  private handleDirectEvent(frame: WsFrame): void {
    const type = frame.type;
    const payload = frame.payload as Record<string, unknown> | undefined;
    const sessionId = (payload?.sessionId || payload?.session_id || this.sessionId) as string;

    // Update session state cache
    const cached = this.sessionStateCache.get(sessionId) || { status: "unknown", updatedAt: 0 };

    if (type === "event.session.status_changed" && payload?.status) {
      cached.status = payload.status as string;
      cached.updatedAt = Date.now();
      this.sessionStateCache.set(sessionId, cached);

      // Notify waiting sendPrompt calls
      const resolvers = this.statusResolvers.get(sessionId);
      if (resolvers && resolvers.length > 0) {
        const status = payload.status as string;
        if (status === "idle" || status === "aborted") {
          for (const r of resolvers) r.resolve(status);
          this.statusResolvers.delete(sessionId);
        } else if (status === "awaiting_approval") {
          const resolver = resolvers[0];
          if (resolver) resolver.resolve("awaiting_approval");
        }
      }
    }

    if (type === "turn.started") {
      cached.lastTurnId = payload?.turnId as number;
      cached.updatedAt = Date.now();
      this.sessionStateCache.set(sessionId, cached);
      process.stderr.write(`[wire-client] Turn started for ${sessionId}\n`);
    }

    if (type === "turn.ended") {
      process.stderr.write(`[wire-client] Turn ended for ${sessionId}: ${payload?.reason || "unknown"}\n`);
    }

    // ── Watch output (for coordinating session) ──────────────────────────────
    if (this.watchOutputPath) {
      if (type === "prompt.submitted") {
        this.watchPromptCount++;
        this.watchAssistantText = "";
      }
      if (type === "assistant.delta") {
        this.watchAssistantText += (payload?.delta as string) || "";
      }
      if (type === "prompt.completed") {
        try {
          const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
          const { dirname } = require("node:path") as typeof import("node:path");
          mkdirSync(dirname(this.watchOutputPath!), { recursive: true });
          writeFileSync(this.watchOutputPath!, JSON.stringify({
            sessionId,
            status: "completed",
            result: this.watchAssistantText,
            promptId: payload?.promptId || "",
            promptCount: this.watchPromptCount,
            completedAt: new Date().toISOString(),
            timestamp: new Date().toISOString(),
          }, null, 2), "utf-8");
        } catch {}
      }
    }
  }

  /**
   * Enable watch output: write completion status to a file after each prompt.completed.
   * Falls back to REST polling every 3s if WS events are not received.
   */
  setWatchOutput(path: string): void {
    this.watchOutputPath = path;
    // Start a REST polling fallback in case WS events are missed
    this.startWatchPolling();
  }

  private watchPollTimer: ReturnType<typeof setInterval> | null = null;

  private startWatchPolling(): void {
    if (this.watchPollTimer) return;
    this.watchPollTimer = setInterval(async () => {
      if (!this.watchOutputPath || !this.sessionId) return;
      try {
        const status = (await this.getSessionStatus()) || "unknown";
        if (status === "idle" || status === "aborted") {
          // Fetch messages to get the result
          const msgs = await this.apiGet<{ items: Array<{ content: Array<{ type: string; text?: string }> }> }>(
            `/api/v1/sessions/${this.sessionId}/messages?page_size=3&role=assistant`
          );
          const items = msgs?.items || [];
          let text = "";
          for (let i = items.length - 1; i >= 0; i--) {
            for (const block of items[i].content || []) {
              if (block.type === "text" && block.text) { text = block.text; break; }
            }
            if (text) break;
          }
          if (text) {
            try {
              const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
              const { dirname } = require("node:path") as typeof import("node:path");
              mkdirSync(dirname(this.watchOutputPath!), { recursive: true });
              writeFileSync(this.watchOutputPath!, JSON.stringify({
                sessionId: this.sessionId,
                status: "completed",
                result: text,
                completedAt: new Date().toISOString(),
                source: "poll_fallback",
              }, null, 2), "utf-8");
            } catch {}
          }
        }
      } catch {}
    }, 3000);
  }

  /**
   * Wait for a session status change via WebSocket.
   * Falls back to polling if WebSocket is not connected.
   */
  private waitForStatus(
    sessionId: string,
    targetStatus: string,
    timeoutMs: number,
    autoApprove: boolean
  ): Promise<string> {
    // If WebSocket is connected, use event-driven wait
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Timeout — resolve anyway (caller will fetch messages)
          resolve("timeout");
        }, timeoutMs);

        const resolvers = this.statusResolvers.get(sessionId) || [];
        resolvers.push({
          resolve: (status: string) => {
            clearTimeout(timer);
            if (status === "awaiting_approval" && autoApprove) {
              // Approve and continue waiting
              this.approveAll(sessionId).then(() => {
                // Re-register to wait for idle
                const more = this.statusResolvers.get(sessionId) || [];
                more.push({
                  resolve: (s: string) => { clearTimeout(timer); resolve(s); },
                  reject: (e: Error) => { clearTimeout(timer); reject(e); },
                });
                this.statusResolvers.set(sessionId, more);
              }).catch(() => resolve(status));
            } else {
              resolve(status);
            }
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        this.statusResolvers.set(sessionId, resolvers);
      });
    }

    // Fallback: polling
    const startTime = Date.now();
    return new Promise((resolve) => {
      const poll = async () => {
        if (Date.now() - startTime > timeoutMs) {
          resolve("timeout");
          return;
        }
        const status = await this.getSessionStatus();
        if (status === targetStatus || status === "unknown" || status === "aborted") {
          resolve(status);
          return;
        }
        if (status === "awaiting_approval" && autoApprove) {
          await this.approveAll(sessionId);
        }
        setTimeout(poll, 1000);
      };
      poll();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Prompt submission
  // ═══════════════════════════════════════════════════════════════════════════════

  async submitPrompt(
    prompt: string,
    options: { autoApprove?: boolean } = {}
  ): Promise<{ promptId: string }> {
    const { autoApprove = false } = options;

    if (!this.connected) {
      throw new Error("Wire client not connected");
    }
    if (!this.sessionId) {
      throw new Error("No session ID set.");
    }

    // Guard: wait for session ready via WebSocket (or polling fallback)
    const preStatus = await this.waitForStatus(this.sessionId, "idle", 60000, autoApprove);
    if (preStatus === "running") {
      if (autoApprove) {
        // Wait a bit more and retry
        await sleep(2000);
        const retryStatus = await this.waitForStatus(this.sessionId, "idle", 58000, autoApprove);
        if (retryStatus === "running") {
          throw new Error(
            `Session ${this.sessionId} is busy. Wait for the current turn to complete.`
          );
        }
      } else {
        throw new Error(
          `Session ${this.sessionId} is busy (status: ${preStatus}). ` +
          `Wait for the current turn to complete before sending a new prompt.`
        );
      }
    }

    // Subscribe to this session if not already
    this.wsSubscribe(this.sessionId);

    const body: Record<string, unknown> = {
      content: [{ type: "text", text: prompt }],
    };
    if (autoApprove) {
      body.permission_mode = "auto";
    }

    const resp = await this.apiPost<{ prompt_id: string }>(
      `/api/v1/sessions/${this.sessionId}/prompts`,
      body
    );
    return { promptId: resp.prompt_id };
  }

  /**
   * Send a prompt and wait for the complete response.
   * Uses WebSocket push when available, falls back to polling.
   */
  async sendPrompt(
    prompt: string,
    options: {
      timeoutMs?: number;
      includeThinking?: boolean;
      autoApprove?: boolean;
    } = {}
  ): Promise<TurnPromptResponse> {
    const { timeoutMs = 300000, includeThinking = false, autoApprove = false } = options;

    if (!this.connected) {
      throw new Error("Wire client not connected");
    }
    if (!this.sessionId) {
      throw new Error("No session ID set. Use list_sessions to find one.");
    }

    // Step 0: Wait for session ready via WebSocket push (or polling fallback)
    const preStatus = await this.waitForStatus(this.sessionId, "idle", Math.min(timeoutMs, 60000), autoApprove);

    if (preStatus === "awaiting_approval") {
      if (!autoApprove) {
        throw new Error(
          `Session ${this.sessionId} is awaiting approval. ` +
          `Enable auto_mode or approve manually before sending a new prompt.`
        );
      }
      await this.approveAll(this.sessionId);
      const afterApprove = await this.waitForStatus(this.sessionId, "idle", 10000, autoApprove);
      if (afterApprove === "running") {
        throw new Error(`Session is still busy after approval.`);
      }
    }

    // Subscribe to events
    this.wsSubscribe(this.sessionId);

    // Step 1: Submit prompt via REST
    const submitResp = await this.apiPost<{
      prompt_id: string;
      user_message_id: string;
      status: string;
      content: KimiContentBlock[];
    }>(`/api/v1/sessions/${this.sessionId}/prompts`, {
      content: [{ type: "text", text: prompt }],
      ...(autoApprove && { permission_mode: "auto" }),
    });

    const promptId = submitResp.prompt_id;

    // Step 2: Wait for status to return to idle via WebSocket (or polling)
    const remainingTimeout = timeoutMs - 3000; // subtract the time spent above
    const finalStatus = await this.waitForStatus(
      this.sessionId,
      "idle",
      Math.max(remainingTimeout, 10000),
      autoApprove
    );

    // Step 3: Fetch the response messages
    const allMessages: KimiContentBlock[] = [];
    let finalText = "";
    let thinkingText = "";

    try {
      const msgsResp = await this.apiGet<{ items: KimiMessage[] }>(
        `/api/v1/sessions/${this.sessionId}/messages?page_size=50&role=assistant`
      );

      for (const msg of (msgsResp.items || [])) {
        for (const block of msg.content) {
          allMessages.push(block);
          if (block.type === "text" && block.text) {
            finalText += block.text;
          }
          if (block.type === "thinking" && block.thinking) {
            thinkingText += block.thinking;
          }
        }
      }
    } catch {
      // Fetch failed — return what we have
    }

    return {
      promptId,
      finalText,
      thinkingText,
      status: "completed",
      messages: allMessages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════════

  getThinkingFromMessages(messages: KimiContentBlock[]): string {
    return messages
      .filter((b) => b.type === "thinking" && b.thinking)
      .map((b) => b.thinking!)
      .join("\n");
  }

  filterTextOnly(messages: KimiContentBlock[]): KimiContentBlock[] {
    return messages.filter((b) => b.type !== "thinking");
  }

  async getSessionStatus(): Promise<string> {
    // Fast path: WebSocket cache
    const cached = this.sessionStateCache.get(this.sessionId);
    if (cached && Date.now() - cached.updatedAt < 30000) {
      return cached.status;
    }
    // Fallback: REST API
    try {
      const resp = await this.apiGet<{ status: string }>(
        `/api/v1/sessions/${this.sessionId}/status`
      );
      return resp.status || "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Get cached status for any session (WebSocket push). Returns null if never seen. */
  getCachedStatus(sessionId: string): string | null {
    const cached = this.sessionStateCache.get(sessionId);
    return cached?.status || null;
  }

  private async approveAll(sessionId: string): Promise<void> {
    try {
      const approvalsResp = await this.apiGet<{
        items: Array<{ approval_id: string }>;
      }>(`/api/v1/sessions/${sessionId}/approvals?status=pending`);

      const items = approvalsResp.items || [];
      for (const item of items) {
        await this.apiPost(
          `/api/v1/sessions/${sessionId}/approvals/${item.approval_id}`,
          { decision: "approved", scope: "session" }
        );
        process.stderr.write(
          `[wire-client] Auto-approved ${item.approval_id} (session scope)\n`
        );
      }
    } catch {
      // Ignore approval errors
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }
    if (this.watchPollTimer) {
      clearInterval(this.watchPollTimer);
      this.watchPollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // REST helpers (public for watcher use)
  // ═══════════════════════════════════════════════════════════════════════════════

  async apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`API GET ${path} failed: ${resp.status}`);
    }
    const json: KimiApiResponse<T> = await resp.json();
    if (json.code !== 0) {
      throw new Error(`API error: ${json.msg} (code ${json.code})`);
    }
    return json.data;
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`API POST ${path} failed: ${resp.status}`);
    }
    const json: KimiApiResponse<T> = await resp.json();
    if (json.code !== 0) {
      throw new Error(`API error: ${json.msg} (code ${json.code})`);
    }
    return json.data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
