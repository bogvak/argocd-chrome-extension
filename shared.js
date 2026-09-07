export const CONTENT_SCRIPT_ID = "argocd-kind-filter";

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

  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});

  if (activeHosts.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: activeHosts.map(hostToPattern),
        js: ["content.js"],
        css: ["content.css"],
        runAt: "document_idle",
      },
    ]);
  }

  return activeHosts;
}
