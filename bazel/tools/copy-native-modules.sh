#!/usr/bin/env bash
# After `bazel build //:native_modules`, drop each produced .node file into
# a node_modules tree at the path the module's own JS require()s
# (e.g. <target>/@vscode/sqlite3/build/Release/vscode-sqlite3.node).
#
# The npm-ci step already staged the JS + package.json for each module; only
# the compiled .node was missing. This overlay closes that gap without
# duplicating node_modules into release/.
#
# Usage: copy-native-modules.sh [target_node_modules_dir]
#   Defaults to `node_modules/` (the dev tree). Pass an alternative tree
#   (e.g. `.build/prod/node_modules`) to overlay onto a prod-only install.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")"/../../.. && pwd)
cd "$ROOT"

TARGET=${1:-node_modules}
BIN=$(bazel info bazel-bin)

# (bazel_target_basename, dest under node_modules/)
declare -a MAPPING=(
	"vscode_sqlite3.node          @vscode/sqlite3/build/Release/vscode-sqlite3.node"
	"vscode_spdlog.node           @vscode/spdlog/build/Release/spdlog.node"
	"vscode_policy_watcher.node   @vscode/policy-watcher/build/Release/vscode-policy-watcher.node"
	"vscode_native_watchdog.node  @vscode/native-watchdog/build/Release/watchdog.node"
	"node_pty.node                node-pty/build/Release/pty.node"
	"native_keymap.node           native-keymap/build/Release/keymapping.node"
	"native_is_elevated.node      native-is-elevated/build/Release/iselevated.node"
	"kerberos.node                kerberos/build/Release/kerberos.node"
	"parcel_watcher.node          @parcel/watcher/build/Release/watcher.node"
)

for line in "${MAPPING[@]}"; do
	set -- $line
	src="$BIN/$1"
	dest="$TARGET/$2"
	if [ ! -f "$src" ]; then
		echo "[skip] $src not built (rerun bazel build //:native_modules)"
		continue
	fi
	mkdir -p "$(dirname "$dest")"
	cp -f "$src" "$dest"
	echo "[copy] $dest"
done
