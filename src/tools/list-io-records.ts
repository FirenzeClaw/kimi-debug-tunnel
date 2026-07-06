import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listIORecords } from "../session-log-reader.js";

export function registerListIORecords(server: McpServer): void {
  server.tool(
    "list_io_records",
    "快速列出 session 的输入输出记录。仅提取用户 prompt 和助手文本回复，过滤所有 tool_call/thinking/step_end 噪音。用于快速了解对话流程。",
    {
      session_id: z
        .string()
        .describe("目标 session ID，如 session_<uuid>。可从 list_sessions 获取。"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("返回记录数量上限"),
    },
    async ({ session_id, limit }) => {
      const result = await listIORecords(session_id, { limit });

      if (!result) {
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

      // Build concise output
      const lines: string[] = [
        `Session: ${result.sessionId}`,
        `Total turns: ${result.totalTurns}`,
        `Showing last ${result.records.length} records:`,
        "",
      ];

      for (const rec of result.records) {
        const prefix = rec.type === "user" ? "👤" : "🤖";
        const stepInfo = rec.type === "assistant" && rec.stepCount
          ? ` [${rec.stepCount} steps]`
          : "";
        const content = rec.content.length > 300
          ? rec.content.slice(0, 300) + "..."
          : rec.content;
        lines.push(`${prefix} Turn ${rec.turn}${stepInfo}: ${content}`);
        lines.push("");
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
      };
    }
  );
}
