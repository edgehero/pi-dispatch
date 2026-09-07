import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { defaultSettingsFile } from "../src/config.mjs";
import { KNOWN_KEYS, effectiveSettings, readOverlay, settingsFilePath, writeOverlay } from "../src/runtime-settings.mjs";

/**
 * A fake fs exposing only what the overlay module touches, with an ordered `ops` log so a test can
 * assert the write sequence (mkdir -> write tmp -> rename). Read side: `readFile` is the string
 * `readFileSync` returns; `readError` (a `{ code }`) makes it throw so the ENOENT-vs-other split is
 * testable. Write side: `mkdirThrows`/`writeThrows` exercise the never-throw posture, and
 * `renameErrors` is a list of `{ code }` thrown on successive `renameSync` calls -- `[{code:"EPERM"}]`
 * is the retry-once-then-succeed case, `[{code:"EPERM"},{code:"EPERM"}]` the retry-then-fail case.
 */
function makeFakeFs({ readFile = null, readError = null, mkdirThrows = false, writeThrows = false, renameErrors = [] } = {}) {
	const ops = [];
	let renameCall = 0;
	function fail(code, message) {
		const err = new Error(message ?? code);
		err.code = code;
		return err;
	}
	return {
		ops,
		readFileSync(path, enc) {
			ops.push({ op: "read", path, enc });
			if (readError) throw fail(readError.code, readError.message);
			return readFile;
		},
		mkdirSync(path, options) {
			ops.push({ op: "mkdir", path, options });
			if (mkdirThrows) throw fail("EACCES", "mkdir failed");
		},
		writeFileSync(path, data) {
			if (writeThrows) throw fail("ENOSPC", "write failed");
			ops.push({ op: "write", path, data });
		},
		renameSync(from, to) {
			ops.push({ op: "rename", from, to });
			const err = renameErrors[renameCall++];
			if (err) throw fail(err.code, err.message);
		},
	};
}

function readObj(obj, log = () => {}) {
	return readOverlay("/s/settings.json", { fs: makeFakeFs({ readFile: JSON.stringify(obj) }), log });
}

function readRaw(text, log = () => {}) {
	return readOverlay("/s/settings.json", { fs: makeFakeFs({ readFile: text }), log });
}

// ---- readOverlay: missing vs unreadable (the fail-closed distinction) ----

test("readOverlay: a missing file (ENOENT) is a normal empty overlay", () => {
	const res = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "ENOENT" } }) });
	assert.deepEqual(res, { overlay: {} });
});

test("readOverlay: an EACCES read error fails closed as invalid, distinct from ENOENT", () => {
	const enoent = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "ENOENT" } }) });
	const eacces = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "EACCES" } }) });
	assert.ok("overlay" in enoent && !("invalid" in enoent), "ENOENT -> empty overlay");
	assert.ok("invalid" in eacces && !("overlay" in eacces), "present-but-unreadable -> invalid, NOT an empty overlay");
});

// ---- readOverlay: parse / root shape ----

test("readOverlay: unparseable JSON is invalid", () => {
	const res = readRaw("{not valid json");
	assert.ok(res.invalid);
});

test("readOverlay: a non-object root (array, string, null) is invalid", () => {
	for (const text of ["[]", '"a string"', "null", "42"]) {
		assert.ok(readRaw(text).invalid, `root ${text} must be invalid`);
	}
});

// ---- readOverlay: each known key ----

test("readOverlay: valid known keys are accepted and returned as the overlay", () => {
	const obj = { model: "claude-x", provider: "anthropic", maxTurns: 12, dailyCap: 40, weeklyCap: 200, monthlyCap: 800, maxTokens: 500000, dailyTokenCap: 2000000, concurrency: 5, softHoldPct: 80 };
	assert.deepEqual(readObj(obj), { overlay: obj });
});

test("readOverlay: softHoldPct boundaries 1 and 99 are accepted", () => {
	assert.deepEqual(readObj({ softHoldPct: 1 }), { overlay: { softHoldPct: 1 } });
	assert.deepEqual(readObj({ softHoldPct: 99 }), { overlay: { softHoldPct: 99 } });
});

test("readOverlay: concurrency boundaries 1 and 10 are accepted", () => {
	assert.deepEqual(readObj({ concurrency: 1 }), { overlay: { concurrency: 1 } });
	assert.deepEqual(readObj({ concurrency: 10 }), { overlay: { concurrency: 10 } });
});

test("readOverlay: an invalid known key makes the whole file invalid; the reason names the key, not the value", () => {
	const cases = [
		{ obj: { model: 12345 }, key: "model", value: "12345" },
		{ obj: { model: "" }, key: "model", value: null },
		{ obj: { provider: false }, key: "provider", value: "false" },
		{ obj: { provider: "   " }, key: "provider", value: null },
		{ obj: { maxTurns: 0 }, key: "maxTurns", value: null },
		{ obj: { maxTurns: -3 }, key: "maxTurns", value: "-3" },
		{ obj: { maxTurns: 3.5 }, key: "maxTurns", value: "3.5" },
		{ obj: { maxTurns: "5" }, key: "maxTurns", value: "5" },
		{ obj: { dailyCap: 0 }, key: "dailyCap", value: null },
		{ obj: { dailyCap: -8 }, key: "dailyCap", value: "-8" },
		{ obj: { weeklyCap: 0 }, key: "weeklyCap", value: null },
			{ obj: { weeklyCap: 2.5 }, key: "weeklyCap", value: "2.5" },
			{ obj: { monthlyCap: -1 }, key: "monthlyCap", value: "-1" },
			{ obj: { maxTokens: 0 }, key: "maxTokens", value: null },
			{ obj: { maxTokens: -5 }, key: "maxTokens", value: "-5" },
			{ obj: { dailyTokenCap: 0 }, key: "dailyTokenCap", value: null },
			{ obj: { dailyTokenCap: 2.5 }, key: "dailyTokenCap", value: "2.5" },
			{ obj: { softHoldPct: 0 }, key: "softHoldPct", value: null },
			{ obj: { softHoldPct: 100 }, key: "softHoldPct", value: "100" },
			{ obj: { softHoldPct: 50.5 }, key: "softHoldPct", value: "50.5" },
			{ obj: { concurrency: 0 }, key: "concurrency", value: null },
		{ obj: { concurrency: 99 }, key: "concurrency", value: "99" },
		{ obj: { concurrency: 4.2 }, key: "concurrency", value: "4.2" },
	];
	for (const { obj, key, value } of cases) {
		const res = readObj(obj);
		assert.ok(res.invalid, `${JSON.stringify(obj)} must be invalid`);
		assert.ok(res.invalid.includes(key), `reason must name "${key}": got "${res.invalid}"`);
		if (value !== null) {
			assert.ok(!res.invalid.includes(value), `reason must NOT echo the offending value "${value}": got "${res.invalid}"`);
		}
	}
});

// ---- readOverlay: unknown keys ----

test("readOverlay: an unknown key is dropped and logged, known keys still apply, file stays valid", () => {
	const events = [];
	const res = readObj({ model: "claude-x", frobnicate: "yes" }, (event, fields) => events.push({ event, fields }));
	assert.deepEqual(res, { overlay: { model: "claude-x" } }, "unknown key excluded, known key kept");
	const unknown = events.find((e) => e.event === "settings_overlay_unknown_key");
	assert.ok(unknown, "unknown key is logged");
	assert.equal(unknown.fields.key, "frobnicate");
});

// ---- readOverlay: never throws ----

test("readOverlay never throws across the nasty corpus", () => {
	const fakes = [
		makeFakeFs({ readError: { code: "ENOENT" } }),
		makeFakeFs({ readError: { code: "EACCES" } }),
		makeFakeFs({ readError: { code: "EISDIR" } }),
		makeFakeFs({ readError: { code: undefined } }),
		makeFakeFs({ readFile: "{not json" }),
		makeFakeFs({ readFile: "[]" }),
		makeFakeFs({ readFile: "null" }),
		makeFakeFs({ readFile: JSON.stringify({ maxTurns: -1 }) }),
		makeFakeFs({ readFile: JSON.stringify({ model: 5 }) }),
		makeFakeFs({ readFile: JSON.stringify({ concurrency: 50 }) }),
		makeFakeFs({ readFile: JSON.stringify({ unknown: 1 }) }),
	];
	for (const fs of fakes) {
		assert.doesNotThrow(() => readOverlay("/s/settings.json", { fs }));
	}
});

// ---- effectiveSettings ----

test("effectiveSettings: overlay wins where set, config fills the rest, result has exactly ten keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null, valkeyUrl: "x", jobImage: "y" };
	const res = effectiveSettings(config, { model: "ovl-model", dailyCap: 5, weeklyCap: 100, softHoldPct: 80, maxTokens: 500000, dailyTokenCap: 2000000 });
	assert.equal(res.model, "ovl-model", "overlay wins");
	assert.equal(res.dailyCap, 5, "overlay wins");
	assert.equal(res.weeklyCap, 100, "overlay sets an otherwise-disabled window");
	assert.equal(res.softHoldPct, 80, "overlay sets the soft-hold band");
	assert.equal(res.maxTokens, 500000, "overlay sets the otherwise-disabled per-job token budget");
	assert.equal(res.dailyTokenCap, 2000000, "overlay sets the otherwise-disabled daily token cap");
	assert.equal(res.provider, "anthropic", "absent overlay key falls to config");
	assert.equal(res.maxTurns, 30, "absent overlay key falls to config");
	assert.equal(res.monthlyCap, null, "absent overlay key falls to config's null (disabled)");
	assert.equal(res.concurrency, 3, "absent overlay key falls to config");
	assert.deepEqual(Object.keys(res).sort(), ["concurrency", "dailyCap", "dailyTokenCap", "maxTokens", "maxTurns", "model", "monthlyCap", "provider", "softHoldPct", "weeklyCap"]);
});

test("effectiveSettings: an empty overlay yields the config values verbatim for all ten keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null };
	assert.deepEqual(effectiveSettings(config, {}), config);
});

// ---- writeOverlay ----

test("writeOverlay: happy path ensures the dir, writes a same-dir tmp, then renames over the target", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { model: "m", concurrency: 4 }, { fs });
	assert.deepEqual(res, { ok: true });

	const seq = fs.ops.map((o) => o.op);
	assert.deepEqual(seq, ["mkdir", "write", "rename"], "order is mkdir -> write -> rename");

	const mkdir = fs.ops.find((o) => o.op === "mkdir");
	assert.equal(mkdir.options.recursive, true, "mkdirSync is recursive");

	const write = fs.ops.find((o) => o.op === "write");
	assert.equal(write.path, "/s/settings.json.tmp", "tmp is the target + .tmp");
	assert.equal(dirname(write.path), dirname("/s/settings.json"), "tmp is a same-directory sibling");
	assert.equal(write.data, `${JSON.stringify({ model: "m", concurrency: 4 }, null, 2)}\n`, "2-space indent + trailing newline");

	const rename = fs.ops.find((o) => o.op === "rename");
	assert.equal(rename.from, "/s/settings.json.tmp");
	assert.equal(rename.to, "/s/settings.json");
});

test("writeOverlay: an empty candidate is valid and writes {}", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", {}, { fs });
	assert.deepEqual(res, { ok: true });
	assert.equal(fs.ops.find((o) => o.op === "write").data, "{}\n");
});

test("writeOverlay: EPERM on rename is retried once and then succeeds", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EPERM" }] });
	const res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	assert.deepEqual(res, { ok: true });
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 2, "rename retried exactly once");
});

test("writeOverlay: EPERM twice returns invalid, not a throw", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EPERM" }, { code: "EPERM" }] });
	let res;
	assert.doesNotThrow(() => {
		res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	});
	assert.ok(res.invalid, "second EPERM surfaces as invalid");
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 2, "one retry, then give up");
});

test("writeOverlay: an invalid candidate returns invalid and touches no file at all", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { maxTurns: 0 }, { fs });
	assert.ok(res.invalid);
	assert.ok(res.invalid.includes("maxTurns"));
	assert.equal(fs.ops.length, 0, "no mkdir, no write, no rename when the candidate is invalid");
});

test("writeOverlay: a same-key contract is enforced -- concurrency 11 is rejected before any write", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { concurrency: 11 }, { fs });
	assert.ok(res.invalid);
	assert.equal(fs.ops.length, 0);
});

test("writeOverlay: a non-EPERM rename error is not retried and returns invalid", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EXDEV" }] });
	const res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	assert.ok(res.invalid);
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 1, "a non-EPERM failure is terminal");
});

test("writeOverlay never throws when mkdir or write fails", () => {
	assert.doesNotThrow(() => {
		const res = writeOverlay("/s/settings.json", { model: "m" }, { fs: makeFakeFs({ mkdirThrows: true }) });
		assert.ok(res.invalid);
	});
	assert.doesNotThrow(() => {
		const res = writeOverlay("/s/settings.json", { model: "m" }, { fs: makeFakeFs({ writeThrows: true }) });
		assert.ok(res.invalid);
	});
});

// ---- KNOWN_KEYS ----

test("KNOWN_KEYS is exported and lists exactly the ten overlay keys", () => {
	assert.deepEqual(
		[...KNOWN_KEYS].sort(),
		["concurrency", "dailyCap", "dailyTokenCap", "maxTokens", "maxTurns", "model", "monthlyCap", "provider", "softHoldPct", "weeklyCap"],
	);
});

// ---- settingsFilePath ----

test("settingsFilePath: PI_SETTINGS_FILE wins when set", () => {
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "/abs/custom.json" }), "/abs/custom.json");
});

test("settingsFilePath: unset or empty falls back to the shared DURABLE default", () => {
	assert.equal(settingsFilePath({}), defaultSettingsFile());
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "" }), defaultSettingsFile());
	assert.ok(settingsFilePath({}).endsWith(".pi-dispatch/settings.json"), "default sits under the durable state root (issue #290)");
	// The seam the worker never uses and doctor depends on: an injected home must reach the default.
	assert.equal(settingsFilePath({}, "/home/u"), "/home/u/.pi-dispatch/settings.json");
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "/abs/x.json" }, "/home/u"), "/abs/x.json", "an explicit path still wins over any home");
});
