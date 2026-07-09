# Research: Kimi Web UI 编排监控插件

**Feature**: `005-web-ui-extension`
**Created**: 2026-07-09

---

## Decision 1: Shared Code Runtime

**Chosen**: Plain JavaScript (ES2020+), no bundler, no TypeScript for browser-side code.

**Rationale**:
- Chrome extension content scripts and Tampermonkey userscripts run in browser context
- TypeScript compilation adds build complexity with zero benefit (no type checking at browser runtime)
- Project TypeScript config (`rootDir: "src"`, Node16 module resolution) not designed for browser-target output
- ~600 lines of shared JS — small enough to maintain without types

**Alternatives considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|:--:|
| TypeScript + separate tsconfig | Type safety | Extra tsconfig, build step, sourcemap complexity | ❌ |
| Bundler (esbuild/rollup) | Module resolution | Adds devDependency, overkill | ❌ |
| Plain JS | Zero build, direct copy | No type checking (manual review) | ✅ |

---

## Decision 2: Chrome Extension Content Script Injection

**Chosen**: Manifest V3 `content_scripts` with `"run_at": "document_end"`, matching `https://127.0.0.1:*/` and `https://localhost:*/`.

**Rationale**:
- `document_end` ensures DOM ready before injection — no MutationObserver polling needed
- `content_scripts` auto-injects on every matching page load
- `host_permissions` scoped to localhost only (minimal permission footprint)

**Alternatives considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|:--:|
| `chrome.scripting.executeScript` | Dynamic control | Requires extra permissions, no auto-inject | ❌ |
| `chrome.action.onClicked` | User-initiated | Extra click per page load | ❌ |

---

## Decision 3: Tampermonkey Shared Code Inline Strategy

**Chosen**: Build-time concatenation via `scripts/build-userscript.mjs`. Reads `shared/*.js` files, wraps in IIFE, prepends userscript header.

**Rationale**:
- Tampermonkey scripts are single-file by convention
- `@require` can load external URLs but not local files reliably across browsers
- Build script runs as part of `npm run build` (after tsc)

---

## Decision 4: Kimi Web UI DOM Injection Target

**Chosen**: Inject at `.sessions` container bottom, as a new `.group` element with identical internal structure to native groups.

**Rationale**:
- Matches existing `.group` structure exactly — existing CSS handles all styling
- No new CSS classes needed beyond what page already provides
- Collapse/expand behavior inherited from parent container

**Observed DOM structure** (from 2026-07-09 Kimi Web UI):
```html
<div class="sessions">
  <div class="group">
    <div class="gh">...</div>           <!-- folder header -->
    <div class="group-sessions">
      <div class="se">...</div>         <!-- session entry -->
    </div>
  </div>
</div>
```

---

## Decision 5: Token Storage and Transmission

**Chosen**: Tunnel exposes `GET /api/token` (localhost-only IP check). Extension/userscript fetch once on startup. No persistent token storage.

**Security**: `/api/token` validates `req.ip` is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Non-local requests return 403.

---

## Decision 6: Build Script Changes

**Chosen**: Modify `package.json` build to remove HTML copy step, add userscript build step.

**Before**: `tsc && node -e "..." && cp -r src/public/* dist/public/`
**After**: `tsc && node scripts/build-userscript.mjs`

---

## Decision 7: Polling Interval

**Chosen**: 5 seconds.

**Rationale**:
- Session status changes are seconds-level events (prompt → tool execution → response)
- 5s is the lowest granularity that matters for a human observer
- Avoids unnecessary load on Kimi Server API

---

## Decision 8: Error Handling Strategy

**Chosen**: All API failures are silent. Plugin degrades gracefully.

- Tunnel unreachable → no Orchestrator group rendered
- Kimi Server unreachable → no session list rendered
- Token fetch fails → skip auto-login
- ALL errors logged to `console.debug()` (not `console.error()` — not a bug, just unavailable)

**Rationale**: The plugin is a convenience feature. It must never degrade the Kimi Web UI experience.
