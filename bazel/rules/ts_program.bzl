"""ts_program: run tsc on one tsconfig, emit a single output directory.

This is the Bazel side of the parity diff against gulp-tsb's compile-build.
Design choices, aimed at MATCHING the npm build's output surface (not at
idiomatic Bazel):

  * One action per rule invocation, running `tsc --project <tsconfig>` -- the
    same whole-program compile TypeScript exposes natively. gulp-tsb's per-file
    getEmitOutput loop uses the same emitter under the hood, so bytes should
    match modulo emit-mode differences.
  * Output is one `declare_directory`, not ~21k individually-declared files.
    We're diffing at the target-set level; per-file output declarations are a
    future refinement if we want per-file caching / actions.
  * Node comes from the host PATH via use_default_shell_env=True. Avoiding
    rules_nodejs keeps the module dep graph empty; the sandbox already has
    node installed for the npm-side runs.

Attrs:
  srcs:           .ts / .d.ts files that the tsconfig references. Broad glob
                  is fine -- tsc respects the tsconfig's own include/exclude.
  tsconfig:       the tsconfig.json to drive the compile.
  out_dir:        name of the emitted directory (relative to bazel-bin).
  typescript:    filegroup for node_modules/typescript so tsc.js and its
                  dependencies are hermetic inputs of the action.
"""

def _ts_program_impl(ctx):
    out_dir = ctx.actions.declare_directory(ctx.attr.out_dir)

    ts_files = ctx.files.typescript
    # tsc.js is the CLI entry. It's inside the typescript filegroup; find it
    # so we can pass its exec path to `node`.
    tsc_js = None
    for f in ts_files:
        if f.path.endswith("node_modules/typescript/lib/tsc.js"):
            tsc_js = f
            break
    if tsc_js == None:
        fail("typescript filegroup does not include node_modules/typescript/lib/tsc.js")

    # Wrapper: runs tsc then copies non-TS source files from src_root into
    # the outDir, matching gulp's `gulp.src('src/**').pipe(gulp.dest('...'))`
    # step. Downstream esbuild_bundle rules need those hand-written .js /
    # .css / etc. present in the same tree they read imports from.
    args = ctx.actions.args()
    args.add(ctx.file._wrapper.path)
    args.add(tsc_js.path)
    args.add(ctx.attr.src_root)
    args.add(out_dir.path)
    args.add("patch" if ctx.attr.nls == "patch" else "none")
    args.add("--project", ctx.file.tsconfig.path)
    # gulp-tsb overrides these regardless of tsconfig (see
    # build/lib/compilation.ts:38 -- `options.sourceMap = true`). Passing them
    # explicitly on the CLI lines Bazel's tsc output up with the npm build.
    args.add("--sourceMap")

    inputs = (ctx.files.srcs + [ctx.file.tsconfig] + ts_files +
              ctx.files.type_deps + [ctx.file._wrapper])
    if ctx.attr.nls == "patch":
        inputs = inputs + [ctx.file._nls_transform] + ctx.files._source_map
    ctx.actions.run(
        outputs = [out_dir],
        inputs = inputs,
        executable = "node",
        arguments = [args],
        mnemonic = "TsProgram",
        progress_message = "TsProgram %{label}",
        # Node isn't a Bazel toolchain here; pull it from the host env.
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([out_dir]))]

ts_program = rule(
    implementation = _ts_program_impl,
    attrs = {
        "srcs": attr.label_list(
            allow_files = True,
            doc = "All files under src_root that the compile+copy step needs " +
                  "-- .ts / .d.ts (input to tsc), and any non-TS files " +
                  "downstream bundling relies on (hand-written .js, .css, " +
                  ".json, snapshots, static assets).",
        ),
        "tsconfig": attr.label(allow_single_file = True, mandatory = True),
        "typescript": attr.label(mandatory = True),
        "type_deps": attr.label_list(
            allow_files = True,
            doc = "Extra @types packages the tsconfig's `types` option " +
                  "references (e.g. node_modules/@types/mocha).",
        ),
        "out_dir": attr.string(default = "out-build"),
        "src_root": attr.string(
            default = "src",
            doc = "Repo-relative source directory. Non-TS files under this " +
                  "root are copied verbatim into out_dir alongside tsc's " +
                  "emitted output -- matches gulp's asset copy.",
        ),
        "_wrapper": attr.label(
            default = "//bazel/tools:run_ts_program.mjs",
            allow_single_file = True,
        ),
        "nls": attr.string(
            default = "patch",
            values = ["none", "patch"],
            doc = "Whether to run the NLS index-replacement transform after " +
                  "tsc. `patch` mirrors gulp's build=true path " +
                  "(build/lib/compilation.ts:88); `none` skips it. Needed for " +
                  "byte parity of downstream bundles.",
        ),
        "_nls_transform": attr.label(
            default = "//bazel/tools:nls_transform.mjs",
            allow_single_file = True,
        ),
        "_source_map": attr.label(default = "//:source_map_package"),
    },
)
