export const CONTENT_SCRIPT_ID = "argocd-kind-filter";
export const PAGE_INTERCEPTOR_SCRIPT_ID = "argocd-kind-filter-page-interceptor";

export function normalizeHost(raw) {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  host = host.split("/")[0];
  host = host.split("?")[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  return host;
}

export function hostToPattern(host) {
  return `https://${host}/*`;
}

export async function getStoredHosts() {
  const { hosts } = await chrome.storage.local.get("hosts");
  return hosts || [];
}

export async function setStoredHosts(hosts) {
  await chrome.storage.local.set({ hosts });
}

// Registers the content script only for hosts that still have a live
// permission grant, dropping any that were revoked outside the popup
// (e.g. via chrome://extensions), and persists the trimmed list.
export async function reconcileContentScripts() {
  const hosts = await getStoredHosts();
  const granted = await chrome.permissions.getAll();
  const grantedOrigins = new Set(granted.origins || []);
  const activeHosts = hosts.filter((h) => grantedOrigins.has(hostToPattern(h)));

  if (activeHosts.length !== hosts.length) {
    await setStoredHosts(activeHosts);
  }

  const scripts = activeHosts.length
    ? [
        {
          id: CONTENT_SCRIPT_ID,
          matches: activeHosts.map(hostToPattern),
          js: ["content.js"],
          css: ["content.css"],
          runAt: "document_idle",
        },
        {
          // MAIN world + document_start: has to patch window.EventSource
          // before ArgoCD's own bundle runs and opens its first resource-tree
          // stream. Isolated-world content.js can't reach window.EventSource
          // at all — MAIN and isolated worlds don't share JS globals, only
          // the DOM (which is how content.js and this script talk to each
          // other, via window.postMessage — see content.js/page-interceptor.js).
          id: PAGE_INTERCEPTOR_SCRIPT_ID,
          matches: activeHosts.map(hostToPattern),
          js: ["page-interceptor.js"],
          world: "MAIN",
          runAt: "document_start",
        },
      ]
    : [];

  // registerContentScripts() throws (and registers NOTHING, not even the
  // scripts that were fine) if any given id is already registered — which
  // happens easily here since this runs on every host add/remove, every
  // onInstalled/onStartup. Checking what's actually registered first and
  // routing each script to register vs. update accordingly avoids ever
  // hitting that all-or-nothing failure.
  const existingIds = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const scriptIds = new Set(scripts.map((s) => s.id));

  const idsToRemove = [...existingIds].filter((id) => !scriptIds.has(id));
  if (idsToRemove.length) {
    await chrome.scripting.unregisterContentScripts({ ids: idsToRemove }).catch(() => {});
  }

  const toUpdate = scripts.filter((s) => existingIds.has(s.id));
  const toRegister = scripts.filter((s) => !existingIds.has(s.id));
  if (toUpdate.length) await chrome.scripting.updateContentScripts(toUpdate);
  if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);

  return activeHosts;
}
