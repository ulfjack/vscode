// Assemble a vscode-app-ready directory tree from Bazel outputs.
//
//   node assemble_vscode_dir.mjs <output_dir> <core_dir> <bundle_dirs.json>
//
// - <core_dir>          Bazel out-build/ (per-file tsc emit + copied assets +
//                       nls metadata files)
// - <bundle_dirs.json>  JSON array of per-bundle output directories from the
//                       23 esbuild_bundle targets
//
// We copy the whole core first, then overlay each bundle dir on top. Bundles
// win because their entry-point .js is what Electron loads at runtime; the
// per-file .js from tsc becomes unused deadweight in this layout but keeping
// it costs nothing runtime-wise and simplifies the rule (no need to enumerate
// exactly which files to keep vs. drop).

import { readdirSync, mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [outDir, coreDir, bundleDirsJsonPath, productJsonSrc, srcPackageJsonPath] = process.argv.slice(2);
if (!outDir || !coreDir || !bundleDirsJsonPath || !productJsonSrc || !srcPackageJsonPath) {
	throw new Error(
		'usage: assemble_vscode_dir.mjs <out> <core> <bundle_dirs.json> ' +
		'<product.json> <package.json>');
}

const bundleDirs = JSON.parse(readFileSync(bundleDirsJsonPath, 'utf-8'));

function walk(srcRoot) {
	const out = [];
	(function rec(dir) {
		for (const name of readdirSync(dir)) {
			const p = path.join(dir, name);
			let st;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) {
				rec(p);
			} else if (st.isFile()) {
				out.push(path.relative(srcRoot, p));
			}
		}
	})(srcRoot);
	return out;
}

function copyTree(srcRoot, destRoot) {
	for (const rel of walk(srcRoot)) {
		const src = path.join(srcRoot, rel);
		const dest = path.join(destRoot, rel);
		mkdirSync(path.dirname(dest), { recursive: true });
		// Sources are Bazel-staged files (read-only symlinks). If we're
		// overlaying a bundle on top of the core's per-file .js, the
		// destination will already exist and be read-only -- copyFileSync
		// bails with EACCES. Remove first so the copy always succeeds.
		try { rmSync(dest, { force: true }); } catch { /* ok */ }
		copyFileSync(src, dest);
	}
}

// Layout matches npm's `packageTask`: bundles + assets live under `out/`,
// and product.json / package.json sit ONE LEVEL UP at the app root. The
// bundled main.js does `require('../product.json')`, so their relative
// positioning is load-bearing (see build/lib/inlineMeta.ts's TODO about
// why product.json isn't inlined into the bundle).
const jsOutDir = path.join(outDir, 'out');
mkdirSync(jsOutDir, { recursive: true });
copyTree(coreDir, jsOutDir);
for (const bd of bundleDirs) {
	copyTree(bd, jsOutDir);
}

// product.json at the app root -- the bundled main.js requires it via
// `../product.json` relative to `out/main.js`.
copyFileSync(productJsonSrc, path.join(outDir, 'product.json'));

// package.json at the app root, main pointing at `./out/main.js` -- same
// path the repo's dev-mode package.json uses. Electron reads this on launch.
const pkg = JSON.parse(readFileSync(srcPackageJsonPath, 'utf-8'));
pkg.main = './out/main.js';
writeFileSync(
	path.join(outDir, 'package.json'),
	JSON.stringify(pkg, null, '\t'),
);
