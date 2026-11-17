import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { tempDir } from "./helpers/temp-dir.mjs";
import { displayResult, DISPLAY_PROBE_TIMEOUT_MS, DISPLAY_REASONS, runDisplayProbe } from "../src/display-probe.mjs";
import { checkDisplays, displayTargets } from "../src/doctor-display.mjs";
import { buildDockerRunArgs, buildPodmanRunArgs, ISOLATION_FLAGS } from "../src/docker-run.mjs";
import { DEFAULT_JOB_SIZE } from "../src/job-size.mjs";

const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
const PNG_BYTES = PNG.sync.write({ width: 800, height: 600, data: Buffer.alloc(800 * 600 * 4, 255) });
const SUCCESS = { code: 0, stdout: JSON.stringify({ v: 1, ok: true, reason: "rendered", width: 800, height: 600, sha256: createHash("sha256").update(PNG_BYTES).digest("hex"), memoryPeak: 100, pidsPeak: 10 }) };
const ID = "a".repeat(64);

test("the troubleshooting table covers every image and host display failure", () => {
	const doc = fs.readFileSync(new URL("../../docs/job-image.md", import.meta.url), "utf8");
	const source = fs.readFileSync(new URL("../src/display-probe.mjs", import.meta.url), "utf8");
	const reasons = new Set([...DISPLAY_REASONS, ...[...source.matchAll(/reason: "([a-z-]+)"/g)].map((m) => m[1])]);
	reasons.delete("rendered");
	for (const reason of reasons) assert.ok(doc.includes(`\`${reason}\``), reason);
});

test("a success needs the bounded PNG that the in-image pixel check actually measured", () => {
	assert.equal(displayResult(SUCCESS, () => PNG_BYTES).ok, true);
	for (const bytes of [Buffer.from("PNG"), Buffer.alloc(1024 * 1024 + 1), Buffer.from(PNG_BYTES).fill(0, 33, 40)]) assert.equal(displayResult(SUCCESS, () => bytes).reason, "screenshot-invalid");
	assert.equal(displayResult(SUCCESS, () => { throw new Error("missing"); }).ok, false);
	assert.equal(displayResult({ ...SUCCESS, code: 1 }, () => PNG_BYTES).ok, false);
});

test("closed failure reasons, malformed output, stdout bounds and timeout never become success", () => {
	for (const reason of ["display-start-failed", "browser-start-failed", "screenshot-blank", "text-not-rendered"]) assert.deepEqual(displayResult({ code: 2, stdout: JSON.stringify({ v: 1, ok: false, reason }) }), { ok: false, reason });
	for (const stdout of ["", "{}", "null", "x".repeat(2049), '{"v":1,"ok":false,"reason":"secret text"}']) assert.equal(displayResult({ code: 2, stdout }).reason, "probe-result-invalid");
	assert.equal(displayResult({ code: null, ended: "timeout" }).reason, "probe-timeout");
	assert.equal(displayResult({ code: 127, stdout: "" }).reason, "probe-missing");
});

function fixture({ result = SUCCESS, start = { code: 0, stdout: ID }, throws = false, symlink = false, local = true, cleanupFails = false, podman = false } = {}) {
	const jobsDir = tempDir("pi-display-test-");
	const calls = [];
	let workspace;
	const options = {
		image: "pi-job:display", bin: podman ? "podman" : "docker", buildArgs: podman ? buildPodmanRunArgs : buildDockerRunArgs,
		jobsDir, fs, pid: 42, nonce: "abc", isAlive: () => true, user: "4242:4242", size: DEFAULT_JOB_SIZE,
		resolveEndpoint: async () => ({ local }),
		run: async (args, options) => {
			calls.push({ args, options });
			if (args[0] === "run") {
				workspace = args.find((s) => s.endsWith(":/workspace")).slice(0, -":/workspace".length);
				return start;
			}
			if (args[0] === "exec") {
				if (throws) throw new Error("daemon disappeared");
				if (symlink) fs.symlinkSync(join(jobsDir, "absent"), join(workspace, "display.png"));
				else fs.writeFileSync(join(workspace, "display.png"), PNG_BYTES);
				return result;
			}
			return { code: cleanupFails && args[0] === "rm" ? 1 : 0, stdout: "" };
		},
	};
	return { jobsDir, calls, options };
}

for (const podman of [false, true]) test(`display uses the real ${podman ? "podman" : "docker"} builder, decided uid, bounds and empty env`, async () => {
	const h = fixture({ podman });
	let captured = false;
	const result = await runDisplayProbe({ ...h.options, onScreenshot: (bytes) => { captured = true; assert.deepEqual(bytes, PNG_BYTES); } });
	assert.equal(result.ok, true);
	assert.equal(captured, true);
	const args = h.calls.find((c) => c.args[0] === "run").args;
	for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), flag);
	for (const flag of ["--memory=4g", "--memory-swap=4g", "--shm-size=1g", "--user=4242:4242", "--network=none"]) assert.ok(args.includes(flag), flag);
	assert.equal(args.includes("--userns=keep-id"), podman);
	assert.equal(args.includes("-e"), false);
	assert.equal(h.calls.find((c) => c.args[0] === "exec").options.timeoutMs, DISPLAY_PROBE_TIMEOUT_MS);
	assert.deepEqual(h.calls.at(-1).args, ["rm", "-f", ID]);
	assert.deepEqual(fs.readdirSync(h.jobsDir), []);
});

for (const scenario of [{ throws: true }, { result: { code: null, ended: "timeout" } }, { symlink: true }, { result: { code: 2, stdout: '{"v":1,"ok":false,"reason":"display-start-failed"}' } }]) test(`failed display removes its container and fixture: ${JSON.stringify(scenario)}`, async () => {
	const h = fixture(scenario);
	assert.equal((await runDisplayProbe(h.options)).ok, false);
	assert.deepEqual(h.calls.at(-1).args, ["rm", "-f", ID]);
	assert.deepEqual(fs.readdirSync(h.jobsDir), []);
});

test("partial starts are removed by ID when returned, otherwise by this run's unique name", async () => {
	for (const stdout of [ID, ""]) {
		const h = fixture({ start: { code: 1, stdout } });
		assert.equal((await runDisplayProbe(h.options)).reason, "container-start-failed");
		assert.deepEqual(h.calls.at(-1).args, ["rm", "-f", stdout || "pi-dispatch-live-display-42-abc"]);
		assert.deepEqual(fs.readdirSync(h.jobsDir), []);
	}
});

test("a changed remote endpoint does not touch the runtime or create a fixture", async () => {
	const h = fixture({ local: false });
	assert.equal((await runDisplayProbe(h.options)).reason, "venue-not-local");
	assert.deepEqual(h.calls, []);
	assert.deepEqual(fs.readdirSync(h.jobsDir), []);
});

test("the host reads artifacts only after all container writers are stopped", async () => {
	const h = fixture();
	let reads = 0;
	h.options.fs = { ...fs, readFileSync: (...args) => {
		assert.deepEqual(h.calls.at(-1).args, ["rm", "-f", ID]);
		reads++;
		return fs.readFileSync(...args);
	} };
	assert.equal((await runDisplayProbe(h.options)).ok, true);
	assert.ok(reads > 0);
});

test("cleanup failure is reported with the owned container ID, without reading or removing its fixture", async () => {
	const h = fixture({ cleanupFails: true });
	let read = false;
	h.options.fs = { ...fs, readFileSync: () => { read = true; return PNG_BYTES; } };
	const result = await runDisplayProbe(h.options);
	assert.equal(result.reason, "probe-cleanup-failed");
	assert.ok(result.notes.some((s) => s.includes(ID)));
	assert.equal(read, false);
	assert.equal(fs.readdirSync(h.jobsDir).length, 1);
});

test("default and trigger images are deduplicated per blessed venue, never across stores", () => {
	assert.deepEqual(displayTargets({ image: "base", venues: ["podman", "local"], routes: [{ image: "custom" }, { image: "custom", backend: "podman" }, { image: "custom", backend: "local" }, { image: "other", backend: "openshell" }] }), [
		{ image: "base", venue: "podman" }, { image: "base", venue: "local" }, { image: "custom", venue: "podman" }, { image: "custom", venue: "local" },
	]);
});

test("doctor checks only declared display images and keeps unverified venues distinct from failures", async () => {
	const calls = [];
	const checks = await checkDisplays({
		targets: ["old", "broken", "unverified", "good"].map((image) => ({ image, venue: "local" })), size: DEFAULT_JOB_SIZE,
		inspect: async ({ image }) => ({ ok: true, capabilities: image === "old" ? [] : ["display"] }),
		prepare: async ({ image }) => { calls.push(image); return image === "unverified" ? { run: false, reason: "venue-not-probed" } : { run: true }; },
		probe: async ({ image }) => image === "broken" ? { ok: false, reason: "display-start-failed" } : { ok: true, reason: "rendered" },
	});
	assert.deepEqual(calls, ["broken", "unverified", "good"]);
	assert.equal(checks[0].ok, false);
	assert.equal(checks[0].warn, undefined);
	assert.match(checks[0].label, /display-start-failed/);
	assert.equal(checks[1].warn, true);
	assert.equal(checks[2].ok, true);
});
