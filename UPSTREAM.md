# Provenance and upstream sync

`app/src` and `shared/src` are the Hermes desktop renderer from the Hermes Agent monorepo (MIT, Copyright (c) 2025 Nous Research; see `LICENSE`): upstream `apps/desktop/src` and `apps/shared/src`.
hermes-ui adds a thin web layer on top so the same renderer runs in a browser, served same-origin by the gateway.

## How tracking works

Upstream is tracked with a vendor branch, so every sync is an ordinary `git merge`:

- **`vendor/upstream`** holds pristine snapshots of the vendored upstream paths (listed in `VENDORED` in `scripts/sync-upstream.sh`), one commit per synced upstream ref.
  Each commit carries an `Upstream-Commit: <sha>` trailer, which is the sync watermark.
  Never edit this branch by hand.
- **`main`** merges `vendor/upstream`. All web-specific changes live only on `main`, so git re-applies them on every merge and only real overlaps conflict.

To sync:

```sh
scripts/sync-upstream.sh              # newest vYYYY.M.D release tag
scripts/sync-upstream.sh v2026.10.1   # or any tag / branch / commit
```

The script adds the snapshot to `vendor/upstream`, creates `sync/<ref>` from your current branch, merges, and prints any upstream renderer dependency changes to copy into `app/package.json`.
Then run `cd app && bun install && bun run build && bunx vitest run --project ui`.
Prefer release tags over `main`, and do not sync past the gateway version you run, since the renderer calls gateway RPCs that older gateways lack.

`.github/workflows/upstream-sync.yml` runs the same script weekly (and on demand from the Actions tab) and opens a PR for each new release.
A clean merge that builds and passes the UI tests becomes a ready-for-review PR. Anything else becomes a draft PR listing the conflicted files.

**Current watermark:** `git log -1 --format=%B vendor/upstream`, at the time of writing hermes-agent `97bacbbce514` (v2026.9.24 release line, Hermes 0.21.5).

## The local web layer

Keep this layer small and keep it here. Every line outside these files is a future merge conflict.

**Web-only modules (no upstream counterpart):**

- `app/src/web-bridge/`: the browser implementation of Electron's `window.hermesDesktop` preload API.
  - `bridge.ts` implements the bridge. `WebBridge` is typed against the full upstream interface, so a new required bridge member breaks `tsc` instead of crashing at runtime.
  - Saved gateways (`gateways.ts`) are exposed as upstream's v2 connection registry (`connections`, `getConnectionFor`, `getGatewayWsUrlFor`, per-request `connectionId`). Upstream's own source switcher and Settings → Gateways manage them.
  - Electron-only surfaces (local PTY terminal, Hermes Cloud sign-in, SSH, quick entry, pop-out windows, pool limits) are honest stubs.
- `app/src/lib/web-platform.ts`: `isWebPlatform()` (an explicit `window.__HERMES_WEB__` flag set by `web-bridge/install.ts`) and `supports*()` capability predicates.
- `app/src/pwa/`: the installable PWA, with a service worker that never caches the token-injected `index.html`.
- `app/src/store/sidebar-cache.ts`, `app/src/lib/query-persist.ts`, `app/src/store/shell-snapshot.ts`: per-gateway caches that paint the shell instantly on a cold load.
- `app/electron/machine-profile.ts` and `app/electron/window-growth.ts`: type-only shims for upstream modules that import electron/node.

**Small patches to upstream files**, each marked with a `hermes-ui:` comment:

- `main.tsx`: installs the bridge first, and boots the PWA, shell snapshot and caches.
- `app/chat/hooks/use-composer-actions.ts` and `store/composer.ts`: browser-local files (picker, drop, paste) carry their bytes as `bytesDataUrl` and upload at submit. This includes a `crypto.randomUUID` fallback for plain-http origins.
- Hiding what a browser cannot do:
  - `about-settings`: client self-update and uninstall
  - `appearance-settings`: window zoom and the theme marketplace
  - `sessions-settings`: the default project folder picker
  - `gateway-settings`: Local, Cloud and SSH modes, the OS keychain and on-disk logs. It also explains cross-origin URLs.
  - `command-palette`: the marketplace
  - `use-statusbar-items`: the client update pill and the terminal toggle
  - `floating-pet`: the OS overlay window
  - `boot-failure-overlay` and `error-boundary`: on-disk logs
- `components/onboarding/index.tsx`: onboarding steps aside on a boot failure so gateway recovery stays reachable.
- `components/gateway-connecting-overlay.tsx`: no full-screen "connecting" modal over a cached shell.
- `lib/markdown-code.ts` and `lib/markdown-preprocess.ts`: explicitly named code fences (```` ```text ````, ```` ```diff ````) are never demoted to prose, including mid-stream.
- `app/contrib/controller.tsx` and `app/shell/statusbar-controls.tsx`: dynamic viewport height and safe-area insets for phones.
- `themes/context.tsx`: refreshes the shell snapshot when the theme changes.
- `app/session/hooks/use-session-list-actions.ts`: writes the sidebar cache after each refresh.
- `i18n/{types,en,ja,zh,zh-hant}.ts`: the cross-origin gateway strings.

**Build and tooling (`app/`):**

- `package.json` holds upstream's renderer dependencies, minus Electron-main ones, plus `vite-plugin-pwa` and `http-proxy-3`.
  - `@babel/core` is pinned to 7 because `workbox-build` needs Babel 7.
  - `overrides` pins `@assistant-ui/tap`, `@assistant-ui/store`, `assistant-stream`, `assistant-cloud` and `zustand` to upstream's lockfile versions. Newer releases break the thread view with "getSnapshot should be cached".
- `vite.config.ts` is upstream's renderer build (React Compiler, chunk groups, emoji assets, `driver.js` aliases) plus the dev gateway proxy, the PWA plugin and the cache-buster define.
- `vitest.config.ts` keeps upstream's `ui` project. It excludes `relay-deliver-budget.test.ts`, which reads Python sources from the monorepo root.

## Decisions

- **Billing** is kept. It runs over the gateway RPC, so it works in a browser, and excluding it would be a permanent diff.
- **Multi-gateway** is upstream's connection registry. The old custom gateway switcher, gateway manager and soft-switch were retired in favour of it.
- **Serving:** `hermes serve` is a headless backend since Hermes 2026.9, so `scripts/serve-on-gateway.sh` uses `hermes dashboard` with `HERMES_WEB_DIST`.

## History

- 2026-07-11: extracted at upstream `56a8e81`.
- 2026-07-20: partial sync to `f0aae14`.
- 2026-08-19: Bot Mode ported from `v2026.8.18`.
- 2026-10-07: full re-sync to `97bacbbce514` and introduction of the vendor branch.
  The diff from `f0aae14` was about 4,400 upstream commits (layout tree engine, plugin system, connection registry, `@assistant-ui` 0.14 and more), so the web layer was re-applied onto a fresh upstream snapshot instead of hand-porting.
