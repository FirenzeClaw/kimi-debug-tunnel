/**
 * DOM injector — manages Orchestrator group lifecycle in Kimi Web UI sidebar.
 * Injects "统筹区" section label + Orchestrator group above "工作区".
 */

const GROUP_SELECTOR = '[data-orchestrator="true"]';
const SECTION_SELECTOR = '[data-orchestrator-section="true"]';

/**
 * Inject "统筹区" label and Orchestrator group above the first "工作区" label.
 * @param {Object} tree - SessionTree
 */
function injectOrchestratorGroup(tree) {
  removeOrchestratorGroup();

  const sessionsEl = document.querySelector(".sessions");
  if (!sessionsEl) {
    console.debug("[Orchestrator] .sessions container not found");
    return;
  }

  const workSection = sessionsEl.querySelector(".side-section-label");
  const sectionLabel = createSectionLabel();
  const group = renderGroup(tree);
  if (!group) return;

  if (workSection) {
    sessionsEl.insertBefore(sectionLabel, workSection);
    sessionsEl.insertBefore(group, workSection);
  } else {
    sessionsEl.appendChild(sectionLabel);
    sessionsEl.appendChild(group);
  }
}

function updateOrchestratorGroup(tree) {
  const existing = document.querySelector(GROUP_SELECTOR);
  if (!existing) {
    injectOrchestratorGroup(tree);
    return;
  }
  removeOrchestratorGroup();
  injectOrchestratorGroup(tree);
}

function removeOrchestratorGroup() {
  const group = document.querySelector(GROUP_SELECTOR);
  if (group) group.remove();
  const section = document.querySelector(SECTION_SELECTOR);
  if (section) section.remove();
}

function tryAutoLogin(token) {
  if (!token) return;
  const inputs = document.querySelectorAll('input[type="password"], input[type="text"]');
  for (const input of inputs) {
    const ph = (input.getAttribute("placeholder") || "").toLowerCase();
    const nm = (input.getAttribute("name") || "").toLowerCase();
    if (ph.includes("token") || ph.includes("key") || nm.includes("token")) {
      input.value = token;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const form = input.closest("form");
      const btn = form ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
      if (btn) setTimeout(() => btn.click(), 300);
      console.debug("[Orchestrator] Token auto-filled");
      return;
    }
  }
}
