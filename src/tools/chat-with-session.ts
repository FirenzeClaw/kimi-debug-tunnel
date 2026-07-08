import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { generatePollCommand } from "../poll-command.js";

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
      policy: z.string().optional().describe('任务策略: "read-only" / "safe-edit" / "full-access" / .yaml路径'),
      skip_memory: z.boolean().default(false).describe("跳过共享内存上下文注入（SPEC 002）。"),
    },
    async ({ session_id, task, auto_mode, policy, skip_memory }) => {
      if (!wireClient.isConnected()) {
        try { await wireClient.connect(); } catch {
          return { content: [{ type: "text", text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open" }], isError: true };
        }
      }

      wireClient.setSessionId(session_id);

      // Bind policy if specified
      if (policy) {
        try { wireClient.setSessionPolicy(session_id, policy); } catch { /* non-fatal */ }
      }

      // Bind memory injection context (SPEC 002)
      let effectiveTask = task;
      if (!skip_memory && services.memoryStore && services.tunnelProjectRoot) {
        const profile = wireClient.getMemoryProfile(session_id);
        if (profile && profile.level !== "off") {
          try {
            services.memoryStore.ensureDb(services.tunnelProjectRoot);
            const injection = services.memoryStore.buildInjection({
                level: profile.level as "off" | "minimal" | "standard" | "full",
                maxBytes: 8192,
                fromSession: profile.fromSession,
                cwd: profile.cwd,
                hasExpiredEntries: profile.hasExpiredEntries,
              });
              if (injection) {
                const warning = profile.hasExpiredEntries
                  ? "⚠️ 警告: 以下注入的部分条目已被 PM 标记为过期，内容可能不是最新。\n\n"
                  : "";
                effectiveTask = `${warning}${injection}\n\n---\n\n${task}`;
              }
          } catch { /* non-fatal */ }
        }
      }

      try {
        const { promptId } = await wireClient.submitPrompt(effectiveTask, { autoApprove: auto_mode });
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
