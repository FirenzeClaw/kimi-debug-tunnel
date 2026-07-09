/**
 * DOM renderer for Orchestrator group.
 * Full native UI parity: collapse section, collapse folder, kebab, highlight.
 */

function cloneNative(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  return el.cloneNode(true);
}

function getVueScopeAttr(el) {
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-v-")) return { name: attr.name, value: attr.value };
  }
  return null;
}

function copyVueAttr(target, source) {
  const vm = getVueScopeAttr(source);
  if (vm) target.setAttribute(vm.name, vm.value);
}

function navigateToSession(sessionId) {
  if (!sessionId) return;
  const url = "/session/" + sessionId;
  try {
    history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch (e) {
    window.location.href = window.location.origin + url;
  }
}

/**
 * Create the "统筹区" section label with collapse toggle and kebab.
 */
function createSectionLabel() {
  const native = document.querySelector(".side-section-label");
  if (!native) {
    const lbl = document.createElement("div");
    lbl.className = "side-section-label";
    lbl.innerHTML = '<span class="side-section-title">统筹区</span>';
    return lbl;
  }
  const label = native.cloneNode(true);
  label.setAttribute("data-orchestrator-section", "true");
  label.querySelector(".side-section-title").textContent = "统筹区";

  // Wire toggle button — collapse/expand Orchestrator group
  const toggle = label.querySelector(".side-section-toggle:not(.side-section-kebab)");
  if (toggle) {
    toggle.setAttribute("aria-label", "折叠统筹区");
    toggle.addEventListener("click", () => {
      const group = document.querySelector('[data-orchestrator="true"]');
      if (!group) return;
      const sessions = group.querySelector(".group-sessions");
      const gh = group.querySelector(".gh");
      if (sessions.style.display === "none") {
        sessions.style.display = "";
        if (gh) gh.classList.add("on");
      } else {
        sessions.style.display = "none";
        if (gh) gh.classList.remove("on");
      }
    });
  }
  // Wire section kebab
  const sectionKebab = label.querySelector(".side-section-kebab");
  if (sectionKebab) {
    sectionKebab.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showSectionMenu(e);
    }, { capture: true });
    sectionKebab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showSectionMenu(e);
    }, { capture: true });
  }
  return label;
}

function renderGroup(tree) {
  const template = cloneNative(".sessions .group");
  if (!template) {
    const g = document.createElement("div");
    g.className = "group";
    g.setAttribute("data-orchestrator", "true");
    g.innerHTML = '<div class="gh"><div class="gh-top"><span class="gh-name">无统筹</span></div></div><div class="group-sessions"></div>';
    return g;
  }

  const group = template;
  group.setAttribute("data-orchestrator", "true");

  const hasSessions = tree && tree.pmSessions && tree.pmSessions.length > 0;
  const firstPm = hasSessions ? tree.pmSessions[0] : null;

  // Folder header
  const gh = group.querySelector(".gh");
  const ghName = group.querySelector(".gh-name");
  if (ghName) {
    ghName.textContent = firstPm ? (firstPm.title || firstPm.id) : "无统筹";
    if (firstPm && firstPm.id) {
      ghName.style.cursor = "pointer";
      ghName.addEventListener("click", (e) => { e.stopPropagation(); navigateToSession(firstPm.id); });
    }
  }

  const ghPath = group.querySelector(".gh-path");
  if (ghPath) ghPath.textContent = firstPm ? firstPm.cwd || "" : "";

  // Remove kebab and add buttons — only collapse
  const ghMore = group.querySelector(".gh-more");
  if (ghMore) ghMore.remove();
  const ghAdd = group.querySelector(".gh-add");
  if (ghAdd) ghAdd.remove();

  // Collapse/expand on header click (folder only, not session entries)
  if (gh) {
    gh.addEventListener("click", (e) => {
      if (e.target.closest(".gh-name")) return; // allow name click to navigate
      const sessions = group.querySelector(".group-sessions");
      if (sessions.style.display === "none") {
        sessions.style.display = "";
        gh.classList.add("on");
      } else {
        sessions.style.display = "none";
        gh.classList.remove("on");
      }
    });
  }

  // Sessions
  const container = group.querySelector(".group-sessions");
  if (!container) return group;
  container.innerHTML = "";

  // Collect all child sessions
  const allChildren = [];
  if (hasSessions) {
    for (const pm of tree.pmSessions) {
      for (const child of pm.children) {
        allChildren.push(child);
      }
    }
  }

  if (allChildren.length === 0) {
    const empty = document.createElement("div");
    empty.className = "group-empty";
    copyVueAttr(empty, group);
    empty.textContent = "无统筹";
    container.appendChild(empty);
  }

  for (const child of allChildren) {
    container.appendChild(renderEntry(child, group));
  }

  return group;
}

function renderEntry(session, groupTemplate) {
  const template = cloneNative(".sessions .se");
  const se = template || document.createElement("div");
  if (!template) se.className = "se";

  se.style.paddingLeft = "16px";

  const ts = session.updatedAt ? timeAgo(session.updatedAt) : "";
  const isActive = session.status === "active" || session.status === "swarm";

  // Current session highlight
  const currentId = getCurrentSessionId();
  if (currentId && session.id === currentId) {
    se.classList.add("on");
  }

  const row = se.querySelector(".row");
  if (row) {
    const tEl = row.querySelector(".t");
    if (tEl) tEl.textContent = session.title || session.id;

    const tsEl = row.querySelector(".ts");
    if (tsEl) tsEl.textContent = ts;

    const leadEl = row.querySelector(".lead");
    if (leadEl && isActive) {
      leadEl.innerHTML = '<span class="ui-spinner ui-spinner--sm" role="status"><svg class="ui-spinner__svg" viewBox="0 0 24 24"><circle class="ui-spinner__track" cx="12" cy="12" r="9"></circle><circle class="ui-spinner__arc" cx="12" cy="12" r="9"></circle></svg></span>';
      const vm = getVueScopeAttr(se);
      if (vm) leadEl.querySelectorAll("*").forEach(c => c.setAttribute(vm.name, vm.value));
    }

    // Wire kebab button — create if missing from cloned template
    let kebab = row.querySelector(".kebab");
    if (!kebab) {
      // Create kebab button if cloned template lacks it
      const act = row.querySelector(".act");
      if (act) {
        kebab = document.createElement("button");
        kebab.className = "ui-icon-button ui-icon-button--sm kebab";
        kebab.setAttribute("type", "button");
        kebab.setAttribute("aria-label", "选项");
        kebab.innerHTML = '<svg class="kw-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 10.5c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5S6 12.825 6 12s-.675-1.5-1.5-1.5m15 0c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5S21 12.825 21 12s-.675-1.5-1.5-1.5m-7.5 0c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5s1.5-.675 1.5-1.5s-.675-1.5-1.5-1.5"></path></svg>';
        const vm = getVueScopeAttr(se);
        if (vm) kebab.querySelectorAll("*").forEach(c => c.setAttribute(vm.name, vm.value));
        act.appendChild(kebab);
      }
    }
    if (kebab) {
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showSessionMenu(e, session);
      };
      kebab.addEventListener("pointerdown", handler, { capture: true });
      kebab.addEventListener("click", handler, { capture: true });
    }
  } else {
    se.textContent = session.title || session.id;
  }

  se.style.cursor = "pointer";
  se.addEventListener("click", (e) => {
    navigateToSession(session.id);
  });

  return se;
}

/** Try to detect current active session from page URL */
function getCurrentSessionId() {
  const m = window.location.pathname.match(/\/session\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function updateEntry(el, oldData, newData) {
  if (!el) return;
  const tEl = el.querySelector(".t");
  const tsEl = el.querySelector(".ts");
  if (tEl && newData.title !== oldData.title) tEl.textContent = newData.title;
  if (tsEl && newData.updatedAt) tsEl.textContent = timeAgo(newData.updatedAt);
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + "m";
  const h = Math.floor(mins / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d";
  return Math.floor(d / 7) + "w";
}

// ── Dropdown menus ────────────────────────────────────────

let activeMenu = null;

document.addEventListener("click", () => {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}, true);

function showSessionMenu(event, session) {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; return; }

  const menu = document.createElement("div");
  menu.className = "orch-menu";
  menu.innerHTML = `
    <button class="orch-menu-item">复制 Session ID</button>
    <div class="orch-menu-sep"></div>
    <div class="orch-menu-time">${session.updatedAt || ""}</div>
  `;
  menu.style.top = event.clientY + "px";
  menu.style.left = (event.clientX - 140) + "px";

  menu.querySelector(".orch-menu-item").addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(session.id).catch(() => {});
    menu.remove();
    activeMenu = null;
  });

  document.body.appendChild(menu);
  activeMenu = menu;
  event.stopPropagation();
}

function showSectionMenu(event) {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; return; }

  const showPath = localStorage.getItem("orch-show-path") === "true";

  const menu = document.createElement("div");
  menu.className = "orch-menu";
  menu.innerHTML = `
    <button class="orch-menu-item">
      <span class="orch-menu-check">${showPath ? '✓' : ''}</span>
      显示工作区路径
    </button>
  `;
  menu.style.top = event.clientY + "px";
  menu.style.left = (event.clientX - 120) + "px";

  menu.querySelector(".orch-menu-item").addEventListener("click", (e) => {
    e.stopPropagation();
    const newVal = !showPath;
    localStorage.setItem("orch-show-path", newVal);
    const el = document.querySelector('[data-orchestrator="true"] .gh-path');
    if (el) el.style.display = newVal ? "" : "none";
    menu.remove();
    activeMenu = null;
  });

  document.body.appendChild(menu);
  activeMenu = menu;
  event.stopPropagation();
}
