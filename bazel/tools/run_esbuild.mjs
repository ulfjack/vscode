// Wrapper the esbuild_bundle rule invokes.
//
//   node run_esbuild.mjs <config.json>
//
// The Bazel rule writes a JSON config file with all esbuild BuildOptions plus
// these internal fields (all __-prefixed so the wrapper strips them before
// forwarding to esbuild):
//   __esbuildDir          -- path to node_modules/esbuild (createRequire anchor)
//   __metafileOut         -- where to write the esbuild metafile
//   __minimistPath        -- absolute path to node_modules/minimist/index.js
//                            (rehydrates the npm side's external-override plugin)
//   __removeTsBoilerplate -- whether to install the contents-mapper plugin
//                            (npm's `skipTSBoilerplateRemoval` inverted)
//
// These two flags together port build/lib/optimize.ts's custom plugins to the
// Bazel side. Input-closure parity requires __minimistPath; byte-level parity
// on the bundle contents also requires __removeTsBoilerplate.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, promises as fsp } from 'node:fs';

// --- vscode's TS-boilerplate stripper, ported from build/lib/bundle.ts. -----
// Matches every helper the TypeScript emitter can inline at the top of an
// output file (__extends, __assign, __decorate, ...); the contents-mapper
// plugin runs this once per .js file, so every file emerges as if the
// helpers had been extracted to a runtime import.
const BOILERPLATE = [
	{ start: /^var __extends/, end: /^}\)\(\);$/ },
	{ start: /^var __assign/, end: /^};$/ },
	{ start: /^var __decorate/, end: /^};$/ },
	{ start: /^var __metadata/, end: /^};$/ },
	{ start: /^var __param/, end: /^};$/ },
	{ start: /^var __awaiter/, end: /^};$/ },
	{ start: /^var __generator/, end: /^};$/ },
	{ start: /^var __createBinding/, end: /^}\)\);$/ },
	{ start: /^var __setModuleDefault/, end: /^}\);$/ },
	{ start: /^var __importStar/, end: /^};$/ },
	{ start: /^var __addDisposableResource/, end: /^};$/ },
	{ start: /^var __disposeResources/, end: /^}\);$/ },
];

function removeAllTSBoilerplate(source) {
	// The npm version's `seen` array is pre-filled with `true`, so every
	// helper block is removed on FIRST sight (not just second). We mirror
	// that exactly.
	const seen = BOILERPLATE.map(() => true);
	const lines = source.split(/\r\n|\n|\r/);
	const out = [];
	let removing = false;
	let endRe = null;
	for (const line of lines) {
		if (removing) {
			out.push('');
			if (endRe.test(line)) { removing = false; }
			continue;
		}
		for (let j = 0; j < BOILERPLATE.length; j++) {
			if (BOILERPLATE[j].start.test(line)) {
				if (seen[j]) {
					removing = true;
					endRe = BOILERPLATE[j].end;
				} else {
					seen[j] = true;
				}
				break;
			}
		}
		out.push(removing ? '' : line);
	}
	return out.join('\n');
}

const configPath = process.argv[2];
if (!configPath) {
	throw new Error('usage: run_esbuild.mjs <config.json>');
}
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const esbuildDir = config.__esbuildDir;
const metafileOut = config.__metafileOut;
const minimistPath = config.__minimistPath;
const removeBoilerplate = !!config.__removeTsBoilerplate;
const tslibPath = config.__tslibPath;
delete config.__esbuildDir;
delete config.__metafileOut;
delete config.__minimistPath;
delete config.__removeTsBoilerplate;
delete config.__tslibPath;

// Anchor createRequire at the esbuild package.json so `require('esbuild')`
// resolves through node_modules/esbuild/, not our cwd. Bazel's action cwd
// is the sandbox execroot, which has no node_modules tree by default.
const req = createRequire(pathToFileURL(esbuildDir + '/package.json'));
const esbuild = req('esbuild');

// Force metafile so we can diff the resolved input closure.
config.metafile = true;

// esbuild requires an ABSOLUTE absWorkingDir; the rule passes a
// Bazel-execroot-relative path, so resolve it here.
if (config.absWorkingDir) {
	const { resolve: absResolve } = await import('node:path');
	config.absWorkingDir = absResolve(config.absWorkingDir);
}

// Banner: license header + optional inline copy of tslib.es6.js. In npm's
// build the SAME callback (skipTSBoilerplateRemoval) controls both the
// tslib-in-banner decision and the boilerplate-stripping plugin -- so we
// tie them together here: bundles that keep their per-file boilerplate
// (workbench.js, sessions.js in electron-browser) also skip the shared
// tslib banner.
if (tslibPath) {
	const DEFAULT_FILE_HEADER = [
		'/*!--------------------------------------------------------',
		' * Copyright (C) Microsoft Corporation. All rights reserved.',
		' *--------------------------------------------------------*/',
	].join('\n');
	const js = removeBoilerplate
		? DEFAULT_FILE_HEADER + readFileSync(tslibPath, 'utf-8')
		: DEFAULT_FILE_HEADER;
	config.banner = { ...(config.banner || {}), js };
}

// Rehydrate build/lib/optimize.ts's custom plugins.
const plugins = [];
if (removeBoilerplate) {
	plugins.push({
		name: 'contents-mapper',
		setup(build) {
			build.onLoad({ filter: /\.js$/ }, async ({ path }) => {
				const contents = await fsp.readFile(path, 'utf-8');
				return { contents: removeAllTSBoilerplate(contents) };
			});
		},
	});
}
if (minimistPath) {
	// esbuild wants absolute paths from onResolve; Bazel's config value is
	// relative to the sandbox root, so resolve against CWD (execroot) here.
	const { resolve: absResolve } = await import('node:path');
	const minimistAbs = absResolve(minimistPath);
	plugins.push({
		name: 'external-override',
		setup(build) {
			// Inline minimist even though `packages: 'external'` would leave
			// it as an external import -- vscode needs it at startup without
			// a conditional await import().
			build.onResolve({ filter: /^minimist$/ }, () => {
				return { path: minimistAbs, external: false };
			});
		},
	});
}
if (plugins.length) {
	config.plugins = [...(config.plugins || []), ...plugins];
}

const result = await esbuild.build(config);

if (result.metafile && metafileOut) {
	writeFileSync(metafileOut, JSON.stringify(result.metafile));
}

// Post-process bundle for byte parity with npm's output:
//
//   1. Append `//# sourceMappingURL=<name>.js.map`. esbuild's
//      `sourcemap: 'external'` does NOT add this comment; the npm pipeline
//      pipes through gulp-sourcemaps.write({addComment: true}) which does.
//   2. Rewrite `(../)+node_modules/` -> `node_modules/`. In npm, esbuild's
//      absWorkingDir is the repo root so node_modules lives directly under
//      it; in Bazel we anchor at `bazel-out/<cfg>/bin` so it ends up above
//      that as `../../../...`. Bytes are identical modulo this prefix.
if (result.metafile) {
	const { resolve: absResolve, basename } = await import('node:path');
	for (const outPath of Object.keys(result.metafile.outputs)) {
		if (!outPath.endsWith('.js')) continue;
		// metafile output paths are relative to absWorkingDir.
		const abs = absResolve(config.absWorkingDir || '.', outPath);
		let js = readFileSync(abs, 'utf-8');
		// Normalize path prefixes so bundle comments read the same as npm's:
		//   `<sandbox>/execroot/<repo>/bazel-out/<cfg>/bin/out-build/foo.js`
		//     -> `out-build/foo.js`
		//   `(../)+node_modules/foo`
		//     -> `node_modules/foo`
		// esbuild embeds paths relative to its resolved absWorkingDir, but the
		// sandbox layout puts node_modules above the working dir (Bazel's
		// bazel-bin) while npm's build has both directly under the repo root.
		js = js.replace(
			/(?:\.\.\/)*(?:[^ "'/]+\/)*execroot\/[^/]+\/bazel-out\/[^/]+\/bin\//g,
			'',
		);
		js = js.replace(/(?:\.\.\/)+node_modules\//g, 'node_modules/');
		if (!js.endsWith('\n')) js += '\n';
		js += `\n//# sourceMappingURL=${basename(abs)}.map\n`;
		writeFileSync(abs, js);
	}
}
if (result.errors && result.errors.length) {
	for (const e of result.errors) {
		console.error(e.text || e);
	}
	process.exit(1);
}
