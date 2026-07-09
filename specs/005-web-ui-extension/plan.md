# Implementation Plan: Kimi Web UI 编排监控插件

**Feature**: `005-web-ui-extension`
**Plan Version**: 1.0
**Created**: 2026-07-09
**Status**: Ready for implementation
**Spec**: [spec.md](./spec.md)

---

## Technical Context

**Change Type**: Restructure — remove 2 HTML files (~1400 lines), add ~600 lines of shared JS + 2 thin adapters, add 2 tunnel API endpoints
**Affected Modules**: `src/http-server.ts`, `src/public/`, new `shared/`, `ext/`, `userscript/` directories
**Risk Level**: Medium — HTML removal is safe (no other consumers); new code is independent of existing TS modules; tunnel API additions are additive

### Target State

| Component | Current | After |
|-----------|---------|-------|
| `console.html` (565 lines) | Served at `/` | **DELETED** |
| `workflow-console.html` (824 lines) | Served at `/workflow-console.html` | **DELETED** |
| `http-server.ts` GET routes | 2 static HTML routes | **DELETED** (2 routes removed) |
| `http-server.ts` POST routes | `/api/execute`, `/api/send` | **ADDED**: `/api/orchestrations`, `/api/token` |
| `shared/` | N/A | **NEW**: `api.js`, `state.js`, `injector.js`, `renderer.js`, `styles.css` |
| `ext/` | N/A | **NEW**: Chrome MV3 extension (manifest.json, content.js, service-worker.js, icons, options.html) |
| `userscript/` | N/A | **NEW**: `orchestrator.user.js` |
| `package.json` build | `tsc && cp src/public/* → dist/public/` | Remove `cp src/public/*` step (no more HTML) |
| `dist/` output | `dist/public/` with HTML copies | `dist/public/` **DELETED** (or empty) |

---

## Constitution Check

> Applying project conventions from `AGENTS.md`.

| Principle | Compliance |
|-----------|:--:|
| **依赖注入 (DI)** | ✅ New tunnel endpoints receive services via `TunnelServices` parameter (existing pattern) |
| **深模块优先** | ✅ Shared JS modules: `api.js` (small interface: `fetchOrchestrations()`, `fetchSessions()`, `getToken()`), large implementation |
| **单一职责** | ✅ `injector.js` only does DOM injection, `renderer.js` only does rendering, `state.js` only manages tree state |
| **Guard Clauses** | ✅ Tunnel unavailable → early return in `api.js`; no token input → skip in `injector.js` |
| **Minimal changes** | ✅ `http-server.ts` changes are additive (2 new endpoints) and subtractive (2 dead routes); no logic changes to existing code |
| **禁止破坏性操作** | ✅ No `git push --force`, no `rm -rf` outside workspace, no data deletion |
| **TypeScript strict** | N/A for shared JS (browser runtime); tunnel changes continue strict TS |
| **函数命名** | ✅ Verb-phrase: `buildTree()`, `injectGroup()`, `renderEntries()`, `pollSessions()` |

---

## Phase 0: Research

### Decision 1: Shared Code Runtime

**Chosen**: Plain JavaScript (ES2020+), no bundler, no TypeScript for browser-side code.

**Rationale**:
- Chrome extension content scripts and Tampermonkey userscripts run in browser context — TypeScript compilation adds build complexity with zero benefit (no type checking at browser runtime)
- Chrome MV3 content scripts support ES modules via `"type": "module"` in manifest or dynamic `import()`
- Tampermonkey scripts are single-file by convention; shared code inlined at build or copy time
- Project TypeScript config has `rootDir: "src"` and Node16 module resolution — not designed for browser-target output

**Alternatives considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|:--:|
| TypeScript + separate tsconfig | Type safety | Extra tsconfig, build step, sourcemap complexity | ❌ |
| Bundler (esbuild/rollup) | Module resolution | Adds devDependency, overkill for ~600 lines | ❌ |
| Plain JS | Zero build, direct copy | No type checking (manual review) | ✅ |

### Decision 2: Extension Content Script Injection

**Chosen**: Manifest V3 `content_scripts` with `"run_at": "document_end"`, matching `https://127.0.0.1:*/` and `https://localhost:*/`.

**Rationale**:
- `document_end` ensures DOM is ready before injection
- `content_scripts` auto-injects on page load — no user action needed
- `host_permissions` scoped to localhost only (security review passes for Chrome Web Store)

**Alternatives considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|:--:|
| `chrome.scripting.executeScript` | Dynamic control | Requires activeTab/origins permission, no auto-inject | ❌ |
| `chrome.action.onClicked` | User-initiated | Extra click per page load | ❌ |

### Decision 3: Tampermonkey Shared Code Inline Strategy

**Chosen**: Build-time concatenation via a simple Node.js script (`scripts/build-userscript.mjs`). Reads `shared/*.js` files, wraps in IIFE, prepends userscript header.

**Rationale**:
- Tampermonkey scripts are single-file; `@require` can load external URLs but not local files reliably
- Build script runs as part of `npm run build` (after tsc)
- Users can also copy-paste the pre-built `.user.js` from dist/

### Decision 4: Kimi Web UI DOM Injection Target

**Chosen**: Inject at `.sessions` container bottom, as a new `.group` element with structure:
```html
<div class="group">
  <div class="gh">  <!-- group header: 📁 Orchestrator, toggle collapse -->
  <div class="group-sessions">  <!-- session entries -->
    <div class="se">  <!-- parent session -->
    <div class="se" style="padding-left:16px">  <!-- child session (indented) -->
```

**Rationale**:
- Matches existing `.group` structure exactly — existing CSS handles styling, collapse, hover
- Indentation for children via inline `padding-left` (no new CSS class needed)
- PM session entries use existing `.se` class with `ui-spinner` and timestamp

### Decision 5: Token Storage and Transmission

**Chosen**: Tunnel exposes `GET /api/token` (localhost-only). Extension and userscript fetch once on startup. No persistent token storage — token lives only in tunnel memory (`process.env`).

**Security note**: `/api/token` must validate `req.ip` is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Reject all non-local requests with 403.

### Decision 6: Build Script Changes

**Chosen**: Modify `package.json` build script: remove `cp -r src/public/* dist/public/`, add `node scripts/build-userscript.mjs`. The `shared/` and `ext/` directories are copied as-is to `dist/`.

```json
"build": "tsc && node scripts/build-userscript.mjs"
```

Remove `mkdir -p dist/public` — no more public HTML to serve.

---

## Phase 1: Design

### Data Model

```
┌─────────────────────────────┐
│ SessionTree (in-memory)     │
├─────────────────────────────┤
│ pmSessions: PMSession[]     │
│ lastUpdated: number         │
└──────────┬──────────────────┘
           │
     ┌─────▼─────┐
     │ PMSession │
     ├───────────┤
     │ id        │
     │ title     │
     │ status    │
     │ updatedAt │
     │ children  │──→ ChildSession[]
     └───────────┘
           │
     ┌─────▼──────┐
     │ ChildSession│
     ├────────────┤
     │ id          │
     │ title       │
     │ status      │
     │ updatedAt   │
     └────────────┘
```

**Data sources**:
- PM-child relationships: `GET /api/orchestrations` (tunnel)
- Session details (title, status, time): `GET /api/v1/sessions` (Kimi Server)
- Merge key: `session.id`

**State lifecycle**:
1. Plugin init → fetch both APIs → merge → build tree → render
2. Every 5s → fetch sessions API → diff with cached tree → update changed entries only
3. Tunnel unreachable → skip orchestration data → render empty state (no group)

### API Contracts

#### Tunnel: `GET /api/orchestrations`

**Request**: `GET /api/orchestrations` — no body. Tunnel auto-discovers all known PM sessions from WorkflowEngine active executions.

**Response** (200):
```json
{
  "orchestrations": [
    {
      "pm_session_id": "ses_abc123",
      "cwd": "D:/code/my-project",
      "children": [
        {
          "session_id": "ses_child001",
          "cwd": "D:/code/my-project",
          "status": "active",
          "created_at": "2026-07-09T10:00:00Z"
        }
      ]
    }
  ]
}
```

**Response** (empty, 200):
```json
{ "orchestrations": [] }
```

#### Tunnel: `GET /api/token`

**Response** (200, localhost only):
```json
{ "token": "kimi-token-string-here" }
```

**Response** (403, non-local):
```json
{ "error": "Access restricted to localhost" }
```

**Response** (404, token not set):
```json
{ "error": "KIMI_SERVER_TOKEN not configured" }
```

#### Kimi Server: `GET /api/v1/sessions`

Used as-is (existing API, already documented in `API.md`). Plugin calls with `?limit=50` and filters to relevant session IDs from orchestration tree.

### Module Design

#### `shared/api.js`

```javascript
// Public interface:
async function fetchOrchestrations(tunnelPort) → Orchestration[]
async function fetchSessions(kimiOrigin) → SessionInfo[]
async function getToken(tunnelPort) → string | null
```

Internal: `fetch()` with timeout (5s), error handling (return null/empty on failure).

#### `shared/state.js`

```javascript
// Public interface:
function buildTree(orchestrations, sessions) → SessionTree
function diffTree(oldTree, newTree) → { added: [], removed: [], changed: [] }
```

Internal: merge orchestration relationships with session details, compute status.

#### `shared/injector.js`

```javascript
// Public interface:
function injectOrchestratorGroup(tree) → void
function updateOrchestratorGroup(tree) → void
function removeOrchestratorGroup() → void
function tryAutoLogin(token) → void
```

Internal: find `.sessions` container, create/update `.group.orchestrator` element, detect `input[type="password"]` for token field.

#### `shared/renderer.js`

```javascript
// Public interface:
function renderGroup(tree) → HTMLElement
function renderEntry(session, depth) → HTMLElement
function updateEntry(el, oldData, newData) → void
```

Internal: clone existing `.se` structure, reuse page's `ui-spinner`, `ts`, title elements.

#### `ext/content.js`

```javascript
// Bootstrap for Chrome extension:
import { ... } from './shared/api.js';
// Auto-execute on document_end
```

#### `userscript/orchestrator.user.js`

```javascript
// ==UserScript== header
// @match https://127.0.0.1:5494/*
// @match https://localhost:5494/*
// @grant GM_getValue, GM_setValue
// ==/UserScript==

// Inline shared code from shared/* files
// Use GM_getValue("tunnelPort", 3456) for port config
```

### Files Changed/Created

| File | Action | Est. Lines |
|------|--------|:--:|
| `src/public/console.html` | **DELETE** | -565 |
| `src/public/workflow-console.html` | **DELETE** | -824 |
| `src/http-server.ts` | Modify: remove 2 GET routes, add 2 API endpoints | +40 / -20 |
| `shared/api.js` | **NEW** | ~80 |
| `shared/state.js` | **NEW** | ~60 |
| `shared/injector.js` | **NEW** | ~120 |
| `shared/renderer.js` | **NEW** | ~100 |
| `shared/styles.css` | **NEW** | ~30 |
| `ext/manifest.json` | **NEW** | ~20 |
| `ext/content.js` | **NEW** | ~15 |
| `ext/service-worker.js` | **NEW** | ~10 |
| `ext/options.html` | **NEW** | ~40 |
| `userscript/orchestrator.user.js` | **NEW** header only | ~20 |
| `scripts/build-userscript.mjs` | **NEW** | ~40 |
| `package.json` | Modify: build script | ~1 line change |
| `README.md` | Modify: remove HTML console references | ~10 lines |

**Total**: ~600 lines new, ~1400 lines deleted.

### Verification Plan

| SC | Test | Expected |
|----|------|---------|
| SC-1 | Open Kimi Web UI with extension/userscript installed, tunnel running, PM session with children | Sidebar shows `Orchestrator` group with PM + child entries |
| SC-2 | Compare DOM structure of injected `.se` with native `.se` | Same classes, same inner structure (spinner, title, timestamp) |
| SC-3 | Install both extension and userscript (separately), compare DOM output | Identical injected group structure |
| SC-4 | Change tunnel port via options/GM_setValue, reload page | Plugin queries new port |
| SC-5 | Start tunnel + Kimi Server, open Kimi Web UI (first time, no cookie) | Token field auto-filled within 3s, login proceeds |
| SC-6 | Open Kimi Web UI with tunnel NOT running | No Orchestrator group, page works normally, no console errors |
| Edge: No children | PM session with zero child sessions | PM entry shown, no children, no error |
| Edge: Multiple PM sessions | Two PM sessions each with children | One Orchestrator group containing both PM entries (each with their children indented beneath) |
| Edge: Token request from non-localhost | `curl http://<external-ip>:3456/api/token` | 403 Forbidden |
| Edge: Port already in use (EADDRINUSE) | Start tunnel on occupied port | HTTP server skipped, MCP stdio still available (existing behavior unchanged) |

---

## Risk Assessment

| Risk | Probability | Mitigation |
|------|:--:|------|
| Kimi Web UI DOM restructure breaks injection | Medium | Monitor `.sessions` selector stability; injector uses graceful querySelector with null check |
| Tunnel port conflict with other services | Low | Default 3456 is uncommon; user can configure; tunnel already handles EADDRINUSE gracefully |
| Token exposure via `/api/token` | None | Loopback-only access enforced server-side; token never leaves localhost |
| Chrome Web Store rejects MV3 extension | Low | Content script is minimal (DOM injection only), no remote code, host_permissions scoped to localhost |
| Tampermonkey @match fails on varying Kimi Server ports | Medium | Use wildcard port match: `https://127.0.0.1:*/` and `https://localhost:*/` |
