import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { listIORecords } from "../session-log-reader.js";
import { saveTemplate } from "../workflow-store.js";
import type { WorkflowTemplate, WorkflowStep } from "../workflow-template.js";
import { validateTemplate } from "../workflow-template.js";

export function registerLearnWorkflow(server: McpServer, _services?: TunnelServices): void {
  server.tool(
    "learn_workflow",
    "从口头描述或历史 session 中学习工作流，生成可复用的 YAML 模板。",
    {
      name: z
        .string()
        .min(1)
        .describe("模板名称，作为文件标识。如 phase5-audit"),
      cwd: z
        .string()
        .describe("任务 session 的工作目录绝对路径"),
      spec_docs: z
        .array(z.string())
        .default([])
        .describe("项目规范文档路径列表"),
      description: z
        .string()
        .optional()
        .describe("口头描述的工作流步骤。AI 应从自然语言描述中提取步骤序列并传入此字段，格式：'1. 第一步\\n2. 第二步...' 或用换行分隔。"),
      steps: z
        .array(
          z.object({
            id: z.string().describe("步骤标识"),
            instruction: z.string().describe("步骤指令"),
            expectedOutcome: z.string().optional().describe("预期产出关键词"),
          })
        )
        .optional()
        .describe("直接提供的步骤数组，优先于 description"),
      from_session: z
        .string()
        .optional()
        .describe("从指定 session 的 IO 记录中提取用户 prompt 作为步骤。优先于 description 和 steps。"),
    },
    async ({ name, cwd, spec_docs, description, steps, from_session }) => {
      let extractedSteps: WorkflowStep[] = [];

      try {
        // Path 1: Extract from session history
        if (from_session) {
          const ioResult = await listIORecords(from_session, { limit: 100 });
          if (!ioResult) {
            return {
              content: [{ type: "text", text: `Session "${from_session}" 未找到或日志不可读。` }],
              isError: true,
            };
          }

          const userPrompts: string[] = [];
          for (const rec of ioResult.records) {
            if (rec.type !== "user") continue;
            const content = rec.content.trim();
            // Skip system-injected prompts
            if (!content || content.includes("<system-reminder>")) continue;
            // Skip pure error reposts (heuristic: very long and contains stack trace patterns)
            if (content.length > 2000 && /error|stack|trace|at\s+/.test(content)) continue;
            userPrompts.push(content);
          }

          // Merge adjacent short prompts (< 50 chars) into combined steps
          const merged: string[] = [];
          let buffer = "";
          for (const p of userPrompts) {
            if (p.length < 50) {
              buffer = buffer ? buffer + "; " + p : p;
            } else {
              if (buffer) {
                merged.push(buffer);
                buffer = "";
              }
              merged.push(p);
            }
          }
          if (buffer) merged.push(buffer);

          if (merged.length === 0) {
            return {
              content: [{ type: "text", text: `Session "${from_session}" 中未找到有效的用户 prompt。` }],
              isError: true,
            };
          }

          extractedSteps = merged.map((text, i) => ({
            id: `step-${i + 1}`,
            instruction: text.length > 500 ? text.slice(0, 500) : text,
          }));
        }
        // Path 2: Direct steps array
        else if (steps && steps.length > 0) {
          extractedSteps = steps;
        }
        // Path 3: Parse from description text
        else if (description) {
          extractedSteps = parseStepsFromDescription(description);
        } else {
          return {
            content: [{ type: "text", text: "必须提供 from_session、steps 或 description 中至少一项。" }],
            isError: true,
          };
        }

        if (extractedSteps.length === 0) {
          return {
            content: [{ type: "text", text: "未能提取到任何步骤。" }],
            isError: true,
          };
        }

        // Build template
        const template: WorkflowTemplate = {
          name,
          version: "1.0",
          projectCwd: cwd,
          specDocs: spec_docs,
          steps: extractedSteps,
          blockagePolicy: {
            autoResolve: ["dependency_missing", "file_not_found"],
            maxRetriesPerStep: 1,
          },
          timeout: {
            perStep: 600000,
            total: 3600000,
          },
          description: description || `Learned from ${from_session || "description"}`,
        };

        // Validate before saving
        const validation = validateTemplate(template);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text",
                text: `模板验证失败:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        await saveTemplate(template);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  saved: true,
                  name,
                  version: "1.0",
                  steps: extractedSteps.length,
                  cwd,
                  warnings: validation.warnings,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `学习工作流失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Parse step descriptions from natural language text.
 * Handles numbered lists (1. / 1) / - / *) and plain line-break separated items.
 */
function parseStepsFromDescription(description: string): WorkflowStep[] {
  const lines = description.split("\n");
  const steps: WorkflowStep[] = [];

  // Try to detect numbered list pattern
  const numberedPattern = /^\s*(?:\d+[\.\)、]|[-*])\s+/;
  let currentStep = "";
  let stepIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line: flush current step
      if (currentStep) {
        stepIndex++;
        steps.push({ id: `step-${stepIndex}`, instruction: currentStep.trim() });
        currentStep = "";
      }
      continue;
    }

    if (numberedPattern.test(trimmed)) {
      // Flush previous step
      if (currentStep) {
        stepIndex++;
        steps.push({ id: `step-${stepIndex}`, instruction: currentStep.trim() });
      }
      currentStep = trimmed.replace(numberedPattern, "");
    } else {
      // Continuation line
      currentStep = currentStep ? currentStep + " " + trimmed : trimmed;
    }
  }

  // Flush last step
  if (currentStep) {
    stepIndex++;
    steps.push({ id: `step-${stepIndex}`, instruction: currentStep.trim() });
  }

  return steps;
}
