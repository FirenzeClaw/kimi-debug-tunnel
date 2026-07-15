import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { ensureConnected, setMemoryProfileWithExpiry } from "./helpers.js";

export function registerCreateSession(server: McpServer, services: TunnelServices): void {
  const { wireClient, orchestrationStore } = services;
  server.tool(
    "create_session",
    "创建新的 Kimi Code session。可指定工作目录和权限模式（auto/manual/yolo）。",
    {
      cwd: z
        .string()
        .describe("工作目录的绝对路径，如 D:/code/glass-desktop/scene"),
      title: z.string().optional().describe("Session 标题，可选"),
      permission_mode: z
        .enum(["manual", "yolo", "auto"])
        .default("auto")
        .describe("权限模式：auto=自动审批所有工具调用，manual=需确认，yolo=超级自动"),
      model: z.string().optional().describe("模型标识符，如 deepseek/deepseek-v4-pro"),
      thinking: z
        .enum(["off", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("思考级别，默认 max"),
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
      memory_level: z
        .enum(["off", "minimal", "standard", "full"])
        .default("standard")
        .describe(
          "冷启动内存注入级别。off=不注入, minimal=仅项目元信息, " +
          "standard=meta+decisions（默认）, full=meta+decisions+risks+learnings"
        ),
      from_session: z
        .string()
        .optional()
        .describe("接续的前置 session ID，自动拉取其 handoff 交接信息注入到首条 prompt。"),
    },
    async ({ cwd, title, permission_mode, model, thinking, policy, memory_level, from_session }) => {
      if (!(await ensureConnected(services))) {
        return {
          content: [{ type: "text", text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open" }],
          isError: true,
        };
      }

      try {
        const pmSessionId = wireClient.getPmSessionId();
        const result = await wireClient.createSession({
          cwd,
          title,
          permissionMode: permission_mode,
          model,
          thinking,
        });

        // Track orchestration relationship (PM → child)
        if (pmSessionId && orchestrationStore) {
          orchestrationStore.recordChildCreation(pmSessionId, cwd, result.sessionId, cwd);
        }

        // Bind policy if specified
        if (policy) {
          try {
            wireClient.setSessionPolicy(result.sessionId, policy, cwd);
          } catch (policyErr) {
            return {
              content: [{ type: "text", text: `策略绑定失败: ${(policyErr as Error).message}` }],
              isError: true,
            };
          }
        }

        // Bind memory profile if level != "off" (SPEC 002)
        setMemoryProfileWithExpiry(
          services.memoryStore, services.tunnelProjectRoot, result.sessionId,
          { level: memory_level, cwd, fromSession: from_session }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: result.sessionId,
                  title: result.title,
                  cwd,
                  permission_mode,
                  policy: policy || "full-access (default)",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `创建 session 失败: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
