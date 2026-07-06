import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { pollSessionStatus } from "../session-log-reader.js";

export function registerPollSession(server: McpServer, services?: TunnelServices): void {
  const { wireClient, workflowEngine } = services || {};

  server.tool(
    "poll_session",
    "轮询 session 运行状态。返回结构化状态报告，优先使用 WebSocket 推送缓存（零 I/O）。",
    {
      session_id: z.string().describe("目标 session ID"),
    },
    async ({ session_id }) => {
      // Fast path: WebSocket-pushed cache (zero file I/O)
      if (wireClient) {
        const cached = wireClient.getCachedStatus(session_id);
        if (cached && cached !== "unknown") {
          const stateLabels: Record<string, string> = {
            active: "🟢 运行中", swarm: "🟢 并行调度中",
            awaiting_approval: "🟡 等待审批", done: "✅ 已完成",
            error: "🔴 错误", idle: "⏳ 空闲",
          };
          // Check engine for active flow
          const flow = workflowEngine?.getFlow(session_id);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                sessionId: session_id,
                state: cached,
                stateLabel: stateLabels[cached] || cached,
                complete: cached === "done",
                totalLines: 0,  // WS cache doesn't track line count
                source: "ws_cache",
                ...(flow && { flow }),
              }, null, 2),
            }],
          };
        }
      }

      // Fallback: parse wire.jsonl
      const status = await pollSessionStatus(session_id);
      if (!status) {
        return {
          content: [{ type: "text", text: `Session "${session_id}" 未找到或日志不可读。` }],
          isError: true,
        };
      }

      const stateLabels: Record<string, string> = {
        active: "🟢 运行中", swarm: "🟢 并行调度中",
        awaiting_approval: "🟡 等待审批", done: "✅ 已完成",
        error: "🔴 错误", idle: "⏳ 空闲",
      };

      const flow = workflowEngine?.getFlow(session_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...status,
            stateLabel: stateLabels[status.state] || status.state,
            source: "file_parse",
            ...(flow && { flow }),
          }, null, 2),
        }],
      };
    }
  );
}
