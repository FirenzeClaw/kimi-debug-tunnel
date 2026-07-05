import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { messageQueue } from "../message-queue.js";

export function registerPushResponse(server: McpServer): void {
  server.tool(
    "push_response",
    "将处理结果推送给所有连接的外部调试客户端。客户端通过 WebSocket 实时接收响应。",
    {
      content: z.string().describe("要推送给客户端的响应内容"),
      in_reply_to: z
        .string()
        .optional()
        .describe("关联的原始消息 ID"),
    },
    async ({ content, in_reply_to }) => {
      const msg = messageQueue.enqueueResponse(content, in_reply_to);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                messageId: msg.id,
                message: "Response pushed to all connected clients",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
