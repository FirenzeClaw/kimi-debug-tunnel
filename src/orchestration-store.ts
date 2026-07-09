/**
 * Lightweight in-memory store tracking PM session → child session relationships.
 * Records child creation when PM uses create_session / execute_workflow tools.
 */
export interface ChildRecord {
  session_id: string;
  cwd: string;
  status: string;
  created_at: string;
}

export interface OrchestrationEntry {
  pm_session_id: string;
  cwd: string;
  children: ChildRecord[];
}

export class OrchestrationStore {
  private entries = new Map<string, OrchestrationEntry>();

  /**
   * Record that a PM session created a child session.
   * The PM session is the tunnel's current session at time of creation.
   */
  recordChildCreation(
    pmSessionId: string,
    pmCwd: string,
    childSessionId: string,
    childCwd: string
  ): void {
    let entry = this.entries.get(pmSessionId);
    if (!entry) {
      entry = { pm_session_id: pmSessionId, cwd: pmCwd, children: [] };
      this.entries.set(pmSessionId, entry);
    }
    // Avoid duplicates
    if (!entry.children.some((c) => c.session_id === childSessionId)) {
      entry.children.push({
        session_id: childSessionId,
        cwd: childCwd,
        status: "active",
        created_at: new Date().toISOString(),
      });
    }
  }

  /** Update the status of a child session. */
  updateChildStatus(pmSessionId: string, childSessionId: string, status: string): void {
    const entry = this.entries.get(pmSessionId);
    if (!entry) return;
    const child = entry.children.find((c) => c.session_id === childSessionId);
    if (child) {
      child.status = status;
    }
  }

  /** Clean up entries for a PM session that is no longer active. */
  removePmSession(pmSessionId: string): void {
    this.entries.delete(pmSessionId);
  }

  /** Get all orchestration entries for the API response. */
  getAll(): OrchestrationEntry[] {
    return Array.from(this.entries.values());
  }

  /** Get count of tracked PM sessions. */
  get size(): number {
    return this.entries.size;
  }
}
