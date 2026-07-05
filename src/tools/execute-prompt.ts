import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wireClient } from "../wire-client.js";

export function registerExecutePrompt(server: McpServer): void {
  server.tool(
    "execute_prompt",
    "向目标 session 发送 prompt 并等待完整回复。通过 Kimi Server REST API 直接通信。默认排除思考链内容以节省 token。若回复模糊，可设置 include_thinking 获取思考内容确认意图。",
    {
      session_id: z.string().describe("目标 session ID。可从 list_sessions 获取。"),
      prompt: z.string().describe("要发送的 prompt 内容"),
      include_thinking: z
        .boolean()
        .default(false)
        .describe(
          "是否包含 AI 的思考过程。默认 false 以节省 token。当回复模糊或不明确时设为 true。"
        ),
      timeout_ms: z
        .number()
        .min(10000)
        .max(600000)
        .default(300000)
        .describe("等待超时毫秒数，默认 5 分钟"),
    },
    async ({ session_id, prompt, include_thinking, timeout_ms }) => {
      if (!wireClient.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "Wire client 未连接到 Kimi Server。请先执行 `kimi web --no-open` 启动，并设置 KIMI_SERVER_TOKEN 环境变量。",
            },
          ],
          isError: true,
        };
      }

      try {
        wireClient.setSessionId(session_id);
        const response = await wireClient.sendPrompt(prompt, {
          timeoutMs: timeout_ms,
          includeThinking: include_thinking,
        });

        const result: Record<string, unknown> = {
          promptId: response.promptId,
          status: response.status,
          response: response.finalText,
          messageCount: response.messages.length,
          thinkingAvailable: response.thinkingText.length > 0,
        };

        if (include_thinking && response.thinkingText) {
          result.thinking = response.thinkingText.slice(0, 2000);
        }

        result.thinkingAvailable = response.thinkingText.length > 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `执行失败: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
