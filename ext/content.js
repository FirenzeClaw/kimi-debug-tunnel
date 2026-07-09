/**
 * Chrome extension content script bootstrap.
 * Shared modules (api, state, renderer, injector) are loaded
 * by manifest content_scripts in order — all share global scope.
 */

const tunnelPort = 3456; // default, overridden via chrome.storage.local

async function init() {
  // Load tunnel port from extension storage
  try {
    const result = await chrome.storage.local.get("tunnelPort");
    if (result.tunnelPort) {
      // Use configured port (cannot reassign const; use directly)
      await main(result.tunnelPort);
      return;
    }
  } catch (e) {
    // chrome.storage not available in some contexts
  }
  await main(tunnelPort);
}

async function main(port) {
  try {
    // Auto-login
    const token = await getToken(port);
    if (token) {
      tryAutoLogin(token);
    }

    // Always show the Orchestrator group
    const orchestrations = await fetchOrchestrations(port);
    const sessions = await fetchSessions(window.location.origin, token);
    const tree = buildTree(orchestrations, sessions);
    injectOrchestratorGroup(tree);

    if (!orchestrations || orchestrations.length === 0) {
      console.debug("[Orchestrator] No orchestration data — tunnel may not be running");
    }

    // Poll every 5 seconds
    setInterval(async () => {
      const newOrchestrations = await fetchOrchestrations(port);
      const newSessions = await fetchSessions(window.location.origin, token);
      const newTree = buildTree(newOrchestrations, newSessions);
      updateOrchestratorGroup(newTree);
    }, 5000);
  } catch (e) {
    console.debug("[Orchestrator] Init failed:", e.message);
  }
}

init();
