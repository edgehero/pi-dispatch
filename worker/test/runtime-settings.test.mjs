import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { defaultSettingsFile } from "../src/config.mjs";
import { KNOWN_KEYS, effectiveSettings, readOverlay, resolveSettings, settingsFilePath, writeOverlay } from "../src/runtime-settings.mjs";

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

// ---- the dollar keys (issue #501) ----

test("readOverlay: maxCostUsd is accepted as a decimal string or a number and kept AS WRITTEN", () => {
	assert.deepEqual(readObj({ maxCostUsd: "2.50" }), { overlay: { maxCostUsd: "2.50" } });
	assert.deepEqual(readObj({ maxCostUsd: 2.5 }), { overlay: { maxCostUsd: 2.5 } });
	assert.deepEqual(readObj({ maxCostUsd: "0.000001" }), { overlay: { maxCostUsd: "0.000001" } });
	assert.deepEqual(readObj({ maxCostUsd: 1000000 }), { overlay: { maxCostUsd: 1000000 } });
});

test("readOverlay: a malformed maxCostUsd fails the WHOLE overlay, naming the key and never the value", () => {
	for (const bad of [0, "0", -1, "1.1234567", 1e-7, "abc", true, null, [], 1000001]) {
		const res = readObj({ maxCostUsd: bad, dailyCap: 5 });
		assert.ok(res.invalid, `${JSON.stringify(bad)} must be invalid`);
		assert.match(res.invalid, /^maxCostUsd must be a dollar amount/);
		assert.equal(res.overlay, undefined, "no partial overlay");
	}
	assert.equal(readObj({ maxCostUsd: "sk-ant-secret" }).invalid.includes("sk-ant"), false);
});

test("readOverlay: a dollar WINDOW is accepted and kept AS WRITTEN, and a malformed one is refused by name (issue #501)", () => {
	for (const key of ["dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]) {
		assert.deepEqual(readObj({ [key]: "25", maxCostUsd: "2" }), { overlay: { [key]: "25", maxCostUsd: "2" } }, `${key} with a cap`);
		assert.deepEqual(readObj({ [key]: 25.5 }), { overlay: { [key]: 25.5 } }, `${key} alone passes the per-key check; the merged-values invariant is resolveSettings'`);
		assert.match(readObj({ [key]: "nope" }).invalid, new RegExp(`^${key} must be a dollar amount`), `${key} malformed is named as malformed`);
		assert.equal(readObj({ [key]: "sk-ant-secret" }).invalid.includes("sk-ant"), false, "never the value");
	}
});

test("readOverlay: a near miss of a dollar key (case, separator, look-alike letters, wrong names) is refused by name, never dropped (#501)", () => {
	for (const [key, meant] of [["maxcostusd", "maxCostUsd"], ["MaxCostUsd", "maxCostUsd"], ["max_cost_usd", "maxCostUsd"], ["max-cost-usd", "maxCostUsd"], ["maxCostUSD", "maxCostUsd"], ["maxCost", "maxCostUsd"], ["daily_cost_usd", "dailyCostUsd"], ["WeeklyCostUsd", "weeklyCostUsd"], ["monthlyCost", "monthlyCostUsd"], ["max\u0421ostUsd", "maxCostUsd"], ["d\u0430ilyCostUsd", "dailyCostUsd"], ["PI_MAX_COST_USD", "maxCostUsd"], ["maxCostMicros", "maxCostUsd"], ["costUsd", "maxCostUsd"], ["PI_WEEKLY_COST_USD", "weeklyCostUsd"], ["MAX_COST_USD", "maxCostUsd"], ["PI_DAILY_COST_USD", "dailyCostUsd"], ["pi.monthly.cost.usd", "monthlyCostUsd"], ["m\u03B1xCostUsd", "maxCostUsd"], ["\uFF4D\uFF41\uFF58CostUsd", "maxCostUsd"]]) {
		const res = readObj({ [key]: "2" });
		assert.ok((res.invalid ?? "").startsWith(`${key} is not a settings key -- did you mean ${meant}?`), `${key}: ${res.invalid}`);
	}
	// Any other unknown key keeps the forward-compatible drop-and-log. The rule is an EXACT match after the shape
	// (case, separators, a fixed look-alike table), so a key with any other non-ASCII letter, or a different word, can
	// never refuse the file: a false refusal here would stop every job.
	for (const key of ["temperature", "host_\u00FC", "not\u00E9s", "maxCostCents", "maxCostUsdx", "max\u00FCCostUsd", "\u00FCmaxCostUsd"]) {
		const logged = [];
		assert.deepEqual(readObj({ [key]: 1, dailyCap: 3 }, (event, f) => logged.push([event, f])), { overlay: { dailyCap: 3 } }, key);
		assert.deepEqual(logged, [["settings_overlay_unknown_key", { key }]], key);
	}
});

test("readOverlay: a duplicate key is refused, naming the key and never a value (#501)", () => {
	const res = readRaw('{"maxCostUsd":"1","maxCostUsd":"999"}');
	assert.match(res.invalid, /^settings file has a duplicate key "maxCostUsd"/);
	assert.equal(res.invalid.includes("999"), false);
	assert.match(readRaw('{"dailyCap":1,"dailyCap":2}').invalid, /duplicate key "dailyCap"/);
	// A file writeOverlay wrote never has one: it serialises an object.
	const fs = makeFakeFs();
	writeOverlay("/s/settings.json", { maxCostUsd: "1", dailyCap: 2 }, { fs });
	const written = fs.ops.find((o) => o.op === "write").data;
	assert.deepEqual(readRaw(written), { overlay: { maxCostUsd: "1", dailyCap: 2 } });
});

test("writeOverlay: a dollar window is written like any other key, and a malformed one is refused at the WRITE (issue #501)", () => {
	const fs = makeFakeFs();
	assert.deepEqual(writeOverlay("/s/settings.json", { dailyCostUsd: "25", maxCostUsd: "2" }, { fs }), { ok: true });
	assert.deepEqual(JSON.parse(fs.ops.find((o) => o.op === "write").data), { dailyCostUsd: "25", maxCostUsd: "2" });
	const bad = makeFakeFs();
	assert.match(writeOverlay("/s/settings.json", { weeklyCostUsd: "1.1234567", maxCostUsd: "2" }, { fs: bad }).invalid, /^weeklyCostUsd must be a dollar amount/);
	assert.deepEqual(bad.ops, [], "nothing touched");
});

test("resolveSettings: the dollar invariant runs on MERGED values, never on the overlay alone", () => {
	const config = { provider: "p", model: "m", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: null, dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null };
	// The inputs are passed as already validated. The windows are enforced (issue #501), so a window reaches here
	// from either source, and the cross-key rule must not be a per-key check.
	for (const window of ["dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]) {
		// A window in the overlay, the cap in env: valid. A per-key check of the overlay would refuse it.
		const ok = resolveSettings({ ...config, maxCostUsd: "2" }, { overlay: { [window]: "25" } });
		assert.equal(ok.invalid, undefined, `${window} in the overlay, cap in env`);
		assert.equal(ok[window], "25");
		// A window in env, the cap in the overlay: valid too.
		assert.equal(resolveSettings({ ...config, [window]: "25" }, { overlay: { maxCostUsd: 2 } }).invalid, undefined, `${window} in env, cap in the overlay`);
		// Neither source has a cap: invalid, by the window's name.
		assert.match(resolveSettings(config, { overlay: { [window]: "25" } }).invalid, new RegExp(`^${window} needs maxCostUsd`));
		assert.match(resolveSettings({ ...config, [window]: "25" }, { overlay: {} }).invalid, new RegExp(`^${window} needs maxCostUsd`));
	}
});

test("resolveSettings: an invalid read passes through; a valid one is the effective settings plus secretProfiles", () => {
	const config = { provider: "p", model: "m", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: "5", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null };
	assert.deepEqual(resolveSettings(config, { invalid: "settings file is not valid JSON" }), { invalid: "settings file is not valid JSON" });
	assert.deepEqual(resolveSettings(config, { overlay: {} }), { ...config, secretProfiles: {} });
	assert.deepEqual(resolveSettings(config, { overlay: { maxCostUsd: "1", secretProfiles: { a: "/x" } } }), { ...config, maxCostUsd: "1", secretProfiles: { a: "/x" } });
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

// FOURTEEN since issue #501 (was ten): the four dollar keys resolve overlay > env like every other key. The
// pins below moved with the reason, not around it: the key set is still exact, and an empty overlay still
// returns the config verbatim.
test("effectiveSettings: overlay wins where set, config fills the rest, result has exactly fourteen keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: "5", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null, valkeyUrl: "x", jobImage: "y" };
	const res = effectiveSettings(config, { model: "ovl-model", dailyCap: 5, weeklyCap: 100, softHoldPct: 80, maxTokens: 500000, dailyTokenCap: 2000000, maxCostUsd: 1.25 });
	assert.equal(res.maxCostUsd, 1.25, "the overlay's dollar cap wins over env's, as written");
	assert.equal(res.weeklyCostUsd, null, "an absent dollar window falls to config's null");
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
	assert.deepEqual(Object.keys(res).sort(), ["concurrency", "dailyCap", "dailyCostUsd", "dailyTokenCap", "maxCostUsd", "maxTokens", "maxTurns", "model", "monthlyCap", "monthlyCostUsd", "provider", "softHoldPct", "weeklyCap", "weeklyCostUsd"]);
});

test("effectiveSettings: an empty overlay yields the config values verbatim for all fourteen keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, dailyCap: 25, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: "2.50", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null };
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

test("KNOWN_KEYS is exported and lists exactly the fourteen overlay keys (the four dollar keys since issue #501)", () => {
	assert.deepEqual(
		[...KNOWN_KEYS].sort(),
		["concurrency", "dailyCap", "dailyCostUsd", "dailyTokenCap", "maxCostUsd", "maxTokens", "maxTurns", "model", "monthlyCap", "monthlyCostUsd", "provider", "softHoldPct", "weeklyCap", "weeklyCostUsd"],
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

test("writeOverlay into the per-account temp root (the no-home default) refuses a root another account owns, and writes nothing (#464)", () => {
	const writes = [];
	const tmp = process.env.TMPDIR?.trim() ? process.env.TMPDIR.trim().replace(/(?!^)\/+$/, "") : "/tmp";
	const root = `${tmp}/pi-dispatch-${process.geteuid()}`;
	const owner = (uid) => ({
		mkdirSync: () => {},
		lstatSync: () => ({ uid, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 }),
		statSync: () => ({ uid, isDirectory: () => true }),
		chmodSync: () => {},
		writeFileSync: (p) => writes.push(p),
		renameSync: (a, b) => writes.push(b),
	});
	const theirs = writeOverlay(`${root}/settings.json`, { model: "m" }, { fs: owner(process.geteuid() + 1) });
	assert.match(theirs.invalid, new RegExp(`^settings dir refused: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is owned by uid ${process.geteuid() + 1}, not by this account`));
	assert.deepEqual(writes, []);
	assert.deepEqual(writeOverlay(`${root}/settings.json`, { model: "m" }, { fs: owner(process.geteuid()) }), { ok: true });
	assert.ok(writes.includes(`${root}/settings.json`));
});
