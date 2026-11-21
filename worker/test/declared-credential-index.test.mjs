import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { boundSecretsResolver, makeProcessor } from "../src/index.mjs";
import { withDeferRecords } from "./helpers/defer-redis.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

// Issue #967: the processor names the declared main credential to the resolver, and the wiring that binds the resolver
// to this job's abort signal and overlay table (index.mjs) must pass that name on rather than drop it. Dropped, the
// resolver keeps the provider's own variable reserved and every such job is refused as secret-name-reserved.
test("issue #967: the resolver wrapper forwards the declared main credential under its own signal and overlay table, and runContainer gets the name", async () => {
	const root = tempDir("pi-declared-index-");
	const resolverSaw = [];
	const containerSaw = [];
	const records = [];
	const redis = withDeferRecords({ async incr() { return 1; }, async decr() { return 0; }, async expire() {} });
	const processor = makeProcessor({
		cancelJob() {}, stopContainer() {}, redis, hostName: "h", now: () => NOW,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, secretProfiles: { panel: "/opt/pi/panel.sh" } }),
		recordRun: (r) => records.push(r), timeoutMs: 100_000,
		deps: {
			checkProviderCredential: (job) => (job.provider === "openrouter" ? { ok: true, declared: "OPENROUTER_API_KEY" } : { ok: true }),
			resolveSecrets: async (_job, options) => (resolverSaw.push(options), { ok: true, secrets: { OPENROUTER_API_KEY: "sk-or-declared" } }),
			async mintToken() { return "token"; },
			async isDefaultBranchProtected() { return true; },
			async prepareWorkspace() {
				const jobDir = join(root, `job-${records.length}`);
				mkdirSync(join(jobDir, "workspace"), { recursive: true });
				return { workspace: join(jobDir, "workspace"), jobDir };
			},
			async runContainer(ctx) {
				containerSaw.push(ctx);
				return { code: 0, aborted: false, turns: 1, tokens: null };
			},
			async cleanup() {},
			async comment() {},
			log: () => {},
		},
	});
	const job = { id: "gh-declared-1", name: "github", attemptsMade: 0, opts: { attempts: 2 }, data: { kind: "github", repo: "o/r", provider: "openrouter", model: "deepseek/deepseek-chat", target: { type: "issue", number: 7 }, flow: "fix", secrets: { OPENROUTER_API_KEY: "op://ci/or/key" }, trigger: { deliveryId: "d1", matched: { index: 0, type: "label", label: "pi" } } }, async moveToDelayed() {} };
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.outcome, "completed", JSON.stringify(result));
	assert.equal(resolverSaw.length, 1);
	assert.equal(resolverSaw[0].mainCredential, "OPENROUTER_API_KEY", "the processor's option survives the wrapper");
	assert.deepEqual(resolverSaw[0].overlayProfiles, { panel: "/opt/pi/panel.sh" }, "beside this job-start's overlay table");
	assert.ok(resolverSaw[0].signal instanceof AbortSignal, "and the job's own abort signal");
	assert.equal(containerSaw[0].mainCredential, "OPENROUTER_API_KEY");
});

test("issue #967: the processor's options cannot replace the job's own abort signal or overlay table", async () => {
	const seen = [];
	const own = new AbortController().signal;
	const bound = boundSecretsResolver(async (_job, options) => (seen.push(options), { ok: true, secrets: {} }), { signal: own, overlayProfiles: { panel: "/opt/pi/panel.sh" } });
	await bound({ secrets: { A: "ref" } }, { mainCredential: "OPENROUTER_API_KEY", signal: new AbortController().signal, overlayProfiles: { forged: "/tmp/forged.sh" } });
	await bound({ secrets: { A: "ref" } });
	assert.equal(seen[0].mainCredential, "OPENROUTER_API_KEY");
	assert.equal(seen[0].signal, own);
	assert.deepEqual(seen[0].overlayProfiles, { panel: "/opt/pi/panel.sh" });
	assert.deepEqual(seen[1], { signal: own, overlayProfiles: { panel: "/opt/pi/panel.sh" } }, "no options: the call it always was");
});
