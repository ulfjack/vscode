"""vscode_app: assemble a runnable vscode application directory.

Takes the //:core output (tsc emit + copied source assets + nls metadata)
plus the 23 esbuild_bundle outputs (per-entrypoint .js/.js.map/.css/media)
and merges them into one out-vscode-shaped tree:

    bazel-bin/<name>/
      main.js            <- bundled Electron main entry
      cli.js
      bootstrap-fork.js
      vs/workbench/workbench.desktop.main.js
      vs/workbench/workbench.desktop.main.css
      media/*.svg *.png *.ttf
      nls.messages.json  nls.keys.json  nls.metadata.json  nls.messages.js
      ...

Runs as ONE action so downstream targets (launcher script, packaged app)
get a single output directory, not N interleaved TreeArtifacts.
"""

def _vscode_app_impl(ctx):
    out_dir = ctx.actions.declare_directory(ctx.attr.name)

    # Locate the core out-build directory among the core target's files.
    core_dir = None
    for f in ctx.files.core:
        if f.is_directory and f.basename == ctx.attr.core_dir_name:
            core_dir = f
            break
    if core_dir == None:
        fail("core dep did not produce a directory named %s" %
             ctx.attr.core_dir_name)

    # Bundle deps each produce a directory; collect them.
    bundle_dirs = []
    for b in ctx.attr.bundles:
        for f in b[DefaultInfo].files.to_list():
            if f.is_directory:
                bundle_dirs.append(f)

    # Bundle-dir paths change per configuration; write them to a JSON file
    # the assembler reads. Avoids the shell-escaping headache of passing
    # many paths on argv when N grows.
    bundle_dirs_json = ctx.actions.declare_file(ctx.attr.name + ".bundle_dirs.json")
    ctx.actions.write(
        bundle_dirs_json,
        json.encode([d.path for d in bundle_dirs]),
    )

    args = ctx.actions.args()
    args.add(ctx.file._assembler.path)
    args.add(out_dir.path)
    args.add(core_dir.path)
    args.add(bundle_dirs_json.path)
    args.add(ctx.file.product_json.path)
    args.add(ctx.file.package_json.path)

    ctx.actions.run(
        outputs = [out_dir],
        inputs = [
            core_dir,
            bundle_dirs_json,
            ctx.file._assembler,
            ctx.file.product_json,
            ctx.file.package_json,
        ] + bundle_dirs,
        executable = "node",
        arguments = [args],
        mnemonic = "VscodeAssemble",
        progress_message = "VscodeAssemble %{label}",
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out_dir]))]

vscode_app = rule(
    implementation = _vscode_app_impl,
    attrs = {
        "core": attr.label(
            mandatory = True,
            doc = "The //:core ts_program target -- provides tsc emit + " +
                  "copied source assets + nls metadata files.",
        ),
        "bundles": attr.label_list(
            mandatory = True,
            doc = "The 23 esbuild_bundle targets. Their outputs overlay " +
                  "the core dir; bundled entry .js beat their unbundled " +
                  "counterparts at the same path.",
        ),
        "core_dir_name": attr.string(default = "out-build"),
        "product_json": attr.label(
            mandatory = True,
            allow_single_file = True,
            doc = "Repo's product.json -- copied verbatim into the app root.",
        ),
        "package_json": attr.label(
            mandatory = True,
            allow_single_file = True,
            doc = "Repo's package.json -- copied with `main` rewritten to " +
                  "`./main.js` (bundled main sits at root, not under out/).",
        ),
        "_assembler": attr.label(
            default = "//cmake2bazel/bazel/tools:assemble_vscode_dir.mjs",
            allow_single_file = True,
        ),
    },
)
