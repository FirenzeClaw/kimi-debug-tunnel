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
      // Resolve block event if available (may be null after tunnel reload)
      let sid = session_id;
      let block: { toolName: string; sessionId: string } | null = null;
      if (block_id && policyEngine) {
        block = policyEngine.resolveBlock(block_id, "approved");
        if (block) {
          sid = sid || block.sessionId;
        }
      }

      if (!sid) {
        return { content: [{ type: "text", text: "缺少 session_id：请提供 session_id 或有效的 block_id" }], isError: true };
      }

      try {

        // If scope=session, unbind the policy entirely
        if (scope === "session" && policyEngine) {
          policyEngine.unbind(sid);
          process.stderr.write(`[approve-tool] Policy unbound for session ${sid}\n`);
        }

        // If we have an approval_id, POST the approval to Kimi Server
        if (approval_id && wireClient.isConnected()) {
          try {
            await wireClient.apiPost(
              `/api/v1/sessions/${sid}/approvals/${approval_id}`,
              { decision: "approved", scope: scope === "session" ? "session" : "once" }
            );
          } catch {
            // Non-fatal: approval may have already been handled
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  approved: true,
                  ...(block_id && { block_id }),
                  tool: block?.toolName || "unknown",
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
