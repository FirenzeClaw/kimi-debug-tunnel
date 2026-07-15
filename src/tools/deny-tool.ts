/**
 * MCP tool: deny_tool — PM manually denies a held tool call.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerDenyTool(server: McpServer, services: TunnelServices): void {
  const { wireClient, policyEngine } = services;
  server.tool(
    "deny_tool",
    "拒绝被策略阻断或待审批的工具调用（仅 PM 使用）",
    {
      block_id: z.string().optional()
        .describe("阻断事件 ID。从 poll_session 或 watch_result 的 blocks 中获取。"),
      session_id: z.string().optional().describe("目标 session ID"),
      approval_id: z.string().optional().describe("Kimi Server 审批 ID（高级用法）"),
    },
    async ({ block_id, session_id, approval_id }) => {
      let sid = session_id;

      if (!sid && !approval_id) {
        return { content: [{ type: "text", text: "缺少 session_id 或 approval_id" }], isError: true };
      }

      try {
        // If we have an approval_id, POST denial to Kimi Server
        let apiDenied = false;
        if (approval_id && wireClient.isConnected()) {
          if (!sid) {
            return { content: [{ type: "text", text: "approval_id 需要配合 session_id 使用" }], isError: true };
          }
          try {
            await wireClient.resolveApproval(sid, approval_id, "rejected", "PM 拒绝");
            apiDenied = true;
          } catch (err) {
            return {
              content: [{ type: "text", text: `Kimi Server 拒绝失败: ${(err as Error).message}` }],
              isError: true,
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              denied: true,
              api_denied: apiDenied,
              ...(block_id && { block_id }),
              tool: "unknown",
              session_id: sid,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `拒绝失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
