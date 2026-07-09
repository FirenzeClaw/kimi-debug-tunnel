# Tasks: Kimi Web UI 编排监控插件

**Feature**: `005-web-ui-extension`
**Created**: 2026-07-09
**Plan**: [plan.md](./plan.md)
**Spec**: [spec.md](./spec.md)

---

## User Story Mapping

| Story | Priority | Description | Independent Test |
|-------|:--:|------|------|
| US1 | P1 | PM 在 Kimi Web UI 侧边栏看到编排 session 层级树 | 打开 Kimi Web UI → 侧边栏出现 Orchestrator 组 |
| US2 | P1 | Session 条目样式与页面原生元素一致 | 对比注入的 `.se` 与页面原生 `.se` DOM 结构 |
| US3 | P2 | Token 首次启动自动填入 | 清除 cookie → 打开页面 → token 自动填入 |
| US4 | P3 | Tunnel 端口可配置 | 修改端口配置 → 刷新 → 使用新端口查询 |

> US1 + US2 合并为一个 phase（visual appearance 是 tree 的不可分部分）。

---

## Phase 1: Setup — Build Infrastructure

**Goal**: 目录结构就绪，构建脚本可用，扩展 manifest 和 userscript 骨架到位。

- [x] T001 Create directory structure: `shared/`, `ext/`, `ext/icons/`, `userscript/`, `scripts/` under project root
- [x] T002 [P] Create `ext/manifest.json` — Chrome MV3 manifest with content_scripts, host_permissions (127.0.0.1:*, localhost:*), options_page; create placeholder icons (16/48/128 px) in `ext/icons/` (single-color SVG or generated PNG)
- [x] T003 [P] Create `ext/options.html` — minimal port config page (input + save button, chrome.storage.local read/write)
- [x] T004 [P] Create `ext/service-worker.js` — empty service worker (required by MV3, no background logic needed)
- [x] T005 [P] Create `scripts/build-userscript.mjs` — Node.js script: read shared/*.js, wrap in IIFE, prepend userscript header (`@name`, `@namespace`, `@version`, `@match https://127.0.0.1:*/` and `https://localhost:*/`, `@grant GM_getValue, GM_setValue`), output to `dist/userscript/orchestrator.user.js`
- [x] T006 Update `package.json` build script — remove `cp -r src/public/* dist/public/` step; add `node scripts/build-userscript.mjs`; remove `mkdir -p dist/public`

---

## Phase 2: Foundational — Tunnel API Endpoints

**Goal**: Tunnel 提供编排关系查询和 token 获取两个新端点，供后续所有 phase 使用。

**Independent Test**: `curl http://localhost:3456/api/orchestrations` → 200 with orchestrations array; `curl http://localhost:3456/api/token` → 200 with token (from localhost)

- [x] T007 Add `GET /api/orchestrations` to `src/http-server.ts` — no request parameters; auto-discover all known PM sessions from WorkflowEngine active executions; return orchestration relation JSON; respond 503 if wire not connected
- [x] T008 Add `GET /api/token` to `src/http-server.ts` — return `process.env.KIMI_SERVER_TOKEN` as JSON; reject non-localhost IPs with 403; return 404 if token not set

---

## Phase 3: US1+US2 — Session Hierarchy Tree with Native Styling

**Goal**: Kimi Web UI 左侧栏出现 `Orchestrator` 组，展示 PM session → 子 session 层级，条目样式与页面原生 `.se` 一致。

**Independent Test**: 安装扩展或脚本 → 打开 Kimi Web UI（tunnel + Kimi Server 运行中，至少 1 个 PM session 含子 session）→ 侧边栏 `.sessions` 底部出现 Orchestrator 组，内有 PM 条目 + 缩进子条目，spinner 和时间戳与原生条目无差异

- [x] T009 [P] [US1] Create `shared/api.js` — `fetchOrchestrations(tunnelPort)` calls `GET /api/orchestrations` (no params, tunnel auto-discovers), `fetchSessions(kimiOrigin)` calls `GET /api/v1/sessions`, `getToken(tunnelPort)` calls `GET /api/token`; all with 5s fetch timeout and silent error handling (return null/empty on failure)
- [x] T010 [P] [US1] Create `shared/state.js` — `buildTree(orchestrations, sessions)` merges relationships + session details into `SessionTree`; `diffTree(old, new)` returns `{added, removed, changed}` arrays
- [x] T011 [US1] Create `shared/renderer.js` — `renderGroup(tree)` returns DOM `.group` element with `.gh` header + `.group-sessions` container; `renderEntry(session, depth)` returns `.se` element (depth 0 = PM, depth 1 = child with 16px padding-left) with click handler navigating to `/session/<id>`; `updateEntry(el, old, new)` patches changed fields; reuse page `ui-spinner`, timestamp classes
- [x] T012 [US1] Create `shared/styles.css` — minimal injected stylesheet (only `padding-left` for child indentation; all other styling inherited from page CSS variables)
- [x] T013 [US1] Create `shared/injector.js` — `injectOrchestratorGroup(tree)` finds `.sessions` container, appends rendered group; `updateOrchestratorGroup(tree)` diffs and patches; `removeOrchestratorGroup()` cleans up on tunnel disconnect; uses `MutationObserver` or poll to survive page navigation/re-render
- [x] T014 [US1] Create `ext/content.js` — ES module: import shared modules, auto-execute on `document_end`: fetch orchestrations + sessions → build tree → inject; set 5s polling interval
- [x] T015 [US1] Create `userscript/orchestrator.user.js` — Tampermonkey header (`@match`, `@grant GM_getValue, GM_setValue`); inline all shared code; same bootstrap logic as content.js; default tunnel port from `GM_getValue("tunnelPort", 3456)`

---

## Phase 4: US3 — Auto Token Fill

**Goal**: 首次打开 Kimi Web UI 时，token 自动填入并提交。

**Independent Test**: 清除浏览器 cookie → 打开 Kimi Web UI → 3 秒内 token 输入框被填充并自动提交；已登录状态 → 无操作

- [x] T016 [US3] Add `tryAutoLogin(token)` to `shared/injector.js` — query DOM for token/password input on login page; if found, fill value and click submit button; if not found (already logged in), skip silently
- [x] T017 [US3] Wire auto-login into `ext/content.js` and `userscript/orchestrator.user.js` bootstrap — call `getToken()` first, then `tryAutoLogin(token)`, then proceed to tree injection

---

## Phase 5: US4 — Configurable Tunnel Port

**Goal**: 用户可通过扩展选项页或 Tampermonkey 存储修改 tunnel 端口，无需编辑代码。

**Independent Test**: 修改端口 → 刷新页面 → orchestration 数据从新端口获取

- [x] T018 [US4] Implement `ext/options.html` save/load — read/write `chrome.storage.local.tunnelPort`; display current value; save button persists change
- [x] T019 [US4] Add port configuration to `userscript/orchestrator.user.js` — read `GM_getValue("tunnelPort", 3456)` at startup; document in script header comment how to change via Tampermonkey storage editor
- [x] T020 [US4] Ensure `shared/api.js` accepts tunnel port as parameter — `fetchOrchestrations(port, ...)` and `getToken(port)` use the configured port, not a hardcoded 3456

---

## Phase 6: Polish — Cleanup & Docs

**Goal**: 旧 HTML 文件删除，docs 与 build 验证完整。

- [x] T021 [P] Delete `src/public/console.html`
- [x] T022 [P] Delete `src/public/workflow-console.html`
- [x] T023 Remove static file routes from `src/http-server.ts` — delete `GET /` (console.html) and `GET /workflow-console.html` route handlers; keep all REST API and WebSocket routes
- [x] T024 Update `README.md` — replace "Web 调试控制台" references with plugin installation guides; update project structure diagram to include `shared/`, `ext/`, `userscript/`; mark old HTML console as removed
- [x] T025 Verify build: run `npm run build`, confirm `dist/` contains no `public/` directory, `dist/userscript/orchestrator.user.js` exists, extension files in `dist/ext/`

---

## Dependency Graph

```
Phase 1: Setup ──────────────────────────────────────────┐
  T001 → T002,T003,T004,T005 (parallel) → T006           │
                                                          │
Phase 2: Foundational (depends on: nothing)               │
  T007, T008 (parallel, additive to http-server.ts)       │
                                                          │
Phase 3: US1+US2 (depends on: Phase 1, Phase 2)          │
  T009,T010 (parallel) → T011 → T012                     │
  T013 → T014, T015 (parallel)                           │
                                                          │
Phase 4: US3 (depends on: Phase 3)                        │
  T016 → T017                                             │
                                                          │
Phase 5: US4 (depends on: Phase 3)                        │
  T018, T019 (parallel) → T020                            │
                                                          │
Phase 6: Polish (depends on: Phase 3+)                    │
  T021,T022 (parallel) → T023 → T024 → T025              │
```

---

## Parallel Execution Opportunities

**Within Phase 1**: T002, T003, T004, T005 all operate on different files → launch 4 parallel tasks after T001.

**Within Phase 2**: T007 and T008 are independent additions to `src/http-server.ts` → can be done in a single edit or two parallel edits on non-overlapping regions.

**Within Phase 3**:
- T009 + T010 are different files, no mutual dependency → parallel
- T014 + T015 are different files, both import shared → parallel after T013

**Within Phase 5**: T018 + T019 are different files → parallel.

**Within Phase 6**: T021 + T022 are deletions → parallel.

---

## Implementation Strategy

### MVP (Phase 1-3)

T001 → T006 (setup) → T007 → T008 (tunnel API) → T009 → T015 (tree injection)

Delivers: orchestration tree visible in Kimi Web UI sidebar. ~80% user value.

### Incremental

- **+Phase 4**: Auto login — eliminates manual token paste
- **+Phase 5**: Port config — flexibility for non-standard setups
- **+Phase 6**: Cleanup — removes dead code, final polish

---

## Format Validation

| Check | Status |
|-------|:--:|
| All 25 tasks use `- [ ]` checkbox format | ✅ |
| All tasks have sequential IDs (T001-T025) | ✅ |
| [P] marker on parallelizable tasks | ✅ |
| [US1]-[US4] labels on story tasks | ✅ |
| Every task includes file path | ✅ |
| Setup/Foundational phases: no story label | ✅ |
