# LibraSoft Downloads Mirror

This repository exists **only to host LibraSoft's public installer files over HTTPS**.

The files are mirrored from the legacy server (`http://librasoft.us/ver/…`) — which
serves over plain HTTP and therefore triggers browser "insecure download" warnings —
to this repo's **Releases**, which GitHub serves over HTTPS via its CDN, for free.

## How it works

A scheduled GitHub Action (`.github/workflows/sync.yml`, daily + manual) runs
[`sync.mjs`](./sync.mjs), which:

1. Reads the legacy `downloads.html` to discover the current file list.
2. Sends a `HEAD` to each file and compares size + `Last-Modified` against
   [`manifest.json`](./manifest.json) to detect changes.
3. Re-downloads and re-uploads **only changed files** to the `files` Release.
4. POSTs the resulting HTTPS URLs to the main site's Convex backend, which the
   public downloads page reads from.

The current Release asset keeps serving until a new upload finishes, and a file
that fails to fetch falls back to its last-good mirrored URL — so a transient
outage on the legacy server never drops a working download link.

## Why public?

GitHub Release assets on a private repo require authentication to download.
These installers are already publicly downloadable from the legacy server, so
hosting them publicly here exposes nothing new — it just adds HTTPS. **No
application source code lives here.**

## Required Actions secrets

| Secret | Value |
| --- | --- |
| `CONVEX_SITE_URL` | The production Convex HTTP URL, e.g. `https://<deployment>.convex.site` |
| `DOWNLOADS_SYNC_SECRET` | Shared bearer token; must match the `DOWNLOADS_SYNC_SECRET` Convex env var |

`GITHUB_TOKEN` is provided automatically by Actions.
