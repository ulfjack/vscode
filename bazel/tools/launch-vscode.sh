#!/usr/bin/env bash
# Bazel sh_binary that boots our Bazel-built vscode: hands the assembled
# app dir to the Electron binary downloaded via http_archive.
#
# `bazel run //:vscode` places both the app dir and the Electron distribution
# under runfiles; we discover them through RUNFILES_DIR (or the runfiles
# manifest as fallback) rather than fixed paths.
set -euo pipefail

runfiles_root=${RUNFILES_DIR:-}
if [ -z "$runfiles_root" ]; then
	# Bazel 7 lays out runfiles at <binary>.runfiles/ next to the sh_binary
	# wrapper; the wrapper's argv[0] is what we get in BASH_SOURCE.
	runfiles_root="${BASH_SOURCE[0]}.runfiles"
fi

app_dir="$runfiles_root/_main/bazel-out/k8-fastbuild/bin/vscode_app"
if [ ! -d "$app_dir" ]; then
	# Fallback for non-sandboxed layouts: try the workspace-relative path.
	app_dir="$runfiles_root/_main/vscode_app"
fi

electron="$runfiles_root/_main~_repo_rules~electron_linux_x64/electron"
if [ ! -x "$electron" ]; then
	# The extracted archive's binary path can vary; fall back to a search.
	electron=$(find "$runfiles_root" -type f -name electron -executable | head -1)
fi

if [ ! -d "$app_dir" ]; then
	echo "vscode_app dir not found under $runfiles_root" >&2
	exit 1
fi
if [ ! -x "$electron" ]; then
	echo "electron binary not found under $runfiles_root" >&2
	exit 1
fi

# --no-sandbox is a workaround for setuid'd chrome-sandbox not being usable
# in most dev environments (needs root ownership + setuid). Fine for local
# use; a packaged distribution would install chrome-sandbox correctly.
exec "$electron" --no-sandbox "$app_dir" "$@"
