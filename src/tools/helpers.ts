/**
 * Shared tool helpers — eliminate duplicated memory injection, policy binding,
 * and connection check across tool files.
 *
 * v2.10: Extracted from execute-prompt.ts, chat-with-session.ts, create-session.ts,
 * and workflow-engine.ts (~25 lines each × 4 = ~100 lines saved).
 * v2.11: Extracted injectMemoryIntoPrompt + setMemoryProfileWithExpiry to
 * eliminate the last two duplicated memory-injection copies (workflow-engine.ts,
 * create-session.ts).
 */

import type { TunnelServices, IMemoryStore, InjectionProfile } from "../types.js";

export interface PreparePromptOpts {
  sessionId: string;
  prompt: string;
  skipMemory?: boolean;
  policy?: string;
  cwd?: string;  // used for policy resolution
}

/**
 * Pure function: inject shared memory text into a prompt if a profile exists.
 * Called by preparePrompt (tools) and workflow-engine driveStep (private).
 * No side effects beyond reading from memoryStore.
 *
 * @returns The prompt text with memory injection prepended, or the original prompt.
 */
export function injectMemoryIntoPrompt(
  memoryStore: IMemoryStore,
  tunnelProjectRoot: string,
  sessionId: string,
  prompt: string,
  profile: { level: string; cwd: string; fromSession?: string; hasExpiredEntries?: boolean }
): string {
  if (profile.level === "off") return prompt;
  try {
    memoryStore.ensureDb(tunnelProjectRoot);
    const injection = memoryStore.buildInjection({
      level: profile.level as InjectionProfile["level"],
      maxBytes: 8192,
      fromSession: profile.fromSession,
      cwd: profile.cwd,
      hasExpiredEntries: profile.hasExpiredEntries,
    });
    if (injection) {
      const warning = profile.hasExpiredEntries
        ? "⚠️ 警告: 以下注入的部分条目已被 PM 标记为过期，内容可能不是最新。\n\n"
        : "";
      return `${warning}${injection}\n\n---\n\n${prompt}`;
    }
  } catch {
    // Non-fatal: memory injection failure shouldn't block
  }
  return prompt;
}

/**
 * Set a memory profile on a session after checking for expired entries.
 * Extracted from create-session.ts and workflow-engine.ts:execute().
 * No-op if memoryStore or tunnelProjectRoot is absent.
 */
export function setMemoryProfileWithExpiry(
  memoryStore: IMemoryStore | null | undefined,
  tunnelProjectRoot: string | null | undefined,
  sessionId: string,
  opts: { level: string; cwd: string; fromSession?: string }
): void {
  if (!memoryStore || !tunnelProjectRoot) return;
  if (opts.level === "off") return;
  try {
    memoryStore.ensureDb(tunnelProjectRoot);
    const nsToCheck =
      opts.level === "minimal"
        ? ["project/meta"]
        : opts.level === "standard"
        ? ["project/meta", "project/decisions"]
        : ["project/meta", "project/decisions", "project/risks", "project/learnings"];
    let hasExpired = false;
    for (const ns of nsToCheck) {
      const entries = memoryStore.get(ns);
      if (entries.some((e) => e.expired)) { hasExpired = true; break; }
    }
    memoryStore.setMemoryProfile(sessionId, {
      level: opts.level,
      cwd: opts.cwd,
      fromSession: opts.fromSession,
      hasExpiredEntries: hasExpired,
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Prepare a prompt with optional memory injection and policy binding.
 * Returns the effective prompt text (possibly augmented with injected memory).
 *
 * Side-effects:
 * - Binds a policy to the session if `policy` is specified.
 * - Reads and injects shared memory if `skipMemory` is false and a profile exists.
 */
export function preparePrompt(
  services: TunnelServices,
  opts: PreparePromptOpts
): string {
  const { wireClient, memoryStore, tunnelProjectRoot } = services;
  const { sessionId, prompt, skipMemory, policy, cwd } = opts;

  // Bind policy if specified (non-fatal on failure)
  if (policy) {
    try {
      wireClient.setSessionPolicy(sessionId, policy, cwd);
    } catch {
      // Non-fatal: policy binding failure shouldn't block prompt submission
    }
  }

  // Build effective prompt with optional memory injection (SPEC 002)
  if (!skipMemory && memoryStore && tunnelProjectRoot) {
    const profile = memoryStore.getMemoryProfile(sessionId);
    if (profile) {
      return injectMemoryIntoPrompt(memoryStore, tunnelProjectRoot, sessionId, prompt, profile);
    }
  }

  return prompt;
}

/**
 * Ensure the wire client is connected. Tries a single connect() attempt.
 * Returns true if connected, false otherwise.
 */
export async function ensureConnected(
  services: TunnelServices
): Promise<boolean> {
  const { wireClient } = services;
  if (wireClient.isConnected()) return true;
  try {
    await wireClient.connect();
    return wireClient.isConnected();
  } catch {
    return false;
  }
}
