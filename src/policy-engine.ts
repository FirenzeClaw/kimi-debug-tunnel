/**
 * Policy engine — resolves policies, checks tool calls against rules,
 * and manages session-policy bindings.
 *
 * Implements the IPolicyEngine interface for DI through TunnelServices.
 */

import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Policy, PolicyDecision, BlockEvent, SessionPolicyBinding } from "./policy-types.js";
import { BUILTIN_POLICIES } from "./policy-builtins.js";
import { loadPolicyFile, listPolicyFiles } from "./policy-store.js";

// ── Interface ───────────────────────────────────────────────────────────────────

export interface IPolicyEngine {
  /** Resolve a policy spec to a Policy object. */
  resolve(policySpec: string, cwd?: string): Policy;
  /** Check a tool call against a policy. */
  check(policy: Policy, toolName: string): PolicyDecision;
  /** Bind a session to a policy. */
  bind(sessionId: string, policy: Policy, boundBy?: string): void;
  /** Remove a session's policy binding. */
  unbind(sessionId: string): void;
  /** Get the active policy for a session. */
  getActivePolicy(sessionId: string): Policy | null;
  /** Generate a human-readable block message. */
  getBlockMessage(policy: Policy, ruleName: string, toolName: string): string;
  /** List all available policies (built-in + custom). */
  listPolicies(cwd: string): { builtin: string[]; custom: ReturnType<typeof listPolicyFiles> };
  /** Record a block event for audit and dashboard. */
  recordBlock(block: BlockEvent): void;
  /** Get pending (unresolved) block events. */
  getPendingBlocks(): BlockEvent[];
  /** Resolve a block event. */
  resolveBlock(blockId: string, resolution: "approved" | "denied"): BlockEvent | null;
  /** Get unresolved block events for a specific session. */
  getBlocksBySession(sessionId: string): BlockEvent[];
}

// ── Implementation ──────────────────────────────────────────────────────────────

export class PolicyEngine implements IPolicyEngine {
  /** Session → policy bindings (in-memory, tied to tunnel process lifetime). */
  private bindings = new Map<string, SessionPolicyBinding>();

  /** Block event records for audit and PM dashboard. */
  private blocks = new Map<string, BlockEvent>();

  // ── Resolve ──────────────────────────────────────────────────────────────────

  resolve(policySpec: string, cwd?: string): Policy {
    // Built-in policies
    if (BUILTIN_POLICIES.has(policySpec)) {
      return BUILTIN_POLICIES.get(policySpec)!;
    }

    // File path policies
    if (policySpec.endsWith(".yaml") || policySpec.endsWith(".yml")) {
      const fullPath = cwd
        ? pathResolve(cwd, policySpec)
        : pathResolve(policySpec);
      return loadPolicyFile(fullPath);
    }

    // Try as a built-in name with different casing/spacing
    throw new Error(
      `无效的策略标识: "${policySpec}"。有效值: "read-only", "safe-edit", "full-access"，或策略文件路径（如 ".kimi-tunnel/policies/review.yaml"）`
    );
  }

  // ── Check ────────────────────────────────────────────────────────────────────

  check(policy: Policy, toolName: string): PolicyDecision {
    for (const rule of policy.rules) {
      if (rule.tools.includes(toolName)) {
        return {
          action: rule.action,
          ruleName: rule.name,
          message: rule.action === "deny"
            ? this.getBlockMessage(policy, rule.name, toolName)
            : undefined,
        };
      }
    }

    // No rule matched — use default action
    const defaultAction = policy.defaultAction;
    return {
      action: defaultAction,
      message: defaultAction === "deny"
        ? this.getBlockMessage(policy, "(default)", toolName)
        : undefined,
    };
  }

  // ── Bind / Unbind ────────────────────────────────────────────────────────────

  bind(sessionId: string, policy: Policy, boundBy?: string): void {
    this.bindings.set(sessionId, {
      sessionId,
      policyName: policy.name,
      boundAt: new Date().toISOString(),
      boundBy,
    });
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  getActivePolicy(sessionId: string): Policy | null {
    const binding = this.bindings.get(sessionId);
    if (!binding) return null;

    // Try built-in first
    const builtin = BUILTIN_POLICIES.get(binding.policyName);
    if (builtin) return builtin;

    // Not found — binding is stale (file policy from previous process)
    process.stderr.write(
      `[policy-engine] Stale binding for session ${sessionId}: policy "${binding.policyName}" not found (file may have been deleted or process restarted)\n`
    );
    this.unbind(sessionId);
    return null;
  }

  // ── Block message ────────────────────────────────────────────────────────────

  getBlockMessage(policy: Policy, ruleName: string, toolName: string): string {
    const base = `🔒 策略阻断: [${policy.name}] 规则 '${ruleName}' 禁止使用 ${toolName}。`;

    // Find the matching rule to get its custom message
    const rule = policy.rules.find((r) => r.name === ruleName);
    const customMsg = rule?.message ? ` ${rule.message}` : "";

    const suggestion = this.getSuggestion(policy.name, toolName);

    return `${base}${customMsg}${suggestion}`;
  }

  /** Suggest alternative tools when a tool is blocked. */
  private getSuggestion(policyName: string, toolName: string): string {
    if (policyName === "read-only") {
      if (toolName === "Write" || toolName === "Edit") {
        return " 建议：使用 Read 检查文件内容，审查完成后由 PM 执行修改。";
      }
      if (toolName === "Bash") {
        return " 建议：使用 Read/Grep/Glob 完成审查，由 PM 执行构建和测试命令。";
      }
      return " 如需此操作，请联系 PM 调整策略或使用 approve_tool 放行。";
    }
    if (policyName === "safe-edit") {
      if (toolName === "Bash") {
        return " 建议：仅编辑文件（Write/Edit 可用），构建和测试命令请联系 PM 执行。";
      }
      return " 如需此操作，请联系 PM 调整策略。";
    }
    return " 如需此操作，请联系 PM 调整策略。";
  }

  // ── List ─────────────────────────────────────────────────────────────────────

  listPolicies(cwd: string): { builtin: string[]; custom: ReturnType<typeof listPolicyFiles> } {
    return {
      builtin: Array.from(BUILTIN_POLICIES.keys()),
      custom: listPolicyFiles(cwd),
    };
  }

  // ── Block event tracking ─────────────────────────────────────────────────────

  recordBlock(block: BlockEvent): void {
    this.blocks.set(block.id, block);
  }

  getPendingBlocks(): BlockEvent[] {
    return Array.from(this.blocks.values()).filter((b) => !b.resolved);
  }

  getBlocksBySession(sessionId: string): BlockEvent[] {
    return Array.from(this.blocks.values()).filter(
      (b) => b.sessionId === sessionId && !b.resolved
    );
  }

  resolveBlock(blockId: string, resolution: "approved" | "denied"): BlockEvent | null {
    const block = this.blocks.get(blockId);
    if (!block) return null;
    block.resolved = true;
    block.resolution = resolution;
    this.blocks.set(blockId, block);
    return block;
  }
}
