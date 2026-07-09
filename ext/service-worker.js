// Service worker for Kimi Session Orchestrator extension
// Currently no background logic needed — content script handles all injection.
// Placeholder required by Chrome MV3 manifest.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("tunnelPort", (result) => {
    if (!result.tunnelPort) {
      chrome.storage.local.set({ tunnelPort: 3456 });
    }
  });
});
