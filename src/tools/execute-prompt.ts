import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { generatePollCommand } from "../poll-command.js";
import { preparePrompt, ensureConnected } from "./helpers.js";

export function registerExecutePrompt(server: McpServer, services: TunnelServices): void {
  const { wireClient } = services;
  server.tool(
    "execute_prompt",
    "向目标 session 发送 prompt 并等待完整回复。通过 Kimi Server REST API 直接通信。默认排除思考链内容以节省 token。若回复模糊，可设置 include_thinking 获取思考内容确认意图。",
    {
      session_id: z.string().describe("目标 session ID。可从 list_sessions 获取。"),
      prompt: z.string().describe("要发送的 prompt 内容"),
      include_thinking: z
        .boolean()
        .default(false)
        .describe(
          "是否包含 AI 的思考过程。默认 false 以节省 token。当回复模糊或不明确时设为 true。"
        ),
      timeout_ms: z
        .number()
        .min(10000)
        .max(600000)
        .default(300000)
        .describe("等待超时毫秒数，默认 5 分钟"),
      auto_mode: z
        .boolean()
        .default(false)
        .describe(
          "启用自动模式：自动审批所有工具调用（scope=session），无需人工确认。默认 false。"
        ),
      wait: z
        .boolean()
        .default(false)
        .describe(
          "已废弃。受 MCP 超时限制，始终即发即返。用 poll_session / list_io_records 轮询进度。"
        ),
      policy: z
        .string()
        .optional()
        .describe(
          '任务策略。可选值:\n' +
          '- "read-only": 只读（禁止写文件/执行命令）\n' +
          '- "safe-edit": 安全编辑（禁止 shell 命令，可编辑文件）\n' +
          '- "full-access": 全部允许（默认）\n' +
          '- 自定义策略文件路径: 如 ".kimi-tunnel/policies/review.yaml"'
        ),
      skip_memory: z
        .boolean()
        .default(false)
        .describe("跳过共享内存上下文注入（SPEC 002）。默认 false。"),
    },
    async ({ session_id, prompt, include_thinking, timeout_ms, auto_mode, wait, policy, skip_memory }) => {
      if (!(await ensureConnected(services))) {
        return {
          content: [{ type: "text", text: "Wire client 未连接到 Kimi Server。请先执行 `kimi web --no-open` 启动，并设置 KIMI_SERVER_TOKEN 环境变量。" }],
          isError: true,
        };
      }

      try {
        const effectivePrompt = preparePrompt(services, {
          sessionId: session_id,
          prompt,
          skipMemory: skip_memory,
          policy,
        });

        if (!wait) {
          // Fire-and-forget: submit prompt, return immediately with poll command
          const { promptId } = await wireClient.submitPrompt(session_id, effectivePrompt, { autoApprove: auto_mode });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                submitted: true, session_id, prompt_id: promptId,
                hint: "prompt 已提交。将 poll_command 以 Bash(run_in_background=true) 执行，等待回执。",
                poll_command: generatePollCommand({ sessionId: session_id }),
              }, null, 2),
            }],
          };
        }

        const response = await wireClient.sendPrompt(session_id, effectivePrompt, {
          timeoutMs: timeout_ms,
          includeThinking: include_thinking,
          autoApprove: auto_mode,
        });

        const result: Record<string, unknown> = {
          promptId: response.promptId,
          status: response.status,
          response: response.finalText,
          messageCount: response.messages.length,
          thinkingAvailable: response.thinkingText.length > 0,
        };

        if (include_thinking && response.thinkingText) {
          result.thinking = response.thinkingText.slice(0, 2000);
        }

        result.thinkingAvailable = response.thinkingText.length > 0;

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = (err as Error).message;
        const isTimeout = /timeout|timed out/i.test(msg);
        const hint = isTimeout
          ? `\n\n提示：目标 session 可能正忙（mid-turn）。prompt 可能已成功注入，但响应等待超时。请用 read_session_log / list_io_records 检查 session 是否已开始处理。`
          : `\n\n提示：请确认 Kimi Server 正在运行（kimi web --no-open）且 session 可访问。`;
        return {
          content: [{ type: "text", text: `执行失败: ${msg}${hint}` }],
          isError: true,
        };
      }
    }
  );
}
