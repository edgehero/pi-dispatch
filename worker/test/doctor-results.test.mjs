import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	CHECK_ID_RE,
	DOCTOR_CHECKS_MAX,
	DOCTOR_DETAILED_MAX,
	DOCTOR_HOSTS,
	DOCTOR_LABEL_MAX,
	DOCTOR_RESULTS_TTL_MS,
	DOCTOR_SECTIONS,
	NAMED_CHECK_IDS,
	REPEATED_CHECK_IDS,
	assignCheckIds,
	buildDoctorRecord,
	checkLevel,
	doctorIntervalHours,
	doctorKey,
	parseDoctorRecord,
	publishDoctorRecord,
	readDoctorResults,
	redactText,
	secretValuesIn,
} from "../src/doctor-results.mjs";
import { makeRedactor } from "../src/redact-secrets.mjs";

/**
 * Doctor's published results (issue #712, `INT-DOCTOR-RESULTS-KEY`): the check ids, the redaction, the record's shape
 * and caps, and the write and the read through a fake Valkey. No doctor run here (doctor.test.mjs publishes one through
 * the real collection); nothing reaches a server, and every age is judged on an injected clock.
 */

const AT = Date.UTC(2026, 9, 21, 9, 0, 0);
const DOCTOR_SRC = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");

// A fake Valkey: strings with their PX, sets, every call recorded so the SHAPE of the write is asserted, not only its
// end state. The registry test's hand-rolled style; `hang` is a command that never answers, as a real ioredis queues one
// against an unreachable server.
function fakeRedis({ fail = false, hang = false } = {}) {
	const strings = new Map();
	const sets = new Map();
	const calls = [];
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
		if (hang) return new Promise(() => {});
		return null;
	};
	return {
		calls,
		strings,
		sets,
		async set(key, value, ...opts) {
			calls.push(["set", key, ...opts]);
			await guard();
			strings.set(key, { value, opts });
			return "OK";
		},
		async get(key) {
			calls.push(["get", key]);
			await guard();
			return strings.get(key)?.value ?? null;
		},
		async mget(...keys) {
			calls.push(["mget", ...keys]);
			await guard();
			return keys.map((k) => strings.get(k)?.value ?? null);
		},
		async sadd(key, member) {
			calls.push(["sadd", key, member]);
			await guard();
			const s = sets.get(key) ?? new Set();
			s.add(member);
			sets.set(key, s);
		},
		async srem(key, member) {
			calls.push(["srem", key, member]);
			await guard();
			sets.get(key)?.delete(member);
		},
		async smembers(key) {
			calls.push(["smembers", key]);
			await guard();
			return [...(sets.get(key) ?? [])];
		},
	};
}

test("the sections are pinned, and every section doctor.mjs opens is one of them (and none is unused)", () => {
	assert.deepEqual(DOCTOR_SECTIONS, ["node", "env", "image", "docker", "triggers", "dollars", "venues", "images", "egress", "backends", "sizing", "job-user", "podman", "openshell", "selinux", "forges", "github", "valkey", "fleet", "capacity", "provider", "overlay", "waits", "models", "secrets", "sessions", "files", "limits", "envelope", "console", "dirs", "state", "live"]);
	const opened = new Set([...DOCTOR_SRC.matchAll(/\bsection\("([a-z-]+)"\)/g)].map((m) => m[1]));
	opened.add("sizing"); // the fleet's re-said budget lines are tagged by `tagSection(again, "sizing")`
	opened.add("live"); // the --live read-backs, tagged by `publishResults`
	assert.deepEqual([...opened].sort(), [...DOCTOR_SECTIONS].sort(), "a section opened in doctor.mjs and not listed, or listed and never opened");
});

test("the named ids are pinned against the source: each literal id once (REPEATED_CHECK_IDS as counted), each boot file's two, and nothing else", async () => {
	const { BOOT_FILES, bootFileId } = await import("../src/doctor.mjs");
	const literal = [...DOCTOR_SRC.matchAll(/\bid: "([a-z0-9.-]+)"/g)].map((m) => m[1]);
	const sites = new Map();
	for (const id of literal) sites.set(id, (sites.get(id) ?? 0) + 1);
	for (const [id, n] of sites) assert.equal(n, REPEATED_CHECK_IDS[id] ?? 1, `${id} is written at ${n} sites`);
	for (const [id, n] of Object.entries(REPEATED_CHECK_IDS)) {
		assert.equal(sites.get(id), n, `${id} is listed as written at ${n} sites`);
		assert.ok(n > 1, `${id}: a repeat is two sites or more`);
		assert.ok(NAMED_CHECK_IDS.includes(id), `${id} is a named id`);
	}
	assert.deepEqual(Object.keys(REPEATED_CHECK_IDS), ["egress.proxy"]);
	assert.ok(Object.isFrozen(REPEATED_CHECK_IDS));
	const derived = BOOT_FILES.flatMap((spec) => [bootFileId(spec), bootFileId(spec, "shell")]);
	const all = [...sites.keys(), ...derived];
	assert.equal(new Set(all).size, all.length, "a literal id collides with a boot file's");
	assert.deepEqual([...all].sort(), [...NAMED_CHECK_IDS].sort());
	for (const id of NAMED_CHECK_IDS) {
		assert.match(id, CHECK_ID_RE, id);
		assert.doesNotMatch(id, /\.\d+$/, `${id} would collide with a derived id`);
	}
	assert.deepEqual(derived.slice(0, 2), ["pause-windows.file", "pause-windows.file-shell"]);
});

// Issue #737: the two named ids on the lines doctor really prints, through the real collection. A docker CLI that answers
// each argv by the first plan key it starts with, on the microtask queue (doctor.test.mjs's fake, cut to what this needs).
function planSpawn(plan) {
	return (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		const outcome = plan[Object.keys(plan).find((k) => line.startsWith(k))];
		const stream = () => ({ handlers: {}, on(ev, cb) { this.handlers[ev] = cb; return this; } });
		const handlers = {};
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => {
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

async function proxyIdRun({ image }) {
	const { collectChecks } = await import("./helpers/doctor.mjs");
	const { EGRESS_PROXY_CMD, EGRESS_PROXY_ENTRYPOINT } = await import("../src/egress-proxy-state.mjs");
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	const { existsSync } = await import("node:fs");
	const proxy = { status: "running", health: "healthy", image, entrypoint: EGRESS_PROXY_ENTRYPOINT, cmd: EGRESS_PROXY_CMD, mounts: [], networks: { "pi-dispatch-egress-out": {} } };
	const plan = {
		"docker context inspect": { code: 0, output: '"desktop-linux"|"unix:///Users/x/.docker/run/docker.sock"\n' },
		'docker inspect --format={"status":': { code: 0, output: `${JSON.stringify(proxy)}\n` },
		"docker network": 0,
		"docker run --rm --name pi-dispatch-egress-probe-provider": 0,
		"docker run --rm --name pi-dispatch-egress-probe-unlisted": 3,
		"docker run --rm --name pi-dispatch-egress-probe-plainhttp": 3,
		"docker info --format={{json .}}": { code: 0, output: `${JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin"], PidsLimit: true, MemoryLimit: true })}\n` },
		"docker info": 0,
		"docker image": 0,
	};
	return collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, { cwd: tempDir("pi-doctor-ids-"), home: tempDir("pi-doctor-ids-home-"), out: () => {}, spawn: planSpawn(plan), probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, nodeVersion: "22.19.0" });
}

test("egress.proxy is on docker's proxy line, or on the line that stands in for it, and provider.key on the key line (#737)", async () => {
	const { EGRESS_PROXY_IMAGE } = await import("../src/egress-proxy-state.mjs");
	const current = await proxyIdRun({ image: EGRESS_PROXY_IMAGE });
	const proxy = current.filter((c) => c.id === "egress.proxy");
	assert.deepEqual(proxy.map((c) => [c.ok, c.label]), [[true, "Egress proxy running (pi-dispatch-egress-proxy)"]]);
	const key = current.filter((c) => c.id === "provider.key");
	assert.equal(key.length, 1);
	assert.match(key[0].label, /ANTHROPIC_API_KEY/);
	// Published under those ids: a named id is kept whatever section the check was added in.
	const ids = assignCheckIds(current);
	assert.ok(ids.includes("egress.proxy") && ids.includes("provider.key"), ids.join(", "));
	// A RUNNING proxy that is not this deployment's: doctor prints no "running" line, and the line it prints instead
	// carries the id, so a reader still finds the proxy's verdict, and finds it failing.
	const stale = await proxyIdRun({ image: "ubuntu/squid:old" });
	const stood = stale.filter((c) => c.id === "egress.proxy");
	assert.equal(stood.length, 1);
	assert.equal(stood[0].ok, false);
	assert.match(stood[0].label, /^Egress proxy is (?:running but is not this deployment's|this deployment's proxy but out of date) \(pi-dispatch-egress-proxy\)/);
	assert.ok(!stale.some((c) => /^Egress proxy running/.test(c.label ?? "")));
});

test("podman's proxy line carries egress.proxy too, and nothing else in doctor.mjs does (#737)", () => {
	// podmanChecks needs a Linux host's whole `podman info` to reach its proxy line, so this one is pinned on the source:
	// each literal site sits in the check whose label is a proxy's running line.
	const sites = [...DOCTOR_SRC.matchAll(/\bid: "egress\.proxy"/g)].map((m) => DOCTOR_SRC.slice(m.index, m.index + 600));
	assert.equal(sites.length, 2);
	assert.match(sites[0], /label: up\s*\?\s*`Egress proxy running \(\$\{proxy\}\)`/);
	assert.match(sites[1], /label: proxyRunning \? `podman: egress proxy running under this account's Podman \(\$\{proxy\}\)`/);
	assert.equal([...DOCTOR_SRC.matchAll(/\bid: proxyCheck\.id\b/g)].length, 1, "the stand-in line takes the id from its check");
});

test("ids: a named id is kept, the rest are <section>.<n> in order, an unknown section is env, a repeat gets -2", () => {
	const a = { ok: true, label: "a" };
	const b = { ok: false, label: "b" };
	const named = { id: "triggers.file", ok: false, label: "t" };
	const c = { ok: true, label: "c" };
	const sections = new Map([[a, "valkey"], [b, "valkey"], [c, "nowhere"]]);
	const ids = assignCheckIds([a, named, b, c, named, { id: "Not An Id", ok: true }], (x) => sections.get(x) ?? "env");
	assert.deepEqual(ids, ["valkey.1", "triggers.file", "valkey.2", "env.1", "triggers.file-2", "env.2"]);
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.match(id, CHECK_ID_RE);
});

test("levels follow render's tiers: ok first, then warn, else fail", () => {
	assert.equal(checkLevel({ ok: true, warn: true }), "ok");
	assert.equal(checkLevel({ ok: false, warn: true }), "warn");
	assert.equal(checkLevel({ ok: false }), "fail");
	assert.equal(checkLevel(null), "fail");
});

test("redaction: paths become <path>, URLs keep scheme and host, userinfo, queries and tokens never survive", () => {
	const r = (t, values = []) => redactText(t, { redact: makeRedactor({ values }) });
	assert.equal(r("PI_TRIGGERS_FILE names /home/rob/deploy/triggers.json, which does not exist"), "PI_TRIGGERS_FILE names <path>, which does not exist");
	assert.equal(r('settings overlay "/srv/pi/settings.json" is invalid'), 'settings overlay "<path>" is invalid');
	assert.equal(r("the key at ~/.ssh/id_ed25519: not readable"), "the key at <path>: not readable");
	assert.equal(r("C:\\Users\\rob\\deploy\\.env line 3"), "<path> line 3");
	assert.equal(r("(/var/run/docker.sock)"), "(<path>)");
	assert.equal(r("Valkey (redis://:hunter2@10.0.0.5:6379/2?x=1) answers"), "Valkey (redis://10.0.0.5:6379) answers");
	assert.equal(r("gitlab triggers configured (https://oauth2:glpat-abcdefghijklmnop1234@gitlab.example.com/group/repo.git)"), "gitlab triggers configured (https://gitlab.example.com)");
	assert.equal(r("daemon at unix:///run/user/1000/podman/podman.sock."), "daemon at unix://<path>.");
	// What a path is NOT: a zone, an image, a repository, a ratio, a lone slash.
	assert.equal(r("Europe/Amsterdam ghcr.io/edgehero/pi-job:4.3.1 acme/web 2/4 and / or"), "Europe/Amsterdam ghcr.io/edgehero/pi-job:4.3.1 acme/web 2/4 and / or");
	// A secret value, anywhere, even where no rule above would have cut it, and a known token shape with no name.
	assert.equal(r("token s3cretValue-Not-A-Shape here", ["s3cretValue-Not-A-Shape"]), "token [redacted] here");
	assert.equal(r("found ghp_abcdefghijklmnopqrstuvwx1234 in a file"), "found [redacted] in a file");
	// Controls out, whitespace folded, the cap last.
	assert.equal(r("a\u001b[2J\u202eb\n\tc"), "a [2J b c");
	const long = r(`${"x".repeat(DOCTOR_LABEL_MAX + 50)}`);
	assert.equal(long.length, DOCTOR_LABEL_MAX);
	assert.ok(long.endsWith("\u2026"));
	assert.equal(r(""), "");
	assert.equal(r(undefined), "");
});

test("secret values: secret-named variables, the PAT the pointer names, URL passwords; paths and pointers are not secrets", () => {
	const values = secretValuesIn(
		{ ANTHROPIC_API_KEY: "sk-ant-aaaaaaaaaaaaaaaaaaaa", GITHUB_PAT_VAR: "MY_PAT", MY_PAT: "pat-value-123456", VALKEY_URL: "redis://:p%40ssw0rd99@h:6379", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem", PI_LOGS_DIR: "/srv/logs", PI_SESSIONS_TTL_DAYS: "7" },
		{ WEBHOOK_SECRET: "whsec-1234567890" },
		undefined,
	);
	assert.deepEqual([...new Set(values)].sort(), ["p%40ssw0rd99", "p@ssw0rd99", "pat-value-123456", "sk-ant-aaaaaaaaaaaaaaaaaaaa", "whsec-1234567890"]);
	assert.deepEqual(secretValuesIn({ GITHUB_PAT_VAR: "TOKEN_HOLDER", TOKEN_HOLDER: "held-by-pointer-1" }).includes("held-by-pointer-1"), true, "the pointer's target is a secret by being pointed at");
	assert.deepEqual(secretValuesIn({ GITHUB_PAT_VAR: "PLAIN", PLAIN: "pointed-at-value" }), ["pointed-at-value"]);
});

test("a record: counts over every check, ok entries are id and level only, warn and fail carry the redacted label and fix", () => {
	const secret = "a-very-secret-token-value";
	const checks = [
		{ ok: true, label: `Secret resolver profiles declared: vault -> /opt/secret ${secret}` },
		{ ok: false, warn: true, label: `${secret} at /srv/x`, fix: "edit /srv/x then re-run doctor" },
		{ id: "triggers.file", ok: false, label: "triggers file is refused at load -- the receiver will refuse to start: /d/triggers.json: not valid JSON", fix: "fix /d/triggers.json" },
	];
	const ids = assignCheckIds(checks, () => "env");
	const record = buildDoctorRecord({ checks, ids, at: AT, version: "4.3.1", openshell: true, every: 24, secrets: [secret] });
	assert.deepEqual(record, {
		v: 1,
		at: AT,
		version: "4.3.1",
		openshell: true,
		every: 24,
		by: { uid: null, worker: false },
		counts: { ok: 1, warn: 1, fail: 1 },
		checks: [
			{ id: "env.1", level: "ok" },
			{ id: "env.2", level: "warn", label: "[redacted] at <path>", fix: "edit <path> then re-run doctor" },
			{ id: "triggers.file", level: "fail", label: "triggers file is refused at load -- the receiver will refuse to start: <path>: not valid JSON", fix: "fix <path>" },
		],
		more: 0,
	});
	assert.doesNotMatch(JSON.stringify(record), new RegExp(`${secret}|/srv|/opt|/d/`));
	assert.equal(buildDoctorRecord({ checks, ids, at: AT, version: "4.3.1\u001b" }).version, "", "a version outside its charset is dropped");
});

test("a record is capped: at most DOCTOR_CHECKS_MAX entries (the rest in more), at most DOCTOR_DETAILED_MAX with words", () => {
	const checks = Array.from({ length: DOCTOR_CHECKS_MAX + 7 }, (_, i) => ({ ok: false, label: `fail ${i}`, fix: "f" }));
	const record = buildDoctorRecord({ checks, ids: assignCheckIds(checks), at: AT, version: "1" });
	assert.equal(record.checks.length, DOCTOR_CHECKS_MAX);
	assert.equal(record.more, 7);
	assert.equal(record.counts.fail, DOCTOR_CHECKS_MAX + 7, "the counts are of every check, listed or not");
	assert.equal(record.checks.filter((c) => "label" in c).length, DOCTOR_DETAILED_MAX);
	assert.ok(JSON.stringify(record).length < 64 * 1024, "the worst case stays one small value");
});

test("publish: one SET with the value and its 7-day PX in ONE command, then the index; a second publish refreshes the TTL", async () => {
	const redis = fakeRedis();
	const record = buildDoctorRecord({ checks: [{ ok: true, label: "x" }], ids: ["node.1"], at: AT, version: "4.3.1" });
	await publishDoctorRecord(redis, "mini1", record);
	assert.deepEqual(redis.calls, [["get", "doctor:h:mini1"], ["set", "doctor:h:mini1", "PX", DOCTOR_RESULTS_TTL_MS], ["sadd", DOCTOR_HOSTS, "mini1"], ["smembers", DOCTOR_HOSTS]], "the value and its expiry in ONE command; the read before it is only for whose run it replaces");
	assert.equal(DOCTOR_RESULTS_TTL_MS, 7 * 24 * 3600 * 1000);
	assert.deepEqual(JSON.parse(redis.strings.get(doctorKey("mini1")).value), record);
	await publishDoctorRecord(redis, "mini1", { ...record, at: AT + 1000 });
	assert.deepEqual(redis.calls.filter((c) => c[0] === "set").map((c) => c.slice(2)), [["PX", DOCTOR_RESULTS_TTL_MS], ["PX", DOCTOR_RESULTS_TTL_MS]], "every publish sets the expiry afresh");
	await assert.rejects(publishDoctorRecord(redis, "../evil", record), /not a worker name/, "a name that is not a worker name is never a key segment");
	await assert.rejects(publishDoctorRecord(fakeRedis({ fail: true }), "mini1", record), /ECONNREFUSED/, "the CALLER is best effort; the write says it failed");
	await assert.rejects(publishDoctorRecord(fakeRedis({ hang: true }), "mini1", record, { timeoutMs: 5 }), /timeout/, "a hung server is a bounded failure, not a hang");
});

test("read back: the index plus the live names, one MGET, ages on the injected clock, an expired member pruned", async () => {
	const redis = fakeRedis();
	const rec = (at, extra = {}) => buildDoctorRecord({ checks: [{ ok: false, warn: true, label: "w /p", fix: "f" }], ids: ["valkey.1"], at, version: "4.3.1", every: 24, ...extra });
	await publishDoctorRecord(redis, "mini1", rec(AT - 3_600_000));
	await publishDoctorRecord(redis, "mini2", rec(AT + 5_000));
	redis.sets.get(DOCTOR_HOSTS).add("gone");
	redis.sets.get(DOCTOR_HOSTS).add("../not-a-name");
	redis.calls.length = 0;
	const got = await readDoctorResults(redis, { names: ["mini3"], now: () => AT });
	assert.deepEqual(got.hosts.map((h) => [h.name, h.ageMs]), [["mini1", 3_600_000], ["mini2", 0]], "a record ahead of our clock reads as age 0");
	assert.deepEqual(got.hosts[0].checks, [{ id: "valkey.1", level: "warn", label: "w <path>", fix: "f" }]);
	assert.deepEqual(got.hosts[0].by, { uid: null, worker: false });
	assert.equal(got.hosts[0].every, 24);
	assert.equal(redis.calls.filter((c) => c[0] === "mget").length, 1, "one MGET for every host");
	assert.deepEqual(redis.calls.find((c) => c[0] === "mget").slice(1), ["doctor:h:mini3", "doctor:h:gone", "doctor:h:mini1", "doctor:h:mini2"], "worker names only: the live ones first, then the index, each sorted");
	assert.deepEqual(redis.calls.filter((c) => c[0] === "srem"), [["srem", DOCTOR_HOSTS, "gone"]], "only an INDEX member whose record is gone is pruned; a live name never was in it");
	const readOnly = fakeRedis();
	readOnly.sets.set(DOCTOR_HOSTS, new Set(["gone"]));
	assert.deepEqual(await readDoctorResults(readOnly, { prune: false, now: () => AT }), { hosts: [], more: 0 });
	assert.equal(readOnly.calls.filter((c) => c[0] === "srem").length, 0, "a reader that promises no write prunes nothing");
});

test("read back: unreachable is not empty, and a hostile record is read through the allowlist or not at all", async () => {
	assert.ok((await readDoctorResults(fakeRedis({ fail: true }))).unreachable);
	assert.ok((await readDoctorResults(fakeRedis({ hang: true }), { timeoutMs: 5 })).unreachable, "a hang is bounded");
	assert.deepEqual(await readDoctorResults(fakeRedis(), { now: () => AT }), { hosts: [], more: 0 });
	const redis = fakeRedis();
	redis.sets.set(DOCTOR_HOSTS, new Set(["bad", "v2", "hostile"]));
	redis.strings.set("doctor:h:bad", { value: "{not json" });
	redis.strings.set("doctor:h:v2", { value: JSON.stringify({ v: 2, at: AT }) });
	redis.strings.set(
		"doctor:h:hostile",
		{
			value: JSON.stringify({
				v: 1,
				at: AT,
				version: "<script>",
				openshell: "yes",
				counts: { ok: -1, warn: 2.5, fail: 3 },
				checks: [{ id: "valkey.1", level: "fail", label: "\u001b[2J evil\u202e", fix: 7, extra: "dropped" }, { id: "bad id", level: "fail" }, { id: "a.1", level: "panic" }, { id: "ok.1", level: "ok", label: "an ok label is never shown" }],
				more: "many",
				extra: { nested: true },
			}),
		},
	);
	const got = await readDoctorResults(redis, { now: () => AT });
	assert.deepEqual(got.hosts, [
		{ name: "bad", unreadable: true },
		{ name: "hostile", ageMs: 0, at: AT, version: "", openshell: false, every: null, by: { uid: null, worker: false }, workerRun: null, counts: { ok: 0, warn: 0, fail: 3 }, checks: [{ id: "valkey.1", level: "fail", label: " [2J evil " }, { id: "ok.1", level: "ok" }], more: 0 },
		{ name: "v2", unreadable: true },
	]);
	assert.equal(parseDoctorRecord("null"), null);
	assert.equal(parseDoctorRecord(JSON.stringify({ v: 1, at: -5 })), null);
});

test("the interval as the service reads it: 24 by default, 0 is off, a week the ceiling, anything else unknown", () => {
	assert.equal(doctorIntervalHours({}), 24);
	assert.equal(doctorIntervalHours({ PI_DOCTOR_INTERVAL_HOURS: "" }), 24);
	assert.equal(doctorIntervalHours({ PI_DOCTOR_INTERVAL_HOURS: "0" }), 0);
	assert.equal(doctorIntervalHours({ PI_DOCTOR_INTERVAL_HOURS: "168" }), 168);
	for (const bad of ["169", "-1", "1.5", "x", "24h"]) assert.equal(doctorIntervalHours({ PI_DOCTOR_INTERVAL_HOURS: bad }), null, bad);
});

test("the cap reads the LIVE hosts first: seventy expired index members cannot push a live host out of the read", async () => {
	const redis = fakeRedis();
	const stale = Array.from({ length: 70 }, (_, i) => `aa-stale-${String(i).padStart(2, "0")}`);
	redis.sets.set(DOCTOR_HOSTS, new Set([...stale, "zz-live"]));
	await publishDoctorRecord(redis, "zz-live", buildDoctorRecord({ checks: [{ ok: true }], ids: ["node.1"], at: AT, version: "1" }), { timeoutMs: 50 });
	const got = await readDoctorResults(redis, { names: ["zz-live"], prune: false, now: () => AT });
	assert.deepEqual(got.hosts.map((h) => h.name), ["zz-live"], "the live host is read, and so drawn as published");
});

test("the publisher prunes the expired members it sees, so a console-only deployment's index does not grow without bound", async () => {
	const redis = fakeRedis();
	redis.sets.set(DOCTOR_HOSTS, new Set(["gone-1", "gone-2", "kept"]));
	redis.strings.set(doctorKey("kept"), { value: JSON.stringify(buildDoctorRecord({ checks: [], ids: [], at: AT, version: "1" })) });
	await publishDoctorRecord(redis, "mini1", buildDoctorRecord({ checks: [], ids: [], at: AT, version: "1" }));
	assert.deepEqual([...redis.sets.get(DOCTOR_HOSTS)].sort(), ["kept", "mini1"]);
});

test("an operator's run over the worker's names the worker's run it replaced, with its uid; the worker's own run does not", async () => {
	const redis = fakeRedis();
	const rec = (by, at) => buildDoctorRecord({ checks: [], ids: [], at, version: "1", by });
	await publishDoctorRecord(redis, "mini1", rec({ uid: 1001, worker: true }, AT - 3_600_000));
	const sudo = await publishDoctorRecord(redis, "mini1", rec({ uid: 0, worker: false }, AT));
	assert.deepEqual(sudo.by, { uid: 0, worker: false });
	assert.deepEqual(sudo.workerRun, { uid: 1001, at: AT - 3_600_000 });
	const again = await publishDoctorRecord(redis, "mini1", rec({ uid: 0, worker: false }, AT + 1));
	assert.deepEqual(again.workerRun, { uid: 1001, at: AT - 3_600_000 }, "carried while operators keep publishing over it");
	const same = await publishDoctorRecord(redis, "mini1", rec({ uid: 1001, worker: false }, AT + 2));
	assert.equal(same.workerRun, undefined, "the worker's own account by hand replaces nothing worth naming");
	const worker = await publishDoctorRecord(redis, "mini1", rec({ uid: 1001, worker: true }, AT + 3));
	assert.equal(worker.workerRun, undefined);
	assert.deepEqual(parseDoctorRecord(JSON.stringify(sudo)).workerRun, { uid: 1001, at: AT - 3_600_000 });
	const broken = fakeRedis();
	broken.get = async () => {
		throw new Error("no GET");
	};
	assert.ok(await publishDoctorRecord(broken, "mini1", rec({ uid: 0 }, AT)), "a GET that fails costs the note, never the publish");
});

test("JSON.parse's own messages, on adversarial files, publish no byte of the file", () => {
	const secret = "mysecretprompt-0123456789";
	const inputs = [`{"prompt": ${secret} here}`, `${secret} plain`, `{"a":1, "b": "${secret}", c}`, `{"k": tru${secret}}`, `["${secret}", ]`, `{"${secret}"}`, `"${secret}" junk`];
	for (const text of inputs) {
		let message;
		try {
			JSON.parse(text);
			continue;
		} catch (e) {
			message = e.message;
		}
		const label = redactText(`triggers file is refused at load -- the receiver will refuse to start: /d/triggers.json: ${message}`);
		assert.ok(!label.includes(secret.slice(0, 6)), `${JSON.stringify(message)} -> ${label}`);
		assert.match(label, /^triggers file is refused at load -- the receiver will refuse to start: <path>: /);
	}
	assert.equal(redactText("Unexpected token 'm', ...\"\"prompt\": mysecretpr\"... is not valid JSON"), "<content> is not valid JSON");
	assert.equal(redactText("Expected ',' or '}' after property value in JSON at position 9 (line 1 column 10)"), "Expected ',' or '}' after property value in JSON at position 9 (line 1 column 10)", "a position quotes nothing and stays");
});

test("path shapes a person writes: after a colon, a bar, a star or a dash, in an scp spelling, a home path, and with spaces", () => {
	const cases = [
		["name:/abs/path x", "name:<path> x"],
		["path:/etc/x", "path:<path>"],
		["a \u2014/x b", "a \u2014<path> b"],
		["a|/x", "a|<path>"],
		["*/x", "*<path>"],
		["scp user@host:~/dev now", "scp user@host:<path> now"],
		["~/notes.txt", "<path>"],
		["/Users/rob/My Projects/pi/.env is bad", "<path> is bad"],
		["C:\\Program Files\\pi\\x.json missing", "<path> missing"],
		['"/Users/rob/My Projects/x" quoted', '"<path>" quoted'],
		["in /home/rob/my\u00a0dir/x", "in <path>"],
		["file:///home/rob/x.json", "file://<path>"],
		["ssh user:verysecretpass@host", "ssh [redacted]@host"],
		["api.x.com/v1?key=abcdef123456&x=1", "api.x.com/v1?key=[redacted]&x=1"],
	];
	for (const [input, want] of cases) assert.equal(redactText(input), want, input);
	assert.equal(redactText("Europe/Amsterdam 2/4 acme/web ghcr.io/x/y:1 and / or N/A"), "Europe/Amsterdam 2/4 acme/web ghcr.io/x/y:1 and / or N/A", "what a path is not");
});

test("the publish token shapes: a JWT, a Google key, Hugging Face and npm tokens; and the separators and marks are controls", () => {
	for (const t of ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "AIzaSyA1234567890abcdefghijklmnopqrstu", "hf_abcdefghijklmnopqrstuvwxyz", "npm_abcdefghijklmnopqrstuvwxyz12"]) assert.equal(redactText(`token ${t} here`), "token [redacted] here", t);
	assert.equal(redactText("a\u2028b\u2029c\u061cd"), "a b c d");
	assert.doesNotMatch(readFileSync(new URL("../src/doctor-results.mjs", import.meta.url), "utf8"), /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/, "no invisible character in the source");
});

test("invisible characters are deleted before the rules, so they cannot split a token, a path or a name", () => {
	assert.equal(redactText("token ghp_\u200bABCDEFGHIJKLMNOPQRSTUV here"), "token [redacted] here");
	assert.equal(redactText("token ghp_ABCDEFGH\u2060IJKLMNOPQRSTUV here"), "token [redacted] here");
	assert.equal(redactText("token ghp_ABCDEFGH\u00adIJKLMNOPQRSTUV here"), "token [redacted] here", "the soft hyphen");
	assert.equal(redactText("at /\u200bUsers/rob/x now"), "at <path> now");
	assert.equal(redactText("pass\u00adword=hunter2hunter2"), "password=[redacted]");
	assert.equal(redactText("a\u180eb\ufeffc"), "abc");
	assert.equal(redactText("a\nb\u2028c"), "a b c", "a line break is still a space");
});

test("JSON.parse's quote is cut from where its message starts, so an earlier quoted value survives, with no stray quote", () => {
	assert.equal(redactText(`envelope path "/a/b" must be absolute: Unexpected token 'q', "q" is not valid JSON`), `envelope path "<path>" must be absolute: <content> is not valid JSON`);
	assert.equal(redactText(`envelope "x y" bad: "abc def" is not valid JSON`), `envelope "x y" bad: <content> is not valid JSON`);
	assert.equal(redactText(`boot: "Unexpected token 's', \\"{ \\"a\\": secretTABv\\"... is not valid JSON"`), `boot: "<content> is not valid JSON"`, "the escaped form a quoted value carries keeps both its own quotes");
});

test("credential forms outside a URL: any credential-named query or fragment parameter, assignments, flags, Basic and api-key headers", () => {
	const cases = [
		["gitlab.lan/api/v4?private_token=abcdefgh123", "gitlab.lan/api/v4?private_token=[redacted]"],
		["host/cb#access_token=abcdef123", "host/cb#access_token=[redacted]"],
		["host/x?client_secret=zzzzzzzz&page=2", "host/x?client_secret=[redacted]&page=2"],
		["password=hunter2hunter2 is wrong", "password=[redacted] is wrong"],
		["VALKEY_PASSWORD=hunter2hunter2 is set", "VALKEY_PASSWORD=[redacted] is set"],
		['YAML bad: "password: hunter2hunter2"', 'YAML bad: "password: [redacted]"'],
		["run it with --password hunter2hunter2", "run it with --password [redacted]"],
		["or --token=abcdef123456", "or --token=[redacted]"],
		["Basic dXNlcjpodW50ZXIy", "Basic [redacted]"],
		["x-api-key: 0123456789abcdef", "x-api-key: [redacted]"],
	];
	for (const [input, want] of cases) assert.equal(redactText(input), want, input);
	assert.equal(redactText("the daily token cap is 40 and Basic auth is off"), "the daily token cap is 40 and Basic auth is off", "prose about tokens and Basic auth is not a credential");
});

test("a numeric or switch value of a secret-sounding knob is not a secret, and the count suffixes are not secret names", () => {
	const values = secretValuesIn({ PI_SESSION_MAX_BYTES: "1048576", PI_DAILY_TOKEN_CAP: "40", PI_AUTH_FROM_PI: "1", PI_SESSION_FLAG: "true", PI_SECRET_RESOLVER_ROOTS: "/opt/a", PI_SECRET_PROFILES: "vault:/x", PI_SECRET_BUNDLES: "b:/y", PI_SECRET_RESOLVE_TIMEOUT_MS: "15000", PI_SESSION_TOKENS: "abcdef", REAL_TOKEN: "tok-0123456789" });
	assert.deepEqual(values, ["tok-0123456789"]);
});
