// Options page script for Kimi Session Orchestrator extension
document.addEventListener("DOMContentLoaded", () => {
  const portInput = document.getElementById("port");
  const saveBtn = document.getElementById("saveBtn");
  const statusEl = document.getElementById("status");

  // Load saved port
  chrome.storage.local.get("tunnelPort", (result) => {
    if (result.tunnelPort) {
      portInput.value = result.tunnelPort;
    }
  });

  // Save port
  saveBtn.addEventListener("click", () => {
    const port = parseInt(portInput.value, 10);
    if (port < 1 || port > 65535) {
      statusEl.textContent = "端口号必须在 1-65535 之间";
      statusEl.style.color = "#f85149";
      return;
    }
    chrome.storage.local.set({ tunnelPort: port }, () => {
      statusEl.textContent = "已保存";
      statusEl.style.color = "#3fb950";
    });
  });
});
