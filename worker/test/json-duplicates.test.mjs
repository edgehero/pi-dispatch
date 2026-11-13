import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findDuplicateKey } from "../src/json-duplicates.mjs";

// Issue #313. `JSON.parse` keeps the LAST value for a duplicated key, so the reviewed file and the running
// file can differ with nothing to say so. These tests are in two halves: worked cases, and a generator
// that knows the answer.

// A backslash BUILT rather than typed, because a `\u00xx` sequence written into a source file by anything
// that processes escapes lands as the decoded character instead, and then the test asserts nothing.
const B = String.fromCharCode(92);
/** `"abc"` as JSON, but with the first character written as a `\u00xx` escape. */
const escapedFirst = (k) => `"${B}u${k.charCodeAt(0).toString(16).padStart(4, "0")}${JSON.stringify(k.slice(1)).slice(1)}`;

test("a duplicate is found, and named by PATH rather than by key alone", () => {
	// `flow` appears in every entry, so the key on its own does not tell an operator where to look.
	const text = '{"triggers":[{"on":{"type":"issue"}},{"run":{"flow":"safe","flow":"evil"}}]}';
	assert.deepEqual(findDuplicateKey(text), { key: "flow", at: "triggers.1.run.flow" });
	// And the parse it is guarding really does take the second value.
	assert.equal(JSON.parse(text).triggers[1].run.flow, "evil");
});

test("a clean file is clean, in every shape the writer and an operator produce", () => {
	const value = {
		_note: "deploy/triggers.json opens with one of these, and an unknown top-level key is legal",
		triggers: [
			{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/x", flow: "tidy" } },
			{ on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "fix", packages: false } },
		],
	};
	for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2), JSON.stringify(value, null, "\t")]) {
		assert.equal(findDuplicateKey(text), null, "indentation must not change the verdict");
	}
});

test("the same key spelled two ways is ONE key to JSON.parse, and must be to this too", () => {
	// The spelling an attacker would actually use, and the case a byte comparison misses entirely.
	const text = `{"flow":"safe",${escapedFirst("flow")}:"evil"}`;
	assert.equal(Object.keys(JSON.parse(text)).length, 1, "the premise: JSON.parse sees one key");
	assert.equal(JSON.parse(text).flow, "evil");
	assert.deepEqual(findDuplicateKey(text), { key: "flow", at: "flow" });
});

test("a key is decoded exactly as JSON.parse decodes it, escape by escape (issue #868)", () => {
	// Since #868 a key with a backslash is decoded by JSON.parse of its literal and a key without one is a slice
	// of the text, so what can go wrong is the choice between the two and where the literal ends. Every code
	// unit is written twice: escaped as `\uXXXX`, and in the plainest spelling JSON allows, which is raw (the
	// slice) for everything but a quote, a backslash and a control character. The key reported has to be the
	// one JSON.parse made, which is the reading the check defends. The hand-written decoder before #868 passes
	// this too, so the change could not move a verdict.
	const hex4 = (c) => c.toString(16).padStart(4, "0");
	for (let c = 0; c <= 0xffff; c++) {
		const unit = String.fromCharCode(c);
		const plain = c < 0x20 || c === 0x22 || c === 0x5c ? JSON.stringify(unit) : `"${unit}"`;
		for (const hex of [hex4(c), hex4(c).toUpperCase()]) {
			const text = `{${plain}:1,"${B}u${hex}":2}`;
			const found = findDuplicateKey(text);
			if (found?.key !== unit || found.at !== unit) assert.fail(`U+${hex}: found ${JSON.stringify(found)} in ${JSON.stringify(text)}`);
		}
		// Spot-check the premise rather than paying a second parse for every unit.
		if (c % 4099 === 0) assert.deepEqual(Object.keys(JSON.parse(`{${plain}:1,"${B}u${hex4(c)}":2}`)), [unit]);
	}

	// The simple escapes, each against a spelling of the same character that is not itself.
	const SIMPLE = [["/", "/"], ["b", `${B}u0008`], ["f", `${B}u000C`], ["n", `${B}u000a`], ["r", `${B}u000D`], ["t", `${B}u0009`], ['"', `${B}u0022`], [B, `${B}u005c`]];
	for (const [esc, other] of SIMPLE) {
		const text = `{"a${B}${esc}b":1,"a${other}b":2}`;
		const [key] = Object.keys(JSON.parse(text));
		assert.deepEqual(findDuplicateKey(text), { key, at: key }, `${B}${esc} is ${other}`);
	}

	// Surrogates: JSON.parse keeps a lone one as itself, so a pair written as two escapes, as one escape beside
	// a raw half, and raw are all one key, and two different lone halves are two keys.
	const smile = "\u{1f600}";
	for (const spelling of [`${B}ud83d${B}ude00`, `${B}ud83d${smile[1]}`, `${smile[0]}${B}ude00`, `${B}uD83D${B}uDE00`]) {
		assert.deepEqual(findDuplicateKey(`{"${smile}x":1,"${spelling}x":2}`), { key: `${smile}x`, at: `${smile}x` }, spelling);
		assert.deepEqual(findDuplicateKey(`{"${spelling}x":1,"${smile}x":2}`), { key: `${smile}x`, at: `${smile}x` }, `${spelling}, second`);
	}
	assert.equal(findDuplicateKey(`{"${B}ud800":1,"${B}udc00":2,"${B}udc00${B}ud800":3,"${B}ud800${B}udc00":4}`), null);
	assert.equal(Object.keys(JSON.parse(`{"${B}ud800":1,"${B}udc00":2,"${B}udc00${B}ud800":3,"${B}ud800${B}udc00":4}`)).length, 4);
});

test("a duplicate inside a STRING is not a duplicate", () => {
	// A trigger may legitimately carry JSON in a task or an instruction.
	const text = JSON.stringify({ triggers: [{ run: { task: '{"a":1,"a":2}' } }] });
	assert.equal(findDuplicateKey(text), null);
});

test("keys containing the scanner's own vocabulary are read as keys, not as syntax", () => {
	for (const key of ['a"b', "a\\b", "a{b}", "a[b]", "a:b", "a,b", "a\nb", "a\tb", "  ", "", "é漢"]) {
		const clean = JSON.stringify({ [key]: 1, other: 2 });
		assert.equal(findDuplicateKey(clean), null, `${JSON.stringify(key)} alone is not a duplicate`);
		const dup = `{${JSON.stringify(key)}:1,${JSON.stringify(key)}:2}`;
		assert.deepEqual(findDuplicateKey(dup), { key, at: key }, `${JSON.stringify(key)} twice is`);
	}
});

test("two objects in one array may share a key; a sibling repeated inside one may not", () => {
	assert.equal(findDuplicateKey('{"t":[{"x":1},{"x":2}]}'), null, "different objects, same key: legal");
	assert.deepEqual(findDuplicateKey('{"t":[{"x":1},{"x":2,"x":3}]}'), { key: "x", at: "t.1.x" });
});

test("a duplicate whose two values are IDENTICAL is still a duplicate", () => {
	// Nothing about the file says one thing, which is the property being defended, and an identical pair is
	// the shape a careless merge produces.
	assert.deepEqual(findDuplicateKey('{"a":1,"a":1}'), { key: "a", at: "a" });
});

test("`triggers` itself can be the duplicated key, which is the whole file shadowed", () => {
	const text = '{"triggers":[{"on":{"type":"issue"},"run":{"kind":"github","flow":"safe"}}],"triggers":[]}';
	assert.deepEqual(findDuplicateKey(text), { key: "triggers", at: "triggers" });
	assert.deepEqual(JSON.parse(text).triggers, [], "the reviewed rule set is not the one that would load");
});

test("bare literals, empty containers and deep nesting do not confuse the walk", () => {
	assert.equal(findDuplicateKey('{"a":1,"b":true,"c":null,"d":-1.5e10,"e":{},"f":[],"g":[[],[{}]]}'), null);
	assert.deepEqual(findDuplicateKey('{"a":{"b":{"c":{"d":1,"d":2}}}}'), { key: "d", at: "a.b.c.d" });
	assert.deepEqual(findDuplicateKey('{"a":[{"b":[{"c":1,"c":2}]}]}'), { key: "c", at: "a.0.b.0.c" });
});

test("the FIRST duplicate is reported, so a file with several still names a real one", () => {
	assert.deepEqual(findDuplicateKey('{"a":{"x":1,"x":2},"b":{"y":1,"y":2}}'), { key: "x", at: "a.x" });
});

// ── The oracle ──────────────────────────────────────────────────────────────────────────────────
//
// A hand-written source-text scanner is a shape this project has been burned by (issue #282: four rounds
// of latent defects in a comment stripper, every one of them green before and after). What settles that is
// not more worked cases, it is checking the scanner against something other than itself. So: generate
// documents, inject a duplicate at a KNOWN path in half of them, and require exact agreement.

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function mulberry(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Deliberately including every character that means something to the scanner. Since issue #868 that also
// means the surrogates: a pair, which JSON.stringify writes raw, and each lone half, which it writes as a
// `\u` escape, so a key can reach JSON.parse with one half escaped and the other raw.
const KEY_CHARS = ["a", "b", "Z", "_", "-", ".", " ", '"', "\\", "\n", "\t", "é", "漢", "$", "{", "}", ":", ",", "[", "]", "\u{1f600}", "\ud800", "\udc00"];

function randomKey(rnd) {
	let k = "";
	// Now and then a key of 13 characters or more, the length from which V8 makes a slice a view of the text
	// rather than a copy, so the keys the Set compares are real slices as well as short copies.
	const len = rnd() < 0.1 ? 13 + Math.floor(rnd() * 20) : 1 + Math.floor(rnd() * 4);
	for (let i = 0; i < len; i++) k += KEY_CHARS[Math.floor(rnd() * KEY_CHARS.length)];
	return k;
}

function generate(rnd, depth, wantDuplicate, path, out) {
	const r = rnd();
	if (depth >= 3 || r < 0.25) {
		const leaf = rnd();
		if (leaf < 0.2) return String(Math.floor(rnd() * 1000) - 500);
		if (leaf < 0.35) return String(rnd() * 1e6);
		if (leaf < 0.45) return "true";
		if (leaf < 0.55) return "false";
		if (leaf < 0.65) return "null";
		return JSON.stringify(randomKey(rnd) + randomKey(rnd));
	}
	if (r < 0.55) {
		const parts = [];
		for (let i = 0, len = Math.floor(rnd() * 4); i < len; i++) parts.push(generate(rnd, depth + 1, wantDuplicate, [...path, i], out));
		return `[${parts.join(",")}]`;
	}
	const keys = [];
	// From ZERO, so `{}` is generated. An object frame that never appears is a path-stack case that never
	// gets exercised, and a mutation check found exactly that: reverting the pop guard to `if (frame)`
	// survived the whole suite while reporting `triggers.run.flow` for a file whose `on` was `{}`.
	for (let i = 0, len = Math.floor(rnd() * 5); i < len; i++) {
		let k = randomKey(rnd);
		while (keys.includes(k)) k += randomKey(rnd);
		keys.push(k);
	}
	const parts = keys.map((k) => `${JSON.stringify(k)}:${generate(rnd, depth + 1, wantDuplicate, [...path, k], out)}`);
	if (wantDuplicate && keys.length > 0 && out.injected === null && rnd() < 0.35) {
		const k = keys[Math.floor(rnd() * keys.length)];
		out.injected = [...path, k].join(".");
		// Half the time the second occurrence is spelled with an escape, which is the case that separates a
		// decoded comparison from a byte one.
		const spelled = rnd() < 0.5 || k.length === 0 ? JSON.stringify(k) : escapedFirst(k);
		// Which of the scanner's two ways of reading a key this pair takes (issue #868): both spellings free of
		// a backslash are two slices, anything else reaches JSON.parse at least once.
		if (`${JSON.stringify(k)}${spelled}`.includes(B)) out.parsedPairs++;
		else out.slicedPairs++;
		parts.push(`${spelled}:${generate(rnd, depth + 1, false, path, out)}`);
	}
	return `{${parts.join(",")}}`;
}

/** Insert JSON-legal whitespace between tokens, never inside a string. */
function spaceOut(text, rnd) {
	const WS = ["", " ", "\n", "\t", "\r\n", "  ", "\r"];
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		out += ch;
		if (inString) {
			if (ch === "\\") {
				out += text[++i];
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",") out += WS[Math.floor(rnd() * WS.length)];
	}
	return out;
}

test("an empty container before the duplicate does not shift the reported path", () => {
	// The case the generator could not produce, and the one that makes a wrong path plausible rather than
	// obviously wrong: `triggers.0.flow` points at a real nesting level, just not this one.
	assert.deepEqual(findDuplicateKey('{"a":{"b":{},"c":{"d":1,"d":2}}}'), { key: "d", at: "a.c.d" });
	assert.deepEqual(findDuplicateKey('{"triggers":[{"on":{},"run":{"flow":"safe","flow":"evil"}}]}'), { key: "flow", at: "triggers.0.run.flow" });
	assert.deepEqual(findDuplicateKey('{"triggers":[{"on":{"type":"issue"},"run":{"secrets":{},"flow":"safe","flow":"evil"}}]}'), { key: "flow", at: "triggers.0.run.flow" });
	assert.deepEqual(findDuplicateKey('{"a":[],"b":{"c":1,"c":2}}'), { key: "c", at: "b.c" });
});

test("a value string is walked, not built, and its escapes still cannot end it early", () => {
	// A value's text is discarded, so decoding it was pure garbage: a single 64MB `run.task` cost ~2GB of
	// heap to produce a string this function throws away, and a worker that dies at boot reading its own
	// configuration is a worse failure than anything this file refuses. The skip has to get escaping right
	// or a value could end early and the rest of the document be read as structure.
	const B = String.fromCharCode(92);
	const Q = String.fromCharCode(34);
	for (const v of [B + B, B + B + B + B, B + Q, "a" + B + B, "a" + B + Q + "b", B + "u0022", B + "u005C", "}" + B + Q + "{", "]" + B + Q + "[", "," + B + Q + ":"]) {
		const clean = `{"t":[{"task":"${v}","flow":"a"}]}`;
		const dup = `{"t":[{"task":"${v}","flow":"a","flow":"b"}]}`;
		JSON.parse(clean); // the precondition, asserted by not throwing
		JSON.parse(dup);
		assert.equal(findDuplicateKey(clean), null, `value ${JSON.stringify(v)} must not read as structure`);
		assert.deepEqual(findDuplicateKey(dup), { key: "flow", at: "t.0.flow" }, `and the duplicate after it is still seen`);
	}

	// And the resource property, which is the reason for the change: a large value must not be copied.
	const big = JSON.stringify({ t: [{ task: "x".repeat(4 * 1024 * 1024), flow: "a", other: 1 }] });
	const before = process.memoryUsage().heapUsed;
	assert.equal(findDuplicateKey(big), null);
	const grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
	assert.ok(grew < 8, `scanning a 4MB value must not allocate it again (grew ${grew.toFixed(1)}MB)`);
});

test("a long key costs about its own length, so 2MB keys fit a 32MB heap (issue #868)", () => {
	// Keys were decoded one character at a time until #868, about 30 bytes of heap per character: a 4MB key took
	// 123MB and a 16MB key ended a process with a 256MB heap, which for these files is a worker that dies at boot
	// reading its own configuration. A heapUsed delta in this process would depend on when the collector ran, so
	// the bound is a child whose heap is too small for the old cost. Measured on node 22, this child needs 137MB
	// with the old decoder and dies here in about 90ms, and 14MB with a slice. It also reads the escaped spelling
	// (JSON.parse, so that key costs its own decoded length) and a long value, then reports what it found.
	const script = `
		import { findDuplicateKey } from ${JSON.stringify(new URL("../src/json-duplicates.mjs", import.meta.url).href)};
		const L = 2 * 1024 * 1024;
		const B = String.fromCharCode(92);
		const texts = {
			plain: () => { const k = "k".repeat(L); return ['{"', k, '":1,"', k, '":2}'].join(""); },
			escaped: () => { const k = "k".repeat(L) + B + "n"; return ['{"', k, '":1,"', k, '":2}'].join(""); },
			value: () => ['{"t":[{"task":"', "v".repeat(L), '","flow":"a","flow":"b"}]}'].join(""),
		};
		const seen = {};
		for (const [name, make] of Object.entries(texts)) {
			const found = findDuplicateKey(make());
			seen[name] = found && { keyLength: found.key.length, tail: found.key.slice(-2), at: found.at === found.key ? "the key" : found.at };
		}
		process.stdout.write(JSON.stringify(seen));
	`;
	const child = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
	assert.equal(child.status, 0, `the scan must fit a 32MB heap (status ${child.status}, signal ${child.signal}): ${child.stderr.slice(-600)}`);
	const L = 2 * 1024 * 1024;
	assert.deepEqual(JSON.parse(child.stdout), {
		plain: { keyLength: L, tail: "kk", at: "the key" },
		escaped: { keyLength: L + 1, tail: "k\n", at: "the key" },
		value: { keyLength: 4, tail: "ow", at: "t.0.flow" },
	});
});

test("a CRLF file is read, not hung on", () => {
	// `\r` is in STRUCTURAL, so a scanner that stopped treating it as whitespace could not advance past one
	// and would spin forever: the worker and the receiver would HANG at boot rather than refuse, which is
	// worse than any wrong answer. A CRLF triggers.json is what a Windows editor or core.autocrlf produces.
	assert.deepEqual(findDuplicateKey('{\r\n\t"a": 1,\r\n\t"a": 2\r\n}'), { key: "a", at: "a" });
	assert.equal(findDuplicateKey('{\r\n\t"a": 1,\r\n\t"b": [1,\r\n2]\r\n}'), null);
});

test("the scanner agrees with a generator that knows the answer, over thousands of documents", () => {
	let checked = 0;
	let withDuplicate = 0;
	const out = { injected: null, slicedPairs: 0, parsedPairs: 0 };
	for (let seed = 1; seed <= 3000; seed++) {
		const rnd = mulberry(seed);
		const wantDuplicate = seed % 2 === 0;
		out.injected = null;
		let text = generate(rnd, 0, wantDuplicate, [], out);
		if (!text.startsWith("{") && !text.startsWith("[")) text = `{"root":${text}}`;
		// The scanner's contract is text that already parsed, so a generated document that does not is out
		// of scope rather than a failure. (In practice they all do; this is the precondition made explicit.)
		try {
			JSON.parse(text);
		} catch {
			continue;
		}
		checked++;
		if (out.injected !== null) withDuplicate++;
		const found = findDuplicateKey(text);
		assert.equal(found ? found.at : null, out.injected, `seed ${seed}: ${text.slice(0, 200)}`);
		// The same document with whitespace at every token boundary must give the identical verdict. The
		// generator emits none, and the failure mode of the whitespace branch is not a wrong answer but a
		// HANG: `\r` is in STRUCTURAL, so a scanner that stopped skipping it could not advance past one and
		// the outer loop would never end. A CRLF triggers.json is ordinary on Windows.
		const spaced = spaceOut(text, mulberry(seed ^ 0x5f5f));
		const foundSpaced = findDuplicateKey(spaced);
		assert.equal(foundSpaced ? foundSpaced.at : null, out.injected, `seed ${seed}: whitespace-injected`);
		// Re-serialising a document with no duplicate cannot introduce one, and must not change the verdict.
		if (out.injected === null) {
			assert.equal(findDuplicateKey(JSON.stringify(JSON.parse(text), null, 2)), null, `seed ${seed}: pretty-printed`);
		}
	}
	// The generator has to actually be generating both, or this passes by producing nothing interesting.
	assert.ok(checked > 2500, `too few documents survived the precondition: ${checked}`);
	assert.ok(withDuplicate > 300, `too few documents carried an injected duplicate: ${withDuplicate}`);
	// And a duplicate has to be found both ways a key is read, or one of them is checked by nothing here.
	assert.ok(out.slicedPairs > 50, `too few duplicates spelled without an escape on either side: ${out.slicedPairs}`);
	assert.ok(out.parsedPairs > 50, `too few duplicates spelled with an escape on a side: ${out.parsedPairs}`);
});

test("this module imports nothing", () => {
	// `triggers.mjs` is the shared validator: the receiver loads it and admin/build.mjs INLINES it into the
	// published console, so anything it reaches has to stay as cheap as a list of strings. Same rule as
	// reserved-env.mjs, provider-key.mjs and transient.mjs.
	const src = readFileSync(new URL("../src/json-duplicates.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "json-duplicates.mjs must stay import-free");
});
