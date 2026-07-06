import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

/**
 * Legacy tool — now delegates to execute_prompt.
 * The original multi-turn orchestration (orchestrateTask) was removed when MCP timeout
 * constraints forced fire-and-forget; chat_with_session is now equivalent to
 * execute_prompt(wait=false, auto_mode=...).
 */
export function registerChatWithSession(server: McpServer, services: TunnelServices): void {
  const { wireClient } = services;
  server.tool(
    "chat_with_session",
    "向指定 session 发送任务（即发即返）。用 poll_session 跟踪进度。",
    {
      session_id: z.string().describe("目标 session ID"),
      task: z.string().describe("任务需求描述"),
      auto_mode: z.boolean().default(false).describe("自动审批工具调用"),
    },
    async ({ session_id, task, auto_mode }) => {
      if (!wireClient.isConnected()) {
        try { await wireClient.connect(); } catch {
          return { content: [{ type: "text", text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open" }], isError: true };
        }
      }

      wireClient.setSessionId(session_id);

      try {
        const { promptId } = await wireClient.submitPrompt(task, { autoApprove: auto_mode });
        return {
          content: [{ type: "text", text: JSON.stringify({
            submitted: true, session_id, prompt_id: promptId,
            hint: "任务已提交。用 poll_session / list_io_records 跟踪进度。",
          }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `提交失败: ${(err as Error).message}` }], isError: true };
      }
    }
  );
}
