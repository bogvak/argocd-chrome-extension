(function () {
  const KINDS = ["All", "Deployment", "Service", "ConfigMap"];
  const NODE_SELECTOR = ".application-resource-tree__node";
  const EDGE_WRAPPER_SELECTOR = ".application-resource-tree__edge";
  const EDGE_SELECTOR = ".application-resource-tree__line";
  const EDGE_HIDE_PADDING_PX = 6;
  const POLL_MS = 700;
  const POS_STORAGE_KEY = "argocd-ext-kf-pos";
  const COLLAPSED_STORAGE_KEY = "argocd-ext-kf-collapsed";

  let selectedKind = "All";
  let treeData = null; // { allNodes, childrenByParentKey }
  let lastAppKey = null;
  let lastHref = location.href;
  let applyScheduled = false;

  function getAppInfo() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("applications");
    if (idx === -1) return null;
    const rest = parts.slice(idx + 1);
    if (rest.length === 0) return null;
    if (rest.length === 1) return { namespace: null, name: rest[0] };
    return { namespace: rest[0], name: rest[1] };
  }

  function nodeKey(n) {
    return `${n.kind}|${n.namespace || ""}|${n.name}`;
  }

  async function fetchTree(appInfo) {
    const params = new URLSearchParams();
    if (appInfo.namespace) params.set("appNamespace", appInfo.namespace);
    const qs = params.toString();
    const url = `/api/v1/applications/${encodeURIComponent(appInfo.name)}/resource-tree${qs ? "?" + qs : ""}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`resource-tree fetch failed: ${res.status}`);
    return res.json();
  }

  function buildChildrenMap(tree) {
    const allNodes = (tree.nodes || []).concat(tree.orphanedNodes || []);
    const map = new Map();
    for (const n of allNodes) {
      for (const p of n.parentRefs || []) {
        const pk = nodeKey(p);
        if (!map.has(pk)) map.set(pk, []);
        map.get(pk).push(nodeKey(n));
      }
    }
    return { allNodes, map };
  }

  function collectDescendants(rootKey, map) {
    const keep = new Set([rootKey]);
    const stack = [rootKey];
    while (stack.length) {
      const k = stack.pop();
      for (const c of map.get(k) || []) {
        if (!keep.has(c)) {
          keep.add(c);
          stack.push(c);
        }
      }
    }
    return keep;
  }

  function computeKeepSet(kind) {
    if (kind === "All" || !treeData) return null;
    const { allNodes, map } = treeData;
    const keep = new Set();
    for (const n of allNodes) {
      if (n.kind === kind) {
        for (const k of collectDescendants(nodeKey(n), map)) keep.add(k);
      }
    }
    return keep;
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

  function rectsOverlap(a, b, pad) {
    return !(
      a.right < b.left - pad ||
      a.left > b.right + pad ||
      a.bottom < b.top - pad ||
      a.top > b.bottom + pad
    );
  }

  function applyFilterNow() {
    const keep = computeKeepSet(selectedKind);
    const nodeEls = document.querySelectorAll(NODE_SELECTOR);

    // Reset to visible first so rects reflect true layout positions
    // (hidden elements collapse to a zero rect and can't be measured).
    nodeEls.forEach((el) => {
      el.style.display = "";
    });

    const hiddenRects = [];
    nodeEls.forEach((el) => {
      if (!keep) return;
      const info = parseTitle(el.getAttribute("title"));
      const isHidden = !info || !keep.has(nodeKey(info));
      if (isHidden) {
        hiddenRects.push(el.getBoundingClientRect());
        el.style.display = "none";
      }
    });

    // Line segments are grouped under one edge wrapper (right-angle routing
    // splits an edge into horizontal/vertical/horizontal segments). Only the
    // segments touching a node actually overlap its rect, so decide per
    // wrapper using ALL its segments, then hide/show them together.
    document.querySelectorAll(EDGE_WRAPPER_SELECTOR).forEach((edgeEl) => {
      edgeEl.style.display = "";
      if (!keep) return;
      const lineEls = edgeEl.querySelectorAll(EDGE_SELECTOR);
      const touchesHidden = Array.from(lineEls).some((lineEl) => {
        const rect = lineEl.getBoundingClientRect();
        return hiddenRects.some((hr) =>
          rectsOverlap(rect, hr, EDGE_HIDE_PADDING_PX)
        );
      });
      if (touchesHidden) edgeEl.style.display = "none";
    });
  }

  function applyFilter() {
    if (applyScheduled) return;
    applyScheduled = true;
    requestAnimationFrame(() => {
      applyScheduled = false;
      applyFilterNow();
    });
  }

  async function refreshTreeData() {
    const appInfo = getAppInfo();
    if (!appInfo) {
      treeData = null;
      return;
    }
    try {
      treeData = buildChildrenMap(await fetchTree(appInfo));
    } catch (e) {
      console.error("[argocd-ui-enhancer]", e);
      treeData = null;
    }
  }

  async function onAppMaybeChanged() {
    const appInfo = getAppInfo();
    const key = appInfo ? `${appInfo.namespace}|${appInfo.name}` : null;
    if (key === lastAppKey) return;
    lastAppKey = key;
    await refreshTreeData();
    applyFilter();
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

  function createWidget() {
    if (document.getElementById("argocd-ext-kind-filter")) return;

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
    for (const k of KINDS) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k === "All" ? "All kinds" : k;
      select.appendChild(opt);
    }
    select.value = selectedKind;
    select.addEventListener("change", () => {
      selectedKind = select.value;
      applyFilter();
    });
    body.appendChild(select);

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
  }

  function init() {
    createWidget();
    onAppMaybeChanged();

    new MutationObserver(() => applyFilter()).observe(document.body, {
      childList: true,
      subtree: true,
    });

    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onAppMaybeChanged();
      }
      if (!document.getElementById("argocd-ext-kind-filter")) createWidget();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
