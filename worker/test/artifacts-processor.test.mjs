import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { artifactLimitsOf, makeArtifactsRuntime } from "../src/artifacts.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { withDeferRecords } from "./helpers/defer-redis.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const SECRET = "ghs_processorsecret123456";

function harness({ run, artifacts = true } = {}) {
	const root = tempDir("pi-artifacts-proc-");
	const records = [];
	const staged = [];
	const store = join(root, "store");
	const runtime = makeArtifactsRuntime({ storeDir: store, limits: artifactLimitsOf({ maxFiles: 5, maxFileMb: 1, maxRunMb: 2 }), retentionDays: 14, now: () => NOW });
	const redis = withDeferRecords({ async incr() { return 1; }, async decr() { return 0; }, async expire() {} });
	const processor = makeProcessor({
		cancelJob() {}, stopContainer() {}, redis, hostName: "h", now: () => NOW,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: (r) => records.push(r), timeoutMs: 100_000,
		deps: {
			...(artifacts ? { artifacts: runtime } : {}),
			async mintToken() { return "token"; },
			async isDefaultBranchProtected() { return true; },
			async prepareWorkspace() {
				const jobDir = join(root, `job-${records.length}`);
				mkdirSync(join(jobDir, "workspace"), { recursive: true });
				return { workspace: join(jobDir, "workspace"), jobDir };
			},
			async runContainer({ prepared }) {
				staged.push(prepared.artifactsDir ?? null);
				// What run-container.mjs defines before its spawn: the job's own secret values.
				Object.defineProperty(prepared, "credentialSecretValues", { value: [SECRET], configurable: true });
				return run(prepared);
			},
			async cleanup() {},
			async comment() {},
			log: () => {},
		},
	});
	const job = (id) => ({ id, name: "github", attemptsMade: 0, opts: { attempts: 2 }, data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: id, matched: { index: 0, type: "label", label: "pi" } } }, async moveToDelayed() {} });
	return { root, store, records, staged, run: (id) => processor(job(id), "tok", new AbortController().signal) };
}

test("a forge job's container gets a staged folder, and what it left is kept and counted on its record", async () => {
	const h = harness({
		run: (prepared) => {
			writeFileSync(join(prepared.artifactsDir, "report.txt"), `used ${SECRET}\n`);
			writeFileSync(join(prepared.artifactsDir, "bad name.txt"), "x");
			return { code: 0, aborted: false, turns: 1, tokens: null };
		},
	});
	const result = await h.run("gh-run-1");
	assert.equal(result.outcome, "completed");
	assert.match(h.staged[0], /artifacts$/);
	assert.deepEqual(result.artifacts, { kept: 1, bytes: result.artifacts.bytes, dropped: { name: 1 } });
	const record = buildRecord({ job: { id: "gh-run-1", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix" } }, result, startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW).toISOString() });
	assert.deepEqual(record.artifacts, result.artifacts);
	assert.ok(existsSync(join(h.store, "gh-run-1", "files", "report.txt")));
});

test("an aborted container's folder is never read, and a host that keeps none stages none", async () => {
	const aborted = harness({
		run: (prepared) => {
			writeFileSync(join(prepared.artifactsDir, "late.txt"), "x");
			return { code: 137, aborted: true };
		},
	});
	const result = await aborted.run("gh-run-2");
	assert.equal(result.artifacts, undefined, "a writer may still be alive after a stop that did not take");
	assert.equal(existsSync(join(aborted.store, "gh-run-2")), false);
	const off = harness({ artifacts: false, run: () => ({ code: 0, aborted: false, turns: 1, tokens: null }) });
	await off.run("gh-run-3");
	assert.deepEqual(off.staged, [null]);
});
