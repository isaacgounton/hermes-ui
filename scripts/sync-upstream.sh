#!/usr/bin/env bash
#
# sync-upstream.sh
#
# Pull a newer Hermes desktop renderer into hermes-ui.
#
# hermes-ui tracks upstream with a vendor branch:
#   vendor/upstream  pristine snapshots of hermes-agent's apps/desktop/src and
#                    apps/shared/src (plus the few files listed in VENDORED
#                    below), one commit per synced upstream ref, each carrying
#                    an `Upstream-Commit: <sha>` trailer.
#   main             merges vendor/upstream. Our web layer (app/src/web-bridge,
#                    app/src/pwa, the small `hermes-ui:` patches) lives only
#                    here, so a plain `git merge` re-applies it on every sync.
#
# This script adds the next snapshot to vendor/upstream, then merges it into a
# new `sync/<ref>` branch cut from the current HEAD. It never pushes.
#
# Usage:
#   scripts/sync-upstream.sh            # latest vYYYY.M.D release tag
#   scripts/sync-upstream.sh v2026.9.24 # any tag, branch or commit
#
# Exit codes: 0 merged cleanly (or already up to date), 2 merged with
# conflicts left in the working tree for resolution, 1 any other failure.
# Under GitHub Actions it also writes ref/sha/status/branch to $GITHUB_OUTPUT.
#
set -euo pipefail

UPSTREAM_URL="${HERMES_AGENT_URL:-https://github.com/NousResearch/hermes-agent.git}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
CACHE="${HERMES_AGENT_CACHE:-$ROOT/.cache/hermes-agent}"
VENDOR_BRANCH=vendor/upstream

# upstream path -> hermes-ui path. Directories are replaced wholesale, so
# upstream deletions and renames carry over too.
VENDORED=(
  "apps/desktop/src:app/src"
  "apps/shared/src:shared/src"
  # Type-only Electron modules the renderer imports by relative path. The ones
  # that pull in electron/node (machine-profile, window-growth) are local shims.
  "apps/desktop/electron/command-screenshot-types.ts:app/electron/command-screenshot-types.ts"
  "apps/desktop/electron/hud-modifier-types.ts:app/electron/hud-modifier-types.ts"
  "apps/desktop/electron/notification-types.ts:app/electron/notification-types.ts"
  "apps/desktop/electron/pool-limits.ts:app/electron/pool-limits.ts"
  "tests/fixtures/session-resume-active-turn.json:tests/fixtures/session-resume-active-turn.json"
)

output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "$1=$2" >>"$GITHUB_OUTPUT"
  fi
}

cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi

git rev-parse --verify --quiet "$VENDOR_BRANCH" >/dev/null || {
  echo "error: no local $VENDOR_BRANCH branch (git fetch origin $VENDOR_BRANCH:$VENDOR_BRANCH)" >&2
  exit 1
}

# Blob-less, sparse clone: history for tags/trailers, file contents on demand.
if [[ ! -d "$CACHE/.git" ]]; then
  mkdir -p "$(dirname "$CACHE")"
  git clone --quiet --filter=blob:none --no-checkout "$UPSTREAM_URL" "$CACHE"
fi
git -C "$CACHE" fetch --quiet --tags --force origin

REF="${1:-$(git -C "$CACHE" tag -l 'v20*' --sort=-creatordate | head -n 1)}"
SHA="$(git -C "$CACHE" rev-parse --verify "${REF}^{commit}" 2>/dev/null || git -C "$CACHE" rev-parse --verify "origin/${REF}^{commit}")"
CURRENT="$(git log -1 --format='%(trailers:key=Upstream-Commit,valueonly)' "$VENDOR_BRANCH" | tr -d '[:space:]')"
output ref "$REF"
output sha "$SHA"

if [[ "$CURRENT" == "$SHA" ]]; then
  echo "Already at $REF ($SHA)."
  output status up-to-date
  exit 0
fi

if [[ -n "$CURRENT" ]] && git -C "$CACHE" merge-base --is-ancestor "$SHA" "$CURRENT" 2>/dev/null; then
  echo "error: $REF ($SHA) is older than the vendored $CURRENT; refusing to go backwards" >&2
  exit 1
fi

# Export the vendored paths of $SHA into a scratch tree laid out like hermes-ui.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/upstream" "$WORK/tree"
upstream_paths=()
for entry in "${VENDORED[@]}"; do
  upstream_paths+=("${entry%%:*}")
done
git -C "$CACHE" archive "$SHA" -- "${upstream_paths[@]}" | tar -x -C "$WORK/upstream"
for entry in "${VENDORED[@]}"; do
  src="$WORK/upstream/${entry%%:*}"
  dst="$WORK/tree/${entry#*:}"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
done

# Build the vendor commit with plumbing: start from the previous snapshot, swap
# the vendored paths for the new export. The working tree is never touched.
export GIT_INDEX_FILE="$WORK/index"
git read-tree "$VENDOR_BRANCH"
for entry in "${VENDORED[@]}"; do
  git rm -r -q --cached --ignore-unmatch -- "${entry#*:}"
done
(cd "$WORK/tree" && GIT_DIR="$ROOT/.git" git --work-tree="$WORK/tree" add -f -- .)
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

VENDOR_COMMIT="$(git commit-tree "$TREE" -p "$VENDOR_BRANCH" -m "vendor: hermes-agent $REF

Upstream-Commit: $SHA")"
git update-ref "refs/heads/$VENDOR_BRANCH" "$VENDOR_COMMIT"
echo "$VENDOR_BRANCH -> $(git rev-parse --short "$VENDOR_COMMIT") (hermes-agent $REF, ${SHA:0:12})"

BRANCH="sync/${REF//[^A-Za-z0-9._-]/-}"
git switch --quiet -c "$BRANCH"
output branch "$BRANCH"

# Dependency drift is reported, not applied: app/package.json keeps only the
# renderer's deps (Electron-main ones are dropped) and its own web additions.
echo
echo "Upstream renderer dependencies that differ from app/package.json:"
git -C "$CACHE" show "$SHA:apps/desktop/package.json" >"$WORK/upstream-package.json"
node -e '
  const up = require(process.argv[1]).dependencies, ours = require(process.argv[2]).dependencies
  const electronOnly = new Set(["dbus-native","electron-updater","https-proxy-agent","node-pty","proxy-from-env","simple-git","yaml","@streamdown/math"])
  const drift = Object.entries(up).filter(([n, v]) => !electronOnly.has(n) && ours[n] !== v)
  console.log(drift.length ? drift.map(([n, v]) => `  ${n}: ${ours[n] ?? "(missing)"} -> ${v}`).join("\n") : "  (none)")
' "$WORK/upstream-package.json" "$ROOT/app/package.json" | tee "$WORK/drift.txt"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "drift<<EOF"; cat "$WORK/drift.txt"; echo "EOF"; } >>"$GITHUB_OUTPUT"
fi

echo
if git merge --no-ff --no-edit -m "Merge hermes-agent $REF into hermes-ui" "$VENDOR_BRANCH"; then
  echo "Merged cleanly on $BRANCH. Next: cd app && bun install && bun run build && bunx vitest run --project ui"
  output status clean
  exit 0
fi

echo
echo "Conflicts on $BRANCH (resolve, keep the hermes-ui: patches minimal, then commit):"
git diff --name-only --diff-filter=U | sed 's/^/  /' | tee "$WORK/conflicts.txt"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "conflicts<<EOF"; cat "$WORK/conflicts.txt"; echo "EOF"; } >>"$GITHUB_OUTPUT"
fi
output status conflicts
exit 2
