/**
 * Policy type definitions and Zod validation schemas.
 *
 * Defines the data structures for the three-level permission system:
 *   L1: Session-level permission_mode (existing, not defined here)
 *   L2: Task-level policy (Policy, PolicyRule)
 *   L3: Tool-level interception (PolicyDecision)
 */

import { z } from "zod";

// ── Core types ──────────────────────────────────────────────────────────────────

/** Named action a policy rule can take when it matches a tool call. */
export type PolicyAction = "allow" | "deny" | "require_approval";

/** Single rule within a policy — matches tools by name and specifies an action. */
export interface PolicyRule {
  /** Human-readable rule name, used in block messages. */
  name: string;
  /** Action to take when this rule matches. */
  action: PolicyAction;
  /** Tool names to match against (kimi-code built-in tool names). */
  tools: string[];
  /** Optional message shown to the session when denied. */
  message?: string;
}

/** Source of a policy — either a built-in level or a user-defined YAML file. */
export type PolicySource = "builtin" | "file";

/** Complete policy definition. */
export interface Policy {
  /** Unique policy name (built-in: "read-only"|"safe-edit"|"full-access"; file: filename without .yaml). */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Default action when no rule matches. */
  defaultAction: PolicyAction;
  /** Ordered list of rules — first match wins. */
  rules: PolicyRule[];
  /** Where this policy came from. */
  source: PolicySource;
  /** File path for file-source policies. */
  filePath?: string;
}

/** Result of checking a tool call against a policy. */
export interface PolicyDecision {
  /** Whether the tool is allowed, denied, or requires PM approval. */
  action: PolicyAction;
  /** Name of the matching rule, if any. */
  ruleName?: string;
  /** Human-readable block message, if denied. */
  message?: string;
}

/** Built-in policy name constants. */
export const BUILTIN_POLICY_NAMES = ["read-only", "safe-edit", "full-access"] as const;
export type BuiltinPolicyName = (typeof BUILTIN_POLICY_NAMES)[number];

/** Session-policy binding record. */
export interface SessionPolicyBinding {
  sessionId: string;
  policyName: string;
  boundAt: string;
  /** PM session ID that created the binding. */
  boundBy?: string;
}

/** A blocked tool call event, recorded for audit and dashboard display. */
export interface BlockEvent {
  id: string;
  sessionId: string;
  toolName: string;
  policyName: string;
  ruleName: string;
  action: "deny" | "require_approval";
  message: string;
  timestamp: string;
  resolved: boolean;
  resolution: "approved" | "denied" | null;
  /** Kimi Server approval ID — used by PM to POST override via approve_tool. */
  approvalId?: string;
}

// ── Known kimi-code tool names ──────────────────────────────────────────────────

/** All kimi-code built-in tool names that policies may reference.
 *  Must be updated when new tools are added to kimi-code. */
export const KNOWN_TOOLS = [
  // Read-only tools
  "Read", "Grep", "Glob", "WebSearch", "FetchURL", "TaskList",
  // Write tools
  "Write", "Edit",
  // Execution tools
  "Bash", "Agent", "AgentSwarm", "TaskStop", "TaskOutput",
  // Tunnel status tools
  "list_sessions", "poll_session", "get_session_info",
  "list_io_records", "read_session_log", "get_tunnel_status",
  "list_templates", "list_workflow_templates",
  // Workflow tools
  "execute_prompt", "chat_with_session", "create_session",
  "run_flow", "learn_workflow", "execute_workflow",
  "continue_workflow", "watch_session", "get_watch_result",
  "continue_watch", "set_watch_output", "stream_response",
] as const;

export type KnownToolName = (typeof KNOWN_TOOLS)[number];

/** Check whether a tool name is in the known tools list. */
export function isKnownTool(name: string): name is KnownToolName {
  return (KNOWN_TOOLS as readonly string[]).includes(name);
}

// ── Zod schemas for YAML file validation ────────────────────────────────────────

export const PolicyRuleSchema = z.object({
  name: z.string().min(1).max(128).describe("Rule name, unique within the policy"),
  action: z.enum(["allow", "deny", "require_approval"]).describe("Action when rule matches"),
  tools: z.array(z.string().min(1)).min(1).describe("Tool names to match"),
  message: z.string().max(500).optional().describe("Message shown when denied"),
});

export const PolicySchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9-]+$/, "Only letters, digits, and hyphens allowed"),
  version: z.string().min(1).describe("Semantic version"),
  default_action: z.enum(["allow", "deny"]).describe("Default action when no rule matches"),
  rules: z.array(PolicyRuleSchema).min(1).describe("Ordered list of rules (first match wins)"),
});
