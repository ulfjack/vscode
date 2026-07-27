// Wrapper the ts_program rule invokes. Two steps in ONE action so the
// downstream esbuild_bundle sees ONE unified out-build/ directory:
//
//   1. Run tsc as configured (--project, --outDir, --sourceMap, ...).
//   2. Copy non-TS assets (hand-written .js / .css / images / snapshots /
//      .json etc.) from src/ into --outDir, mirroring gulp's
//      `gulp.src('src/**').pipe(gulp.dest('out-build'))` step.
//
// Splitting into two Bazel rules doesn't work: two rules can't own the same
// declared directory, and esbuild resolves imports off the filesystem tree
// so partial input dirs make it fail on any hand-written .js.
//
// Args:
//   node run_ts_program.mjs <tsc.js> <src_root> <out_dir> [--project ...] [--sourceMap] ...
//
// Everything after src_root and out_dir is forwarded to tsc verbatim.

import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, copyFileSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [tscJs, srcRoot, outDir, nlsMode, ...tscArgs] = process.argv.slice(2);
if (!tscJs || !srcRoot || !outDir || !nlsMode) {
	throw new Error(
		'usage: run_ts_program.mjs <tsc.js> <src_root> <out_dir> ' +
		'<none|patch> [tsc args...]');
}

// Step 1: run tsc.
const tsc = spawnSync(
	process.execPath,
	['--max-old-space-size=8192', tscJs, '--outDir', outDir, ...tscArgs],
	{ stdio: 'inherit' },
);
if (tsc.status !== 0) {
	process.exit(tsc.status ?? 1);
}

// Step 2: copy non-TS files under src_root to out_dir. Anything tsc already
// emitted (.js / .js.map / .d.ts derived from .ts) is left untouched -- we
// only copy the source-tree files that never go through the compiler.
//
// Skip .ts / .d.ts (compiled or type-only), .tsbuildinfo (tsc's incremental
// state, if any). Everything else -- .js hand-writes, .css, .json, images,
// snapshots, .md -- gets copied verbatim to mirror the npm build's asset
// step.
const SKIP_EXTS = new Set(['.ts', '.tsbuildinfo']);
function shouldSkip(name) {
	const e = path.extname(name);
	if (SKIP_EXTS.has(e)) return true;
	if (name.endsWith('.d.ts')) return true;
	return false;
}

// Bazel sandboxes each input file as a symlink pointing into the real repo,
// so Dirent.isFile()/isDirectory() return false for staged entries. Use
// statSync (which follows the link) to get the underlying kind.
let copied = 0;
function walk(rel) {
	const abs = path.join(srcRoot, rel);
	let entries;
	try {
		entries = readdirSync(abs);
	} catch {
		return;
	}
	for (const name of entries) {
		const childRel = rel ? path.join(rel, name) : name;
		const abs_child = path.join(abs, name);
		let st;
		try { st = statSync(abs_child); } catch { continue; }
		if (st.isDirectory()) {
			walk(childRel);
		} else if (st.isFile() && !shouldSkip(name)) {
			const dest = path.join(outDir, childRel);
			mkdirSync(path.dirname(dest), { recursive: true });
			copyFileSync(abs_child, dest);
			copied++;
		}
	}
}
walk('');
if (process.env.CMAKE2BAZEL_VERBOSE) {
	console.error(`[run_ts_program] copied ${copied} non-TS assets from ${srcRoot} to ${outDir}`);
}

// Step 3 (optional): NLS transform. Matches build/lib/compilation.ts:88
// `util.$if(build, nls.nls(...))` -- when build=true, every .js from the
// compile pipeline gets its localize()/localize2() calls replaced with
// indexed forms. Byte parity of the bundled output requires this pass;
// input-closure parity does not.
if (nlsMode === 'patch') {
	const wrapperDir = path.dirname(fileURLToPath(import.meta.url));
	const driver = path.join(wrapperDir, 'nls_transform.mjs');
	// Anchor at the tsc.js path -- its node_modules/typescript sibling has
	// what the transform's createRequire needs (typescript + source-map).
	const anchor = path.resolve(path.dirname(tscJs), 'package.json');
	const nls = spawnSync(
		process.execPath, [driver, anchor, outDir, srcRoot],
		{ stdio: 'inherit' },
	);
	if (nls.status !== 0) {
		process.exit(nls.status ?? 1);
	}
}
