// Wrapper that runs `node-gyp rebuild` inside a staged module tree and copies
// the resulting .node binary out.
//
//   node run_nodegyp.mjs <module_root> <binding> <electron_target> <out.node>
//                        -- <module_src_files>...
//                        --headers-- <header_files>...
//
// The rule sends ALL Bazel-staged files as positional args; we stage them
// into a temp directory keyed on <module_root>: any path that begins with
// `<module_root>/` is stripped of that prefix so binding.gyp / src / deps
// end up at the temp dir's root where node-gyp expects them. Header files
// go into a sibling directory that we pass to node-gyp via --nodedir=.

import { mkdtempSync, mkdirSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const [moduleRoot, binding, electronTarget, outPath, sep1, ...rest] = process.argv.slice(2);
if (!moduleRoot || !binding || !electronTarget || !outPath || sep1 !== '--') {
	throw new Error(
		'usage: run_nodegyp.mjs <module_root> <binding> <target> <out> ' +
		'-- <srcs>... --headers-- <headers>...');
}

const headersMarker = rest.indexOf('--headers--');
if (headersMarker < 0) {
	throw new Error("missing --headers-- separator in argv");
}
const srcFiles = rest.slice(0, headersMarker);
const headerFiles = rest.slice(headersMarker + 1);

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'nodegyp-'));
const moduleDir = path.join(tmpBase, 'mod');
const headersDir = path.join(tmpBase, 'headers');

function stage(files, destRoot, stripPrefix) {
	for (const src of files) {
		let rel = src;
		if (stripPrefix) {
			// Files that start with the module_root prefix -- strip it so
			// binding.gyp / src / etc. land at the staged root.
			if (rel.startsWith(stripPrefix + '/')) {
				rel = rel.slice(stripPrefix.length + 1);
			} else {
				// Bazel may prefix source paths with bazel-out/<cfg>/bin/ or
				// external/... — try finding stripPrefix mid-path.
				const idx = rel.indexOf('/' + stripPrefix + '/');
				if (idx >= 0) {
					rel = rel.slice(idx + stripPrefix.length + 2);
				}
				// If we couldn't strip, keep the path as-is: this is how we
				// support extra node_modules deps (e.g. tar, node-addon-api)
				// -- their `node_modules/<pkg>/**` paths land under staged
				// `node_modules/<pkg>/` where the module's build script's
				// `require('tar')` will find them.
			}
		}
		const dest = path.join(destRoot, rel);
		let st;
		try { st = statSync(src); } catch { continue; }
		if (!st.isFile()) continue;
		mkdirSync(path.dirname(dest), { recursive: true });
		copyFileSync(src, dest);
	}
}

stage(srcFiles, moduleDir, moduleRoot);
// Headers: strip everything up to and including the archive's inner
// `node_headers/` directory (see MODULE.bazel's strip_prefix). If we don't
// know the layout, just stage relative to the shortest common path.
stage(headerFiles, headersDir, null);

// node-gyp expects <nodedir>/common.gypi AND <nodedir>/include/node/*.h.
// Electron's tarball ships common.gypi at include/node/common.gypi (co-
// located with headers). Find where `include/node/` lives, take its
// grandparent as nodedir, and mirror common.gypi/config.gypi up to that
// root so node-gyp's config step resolves them.
function findIncludeParent(root) {
	function walk(dir) {
		let entries;
		try { entries = statSync(dir).isDirectory() ? readdirSync(dir) : []; } catch { return null; }
		for (const name of entries) {
			const p = path.join(dir, name);
			try {
				if (statSync(p).isDirectory()) {
					if (name === 'include' && existsSync(path.join(p, 'node'))) {
						return dir;
					}
					const r = walk(p);
					if (r) return r;
				}
			} catch { /* ok */ }
		}
		return null;
	}
	return walk(root) ?? root;
}
const nodedir = findIncludeParent(headersDir);
for (const g of ['common.gypi', 'config.gypi']) {
	const embedded = path.join(nodedir, 'include', 'node', g);
	const expected = path.join(nodedir, g);
	if (existsSync(embedded) && !existsSync(expected)) {
		copyFileSync(embedded, expected);
	}
}

function runNodeGyp(args) {
	const direct = spawnSync('node-gyp', args, { cwd: moduleDir, stdio: 'inherit' });
	if (direct.status === 0) return 0;
	if (direct.error && direct.error.code === 'ENOENT') {
		return spawnSync('npx', ['--yes', 'node-gyp', ...args],
			{ cwd: moduleDir, stdio: 'inherit' }).status ?? 1;
	}
	return direct.status ?? 1;
}

const status = runNodeGyp([
	'rebuild',
	`--target=${electronTarget}`,
	`--nodedir=${nodedir}`,
	'--arch=x64',
	// --dist-url is only used to DOWNLOAD headers; since we supply --nodedir
	// with a local staged tree, point --dist-url at a nonexistent file so
	// node-gyp treats headers as already installed and doesn't try to fetch.
	'--dist-url=file:///dev/null',
]);
if (status !== 0) {
	process.exit(status);
}

const produced = path.join(moduleDir, binding);
if (!existsSync(produced)) {
	throw new Error(`node-gyp reported success but ${produced} was not produced`);
}
copyFileSync(produced, outPath);
