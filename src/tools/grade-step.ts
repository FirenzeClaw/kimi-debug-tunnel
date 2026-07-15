import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { listIORecords } from "../session-log-reader.js";

// 懒创建的 grader session ID，进程级复用
let _graderSessionId: string | null = null;

export function registerGradeStep(server: McpServer, services: TunnelServices): void {
  const { wireClient } = services;

  server.tool(
    "grade_step",
    "对 task session 的产出进行 LLM 自动评分验证。返回 pass/fail 及详细反馈。grader 是筛子非裁判——pass 不代表完美，fail 也不一定是真问题。",
    {
      session_id: z.string().describe("目标 task session ID"),
      criteria: z.string().describe("验收标准，自由文本。逐条明确可量化/可判定的条件"),
      focus: z
        .enum(["completeness", "accuracy", "format"])
        .optional()
        .describe("评分侧重维度：completeness=完整度, accuracy=准确性, format=格式规范"),
    },
    async ({ session_id, criteria, focus }) => {
      if (!wireClient.isConnected()) {
        return { content: [{ type: "text", text: "Wire client 未连接。请先启动 Kimi Server。" }], isError: true };
      }

      // 拉取目标 session 的 IO 记录，作为评分依据
      const ioResult = await listIORecords(session_id, { limit: 5, maxContentLength: 8000 });
      const sessionOutput = ioResult?.records
        ?.map((r) => `[Turn ${r.turn}] ${r.type === "user" ? "Prompt" : "Response"}: ${r.content}`)
        .join("\n\n") ?? "(无法读取 session 产出)";

      const focusHint = focus ? `评分侧重维度: ${focus}。` : "";

      const gradingPrompt = `你是独立产出质量评分助手。以下是 task session ${session_id} 的最近产出，请根据验收标准评估质量。
严格仅返回 JSON，不含任何其他文字：{"pass":true|false,"score":0-100,"feedback":"具体原因，点明通过/不通过的具体证据"}

=== Session 产出 ===
${sessionOutput}

=== 验收标准 ===
${criteria}

${focusHint}`;

      try {
        // 懒创建 grader session（独立 session，不污染 task session）
        if (!_graderSessionId) {
          const created = await wireClient.createSession({
            cwd: process.cwd(),
            title: "[grader] Loop Engineering 评分器",
            permissionMode: "auto",
          });
          _graderSessionId = created.sessionId;
        }

        // 评分：直接传递 grader session ID，无需 save/restore
        const response = await wireClient.sendPrompt(_graderSessionId, gradingPrompt, { timeoutMs: 30000, autoApprove: true });

        try {
          const parsed = JSON.parse(response.finalText);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                pass: !!parsed.pass,
                score: typeof parsed.score === "number" ? parsed.score : (parsed.pass ? 80 : 30),
                feedback: parsed.feedback || "无反馈",
                session_id,
              }, null, 2),
            }],
          };
        } catch {
          // JSON 解析失败（常见于 grader 反馈过长导致 finalText 截断）
          const passMatch = response.finalText.match(/"pass"\s*:\s*(true|false)/);
          const scoreMatch = response.finalText.match(/"score"\s*:\s*(\d+)/);
          const feedbackMatch = response.finalText.match(/"feedback"\s*:\s*"([^"]*)/);
          const pass = passMatch ? passMatch[1] === "true" : false;
          const score = scoreMatch ? Number(scoreMatch[1]) : 0;
          const feedback = (feedbackMatch ? feedbackMatch[1] + "…(截断)" : "") || response.finalText.slice(0, 200);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                pass,
                score,
                feedback,
                session_id,
              }, null, 2),
            }],
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `grade_step 失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
