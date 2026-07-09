# Data Model: Kimi Web UI 编排监控插件

**Feature**: `005-web-ui-extension`
**Created**: 2026-07-09

---

## Entities

### SessionTree

In-memory state object. Not persisted. Rebuilt on each poll cycle.

| Field | Type | Description |
|-------|------|-------------|
| `pmSessions` | `PMSession[]` | List of PM (parent) sessions with their children |
| `lastUpdated` | `number` | Unix timestamp of last successful poll |

### PMSession

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `id` | `string` | Tunnel + Kimi | Session ID (e.g., `ses_abc123`) |
| `title` | `string` | Kimi Server | Session title from `/api/v1/sessions` |
| `status` | `string` | Kimi Server | `active`, `idle`, `awaiting_approval`, etc. |
| `updatedAt` | `string` | Kimi Server | ISO 8601 last update timestamp |
| `cwd` | `string` | Tunnel | Working directory |
| `children` | `ChildSession[]` | Tunnel | Child sessions created by this PM |

### ChildSession

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `id` | `string` | Tunnel | Session ID |
| `title` | `string` | Kimi Server | Session title |
| `status` | `string` | Kimi Server | `active`, `idle`, `awaiting_approval`, `done`, `error` |
| `updatedAt` | `string` | Kimi Server | ISO 8601 last update timestamp |
| `cwd` | `string` | Tunnel | Working directory |

### OrchestrationRelation (Tunnel API response)

| Field | Type | Description |
|-------|------|-------------|
| `pm_session_id` | `string` | PM session that created children |
| `cwd` | `string` | Working directory of PM session |
| `children` | `ChildRef[]` | References to child sessions |

### ChildRef

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Child session ID |
| `cwd` | `string` | Working directory |
| `status` | `string` | Status at time of creation/last update |
| `created_at` | `string` | ISO 8601 creation timestamp |

### Merger

```
OrchestrationRelation[] + SessionInfo[] → SessionTree
```

Merge key: `session_id`. Tunnel provides relationships and `cwd`; Kimi Server provides `title`, live `status`, and `updatedAt`.

If a child session exists in tunnel data but not in Kimi Server response (deleted or expired), render it with status `(removed)` and grey styling.

## State Transitions

```
┌──────────┐  poll (5s)   ┌──────────┐
│  INIT    │──────────────▶│  ACTIVE  │◀──────────┐
│ (no tree) │              │ (tree    │           │
└──────────┘              │ rendered)│    poll   │
                          └────┬─────┘   (diff)  │
                               │                  │
                     tunnel    │    tunnel        │
                     down      │    back          │
                               ▼                  │
                          ┌──────────┐            │
                          │ DEGRADED │────────────┘
                          │ (no      │
                          │ group)   │
                          └──────────┘
```

- **INIT → ACTIVE**: Both tunnel and Kimi Server reachable, tree built and rendered
- **ACTIVE → DEGRADED**: Tunnel becomes unreachable during poll; Orchestrator group removed
- **DEGRADED → ACTIVE**: Tunnel recovers; group re-injected
- Kimi Server unreachable alone → tree shows stale data with "(offline)" indicators, no crash

## Configuration Data

### Extension Config (`chrome.storage.local`)

```json
{
  "tunnelPort": 3456
}
```

### Userscript Config (`GM_setValue`)

```
Key: "tunnelPort" → Value: 3456
```

Default: `3456`. User changeable via extension options page or userscript source edit.
