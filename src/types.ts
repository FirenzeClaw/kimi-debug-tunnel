import type { WireClient } from "./wire-client.js";
import type { MessageQueue } from "./message-queue.js";
import type { WorkflowResult, BlockageEvent } from "./workflow-template.js";
import type { IPolicyEngine } from "./policy-engine.js";
import type { OrchestrationStore } from "./orchestration-store.js";

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
  execute(template: unknown, options: { autoMode: boolean; model?: string; thinking?: string; policy?: string; memory_level?: string; from_session?: string; onProgress?: (p: WorkflowProgress) => void }): Promise<WorkflowResult>;
  handleBlockage(executionId: string, decision: "retry" | "skip" | "abort" | "manual", options?: { instruction?: string }): Promise<WorkflowResult | null>;
  getExecution(executionId: string): {
    executionId: string; template: string; sessionId: string;
    currentStep: number; totalSteps: number; status: string; stepResults: unknown[];
  } | null;
  getFlow(sessionId: string): {
    executionId: string; status: string; currentStep: number; totalSteps: number;
  } | null;
  setMemoryStore(store: IMemoryStore, projectRoot: string | null): void;
}

// === Memory Store Types (SPEC 002) ===

export interface MemoryEntry {
  id: number;
  namespace: string;
  key: string;
  value: string;
  sourceSessionId: string | null;
  version: number;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
  projectId: string;
}

export interface InjectionProfile {
  level: "off" | "minimal" | "standard" | "full";
  maxBytes: number;
  fromSession?: string;
  cwd?: string;
  hasExpiredEntries?: boolean;
}

export interface IMemoryStore {
  resolveProjectRoot(cwd: string): string | null;
  ensureDb(projectRoot: string): void;
  set(namespace: string, key: string, value: string, sessionId?: string, expire?: boolean): MemoryEntry;
  get(namespace: string, key?: string, includeExpired?: boolean): MemoryEntry[];
  list(namespace?: string): Array<{ path: string; keys: string[]; count: number }>;
  delete(namespace: string, key: string): void;
  status(): {
    projectRoot: string; dbPath: string; totalEntries: number;
    activeEntries: number; expiredEntries: number;
    namespaces: Record<string, number>; lastUpdated: string | null;
  };
  archive(sessionId: string, targetNs?: string, keys?: string[]): { archived: number; source: string; target: string };
  buildInjection(profile: InjectionProfile): string;
  close(): void;
}

// === Tunnel Services ===

export interface TunnelServices {
  wireClient: WireClient;
  messageQueue: MessageQueue;
  startTime: number;
  workflowEngine?: IWorkflowEngine;
  policyEngine?: IPolicyEngine;
  memoryStore?: IMemoryStore;
  orchestrationStore?: OrchestrationStore;
  /** Tunnel 自身的项目根目录，用于跨项目 session 注入时定位 memory.db */
  tunnelProjectRoot?: string | null;
}
