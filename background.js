import { reconcileContentScripts } from "./shared.js";

chrome.runtime.onInstalled.addListener(() => {
  reconcileContentScripts().catch((e) => console.error("[argocd-ui-enhancer]", e));
});

chrome.runtime.onStartup.addListener(() => {
  reconcileContentScripts().catch((e) => console.error("[argocd-ui-enhancer]", e));
});
