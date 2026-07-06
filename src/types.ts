import type { WireClient } from "./wire-client.js";
import type { MessageQueue } from "./message-queue.js";
import type { WorkflowResult, BlockageEvent } from "./workflow-template.js";

export interface WorkflowProgress {
  template: string;
  currentStep: number;
  totalSteps: number;
  stepId: string;
  sessionId: string;
  status: "executing" | "done" | "blocked" | "error";
  lastResponse: string;
  blockage: Record<string, unknown> | null;
  timestamp: string;
}

export interface IWorkflowEngine {
  execute(template: unknown, options: { autoMode: boolean; model?: string; thinking?: string; onProgress?: (p: WorkflowProgress) => void }): Promise<WorkflowResult>;
  handleBlockage(executionId: string, decision: "retry" | "skip" | "abort" | "manual", options?: { instruction?: string }): Promise<WorkflowResult | null>;
  getExecution(executionId: string): {
    executionId: string; template: string; sessionId: string;
    currentStep: number; totalSteps: number; status: string; stepResults: unknown[];
  } | null;
  getFlow(sessionId: string): {
    executionId: string; status: string; currentStep: number; totalSteps: number;
  } | null;
}

export interface TunnelServices {
  wireClient: WireClient;
  messageQueue: MessageQueue;
  startTime: number;
  workflowEngine?: IWorkflowEngine;
}
