import {
  normalizeHost,
  hostToPattern,
  getStoredHosts,
  setStoredHosts,
  reconcileContentScripts,
} from "./shared.js";

const currentSiteLabel = document.getElementById("currentSiteLabel");
const enableCurrentBtn = document.getElementById("enableCurrentBtn");
const hostInput = document.getElementById("hostInput");
const addBtn = document.getElementById("addBtn");
const errorMsg = document.getElementById("errorMsg");
const hostList = document.getElementById("hostList");
const emptyMsg = document.getElementById("emptyMsg");

let activeTab = null;
let activeTabHost = null;

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = !msg;
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    // Best-effort: if ArgoCD's own bundle already opened its resource-tree
    // stream before this fired (page was already loaded when the user hit
    // "Enable"), that connection won't be filtered — it's not created via
    // `new EventSource` again until the next navigation/reconnect. A reload
    // guarantees the interceptor is in place from document_start.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page-interceptor.js"],
      world: "MAIN",
    });
  } catch (e) {
    // tab may have navigated away or be a restricted page; safe to ignore
  }
}

async function addHost(host) {
  showError("");
  const normalized = normalizeHost(host);
  if (!normalized) {
    showError("Enter a valid host, e.g. argocd.example.com");
    return;
  }

  const granted = await chrome.permissions.request({ origins: [hostToPattern(normalized)] });
  if (!granted) {
    showError("Permission was not granted.");
    return;
  }

  const hosts = await getStoredHosts();
  if (!hosts.includes(normalized)) {
    hosts.push(normalized);
    await setStoredHosts(hosts);
  }

  let reconcileFailed = false;
  try {
    await reconcileContentScripts();
  } catch (e) {
    reconcileFailed = true;
    showError(`Permission granted, but script registration failed: ${e.message || e}`);
    console.error("[argocd-ui-enhancer]", e);
  }

  if (!reconcileFailed && activeTab && activeTabHost === normalized) {
    await injectIntoTab(activeTab.id);
  }

  hostInput.value = "";
  await renderHostList(); // host is already saved even if reconcile failed — keep the list in sync
}

async function removeHost(host) {
  await chrome.permissions.remove({ origins: [hostToPattern(host)] });
  const hosts = await getStoredHosts();
  await setStoredHosts(hosts.filter((h) => h !== host));
  try {
    await reconcileContentScripts();
  } catch (e) {
    showError(`Removed, but script re-registration failed: ${e.message || e}`);
    console.error("[argocd-ui-enhancer]", e);
  }
  await renderHostList();
}

async function renderHostList() {
  const hosts = await getStoredHosts();
  hostList.innerHTML = "";
  emptyMsg.hidden = hosts.length > 0;

  for (const host of hosts) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.textContent = host;
    li.appendChild(span);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeHost(host));
    li.appendChild(removeBtn);

    hostList.appendChild(li);
  }

  const alreadyAdded = activeTabHost && hosts.includes(activeTabHost);
  enableCurrentBtn.disabled = !activeTabHost || alreadyAdded;
  enableCurrentBtn.textContent = alreadyAdded ? "Already enabled" : "Enable on this site";
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  activeTabHost = tab && tab.url ? normalizeHost(tab.url) : null;

  currentSiteLabel.textContent = activeTabHost
    ? `Current site: ${activeTabHost}`
    : "Current site: n/a";

  await renderHostList();
}

enableCurrentBtn.addEventListener("click", () => {
  if (activeTabHost) addHost(activeTabHost);
});

addBtn.addEventListener("click", () => addHost(hostInput.value));
hostInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addHost(hostInput.value);
});

init();
