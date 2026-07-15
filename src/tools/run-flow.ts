import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import type { WorkflowTemplate } from "../workflow-template.js";

export function registerRunFlow(server: McpServer, services: TunnelServices): void {
  const { wireClient, workflowEngine } = services;
  server.tool(
    "run_flow",
    "分步流程执行引擎。创建 session 后逐步提交任务，每步完成后自动提交下一步。即发即返，通过 poll_session 跟踪流程进度。",
    {
      cwd: z.string().describe("工作目录的绝对路径"),
      steps: z.array(z.string()).min(1).max(30).describe("步骤描述数组"),
      auto_mode: z.boolean().default(true).describe("自动审批工具调用"),
      model: z.string().optional().describe("模型标识符"),
      thinking: z.enum(["off","low","medium","high","xhigh","max"]).optional().describe("思考级别"),
      policy: z.string().optional().describe('任务策略: "read-only" / "safe-edit" / "full-access" / .yaml路径'),
      memory_level: z.enum(["off", "minimal", "standard", "full"]).default("standard").describe("冷启动内存注入级别。"),
      from_session: z.string().optional().describe("接续的前置 session ID。"),
    },
    async ({ cwd, steps, auto_mode, model, thinking, policy, memory_level, from_session }) => {
      if (!wireClient.isConnected()) {
        try { await wireClient.connect(); } catch {
          return { content: [{ type: "text", text: "Wire client 未连接到 Kimi Server" }], isError: true };
        }
      }

      // Build inline template from ad-hoc steps
      const template: WorkflowTemplate = {
        name: `run-flow-${Date.now()}`,
        version: "1.0",
        projectCwd: cwd,
        specDocs: [],
        steps: steps.map((s, i) => ({ id: `step-${i + 1}`, instruction: s })),
        blockagePolicy: { autoResolve: ["dependency_missing", "file_not_found"], maxRetriesPerStep: 1 },
        timeout: { perStep: 600000, total: 3600000 },
      };

      // Fire-and-forget via WorkflowEngine
      const engine = workflowEngine;
      const pmSessionId = wireClient.getPmSessionId();
      engine.execute(template, { autoMode: auto_mode, model, thinking, policy, memory_level, from_session })
        .then(r => {
          // Track orchestration relationship (PM → child)
          if (pmSessionId && r.sessionId && services.orchestrationStore) {
            services.orchestrationStore.recordChildCreation(pmSessionId, cwd, r.sessionId, cwd);
          }
          process.stderr.write(`[run-flow] ${r.template} ${r.status}\n`);
        })
        .catch(e => process.stderr.write(`[run-flow] error: ${e.message}\n`));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            submitted: true, cwd, auto_mode, total_steps: steps.length,
            hint: "流程已启动，任务 session 正在创建（标题 [WF] run-flow-*）。用 list_sessions 找到新 session 后，以 Bash(run_in_background=true) 执行 poll_command 等待回执。",
          }, null, 2),
        }],
      };
    }
  );
}
