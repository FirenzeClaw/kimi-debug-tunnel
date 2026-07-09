/**
 * Session tree state management.
 * Merges orchestration relationships with Kimi Server session details.
 */

/**
 * Build a SessionTree from orchestration data and session details.
 * @param {Array} orchestrations - from tunnel GET /api/orchestrations
 * @param {Array} sessions - from Kimi Server GET /api/v1/sessions
 * @returns {{ pmSessions: Array, lastUpdated: number }}
 */
function buildTree(orchestrations, sessions) {
  if (!orchestrations || !sessions) {
    return { pmSessions: [], lastUpdated: Date.now() };
  }

  // Create session lookup by ID
  const sessionMap = {};
  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      sessionMap[s.id] = s;
    }
  }

  const pmSessions = [];
  for (const orch of orchestrations) {
    const pmDetail = sessionMap[orch.pm_session_id] || {};
    const children = (orch.children || []).map((child) => {
      const childDetail = sessionMap[child.session_id] || {};
      return {
        id: child.session_id,
        title: childDetail.title || child.session_id,
        status: childDetail.status || child.status || "unknown",
        updatedAt: childDetail.updated_at || child.created_at || "",
        cwd: child.cwd || "",
      };
    });

    pmSessions.push({
      id: orch.pm_session_id,
      title: pmDetail.title || orch.pm_session_id,
      status: pmDetail.status || "active",
      updatedAt: pmDetail.updated_at || "",
      cwd: orch.cwd || "",
      children,
    });
  }

  return { pmSessions, lastUpdated: Date.now() };
}

/**
 * Compare two trees and return changes.
 * @returns {{ added: Array, removed: Array, changed: Array }}
 */
function diffTree(oldTree, newTree) {
  const added = [];
  const removed = [];
  const changed = [];

  const oldIds = new Set(oldTree.pmSessions.map((p) => p.id));
  const newIds = new Set(newTree.pmSessions.map((p) => p.id));

  for (const p of newTree.pmSessions) {
    if (!oldIds.has(p.id)) {
      added.push(p);
    } else {
      const oldPm = oldTree.pmSessions.find((o) => o.id === p.id);
      if (oldPm && (oldPm.status !== p.status || oldPm.updatedAt !== p.updatedAt)) {
        changed.push(p);
      }
      // Check children changes
      for (const c of p.children) {
        const oldChild = oldPm ? oldPm.children.find((oc) => oc.id === c.id) : null;
        if (!oldChild) {
          added.push(c);
        } else if (oldChild.status !== c.status || oldChild.updatedAt !== c.updatedAt) {
          changed.push(c);
        }
      }
    }
  }

  for (const p of oldTree.pmSessions) {
    if (!newIds.has(p.id)) {
      removed.push(p);
    }
  }

  return { added, removed, changed };
}
