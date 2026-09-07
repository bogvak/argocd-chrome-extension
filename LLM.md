# LLM.md — universal agent context

Agent-agnostic project context. Read this before changing anything. Update it when architecture or decisions change, not just when code changes.

## Instructions for any coding agent working here

- **Always update this file** when you change architecture, a decision, or a gotcha — not just when you change code. A future agent (any vendor, not just Claude) should be able to read this file alone and not rediscover what's already been learned.
- This repo is public — no company-specific hostnames, internal URLs, or org names in code, docs, or commit messages. If you spot one that slipped in, flag it and ask before scrubbing it yourself.
- Don't reintroduce hardcoded hosts (`content_scripts`/`host_permissions` in `manifest.json`) — see "Permissions model" below for why, and keep new features on the runtime-request flow.
- The ArgoCD DOM/API assumptions here (class names, `title` format, `resource-tree` endpoint shape) came from reading `argoproj/argo-cd`'s public UI source, not from live inspection — this project has no browser automation against a real (IAP-gated) ArgoCD instance. If something stops matching after an ArgoCD upgrade, re-derive it from that source rather than guessing, and update this file with what changed.
- No build step, no automated tests — verify changes by loading the repo unpacked in `chrome://extensions` (see Testing below) before calling anything done.

## What this is

Chrome extension (Manifest V3), public (not tied to any one company — no hardcoded hosts). Fixes/extends ArgoCD's own UI, starting with: filter the Application resource tree by object kind (Deployment / Service / ConfigMap), hiding everything else while keeping the selected kind's descendants (ReplicaSet, Pod, etc.) — unlike ArgoCD's native "Kind" filter, which filters every node independently and breaks the tree (hides children too).

## File map

- `manifest.json` — MV3 manifest. No `content_scripts`/`host_permissions` — injection is fully dynamic (see Permissions model below).
- `content.js` / `content.css` — the actual feature: injected into ArgoCD pages, renders the floating draggable "Kind filter" widget, fetches the resource tree, hides/shows nodes and connector lines.
- `popup.html` / `popup.js` / `popup.css` — toolbar popup: lets the user add/remove ArgoCD hosts, requests permission per host, registers/injects the content script.
- `background.js` — MV3 service worker. Only job: reconcile dynamic content-script registration with actually-granted permissions on `onInstalled`/`onStartup`.
- `shared.js` — ES module shared between `background.js` and `popup.js` (host normalization, `chrome.storage` helpers, `chrome.scripting.registerContentScripts` wrapper). Both load it via `type: "module"`.
- `icons/icon.svg` + rasterized `icons/icon{16,32,48,128}.png` — toolbar/store icon (funnel + colored dots = "filter by kind"). Regenerate PNGs from the SVG with `rsvg-convert -w <size> -h <size> icon.svg -o icon<size>.png` if the design changes.

## Permissions model — why there's no hardcoded host

This started as a internal tool with hosts hardcoded in `manifest.json`. To make it public, switched to:

- `optional_host_permissions: ["https://*/*"]` in the manifest (broad *declaration*, required so the runtime request below is even possible).
- Popup calls `chrome.permissions.request({origins: ["https://<host>/*"]})` for the *specific* host the user types — Chrome shows a native prompt scoped to that one host, not the wildcard.
- On grant: host saved to `chrome.storage.local`, `chrome.scripting.registerContentScripts()` registers `content.js`/`content.css` for that host (persists across restarts), and `chrome.scripting.executeScript`/`insertCSS` inject into the *currently open* tab immediately (registration alone only affects future page loads).
- Remove flow: `chrome.permissions.remove()` + drop from storage + re-register.
- `background.js` reconciles on startup/install in case Chrome drops a registration or a permission gets revoked outside the popup (e.g. via `chrome://extensions`).

Don't revert to static `content_scripts`/`host_permissions` — that's what made this internal-only.

## How the filter actually works (ArgoCD internals — reverse-engineered from `argoproj/argo-cd` UI source, not documented anywhere)

ArgoCD's tree view DOM has **no data attributes** for a node's kind, name, namespace, or parent. Everything below was found by reading `ui/src/app/applications/components/application-resource-tree/application-resource-tree.tsx` in the argo-cd repo — re-check that file if this ever breaks after an ArgoCD upgrade.

- **Identifying a node**: each node wrapper (`.application-resource-tree__node`) has a `title` attribute set to the output of `describeNode()`:
  ```
  Kind: Deployment
  Namespace: foo
  Name: bar
  ```
  `content.js` parses this and builds a key `kind|namespace|name` — this is the only reliable identity available in the DOM (no `group`, so a same-name/kind/namespace collision across API groups is an unhandled edge case, acceptably rare).

- **Parent/child structure isn't in the DOM at all.** It only exists in React state, built from each node's `parentRefs`. So `content.js` fetches it independently from ArgoCD's own REST API: `GET /api/v1/applications/<name>/resource-tree` (+ `?appNamespace=<ns>` if the app itself lives in a non-default namespace — URL path is `/applications/<namespace>/<name>` or `/applications/<name>`). This is a same-origin `fetch(..., {credentials:'include'})`, so it rides the existing ArgoCD session/IAP cookie — no separate auth needed. Response nodes carry `kind`/`namespace`/`name`/`parentRefs`; `content.js` builds a `childrenByParentKey` map from that and walks it to compute "kind + all descendants" as the keep-set.

- **Connector lines/arrows are the hard part.** Each edge renders as a `.application-resource-tree__edge` wrapper containing 1+ `.application-resource-tree__line` divs (right-angle routing = horizontal → vertical → horizontal segments, all under one wrapper). Two things bit us during development, both fixed in the current code:
  1. The wrapper itself has no usable size for hit-testing — its children are `position:absolute`, so a plain CSS box wouldn't contain them and the wrapper's own `getBoundingClientRect()` is meaningless. Must measure the `.line` children directly, not the wrapper.
  2. Even measuring the lines, the **vertical middle segment** of a right-angle edge sits at a "bend" x-coordinate between node columns — it never geometrically overlaps either endpoint node's box, only the two horizontal segments (which run right up to the node edges) do. Fix: group all line segments by their shared edge wrapper, and if *any* segment in that group overlaps a hidden node's box (padded a few px), hide the *whole group* together — not each segment independently.

  The overlap test is a simple padded axis-aligned bounding-box check (`rectsOverlap` in `content.js`), computed after resetting everything to visible each pass (hidden elements collapse to a zero rect and can't be measured, so nodes/edges are always reset to visible, measured, then re-hidden every `applyFilterNow()` call).

- Because ArgoCD is a client-rendered SPA, `content.js` also: polls `location.href` (no real navigation event fires on in-app app switches) to know when to re-fetch the tree, and runs a `MutationObserver` on `document.body` to reapply the filter as the tree view re-renders (health/status polling, expand/collapse, etc.).

## Widget UI

Floating panel, dark header = drag handle, ▾/▸ collapses to just the header. Position and collapsed state persist in `localStorage` (per-origin, so per ArgoCD instance) — not `chrome.storage`, since it's purely a per-page UI preference with no cross-device need.

## Current scope / known limitations

- Kind dropdown is single-select, hardcoded list: `All / Deployment / Service / ConfigMap` (`KINDS` const in `content.js`). Multi-select and a configurable kind list are natural next steps, not built yet.
- Line-hiding is a geometric heuristic (bounding-box overlap), not a true graph lookup — a false-positive hide is theoretically possible if two unrelated branches visually cross on screen, but tree-view's column layout makes this rare in practice. Watch for reports of the wrong line disappearing.
- No automated tests. Verified manually against a couple of live (internal, IAP-gated) ArgoCD instances, since the coding agent has no browser automation access to an authenticated instance — API/DOM assumptions above were derived by reading the public argo-cd source, not by inspecting a live page. If ArgoCD upgrades change these class names/title format/API shape, this breaks silently (no error surfaced beyond a console fetch failure for the API call).

## Testing

No build step — load unpacked: `chrome://extensions` → Developer mode → Load unpacked → repo root. Then use the toolbar popup to add a host. Check the console on the ArgoCD tab for `[argocd-ui-enhancer]` errors if the tree doesn't filter (usually means the `resource-tree` API call failed or the app path parsing guessed wrong).
