#!/usr/bin/env bash
# Launch vscode from Bazel-built code.
#
# vscode's package.json says `"main": "./out/main.js"`. Point that at
# `//:vscode_app`'s output -- a merged directory containing all 23 bundled
# entry points overlaid on tsc's per-file emit + copied source assets +
# nls metadata. Electron then loads our bundled main.js.
#
# `scripts/code.sh` on first run installs Electron and downloads built-in
# extensions via `build/lib/preLaunch.ts`; it also runs `npm run compile`
# if `out/` is missing, so we make out/ exist (via symlink) BEFORE running
# the launcher.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")"/../../.. && pwd)
cd "$ROOT"

echo "[1/3] bazel build //:vscode_app"
bazel build //:vscode_app >/dev/null

if [ -e out ] && [ ! -L out ]; then
	echo "[abort] $ROOT/out exists and is not a symlink -- refusing to overwrite."
	echo "        rename or delete it, then rerun this script."
	exit 1
fi

echo "[2/3] symlink out -> bazel-bin/vscode_app"
rm -f out
ln -s bazel-bin/vscode_app out

echo "[3/3] launch scripts/code.sh (installs Electron + built-in extensions on first run)"
exec scripts/code.sh "$@"
