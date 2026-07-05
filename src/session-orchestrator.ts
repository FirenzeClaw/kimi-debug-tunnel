import { wireClient, type TurnPromptResponse } from "./wire-client.js";

export interface OrchestrationResult {
  success: boolean;
  turns: number;
  finalResponse: string;
  summary: string;
  error?: string;
}

/**
 * Multi-turn session orchestrator.
 * Sends an initial task to a session, monitors progress through multiple turns,
 * and continues until the task is complete or max turns reached.
 *
 * Thinking content is excluded by default. Use includeThinking: true to include it,
 * or call withCheckThinking: true to auto-include thinking when the response is ambiguous.
 */
export async function orchestrateTask(
  sessionId: string,
  taskDescription: string,
  options: {
    maxTurns?: number;
    includeThinking?: boolean;
    withCheckThinking?: boolean;
    onProgress?: (turn: number, text: string) => void;
  } = {}
): Promise<OrchestrationResult> {
  const {
    maxTurns = 10,
    includeThinking = false,
    withCheckThinking = false,
    onProgress,
  } = options;

  const results: string[] = [];
  let currentPrompt = taskDescription;
  let turns = 0;

  try {
    while (turns < maxTurns) {
      turns++;
      const response: TurnPromptResponse = await wireClient.sendPrompt(
        currentPrompt,
        { timeoutMs: 600000 }
      );

      let responseText = response.finalText.trim();

      // Auto-check thinking if response is ambiguous and withCheckThinking enabled
      if (withCheckThinking && isAmbiguous(responseText) && response.thinkingText) {
        const thinkingSummary = summarizeThinking(response.thinkingText);
        responseText += `\n\n[思考过程摘要: ${thinkingSummary}]`;
      } else if (includeThinking && response.thinkingText) {
        responseText += `\n\n[思考: ${response.thinkingText.slice(0, 500)}]`;
      }

      results.push(responseText);
      onProgress?.(turns, responseText);

      // Determine if task is complete
      const completionCheck = checkTaskCompletion(responseText, response);
      if (completionCheck.isComplete) {
        return {
          success: true,
          turns,
          finalResponse: responseText,
          summary: completionCheck.summary || "Task completed",
        };
      }

      // Since sendPrompt now blocks until session is idle, turn is always complete
      if (completionCheck.needsMoreInfo) {
        currentPrompt = `继续之前的任务。上一步回复: ${responseText.slice(
          0,
          500
        )}\n\n请基于以上信息继续完成任务。`;
      } else if (responseText.length > 0) {
        // Response received - check if task appears complete
        return {
          success: true,
          turns,
          finalResponse: responseText,
          summary: "Response received",
        };
      } else {
        currentPrompt = `继续执行。先前回复: ${responseText.slice(0, 300)}`;
      }
    }

    return {
      success: false,
      turns,
      finalResponse: results[results.length - 1] || "",
      summary: `Reached max turns (${maxTurns}) without completion`,
    };
  } catch (err) {
    return {
      success: false,
      turns,
      finalResponse: results[results.length - 1] || "",
      summary: "Orchestration failed",
      error: (err as Error).message,
    };
  }
}

function isAmbiguous(text: string): boolean {
  const ambiguousPatterns = [
    /不确定/i,
    /可能/i,
    /也许/i,
    /我?不太?确定/,
    /需要.*(确认|更多)/,
    /可以.*(尝试|考虑|看看)/,
    /unsure/i,
    /maybe/i,
    /perhaps/i,
    /might/i,
    /could/i,
  ];
  return ambiguousPatterns.some((p) => p.test(text));
}

function summarizeThinking(thinking: string): string {
  // Extract key points from thinking, strip excessive detail
  const lines = thinking.split("\n");
  const keyLines = lines.filter(
    (l) =>
      l.match(
        /(?:目标|方案|问题|关键|结论|决定|选择|goal|plan|issue|key|decision|choose|conclusion)/i
      ) && l.length > 20
  );
  if (keyLines.length > 0) {
    return keyLines.slice(0, 3).join("; ");
  }
  return thinking.slice(0, 200);
}

function checkTaskCompletion(
  text: string,
  _response: TurnPromptResponse
): { isComplete: boolean; needsMoreInfo: boolean; summary?: string } {
  const lower = text.toLowerCase();

  // Explicit completion signals
  const completePatterns = [
    /任务(已|已经)?完成/,
    /全部完成/,
    /✅/,
    /done/i,
    /completed/i,
    /finished/i,
    /task complete/i,
  ];

  const needsMorePatterns = [
    /需要.*(确认|更多信息|更多细节|更多的信息)/,
    /请.*(提供|告诉|说明|选择)/,
    /你.*(想要|希望|需要).*哪一种/,
    /which.*(option|approach|choice)/,
    /需要.*(决定|选择)/,
    /would you like/i,
    /do you want/i,
  ];

  for (const p of completePatterns) {
    if (p.test(text)) {
      return { isComplete: true, needsMoreInfo: false, summary: "Task completed" };
    }
  }

  for (const p of needsMorePatterns) {
    if (p.test(text)) {
      return { isComplete: false, needsMoreInfo: true };
    }
  }

  // If text is substantial (>200 chars) and turn completed, consider it done
  if (text.length > 200) {
    return { isComplete: false, needsMoreInfo: false };
  }

  return { isComplete: false, needsMoreInfo: false };
}
