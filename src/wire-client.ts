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
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import { WireTransport } from "./wire-transport.js";
import { detectKimiServerUrl } from "./server-lock.js";
import type { ISessionClient, IStatusClient, IPushClient } from "./types.js";
import type { PolicyEngine } from "./policy-engine.js";
import type { MessageQueue } from "./message-queue.js";

export interface KimiContentBlock {
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

export class WireClient implements ISessionClient, IStatusClient, IPushClient {
  private baseUrl: string;
  private token: string;
  private sessionId: string;
  private sessionPermissionMode: string | null = null;
  private connected = false;

  // Transport layer (REST calls)
  private transport: WireTransport;

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
  // Health check: periodically ping the server to detect silent crashes
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthFailCount = 0;
  private connecting = false; // guard against concurrent connect() calls
  private wsReconnectAttempts = 0;
  private static HEALTH_CHECK_INTERVAL_MS = 10_000;
  private static HEALTH_MAX_FAILS = 3;
  private static WS_MAX_RECONNECT_ATTEMPTS = 10;
  // Policy engine: checks tool calls against session policies
  private policyEngine: PolicyEngine | null = null;
  // Message queue: broadcasts block events to WebSocket clients (PM Dashboard)
  private messageQueue: MessageQueue | null = null;

  constructor(sessionId?: string) {
    this.baseUrl =
      process.env.KIMI_SERVER_URL || detectKimiServerUrl();
    this.token =
      process.env.KIMI_SERVER_TOKEN || "";
    this.sessionId = sessionId || "";
    this.wsUrl = this.baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
    this.wsClientId = "tunnel-" + randomUUID().slice(0, 8);
    this.transport = new WireTransport({ baseUrl: this.baseUrl, token: this.token });
  }

  /** Internal: set session ID for WS subscription tracking (v2.11: not in public interface). */
  setSessionId(sessionId: string): void {
    const oldId = this.sessionId;
    this.sessionId = sessionId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && sessionId && sessionId !== oldId) {
      this.wsSubscribe(sessionId);
    }
  }

  /** Internal: get session ID for startup auto-select (v2.11: use getPmSessionId for tools). */
  getSessionId(): string {
    return this.sessionId;
  }

  /** PM session ID for orchestration tracking (read-only, no mutation). */
  getPmSessionId(): string {
    return this.sessionId;
  }

  setToken(token: string): void {
    this.token = token;
    this.transport.token = token;
  }

  /** Inject the message queue for broadcasting block events to PM Dashboard. */
  setMessageQueue(mq: MessageQueue): void {
    this.messageQueue = mq;
  }

  /** Inject the policy engine for tool-call interception. */
  setPolicyEngine(pe: PolicyEngine): void {
    this.policyEngine = pe;
  }

  /**
   * Bind a policy to a session. The policy engine will check all tool calls
   * against this policy during approval handling.
   */
  setSessionPolicy(sessionId: string, policySpec: string, cwd?: string, boundBy?: string): void {
    if (!this.policyEngine) {
      process.stderr.write(`[wire-client] WARNING: policyEngine not set, cannot bind policy for ${sessionId}\n`);
      return;
    }
    const policy = this.policyEngine.resolve(policySpec, cwd);
    this.policyEngine.bind(sessionId, policy, boundBy);
    process.stderr.write(`[wire-client] Policy "${policy.name}" bound to session ${sessionId}\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Session creation

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

    const resp = await this.transport.apiPost<{ id: string; title: string }>(
      "/api/v1/sessions",
      body
    );
    process.stderr.write(
      `[wire-client] Created session ${resp.id} (cwd: ${options.cwd}, permission: ${options.permissionMode || "default"})\n`
    );

    // Update internal sessionId so subsequent API calls target this session
    this.setSessionId(resp.id);
    this.sessionPermissionMode = options.permissionMode || null;

    return { sessionId: resp.id, title: resp.title };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Connection (REST health check + WebSocket handshake)
  // ═══════════════════════════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return; // prevent concurrent connection attempts
    this.connecting = true;

    try {
      // Re-detect URL on each connect() call — stale lock may have been cleaned
      // and a new kimi web instance may have started on a different port since.
      if (!this.connected) {
        const freshUrl = detectKimiServerUrl();
        if (freshUrl !== this.baseUrl) {
          process.stderr.write(
            `[wire-client] Kimi Server URL changed: ${this.baseUrl} → ${freshUrl}\n`
          );
          this.baseUrl = freshUrl;
          this.wsUrl = this.baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
          this.transport.baseUrl = freshUrl;
        }
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s — up to ~63s total
      const delays = [1000, 2000, 4000, 8000, 16000, 32000];

      for (let attempt = 0; attempt < delays.length; attempt++) {
        try {
          const metaResp = await this.transport.apiGet<{
            server_version: string;
            capabilities: Record<string, boolean>;
          }>("/api/v1/meta");
          this.connected = true;
          this.healthFailCount = 0;
          process.stderr.write(
            `[wire-client] Connected to Kimi server v${metaResp.server_version} (session: ${this.sessionId || "none"})\n`
          );

          // Connect WebSocket for push notifications
          this.wsConnect().catch((err) => {
            process.stderr.write(`[wire-client] WebSocket unavailable, falling back to polling: ${err.message}\n`);
          });

          // Start periodic health check to detect silent server crashes
          this.startHealthCheck();

          return;
        } catch (err) {
          const isLastAttempt = attempt === delays.length - 1;
          const errMsg = (err as Error).message || String(err);
          if (isLastAttempt) {
            process.stderr.write(
              `[wire-client] All ${delays.length} connection attempts exhausted (last error: ${errMsg}, baseUrl=${this.baseUrl})\n`
            );
            if (!this.token) {
              throw new Error(
                `Cannot connect to Kimi server at ${this.baseUrl}. Start with: kimi web --no-open. Then set KIMI_SERVER_TOKEN env var.`
              );
            }
            throw new Error(
              `Cannot connect to Kimi server at ${this.baseUrl}: ${errMsg}`
            );
          }
          const delay = delays[attempt];
          process.stderr.write(
            `[wire-client] Connection attempt ${attempt + 1}/${delays.length} failed: ${errMsg} (baseUrl=${this.baseUrl}). Retrying in ${delay}ms...\n`
          );
          await sleep(delay);
        }
      }
    } finally {
      this.connecting = false;
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
            this.wsReconnectAttempts = 0;
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
        clearTimeout(timeout);
        // Auto-reconnect with exponential backoff and max attempts cap
        if (this.connected) {
          this.wsReconnectAttempts++;
          if (this.wsReconnectAttempts <= WireClient.WS_MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(3000 * Math.pow(2, this.wsReconnectAttempts - 1), 60_000);
            this.wsReconnectTimer = setTimeout(() => {
              process.stderr.write("[wire-client] WebSocket reconnecting...\n");
              this.wsConnect().catch(() => {});
            }, delay);
          } else {
            process.stderr.write(
              `[wire-client] WebSocket reconnect exhausted after ${WireClient.WS_MAX_RECONNECT_ATTEMPTS} attempts — sticking with REST polling\n`
            );
          }
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
        const status = (await this.getSessionStatus(this.sessionId)) || "unknown";
        if (status === "idle" || status === "aborted") {
          // Fetch messages to get the result
          const msgs = await this.transport.apiGet<{ items: Array<{ content: Array<{ type: string; text?: string }> }> }>(
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
          if (text || status === "idle" || status === "aborted") {
            try {
              mkdirSync(dirname(this.watchOutputPath!), { recursive: true });
              writeFileSync(this.watchOutputPath!, JSON.stringify({
                sessionId: this.sessionId,
                status: "completed",
                result: text || "(completed — tool calls only, no text reply)",
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
            resolve(status);
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
        const status = await this.getSessionStatus(sessionId);
        if (status === targetStatus || status === "unknown" || status === "aborted") {
          resolve(status);
          return;
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
    sessionId: string,
    prompt: string,
    options: { autoApprove?: boolean } = {}
  ): Promise<{ promptId: string }> {
    const { autoApprove = false } = options;

    if (!this.connected) {
      throw new Error("Wire client not connected");
    }

    // Guard: wait for session ready via WebSocket (or polling fallback)
    const preStatus = await this.waitForStatus(sessionId, "idle", 60000, autoApprove);
    if (preStatus === "running") {
      if (autoApprove) {
        await sleep(2000);
        const retryStatus = await this.waitForStatus(sessionId, "idle", 58000, autoApprove);
        if (retryStatus === "running") {
          throw new Error(
            `Session ${sessionId} is busy. Wait for the current turn to complete.`
          );
        }
      } else {
        throw new Error(
          `Session ${sessionId} is busy (status: ${preStatus}). ` +
          `Wait for the current turn to complete before sending a new prompt.`
        );
      }
    }

    // Subscribe to this session if not already
    this.wsSubscribe(sessionId);

    const body: Record<string, unknown> = {
      content: [{ type: "text", text: prompt }],
    };
    if (autoApprove || this.sessionPermissionMode === "auto") {
      body.permission_mode = "auto";
    }

    const resp = await this.transport.apiPost<{ prompt_id: string }>(
      `/api/v1/sessions/${sessionId}/prompts`,
      body
    );
    return { promptId: resp.prompt_id };
  }

  /**
   * Send a prompt and wait for the complete response.
   * Uses WebSocket push when available, falls back to polling.
   */
  async sendPrompt(
    sessionId: string,
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

    // Step 0: Wait for session ready via WebSocket push (or polling fallback)
    const preStatus = await this.waitForStatus(sessionId, "idle", Math.min(timeoutMs, 60000), autoApprove);

    if (preStatus === "awaiting_approval") {
        throw new Error(
          `Session ${sessionId} is awaiting approval. ` +
          `Approve or deny manually before sending a new prompt.`
        );
    }

    // Subscribe to events
    this.wsSubscribe(sessionId);

    // Step 1: Submit prompt via REST
    const submitResp = await this.transport.apiPost<{
      prompt_id: string;
      user_message_id: string;
      status: string;
      content: KimiContentBlock[];
    }>(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: "text", text: prompt }],
    });

    const promptId = submitResp.prompt_id;

    // Step 2: Wait for status to return to idle via WebSocket (or polling)
    const remainingTimeout = timeoutMs - 3000;
    await this.waitForStatus(
      sessionId,
      "idle",
      Math.max(remainingTimeout, 10000),
      autoApprove
    );

    // Step 3: Fetch the response messages using semantic method
    const allMessages = await this._fetchSessionMessages(sessionId, { pageSize: 50, role: "assistant" });
    let finalText = "";
    let thinkingText = "";

    for (const block of allMessages) {
      if (block.type === "text" && block.text) {
        finalText += block.text;
      }
      if (block.type === "thinking" && block.thinking) {
        thinkingText += block.thinking;
      }
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

  async getSessionStatus(sessionId: string): Promise<string> {
    // Fast path: WebSocket cache
    const cached = this.sessionStateCache.get(sessionId);
    if (cached && Date.now() - cached.updatedAt < 30000) {
      return cached.status;
    }
    // Fallback: REST API
    try {
      const resp = await this.transport.apiGet<{ status: string }>(
        `/api/v1/sessions/${sessionId}/status`
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // Health check — detect silent server crashes and reconnect
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Start periodic health check to detect server crashes and auto-reconnect.
   *  Safe to call multiple times — stops any existing timer first.
   *  Public so index.ts can start the reconnect loop even when initial connect() fails. */
  startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.transport.apiGet<{ server_version: string }>("/api/v1/meta");
        // Success — reset fail count. If we were disconnected, this means reconnect happened.
        if (this.healthFailCount > 0) {
          process.stderr.write(
            `[wire-client] Health check recovered (${this.healthFailCount} prior failures)\n`
          );
          this.healthFailCount = 0;
        }
      } catch {
        this.healthFailCount++;
        if (this.healthFailCount === 1) {
          process.stderr.write(
            `[wire-client] Health check failed — server may have crashed\n`
          );
        }
        if (this.healthFailCount >= WireClient.HEALTH_MAX_FAILS && this.connected) {
          process.stderr.write(
            `[wire-client] Health check failed ${this.healthFailCount} times — marking disconnected, will auto-reconnect\n`
          );
          this.connected = false;
        }
        // Attempt reconnection when disconnected
        if (!this.connected) {
          try {
            await this.connect();
          } catch {
            // connect() already logs errors; keep health check running
          }
        }
      }
    }, WireClient.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.healthFailCount = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════════

  async close(): Promise<void> {
    this.connected = false;
    this.stopHealthCheck();
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

  // Semantic REST methods (v2.11 — replacing raw apiGet/apiPost)
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Fetch messages from a session — replaces raw apiGet path construction. */
  async getSessionMessages(
    sessionId: string,
    opts: { pageSize?: number; role?: string } = {}
  ): Promise<KimiContentBlock[]> {
    const { pageSize = 50, role = "assistant" } = opts;
    const blocks: KimiContentBlock[] = [];
    try {
      const msgsResp = await this.transport.apiGet<{ items: KimiMessage[] }>(
        `/api/v1/sessions/${sessionId}/messages?page_size=${pageSize}&role=${role}`
      );
      for (const msg of (msgsResp.items || [])) {
        for (const block of msg.content) {
          blocks.push(block);
        }
      }
    } catch {
      // Non-fatal
    }
    return blocks;
  }

  /** Resolve a pending tool approval — replaces raw apiPost path construction. */
  async resolveApproval(
    sessionId: string,
    approvalId: string,
    action: "approved" | "rejected",
    reason?: string
  ): Promise<void> {
    const body: Record<string, unknown> = { decision: action };
    if (reason) body.reason = reason;
    await this.transport.apiPost(
      `/api/v1/sessions/${sessionId}/approvals/${approvalId}`,
      body
    );
  }

  /** Internal: fetch messages for sendPrompt's Step 3 (v2.11). */
  private async _fetchSessionMessages(
    sessionId: string,
    opts: { pageSize?: number; role?: string } = {}
  ): Promise<KimiContentBlock[]> {
    return this.getSessionMessages(sessionId, opts);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

