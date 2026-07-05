import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendPromptToSession } from "../session-manager.js";

export function registerSendPrompt(server: McpServer): void {
  server.tool(
    "send_prompt",
    "向指定的 Kimi Code CLI session 注入 prompt。通过写入 wire.jsonl 实现。注意：该方法仅写入文件，不会立即触发 session 处理——需 session 处于活跃状态才能响应。",
    {
      session_id: z.string().describe("目标 session ID"),
      prompt: z.string().describe("要注入的 prompt 内容"),
    },
    async ({ session_id, prompt }) => {
      const result = await sendPromptToSession(session_id, prompt);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    }
  );
}
