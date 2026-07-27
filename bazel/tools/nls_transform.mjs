// Port of vscode's build/lib/nls.ts + build/lib/nls-analysis.ts.
//
// Applies the SAME NLS transform gulp-tsb's pipeline runs (compilation.ts:88):
//   localize("keyString", "English message")  ->  localize(NNN, null)
//   localize2("keyString", "English message") ->  localize(NNN, "English message")
//
// NNN is a global index incremented monotonically across all files. To
// reproduce npm's exact indices, files must be processed in the same order
// gulp uses (`.pipe(sort())` in nls.ts uses gulp-sort, which sorts by full
// path ascending). We honor that here by sorting the emitted .js file set
// before iterating.
//
// This is a straight port -- the algorithm and identifier semantics match
// vscode's source. Only the plumbing changes: no gulp streams, no Vinyl,
// no source-map generator rewrites (we don't need updated .js.map bytes
// for bundle byte-parity, only the patched .js).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Anchor createRequire so `typescript` and `source-map` resolve out of the
// staged node_modules tree; the driver process's CWD is the sandbox execroot,
// which has node_modules directly under it.
const anchorPath = process.argv[2];
const outDir = process.argv[3];
const srcRoot = process.argv[4];
if (!anchorPath || !outDir || !srcRoot) {
	throw new Error('usage: nls_transform.mjs <anchor-package.json> <outdir> <src_root>');
}
const req = createRequire(pathToFileURL(anchorPath));
const ts = req('typescript');
const sm = req('source-map');

// ---------------------------------------------------------------------------
// nls-analysis.ts port
// ---------------------------------------------------------------------------

const CollectStepResult = Object.freeze({
	Yes: 'Yes',
	YesAndRecurse: 'YesAndRecurse',
	No: 'No',
	NoAndRecurse: 'NoAndRecurse',
});

function collect(node, fn) {
	const result = [];
	function loop(n) {
		const r = fn(n);
		if (r === CollectStepResult.Yes || r === CollectStepResult.YesAndRecurse) {
			result.push(n);
		}
		if (r === CollectStepResult.YesAndRecurse || r === CollectStepResult.NoAndRecurse) {
			ts.forEachChild(n, loop);
		}
	}
	loop(node);
	return result;
}

function isImportNode(node) {
	return node.kind === ts.SyntaxKind.ImportDeclaration ||
		node.kind === ts.SyntaxKind.ImportEqualsDeclaration;
}

function isCallExpressionWithinTextSpanCollectStep(textSpan, node) {
	if (!ts.textSpanContainsTextSpan(
		{ start: node.pos, length: node.end - node.pos }, textSpan)) {
		return CollectStepResult.No;
	}
	return node.kind === ts.SyntaxKind.CallExpression
		? CollectStepResult.YesAndRecurse
		: CollectStepResult.NoAndRecurse;
}

class SingleFileServiceHost {
	constructor(options, filename, contents) {
		this.options = options;
		this.filename = filename;
		this.file = ts.ScriptSnapshot.fromString(contents);
		this.lib = ts.ScriptSnapshot.fromString('');
	}
	getCompilationSettings = () => this.options;
	getScriptFileNames = () => [this.filename];
	getScriptVersion = () => '1';
	getScriptSnapshot = (name) => (name === this.filename ? this.file : this.lib);
	getCurrentDirectory = () => '';
	getDefaultLibFileName = () => 'lib.d.ts';
	readFile(path) {
		return path === this.filename
			? this.file.getText(0, this.file.getLength()) : undefined;
	}
	fileExists(path) { return path === this.filename; }
}

function analyzeLocalizeCalls(contents, functionName) {
	const filename = 'file.ts';
	const options = { noResolve: true };
	const serviceHost = new SingleFileServiceHost(options, filename, contents);
	const service = ts.createLanguageService(serviceHost);
	const sourceFile = ts.createSourceFile(
		filename, contents, ts.ScriptTarget.ES5, true);

	const imports = collect(sourceFile,
		n => isImportNode(n) ? CollectStepResult.YesAndRecurse : CollectStepResult.NoAndRecurse);

	const importEqualsDecls = imports
		.filter(n => n.kind === ts.SyntaxKind.ImportEqualsDeclaration)
		.filter(d => d.moduleReference.kind === ts.SyntaxKind.ExternalModuleReference)
		.filter(d => {
			const text = d.moduleReference.expression.getText();
			return text.endsWith(`/nls'`) || text.endsWith(`/nls"`) ||
				text.endsWith(`/nls.js'`) || text.endsWith(`/nls.js"`);
		});

	const importDecls = imports
		.filter(n => n.kind === ts.SyntaxKind.ImportDeclaration)
		.filter(d => d.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral)
		.filter(d => {
			const text = d.moduleSpecifier.getText();
			return text.endsWith(`/nls'`) || text.endsWith(`/nls"`) ||
				text.endsWith(`/nls.js'`) || text.endsWith(`/nls.js"`);
		})
		.filter(d => !!d.importClause && !!d.importClause.namedBindings);

	const nlsLocalizeCallExprs = [];
	const namespaceImports = importDecls
		.filter(d => d.importClause?.namedBindings?.kind === ts.SyntaxKind.NamespaceImport)
		.map(d => d.importClause.namedBindings.name);
	const importEqualsNames = importEqualsDecls.map(d => d.name);

	for (const name of [...namespaceImports, ...importEqualsNames]) {
		const refs = service.getReferencesAtPosition(filename, name.pos + 1) ?? [];
		for (const ref of refs) {
			if (ref.isWriteAccess) continue;
			const calls = collect(sourceFile,
				n => isCallExpressionWithinTextSpanCollectStep(ref.textSpan, n));
			const lastCall = calls[calls.length - 1];
			if (lastCall &&
				lastCall.expression.kind === ts.SyntaxKind.PropertyAccessExpression &&
				lastCall.expression.name.getText() === functionName) {
				nlsLocalizeCallExprs.push(lastCall);
			}
		}
	}

	const namedImports = importDecls
		.filter(d => d.importClause?.namedBindings?.kind === ts.SyntaxKind.NamedImports)
		.flatMap(d => Array.from(d.importClause.namedBindings.elements));

	const localizeCallExprs = [];
	for (const namedImport of namedImports) {
		const isTarget = namedImport.name.getText() === functionName ||
			(namedImport.propertyName && namedImport.propertyName.getText() === functionName);
		if (!isTarget) continue;
		const searchName = namedImport.propertyName ? namedImport.name : namedImport.name;
		const refs = service.getReferencesAtPosition(filename, searchName.pos + 1) ?? [];
		for (const ref of refs) {
			if (ref.isWriteAccess) continue;
			const calls = collect(sourceFile,
				n => isCallExpressionWithinTextSpanCollectStep(ref.textSpan, n));
			const lastCall = calls[calls.length - 1];
			if (lastCall) {
				localizeCallExprs.push(lastCall);
			}
		}
	}

	// dedupe by call start
	const allCalls = [...nlsLocalizeCallExprs, ...localizeCallExprs];
	const seen = new Set();
	const unique = allCalls.filter(c => {
		const s = c.getStart();
		if (seen.has(s)) return false;
		seen.add(s);
		return true;
	});

	return unique
		.filter(e => e.arguments.length > 1)
		.sort((a, b) => a.arguments[0].getStart() - b.arguments[0].getStart())
		.map(e => {
			const args = e.arguments;
			return {
				keySpan: {
					start: ts.getLineAndCharacterOfPosition(sourceFile, args[0].getStart()),
					end: ts.getLineAndCharacterOfPosition(sourceFile, args[0].getEnd()),
				},
				key: args[0].getText(),
				valueSpan: {
					start: ts.getLineAndCharacterOfPosition(sourceFile, args[1].getStart()),
					end: ts.getLineAndCharacterOfPosition(sourceFile, args[1].getEnd()),
				},
				value: args[1].getText(),
			};
		});
}

class TextModel {
	constructor(contents) {
		const regex = /\r\n|\r|\n/g;
		let index = 0;
		let match;
		this.lines = [];
		this.lineEndings = [];
		while (match = regex.exec(contents)) {
			this.lines.push(contents.substring(index, match.index));
			this.lineEndings.push(match[0]);
			index = regex.lastIndex;
		}
		if (contents.length > 0) {
			this.lines.push(contents.substring(index, contents.length));
			this.lineEndings.push('');
		}
	}
	apply(span, content) {
		const startLine = this.lines[span.start.line] || '';
		const endLine = this.lines[span.end.line] || '';
		this.lines[span.start.line] = startLine.substring(0, span.start.character)
			+ content + endLine.substring(span.end.character);
		for (let i = span.start.line + 1; i <= span.end.line; i++) {
			this.lines[i] = '';
		}
	}
	toString() {
		let out = '';
		for (let i = 0; i < this.lines.length; i++) {
			out += this.lines[i] + this.lineEndings[i];
		}
		return out;
	}
}

function parseLocalizeKeyOrValue(expr) {
	// eslint-disable-next-line no-eval
	return eval(`(${expr})`);
}

// ---------------------------------------------------------------------------
// nls.ts patch() port (streams stripped)
// ---------------------------------------------------------------------------

let allNLSMessagesIndex = 0;

function mappedPositionFrom(source, lc) {
	return { source, line: lc.line + 1, column: lc.character };
}
function lcFrom(pos) { return { line: pos.line - 1, character: pos.column }; }

function patchJavascript(patches, contents) {
	const model = new TextModel(contents);
	// apply patches in REVERSE order so earlier patches' positions stay valid.
	for (let i = patches.length - 1; i >= 0; i--) {
		model.apply(patches[i].span, patches[i].content);
	}
	return model.toString();
}

async function patch(typescript, javascript, sourcemap, preserveEnglish) {
	const localizeCalls = analyzeLocalizeCalls(typescript, 'localize');
	const localize2Calls = analyzeLocalizeCalls(typescript, 'localize2');
	if (localizeCalls.length === 0 && localize2Calls.length === 0) {
		return { javascript, changed: false };
	}

	// Emit both the ordered keys and messages for this file, matching nls.ts's
	// `nlsKeys` / `nlsMessages` return values. Order is source-position order
	// (which coincides with the order patches are numbered, since analyze
	// returns calls sorted by start).
	const nlsKeys = [
		...localizeCalls.map(lc => parseLocalizeKeyOrValue(lc.key)),
		...localize2Calls.map(lc => parseLocalizeKeyOrValue(lc.key)),
	];
	const nlsMessages = [
		...localizeCalls.map(lc => parseLocalizeKeyOrValue(lc.value)),
		...localize2Calls.map(lc => parseLocalizeKeyOrValue(lc.value)),
	];

	const smc = await new sm.SourceMapConsumer(sourcemap);
	try {
		const positionFrom = (lc) => mappedPositionFrom(sourcemap.sources[0], lc);
		const toPatch = c => {
			const start = lcFrom(smc.generatedPositionFor(positionFrom(c.range.start)));
			const end = lcFrom(smc.generatedPositionFor(positionFrom(c.range.end)));
			return { span: { start, end }, content: c.content };
		};

		const localizePatches = localizeCalls.flatMap(lc => (
			preserveEnglish
				? [{ range: lc.keySpan, content: `${allNLSMessagesIndex++}` }]
				: [
					{ range: lc.keySpan, content: `${allNLSMessagesIndex++}` },
					{ range: lc.valueSpan, content: 'null' },
				]
		)).map(toPatch);

		const localize2Patches = localize2Calls.map(lc => ({
			range: lc.keySpan, content: `${allNLSMessagesIndex++}`,
		})).map(toPatch);

		const patches = [...localizePatches, ...localize2Patches].sort((a, b) => {
			if (a.span.start.line !== b.span.start.line)
				return a.span.start.line - b.span.start.line;
			return a.span.start.character - b.span.start.character;
		});

		const patched = patchJavascript(patches, javascript);
		return { javascript: patched, changed: true, nlsKeys, nlsMessages };
	} finally {
		smc.destroy?.();
	}
}

// ---------------------------------------------------------------------------
// Driver: walk outdir, patch every .js in sort order
// ---------------------------------------------------------------------------

function listJsFiles(dir, baseDir = dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		let st;
		try { st = statSync(p); } catch { continue; }
		if (st.isDirectory()) {
			out.push(...listJsFiles(p, baseDir));
		} else if (st.isFile() && p.endsWith('.js')) {
			out.push({ abs: p, rel: path.relative(baseDir, p) });
		}
	}
	return out;
}

// gulp-sort's defaultComparator sorts by Vinyl `file.path` (absolute) using
// String.localeCompare. Match both aspects: sort on the absolute path with
// localeCompare so files that vary only by unicode collation (digits vs
// letters, case, etc.) fall in the same order the npm build sees.
const files = listJsFiles(outDir).sort((a, b) => a.abs.localeCompare(b.abs));

// Global accumulators, matching build/lib/nls.ts's private state. Emitted
// as nls.metadata.json / nls.messages.json / nls.keys.json / nls.messages.js
// after the walk finishes.
const moduleToNLSKeys = {};
const moduleToNLSMessages = {};
const allNLSMessages = [];
const allNLSModulesAndKeys = [];

let filesTouched = 0;
for (const f of files) {
	const mapPath = f.abs + '.map';
	let raw;
	try { raw = readFileSync(mapPath, 'utf-8'); } catch { continue; }
	const sourcemap = JSON.parse(raw);
	const tsRelInSourcemap = sourcemap.sources?.[0];
	if (!tsRelInSourcemap) continue;

	// Sourcemap `sources[0]` is a path RELATIVE to the .js.map file's
	// directory. Resolve to an absolute path and read the .ts source.
	const tsAbs = path.resolve(path.dirname(f.abs), tsRelInSourcemap);
	let tsSource;
	try { tsSource = readFileSync(tsAbs, 'utf-8'); } catch { continue; }

	const jsSource = readFileSync(f.abs, 'utf-8');
	const result = await patch(tsSource, jsSource, sourcemap, /*preserveEnglish=*/ false);
	if (result.changed) {
		writeFileSync(f.abs, result.javascript);
		filesTouched++;

		// Module id: relative path from outDir with `.js` stripped, forward
		// slashes -- matches build/lib/nls.ts's patchFile logic.
		const moduleId = f.rel.replace(/\.js$/, '').replace(/\\/g, '/');
		moduleToNLSKeys[moduleId] = result.nlsKeys;
		moduleToNLSMessages[moduleId] = result.nlsMessages;
		allNLSMessages.push(...result.nlsMessages);
		allNLSModulesAndKeys.push([
			moduleId,
			result.nlsKeys.map(k => typeof k === 'string' ? k : k.key),
		]);
	}
}
// Write the four NLS metadata files at the outDir root, matching the four
// Vinyl files nls.ts pushes in its flush() callback. downstream bundle-vscode
// / packaging steps copy these into out-vscode/ so `.messages` / `.keys` are
// available to the runtime.
writeFileSync(
	path.join(outDir, 'nls.metadata.json'),
	JSON.stringify({ keys: moduleToNLSKeys, messages: moduleToNLSMessages }, null, '\t'),
);
writeFileSync(
	path.join(outDir, 'nls.messages.json'),
	JSON.stringify(allNLSMessages),
);
writeFileSync(
	path.join(outDir, 'nls.keys.json'),
	JSON.stringify(allNLSModulesAndKeys),
);
writeFileSync(
	path.join(outDir, 'nls.messages.js'),
	`/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
globalThis._VSCODE_NLS_MESSAGES=${JSON.stringify(allNLSMessages)};`,
);

if (process.env.CMAKE2BAZEL_VERBOSE) {
	console.error(`[nls_transform] patched ${filesTouched}/${files.length} files, ` +
		`${allNLSMessagesIndex} localize/localize2 calls indexed`);
}
