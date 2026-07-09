import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const sharedDir = join(rootDir, "shared");
const outputDir = join(rootDir, "dist", "userscript");
const outputFile = join(outputDir, "orchestrator.user.js");

// Userscript header
const header = `// ==UserScript==
// @name         Kimi Session Orchestrator
// @namespace    https://github.com/FirenzeClaw/kimi-session-orchestrator
// @version      1.0
// @description  在 Kimi Web UI 侧边栏中展示编排器 session 层级结构
// @author       FirenzeClaw
// @match        *://127.0.0.1:/*
// @match        *://localhost:/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";

  // ── Shared modules ────────────────────────────────────────────
`;

// Read shared modules in order
const sharedFiles = ["api.js", "state.js", "renderer.js", "injector.js"];

let body = "";
for (const file of sharedFiles) {
  const filePath = join(sharedDir, file);
  if (!existsSync(filePath)) {
    console.error(`Missing shared module: ${filePath}`);
    process.exit(1);
  }
  body += `\n  // ── ${file} ──\n`;
  body += readFileSync(filePath, "utf-8") + "\n";
}

// Footer with bootstrap
const footer = `
  // ── Bootstrap ────────────────────────────────────────────────
  const tunnelPort = GM_getValue("tunnelPort", 3456);
  const kimiOrigin = window.location.origin;

  async function main() {
    try {
      // Auto-login
      const token = await getToken(tunnelPort);
      if (token) {
        tryAutoLogin(token);
      }

      // Always show the Orchestrator group
      const orchestrations = await fetchOrchestrations(tunnelPort);
      const sessions = await fetchSessions(kimiOrigin, token);
      const tree = buildTree(orchestrations, sessions);
      injectOrchestratorGroup(tree);

      if (!orchestrations || orchestrations.length === 0) {
        console.debug("[Orchestrator] No orchestration data — tunnel may not be running");
      }

      // Poll every 5 seconds — also re-fetch orchestrations
      setInterval(async () => {
        const newOrchestrations = await fetchOrchestrations(tunnelPort);
        const newSessions = await fetchSessions(kimiOrigin, token);
        const newTree = buildTree(newOrchestrations, newSessions);
        updateOrchestratorGroup(newTree);
      }, 5000);
    } catch (e) {
      console.debug("[Orchestrator] Init failed:", e.message);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
`;

const userscript = header + body + footer;

// Write output
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(outputFile, userscript, "utf-8");

console.log(`Userscript built: ${outputFile} (${userscript.length} bytes)`);
