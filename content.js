(function () {
  const KINDS = ["All", "Deployment", "Service", "ConfigMap", "StatefulSet"];
  const NODE_SELECTOR = ".application-resource-tree__node";
  const POLL_MS = 700;
  const POS_STORAGE_KEY = "argocd-ext-kf-pos";
  const COLLAPSED_STORAGE_KEY = "argocd-ext-kf-collapsed";
  const CUSTOM_KINDS_STORAGE_KEY = "argocd-ext-kf-custom-kinds";
  const HIDDEN_KINDS_STORAGE_KEY = "argocd-ext-hidden-kinds";
  const DEBUG_LOGGING_STORAGE_KEY = "argocd-ext-debug-logging";
  const IGNORE_HIDDEN_STORAGE_KEY = "argocd-ext-kf-ignore-hidden";
  const NODE_MENU_ANCHOR_SELECTOR = ".application-resource-tree__node-menu .argo-dropdown__anchor";
  const OPEN_ACTION_MENU_SELECTOR = ".argo-dropdown__content.is-menu.opened ul";
  const HIDE_BY_DEFAULT_ITEM_CLASS = "argocd-ext-hide-by-default-item";

  let selectedKind = "All";
  let customKinds = [];
  let hiddenKinds = []; // kinds hidden by default, shared globally via chrome.storage.local
  let ignoreHiddenDefaults = false; // per-instance override: temporarily show hidden-by-default kinds
  let debugLogging = false; // chrome.storage.local, off by default — see options page
  let pendingMenuNodeInfo = null; // { kind, namespace, name } of the node whose kebab menu was last opened

  function log(...args) {
    if (debugLogging) console.log(...args);
  }

  function nodeKey(n) {
    return `${n.kind}|${n.namespace || ""}|${n.name}`;
  }

  function parseTitle(title) {
    if (!title) return null;
    const info = {};
    for (const line of title.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "kind") info.kind = val;
      if (key === "namespace") info.namespace = val === "(global)" ? "" : val;
      if (key === "name") info.name = val;
    }
    if (!info.kind || info.name === undefined) return null;
    return info;
  }

  function getAppInfo() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("applications");
    if (idx === -1) return null;
    const rest = parts.slice(idx + 1);
    if (rest.length === 0) return null;
    if (rest.length === 1) return { namespace: null, name: rest[0] };
    return { namespace: rest[0], name: rest[1] };
  }

  // ArgoCD's resource-tree *stream* only pushes a message when the backend
  // actually refreshes/reconciles the app — it doesn't push its current
  // state just because a new EventSource subscribed. Until that happens,
  // what's on screen is whatever the one-shot GET returned, which
  // page-interceptor.js doesn't filter (see LLM.md's "Graph-level
  // filtering" — that's a deliberately accepted gap, not an oversight) —
  // and unlike a brief flash, this can persist indefinitely, exactly what
  // clicking ArgoCD's own "Refresh" button was observed to fix. So fire
  // that same request ourselves rather than making the user find and click
  // it: GET /api/v1/applications/<name>?appNamespace=<ns>&refresh=normal,
  // same endpoint/params ArgoCD's own UI uses for a normal (not hard)
  // refresh.
  async function triggerRefresh() {
    const appInfo = getAppInfo();
    if (!appInfo) return;
    const params = new URLSearchParams({ refresh: "normal" });
    if (appInfo.namespace) params.set("appNamespace", appInfo.namespace);
    try {
      await fetch(`/api/v1/applications/${encodeURIComponent(appInfo.name)}?${params}`, {
        credentials: "include",
      });
      log("[argocd-ui-enhancer] triggered app refresh to force a filtered stream push");
    } catch (e) {
      console.error("[argocd-ui-enhancer] app refresh failed", e);
    }
  }

  // The actual filtering happens in page-interceptor.js (MAIN world), which
  // rewrites ArgoCD's own resource-tree API/stream responses before React
  // ever sees the dropped nodes — so dagre lays out a fresh, already-pruned
  // graph with no gaps, rather than this content script hiding already-
  // rendered DOM after the fact. This just needs to tell it what the
  // current filter is, any time that changes. postMessage is the only way
  // across — MAIN and isolated worlds share the DOM but not JS globals, so
  // there's no direct function call or shared state possible here.
  function postFilterConfig() {
    log("[argocd-ui-enhancer] posting filter config", {
      selectedKind,
      hiddenKinds,
      ignoreHiddenDefaults,
      debugLogging,
    });
    window.postMessage(
      {
        source: "argocd-ext",
        type: "filter-config",
        selectedKind,
        hiddenKinds,
        ignoreHiddenDefaults,
        debugLogging,
      },
      location.origin
    );
  }

  function loadJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // ignore (private mode, storage disabled, etc.)
    }
  }

  function getAllKinds() {
    return KINDS.concat(customKinds);
  }

  function addCustomKind(rawKind) {
    const kind = (rawKind || "").trim();
    if (!kind) return false;
    const exists = getAllKinds().some((k) => k.toLowerCase() === kind.toLowerCase());
    if (exists) return false;
    customKinds.push(kind);
    saveJSON(CUSTOM_KINDS_STORAGE_KEY, customKinds);
    return true;
  }

  function removeCustomKind(kind) {
    customKinds = customKinds.filter((k) => k !== kind);
    saveJSON(CUSTOM_KINDS_STORAGE_KEY, customKinds);
    if (selectedKind === kind) selectedKind = "All";
  }

  // Hidden-by-default kinds live in chrome.storage.local (not localStorage)
  // because the options page — a separate extension page, different origin
  // from the ArgoCD page — needs to read/write the same list.
  function loadHiddenKinds() {
    chrome.storage.local.get(HIDDEN_KINDS_STORAGE_KEY, (res) => {
      hiddenKinds = Array.isArray(res[HIDDEN_KINDS_STORAGE_KEY]) ? res[HIDDEN_KINDS_STORAGE_KEY] : [];
      postFilterConfig();
    });
  }

  // Also chrome.storage.local (not localStorage) — same reasoning as
  // hidden-by-default kinds, the options page needs to read/write it too.
  function loadDebugLogging() {
    chrome.storage.local.get(DEBUG_LOGGING_STORAGE_KEY, (res) => {
      debugLogging = res[DEBUG_LOGGING_STORAGE_KEY] === true;
      postFilterConfig();
    });
  }

  function addHiddenKind(kind) {
    if (!kind || hiddenKinds.includes(kind)) return;
    chrome.storage.local.set({ [HIDDEN_KINDS_STORAGE_KEY]: hiddenKinds.concat(kind) });
    // hiddenKinds itself, and the interceptor, update via the onChanged
    // listener below — chrome.storage.onChanged fires for the writer too.
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[HIDDEN_KINDS_STORAGE_KEY]) {
      hiddenKinds = changes[HIDDEN_KINDS_STORAGE_KEY].newValue || [];
      postFilterConfig();
    }
    if (changes[DEBUG_LOGGING_STORAGE_KEY]) {
      debugLogging = changes[DEBUG_LOGGING_STORAGE_KEY].newValue === true;
      postFilterConfig();
    }
  });

  // ArgoCD's per-node kebab menu (`.application-resource-tree__node-menu`)
  // renders its dropdown content into a React portal on document.body, not
  // nested under the node — so there's no DOM ancestry from the open menu
  // back to the node it belongs to. Capture which node's kebab was clicked
  // (capture phase, so this runs before ArgoCD's own handler calls
  // stopPropagation) and use that to attribute the menu that opens next.
  function trackMenuNodeOnClick(e) {
    const anchor = e.target.closest(NODE_MENU_ANCHOR_SELECTOR);
    if (!anchor) return;
    const nodeEl = anchor.closest(NODE_SELECTOR);
    pendingMenuNodeInfo = nodeEl ? parseTitle(nodeEl.getAttribute("title")) : null;
  }

  // ArgoCD builds the menu's <ul> asynchronously (its items come from an
  // Observable via DataLoader), so this has to run off a MutationObserver
  // rather than right after the click — the <ul> doesn't exist yet then.
  function injectHideByDefaultMenuItem() {
    if (!pendingMenuNodeInfo) return;
    const info = pendingMenuNodeInfo;
    document.querySelectorAll(OPEN_ACTION_MENU_SELECTOR).forEach((ul) => {
      if (!ul.children.length || ul.querySelector(`.${HIDE_BY_DEFAULT_ITEM_CLASS}`)) return;
      const li = document.createElement("li");
      li.className = `application-details__action-menu ${HIDE_BY_DEFAULT_ITEM_CLASS}`;
      li.textContent = `Hide ${info.kind} by default`;
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        addHiddenKind(info.kind);
        document.body.click(); // same trick ArgoCD's own menu items use to close the dropdown
      });
      ul.appendChild(li);
    });
  }

  function makeDraggable(handleEl, boxEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handleEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".argocd-ext-kf__collapse")) return;
      dragging = true;
      const rect = boxEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      handleEl.setPointerCapture(e.pointerId);
    });

    handleEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - boxEl.offsetWidth;
      const maxTop = window.innerHeight - boxEl.offsetHeight;
      const left = Math.min(Math.max(0, startLeft + (e.clientX - startX)), maxLeft);
      const top = Math.min(Math.max(0, startTop + (e.clientY - startY)), maxTop);
      boxEl.style.left = `${left}px`;
      boxEl.style.top = `${top}px`;
      boxEl.style.right = "auto";
    });

    function stopDragging(e) {
      if (!dragging) return;
      dragging = false;
      saveJSON(POS_STORAGE_KEY, { left: boxEl.style.left, top: boxEl.style.top });
    }

    handleEl.addEventListener("pointerup", stopDragging);
    handleEl.addEventListener("pointercancel", stopDragging);
  }

  function renderKindOptions(select) {
    const prevValue = select.value || selectedKind;
    select.innerHTML = "";
    for (const k of getAllKinds()) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k === "All" ? "All kinds" : k;
      select.appendChild(opt);
    }
    select.value = getAllKinds().includes(prevValue) ? prevValue : "All";
    selectedKind = select.value;
  }

  function renderCustomKindList(listEl, select) {
    listEl.innerHTML = "";
    for (const k of customKinds) {
      const li = document.createElement("li");

      const span = document.createElement("span");
      span.textContent = k;
      li.appendChild(span);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "argocd-ext-kf__kind-remove";
      removeBtn.textContent = "×";
      removeBtn.title = `Remove ${k}`;
      removeBtn.addEventListener("click", () => {
        removeCustomKind(k);
        renderKindOptions(select);
        renderCustomKindList(listEl, select);
        postFilterConfig();
      });
      li.appendChild(removeBtn);

      listEl.appendChild(li);
    }
  }

  function createWidget() {
    if (document.getElementById("argocd-ext-kind-filter")) return;

    customKinds = loadJSON(CUSTOM_KINDS_STORAGE_KEY) || [];
    ignoreHiddenDefaults = loadJSON(IGNORE_HIDDEN_STORAGE_KEY) === true;

    const box = document.createElement("div");
    box.id = "argocd-ext-kind-filter";

    const header = document.createElement("div");
    header.className = "argocd-ext-kf__header";

    const title = document.createElement("span");
    title.className = "argocd-ext-kf__title";
    title.textContent = "Kind filter";
    header.appendChild(title);

    const collapsed = loadJSON(COLLAPSED_STORAGE_KEY) === true;

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "argocd-ext-kf__collapse";
    collapseBtn.textContent = collapsed ? "▸" : "▾";
    collapseBtn.addEventListener("click", () => {
      const isCollapsed = box.classList.toggle("is-collapsed");
      collapseBtn.textContent = isCollapsed ? "▸" : "▾";
      saveJSON(COLLAPSED_STORAGE_KEY, isCollapsed);
    });
    header.appendChild(collapseBtn);

    box.appendChild(header);

    const body = document.createElement("div");
    body.className = "argocd-ext-kf__body";

    const select = document.createElement("select");
    renderKindOptions(select);
    select.addEventListener("change", () => {
      selectedKind = select.value;
      postFilterConfig();
    });
    body.appendChild(select);

    const ignoreHiddenRow = document.createElement("label");
    ignoreHiddenRow.className = "argocd-ext-kf__ignore-hidden-row";
    const ignoreHiddenCheckbox = document.createElement("input");
    ignoreHiddenCheckbox.type = "checkbox";
    ignoreHiddenCheckbox.checked = ignoreHiddenDefaults;
    ignoreHiddenCheckbox.addEventListener("change", () => {
      ignoreHiddenDefaults = ignoreHiddenCheckbox.checked;
      saveJSON(IGNORE_HIDDEN_STORAGE_KEY, ignoreHiddenDefaults);
      postFilterConfig();
    });
    ignoreHiddenRow.appendChild(ignoreHiddenCheckbox);
    ignoreHiddenRow.appendChild(document.createTextNode(" Show hidden-by-default kinds"));
    body.appendChild(ignoreHiddenRow);

    const addRow = document.createElement("div");
    addRow.className = "argocd-ext-kf__add-row";

    const kindInput = document.createElement("input");
    kindInput.type = "text";
    kindInput.placeholder = "Add kind (e.g. Job)";
    addRow.appendChild(kindInput);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "+";
    addBtn.title = "Add kind";
    addRow.appendChild(addBtn);

    const kindList = document.createElement("ul");
    kindList.className = "argocd-ext-kf__kind-list";

    function tryAddKind() {
      if (addCustomKind(kindInput.value)) {
        kindInput.value = "";
        renderKindOptions(select);
        renderCustomKindList(kindList, select);
      }
    }

    addBtn.addEventListener("click", tryAddKind);
    kindInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryAddKind();
    });

    body.appendChild(addRow);
    body.appendChild(kindList);
    renderCustomKindList(kindList, select);

    box.appendChild(body);
    if (collapsed) box.classList.add("is-collapsed");

    document.body.appendChild(box);

    const pos = loadJSON(POS_STORAGE_KEY);
    if (pos && pos.left && pos.top) {
      box.style.left = pos.left;
      box.style.top = pos.top;
      box.style.right = "auto";
    }

    makeDraggable(header, box);

    postFilterConfig();
  }

  function init() {
    log("[argocd-ui-enhancer] content script loaded");
    createWidget();
    loadHiddenKinds();
    loadDebugLogging();
    triggerRefresh();
    document.addEventListener("click", trackMenuNodeOnClick, true);

    new MutationObserver(() => injectHideByDefaultMenuItem()).observe(document.body, {
      childList: true,
      subtree: true,
    });

    // ArgoCD is a client-rendered SPA — no real navigation event fires when
    // switching between apps, hence the href poll. Re-triggers the refresh
    // on every app switch (and on revisiting the same app), since each is a
    // fresh EventSource subscription that needs its own push.
    let lastHref = location.href;
    setInterval(() => {
      if (!document.getElementById("argocd-ext-kind-filter")) createWidget();
      if (location.href !== lastHref) {
        lastHref = location.href;
        triggerRefresh();
      }
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
