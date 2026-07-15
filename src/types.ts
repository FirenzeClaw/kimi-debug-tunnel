import type { MessageQueue } from "./message-queue.js";
import type { WorkflowResult, BlockageEvent } from "./workflow-template.js";
import type { IPolicyEngine } from "./policy-engine.js";
import type { OrchestrationStore } from "./orchestration-store.js";
import type {
  KimiContentBlock,
  TurnPromptResponse,
  CreateSessionOptions,
} from "./wire-client.js";

// === Wire Client Interfaces (v2.11 — split from 20-method monolith into 3 focused interfaces) ===

/** Session lifecycle + prompt submission — used by tools that create/manage sessions. */
export interface ISessionClient {
  createSession(opts: CreateSessionOptions): Promise<{ sessionId: string; title: string }>;
  submitPrompt(
    sessionId: string,
    prompt: string,
    opts?: { autoApprove?: boolean }
  ): Promise<{ promptId: string }>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    opts?: {
      timeoutMs?: number;
      includeThinking?: boolean;
      autoApprove?: boolean;
    }
  ): Promise<TurnPromptResponse>;
  setSessionPolicy(sessionId: string, policySpec: string, cwd?: string, boundBy?: string): void;

  // Semantic methods replacing raw apiGet/apiPost (v2.11)
  /** Fetch session messages — replaces apiGet("/api/v1/sessions/SID/messages?...") */
  getSessionMessages(
    sessionId: string,
    opts?: { pageSize?: number; role?: string }
  ): Promise<KimiContentBlock[]>;
  /** Resolve an approval — replaces apiPost("/api/v1/sessions/SID/approvals/AID", ...) */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    action: "approved" | "rejected",
    reason?: string
  ): Promise<void>;

  // Utility
  getThinkingFromMessages(messages: KimiContentBlock[]): string;
  filterTextOnly(messages: KimiContentBlock[]): KimiContentBlock[];

  /** PM session ID for orchestration tracking (read-only, no mutation). */
  getPmSessionId(): string;
}

/** Session status queries — used by monitoring tools. */
export interface IStatusClient {
  getSessionStatus(sessionId: string): Promise<string>;
  getCachedStatus(sessionId: string): string | null;
}

/** Wire lifecycle + push events — used by index.ts and session-watcher. */
export interface IPushClient {
  isConnected(): boolean;
  isWsConnected(): boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  startHealthCheck(): void;
  setMessageQueue(mq: MessageQueue): void;
  setPolicyEngine(pe: IPolicyEngine): void;
  setWatchOutput(path: string): void;
}

// === Backward-compatible composite (v2.11) ===

export interface IWireClient extends ISessionClient, IStatusClient, IPushClient {}

// === Workflow Types ===

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
  /** Store memory injection profile for a session (v2.10: moved from WireClient). */
  setMemoryProfile(sessionId: string, profile: { level: string; cwd: string; fromSession?: string; hasExpiredEntries?: boolean }): void;
  /** Retrieve memory injection profile for a session (v2.10: moved from WireClient). */
  getMemoryProfile(sessionId: string): { level: string; cwd: string; fromSession?: string; hasExpiredEntries?: boolean } | null;
  close(): void;
}

// === Tunnel Services ===

export interface TunnelServices {
  // v2.11: split interfaces (preferred for new code)
  sessionClient: ISessionClient;
  statusClient: IStatusClient;
  pushClient: IPushClient;
  // Backward compat alias
  wireClient: IWireClient;
  messageQueue: MessageQueue;
  startTime: number;
  workflowEngine: IWorkflowEngine;
  policyEngine?: IPolicyEngine;
  memoryStore?: IMemoryStore;
  orchestrationStore?: OrchestrationStore;
  /** Tunnel 自身的项目根目录，用于跨项目 session 注入时定位 memory.db */
  tunnelProjectRoot?: string | null;
}
