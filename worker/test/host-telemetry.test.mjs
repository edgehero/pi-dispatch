import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSandboxTelemetry, parseBudgetFrom, parseCpuReserve, parseSandboxes, SANDBOX_READ_MS } from "../src/host-telemetry.mjs";
import { computeHostBudget } from "../src/host-budget.mjs";
import { listSandboxes, sandboxDeadline } from "../src/sandbox-store.mjs";

const instant = 1_800_000_000_000;
const manifest = (jobId, backend = "local", offset = 0) => ({ jobId, backend, createdAt: new Date(instant + offset).toISOString(), dir: "/private/clone", prompt: "never publish" });

test("retained workspace publication bounds and scrubs data, takes store deadlines, and caches reads for one minute", () => {
	let clock = instant;
	let reads = 0;
	let rows = Array.from({ length: 35 }, (_, i) => manifest(`run-${i}`, "podman", i));
	rows.push({ ...manifest("unsafe/path"), keepUntil: new Date(instant + 100_000).toISOString() });
	const read = makeSandboxTelemetry({ list: () => (reads++, rows), deadline: sandboxDeadline, retentionHours: 24, now: () => clock });
	const first = read();
	assert.equal(first.sandboxesMore, "4");
	assert.equal(parseSandboxes(first.sandboxes).length, 32);
	assert.equal(parseSandboxes(first.sandboxes)[0].id, "run-34");
	assert.doesNotMatch(first.sandboxes, /private|clone|prompt|never publish/);
	rows = [{ ...manifest("unsafe/path", "openshell"), keepUntil: new Date(instant + 100_000).toISOString() }];
	clock += SANDBOX_READ_MS - 1;
	assert.deepEqual(read(), first);
	assert.equal(reads, 1);
	clock++;
	const next = parseSandboxes(read().sandboxes);
	assert.match(next[0].id, /^sha256:[a-f0-9]{16}$/);
	assert.deepEqual([next[0].v, next[0].until, next[0].pin], ["openshell", instant + 100_000, true]);
	assert.equal(reads, 2);
});

test("retention off and old manifests follow the sandbox store's rules; failures do not claim an empty host", () => {
	let clock = instant;
	let fail = false;
	const logs = [];
	const old = manifest("old");
	delete old.backend;
	const read = makeSandboxTelemetry({ list: () => { if (fail) throw new Error("unreadable"); return [old, manifest("unknown", null)]; }, deadline: sandboxDeadline, retentionHours: 0, now: () => clock, log: (event, fields) => logs.push({ event, fields }) });
	assert.deepEqual(parseSandboxes(read().sandboxes), [{ id: "old", v: "local", until: instant, pin: false }]);
	assert.equal(read().sandboxRetentionHours, "0");
	fail = true;
	clock += SANDBOX_READ_MS;
	assert.equal(parseSandboxes(read().sandboxes), null);
	assert.equal(read().sandboxesMore, "");
	assert.deepEqual(logs, [{ event: "host_sandboxes_unreadable", fields: { reason: "read-failed" } }]);
	assert.throws(() => listSandboxes({ sandboxDir: "/absent", fs: { readdirSync() { throw new Error("unreadable"); } }, throwOnReadFailure: true }), /unreadable/);
	assert.deepEqual(listSandboxes({ sandboxDir: "/absent", fs: { readdirSync() { throw new Error("unreadable"); } } }), []);
});

test("registry telemetry parsers accept old absent fields and reject malformed data without carrying arbitrary keys", () => {
	for (const raw of [undefined, "", "{", "x".repeat(40_000), {}]) {
		assert.equal(parseSandboxes(raw), null);
		assert.equal(parseCpuReserve(raw), null);
		assert.equal(parseBudgetFrom(raw), null);
	}
	assert.deepEqual(parseSandboxes([{ id: "safe", v: "local", until: null, pin: false, dir: "/private" }]), [{ id: "safe", v: "local", until: null, pin: false }]);
	const detail = computeHostBudget({ memory: { mode: "auto" }, cpus: { mode: "auto" }, reserveMemory: { mode: "auto" }, reserveCpus: { mode: "auto" } }, { memTotalMiB: 32768, hostCpus: 8 }).detail;
	assert.deepEqual(parseBudgetFrom(JSON.stringify({ ...detail, path: "/private" })), detail);
	assert.equal(parseBudgetFrom({ ...detail, cpuReserveCenti: -1 }), null);
	assert.equal(parseBudgetFrom({ ...detail, memMode: "guess" }), null);
});

test("CPU quota publication preserves held, absent and wrong-quota states, never paths or runtime errors", () => {
	const statuses = ["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"];
	for (const status of statuses) {
		assert.deepEqual(parseCpuReserve([{ venue: "local", status, wantCenti: 400, quotaCenti: 200, path: "/sys/private", reason: "secret" }]), [{ venue: "local", status, wantCenti: 400, quotaCenti: 200 }]);
	}
	assert.deepEqual(parseCpuReserve([{ venue: "local", status: "differs", wantCenti: null, quotaCenti: 200 }]), [{ venue: "local", status: "differs", wantCenti: null, quotaCenti: 200 }]);
	assert.deepEqual(parseCpuReserve([{ venue: "local", status: "invented" }, { venue: "unknown", status: "held" }]), []);
});


test("a malformed nonempty inventory cannot become a claim that no workspace remains (#748)", () => {
	const good = { id: "safe", v: "local", until: null, pin: false };
	for (const bad of [null, [], 3, { ...good, id: "a/b" }, { ...good, v: "unknown" }, { ...good, until: -1 }, { ...good, pin: "false" }]) {
		assert.equal(parseSandboxes(JSON.stringify([bad])), null);
		assert.equal(parseSandboxes([good, bad]), null, "a partial inventory is unknown, not complete");
	}
	assert.equal(parseSandboxes(Array.from({ length: 33 }, () => good)), null, "a list over the publication bound is not silently cut");
	assert.deepEqual(parseSandboxes("[]"), [], "only a verified empty list claims no retained workspace");
});

test("per-workspace image and source kind survive telemetry without paths, project guesses or private fields (#771)", () => {
	const image = `ghcr.io/edgehero/pi-job@sha256:${"a".repeat(64)}`;
	for (const kind of ["local", "github", "gitlab", "forgejo", "azure"]) {
		const row = { ...manifest(`run-${kind}`), image, kind, folder: "/private/source", project: "unverified-project" };
		const read = makeSandboxTelemetry({ list: () => [row], deadline: sandboxDeadline, retentionHours: 24, now: () => instant });
		const raw = read().sandboxes;
		assert.deepEqual(parseSandboxes(raw), [{ id: `run-${kind}`, v: "local", until: instant + 24 * 3_600_000, pin: false, image, kind }]);
		assert.doesNotMatch(raw, /private|folder|project|prompt/);
	}
});

test("malformed optional image or kind facts make source and parsed inventories unknown (#771)", () => {
	const good = { id: "safe", v: "local", until: null, pin: false };
	for (const patch of [{ image: "--help" }, { image: " job:one" }, { image: "job:one\nsecret" }, { image: null }, { kind: "a/private/folder" }, { kind: "watch" }, { kind: null }]) {
		assert.equal(parseSandboxes([good, { ...good, ...patch }]), null, JSON.stringify(patch));
		const read = makeSandboxTelemetry({ list: () => [{ ...manifest("bad"), ...patch }], deadline: sandboxDeadline, retentionHours: 24, now: () => instant });
		assert.equal(parseSandboxes(read().sandboxes), null, "a corrupt present fact cannot be dropped into a plausible complete inventory");
		assert.equal(read().sandboxesMore, "");
	}
});
