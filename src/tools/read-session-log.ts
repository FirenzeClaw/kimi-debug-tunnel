import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { readSessionLog } from "../session-log-reader.js";

export function registerReadSessionLog(server: McpServer, _services?: TunnelServices): void {
  server.tool(
    "read_session_log",
    "读取指定 session 的对话日志。返回最近的消息条目、最后一条用户 prompt、最后一条助手回复、最近调用的工具、以及当前 turn 是否已完成。用于多轮编排时检测目标 session 的处理状态。",
    {
      session_id: z
        .string()
        .describe("目标 session ID，如 session_<uuid>"),
      after_line: z
        .number()
        .min(0)
        .default(0)
        .describe(
          "起始行号。传 0 从日志开头返回前 N 条；传 >0 仅返回该行号之后的增量条目。"
        ),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(30)
        .describe("返回条目数量上限"),
      include_thinking: z
        .boolean()
        .default(false)
        .describe("是否包含思考过程条目"),
      max_content_length: z
        .number()
        .min(50)
        .max(50000)
        .default(500)
        .describe("每条日志内容的最大字符数"),
    },
    async ({ session_id, after_line, limit, include_thinking, max_content_length }) => {
      const log = await readSessionLog(session_id, {
        afterLine: after_line,
        limit,
        includeThinking: include_thinking,
        maxContentLength: max_content_length,
      });

      if (!log) {
        return {
          content: [
            {
              type: "text",
              text: `Session "${session_id}" 未找到或日志不可读。`,
            },
          ],
          isError: true,
        };
      }

      // Build a concise summary
      const summary = {
        sessionId: log.sessionId,
        totalLines: log.totalLines,
        lastTurnComplete: log.lastTurnComplete,
        lastTurnFinishReason: log.lastTurnFinishReason,
        lastUserPrompt: log.lastTurnPrompt
          ? log.lastTurnPrompt.content
          : null,
        lastAssistantResponse: log.lastAssistantText
          ? log.lastAssistantText.content
          : null,
        recentToolCalls: log.lastToolCalls,
        recentEntries: log.recentEntries,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
