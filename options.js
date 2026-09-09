const HIDDEN_KINDS_STORAGE_KEY = "argocd-ext-hidden-kinds";
const HIDE_CHILDLESS_RS_STORAGE_KEY = "argocd-ext-hide-childless-replicasets";
const DEBUG_LOGGING_STORAGE_KEY = "argocd-ext-debug-logging";

const listEl = document.getElementById("kind-list");
const inputEl = document.getElementById("kind-input");
const addBtn = document.getElementById("add-btn");
const hideChildlessRsCheckbox = document.getElementById("hide-childless-rs-checkbox");
const debugLoggingCheckbox = document.getElementById("debug-logging-checkbox");

function loadHiddenKinds(cb) {
  chrome.storage.local.get(HIDDEN_KINDS_STORAGE_KEY, (res) => {
    cb(Array.isArray(res[HIDDEN_KINDS_STORAGE_KEY]) ? res[HIDDEN_KINDS_STORAGE_KEY] : []);
  });
}

function saveHiddenKinds(kinds) {
  chrome.storage.local.set({ [HIDDEN_KINDS_STORAGE_KEY]: kinds });
}

function render(kinds) {
  listEl.innerHTML = "";
  for (const kind of kinds) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.textContent = kind;
    li.appendChild(span);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${kind}`;
    removeBtn.addEventListener("click", () => {
      saveHiddenKinds(kinds.filter((k) => k !== kind));
    });
    li.appendChild(removeBtn);

    listEl.appendChild(li);
  }
}

function addKind() {
  const kind = inputEl.value.trim();
  if (!kind) return;
  loadHiddenKinds((kinds) => {
    if (kinds.some((k) => k.toLowerCase() === kind.toLowerCase())) return;
    saveHiddenKinds(kinds.concat(kind));
    inputEl.value = "";
  });
}

addBtn.addEventListener("click", addKind);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addKind();
});

hideChildlessRsCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ [HIDE_CHILDLESS_RS_STORAGE_KEY]: hideChildlessRsCheckbox.checked });
});

debugLoggingCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ [DEBUG_LOGGING_STORAGE_KEY]: debugLoggingCheckbox.checked });
});

// Keeps this page in sync if something changes elsewhere (a content
// script's "Hide by default" menu action, or this same page open in
// another tab).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[HIDDEN_KINDS_STORAGE_KEY]) {
    render(changes[HIDDEN_KINDS_STORAGE_KEY].newValue || []);
  }
  if (changes[HIDE_CHILDLESS_RS_STORAGE_KEY]) {
    hideChildlessRsCheckbox.checked = changes[HIDE_CHILDLESS_RS_STORAGE_KEY].newValue !== false;
  }
  if (changes[DEBUG_LOGGING_STORAGE_KEY]) {
    debugLoggingCheckbox.checked = changes[DEBUG_LOGGING_STORAGE_KEY].newValue === true;
  }
});

loadHiddenKinds(render);
chrome.storage.local.get(HIDE_CHILDLESS_RS_STORAGE_KEY, (res) => {
  hideChildlessRsCheckbox.checked = res[HIDE_CHILDLESS_RS_STORAGE_KEY] !== false;
});
chrome.storage.local.get(DEBUG_LOGGING_STORAGE_KEY, (res) => {
  debugLoggingCheckbox.checked = res[DEBUG_LOGGING_STORAGE_KEY] === true;
});
