import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { messageQueue } from "../message-queue.js";

export function registerPollIncoming(server: McpServer): void {
  server.tool(
    "poll_incoming",
    "从外部调试客户端轮询待处理的命令消息。返回最多 10 条消息的列表，按入队顺序排列。若无新消息则返回空列表。",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe("返回消息数量上限"),
    },
    async ({ limit }) => {
      const messages = messageQueue.pollIncoming(limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: messages.length,
                messages: messages.map((m) => ({
                  id: m.id,
                  type: m.type,
                  content: m.content,
                  timestamp: m.timestamp,
                  clientId: m.clientId,
                })),
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
