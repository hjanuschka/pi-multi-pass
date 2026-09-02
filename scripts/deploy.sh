#!/usr/bin/env bash
#
# Copy this working tree's extension over the installed one.
#
# pi loads ~/.pi/agent/npm/node_modules/pi-multi-pass/extensions/multi-sub.ts,
# which is a FILE COPY of the upstream npm package, not a symlink to this repo.
# A commit here changes nothing until it is copied across. That gap bit three
# times in one session: tests green, config correct, behaviour unchanged,
# because the running pi was still on the old file.
#
#   bash scripts/deploy.sh          copy, after backing the old file up
#   bash scripts/deploy.sh --check  report drift only, exit 1 if they differ
#
# `pi package update` (or npm) will overwrite the deployed copy with upstream
# and silently drop every local fix. Re-run this afterwards.
set -euo pipefail

repo_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extensions/multi-sub.ts"
installed_file="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-multi-pass/extensions/multi-sub.ts"

[ -f "$repo_file" ] || { echo "missing repo file: $repo_file" >&2; exit 1; }

if [ ! -f "$installed_file" ]; then
  echo "multi-pass is not installed at $installed_file" >&2
  echo "nothing to deploy to - install the package first" >&2
  exit 1
fi

if cmp -s "$repo_file" "$installed_file"; then
  echo "up to date: installed == repo"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  echo "DRIFT: installed differs from repo" >&2
  diff <(wc -l < "$installed_file") <(wc -l < "$repo_file") >/dev/null || true
  echo "  installed: $(wc -l < "$installed_file" | tr -d ' ') lines  $installed_file" >&2
  echo "  repo:      $(wc -l < "$repo_file" | tr -d ' ') lines  $repo_file" >&2
  echo "  run: bash scripts/deploy.sh" >&2
  exit 1
fi

backup="$installed_file.bak-$(date +%Y%m%d-%H%M%S)"
cp "$installed_file" "$backup"
cp "$repo_file" "$installed_file"
echo "deployed  $repo_file"
echo "       -> $installed_file"
echo "backup    $backup"
echo
echo "Already-running pi sessions keep the old copy; extensions load per process."
