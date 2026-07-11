import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { MemoryEntry, InjectionProfile, IMemoryStore } from "./types.js";

export class MemoryStore implements IMemoryStore {
  private db: DatabaseSync | null = null;
  private projectRoot: string | null = null;

  resolveProjectRoot(cwd: string): string | null {
    let dir = cwd.replace(/\\/g, "/");
    // Walk up directory tree looking for .kimi-tunnel/
    while (true) {
      const tunnelDir = join(dir, ".kimi-tunnel");
      if (existsSync(tunnelDir)) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  }

  ensureDb(projectRoot: string): void {
    // Guard: already opened for the same project
    if (this.db && this.projectRoot === projectRoot) return;

    // Close previous connection if switching projects
    this.close();

    const tunnelDir = join(projectRoot, ".kimi-tunnel");
    if (!existsSync(tunnelDir)) {
      mkdirSync(tunnelDir, { recursive: true });
    }

    const dbPath = join(tunnelDir, "memory.db");
    this.db = new DatabaseSync(dbPath);
    this.projectRoot = projectRoot;

    // Enable WAL mode for better concurrency (future-proof)
    this.db.exec("PRAGMA journal_mode=WAL");

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        project_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source_session_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        expired INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        project_id TEXT NOT NULL,
        UNIQUE(project_id, namespace, key)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_namespace
      ON entries(project_id, namespace)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_updated
      ON entries(project_id, updated_at)
    `);

    // Upsert project_meta
    const projectId = projectRoot.replace(/[^a-zA-Z0-9]/g, "_");
    this.db.prepare(
      `INSERT OR REPLACE INTO project_meta (project_id, project_root, updated_at)
       VALUES (?, ?, datetime('now'))`
    ).run(projectId, projectRoot);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      const tunnelPath = this.projectRoot ? join(this.projectRoot, ".kimi-tunnel") : null;
      const hasTunnelDir = tunnelPath ? existsSync(tunnelPath) : false;
      throw new Error(
        hasTunnelDir
          ? "知识库 DB 未打开。请重启 Tunnel 以触发启动初始化。"
          : "知识库未初始化。在项目根目录创建 .kimi-tunnel/ 目录以启用共享内存功能。"
      );
    }
    return this.db;
  }

  private projectId(): string {
    return (this.projectRoot || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
  }

  set(
    namespace: string,
    key: string,
    value: string,
    sessionId?: string,
    expire?: boolean
  ): MemoryEntry {
    const db = this.requireDb();
    const pid = this.projectId();

    // Enforce 64KB value limit to prevent abuse
    if (Buffer.byteLength(value, "utf-8") > 65536) {
      throw new Error("value 超过 64KB 上限");
    }

    // Get current version for upsert
    const existing = db.prepare(
      `SELECT version FROM entries WHERE project_id = ? AND namespace = ? AND key = ?`
    ).get(pid, namespace, key) as { version: number } | undefined;

    const newVersion = existing ? existing.version + 1 : 1;
    const expiredVal = expire ? 1 : 0;

    db.prepare(
      `INSERT OR REPLACE INTO entries
       (namespace, key, value, source_session_id, version, expired, updated_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
    ).run(namespace, key, value, sessionId || null, newVersion, expiredVal, pid);

    return {
      id: 0, // not needed for return
      namespace,
      key,
      value,
      sourceSessionId: sessionId || null,
      version: newVersion,
      expired: expire || false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectId: pid,
    };
  }

  get(namespace: string, key?: string, includeExpired?: boolean): MemoryEntry[] {
    const db = this.requireDb();
    const pid = this.projectId();

    let sql = `SELECT * FROM entries WHERE project_id = ? AND namespace = ?`;
    const params: (string | number)[] = [pid, namespace];

    if (key) {
      sql += ` AND key = ?`;
      params.push(key);
    }

    if (!includeExpired) {
      sql += ` AND expired = 0`;
    }

    sql += ` ORDER BY updated_at DESC`;

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEntry(r));
  }

  list(namespace?: string): Array<{ path: string; keys: string[]; count: number }> {
    const db = this.requireDb();
    const pid = this.projectId();

    let sql = `SELECT namespace, key FROM entries WHERE project_id = ? AND expired = 0`;
    const params: string[] = [pid];

    if (namespace) {
      sql += ` AND namespace LIKE ?`;
      params.push(`${namespace}%`);
    }

    sql += ` ORDER BY namespace, key`;

    const rows = db.prepare(sql).all(...params) as Array<{ namespace: string; key: string }>;

    // Group by namespace
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const keys = map.get(row.namespace) || [];
      keys.push(row.key);
      map.set(row.namespace, keys);
    }

    return Array.from(map.entries()).map(([path, keys]) => ({
      path,
      keys,
      count: keys.length,
    }));
  }

  delete(namespace: string, key: string): void {
    const db = this.requireDb();
    const pid = this.projectId();

    const result = db.prepare(
      `DELETE FROM entries WHERE project_id = ? AND namespace = ? AND key = ?`
    ).run(pid, namespace, key);

    if (result.changes === 0) {
      throw new Error(`条目不存在: ${namespace}/${key}`);
    }
  }

  status(): {
    projectRoot: string;
    dbPath: string;
    totalEntries: number;
    activeEntries: number;
    expiredEntries: number;
    namespaces: Record<string, number>;
    lastUpdated: string | null;
  } {
    const db = this.requireDb();
    const pid = this.projectId();

    const total = db.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE project_id = ?`
    ).get(pid) as { count: number };

    const active = db.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE project_id = ? AND expired = 0`
    ).get(pid) as { count: number };

    const expired = db.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE project_id = ? AND expired = 1`
    ).get(pid) as { count: number };

    const nsRows = db.prepare(
      `SELECT namespace, COUNT(*) as count FROM entries WHERE project_id = ? GROUP BY namespace`
    ).all(pid) as Array<{ namespace: string; count: number }>;

    const namespaces: Record<string, number> = {};
    for (const row of nsRows) {
      namespaces[row.namespace] = row.count;
    }

    const lastRow = db.prepare(
      `SELECT updated_at FROM entries WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).get(pid) as { updated_at: string } | undefined;

    return {
      projectRoot: this.projectRoot || "unknown",
      dbPath: join(this.projectRoot || "", ".kimi-tunnel", "memory.db"),
      totalEntries: total.count,
      activeEntries: active.count,
      expiredEntries: expired.count,
      namespaces,
      lastUpdated: lastRow?.updated_at || null,
    };
  }

  archive(
    sessionId: string,
    targetNs?: string,
    keys?: string[]
  ): { archived: number; source: string; target: string } {
    const db = this.requireDb();
    const pid = this.projectId();
    const targetNamespace = targetNs || "project/learnings";
    const sourceNs = `session/${sessionId}/findings`;

    let sql = `SELECT * FROM entries WHERE project_id = ? AND namespace = ?`;
    const params: string[] = [pid, sourceNs];

    if (keys && keys.length > 0) {
      const placeholders = keys.map(() => "?").join(",");
      sql += ` AND key IN (${placeholders})`;
      params.push(...keys);
    }

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const entry = this.rowToEntry(row);
      db.prepare(
        `INSERT OR REPLACE INTO entries
         (namespace, key, value, source_session_id, version, expired, updated_at, project_id)
         VALUES (?, ?, ?, ?, ?, 0, datetime('now'), ?)`
      ).run(targetNamespace, `${sessionId}/${entry.key}`, entry.value, entry.sourceSessionId, 1, pid);
    }

    // Mark source entries as expired
    if (keys && keys.length > 0) {
      const placeholders = keys.map(() => "?").join(",");
      db.prepare(
        `UPDATE entries SET expired = 1, updated_at = datetime('now')
         WHERE project_id = ? AND namespace = ? AND key IN (${placeholders})`
      ).run(pid, sourceNs, ...keys);
    } else {
      db.prepare(
        `UPDATE entries SET expired = 1, updated_at = datetime('now')
         WHERE project_id = ? AND namespace = ?`
      ).run(pid, sourceNs);
    }

    return {
      archived: rows.length,
      source: sourceNs,
      target: targetNamespace,
    };
  }

  buildInjection(profile: InjectionProfile): string {
    const db = this.requireDb();

    const levelMap: Record<string, string[]> = {
      minimal: ["project/meta"],
      standard: ["project/meta", "project/decisions"],
      full: ["project/meta", "project/decisions", "project/risks", "project/learnings"],
    };

    const namespaces = levelMap[profile.level] || levelMap.standard;
    const suggestionMap: Record<string, string> = {
      "project/meta": "必读",
      "project/decisions": "必读",
      "project/risks": "按需",
      "project/learnings": "按需",
    };
    const nsLabelMap: Record<string, string> = {
      "project/meta": "项目背景",
      "project/decisions": "相关决策",
      "project/risks": "已知风险",
      "project/learnings": "经验沉淀",
    };

    // Collect entries per namespace (non-expired, ordered by updated_at DESC)
    const nsEntries: Record<string, string[]> = {};
    let totalEntries = 0;
    const maxBytes = profile.maxBytes || 8192;

    for (const ns of namespaces) {
      const rows = db.prepare(
        `SELECT key FROM entries WHERE project_id = ? AND namespace = ? AND expired = 0 ORDER BY updated_at DESC`
      ).all(this.projectId(), ns) as Array<{ key: string }>;
      const keys = rows.map((r) => r.key);
      nsEntries[ns] = keys;
      totalEntries += keys.length;
    }

    // --- Empty guard ---
    if (totalEntries === 0) {
      return "[系统注入] 你是任务 session。当前无共享记忆条目。";
    }

    // --- Build output per level ---
    let output = "";

    const rolePrefix = "[系统注入] 你是任务 session。";

    if (profile.level === "minimal") {
      // FR-1 minimal: single instruction
      output = `${rolePrefix} 使用 memory_get(namespace="project/meta") 读取项目背景后开始工作。`;
    } else if (profile.level === "standard") {
      // FR-1 standard: bullet list
      const lines: string[] = [
        `${rolePrefix} 使用 memory_get 按需读取：`,
        "",
      ];
      for (const ns of namespaces) {
        if (nsEntries[ns].length === 0) continue;
        lines.push(`- memory_get(namespace="${ns}") — ${nsLabelMap[ns] || ns}（${suggestionMap[ns] || "按需"}）`);
      }
      output = lines.join("\n");
    } else {
      // full: index table
      const collapse = totalEntries > 20;
      const lines: string[] = [
        `${rolePrefix} 以下记忆条目可用，请用 memory_get 按需读取：`,
        "",
        "| 命名空间 | 条目 | 建议 |",
        "|---------|------|------|",
      ];

      for (const ns of namespaces) {
        const keys = nsEntries[ns];
        if (keys.length === 0) continue;
        const entryCell = collapse
          ? `(${keys.length} 条)`
          : keys.join(", ");
        lines.push(`| ${ns} | ${entryCell} | ${suggestionMap[ns] || "按需"} |`);
      }

      if (collapse) {
        lines.push("");
        lines.push(`总计 ${totalEntries} 条，已折叠。使用 memory_get(namespace=命名空间路径) 读取具体内容。`);
      }

      output = lines.join("\n");
    }

    // --- Handoff from fromSession (keep existing logic) ---
    if (profile.fromSession) {
      const handoffEntries = this.get(`session/${profile.fromSession}/handoff`);
      if (handoffEntries.length > 0) {
        const handoffText = handoffEntries
          .map((e) => `- **${e.key}**: ${e.value}`)
          .join("\n");
        const handoffBlock = `\n\n## 前置结论\n\n${handoffText}`;
        const outputBytes = Buffer.byteLength(output, "utf-8");
        const handoffBytes = Buffer.byteLength(handoffBlock, "utf-8");
        if (outputBytes + handoffBytes <= maxBytes) {
          output += handoffBlock;
        }
      }
    }

    return output;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.projectRoot = null;
    }
  }

  private rowToEntry(r: Record<string, unknown>): MemoryEntry {
    return {
      id: Number(r.id),
      namespace: String(r.namespace),
      key: String(r.key),
      value: String(r.value),
      sourceSessionId: r.source_session_id ? String(r.source_session_id) : null,
      version: Number(r.version),
      expired: Boolean(r.expired),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      projectId: String(r.project_id),
    };
  }
}
