// Runs in the MAIN world (the page's own JS context, not the isolated
// content-script world) so it can patch window.EventSource before ArgoCD's
// own bundle ever calls `new EventSource(...)`. This is what lets the kind
// filter and hidden-by-default kinds work by removing nodes from the graph
// data itself, instead of hiding already-rendered DOM nodes/lines after the
// fact — see LLM.md ("Graph-level filtering") for why that's the point.
(function () {
  if (window.__argocdExtInterceptorInstalled) return;
  window.__argocdExtInterceptorInstalled = true;

  // Off by default (see the options page) — gates every console.log in this
  // file. Declared before the first log call below, since that call needs
  // filterConfig.debugLogging to already exist (not just be about to).
  let filterConfig = { selectedKind: "All", hiddenKinds: [], ignoreHiddenDefaults: false, debugLogging: false };
  function log(...args) {
    if (filterConfig.debugLogging) console.log(...args);
  }
  log("[argocd-ui-enhancer] page-interceptor installed");

  // Matches ArgoCD's streaming resource-tree endpoint
  // (`/api/v1/stream/applications/<name>/resource-tree?...`), reverse-engineered
  // from argo-cd's `applications-service.ts` (`watchResourceTree`). Deliberately
  // does NOT match the non-streaming `/applications/<name>/resource-tree` GET
  // (`resourceTree()` in that same file) — see the "Known limitation" note in
  // LLM.md for why that one-shot fallback isn't intercepted (yet).
  const TREE_STREAM_RE = /\/stream\/applications\/[^/]+\/resource-tree(\?|$)/;

  const NativeEventSource = window.EventSource;

  const activeStreams = new Set(); // handles with a reapply() for instant re-filtering on config change

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "argocd-ext" || data.type !== "filter-config") return;
    filterConfig = {
      selectedKind: data.selectedKind || "All",
      hiddenKinds: Array.isArray(data.hiddenKinds) ? data.hiddenKinds : [],
      ignoreHiddenDefaults: !!data.ignoreHiddenDefaults,
      debugLogging: !!data.debugLogging,
    };
    log("[argocd-ui-enhancer] filter config updated", filterConfig, `${activeStreams.size} active stream(s)`);
    activeStreams.forEach((s) => s.reapply());
  });

  function nodeKey(n) {
    return `${n.kind}|${n.namespace || ""}|${n.name}`;
  }

  // Filters an ApplicationTree (`{nodes, orphanedNodes, hosts}`) down to the
  // current kind filter + hidden-by-default kinds. Unlike hiding already-
  // rendered DOM nodes, a dropped node's children need their `parentRefs`
  // re-wired to their nearest surviving ancestor — otherwise they'd render
  // as fully disconnected floating nodes instead of reattaching further up
  // the chain (dagre lays out whatever graph it's handed fresh each time,
  // so this "just works" once the data is right — no compaction math needed).
  function filterTree(tree) {
    const { selectedKind, hiddenKinds, ignoreHiddenDefaults } = filterConfig;
    // The widget's "Show hidden-by-default kinds" checkbox overrides the
    // persisted list for this pass, without touching the list itself.
    const effectiveHiddenKinds = ignoreHiddenDefaults ? [] : hiddenKinds;
    if (selectedKind === "All" && effectiveHiddenKinds.length === 0) return tree;

    const allNodes = (tree.nodes || []).concat(tree.orphanedNodes || []);
    const byKey = new Map(allNodes.map((n) => [nodeKey(n), n]));
    const childrenByParent = new Map();
    for (const n of allNodes) {
      for (const p of n.parentRefs || []) {
        const pk = nodeKey(p);
        if (!childrenByParent.has(pk)) childrenByParent.set(pk, []);
        childrenByParent.get(pk).push(nodeKey(n));
      }
    }

    let keep = null; // null = kind filter is "All" (everyone passes this check)
    if (selectedKind !== "All") {
      keep = new Set();
      for (const n of allNodes) {
        if (n.kind !== selectedKind) continue;
        const stack = [nodeKey(n)];
        while (stack.length) {
          const k = stack.pop();
          if (keep.has(k)) continue;
          keep.add(k);
          for (const c of childrenByParent.get(k) || []) stack.push(c);
        }
      }
    }

    function isDropped(n) {
      const failsKindFilter = keep ? !keep.has(nodeKey(n)) : false;
      // A hidden-by-default kind stays hidden unless it's the exact kind
      // currently selected in the filter dropdown — otherwise there'd be no
      // way to ever look at it again.
      const suppressedByDefault = effectiveHiddenKinds.includes(n.kind) && selectedKind !== n.kind;
      return failsKindFilter || suppressedByDefault;
    }

    const dropped = new Set(allNodes.filter(isDropped).map(nodeKey));

    // Walk up a dropped node's own parentRefs until hitting survivors (or
    // running out, if the whole chain up to a root was dropped).
    function nearestSurvivingAncestors(refs) {
      const result = [];
      const seen = new Set();
      const stack = [...(refs || [])];
      while (stack.length) {
        const ref = stack.pop();
        const key = nodeKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        if (dropped.has(key)) {
          const parent = byKey.get(key);
          stack.push(...((parent && parent.parentRefs) || []));
        } else {
          result.push(ref);
        }
      }
      return result;
    }

    function rewire(n) {
      if (!(n.parentRefs || []).some((p) => dropped.has(nodeKey(p)))) return n;
      return Object.assign({}, n, { parentRefs: nearestSurvivingAncestors(n.parentRefs) });
    }

    const filterList = (list) => (list || []).filter((n) => !dropped.has(nodeKey(n))).map(rewire);

    return Object.assign({}, tree, {
      nodes: filterList(tree.nodes),
      orphanedNodes: filterList(tree.orphanedNodes),
    });
  }

  // Wraps a real EventSource so ArgoCD gets a filtered stream. Only wraps
  // instances whose URL matches the resource-tree stream — everything else
  // (logs, other watches) passes through completely untouched via a Proxy,
  // so this can safely own the global EventSource constructor for the whole
  // page rather than needing to special-case every other stream ArgoCD uses.
  function InterceptedEventSource(url, opts) {
    const real = new NativeEventSource(url, opts);
    if (!TREE_STREAM_RE.test(String(url))) return real;
    log("[argocd-ui-enhancer] intercepting resource-tree stream", url);

    let lastParsed = null; // cached raw {result: tree}, for instant re-filter on config change
    const messageListeners = new Set();
    let onmessageProp = null;

    function dispatch(dataStr) {
      const evt = { data: dataStr };
      if (onmessageProp) onmessageProp(evt);
      messageListeners.forEach((fn) => fn(evt));
    }

    function emitFiltered(parsed) {
      let payload = parsed;
      try {
        payload = Object.assign({}, parsed, { result: filterTree(parsed.result) });
      } catch (e) {
        console.error("[argocd-ui-enhancer] tree filter failed, passing through unfiltered", e);
      }
      dispatch(JSON.stringify(payload));
    }

    real.addEventListener("message", (evt) => {
      try {
        lastParsed = JSON.parse(evt.data);
      } catch (e) {
        dispatch(evt.data); // not JSON we understand — pass through raw
        return;
      }
      emitFiltered(lastParsed);
    });

    const handle = {
      reapply() {
        if (lastParsed) emitFiltered(lastParsed);
      },
    };
    activeStreams.add(handle);

    return new Proxy(real, {
      get(target, prop) {
        if (prop === "onmessage") return onmessageProp;
        if (prop === "addEventListener") {
          return (type, fn, listenerOpts) => {
            if (type === "message") {
              messageListeners.add(fn);
              return;
            }
            target.addEventListener(type, fn, listenerOpts);
          };
        }
        if (prop === "removeEventListener") {
          return (type, fn, listenerOpts) => {
            if (type === "message") {
              messageListeners.delete(fn);
              return;
            }
            target.removeEventListener(type, fn, listenerOpts);
          };
        }
        if (prop === "close") {
          return () => {
            activeStreams.delete(handle);
            target.close();
          };
        }
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
      set(target, prop, value) {
        if (prop === "onmessage") {
          onmessageProp = value;
          return true;
        }
        target[prop] = value;
        return true;
      },
    });
  }

  InterceptedEventSource.CONNECTING = NativeEventSource.CONNECTING;
  InterceptedEventSource.OPEN = NativeEventSource.OPEN;
  InterceptedEventSource.CLOSED = NativeEventSource.CLOSED;

  window.EventSource = InterceptedEventSource;
})();
