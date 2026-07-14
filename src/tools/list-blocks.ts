import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerListBlocks(server: McpServer, services: TunnelServices): void {
  const { policyEngine } = services;

  server.tool(
    "list_blocks",
    "列出待处理的策略阻断事件。可选按 session 过滤。",
    {
      session_id: z.string().optional()
        .describe("按 session ID 过滤，省略则列出全部待处理阻断"),
    },
    async ({ session_id }) => {
      if (!policyEngine) {
        return {
          content: [{ type: "text", text: "策略引擎未初始化" }],
          isError: true,
        };
      }

      const rawBlocks = session_id
        ? policyEngine.getBlocksBySession(session_id)
        : policyEngine.getPendingBlocks();

      const blocks = rawBlocks.map(b => ({
        block_id: b.id,
        session_id: b.sessionId,
        action: b.action,
        tool_name: b.toolName,
        policy: b.policyName,
        rule: b.ruleName,
        message: b.message,
        created_at: b.timestamp,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ blocks, count: blocks.length }, null, 2),
        }],
      };
    }
  );
}
