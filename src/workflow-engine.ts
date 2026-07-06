import { randomUUID } from "node:crypto";
import type { TunnelServices, WorkflowProgress, WireClientFactory } from "./types.js";
import { WireClient } from "./wire-client.js";
import type { MessageQueue } from "./message-queue.js";
import type {
  WorkflowTemplate,
  WorkflowStep,
  BlockageEvent,
  StepResult,
  WorkflowResult,
  WorkflowExecution,
  ExecutionStatus,
} from "./workflow-template.js";

// ── Ambiguity Detection ─────────────────────────────────────────────────────────
// Reuses the same pattern from session-orchestrator.ts

const AMBIGUOUS_PATTERNS: RegExp[] = [
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

function isAmbiguous(text: string): boolean {
  return AMBIGUOUS_PATTERNS.some((p) => p.test(text));
}

// ── Blockage Detection ──────────────────────────────────────────────────────────

interface BlockagePattern {
  type: BlockageEvent["type"];
  pattern: RegExp;
  autoResolveMessage: string;
  needsUserDecision: boolean;
}

const BLOCKAGE_PATTERNS: BlockagePattern[] = [
  {
    type: "dependency_missing",
    pattern: /command not found|module not found|package.*not found|no module named/i,
    autoResolveMessage: "请先安装缺失的依赖，然后继续任务。",
    needsUserDecision: false,
  },
  {
    type: "file_not_found",
    pattern: /No such file|ENOENT|cannot find|cannot access|not found/i,
    autoResolveMessage: "请确认文件路径是否正确，或检查项目结构。",
    needsUserDecision: false,
  },
  {
    type: "permission_denied",
    pattern: /EACCES|Permission denied|not permitted|access denied/i,
    autoResolveMessage: "",
    needsUserDecision: true,
  },
  {
    type: "timeout",
    pattern: /timeout|timed out/i,
    autoResolveMessage: "",
    needsUserDecision: true,
  },
  {
    type: "tool_approval",
    pattern: /approval|awaiting/i,
    autoResolveMessage: "",
    needsUserDecision: true,
  },
];

function detectBlockage(
  text: string,
  stepIndex: number,
  autoResolve: string[]
): BlockageEvent | null {
  for (const bp of BLOCKAGE_PATTERNS) {
    if (bp.pattern.test(text)) {
      // Check for false positives: negation contexts
      if (/(?:不需要|无需|不用|don'?t need|not required)/i.test(text)) {
        continue;
      }

      const canAutoResolve = autoResolve.includes(bp.type);
      return {
        type: bp.type,
        context: text.slice(0, 300),
        resolved: canAutoResolve,
        resolution: canAutoResolve ? bp.autoResolveMessage : "",
        needsUserDecision: !canAutoResolve,
      };
    }
  }
  return null;
}

// ── Engine ──────────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private messageQueue: MessageQueue;
  private wireClientFactory: WireClientFactory;
  private activeExecutions = new Map<string, {
    executionId: string;
    template: WorkflowTemplate;
    sessionId: string;
    currentStepIndex: number;
    stepResults: StepResult[];
    status: ExecutionStatus;
    autoMode: boolean;
    wireClient: WireClient;
    onProgress?: (progress: WorkflowProgress) => void;
  }>();

  constructor(services: TunnelServices) {
    this.messageQueue = services.messageQueue;
    this.wireClientFactory = services.wireClientFactory;
  }

  /**
   * Execute a workflow template against a new task session.
   * Creates a dedicated WireClient per execution to avoid polluting shared state.
   */
  async execute(
    template: WorkflowTemplate,
    options: {
      autoMode: boolean;
      model?: string;
      thinking?: string;
      onProgress?: (progress: WorkflowProgress) => void;
    }
  ): Promise<WorkflowResult> {
    const { autoMode, onProgress, model, thinking } = options;
    const executionId = randomUUID();
    const startTime = Date.now();

    const stepResults: StepResult[] = [];
    let status: ExecutionStatus = "running";

    // Dedicated WireClient for this workflow execution
    const wireClient = this.wireClientFactory.create();
    try {
      await wireClient.connect();
    } catch (err) {
      return {
        executionId,
        template: template.name,
        sessionId: "",
        status: "failed" as ExecutionStatus,
        steps: [],
        summary: `Cannot connect to Kimi Server: ${(err as Error).message}`,
        totalDuration: Date.now() - startTime,
        nextStepOptions: ["retry", "abort"],
      };
    }

    // ── Create task session ──────────────────────────────────────────────────
    let sessionId: string;
    try {
      const created = await wireClient.createSession({
        cwd: template.projectCwd,
        title: `[WF] ${template.name}`,
        permissionMode: autoMode ? "auto" : "manual",
        model,
        thinking,
      });
      sessionId = created.sessionId;

      // Push progress: session created
      this.pushProgress(onProgress, {
        template: template.name,
        currentStep: 0,
        totalSteps: template.steps.length,
        stepId: "_create_session",
        sessionId,
        status: "executing",
        lastResponse: `Session created: ${sessionId}`,
        blockage: null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      status = "failed";
      return {
        executionId,
        template: template.name,
        sessionId: "",
        status,
        steps: stepResults,
        summary: `Failed to create session: ${(err as Error).message}`,
        totalDuration: Date.now() - startTime,
        nextStepOptions: this.buildNextStepOptions(status),
      };
    }

    // ── Drive steps ──────────────────────────────────────────────────────────
    try {
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const result = await this.driveStep(
          wireClient,
          sessionId,
          step,
          i,
          template,
          autoMode,
          onProgress
        );
        stepResults.push(result);

        if (result.status === "blocked") {
          // Check if any blockage needs user decision
          const unresolvedBlockage = result.blockages.find((b) => b.needsUserDecision);
          if (unresolvedBlockage) {
            status = "awaiting_user";
            // Store execution state for later resume
            this.activeExecutions.set(executionId, {
              executionId,
              template,
              sessionId,
              currentStepIndex: i,
              stepResults,
              status: "awaiting_user",
              autoMode,
              wireClient,
              onProgress,
            });
            break;
          }
          // Auto-resolved blockages: continue to next step
        }

        if (result.status === "failed") {
          status = "failed";
          break;
        }
      }

      if (status === "running") {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
      stepResults.push({
        stepId: "_error",
        stepIndex: -1,
        instruction: "",
        response: (err as Error).message,
        thinkingSummary: "",
        status: "failed",
        adjustment: "",
        blockages: [],
      });
    }

    // ── Push completion ──────────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const summary = this.buildSummary(template.name, stepResults, status, totalDuration);

    // Clean up: remove terminal executions, close dedicated WireClient
    if (status !== "awaiting_user") {
      this.activeExecutions.delete(executionId);
    }
    await wireClient.close();

    this.messageQueue.broadcastJson({
      type: "workflow_complete",
      executionId,
      template: template.name,
      sessionId,
      status,
      steps: stepResults.length,
      summary,
      totalDuration,
      timestamp: new Date().toISOString(),
    });

    return {
      executionId,
      template: template.name,
      sessionId,
      status,
      steps: stepResults,
      summary,
      totalDuration,
      nextStepOptions: this.buildNextStepOptions(status),
    };
  }

  // ── Step Driver ──────────────────────────────────────────────────────────────

  private async driveStep(
    wireClient: WireClient,
    sessionId: string,
    step: WorkflowStep,
    stepIndex: number,
    template: WorkflowTemplate,
    autoMode: boolean,
    onProgress?: (p: WorkflowProgress) => void
  ): Promise<StepResult> {
    const maxRetries = step.maxRetries ?? template.blockagePolicy.maxRetriesPerStep;
    let attempt = 0;
    let lastResponse = "";
    let thinkingSummary = "";
    const blockages: BlockageEvent[] = [];

    while (attempt <= maxRetries) {
      attempt++;

      try {
        // Send instruction and wait for response
        const response = await wireClient.sendPrompt(step.instruction, {
          timeoutMs: template.timeout.perStep,
          autoApprove: autoMode,
        });

        lastResponse = response.finalText.trim();
        thinkingSummary = response.thinkingText
          ? summarizeThinking(response.thinkingText)
          : "";

        // Push progress
        this.pushProgress(onProgress, {
          template: template.name,
          currentStep: stepIndex + 1,
          totalSteps: template.steps.length,
          stepId: step.id,
          sessionId,
          status: "executing",
          lastResponse: lastResponse.slice(0, 300),
          blockage: null,
          timestamp: new Date().toISOString(),
        });

        // Classify response
        // Check for explicit completion
        if (/\[DONE\]|✅|任务完成|全部完成/i.test(lastResponse)) {
          return {
            stepId: step.id,
            stepIndex,
            instruction: step.instruction,
            response: lastResponse,
            thinkingSummary,
            status: "ok",
            adjustment: "",
            blockages,
          };
        }

        // Check for blockage
        const blockage = detectBlockage(
          lastResponse,
          stepIndex,
          template.blockagePolicy.autoResolve
        );

        if (blockage) {
          if (blockage.resolved && !blockage.needsUserDecision) {
            // Auto-resolved: re-instruct with resolution
            blockages.push(blockage);
            if (attempt <= maxRetries) {
              // Adjust instruction with resolution info
              const adjustedInstruction = `${step.instruction}\n\n[上一步遇到问题: ${blockage.context.slice(0, 200)}]\n${blockage.resolution}`;
              // Override instruction for retry by using sendPrompt
              await wireClient.sendPrompt(adjustedInstruction, {
                timeoutMs: template.timeout.perStep,
                autoApprove: autoMode,
              });
              // After re-instruct, continue the loop for the next attempt
              continue;
            }
            return {
              stepId: step.id,
              stepIndex,
              instruction: step.instruction,
              response: lastResponse,
              thinkingSummary,
              status: "adjusted",
              adjustment: blockage.resolution,
              blockages,
            };
          } else {
            // Unresolvable blockage
            blockages.push(blockage);
            this.pushProgress(onProgress, {
              template: template.name,
              currentStep: stepIndex + 1,
              totalSteps: template.steps.length,
              stepId: step.id,
              sessionId,
              status: "blocked",
              lastResponse: lastResponse.slice(0, 300),
              blockage: {
                type: blockage.type,
                context: blockage.context,
                resolved: blockage.resolved,
                resolution: blockage.resolution,
                needsUserDecision: blockage.needsUserDecision,
              } as Record<string, unknown>,
              timestamp: new Date().toISOString(),
            });
            return {
              stepId: step.id,
              stepIndex,
              instruction: step.instruction,
              response: lastResponse,
              thinkingSummary,
              status: "blocked",
              adjustment: "",
              blockages,
            };
          }
        }

        // Check for ambiguity
        if (isAmbiguous(lastResponse)) {
          // Read thinking chain for confirmation
          if (response.thinkingText) {
            thinkingSummary = summarizeThinking(response.thinkingText);
            // If thinking is clear, proceed
            if (thinkingSummary.length > 50) {
              return {
                stepId: step.id,
                stepIndex,
                instruction: step.instruction,
                response: lastResponse,
                thinkingSummary,
                status: "adjusted",
                adjustment: `基于思考链确认：${thinkingSummary.slice(0, 150)}`,
                blockages,
              };
            }
          }

          // Still ambiguous — mark as adjusted but proceed
          return {
            stepId: step.id,
            stepIndex,
            instruction: step.instruction,
            response: lastResponse,
            thinkingSummary,
            status: "adjusted",
            adjustment: "回复模糊但无阻塞信号，默认推进",
            blockages,
          };
        }

        // Default: step completed OK
        return {
          stepId: step.id,
          stepIndex,
          instruction: step.instruction,
          response: lastResponse,
          thinkingSummary,
          status: "ok",
          adjustment: "",
          blockages,
        };
      } catch (err) {
        const errMsg = (err as Error).message;

        // Timeout handling
        if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
          if (attempt <= maxRetries) {
            blockages.push({
              type: "timeout",
              context: errMsg,
              resolved: true,
              resolution: `超时重试 (${attempt}/${maxRetries + 1})`,
              needsUserDecision: false,
            });
            continue;
          }
          return {
            stepId: step.id,
            stepIndex,
            instruction: step.instruction,
            response: errMsg,
            thinkingSummary: "",
            status: "failed",
            adjustment: "",
            blockages: [
              {
                type: "timeout",
                context: errMsg,
                resolved: false,
                resolution: "",
                needsUserDecision: true,
              },
            ],
          };
        }

        return {
          stepId: step.id,
          stepIndex,
          instruction: step.instruction,
          response: errMsg,
          thinkingSummary: "",
          status: "failed",
          adjustment: "",
          blockages: [],
        };
      }
    }

    return {
      stepId: step.id,
      stepIndex,
      instruction: step.instruction,
      response: lastResponse,
      thinkingSummary,
      status: "failed",
      adjustment: `Exceeded max retries (${maxRetries + 1})`,
      blockages,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private pushProgress(
    onProgress: ((p: WorkflowProgress) => void) | undefined,
    progress: WorkflowProgress
  ): void {
    if (onProgress) {
      onProgress(progress);
    }
    // Also broadcast via WebSocket
    this.messageQueue.broadcastJson({
      type: "workflow_progress",
      ...progress,
    });
  }

  private buildNextStepOptions(status: ExecutionStatus): string[] {
    switch (status) {
      case "awaiting_user": return ["retry", "skip", "abort", "manual"];
      case "completed": return ["new_session", "close"];
      case "failed": return ["retry", "abort"];
      case "cancelled": return [];
      default: return [];
    }
  }

  private buildSummary(
    templateName: string,
    steps: StepResult[],
    status: ExecutionStatus,
    duration: number
  ): string {
    const okCount = steps.filter((s) => s.status === "ok" || s.status === "adjusted").length;
    const blockedCount = steps.filter((s) => s.status === "blocked").length;
    const failedCount = steps.filter((s) => s.status === "failed").length;
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);

    return [
      `Workflow "${templateName}": ${status}`,
      `  Steps: ${steps.length} total, ${okCount} OK, ${blockedCount} blocked, ${failedCount} failed`,
      `  Duration: ${minutes}m ${seconds}s`,
    ].join("\n");
  }

  // ── Public: Handle Blockage ─────────────────────────────────────────────────

  /**
   * Handle a blockage event for a paused workflow execution.
   * decision: "retry" | "skip" | "abort" | "manual"
   * instruction: only used with "manual" — replaces the current step's instruction.
   */
  async handleBlockage(
    executionId: string,
    decision: "retry" | "skip" | "abort" | "manual",
    options: { instruction?: string } = {}
  ): Promise<WorkflowResult | null> {
    const state = this.activeExecutions.get(executionId);
    if (!state) return null;

    const { template, sessionId, currentStepIndex, stepResults, autoMode, wireClient, onProgress } = state;
    const startTime = Date.now();

    switch (decision) {
      case "retry": {
        // Re-run current step
        const step = template.steps[currentStepIndex];
        const result = await this.driveStep(
          wireClient, sessionId, step, currentStepIndex, template, autoMode, onProgress
        );
        stepResults[currentStepIndex] = result;
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, wireClient, onProgress, startTime);
      }
      case "skip": {
        // Skip current step, mark as adjusted
        const step = template.steps[currentStepIndex];
        stepResults.push({
          stepId: step.id,
          stepIndex: currentStepIndex,
          instruction: step.instruction,
          response: "",
          thinkingSummary: "",
          status: "adjusted",
          adjustment: "User skipped this step",
          blockages: [],
        });
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, wireClient, onProgress, startTime);
      }
      case "abort": {
        this.activeExecutions.delete(executionId);
        return {
          executionId,
          template: template.name,
          sessionId,
          status: "cancelled",
          steps: stepResults,
          summary: "Workflow cancelled by user",
          totalDuration: Date.now() - startTime,
          nextStepOptions: [],
        };
      }
      case "manual": {
        // Replace current step's instruction with user-provided one
        const step = template.steps[currentStepIndex];
        const manualInstruction = options.instruction || step.instruction;
        const result = await this.driveStep(
          wireClient, sessionId,
          { ...step, instruction: manualInstruction },
          currentStepIndex, template, autoMode, onProgress
        );
        stepResults[currentStepIndex] = result;
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, wireClient, onProgress, startTime);
      }
    }
  }

  /**
   * Get the current state of a workflow execution.
   */
  getExecution(executionId: string): {
    executionId: string;
    template: string;
    sessionId: string;
    currentStep: number;
    totalSteps: number;
    status: ExecutionStatus;
    stepResults: StepResult[];
  } | null {
    const state = this.activeExecutions.get(executionId);
    if (!state) return null;
    return {
      executionId: state.executionId,
      template: state.template.name,
      sessionId: state.sessionId,
      currentStep: state.currentStepIndex,
      totalSteps: state.template.steps.length,
      status: state.status,
      stepResults: state.stepResults,
    };
  }

  /**
   * Find an active execution by session ID.
   */
  getFlow(sessionId: string): {
    executionId: string;
    status: ExecutionStatus;
    currentStep: number;
    totalSteps: number;
  } | null {
    for (const [id, state] of this.activeExecutions) {
      if (state.sessionId === sessionId) {
        return {
          executionId: id,
          status: state.status,
          currentStep: state.currentStepIndex,
          totalSteps: state.template.steps.length,
        };
      }
    }
    return null;
  }

  // ── Private: Resume Execution ────────────────────────────────────────────────

  private async resumeExecution(
    executionId: string,
    sessionId: string,
    startStep: number,
    template: WorkflowTemplate,
    stepResults: StepResult[],
    autoMode: boolean,
    wireClient: WireClient,
    onProgress: ((p: WorkflowProgress) => void) | undefined,
    startTime: number
  ): Promise<WorkflowResult> {
    let status: ExecutionStatus = "running";

    try {
      for (let i = startStep; i < template.steps.length; i++) {
        const step = template.steps[i];
        const result = await this.driveStep(
          wireClient, sessionId, step, i, template, autoMode, onProgress
        );
        stepResults.push(result);

        if (result.status === "blocked") {
          const unresolvedBlockage = result.blockages.find((b) => b.needsUserDecision);
          if (unresolvedBlockage) {
            status = "awaiting_user";
            this.activeExecutions.set(executionId, {
              executionId, template, sessionId,
              currentStepIndex: i, stepResults,
              status: "awaiting_user", autoMode, wireClient, onProgress,
            });
            break;
          }
        }
        if (result.status === "failed") {
          status = "failed";
          break;
        }
      }

      if (status === "running") {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
    }

    // Clean up completed/failed executions
    if (status !== "awaiting_user") {
      this.activeExecutions.delete(executionId);
    }

    const totalDuration = Date.now() - startTime;
    const summary = this.buildSummary(template.name, stepResults, status, totalDuration);

    this.messageQueue.broadcastJson({
      type: "workflow_complete",
      executionId,
      template: template.name,
      sessionId,
      status,
      steps: stepResults.length,
      summary,
      totalDuration,
      timestamp: new Date().toISOString(),
    });

    return {
      executionId,
      template: template.name,
      sessionId,
      status,
      steps: stepResults,
      summary,
      totalDuration,
      nextStepOptions: this.buildNextStepOptions(status),
    };
  }
}

// ── Thinking summarization (reused from session-orchestrator) ───────────────────

function summarizeThinking(thinking: string): string {
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
