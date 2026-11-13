import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DOCTOR_RESULTS_TTL_MS } from "../src/doctor-results.mjs";
import { buildHostLoads, FLOW_BASIS_HEX, FLOW_INPUT_FIELDS, flowBasisOf, flowInputOf, flowProbes, flowTierOf, HOST_LOADS_CAPS, HOST_LOADS_MAX_BYTES, HOST_LOADS_OLD_INTERVALS, HOST_LOADS_PARTS, HOST_LOADS_VERSION, hostLoadsKey, hostsAgree, LOADS_EXTENSION_KINDS, LOADS_FLOW_TIERS, LOADS_IGNORE_FILES, LOADS_REPO_STATES, loadsFreshness, mcpRowsOf, parseHostLoads, pathIsThere, publishHostLoads, readHostLoads, readOverlayExtensionRows, readOverlaySkillNames } from "../src/host-loads.mjs";
import { ABSENT_CODES, parseOverlayMcp } from "../src/mcp-config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #800, INT-DOCTOR-RESULTS-KEY's `doctor:loads:<name>`. Every clock here is injected: a record's age is the point.
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
/** Every name at its longest at every cap, fitted to the bound: measured, and said in the contract. */
const WORST_BYTES = 65_493;
const FLOWS_KEPT = 39;
const HOUR = 3_600_000;
const PARTS = {
	extensions: [{ name: "git-guard.ts", kind: "file" }],
	skills: ["deploy"],
	mcp: [{ name: "linear", transport: "http", where: "mcp.linear.app", exposure: "codemode", enabled: true, keys: ["LINEAR_KEY"] }],
	packages: [{ name: "pi-lint", version: "1.4.2" }],
	flows: [{ trigger: 3, flow: "fix", tier: "overlay", package: null, repo: "unknown", basis: flowBasisOf({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }) }],
};
const record = (over = {}) => buildHostLoads({ at: NOW, every: 24, by: { uid: 501, worker: true }, overlayExtensionsAllowed: true, ...PARTS, ...over });
const rowOf = (over = {}, { name = "mini1", at = NOW } = {}) => ({ name, state: "current", ...parseHostLoads(JSON.stringify(record({ at, ...over }))) });

/** A fake Valkey holding `values` under their keys, with the doctor's index. Records its commands. */
function fakeRedis(values = {}, { index = Object.keys(values).map((key) => key.split(":")[2]), fail = {} } = {}) {
	const calls = [];
	return {
		calls,
		set: async (...args) => {
			calls.push(["set", ...args]);
			if (fail.set) throw new Error("no write");
			return "OK";
		},
		smembers: async () => {
			calls.push(["smembers"]);
			if (fail.smembers) throw new Error("index down");
			return index;
		},
		mget: async (...keys) => {
			calls.push(["mget", ...keys]);
			if (fail.mget) throw new Error("mget down");
			return keys.map((key) => values[key] ?? null);
		},
	};
}

test("the record: the shape the contract names, and an empty `more`", () => {
	assert.deepEqual(record(), {
		v: 1,
		at: NOW,
		every: 24,
		by: { uid: 501, worker: true },
		overlayExtensionsAllowed: true,
		extensions: [{ name: "git-guard.ts", kind: "file" }],
		skills: ["deploy"],
		mcp: [{ name: "linear", transport: "http", where: "mcp.linear.app", exposure: "codemode", enabled: true, keys: ["LINEAR_KEY"] }],
		packages: [{ name: "pi-lint", version: "1.4.2" }],
		flows: [{ trigger: 3, flow: "fix", tier: "overlay", package: null, repo: "unknown", basis: "889e51f3" }],
		more: {},
	});
});

test("the key, its one write and its expiry: one SET ... PX, seven days, and only a worker name is a key segment", async () => {
	const redis = fakeRedis();
	await publishHostLoads(redis, "mini1", record());
	assert.deepEqual(redis.calls.map(([command]) => command), ["set"], "no index write: the doctor record's write has just made this host a member");
	const [, key, text, px, ttl] = redis.calls[0];
	assert.equal(key, "doctor:loads:mini1");
	assert.equal(key, hostLoadsKey("mini1"));
	assert.deepEqual(JSON.parse(text), record());
	assert.equal(px, "PX");
	assert.equal(ttl, DOCTOR_RESULTS_TTL_MS);
	assert.equal(ttl, 7 * 24 * HOUR);
	for (const bad of ["a b", "x/y", "", null, "../x"]) await assert.rejects(publishHostLoads(fakeRedis(), bad, record()), /not a worker name/, String(bad));
	await assert.rejects(publishHostLoads(fakeRedis({}, { fail: { set: true } }), "mini1", record()), /no write/, "the caller is best effort, and hears it");
});

test("no path and no value reaches the bytes, by any part of a real overlay's files", () => {
	const SECRET_TOKEN = "sk-live-0123456789abcdef";
	const mcp = parseOverlayMcp(JSON.stringify({ mcpServers: {
		linear: { url: "https://mcp.linear.app/secret-path/${LINEAR_KEY}?token=${QUERY_TOKEN}", description: "the description is prose", headers: { Authorization: "Bearer ${HEADER_TOKEN}" } },
		runner: { command: "/opt/tools/bin/secret-server", args: ["--flag=literal-value", "--token=${ARG_TOKEN}"], env: { API_KEY: "${ENV_KEY}" }, description: "x" },
	} }));
	assert.deepEqual(mcp.refused, []);
	const rows = mcpRowsOf(mcp.servers);
	assert.deepEqual(rows[0], { name: "linear", transport: "http", where: "mcp.linear.app", exposure: "codemode", enabled: true, keys: ["HEADER_TOKEN", "LINEAR_KEY", "QUERY_TOKEN"] });
	const bytes = JSON.stringify(buildHostLoads({ at: NOW, mcp: rows, extensions: [{ name: "/etc/passwd", kind: "file" }, { name: "../x.ts", kind: "file" }, { name: "ok.ts", kind: "file" }, { name: SECRET_TOKEN.replace(/-/g, " "), kind: "file" }], skills: ["../evil", "/abs", "fine"], packages: [{ name: "/path/x", version: "1.0.0" }, { name: "pi-x", version: "not a version" }, { name: "pi-y", version: "1.0.0" }], flows: [{ trigger: 1, flow: "/etc/shadow", tier: "repository", package: null, repo: "present" }, { trigger: -1, flow: "a", tier: "repository", package: null, repo: "present" }, { trigger: 2, flow: "b", tier: "made-up", package: null, repo: "present" }, { trigger: 3, flow: "c", tier: "overlay", package: "pi-x", repo: "unknown" }] }));
	for (const leak of ["secret-path", "Bearer", "literal-value", "--token", "--flag", "/opt/tools", "/etc/", "../", "the description", SECRET_TOKEN, "sk-live", "not a version", "made-up"]) assert.ok(!bytes.includes(leak), `${leak} reached the bytes: ${bytes}`);
	assert.doesNotMatch(bytes, /"(?:\/|[A-Za-z]:\\\\)[^"]*"/, "no absolute path anywhere in it");
	const parsed = JSON.parse(bytes);
	assert.deepEqual(parsed.extensions, [{ name: "ok.ts", kind: "file" }]);
	assert.deepEqual(parsed.skills, ["fine"]);
	assert.deepEqual(parsed.packages, [{ name: "pi-y", version: "1.0.0" }]);
	assert.deepEqual(parsed.flows, []);
	assert.deepEqual(parsed.more, { extensions: 3, skills: 2, packages: 2, flows: 4 }, "what its charset refused is counted, never dropped silently");
	assert.equal(parsed.mcp[1].where, "secret-server", "a command's base name, never its folder");
	// A host holding a secret in a url's host: the redactor is doctor's, the same one its labels pass.
	const redacted = mcpRowsOf({ s: { transport: "http", url: `https://${SECRET_TOKEN}.example.com/` } }, { redact: (text) => text.replace(SECRET_TOKEN, "[redacted]") });
	assert.equal(redacted[0].where, null);
});

test("each list has its cap, the rest counted in `more`, and the whole record its bound", () => {
	const big = (name, i) => `${name}${String(i).padStart(3, "0")}`;
	const all = buildHostLoads({
		at: NOW,
		extensions: Array.from({ length: 40 }, (_, i) => ({ name: big("e", i), kind: "file" })),
		skills: Array.from({ length: 70 }, (_, i) => big("s", i)),
		mcp: Array.from({ length: 35 }, (_, i) => ({ name: big("m", i), transport: "stdio", where: "x", exposure: "direct", enabled: true, keys: ["A", "B", "C", "D", "E", "F"] })),
		packages: Array.from({ length: 70 }, (_, i) => ({ name: big("p", i), version: "1.0.0" })),
		flows: Array.from({ length: 130 }, (_, i) => ({ trigger: i, flow: "fix", tier: "overlay", package: null, repo: "unknown" })),
	});
	assert.equal(all.extensions.length, HOST_LOADS_CAPS.extensions);
	assert.equal(all.skills.length, HOST_LOADS_CAPS.skills);
	assert.equal(all.mcp.length, HOST_LOADS_CAPS.mcp);
	assert.equal(all.mcp[0].keys.length, HOST_LOADS_CAPS.keys);
	assert.equal(all.packages.length, HOST_LOADS_CAPS.packages);
	assert.equal(all.flows.length, HOST_LOADS_CAPS.flows);
	assert.deepEqual(all.more, { extensions: 8, skills: 6, mcp: 3, keys: 64, packages: 6, flows: 2 });
	assert.deepEqual(HOST_LOADS_CAPS, { extensions: 32, skills: 64, mcp: 32, keys: 4, packages: 64, flows: 128 });

	// Every name at its longest: the caps alone are over the bound, so rows go until it holds, each one counted.
	const worst = buildHostLoads({
		at: Number.MAX_SAFE_INTEGER,
		every: 168,
		by: { uid: Number.MAX_SAFE_INTEGER, worker: true },
		extensions: Array.from({ length: 32 }, (_, i) => ({ name: big("e", i).padEnd(48, "x"), kind: "file" })),
		skills: Array.from({ length: 64 }, (_, i) => big("s", i).padEnd(64, "x")),
		mcp: Array.from({ length: 32 }, (_, i) => ({ name: big("m", i).padEnd(32, "x"), transport: "stdio", where: "w".repeat(255), exposure: "codemode", enabled: true, keys: Array.from({ length: 4 }, (_, k) => `K${k}`.padEnd(64, "Y")) })),
		packages: Array.from({ length: 64 }, (_, i) => ({ name: big("p", i).padEnd(214, "x"), version: `1.0.0-${"r".repeat(122)}` })),
		// Each row with its basis (issue #869), which every doctor since writes: 19 bytes a row, two rows fewer kept than without.
		flows: Array.from({ length: 128 }, (_, i) => ({ trigger: 999_999 - i, flow: "f".repeat(64), tier: "package", package: "p".repeat(214), repo: "unknown", basis: "f".repeat(FLOW_BASIS_HEX) })),
	});
	const bytes = Buffer.byteLength(JSON.stringify(worst), "utf8");
	assert.ok(bytes <= HOST_LOADS_MAX_BYTES, `the worst record is ${bytes} bytes`);
	assert.ok(bytes > HOST_LOADS_MAX_BYTES - 1024, "and the fit stops as soon as it holds");
	assert.equal(HOST_LOADS_MAX_BYTES, 64 * 1024);
	assert.equal(worst.mcp.length, 32, "a server is the last thing to go");
	assert.equal(worst.extensions.length, 32);
	assert.equal(worst.skills.length, 64);
	assert.ok(worst.flows.length < 128 || worst.packages.length < 64);
	assert.equal(worst.flows.length + worst.more.flows, 128, "each row dropped is counted");
	assert.equal((worst.packages.length) + (worst.more.packages ?? 0), 64);
	assert.ok(parseHostLoads(JSON.stringify(worst)) !== null, "and it still parses");
	assert.equal(hostsAgree([{ name: "a", state: "current", ...parseHostLoads(JSON.stringify(worst)) }]), null, "a record that lists less than the host has can say nothing is the same");
	assert.deepEqual([worst.flows.length, worst.more.flows, worst.packages.length, worst.more.packages], [FLOWS_KEPT, 128 - FLOWS_KEPT, 64, undefined], "measured: the flows go first");
	assert.equal(bytes, WORST_BYTES);
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	// With its citation, which only the contract's own sentence has: a revision row quoting the number kept this green while the
	// sentence said something else (the same fix as the run record's bolt in loaded-record.test.mjs).
	assert.ok(spec.includes(`Worst case measured: ${WORST_BYTES.toLocaleString("en-US")} bytes, with ${FLOWS_KEPT} flow rows kept (\`worker/test/host-loads.test.mjs\`)`), `INT-DOCTOR-RESULTS-KEY says the measured worst case (${bytes} bytes)`);
});

test("INT-DOCTOR-RESULTS-KEY's lists say what this module holds: the caps, what `more` counts, each closed word, the expiry and the bound", () => {
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const start = spec.indexOf("**What a host's jobs can load** (issue #800");
	const section = spec.slice(start, spec.indexOf("- **Acceptance**", start)).replace(/\s+/g, " ");
	assert.ok(start > 0 && section.length > 0);
	const quoted = (words) => words.map((word) => `\`${word}\``);
	const inProse = (words, last = " or ") => `${quoted(words).slice(0, -1).join(", ")}${last}${quoted(words).at(-1)}`;
	const { extensions, skills, mcp, keys, packages, flows } = HOST_LOADS_CAPS;
	assert.ok(section.includes(`**Bounded**: ${extensions} extensions, ${skills} skills, ${mcp} servers with ${keys} keys each, ${packages} packages, ${flows} flows, each counted past its cap in \`more\``), "every cap");
	assert.ok(section.includes(`\`more\` (${quoted(Object.keys(HOST_LOADS_CAPS)).join(", ")}, a key only when above 0)`), "`more` counts each list and the keys");
	assert.ok(section.includes(`${HOST_LOADS_MAX_BYTES / 1024} KiB in all (\`HOST_LOADS_MAX_BYTES\`)`), "the whole record's bound");
	assert.ok(section.includes(`\`tier\`, one of ${quoted(LOADS_FLOW_TIERS).join(", ")};`), "every flow tier, in the module's order");
	assert.ok(section.includes(`\`repo\` what that tier answered, ${inProse(LOADS_REPO_STATES)}`), "what the repository tier answers");
	assert.ok(section.includes(`each a first path segment and ${inProse(LOADS_EXTENSION_KINDS)}`), "an extension's two kinds");
	assert.ok(section.includes(`SET <key> <json> PX ${DOCTOR_RESULTS_TTL_MS} (7 days)`), "the expiry");
	assert.equal(DOCTOR_RESULTS_TTL_MS, 7 * 24 * HOUR);
	assert.ok(section.includes(`{"v":${HOST_LOADS_VERSION},"at":0,`), "the version in the record's example");
	const unread = section.slice(section.indexOf("**`unread`**"), section.indexOf("Only `ENOENT`"));
	for (const part of HOST_LOADS_PARTS) assert.ok(unread.includes(`\`${part}\``), `\`unread\` does not name ${part}`);
	assert.ok(section.includes("Past two of its host's own intervals a record is `old`"));
	assert.equal(HOST_LOADS_OLD_INTERVALS, 2);
	// The record's example holds every list, and a row of each kind, by the keys the builder writes.
	const example = JSON.parse(spec.slice(spec.indexOf('{"v":1,"at":0,"every":24,'), spec.indexOf('"more":{}}', spec.indexOf('{"v":1,"at":0,"every":24,')) + '"more":{}}'.length).replace(/\n\s*/g, ""));
	const built = record();
	assert.deepEqual(Object.keys(example).filter((key) => key !== "unread"), Object.keys(built));
	for (const list of ["extensions", "mcp", "packages", "flows"]) assert.deepEqual(Object.keys(example[list][0]), Object.keys(built[list][0]), list);
});

test("the parser is an allowlist: an unknown key is not read, and a row that fails is dropped and counted", () => {
	const parsed = parseHostLoads(JSON.stringify({ ...record(), secret: "SECRET", extensions: [{ name: "ok.ts", kind: "file", path: "/etc/x" }, { name: "/etc/x", kind: "file" }, "x"], mcp: [{ ...PARTS.mcp[0], url: "https://secret" }], packages: [{ name: "pi-a", version: "1.0.0", dir: "/x" }], skills: [7], flows: [{ ...PARTS.flows[0], folder: "/srv" }], unread: ["mcp"], junk: 4, more: { extensions: 1 } }));
	assert.deepEqual(parsed.extensions, [{ name: "ok.ts", kind: "file" }]);
	assert.deepEqual(parsed.mcp, PARTS.mcp);
	assert.deepEqual(parsed.packages, [{ name: "pi-a", version: "1.0.0" }]);
	assert.deepEqual(parsed.skills, []);
	assert.deepEqual(parsed.flows, PARTS.flows);
	assert.deepEqual(parseHostLoads(JSON.stringify({ ...record(), extensions: [{ name: "..", kind: "dir" }, { name: ".", kind: "dir" }] })).extensions, [], "never a path's parts");
	assert.deepEqual(parsed.unread, ["mcp"]);
	assert.deepEqual(parsed.more, { extensions: 3, skills: 1 }, "what the host said was past its cap, and what this reader refused");
	assert.doesNotMatch(JSON.stringify(parsed), /SECRET|\/etc\/x|https:\/\/secret|"\/x"|\/srv|junk/);
	for (const notOne of ["{", "null", "[]", "7", JSON.stringify({ ...record(), v: 2 }), JSON.stringify({ ...record(), v: "1" }), JSON.stringify({ ...record(), v: 0 }), JSON.stringify({ ...record(), at: "x" }), JSON.stringify({ ...record(), at: -1 })]) assert.equal(parseHostLoads(notOne), null, notOne);
});

test("a record with no shape does not read: unknown, never an empty current host that agrees with a real one", async () => {
	// Regression: this parsed as a host with nothing on it, off, and said "the same" of one.
	const shapeless = '{"v":1,"at":1000}';
	assert.equal(parseHostLoads(shapeless), null);
	const real = { name: "real", state: "current", ...parseHostLoads(JSON.stringify(buildHostLoads({ at: 1000, overlayExtensionsAllowed: false }))) };
	const read = await readHostLoads(fakeRedis({ [hostLoadsKey("bare")]: shapeless }), { now: () => 1000 });
	assert.deepEqual(read.hosts, [{ name: "bare", state: "unknown", why: "unreadable" }]);
	assert.equal(hostsAgree([real, ...read.hosts]), null, "never the same");

	// One part at a time, so each list and the switch is a reason of its own.
	const good = record({ more: undefined });
	const without = (part) => {
		const copy = { ...good };
		delete copy[part];
		return copy;
	};
	for (const part of ["extensions", "skills", "mcp", "packages", "flows"]) {
		assert.equal(parseHostLoads(JSON.stringify(without(part))), null, `${part} missing`);
		for (const wrong of [null, "x", 7, {}, true]) assert.equal(parseHostLoads(JSON.stringify({ ...good, [part]: wrong })), null, `${part} as ${JSON.stringify(wrong)}`);
	}
	assert.equal(parseHostLoads(JSON.stringify(without("overlayExtensionsAllowed"))), null, "the switch missing");
	for (const wrong of [null, "true", 1, 0, []]) assert.equal(parseHostLoads(JSON.stringify({ ...good, overlayExtensionsAllowed: wrong })), null, `the switch as ${JSON.stringify(wrong)}`);
	assert.equal(parseHostLoads(JSON.stringify({ ...good, overlayExtensionsAllowed: false })).overlayExtensionsAllowed, false, "a real off stays off");

	// What would otherwise read as "nothing left out", "nothing unread" or "never old".
	assert.equal(parseHostLoads(JSON.stringify(without("more"))), null, "no `more`: whether anything was left out is not known");
	for (const more of [null, 7, "x", [], { flows: "x" }, { keys: -1 }, { mcp: 1.5 }]) assert.equal(parseHostLoads(JSON.stringify({ ...good, more })), null, `more ${JSON.stringify(more)}`);
	for (const unread of [null, "mcp", 7, {}, ["made-up"], ["mcp", "made-up"]]) assert.equal(parseHostLoads(JSON.stringify({ ...good, unread })), null, `unread ${JSON.stringify(unread)}`);
	assert.deepEqual(parseHostLoads(JSON.stringify(without("unread"))).unread, [], "absent is the builder's own way of saying none");
	assert.equal(parseHostLoads(JSON.stringify(without("every"))), null, "no interval key at all");
	for (const every of ["24", -1, 1.5, []]) assert.equal(parseHostLoads(JSON.stringify({ ...good, every })), null, `every ${JSON.stringify(every)}`);
	assert.equal(parseHostLoads(JSON.stringify({ ...good, every: null })).every, null, "null is the builder's own unknown");
	assert.equal(parseHostLoads(JSON.stringify(without("by"))), null);
	assert.equal(parseHostLoads(JSON.stringify({ ...good, by: "x" })), null);
	// `{ worker: "yes" }` read as false, which says an operator ran it, and `{ uid: "root" }` as no uid known.
	for (const by of [{}, { uid: "root", worker: true }, { uid: -1, worker: true }, { worker: true }, { uid: 501 }, { uid: 501, worker: "yes" }, { uid: 501, worker: 1 }, { uid: 501, worker: null }]) assert.equal(parseHostLoads(JSON.stringify({ ...good, by })), null, `by ${JSON.stringify(by)}`);
	assert.deepEqual(parseHostLoads(JSON.stringify({ ...good, by: { uid: null, worker: false } })).by, { uid: null, worker: false }, "null is the builder's own unknown uid");
	assert.deepEqual(parseHostLoads(JSON.stringify(record({ by: null }))).by, { uid: null, worker: false }, "and what the builder writes for no `by` at all reads back");
	// A key this reader has no word for is a host saying it left out something this reader cannot name, so "nothing in `more`"
	// cannot be said of it, and `hostsAgree` must not get the chance to say true.
	for (const more of [{ widgets: 3 }, { extensions: 1, widgets: 0 }]) assert.equal(parseHostLoads(JSON.stringify({ ...good, more })), null, `more ${JSON.stringify(more)}`);
	for (const notText of [null, undefined, 7, {}]) assert.equal(parseHostLoads(notText), null, String(notText));
});

test("a record past the bound does not read, however it got there: no builder writes one, and a reader does not parse it to find out", async () => {
	const pad = (bytes) => {
		const text = JSON.stringify({ ...record(), pad: "" });
		return text.replace('"pad":""', `"pad":"${"x".repeat(bytes - Buffer.byteLength(text, "utf8"))}"`);
	};
	assert.equal(Buffer.byteLength(pad(HOST_LOADS_MAX_BYTES), "utf8"), HOST_LOADS_MAX_BYTES);
	assert.ok(parseHostLoads(pad(HOST_LOADS_MAX_BYTES)) !== null, "at the bound it reads");
	assert.equal(parseHostLoads(pad(HOST_LOADS_MAX_BYTES + 1)), null, "one byte past it does not");
	assert.equal(parseHostLoads(pad(2 * 1024 * 1024)), null, "nor two megabytes, which read as current");
	// By bytes, not characters: another host's multi-byte text cannot get past the bound on its length.
	const wide = JSON.stringify({ ...record(), pad: "é".repeat(HOST_LOADS_MAX_BYTES / 2) });
	assert.ok(wide.length < HOST_LOADS_MAX_BYTES + 512 && Buffer.byteLength(wide, "utf8") > HOST_LOADS_MAX_BYTES);
	assert.equal(parseHostLoads(wide), null);
	const read = await readHostLoads(fakeRedis({ [hostLoadsKey("huge")]: pad(2 * 1024 * 1024) }), { now: () => NOW });
	assert.deepEqual(read.hosts, [{ name: "huge", state: "unknown", why: "unreadable" }]);
});

test("where a server is and the names it references are held to their charsets, at the builder and again at the parser", () => {
	const row = (over) => ({ name: "m", transport: "http", where: "ok.example", exposure: "codemode", enabled: true, keys: ["A_KEY"], ...over });
	const rows = (over) => [buildHostLoads({ at: NOW, mcp: [row(over)] }), parseHostLoads(JSON.stringify({ ...buildHostLoads({ at: NOW }), mcp: [row(over)] }))];
	for (const where of ["/etc/passwd", "bin/tool", "https://user:pass@host/x?y=1", "a b", "host?token=x", "user@host", "ok.example\n", "<b>", "x".repeat(256), "", 7, null]) {
		for (const read of rows({ where })) {
			assert.equal(read.mcp[0].where, null, JSON.stringify(where));
			assert.ok(typeof where !== "string" || where === "" || !JSON.stringify(read).includes(where), JSON.stringify(where));
		}
	}
	for (const where of ["mcp.linear.app", "mcp.linear.app:8443", "[::1]:8080", "my-server_2", "x".repeat(255)]) {
		for (const read of rows({ where })) assert.equal(read.mcp[0].where, where);
	}
	for (const read of rows({ keys: ["GOOD_KEY", "_LEADING", "HOSTILE value", "$(x)", "lower", "9STARTS", "A".repeat(65), "X".repeat(64), 7] })) {
		assert.deepEqual(read.mcp[0].keys, ["GOOD_KEY", "_LEADING", "X".repeat(64)], "a name, and no more than a name");
		assert.equal(read.more.keys, 6, "and each one it did not keep is counted");
		assert.doesNotMatch(JSON.stringify(read), /HOSTILE|\$\(x\)|lower|9STARTS/);
	}
	// A place that failed its charset can hide a difference: two hosts with different hostile values would both read null.
	const place = (where, name) => ({ name, state: "current", ...parseHostLoads(JSON.stringify({ ...buildHostLoads({ at: NOW }), mcp: [row({ where })] })) });
	assert.equal(hostsAgree([place("a b", "x"), place("c d", "y")]), null, "not the same: nobody can say");
	assert.equal(hostsAgree([place(null, "x"), place(null, "y")]), null, "nor when a secret took it out of both");
	assert.equal(hostsAgree([place("ok.example", "x"), place("ok.example", "y")]), true);
	assert.equal(hostsAgree([place("ok.example", "x"), place("other.example", "y")]), false);
});

test("an older host never reads as the same: absent, unparseable, newer and expired all read unknown", async () => {
	const good = JSON.stringify(record());
	const values = {
		[hostLoadsKey("mini1")]: good,
		[hostLoadsKey("broken")]: "{ not json",
		[hostLoadsKey("newer")]: JSON.stringify({ ...record(), v: 2 }),
	};
	const redis = fakeRedis(values, { index: ["mini1", "broken", "newer", "older"] });
	const read = await readHostLoads(redis, { names: ["mini1", "live-host"], now: () => NOW });
	assert.deepEqual(read.hosts.map((row) => [row.name, row.state, row.why ?? null]), [["broken", "unknown", "unreadable"], ["live-host", "unknown", "absent"], ["mini1", "current", null], ["newer", "unknown", "unreadable"], ["older", "unknown", "absent"]]);
	assert.equal(read.more, 0);
	assert.equal(hostsAgree(read.hosts), null, "with any of them in the question");
	assert.equal(hostsAgree(read.hosts.filter((row) => row.name === "mini1")), true, "one host that lists everything agrees with itself");
	for (const unknown of read.hosts.filter((row) => row.state === "unknown")) {
		const asked = [read.hosts.find((row) => row.name === "mini1"), unknown];
		assert.equal(hostsAgree(asked), null, unknown.name);
		assert.notEqual(hostsAgree(asked), true, unknown.name);
	}
	assert.deepEqual(redis.calls.filter(([command]) => command === "mget").length, 1, "one MGET");
	assert.equal(redis.calls.some(([command]) => command !== "mget" && command !== "smembers"), false, "a reader promises to write nothing");
});

test("the read answers `unreachable` as itself, holds to its cap and reads live hosts first", async () => {
	assert.match((await readHostLoads(fakeRedis({}, { fail: { smembers: true } }))).unreachable, /index down/);
	assert.match((await readHostLoads(fakeRedis({}, { index: ["a"], fail: { mget: true } }))).unreachable, /mget down/);
	assert.deepEqual(await readHostLoads(fakeRedis({}, { index: [] })), { hosts: [], more: 0 }, "nobody published is not the same as could not find out");
	const index = Array.from({ length: 70 }, (_, i) => `a${String(i).padStart(2, "0")}`);
	const capped = await readHostLoads(fakeRedis({}, { index }), { names: ["zz-live"], now: () => NOW });
	assert.equal(capped.hosts.length, 64);
	assert.equal(capped.more, 7);
	assert.ok(capped.hosts.some((row) => row.name === "zz-live"), "an expired member cannot push a live host out of the read");
	const odd = await readHostLoads(fakeRedis({}, { index: ["ok", "a b", "../x", 7] }), { names: ["nope nope"], now: () => NOW });
	assert.deepEqual(odd.hosts.map((row) => row.name), ["ok"], "worker names only");
});

test("a record past two of its host's own intervals reads as old, an old host says nothing is the same, and a host with no interval is never old", async () => {
	const at = NOW - 49 * HOUR;
	assert.equal(HOST_LOADS_OLD_INTERVALS, 2);
	assert.equal(loadsFreshness(record({ at }), { now: NOW }), "old", "49 hours on a 24-hour interval");
	assert.equal(loadsFreshness(record({ at: NOW - 48 * HOUR }), { now: NOW }), "current", "exactly two intervals is not past them");
	assert.equal(loadsFreshness(record({ at: NOW - 13 * HOUR, every: 6 }), { now: NOW }), "old");
	for (const every of [0, null]) assert.equal(loadsFreshness(record({ at: NOW - 200 * HOUR, every }), { now: NOW }), "current", `every ${every}: only an operator's run publishes there, and its age is shown`);
	assert.equal(loadsFreshness(record({ at: NOW + HOUR }), { now: NOW }), "current", "a clock ahead of ours is not old");

	const values = { [hostLoadsKey("fresh")]: JSON.stringify(record()), [hostLoadsKey("stale")]: JSON.stringify(record({ at })) };
	const read = await readHostLoads(fakeRedis(values), { now: () => NOW });
	const byName = Object.fromEntries(read.hosts.map((row) => [row.name, row]));
	assert.equal(byName.stale.state, "old");
	assert.equal(byName.stale.ageMs, 49 * HOUR);
	assert.equal(byName.fresh.state, "current");
	assert.equal(byName.fresh.ageMs, 0);
	assert.equal(hostsAgree(read.hosts), null, "though the two lists are equal");
	const ahead = await readHostLoads(fakeRedis({ [hostLoadsKey("ahead")]: JSON.stringify(record({ at: NOW + HOUR })) }), { now: () => NOW });
	assert.equal(ahead.hosts[0].ageMs, 0, "a record ahead of our clock reads as 0, the registry's posture");
});

test("hostsAgree: the same in any order is true, a difference is false, and it never says true without everything", () => {
	const a = rowOf();
	assert.equal(hostsAgree([a, rowOf({}, { name: "b", at: NOW - HOUR })]), true, "when and who ran it is not what the job can load");
	assert.equal(hostsAgree([rowOf({ every: 12, by: { uid: 0, worker: false } }), rowOf({}, { name: "b" })]), true);
	const shuffled = rowOf({ extensions: [{ name: "b.ts", kind: "file" }, { name: "a.ts", kind: "file" }], skills: ["y", "x"] }, { name: "x" });
	const sorted = rowOf({ extensions: [{ name: "a.ts", kind: "file" }, { name: "b.ts", kind: "file" }], skills: ["x", "y"] }, { name: "y" });
	assert.equal(hostsAgree([shuffled, sorted]), true, "a readdir's order is no difference");
	for (const [label, over] of Object.entries({
		"an extension": { extensions: [{ name: "other.ts", kind: "file" }] },
		"a kind": { extensions: [{ name: "git-guard.ts", kind: "dir" }] },
		"a skill": { skills: [] },
		"a server's host": { mcp: [{ ...PARTS.mcp[0], where: "elsewhere" }] },
		"a server switched off": { mcp: [{ ...PARTS.mcp[0], enabled: false }] },
		"a package's version": { packages: [{ name: "pi-lint", version: "1.4.3" }] },
		"where a flow resolved": { flows: [{ ...PARTS.flows[0], tier: "package", package: "pi-lint" }] },
		"the host's switch": { overlayExtensionsAllowed: false },
	})) {
		assert.equal(hostsAgree([a, rowOf(over, { name: "b" })]), false, label);
	}
	const order = [{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" }];
	assert.equal(hostsAgree([rowOf({ packages: order }), rowOf({ packages: [...order].reverse() }, { name: "b" })]), false, "package order is pi's load order");
	for (const [label, over] of Object.entries({ "a part it could not read": { unread: ["mcp"] }, "a list past its cap": { skills: Array.from({ length: 65 }, (_, i) => `s${i}`) } })) {
		assert.equal(hostsAgree([a, rowOf(over, { name: "b" })]), null, label);
	}
	for (const notRows of [[], null, undefined, "x"]) assert.equal(hostsAgree(notRows), null);
	assert.equal(hostsAgree([{ state: "current" }]), null, "a row with no lists says nothing");
});

test("flowTierOf: the loader's order, first hit wins, and a forge trigger found nowhere is unknown, never none", async () => {
	const answer = (state) => async () => state;
	const on = (paths) => ({ fileExists: (path) => paths.some((suffix) => path.endsWith(suffix)), overlay: "/overlay", staged: { skills: [{ name: "fix", package: "pi-lint" }], unenumerable: [] } });
	const SKILL = "fix/SKILL.md";
	const of = async (run, repo, world) => {
		const { tier, package: pkg, repo: repoState } = await flowTierOf({ flow: "fix", ...run }, { repoFlowAtHead: answer(repo), ...world });
		return [tier, pkg, repoState];
	};
	assert.deepEqual(await of({ folder: "/srv" }, "present", on([SKILL])), ["repository", null, "present"]);
	assert.deepEqual(await of({ folder: "/srv", skillsDir: "/t" }, "absent", on(["/t/fix/SKILL.md"])), ["trigger", null, "absent"]);
	assert.deepEqual(await of({ folder: "/srv" }, "absent", on(["/overlay/skills/fix/SKILL.md"])), ["overlay", null, "absent"]);
	assert.deepEqual(await of({ folder: "/srv" }, "absent", on([])), ["package", "pi-lint", "absent"]);
	assert.deepEqual(await of({}, "absent", on(["/overlay/skills/fix/SKILL.md"])), ["overlay", null, "unknown"], "a forge's repository is not on this host, and the walk goes on past it");
	const nowhere = { fileExists: () => false, overlay: "/overlay", staged: { skills: [], unenumerable: [] } };
	assert.deepEqual(await of({}, "absent", nowhere), ["unknown", null, "unknown"], "a forge trigger found nowhere else");
	assert.deepEqual(await of({ folder: "/srv" }, "absent", nowhere), ["none", null, "absent"], "a local trigger every tier answered for");
	assert.deepEqual(await of({ folder: "/srv" }, "unknown", nowhere), ["unknown", null, "unknown"], "a folder git cannot read");
	assert.deepEqual(await of({ folder: "/srv", packages: false }, "absent", on([])), ["none", null, "absent"], "withheld packages are not a place the flow is");
	assert.deepEqual(await of({ folder: "/srv" }, "absent", { ...nowhere, staged: { skills: [], unenumerable: ["pi-glob"] } }), ["unknown", null, "absent"], "a package whose manifest cannot be enumerated");
	const words = await flowTierOf({ flow: "fix", folder: "/srv" }, { repoFlowAtHead: answer("absent"), ...nowhere });
	assert.deepEqual([words.resolved, words.checked, words.unknown], [null, ["repo .pi/skills at HEAD", "overlay skills/", "staged packages"], []], "the words of doctor's own line");
});

// Issue #869: a flow row says which version of the trigger it answered for, so a console reading the file after an edit can tell.
test("a flow row's basis digests exactly the fields flowTierOf reads, read off its own signature, and each one moves it", () => {
	// The names `flowTierOf` destructures from its first argument, from its source: a field it comes to read fails here first.
	const signature = /^async function flowTierOf\(\{([^}]*)\}/.exec(Function.prototype.toString.call(flowTierOf));
	assert.ok(signature, "flowTierOf still takes its trigger's fields as one destructured argument");
	const read = signature[1].split(",").map((part) => part.split("=")[0].trim()).filter(Boolean);
	assert.deepEqual(read, [...FLOW_INPUT_FIELDS], "FLOW_INPUT_FIELDS names what flowTierOf reads, in its order");
	assert.deepEqual(Object.keys(flowInputOf({ run: {} })), [...FLOW_INPUT_FIELDS], "and flowInputOf hands it each of them");

	const base = { on: { type: "cron", id: "web", pattern: "0 9 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "fix", task: "t", skillsDir: "/srv/skills", excludeExtensions: ["pi-a", "pi-b"] } };
	const basis = flowBasisOf(base);
	assert.match(basis, new RegExp(`^[0-9a-f]{${FLOW_BASIS_HEX}}$`));
	assert.equal(FLOW_BASIS_HEX, 8);
	// One change per field, keyed by the list: a field added to it fails until it has one here, and then until the digest moves with it.
	const changes = {
		flow: [{ flow: "review" }],
		folder: [{ folder: "/srv/api" }, { folder: undefined }],
		skillsDir: [{ skillsDir: "/srv/other-skills" }, { skillsDir: "skills" }, { skillsDir: undefined }],
		packages: [{ packages: false }],
		excludeExtensions: [{ excludeExtensions: ["pi-a"] }, { excludeExtensions: ["pi-a", "pi-b", "pi-c"] }, { excludeExtensions: undefined }],
	};
	assert.deepEqual(Object.keys(changes), [...FLOW_INPUT_FIELDS]);
	for (const [field, overs] of Object.entries(changes)) {
		for (const over of overs) {
			const changed = { ...base, run: { ...base.run, ...over } };
			assert.notDeepEqual(flowInputOf(changed)[field], flowInputOf(base)[field], `${field}: flowInputOf reads ${JSON.stringify(over)}`);
			assert.notEqual(flowBasisOf(changed), basis, `${field}: ${JSON.stringify(over)} moves the basis`);
		}
	}
	// What flowTierOf does not read, or reads the same way, does not move it.
	const same = (run) => flowBasisOf({ ...base, run: { ...base.run, ...run } });
	assert.equal(same({ excludeExtensions: ["pi-b", "pi-a"] }), basis, "flowTierOf asks only whether a name is in the list");
	assert.equal(same({ packages: true }), basis, "absent and true are one answer");
	for (const run of [{ task: "another" }, { model: "m", provider: "p" }, { image: "pi-job:4.3.1" }, { mcp: ["linear"] }, { excludeTools: ["bash"] }, { kind: "github" }]) assert.equal(same(run), basis, JSON.stringify(run));
	assert.equal(flowBasisOf({ ...base, on: { type: "label", any: ["pi"] } }), basis, "nor does what starts it");
	// The loader's sentinel for a disarmed one-shot names no flow, so doctor publishes no row for it.
	assert.equal(flowInputOf({ on: { type: "disarmed" }, run: {} }).flow, null);
	assert.notEqual(flowBasisOf({ on: { type: "disarmed" }, run: {} }), basis);
});

test("a flow row's basis is read by its shape: one of another shape drops the row and counts it, and none is a row from before #869", () => {
	const row = PARTS.flows[0];
	const { basis, ...older } = row;
	const parsed = parseHostLoads(JSON.stringify({ ...record(), flows: [row, older, { ...row, trigger: 4, basis: "XYZ12345" }, { ...row, trigger: 5, basis: 7 }, { ...row, trigger: 6, basis: `${basis}0` }, { ...row, trigger: 7, basis: null }] }));
	assert.deepEqual(parsed.flows, [row, older], "its basis kept as written, and a row with none read as an older doctor wrote it");
	assert.deepEqual(parsed.more, { flows: 4 });
	assert.deepEqual(buildHostLoads({ at: NOW, flows: [{ ...row, basis: "/srv/web" }] }).flows, [], "the builder holds it to the same shape");
});

test("flowProbes answers as each reader did, and notes only a failure that is not absence", () => {
	const failing = (code) => {
		const fail = () => {
			throw Object.assign(new Error(code), { code });
		};
		return { statSync: fail, readFileSync: fail, readdirSync: fail };
	};
	const fine = { statSync: () => ({}), readFileSync: () => "text", readdirSync: () => ["a"] };
	for (const answer of [true, false]) {
		const probes = flowProbes({ fileExists: () => answer, fs: failing("EACCES") });
		assert.equal(probes.fileExists("/x"), answer, "the seam's answer stands, whatever the stat met");
		assert.equal(probes.blind(), true);
	}
	const reads = flowProbes({ fileExists: () => true, fs: fine });
	assert.equal(reads.readFile("/x"), "text");
	assert.deepEqual(reads.readDir("/x"), ["a"]);
	assert.equal(reads.fileExists("/x"), true);
	assert.equal(reads.blind(), false);
	for (const code of ABSENT_CODES) {
		const absent = flowProbes({ fileExists: () => false, fs: failing(code) });
		assert.equal(absent.fileExists("/x"), false, code);
		assert.throws(() => absent.readFile("/x"), { code }, "a read still throws, as the caller's catch expects");
		assert.throws(() => absent.readDir("/x"), { code });
		assert.equal(absent.blind(), false, `${code} is absence`);
	}
	for (const [code, use] of [["EACCES", (probes) => probes.readFile("/x")], ["EPERM", (probes) => probes.readDir("/x")], ["EIO", (probes) => probes.readFile("/x")], [undefined, (probes) => probes.readDir("/x")]]) {
		const blocked = flowProbes({ fileExists: () => false, fs: failing(code) });
		assert.throws(() => use(blocked));
		assert.equal(blocked.blind(), true, `${code} is not absence`);
	}
});

test("the overlay's extensions read by the rule a job discovers them by, held to the runner's own function on the same tree", async () => {
	const overlay = tempDir("host-loads-overlay-");
	const dir = join(overlay, "extensions");
	mkdirSync(join(dir, "folder"), { recursive: true });
	writeFileSync(join(dir, "folder", "index.ts"), "export default () => {};\n");
	mkdirSync(join(dir, "pack", "src"), { recursive: true });
	writeFileSync(join(dir, "pack", "package.json"), JSON.stringify({ pi: { extensions: ["./src/main.js"] } }));
	writeFileSync(join(dir, "pack", "src", "main.js"), "export default () => {};\n");
	mkdirSync(join(dir, "not-one"), { recursive: true });
	writeFileSync(join(dir, "not-one", "readme.txt"), "x");
	mkdirSync(join(dir, "dir-entry", "inner"), { recursive: true });
	writeFileSync(join(dir, "dir-entry", "package.json"), JSON.stringify({ pi: { extensions: ["./inner"] } }));
	mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "dep", "index.js"), "x");
	writeFileSync(join(dir, "single.ts"), "x");
	writeFileSync(join(dir, "other.js"), "x");
	writeFileSync(join(dir, "README.md"), "x");
	writeFileSync(join(dir, ".hidden.ts"), "x");
	symlinkSync(join(dir, "single.ts"), join(dir, "linked.ts"));
	symlinkSync(join(dir, "gone"), join(dir, "dangling.ts"));
	const rows = readOverlayExtensionRows(overlay);
	assert.deepEqual(rows, [{ name: "folder", kind: "dir" }, { name: "linked.ts", kind: "file" }, { name: "other.js", kind: "file" }, { name: "pack", kind: "dir" }, { name: "single.ts", kind: "file" }]);

	let loader;
	try {
		loader = await import("../../image/runner/src/loader.mjs");
	} catch {
		loader = null;
	}
	if (loader === null && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error("the runner's loader is REQUIRED here");
	if (loader !== null) {
		const entries = loader.discoverExtensionEntries(dir, { makeIgnore: () => ({ add() {}, ignores: () => false }) });
		const segments = [...new Set(entries.map((entry) => entry.slice(dir.length + 1).split("/")[0]))].sort();
		assert.deepEqual(rows.map((row) => row.name).sort(), segments, "the same first segments a run's record names");
		assert.deepEqual([...LOADS_IGNORE_FILES], [...loader.EXTENSION_IGNORE_FILES]);
	}

	// A folder that is itself a package is that package: its own entries, by first segment.
	const own = tempDir("host-loads-own-");
	mkdirSync(join(own, "extensions", "lib"), { recursive: true });
	writeFileSync(join(own, "extensions", "package.json"), JSON.stringify({ pi: { extensions: ["lib/a.js", "b.js", "missing.js", "../outside.js"] } }));
	writeFileSync(join(own, "outside.js"), "x");
	writeFileSync(join(own, "extensions", "lib", "a.js"), "x");
	writeFileSync(join(own, "extensions", "b.js"), "x");
	writeFileSync(join(own, "extensions", "ignored-c.js"), "x");
	assert.deepEqual(readOverlayExtensionRows(own), [{ name: "lib", kind: "dir" }, { name: "b.js", kind: "file" }]);
	const index = tempDir("host-loads-index-");
	mkdirSync(join(index, "extensions"), { recursive: true });
	writeFileSync(join(index, "extensions", "index.ts"), "x");
	writeFileSync(join(index, "extensions", "other.ts"), "x");
	assert.deepEqual(readOverlayExtensionRows(index), [{ name: "index.ts", kind: "file" }]);

	// An ignore file the host cannot read as a job does says "cannot say", and one with no pattern changes nothing.
	const ignoring = tempDir("host-loads-ignoring-");
	mkdirSync(join(ignoring, "extensions"), { recursive: true });
	writeFileSync(join(ignoring, "extensions", "a.ts"), "x");
	writeFileSync(join(ignoring, "extensions", ".gitignore"), "# just a comment\n\n");
	assert.deepEqual(readOverlayExtensionRows(ignoring), [{ name: "a.ts", kind: "file" }]);
	writeFileSync(join(ignoring, "extensions", ".ignore"), "a.ts\n");
	assert.equal(readOverlayExtensionRows(ignoring), null);

	assert.deepEqual(readOverlayExtensionRows(tempDir("host-loads-empty-")), [], "no folder is no extensions");
	assert.deepEqual(readOverlayExtensionRows(""), []);
	assert.deepEqual(readOverlayExtensionRows(null), []);
});

/** The real `fs`, except that a path `denied` matches fails with `code`: what a folder at mode 000 answers, as any uid. */
function fsDenying(denied, code = "EACCES") {
	const check = (path) => {
		if (denied.test(String(path))) throw Object.assign(new Error(`${code}: permission denied`), { code });
	};
	return {
		statSync: (path, ...rest) => (check(path), statSync(path, ...rest)),
		readFileSync: (path, ...rest) => (check(path), readFileSync(path, ...rest)),
		readdirSync: (path, ...rest) => (check(path), readdirSync(path, ...rest)),
	};
}

test("only absence is absent: anything else a read answers throws, so a folder it cannot enter never reads as none", () => {
	for (const code of ABSENT_CODES) assert.equal(pathIsThere("/x", fsDenying(/x/, code)), false, code);
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const said = spec.match(/Only (`[A-Z]+`(?:, `[A-Z]+`)*(?: and `[A-Z]+`)) are absence \(`ABSENT_CODES`\)/);
	assert.deepEqual(said?.[1].match(/[A-Z]+/g).sort(), [...ABSENT_CODES].sort(), "INT-DOCTOR-RESULTS-KEY names the set");
	for (const code of ["EACCES", "EPERM", "EIO", "EMFILE", undefined]) assert.throws(() => pathIsThere("/x", fsDenying(/x/, code)), undefined, String(code));
	assert.equal(pathIsThere(tempDir("host-loads-there-")), true);

	const overlay = tempDir("host-loads-denied-");
	const dir = join(overlay, "extensions");
	mkdirSync(join(dir, "folder"), { recursive: true });
	writeFileSync(join(dir, "folder", "index.ts"), "x");
	mkdirSync(join(dir, "pack"), { recursive: true });
	writeFileSync(join(dir, "pack", "package.json"), JSON.stringify({ pi: { extensions: ["./main.js"] } }));
	writeFileSync(join(dir, "pack", "main.js"), "x");
	writeFileSync(join(dir, "single.ts"), "x");
	writeFileSync(join(dir, ".gitignore"), "# nothing\n");
	symlinkSync(join(dir, "single.ts"), join(dir, "linked.ts"));
	for (const name of ["deploy", "fix"]) {
		mkdirSync(join(overlay, "skills", name), { recursive: true });
		writeFileSync(join(overlay, "skills", name, "SKILL.md"), "x");
	}
	writeFileSync(join(overlay, "skills", "README.md"), "a file beside the folders is no skill, not a failed read");

	assert.equal(readOverlayExtensionRows(overlay).length, 4, "the premise: all of it reads");
	assert.deepEqual(readOverlaySkillNames(overlay), ["deploy", "fix"], "and a file's ENOTDIR is absence");
	for (const [label, denied] of Object.entries({
		"the overlay": new RegExp(`^${overlay}`),
		"extensions/": /extensions$/,
		"its manifest": /extensions\/package\.json$/,
		"a folder of one extension": /extensions\/folder\//,
		"a package's manifest": /pack\/package\.json$/,
		"what a package's manifest names": /pack\/main\.js$/,
		"an ignore file": /extensions\/\.gitignore$/,
		"where a link points": /linked\.ts$/,
	})) {
		assert.throws(() => readOverlayExtensionRows(overlay, { fs: fsDenying(denied) }), /EACCES/, label);
	}
	for (const [label, denied] of Object.entries({ "the overlay": new RegExp(`^${overlay}`), "skills/": /skills$/, "a skill's own folder": /skills\/deploy\/SKILL\.md$/ })) {
		assert.throws(() => readOverlaySkillNames(overlay, { fs: fsDenying(denied) }), /EACCES/, label);
	}
	// A manifest that does not parse is not one that cannot be read: the job takes it as declaring nothing, and so does this.
	const garbled = tempDir("host-loads-garbled-");
	mkdirSync(join(garbled, "extensions", "broken"), { recursive: true });
	writeFileSync(join(garbled, "extensions", "broken", "package.json"), "{ not json");
	writeFileSync(join(garbled, "extensions", "broken", "index.js"), "x");
	assert.deepEqual(readOverlayExtensionRows(garbled), [{ name: "broken", kind: "dir" }]);
	// A link to nowhere is absence too: discovery skips it, as it always did.
	const dangling = tempDir("host-loads-dangling-");
	mkdirSync(join(dangling, "extensions"), { recursive: true });
	symlinkSync(join(dangling, "gone"), join(dangling, "extensions", "dangling.ts"));
	assert.deepEqual(readOverlayExtensionRows(dangling), []);
});

test("the overlay's skills read by folder, as doctor's flow line reads them", () => {
	const overlay = tempDir("host-loads-skills-");
	for (const name of ["deploy", "fix"]) {
		mkdirSync(join(overlay, "skills", name), { recursive: true });
		writeFileSync(join(overlay, "skills", name, "SKILL.md"), "---\ndescription: x\n---\n");
	}
	mkdirSync(join(overlay, "skills", "not-a-skill"), { recursive: true });
	mkdirSync(join(overlay, "skills", ".hidden"), { recursive: true });
	writeFileSync(join(overlay, "skills", ".hidden", "SKILL.md"), "x");
	assert.deepEqual(readOverlaySkillNames(overlay), ["deploy", "fix"]);
	assert.deepEqual(readOverlaySkillNames(tempDir("host-loads-none-")), []);
	assert.deepEqual(readOverlaySkillNames(""), []);
});

test("the console reads this through the package's exports, and its idea of old is doctor's", async () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./host-loads"], "./src/host-loads.mjs");
	const { DOCTOR_STALE_INTERVALS } = await import("../../admin/src/doctor-view.mjs");
	assert.equal(HOST_LOADS_OLD_INTERVALS, DOCTOR_STALE_INTERVALS);
});
