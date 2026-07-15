import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { loadTemplate } from "../workflow-store.js";

export function registerExecuteWorkflow(server: McpServer, services: TunnelServices): void {
  const { wireClient, workflowEngine } = services;

  server.tool(
    "execute_workflow",
    "执行工作流模板：加载模板，创建任务 session，逐步下发指令，自适应调整，阻塞时暂停等待决策。",
    {
      template_name: z
        .string()
        .min(1)
        .describe("模板名称，如 phase5-audit。可用 list_templates 查看可用模板。"),
      cwd: z
        .string()
        .optional()
        .describe("工作目录，覆盖模板中定义的 projectCwd"),
      auto_mode: z
        .boolean()
        .default(true)
        .describe("自动审批工具调用。默认 true。"),
      model: z
        .string()
        .optional()
        .describe("模型标识符"),
      thinking: z
        .enum(["off", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("思考级别"),
      policy: z
        .string()
        .optional()
        .describe('任务策略: "read-only" / "safe-edit" / "full-access" / .yaml路径'),
      memory_level: z
        .enum(["off", "minimal", "standard", "full"])
        .default("standard")
        .describe("冷启动内存注入级别。"),
      from_session: z
        .string()
        .optional()
        .describe("接续的前置 session ID。"),
    },
    async ({ template_name, cwd, auto_mode, model, thinking, policy, memory_level, from_session }) => {
      // Load template
      const template = await loadTemplate(template_name);
      if (!template) {
        return {
          content: [
            {
              type: "text",
              text: `模板 "${template_name}" 未找到。用 list_templates 查看可用模板，或用 learn_workflow 创建新模板。`,
            },
          ],
          isError: true,
        };
      }

      // Override cwd if provided
      if (cwd) {
        template.projectCwd = cwd;
      }

      // Override model/thinking if provided via agent_config
      // (These are passed to createSession internally by WorkflowEngine)

      if (!wireClient.isConnected()) {
        try {
          await wireClient.connect();
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Wire client 未连接到 Kimi Server。请先启动: kimi web --no-open",
              },
            ],
            isError: true,
          };
        }
      }

      // Bind policy if specified — passed through to engine which binds after session creation
      // (no placeholder binding here; engine.execute() receives policy option)

      // Run engine (uses shared workflowEngine from services — already wired with memory store)
      const engine = workflowEngine;
      const pmSessionId = wireClient.getPmSessionId();
      const effectiveCwd = cwd || template.projectCwd;

      // Start execution (async, non-blocking for the tool)
      // The engine will push progress via WebSocket
      engine
        .execute(template, { autoMode: auto_mode, model, thinking, policy, memory_level, from_session })
        .then((result) => {
          // Track orchestration relationship (PM → child) after workflow session is created
          if (pmSessionId && result.sessionId && services.orchestrationStore) {
            services.orchestrationStore.recordChildCreation(pmSessionId, effectiveCwd, result.sessionId, result.sessionId ? effectiveCwd : "");
          }
          process.stderr.write(
            `[workflow-engine] "${template_name}" completed: ${result.status}\n`
          );
        })
        .catch((err) => {
          process.stderr.write(
            `[workflow-engine] "${template_name}" failed: ${(err as Error).message}\n`
          );
        });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                submitted: true,
                template: template_name,
                steps: template.steps.length,
                auto_mode,
                hint: `工作流已启动。通过 WebSocket (ws://localhost:${process.env.TUNNEL_PORT || "3456"}/ws) 查看实时进度。用 poll_session 跟踪任务 session。`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
