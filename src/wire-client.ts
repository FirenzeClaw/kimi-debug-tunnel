/**
 * Kimi Server REST API client.
 *
 * Uses the local Kimi Code server REST API to send prompts and read responses.
 * Thinking content is filtered out by default; set `includeThinking: true` to include it.
 *
 * Prerequisites: kimi web --no-open --port <port>
 * Token: printed at startup or available from the web UI URL hash.
 */

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

export class WireClient {
  private baseUrl: string;
  private token: string;
  private sessionId: string;
  private connected = false;

  constructor(sessionId?: string) {
    this.baseUrl =
      process.env.KIMI_SERVER_URL || "http://127.0.0.1:5494";
    this.token =
      process.env.KIMI_SERVER_TOKEN || "";
    this.sessionId = sessionId || "";
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async connect(): Promise<void> {
    if (!this.token) {
      // Try to auto-detect token from running server
      try {
        const metaResp = await this.apiGet<{
          server_version: string;
          capabilities: Record<string, boolean>;
        }>("/api/v1/meta");
        this.connected = true;
        process.stderr.write(
          `[wire-client] Connected to Kimi server v${metaResp.server_version}\n`
        );
        return;
      } catch (err) {
        throw new Error(
          `Cannot connect to Kimi server at ${this.baseUrl}. Start with: kimi web --no-open. Then set KIMI_SERVER_TOKEN env var.`
        );
      }
    }

    try {
      const metaResp = await this.apiGet<{
        server_version: string;
        capabilities: Record<string, boolean>;
      }>("/api/v1/meta");
      this.connected = true;
      process.stderr.write(
        `[wire-client] Connected to Kimi server v${metaResp.server_version} (session: ${this.sessionId || "none"})\n`
      );
    } catch (err) {
      throw new Error(
        `Cannot connect to Kimi server at ${this.baseUrl}: ${(err as Error).message}`
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a prompt and wait for the complete response.
   * By default, thinking content is excluded from finalText.
   */
  async sendPrompt(
    prompt: string,
    options: {
      timeoutMs?: number;
      includeThinking?: boolean;
    } = {}
  ): Promise<TurnPromptResponse> {
    const { timeoutMs = 300000, includeThinking = false } = options;

    if (!this.connected) {
      throw new Error("Wire client not connected");
    }
    if (!this.sessionId) {
      throw new Error("No session ID set. Use list_sessions to find one.");
    }

    // Step 1: Submit prompt
    const submitResp = await this.apiPost<{
      prompt_id: string;
      user_message_id: string;
      status: string;
      content: KimiContentBlock[];
    }>(`/api/v1/sessions/${this.sessionId}/prompts`, {
      content: [{ type: "text", text: prompt }],
    });

    const promptId = submitResp.prompt_id;
    let lastMessageId = "";

    let finalText = "";
    let thinkingText = "";
    const allMessages: KimiContentBlock[] = [];

    // Step 2: Poll until idle, collecting messages
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      // Check session status
      try {
        const statusResp = await this.apiGet<{ status: string }>(
          `/api/v1/sessions/${this.sessionId}/status`
        );

        // Fetch new messages
        const params = new URLSearchParams({
          page_size: "30",
          role: "assistant",
        });
        if (lastMessageId) {
          params.set("after_id", lastMessageId);
        }

        const msgsResp = await this.apiGet<{ items: KimiMessage[] }>(
          `/api/v1/sessions/${this.sessionId}/messages?${params}`
        );

        const items = msgsResp.items || [];
        for (const msg of items) {
          if (msg.id > lastMessageId) {
            lastMessageId = msg.id;
          }
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

        // Check if turn is complete
        if (statusResp.status === "idle" && items.length > 0) {
          // Verify we got a text response
          const hasText = allMessages.some((b) => b.type === "text");
          if (hasText || allMessages.length > 0) {
            break;
          }
        }

        // If still running and we haven't seen the prompt yet, wait longer first
        if (statusResp.status === "running" && lastMessageId === "") {
          await sleep(pollInterval * 2);
        }
      } catch {
        // Ignore polling errors, continue
      }

      await sleep(pollInterval);
    }

    return {
      promptId,
      finalText: includeThinking ? finalText : finalText,
      thinkingText,
      status: "completed",
      messages: allMessages,
    };
  }

  /**
   * Read thinking content for a specific turn.
   * Useful when response is ambiguous and needs confirmation.
   */
  getThinkingFromMessages(messages: KimiContentBlock[]): string {
    return messages
      .filter((b) => b.type === "thinking" && b.thinking)
      .map((b) => b.thinking!)
      .join("\n");
  }

  /**
   * Filter out thinking blocks, keeping only text and tool info.
   */
  filterTextOnly(messages: KimiContentBlock[]): KimiContentBlock[] {
    return messages.filter((b) => b.type !== "thinking");
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  private async apiGet<T>(path: string): Promise<T> {
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

export const wireClient = new WireClient();
