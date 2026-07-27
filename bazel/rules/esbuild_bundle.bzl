"""esbuild_bundle: run esbuild.build on one entry point from a ts_program's
out-build directory.

Design mirrors the npm build's optimize.bundleTask (build/lib/optimize.ts):
  * one bundle per entry point,
  * `bundle: true`, `packages: 'external'`, `platform: 'neutral'`,
    `format: 'esm'`, `sourcemap: 'external'`, `target: ES2024`.

Outputs:
  * <out_name>.js
  * <out_name>.js.map
  * <out_name>.meta.json  -- esbuild metafile (the input closure the differ
                             reads to compare against npm's captured metafile)

The vscode-specific plugins (contents-mapper, external-override) aren't
reproduced yet; their effect is on file CONTENTS, not on which files are
pulled into the bundle, so parity at input-closure level still holds.
"""

def _esbuild_bundle_impl(ctx):
    # Bundles emit a variable number of files: always the entry .js + .js.map,
    # optionally an assortment of media assets (svg / ttf / png / etc. -- the
    # workbench and sessions bundles produce ~18 each). We declare a single
    # output directory rather than enumerating; downstream targets pick out
    # specific files by name.
    out_dir = ctx.actions.declare_directory(ctx.attr.name)
    metafile = ctx.actions.declare_file(ctx.attr.name + ".meta.json")

    # The `//:core` target (a ts_program) outputs one directory; find it.
    dep_files = []
    src_dir = None
    for d in ctx.attr.deps:
        for f in d[DefaultInfo].files.to_list():
            dep_files.append(f)
            if f.is_directory and f.basename == ctx.attr.src_dir_name:
                src_dir = f
    if src_dir == None:
        fail("no dep produced a directory named %s" % ctx.attr.src_dir_name)

    # When absWorkingDir is set, esbuild expects entryPoints and outdir to
    # be relative to it (or absolute). We anchor absWorkingDir at src_dir's
    # parent (bazel-bin), so entry / outdir are relative to that. Result:
    # bundle comments read "out-build/foo.js" -- the exact form the npm build
    # produces because its process.cwd is the repo root and out-build sits
    # directly under it.
    working_dir = src_dir.dirname  # e.g. bazel-out/k8-fastbuild/bin
    entry_path = src_dir.basename + "/" + ctx.attr.entry  # "out-build/main.js"
    # esbuild's outdir relative to absWorkingDir. out_dir.short_path is the
    # dir's path relative to bazel-bin, which is exactly working_dir.
    outdir_path = out_dir.short_path

    # esbuild package tree needs to be discoverable by node's module resolver;
    # createRequire in the wrapper is anchored at its package.json.
    esbuild_files = ctx.files._esbuild
    esbuild_pkg_json = None
    for f in esbuild_files:
        if f.path.endswith("node_modules/esbuild/package.json"):
            esbuild_pkg_json = f
            break
    if esbuild_pkg_json == None:
        fail("_esbuild filegroup missing node_modules/esbuild/package.json")
    esbuild_dir = esbuild_pkg_json.dirname

    # minimist gets inlined by the external-override plugin (matches npm's
    # build/lib/optimize.ts). Passed as a path string; the wrapper turns it
    # into an onResolve hook.
    minimist_files = ctx.files._minimist
    minimist_index = None
    for f in minimist_files:
        if f.path.endswith("node_modules/minimist/index.js"):
            minimist_index = f
            break
    if minimist_index == None:
        fail("_minimist filegroup missing node_modules/minimist/index.js")

    # tslib runtime, inlined into the bundle banner (matches npm's build).
    tslib_files = ctx.files._tslib
    tslib_es6 = None
    for f in tslib_files:
        if f.path.endswith("node_modules/tslib/tslib.es6.js"):
            tslib_es6 = f
            break
    if tslib_es6 == None:
        fail("_tslib filegroup missing node_modules/tslib/tslib.es6.js")

    config = struct(
        entryPoints = [struct(_in = entry_path, out = ctx.attr.out_name)],
        bundle = True,
        packages = "external",
        platform = "neutral",
        format = "esm",
        sourcemap = "external",
        target = ["ES2024"],
        loader = struct(
            _ttf = "file",
            _svg = "file",
            _png = "file",
            _sh = "file",
        ),
        assetNames = "media/[name]",
        outdir = outdir_path,
        # esbuild embeds paths relative to `absWorkingDir` (or CWD by
        # default) in bundle comments (e.g. `// out-build/foo.js`). Bazel's
        # sandbox CWD is the execroot, which would make those comments read
        # `../../../execroot/_main/bazel-out/.../out-build/foo.js` -- a
        # cosmetic ~78KB diff against the npm bundle. Anchoring at the
        # directory containing out-build gives us `out-build/foo.js`, same
        # as npm.
        absWorkingDir = working_dir,
        __esbuildDir = esbuild_dir,
        __metafileOut = metafile.path,
        __minimistPath = minimist_index.path,
        __removeTsBoilerplate = not ctx.attr.skip_ts_boilerplate_removal,
        __tslibPath = tslib_es6.path,
    )

    # esbuild's BuildOptions have keys like "in", ".ttf" that Starlark structs
    # can't hold as-is. Serialize with our sentinel-prefixed keys, then fix up
    # via string replace before writing to disk. Simpler than passing 20 args
    # positionally through a shell.
    config_json = json.encode(config)
    config_json = config_json.replace('"_in":', '"in":')
    config_json = config_json.replace('"_ttf":', '".ttf":')
    config_json = config_json.replace('"_svg":', '".svg":')
    config_json = config_json.replace('"_png":', '".png":')
    config_json = config_json.replace('"_sh":', '".sh":')

    config_file = ctx.actions.declare_file(ctx.attr.name + ".esbuild.json")
    ctx.actions.write(config_file, config_json)

    args = ctx.actions.args()
    args.add(ctx.file._runner.path)
    args.add(config_file.path)

    ctx.actions.run(
        outputs = [out_dir, metafile],
        inputs = (dep_files + esbuild_files + minimist_files + tslib_files +
                  [ctx.file._runner, config_file]),
        executable = "node",
        arguments = [args],
        mnemonic = "EsbuildBundle",
        progress_message = "EsbuildBundle %{label}",
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out_dir, metafile]))]

def bundle_target_name(entry):
    """Sanitize an entry-point path into a valid Bazel target name.

    E.g. `vs/editor/common/services/editorWebWorkerMain` ->
         `bundle_vs__editor__common__services__editorWebWorkerMain`.
    """
    return "bundle_" + entry.replace("/", "__").replace(".", "_").replace("-", "_")

esbuild_bundle = rule(
    implementation = _esbuild_bundle_impl,
    attrs = {
        "entry": attr.string(
            mandatory = True,
            doc = "Path to entry .js RELATIVE to the src dep's output " +
                  "directory (e.g. 'main.js', 'vs/code/electron-main/main.js').",
        ),
        "out_name": attr.string(
            mandatory = True,
            doc = "Output basename (without extension). Matches esbuild's " +
                  "`entryPoints[].out` -- same identity as the npm side's " +
                  "target name in the CanonicalModel.",
        ),
        "deps": attr.label_list(
            mandatory = True,
            doc = "Typically the //:core ts_program target -- its output " +
                  "directory is what the bundle reads inputs from.",
        ),
        "src_dir_name": attr.string(default = "out-build"),
        "skip_ts_boilerplate_removal": attr.bool(
            default = False,
            doc = "Mirror of build/lib/optimize.ts's `skipTSBoilerplateRemoval` " +
                  "callback. Set to True for the two workbench sub-bundles " +
                  "that re-emit shared boilerplate.",
        ),
        "_runner": attr.label(
            default = "//bazel/tools:run_esbuild.mjs",
            allow_single_file = True,
        ),
        "_esbuild": attr.label(default = "//:esbuild_package"),
        "_minimist": attr.label(default = "//:minimist_package"),
        "_tslib": attr.label(default = "//:tslib_package"),
    },
)
