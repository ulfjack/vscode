"""nodegyp_module: build one native node module's `.node` binary via node-gyp.

Mirrors what vscode's `npm ci` postinstall (build/npm/postinstall.ts) does for
`@vscode/sqlite3`, `@vscode/spdlog`, `node-pty`, and friends: runs
`node-gyp rebuild` inside a writable copy of the module's source tree,
pointed at Electron's headers so the resulting binary is loadable by Electron
(its V8/blink surface extends stock node's, so plain node-headers builds
crash at load time).

Attrs:
  srcs:            The module's source files (glob over node_modules/<name>/**
                   from the top-level tree npm ci populated). binding.gyp,
                   src/*.cc, deps/, package.json all need to be here.
  module_root:     The `node_modules/<name>` prefix that srcs paths start
                   with -- used to strip Bazel-added prefixes when staging.
  binding:         Path RELATIVE to <module_root> of the .node artifact
                   node-gyp writes (e.g. `build/Release/vscode-sqlite3.node`).
  headers:         Filegroup of Electron's node headers
                   (@electron_headers//:all).
  electron_target: The Electron version to build against (matches the tag
                   used to publish headers, e.g. "42.2.0").
"""

def _nodegyp_module_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.name + ".node")

    args = ctx.actions.args()
    args.add(ctx.file._runner.path)
    args.add(ctx.attr.module_root)
    args.add(ctx.attr.binding)
    args.add(ctx.attr.electron_target)
    args.add(out.path)
    # After the fixed args, pass every module src file + every header input
    # as positional args. The wrapper stages them into a fresh tempdir keyed
    # on the module_root prefix so node-gyp finds binding.gyp at a stable
    # location.
    args.add("--")
    args.add_all([f.path for f in ctx.files.srcs])
    args.add("--headers--")
    args.add_all([f.path for f in ctx.files.headers])

    ctx.actions.run(
        outputs = [out],
        inputs = ctx.files.srcs + ctx.files.headers + [ctx.file._runner],
        executable = "node",
        arguments = [args],
        mnemonic = "NodeGyp",
        progress_message = "NodeGyp %{label}",
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out]))]

nodegyp_module = rule(
    implementation = _nodegyp_module_impl,
    attrs = {
        "srcs": attr.label_list(
            allow_files = True,
            mandatory = True,
            doc = "The module's own source tree PLUS any of its runtime " +
                  "dependencies whose `.js` build helpers the gypfile invokes " +
                  "(e.g. sqlite3's binding.gyp shells out to `deps/extract.js` " +
                  "which requires 'tar' and 'node-addon-api'). Files under " +
                  "module_root are staged at the tree root; anything else " +
                  "(like node_modules/tar/**) keeps its layout so require() " +
                  "walks find it.",
        ),
        "module_root": attr.string(
            mandatory = True,
            doc = "The path prefix under which srcs live, e.g. " +
                  "'node_modules/@vscode/sqlite3'. The wrapper strips this " +
                  "to lay files out at the staged root where node-gyp " +
                  "expects them.",
        ),
        "binding": attr.string(
            mandatory = True,
            doc = "Relative path of the .node artifact node-gyp produces.",
        ),
        "headers": attr.label(
            mandatory = True,
            doc = "The Electron node headers tree (@electron_headers//:all).",
        ),
        "electron_target": attr.string(
            mandatory = True,
        ),
        "_runner": attr.label(
            default = "//cmake2bazel/bazel/tools:run_nodegyp.mjs",
            allow_single_file = True,
        ),
    },
)
