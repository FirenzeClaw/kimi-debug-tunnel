import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { listSessions } from "../session-store.js";

export function registerListSessions(server: McpServer, _services?: TunnelServices): void {
  server.tool(
    "list_sessions",
    "列出所有 Kimi Code CLI session。返回 session ID、标题、创建/更新时间、工作目录和 agent 数量。按更新时间倒序排列。",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("返回 session 数量上限"),
    },
    async ({ limit }) => {
      const sessions = await listSessions();
      const limited = sessions.slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: sessions.length,
                sessions: limited,
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
