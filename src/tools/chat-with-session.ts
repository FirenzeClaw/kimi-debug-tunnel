import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { generatePollCommand } from "../poll-command.js";
import { preparePrompt, ensureConnected } from "./helpers.js";

/**
 * Delegates to the same fire-and-forget pattern as execute_prompt.
 * Both tools share the same helpers — no duplicated logic.
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
      policy: z.string().optional().describe('任务策略: "read-only" / "safe-edit" / "full-access" / .yaml路径'),
      skip_memory: z.boolean().default(false).describe("跳过共享内存上下文注入（SPEC 002）。"),
    },
    async ({ session_id, task, auto_mode, policy, skip_memory }) => {
      if (!(await ensureConnected(services))) {
        return { content: [{ type: "text", text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open" }], isError: true };
      }

      const effectivePrompt = preparePrompt(services, {
        sessionId: session_id,
        prompt: task,
        skipMemory: skip_memory,
        policy,
      });

      try {
        const { promptId } = await wireClient.submitPrompt(session_id, effectivePrompt, { autoApprove: auto_mode });
        return {
          content: [{ type: "text", text: JSON.stringify({
            submitted: true, session_id, prompt_id: promptId,
            hint: "任务已提交。将 poll_command 以 Bash(run_in_background=true) 执行，等待回执。",
            poll_command: generatePollCommand({ sessionId: session_id }),
          }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `提交失败: ${(err as Error).message}` }], isError: true };
      }
    }
  );
}
