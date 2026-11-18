import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";

const job = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", target: { type: "issue", number: 1 }, trigger: { matched: { index: 0, type: "label" } } };
const binding = { id: "devices", bundle: { profile: "device-profile", ref: "device-environment", project: "hardware", files: ["KEY"] } };
function setup(over = {}) {
	const calls = [];
	const runs = [];
	const logs = [];
	let count = 0;
	const deps = {
		redis: { incr: async () => (calls.push("reserve"), ++count), decr: async () => --count, expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null }, softHoldPct: null,
		imagePreflight: async () => ({ ok: true, image: "job:test", capabilities: ["secretFiles"] }),
		mintToken: async () => (calls.push("mint"), "token"),
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async (opts) => (calls.push("run"), runs.push(opts), { code: 0, aborted: false }),
		resolveSecrets: async () => (calls.push("resolve"), { ok: true, secrets: {}, secretFiles: { KEY: "private-key\n" } }),
		secretBundles: { lookup: () => ({ ok: true }), resolve: async () => (calls.push("bundle"), { ok: true, vars: { KEY: "bundle-key\n", ENV: "environment-value" } }) },
		resolvePullRequestHead: async () => (calls.push("head"), { headRepo: "fork/repo" }),
		cleanup: async () => {}, comment: async () => {}, log: (event, fields) => logs.push({ event, fields }),
		now: new Date("2026-11-18T12:00:00Z"),
		...over,
	};
	return { deps, calls, runs, logs };
}

test("file-only trigger resolves before mint and passes contents separately from environment values (#919)", async () => {
	const d = setup();
	const result = await runJob({ ...job, secretFiles: { KEY: "opaque-reference" } }, d.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(d.calls.slice(0, 3), ["resolve", "mint", "prepare"]);
	assert.deepEqual(d.runs[0].secrets, {});
	assert.deepEqual(d.runs[0].secretFiles, { KEY: "private-key\n" });
	assert.deepEqual(result.secretFiles, ["KEY"]);
	assert.equal(JSON.stringify([result, d.logs]).includes("private-key"), false);
	assert.equal(JSON.stringify([result, d.logs]).includes("opaque-reference"), false);
});

test("no declaration reaches neither resolver nor file delivery (#919)", async () => {
	const d = setup();
	const result = await runJob(job, d.deps);
	assert.equal(result.outcome, "completed");
	assert.equal(d.calls.includes("resolve"), false);
	assert.equal(d.runs[0].secretFiles, undefined);
	assert.equal(result.secretFiles, undefined);
});

test("placement protects ungranted jobs before every resolver, mint or budget reservation (#919)", async () => {
	const d = setup({ checkSecretFilesPlacement: () => ({ outcome: "policy", reason: "secret-files-placement-unsafe" }) });
	assert.equal((await runJob(job, d.deps)).reason, "secret-files-placement-unsafe");
	assert.deepEqual(d.calls, []);
	const unavailable = setup({ checkSecretFilesPlacement: () => ({ unavailable: true }) });
	await assert.rejects(runJob(job, unavailable.deps), error => error instanceof InfraRetry);
	assert.deepEqual(unavailable.calls, []);
});

test("an image missing file support refuses before either resolver or any spend (#919)", async () => {
	for (const bundled of [false, true]) {
		const d = setup({ imagePreflight: async () => ({ ok: true, image: "job:old", capabilities: [] }), ...(bundled ? { findSecretBundle: () => binding } : {}) });
		const result = await runJob(bundled ? job : { ...job, secretFiles: { KEY: "ref" } }, d.deps);
		assert.equal(result.reason, "job-image-secret-files-unsupported");
		assert.equal(result.budgetReserved, false);
		assert.deepEqual(d.calls, []);
	}
});

test("a resolver returning environment values without the requested file refuses instead of running unconfigured (#919)", async () => {
	const d = setup({ resolveSecrets: async () => ({ ok: true, secrets: { KEY: "wrong-delivery" } }) });
	const result = await runJob({ ...job, secretFiles: { KEY: "ref" } }, d.deps);
	assert.equal(result.reason, "secret-unresolved");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(d.calls, []);
});

test("reserved file names are refused before invoking an injected resolver (#919)", async () => {
	const d = setup();
	const result = await runJob({ ...job, secretFiles: { PI_PROVIDER: "ref" } }, d.deps);
	assert.equal(result.reason, "secret-name-reserved");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(d.calls, []);
});

test("unsafe queued file names refuse before resolution or spend without printing the name (#919)", async () => {
	for (const name of ["../private-name", "CON", "a".repeat(129), "__proto__"]) {
		const comments = [];
		const d = setup({ comment: async (_job, text) => comments.push(text) });
		const result = await runJob({ ...job, secretFiles: Object.fromEntries([[name, "opaque-reference"]]) }, d.deps);
		assert.equal(result.reason, "secret-file-name-invalid");
		assert.equal(result.budgetReserved, false);
		assert.deepEqual(d.calls, []);
		assert.equal(JSON.stringify([d.logs, comments]).includes(name), false);
	}
});

test("bundle files are partitioned from environment values before the venue sees them (#919)", async () => {
	const asks = [];
	const d = setup({ findSecretBundle: () => binding, bundleGate: async (_job, ask) => (asks.push(ask), { ok: true }) });
	const result = await runJob(job, d.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(d.runs[0].secrets, { ENV: "environment-value" });
	assert.deepEqual(d.runs[0].secretFiles, { KEY: "bundle-key\n" });
	assert.deepEqual(asks[0].fileNames, ["KEY"]);
	assert.equal(asks[0].vars, null);
	assert.deepEqual(asks[1].vars, { ENV: "environment-value" });
	assert.deepEqual(d.runs[0].bundleKeys, { endpoints: {}, plain: ["ENV"] });
	assert.deepEqual(result.secretFiles, ["KEY"]);
});

test("an explicit environment override removes the bundle's file delivery and capability need (#919)", async () => {
	const d = setup({ imagePreflight: async () => ({ ok: true, capabilities: [] }), findSecretBundle: () => binding, resolveSecrets: async () => ({ ok: true, secrets: { KEY: "explicit-env" } }) });
	const result = await runJob({ ...job, secrets: { KEY: "ref" } }, d.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(d.runs[0].secrets, { KEY: "explicit-env", ENV: "environment-value" });
	assert.equal(d.runs[0].secretFiles, undefined);
	assert.deepEqual(result.bundle.shadowed, ["KEY"]);
});

test("bundle endpoint and file-name collisions are refused before resolution (#919)", async () => {
	for (const [extra, field, reason] of [
		[{ files: undefined, endpoints: { KEY: { host: "device.example", auth: "bearer" } } }, "KEY", "secret-file-endpoint-conflict"],
		[{}, "key", "secret-file-name-conflict"],
	]) {
		const d = setup({ findSecretBundle: () => ({ ...binding, bundle: { ...binding.bundle, ...extra } }) });
		const result = await runJob({ ...job, secretFiles: { [field]: "ref" } }, d.deps);
		assert.equal(result.reason, reason);
		assert.equal(result.budgetReserved, false);
		assert.deepEqual(d.calls, []);
	}
});

test("a fork which skips its bundle requires no file capability and reads no bundle (#919)", async () => {
	const d = setup({ imagePreflight: async () => ({ ok: true, capabilities: [] }), findSecretBundle: () => binding });
	const result = await runJob({ ...job, target: { type: "pull_request", number: 1 } }, d.deps);
	assert.equal(result.outcome, "completed");
	assert.equal(result.bundleSkipped, "fork");
	assert.equal(d.calls.includes("bundle"), false);
	assert.equal(d.runs[0].secretFiles, undefined);
});

test("a container infrastructure failure carries only resolved file names in its outcome (#919)", async () => {
	const d = setup({ runContainer: async () => { throw new InfraRetry("container-never-started"); } });
	await assert.rejects(runJob({ ...job, secretFiles: { KEY: "ref" } }, d.deps), (error) => {
		assert.deepEqual(error.secretFiles, ["KEY"]);
		assert.equal(JSON.stringify(error).includes("private-key"), false);
		return true;
	});
});

test("resolved file metadata survives a later refusal without claiming the container started (#919)", async () => {
	for (const bundled of [false, true]) {
		const d = setup({ isDefaultBranchProtected: async () => false, ...(bundled ? { findSecretBundle: () => binding } : {}) });
		const result = await runJob(bundled ? job : { ...job, secretFiles: { KEY: "ref" } }, d.deps);
		assert.equal(result.reason, "unprotected-branch");
		assert.deepEqual(result.secretFiles, ["KEY"]);
		assert.equal(d.runs.length, 0);
		assert.equal(d.calls.includes("reserve"), false);
		assert.equal(JSON.stringify(result).includes(bundled ? "bundle-key" : "private-key"), false);
	}
});

test("venue-reserved file names refuse before resolution, while a skipped fork bundle asks no file gate (#919)", async () => {
	for (const bundled of [false, true]) {
		const asks = [];
		const comments = [];
		const d = setup({ ...(bundled ? { findSecretBundle: () => binding } : {}), comment: async (_job, text) => comments.push(text), bundleGate: async (_job, ask) => {
			asks.push(ask);
			return { venueRefused: { reason: "openshell-bundle-name-taken", comment: "The venue reserves this environment name." } };
		} });
		const result = await runJob(bundled ? job : { ...job, secretFiles: { KEY: "private-reference" } }, d.deps);
		assert.equal(result.reason, "openshell-bundle-name-taken");
		assert.deepEqual(d.calls, []);
		assert.deepEqual(asks.map((ask) => ask.fileNames), [["KEY"]]);
		assert.deepEqual(comments, ["The venue reserves this environment name."]);
	}
	const d = setup({ findSecretBundle: () => binding, bundleGate: async () => assert.fail("a skipped bundle must not be judged") });
	assert.equal((await runJob({ ...job, target: { type: "pull_request", number: 1 } }, d.deps)).bundleSkipped, "fork");
});
