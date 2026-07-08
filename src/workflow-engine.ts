import { randomUUID } from "node:crypto";
import type { WorkflowProgress, IMemoryStore } from "./types.js";
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

interface ActiveExecution {
  executionId: string;
  template: WorkflowTemplate;
  sessionId: string;
  currentStepIndex: number;
  stepResults: StepResult[];
  status: ExecutionStatus;
  autoMode: boolean;
  onProgress?: (progress: WorkflowProgress) => void;
}

export class WorkflowEngine {
  private wireClient: WireClient;
  private messageQueue: MessageQueue;
  private activeExecutions = new Map<string, ActiveExecution>();
  private memoryStore: IMemoryStore | null = null;
  private tunnelProjectRoot: string | null = null;

  constructor(wireClient: WireClient, messageQueue: MessageQueue) {
    this.wireClient = wireClient;
    this.messageQueue = messageQueue;
  }

  /** Set memory store for injecting shared knowledge into workflow sessions. */
  setMemoryStore(store: IMemoryStore, projectRoot: string | null): void {
    this.memoryStore = store;
    this.tunnelProjectRoot = projectRoot;
  }

  /**
   * Execute a workflow template against a new task session.
   * Uses the shared WireClient, saving/restoring its original sessionId around execution.
   */
  async execute(
    template: WorkflowTemplate,
    options: {
      autoMode: boolean;
      model?: string;
      thinking?: string;
      policy?: string;
      memory_level?: string;
      from_session?: string;
      onProgress?: (progress: WorkflowProgress) => void;
    }
  ): Promise<WorkflowResult> {
    const { autoMode, onProgress, model, thinking, policy, memory_level, from_session } = options;
    const executionId = randomUUID();
    const startTime = Date.now();
    const originalSessionId = this.wireClient.getSessionId();

    const stepResults: StepResult[] = [];
    let status: ExecutionStatus = "running";

    if (!this.wireClient.isConnected()) {
      return {
        executionId,
        template: template.name,
        sessionId: "",
        status: "failed" as ExecutionStatus,
        steps: [],
        summary: "Wire client not connected to Kimi Server",
        totalDuration: Date.now() - startTime,
        nextStepOptions: ["retry", "abort"],
      };
    }

    // ── Create task session ──────────────────────────────────────────────────
    let sessionId: string;
    try {
      const created = await this.wireClient.createSession({
        cwd: template.projectCwd,
        title: `[WF] ${template.name}`,
        permissionMode: autoMode ? "auto" : "manual",
        model,
        thinking,
      });
      sessionId = created.sessionId;

      // Bind policy to the newly created task session
      if (policy) {
        try {
          this.wireClient.setSessionPolicy(sessionId, policy, template.projectCwd);
        } catch (policyErr) {
          process.stderr.write(`[workflow-engine] Policy binding warning: ${(policyErr as Error).message}\n`);
        }
      }

      // Store memory profile for auto-injection on first step (SPEC 002)
      if (memory_level && memory_level !== "off") {
        try {
          if (this.memoryStore && this.tunnelProjectRoot) {
            this.memoryStore.ensureDb(this.tunnelProjectRoot);
            // Check for expired entries in relevant namespaces
            const nsToCheck = memory_level === "minimal"
              ? ["project/meta"]
              : memory_level === "standard"
              ? ["project/meta", "project/decisions"]
              : ["project/meta", "project/decisions", "project/risks", "project/learnings"];
            let hasExpired = false;
            for (const ns of nsToCheck) {
              const entries = this.memoryStore.get(ns);
              if (entries.some((e) => e.expired)) { hasExpired = true; break; }
            }
            this.wireClient.setMemoryProfile(sessionId, {
              level: memory_level,
              cwd: template.projectCwd,
              fromSession: from_session,
              hasExpiredEntries: hasExpired,
            });
            process.stderr.write(`[workflow-engine] Memory profile set for ${sessionId} (level: ${memory_level})\n`);
          }
        } catch (memErr) {
          // Non-fatal: memory injection failure shouldn't block workflow
          process.stderr.write(`[workflow-engine] Memory profile warning: ${(memErr as Error).message}\n`);
        }
      }

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
      // Restore original session on failure
      if (originalSessionId) this.wireClient.setSessionId(originalSessionId);
      return {
        executionId,
        template: template.name,
        sessionId: "",
        status: "failed",
        steps: stepResults,
        summary: `Failed to create session: ${(err as Error).message}`,
        totalDuration: Date.now() - startTime,
        nextStepOptions: this.buildNextStepOptions("failed"),
      };
    }

    // ── Drive steps ──────────────────────────────────────────────────────────
    try {
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const result = await this.driveStep(
          sessionId,
          step,
          i,
          template,
          autoMode,
          onProgress
        );
        stepResults.push(result);

        if (result.status === "blocked") {
          const unresolvedBlockage = result.blockages.find((b) => b.needsUserDecision);
          if (unresolvedBlockage) {
            status = "awaiting_user";
            this.activeExecutions.set(executionId, {
              executionId,
              template,
              sessionId,
              currentStepIndex: i,
              stepResults,
              status: "awaiting_user",
              autoMode,
              onProgress,
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

    // Restore original session
    if (originalSessionId) this.wireClient.setSessionId(originalSessionId);

    // Clean up: remove terminal executions
    if (status !== "awaiting_user") {
      this.activeExecutions.delete(executionId);
    }

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
        // Build effective instruction — inject shared memory on first step (SPEC 002)
        let instruction = step.instruction;
        if (stepIndex === 0 && this.memoryStore && this.tunnelProjectRoot) {
          const profile = this.wireClient.getMemoryProfile(sessionId);
          if (profile && profile.level !== "off") {
            try {
              const injection = this.memoryStore.buildInjection({
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
                instruction = `${warning}${injection}\n\n---\n\n${instruction}`;
              }
            } catch {
              // Non-fatal: memory injection failure shouldn't block the step
            }
          }
        }

        // Send instruction and wait for response
        const response = await this.wireClient.sendPrompt(instruction, {
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
            blockages.push(blockage);
            if (attempt <= maxRetries) {
              const adjustedInstruction = `${step.instruction}\n\n[上一步遇到问题: ${blockage.context.slice(0, 200)}]\n${blockage.resolution}`;
              await this.wireClient.sendPrompt(adjustedInstruction, {
                timeoutMs: template.timeout.perStep,
                autoApprove: autoMode,
              });
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
          if (response.thinkingText) {
            thinkingSummary = summarizeThinking(response.thinkingText);
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

  async handleBlockage(
    executionId: string,
    decision: "retry" | "skip" | "abort" | "manual",
    options: { instruction?: string } = {}
  ): Promise<WorkflowResult | null> {
    const state = this.activeExecutions.get(executionId);
    if (!state) return null;

    const { template, sessionId, currentStepIndex, stepResults, autoMode, onProgress } = state;
    const startTime = Date.now();

    switch (decision) {
      case "retry": {
        const step = template.steps[currentStepIndex];
        const result = await this.driveStep(
          sessionId, step, currentStepIndex, template, autoMode, onProgress
        );
        stepResults[currentStepIndex] = result;
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, onProgress, startTime);
      }
      case "skip": {
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
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, onProgress, startTime);
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
        const step = template.steps[currentStepIndex];
        const manualInstruction = options.instruction || step.instruction;
        const result = await this.driveStep(
          sessionId,
          { ...step, instruction: manualInstruction },
          currentStepIndex, template, autoMode, onProgress
        );
        stepResults[currentStepIndex] = result;
        return await this.resumeExecution(executionId, sessionId, currentStepIndex + 1, template, stepResults, autoMode, onProgress, startTime);
      }
    }
  }

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
    onProgress: ((p: WorkflowProgress) => void) | undefined,
    startTime: number
  ): Promise<WorkflowResult> {
    let status: ExecutionStatus = "running";

    try {
      for (let i = startStep; i < template.steps.length; i++) {
        const step = template.steps[i];
        const result = await this.driveStep(
          sessionId, step, i, template, autoMode, onProgress
        );
        stepResults.push(result);

        if (result.status === "blocked") {
          const unresolvedBlockage = result.blockages.find((b) => b.needsUserDecision);
          if (unresolvedBlockage) {
            status = "awaiting_user";
            this.activeExecutions.set(executionId, {
              executionId, template, sessionId,
              currentStepIndex: i, stepResults,
              status: "awaiting_user", autoMode, onProgress,
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

// ── Thinking summarization ──────────────────────────────────────────────────────

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
