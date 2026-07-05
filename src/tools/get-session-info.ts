import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSessionInfo } from "../session-manager.js";

export function registerGetSessionInfo(server: McpServer): void {
  server.tool(
    "get_session_info",
    "获取指定 session 的详细信息，包括标题、工作目录、创建/更新时间、agent 列表和最后一条 prompt。",
    {
      session_id: z
        .string()
        .describe(
          "Session ID，格式如 session_<uuid> 或 ses_<uuid>。可从 list_sessions 获取。"
        ),
    },
    async ({ session_id }) => {
      const info = await getSessionInfo(session_id);

      if (!info) {
        return {
          content: [
            {
              type: "text",
              text: `Session "${session_id}" 未找到。请使用 list_sessions 查看可用 session。`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    }
  );
}
