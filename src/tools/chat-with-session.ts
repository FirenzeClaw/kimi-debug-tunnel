import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wireClient } from "../wire-client.js";
import { orchestrateTask } from "../session-orchestrator.js";

export function registerChatWithSession(server: McpServer): void {
  server.tool(
    "chat_with_session",
    "全自动多轮任务编排。向指定 session 发送任务需求，自动检测回复是否完成，必要时继续对话，直到任务完成或达到最大轮次。默认排除思考链，仅在回复模糊时自动读取思考内容以确认方向。",
    {
      session_id: z.string().describe("目标 session ID。可从 list_sessions 获取。"),
      task: z
        .string()
        .describe("任务需求描述。如'写一个 Python web scraper'或'审查 src/ 目录的代码'"),
      max_turns: z
        .number()
        .min(1)
        .max(20)
        .default(10)
        .describe("最大对话轮次上限"),
      include_thinking: z
        .boolean()
        .default(false)
        .describe("是否始终包含思考内容。默认 false，仅在回复模糊时自动读取"),
    },
    async ({ session_id, task, max_turns, include_thinking }) => {
      if (!wireClient.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open",
            },
          ],
          isError: true,
        };
      }

      wireClient.setSessionId(session_id);
      const result = await orchestrateTask(session_id, task, {
        maxTurns: max_turns,
        includeThinking: include_thinking,
        withCheckThinking: !include_thinking,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                turns: result.turns,
                result: result.finalResponse,
                summary: result.summary,
                error: result.error,
              },
              null,
              2
            ),
          },
        ],
        isError: !result.success,
      };
    }
  );
}
