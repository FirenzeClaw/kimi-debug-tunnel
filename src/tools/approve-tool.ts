/**
 * MCP tool: approve_tool — PM manually approves a blocked/held tool call.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerApproveTool(server: McpServer, services: TunnelServices): void {
  const { wireClient, policyEngine } = services;
  server.tool(
    "approve_tool",
    "放行被策略阻断的工具调用（仅 PM 使用）。scope=once 仅放行本次调用，scope=session 将工具加入 session 临时白名单。",
    {
      block_id: z.string().optional()
        .describe("阻断事件 ID。从 poll_session 或 watch_result 的 blocks 中获取。"),
      scope: z
        .enum(["once", "session"])
        .default("once")
        .describe("once=仅本次调用, session=后续同类工具均放行"),
      session_id: z.string().optional().describe("目标 session ID"),
      approval_id: z.string().optional().describe("Kimi Server 审批 ID（高级用法）"),
    },
    async ({ block_id, scope, session_id, approval_id }) => {
      const sid = session_id;

      if (!sid && !approval_id) {
        return { content: [{ type: "text", text: "缺少 session_id 或 approval_id" }], isError: true };
      }

      try {

        // If scope=session, unbind the policy entirely
        if (scope === "session" && policyEngine && sid) {
          policyEngine.unbind(sid);
          process.stderr.write(`[approve-tool] Policy unbound for session ${sid}\n`);
        }

        // If we have an approval_id, POST the approval to Kimi Server
        let apiApproved = false;
        if (approval_id && wireClient.isConnected()) {
          if (!sid) {
            return { content: [{ type: "text", text: "approval_id 需要配合 session_id 使用" }], isError: true };
          }
          try {
            await wireClient.resolveApproval(sid, approval_id, "approved", "PM 放行");
            apiApproved = true;
          } catch (err) {
            return {
              content: [{ type: "text", text: `Kimi Server 放行失败: ${(err as Error).message}` }],
              isError: true,
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  approved: true,
                  api_approved: apiApproved,
                  ...(block_id && { block_id }),
                  tool: "unknown",
                  scope,
                  session_id: sid,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `放行失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
