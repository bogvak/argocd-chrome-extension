# ArgoCD UI Enhancer

A Chrome extension that fixes small annoyances and adds missing functionality to the [ArgoCD](https://argo-cd.readthedocs.io/) web UI, without needing anything on the server side.

## Why

ArgoCD's Application tree view already has a "Kind" filter, but it's flat: filtering to `Deployment` also hides that Deployment's own ReplicaSets and Pods, since they don't match the selected kind either. The result is a tree that no longer looks like a tree.

This extension adds its own kind filter that understands the hierarchy: pick a kind, and everything of a different kind is hidden *except* the descendants of whatever you kept — so filtering to `Deployment` still shows its ReplicaSets and Pods, connector lines and all.

## Features

- Floating, draggable "Kind filter" widget on the Application resource tree view, with a collapse toggle. Position and collapsed state are remembered per ArgoCD instance.
- Kind filter for v1: `All`, `Deployment`, `Service`, `ConfigMap` — keeping each kept resource's children (ReplicaSets, Pods, etc.) visible, including their connector lines.
- Works with any ArgoCD instance you choose — nothing is hardcoded. You opt in per host from the toolbar popup, and Chrome only ever grants the extension access to the hosts you explicitly add.

## Installing (manual, for now)

This extension isn't on the Chrome Web Store yet (see below), so for now it's installed as an "unpacked" extension:

1. Download or clone this repository somewhere on your machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder.
5. Click the extension's icon in the toolbar, and either:
   - click **Enable on this site** while on your ArgoCD instance, or
   - type the host (e.g. `argocd.example.com`) and click **Add**.
6. Chrome will ask you to confirm access to that host — approve it, then open (or reload) an Application's tree view. The "Kind filter" widget should appear.

You only need to grant access once per ArgoCD host. Remove access any time from the same popup.

## Publishing

The author is currently working on getting this extension published to the official Chrome Web Store, so installation won't require Developer mode in the future. Until then, manual/unpacked installation above is the only way to use it.

## Status

Early days — single-select kind filter, three kinds supported, no automated tests yet. See [LLM.md](LLM.md) if you're a contributor (human or AI) looking for the full technical background, the ArgoCD internals this relies on, and known limitations.
