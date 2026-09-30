// The environment-read classifier behind provider-steering.test.mjs (issue #511).
//
// It is a RULE, not a list of accessor spellings: a spelling list kept missing the next form (`const { X } =
// process.env`, `(env) => env[K]`, `ctx.env("X")`, `const v = env(); v.X`). Instead every OCCURRENCE that
// can reach the environment is found and accounted for, per file:
//
//   - every identifier token `env` outside comments, strings and regex literals (so `process.env`,
//     `ctx.env`, a parameter or a variable named `env`, `{ env: e } = process`, `import { env } ...`);
//   - every `process["env"]`;
//   - every occurrence of an ALIAS of one of those (`const e = process.env`, `const v = env()`,
//     `(_a = process.env) === null ... _a.X`), within the alias's live range;
//   - every call of a HELPER, derived rather than listed: a named function one of whose own parameters is
//     the key of a read above (`getProviderEnvValue(name, env)`, `resolveEnvConfigValue(name, env)`).
//
// Each occurrence either names a variable (a member `.X`, a key `["X"]` or a key resolved through a string
// constant, a call `("X")`, `"X" in env`, `{ X } = env`, or the receiver handed to a selector beside its
// key) or it is a SITE: its short text is returned, and the test pins every file's sites WITH A COUNT. A
// new occurrence anywhere, of any shape, either names something the equality sees or changes a count, so
// nothing new passes silently. Writes (`process.env.X = ...`) are sites too, not reads.
//
// Comments are stripped by a small tokenizer first (strings, template literals and regex literals
// respected), so a name in a JSDoc example is not a read. The test checks the tokenizer with an independent
// parser: each scanned file, rebuilt from the tokenizer's own view (skeleton below), must still parse.

import { readFileSync } from "node:fs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT = /^(?:exports\.)?([A-Za-z_$][\w$]*)$/;
const STRING_CONSTANT = /(?:\b(?:const|let|var)\s+|\bexports\.)([A-Za-z_$][\w$]*)\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
const ENV_OBJECT_METHODS = new Set(["toObject", "toString", "valueOf", "get", "set", "has", "delete", "keys", "entries", "values", "hasOwnProperty"]);
const NOT_A_FUNCTION_NAME = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "await", "yield", "super", "import", "with"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Strip comments. Returns the source with every comment replaced by spaces (newlines kept, so offsets and
 * line numbers are unchanged) and a mask marking every character inside a string, template text or regex
 * literal, delimiters included. Throws on a literal or comment left open at the end of the file, which is
 * what a misread `/` would produce.
 */
export function lex(src) {
	const n = src.length;
	const mask = new Uint8Array(n);
	const comments = [];
	const templates = [];
	// Every literal the lexer saw, as [start, end, kind], for skeleton() below.
	const literals = [];
	let prev = "";
	let i = 0;
	const regexAllowed = () => {
		if (prev === "") return true;
		if (prev.startsWith("p:")) return !")]".includes(prev.slice(2));
		if (prev.startsWith("w:")) return REGEX_AFTER_WORD.has(prev.slice(2));
		return false;
	};
	const template = (start) => {
		let j = start + 1;
		while (j < n) {
			const c = src[j];
			if (c === "\\") j += 2;
			else if (c === "`") {
				mask.fill(1, start, j + 1);
				literals.push([start, j + 1, src[start] === "`" ? "t" : "t)"]);
				prev = "s";
				return j + 1;
			} else if (c === "$" && src[j + 1] === "{") {
				mask.fill(1, start, j + 2);
				literals.push([start, j + 2, src[start] === "`" ? "t(" : "t|"]);
				templates.push(0);
				prev = "p:{";
				return j + 2;
			} else j++;
		}
		throw new Error(`unterminated template literal at ${start}`);
	};
	if (src.startsWith("#!")) {
		const end = src.indexOf("\n");
		comments.push([0, end < 0 ? n : end]);
		i = end < 0 ? n : end;
	}
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "\u00a0" || c === "\ufeff" || c === "\u2028" || c === "\u2029") {
			i++;
		} else if (c === "/" && src[i + 1] === "/") {
			let j = i + 2;
			while (j < n && src[j] !== "\n" && src[j] !== "\r" && src[j] !== "\u2028" && src[j] !== "\u2029") j++;
			comments.push([i, j]);
			i = j;
		} else if (c === "/" && src[i + 1] === "*") {
			const j = src.indexOf("*/", i + 2);
			if (j < 0) throw new Error(`unterminated comment at ${i}`);
			comments.push([i, j + 2]);
			i = j + 2;
		} else if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n && src[j] !== c) {
				if (src[j] === "\\") j += 2;
				else if (src[j] === "\n") throw new Error(`unterminated string at ${i}`);
				else j++;
			}
			if (j >= n) throw new Error(`unterminated string at ${i}`);
			mask.fill(1, i, j + 1);
			literals.push([i, j + 1, "s"]);
			prev = "s";
			i = j + 1;
		} else if (c === "`") {
			i = template(i);
		} else if (c === "}" && templates.length && templates[templates.length - 1] === 0) {
			templates.pop();
			i = template(i);
		} else if (c === "/" && regexAllowed()) {
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				const d = src[j];
				if (d === "\\") j += 2;
				else if (d === "\n") throw new Error(`unterminated regex at ${i}`);
				else if (d === "[") (inClass = true), j++;
				else if (d === "]") (inClass = false), j++;
				else if (d === "/" && !inClass) break;
				else j++;
			}
			if (j >= n) throw new Error(`unterminated regex at ${i}`);
			j++;
			while (j < n && /[a-z]/.test(src[j])) j++;
			mask.fill(1, i, j);
			literals.push([i, j, "r"]);
			prev = "r";
			i = j;
		} else if (/[A-Za-z_$\\]/.test(c) || c.charCodeAt(0) > 127) {
			let j = i + 1;
			while (j < n && (/[\w$\\]/.test(src[j]) || src.charCodeAt(j) > 127) && !/[\u00a0\ufeff\u2028\u2029]/.test(src[j])) j++;
			prev = `w:${src.slice(i, j)}`;
			i = j;
		} else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < n && (/[\w.]/.test(src[j]) || ((src[j] === "+" || src[j] === "-") && /[eE]/.test(src[j - 1]) && !/^0[xX]/.test(src.slice(i, j))))) j++;
			prev = "n";
			i = j;
		} else {
			if (c === "{" && templates.length) templates[templates.length - 1]++;
			else if (c === "}" && templates.length) templates[templates.length - 1]--;
			prev = `p:${c}`;
			i++;
		}
	}
	if (templates.length) throw new Error("unterminated template expression at end of file");
	literals.sort((a, b) => a[0] - b[0]);
	let code = "";
	let at = 0;
	for (const [a, b] of comments) {
		code += src.slice(at, a) + src.slice(a, b).replace(/[^\n\r]/g, " ");
		at = b;
	}
	code += src.slice(at);
	return { code, mask, literals };
}

/**
 * The file with every comment removed and every literal replaced by a minimal one of the same kind:
 * strings by `""`, regexes by `/x/`, template pieces by their delimiters. If the lexer misread anything
 * (a division taken for a regex, a `//` inside a string taken for a comment, a template expression
 * mis-nested), this no longer parses, and the test hands it to an independent parser to find out.
 */
export function skeleton(src) {
	const { code, literals } = lex(src);
	const piece = { s: '""', r: "/x/", t: "``", "t(": "`${", "t|": "}${", "t)": "}`" };
	let out = "";
	let at = 0;
	for (const [a, b, kind] of literals) {
		out += code.slice(at, a) + piece[kind];
		at = b;
	}
	return out + code.slice(at);
}

export function stringConstants(code) {
	const map = new Map();
	for (const m of code.matchAll(STRING_CONSTANT)) if (!map.has(m[1])) map.set(m[1], m[2]);
	return map;
}

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Classify one file. `resolve(id)` maps an identifier key to a name (file constants, then package ones,
 * then evaluated ones) or returns undefined. Returns the names read and the SITES: every counted
 * occurrence that names nothing, as short text.
 */
export function classifyFile(src, resolve, helpers = new Map()) {
	const { code, mask } = lex(src);
	const n = code.length;
	const names = [];
	const sites = [];
	let occurrences = 0;
	// Reads whose key is a bare identifier nothing resolves: the candidates for a helper's parameter.
	const keyReads = [];
	const keyRead = (text, pos) => {
		const id = /^[A-Za-z_$][\w$]*$/.exec(text.trim());
		if (id) keyReads.push({ id: id[0], pos });
	};

	const skip = (i) => {
		while (i < n && isSpace(code[i])) i++;
		return i;
	};
	const back = (i) => {
		while (i > 0 && isSpace(code[i - 1])) i--;
		return i;
	};
	const closing = (open) => {
		const pairs = { "[": "]", "(": ")", "{": "}" };
		const stack = [pairs[code[open]]];
		for (let i = open + 1; i < n; i++) {
			if (mask[i]) continue;
			const c = code[i];
			if (pairs[c]) stack.push(pairs[c]);
			else if (c === stack[stack.length - 1]) {
				stack.pop();
				if (!stack.length) return i + 1;
			}
		}
		return -1;
	};
	const opening = (close) => {
		const pairs = { "]": "[", ")": "(", "}": "{" };
		const stack = [pairs[code[close]]];
		for (let i = close - 1; i >= 0; i--) {
			if (mask[i]) continue;
			const c = code[i];
			if (pairs[c]) stack.push(pairs[c]);
			else if (c === stack[stack.length - 1]) {
				stack.pop();
				if (!stack.length) return i;
			}
		}
		return -1;
	};
	const splitArgs = (open) => {
		const end = closing(open);
		if (end < 0) return [];
		const args = [];
		let depth = 0;
		let from = open + 1;
		for (let i = open + 1; i < end - 1; i++) {
			if (mask[i]) continue;
			const c = code[i];
			if ("([{".includes(c)) depth++;
			else if (")]}".includes(c)) depth--;
			else if (c === "," && depth === 0) {
				args.push(code.slice(from, i).trim());
				from = i + 1;
			}
		}
		args.push(code.slice(from, end - 1).trim());
		return args.filter(Boolean);
	};
	const key = (text) => {
		const t = text.trim();
		const lit = /^(["'`])([^"'`$\\]*)\1$/.exec(t);
		if (lit && NAME.test(lit[2])) return lit[2];
		const id = IDENT.exec(t);
		return id ? resolve(id[1]) : undefined;
	};
	const assigns = (i) => {
		i = skip(i);
		return code[i] === "=" && code[i + 1] !== "=" && code[i + 1] !== ">";
	};
	// A site's text: the occurrence, its whole key or argument list when it has one, and a little context
	// either side, whitespace collapsed.
	const shape = (start, end) => {
		const j = skip(end);
		const open = code[j] === "[" || code[j] === "(" ? j : code.startsWith("?.[", j) || code.startsWith("?.(", j) ? j + 2 : -1;
		const close = open >= 0 ? closing(open) : -1;
		const stop = close > 0 && close - start < 400 ? close + 12 : end + 24;
		return code.slice(Math.max(0, start - 20), Math.min(n, stop)).replace(/\s+/g, " ").trim();
	};

	// What one occurrence reads. `start` is where the receiver expression begins, `end` just past it.
	// Returns { names } or { alias } or {} (a site). `call` is true when `(` after it is a call of the
	// receiver itself (`env("X")`, `ctx.env("X")`).
	const access = (start, end, call) => {
		const j = skip(end);
		if (code.startsWith("?.[", j) || code[j] === "[") {
			const open = code[j] === "[" ? j : j + 2;
			const close = closing(open);
			if (close < 0 || assigns(close) || /\bdelete\s+$/.test(code.slice(Math.max(0, start - 10), start))) return {};
			const text = code.slice(open + 1, close - 1);
			const k = key(text);
			if (!k) keyRead(text, start);
			return k ? { names: [k] } : {};
		}
		if (call && (code[j] === "(" || code.startsWith("?.(", j))) {
			const open = code[j] === "(" ? j : j + 2;
			const args = splitArgs(open);
			if (!args.length) {
				// `env()` RETURNS the environment (@google/genai): read what follows, or bind an alias.
				const close = closing(open);
				return close < 0 ? {} : access(start, close, false);
			}
			const k = key(args[0]);
			if (!k) keyRead(args[0], start);
			return k ? { names: [k] } : {};
		}
		const dot = code.startsWith("?.", j) && code[j + 2] !== "(" && code[j + 2] !== "[" ? j + 2 : code[j] === "." && code[j + 1] !== "." ? j + 1 : -1;
		if (dot >= 0) {
			const m = /^\s*([A-Za-z_$][\w$]*)/.exec(code.slice(dot, dot + 200));
			if (!m) return {};
			const after = dot + m[0].length;
			const k = skip(after);
			if (code[k] === "(" || code.startsWith("?.(", k)) {
				// `get`, `has`, `hasOwnProperty` take a variable name (Deno's `env.get(name)`). Any other method
				// is a site: this `env` is some other object, or the environment used whole.
				if (!/^(get|has|hasOwnProperty|hasOwn)$/.test(m[1])) return {};
				const args = splitArgs(code[k] === "(" ? k : k + 2);
				const kk = args.length ? key(args[0]) : undefined;
				if (!kk && args.length) keyRead(args[0], start);
				return kk ? { names: [kk] } : {};
			}
			if (assigns(after) || /\bdelete\s+$/.test(code.slice(Math.max(0, start - 10), start))) return {};
			// A method of the environment object itself (Deno's `env.toObject`, read without calling it here) is
			// not a variable.
			return NAME.test(m[1]) && !ENV_OBJECT_METHODS.has(m[1]) ? { names: [m[1]] } : {};
		}
		// Bare: `"X" in env`, `K in env`, `{ X } = env`, a selector argument, or an alias binding.
		const b = back(start);
		const before = code.slice(Math.max(0, b - 120), b);
		const inCheck = /(?:(["'])([A-Za-z_][A-Za-z0-9_]*)\1|(?<=[(!&|?:,=]\s*)((?:exports\.)?[A-Za-z_$][\w$]*))\s+in$/.exec(before);
		if (inCheck) {
			const k = inCheck[2] ?? key(inCheck[3]);
			return k ? { names: [k] } : {};
		}
		if (/\}\s*=$/.test(before)) {
			const close = back(b - 1) - 1;
			const open = code[close] === "}" ? opening(close) : -1;
			if (open >= 0) {
				const found = patternNames(code.slice(open + 1, close));
				return found.length ? { names: found } : {};
			}
		}
		const binding = /(?:^|[^\w$.=!<>])([A-Za-z_$][\w$]*)\s*=$/.exec(before);
		if (binding) return { alias: binding[1], at: b };
		// The last operand of `(ID = ... ? void 0 : process.env)`, which is what TypeScript emits for
		// `process?.env`: ID holds the environment from here on.
		const after = skip(end);
		if (code[after] === ")") {
			const open = opening(after);
			const bound = open >= 0 && /^\(\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(code.slice(open, open + 80));
			if (bound) return { alias: bound[1], at: open };
		}
		const e = skip(end);
		if (/[(,]$/.test(before) && (code[e] === "," || code[e] === ")")) {
			let depth = 0;
			for (let i = b - 1; i >= 0 && b - i < 4000; i--) {
				if (mask[i]) continue;
				const c = code[i];
				if (")]}".includes(c)) depth++;
				else if ("([{".includes(c)) {
					if (depth === 0) {
						if (c !== "(") break;
						const found = splitArgs(i).map(key).filter(Boolean);
						return found.length ? { names: found } : {};
					}
					depth--;
				}
			}
		}
		return {};
	};

	// The names of an object pattern `{ A, B: b, C = 1, "D": d, E: { F } }` (one level: a nested pattern
	// under `env` is handled where the env token is).
	const patternNames = (text) => {
		const out = [];
		let depth = 0;
		let part = "";
		const flush = () => {
			const p = part.trim();
			part = "";
			const k = /^(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))/.exec(p);
			if (k && !p.startsWith("...") && NAME.test(k[1] ?? k[2])) out.push(k[1] ?? k[2]);
		};
		for (const c of text) {
			if ("([{".includes(c)) depth++;
			if (")]}".includes(c)) depth--;
			if (c === "," && depth === 0) flush();
			else part += c;
		}
		flush();
		return out;
	};

	// The end of the block enclosing `at`, or the file's end.
	const blockEnd = (at) => {
		let depth = 0;
		for (let i = at; i < n; i++) {
			if (mask[i]) continue;
			if (code[i] === "{") depth++;
			else if (code[i] === "}") {
				if (depth === 0) return i;
				depth--;
			}
		}
		return n;
	};

	const aliases = [];
	const seenAlias = new Set();
	const record = (r, start, end) => {
		occurrences++;
		if (r.names?.length) {
			for (const name of r.names) names.push(name);
			return;
		}
		if (r.alias && r.alias !== "env" && !seenAlias.has(`${r.alias}@${r.at}`)) {
			seenAlias.add(`${r.alias}@${r.at}`);
			aliases.push({ name: r.alias, from: r.from ?? end });
		}
		sites.push(shape(start, end));
	};

	// `env` tokens.
	for (const m of code.matchAll(/(?<![\w$])env(?![\w$])/g)) {
		const p = m.index;
		if (mask[p]) continue;
		const pb = back(p);
		const isMember = code[pb - 1] === "." && code[pb - 2] !== ".";
		let start = p;
		if (isMember) {
			// The object before `.env` (`process`, `ctx`, `globalThis.process`, `this.options`).
			let s = back(pb - 1);
			if (code[s - 1] === "?") s = back(s - 1);
			while (s > 0 && /[\w$.]/.test(code[s - 1])) s--;
			start = s;
		}
		const after = skip(p + 3);
		// A key in a destructure of `process` or an import from it: `{ env: e } = process`,
		// `{ env: { X } } = process`, `import { env as E } from "node:process"`.
		if (!isMember && (code[after] === ":" || code.startsWith("as", after))) {
			const asAlias = /^as\s+([A-Za-z_$][\w$]*)/.exec(code.slice(after, after + 80));
			const colon = code[after] === ":" ? skip(after + 1) : -1;
			let r = {};
			const fromProcess = asAlias && /^[^;]*?\}\s*from\s*["'](?:node:)?process["']/.exec(code.slice(after, after + 300));
			if (fromProcess) r = { alias: asAlias[1], at: after, from: after + fromProcess[0].length };
			else if (colon >= 0 && code[colon] === "{") {
				const close = closing(colon);
				if (close > 0 && /^\s*\}?\s*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/.test(code.slice(close, close + 60))) r = { names: patternNames(code.slice(colon + 1, close - 1)) };
			} else if (colon >= 0) {
				const id = /^([A-Za-z_$][\w$]*)/.exec(code.slice(colon, colon + 80));
				const rest = id && /^[^;{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/.exec(code.slice(colon + id[1].length, colon + id[1].length + 200));
				if (rest) r = { alias: id[1], at: colon, from: colon + id[1].length + rest[0].length };
			}
			record(r, p, p + 3);
			continue;
		}
		record(access(start, p + 3, true), start, p + 3);
	}

	// `process["env"]`.
	for (const m of code.matchAll(/(?<![\w$])process\s*(?:\?\.)?\s*\[\s*(["'`])env\1\s*\]/g)) {
		if (mask[m.index]) continue;
		const end = m.index + m[0].length;
		record(access(m.index, end, false), m.index, end);
	}

	// Aliases, within their live range: to the next reassignment of the name or the end of the block.
	for (let k = 0; k < aliases.length; k++) {
		const { name, from } = aliases[k];
		const esc = name.replace(/\$/g, "\\$");
		const limit = blockEnd(from);
		const re = new RegExp(String.raw`(?<![\w$.])${esc}(?![\w$])`, "g");
		re.lastIndex = from;
		for (let m = re.exec(code); m && m.index < limit; m = re.exec(code)) {
			if (mask[m.index]) continue;
			const end = m.index + m[0].length;
			if (assigns(end) && !/\bconst\s+$|\blet\s+$|\bvar\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) break;
			record(access(m.index, end, false), m.index, end);
		}
	}

	// Helpers, DERIVED: a named function one of whose own parameters is the key of a read above
	// (`function resolveEnvConfigValue(name, env) { return env?.[name] || process.env[name]; }`). Its body's read
	// is a counted site; what it reads is decided at its CALL sites, so each call is counted like a read:
	// a literal or constant argument names the variable, anything else is a site. Derived rather than
	// listed, so a new call of any such helper anywhere in the package is seen.
	const definitions = functionDefinitions();
	const defined = [];
	for (const { id, pos } of keyReads) {
		const def = definitions.filter((d) => d.bodyStart <= pos && pos < d.bodyEnd && d.params.includes(id)).sort((x, y) => y.bodyStart - x.bodyStart)[0];
		if (def?.name && def.name !== "env") defined.push({ name: def.name, index: def.params.indexOf(id) });
	}
	for (const [name, index] of helpers) {
		const esc = name.replace(/\$/g, "\\$");
		for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$])${esc}(?![\w$])`, "g"))) {
			if (mask[m.index]) continue;
			if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
			let j = skip(m.index + name.length);
			if (code[j] === ")") j = skip(j + 1); // `(0, env_1.readEnv)("X")`
			if (code[j] !== "(") continue;
			const close = closing(j);
			if (close > 0 && code[skip(close)] === "{" && !/[=(,:?]\s*$/.test(code.slice(Math.max(0, m.index - 3), m.index))) continue; // a method definition
			const args = splitArgs(j);
			const k = args.length > index ? key(args[index]) : undefined;
			occurrences++;
			if (k) names.push(k);
			else sites.push(shape(m.index, j));
		}
	}

	return { names, sites, occurrences, helpers: defined };

	// Every named function in the file: its parameter names and its body's extent. A declaration, a
	// function or arrow bound to a name (`const f = (a) =>`, `f: function (a)`), or a method `f(a) {`.
	function functionDefinitions() {
		const defs = [];
		const params = (open) => {
			const close = closing(open);
			return close < 0 ? null : { list: splitArgs(open).map((p) => /^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? ""), close };
		};
		const body = (from) => {
			const j = skip(from);
			if (code[j] === "{") return [j, closing(j)];
			let depth = 0;
			for (let i = j; i < n; i++) {
				if (mask[i]) continue;
				const c = code[i];
				if ("([{".includes(c)) depth++;
				else if (")]}".includes(c)) {
					if (depth === 0) return [j, i];
					depth--;
				} else if ((c === ";" || c === ",") && depth === 0) return [j, i];
			}
			return [j, n];
		};
		const boundName = (at) => /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s*)?$/.exec(code.slice(Math.max(0, at - 80), at))?.[1];
		for (const m of code.matchAll(/(?<![\w$])function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
			if (mask[m.index]) continue;
			const p = params(m.index + m[0].length - 1);
			if (!p) continue;
			const [bodyStart, bodyEnd] = body(p.close);
			defs.push({ name: m[1] ?? boundName(m.index), params: p.list, bodyStart, bodyEnd });
		}
		for (const m of code.matchAll(/=>/g)) {
			if (mask[m.index]) continue;
			const b = back(m.index);
			let list;
			let from;
			if (code[b - 1] === ")") {
				const open = opening(b - 1);
				if (open < 0) continue;
				list = splitArgs(open).map((p) => /^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? "");
				from = open;
			} else {
				const id = /([A-Za-z_$][\w$]*)$/.exec(code.slice(Math.max(0, b - 80), b));
				if (!id) continue;
				list = [id[1]];
				from = b - id[1].length;
			}
			const [bodyStart, bodyEnd] = body(m.index + 2);
			defs.push({ name: boundName(back(from)), params: list, bodyStart, bodyEnd });
		}
		for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
			if (mask[m.index] || NOT_A_FUNCTION_NAME.has(m[1])) continue;
			const open = m.index + m[0].length - 1;
			const p = params(open);
			if (!p || code[skip(p.close)] !== "{") continue;
			if (/(?:\bfunction\s*\*?|[=(,:?!&|+\-*/%<>]|\breturn|\bnew)\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
			const [bodyStart, bodyEnd] = body(p.close);
			defs.push({ name: m[1], params: p.list, bodyStart, bodyEnd });
		}
		return defs;
	}
}

/**
 * Every environment name read under a set of files, with the file each was first seen in, and every
 * file's SITES as { shape: count }. `evaluated` supplies constants evaluated elsewhere (pi's config.js);
 * `viaEvaluated` records which identifiers used them.
 */
export function classifyFiles(files, { evaluated = {} } = {}) {
	const sources = files.map((file) => [file, readFileSync(file, "utf8")]);
	const lexed = sources.map(([file, src]) => [file, src, stringConstants(lex(src).code)]);
	const packageWide = new Map();
	for (const [, , local] of lexed) for (const [k, v] of local) if (!packageWide.has(k)) packageWide.set(k, v);
	const names = new Map();
	const sites = new Map();
	const viaEvaluated = new Map();
	const resolverFor = (file, local) => (id) => {
		if (local.has(id)) return local.get(id);
		if (packageWide.has(id)) return packageWide.get(id);
		if (Object.hasOwn(evaluated, id)) {
			viaEvaluated.set(id, file);
			return evaluated[id];
		}
		return undefined;
	};
	// Pass 1 derives the package's helpers (a helper exported from one file is called from another);
	// pass 2 counts with them.
	const helpers = new Map();
	for (const [file, src, local] of lexed) {
		for (const { name, index } of classifyFile(src, resolverFor(file, local)).helpers) if (!helpers.has(name)) helpers.set(name, index);
	}
	viaEvaluated.clear();
	for (const [file, src, local] of lexed) {
		const r = classifyFile(src, resolverFor(file, local), helpers);
		for (const name of r.names) if (!names.has(name)) names.set(name, file);
		if (r.sites.length) {
			const counts = {};
			for (const s of r.sites) counts[s] = (counts[s] ?? 0) + 1;
			sites.set(file, counts);
		}
	}
	return { names, sites, viaEvaluated, helpers };
}
