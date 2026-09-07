import { reconcileContentScripts } from "./shared.js";

chrome.runtime.onInstalled.addListener(() => {
  reconcileContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  reconcileContentScripts();
});
