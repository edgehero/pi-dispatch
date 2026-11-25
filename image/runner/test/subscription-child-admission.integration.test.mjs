import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { injectChildMeter, subscriptionAdapterRoots } from "../src/child-route.mjs";

/**
 * Issue #1098 on the pinned pi: a SEPARATE pi process that a job's own tool starts uses the job's subscription through an
 * admission of its own, which the runner's child meter runs (usage-meter.mjs startChildMeter `admit`), loaded first by
 * the child preload. Real pi children, started as a staged package's tool would start them, with the runner's preload
 * and child ledger in their environment; a fake token, and every request answered in the child (fixtures/
 * offline-fetch.mjs, which also refuses every outbound socket): no provider, no credential, no network.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let smoke;
let runner;
let importError;
try {
	smoke = await import("./fixtures/subscription-child-smoke.mjs");
	runner = await import("./fixtures/subscription-roles-smoke.mjs");
} catch (error) {
	importError = error;
}
if (!smoke && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the subscription child proof is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = smoke ? false : `pi not installed (node ${process.version}); CI runs these`;

/** The reviewed Anthropic adapter, staged and approved from the runner tests' own fixture of it, as subscription-child.test.mjs stages it. */
async function stagedAdapter() {
	const { prepareCommunityAuthAdapter } = await import("../src/community-auth-patches.mjs");
	const root = tempDir("subscription-child-adapter-");
	execFileSync("tar", ["-xzf", fileURLToPath(new URL("../../../worker/test/fixtures/community-auth/gotgenes-pi-anthropic-auth-3.4.3.tar.gz", import.meta.url)), "--strip-components=1", "-C", root]);
	const { digest } = prepareCommunityAuthAdapter({ adapter: "@gotgenes/pi-anthropic-auth@3.4.3", root });
	return { root, digest };
}

/** An extension the spawner hands its child: it registers the subscription's provider again, at load or after the seal. */
function registering(root, when) {
	const path = join(root, `register-${when}.js`);
	mkdirSync(root, { recursive: true });
	const register = `pi.registerProvider("anthropic", { api: "anthropic-messages", streamSimple() { throw new Error("never reached"); } });`;
	writeFileSync(path, when === "load" ? `export default function (pi) { ${register} }\n` : `export default function (pi) { pi.on("before_agent_start", () => { try { ${register} } catch {} }); }\n`);
	return path;
}

test("the image's proof: an OpenAI subscription's pi child is admitted on its own, metered, and notional in the job's fold", { skip, timeout: 120_000 }, async () => {
	await smoke.verifySubscriptionChildren(tempDir("pi-subscription-children-"));
	const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	const script = readFileSync(new URL("../../verify-image.sh", import.meta.url), "utf8");
	assert.match(docker, /LABEL dev\.pi-dispatch\.capabilities="[^"\n]*\bsubscriptionChildren\b/);
	assert.match(script, /\n\t\t\tsubscriptionChildren\)[\s\S]*?--network none[\s\S]*?subscription-child-smoke\.mjs[\s\S]*?'\^subscription child capability holds\$'/);
});

test("a staged Anthropic adapter: the preload loads it right after the meter, which admits the child, and its call is notional in the fold", { skip, timeout: 120_000 }, async () => {
	const adapter = await stagedAdapter();
	const entry = smoke.subscriptionEntry("anthropic", { root: adapter.root, digest: adapter.digest });
	const argv = ["node", "/pi/dist/cli.js", "--mode", "json"];
	injectChildMeter(argv, "cli", "/meter.ts", subscriptionAdapterRoots({ PI_SUBSCRIPTION_AUTH: JSON.stringify([entry]) }));
	assert.deepEqual(argv.slice(2, 7), ["-e", "/meter.ts", "--no-mcp", "-e", adapter.root], "the meter first, the adapter second, before the spawner's own");
	const child = await smoke.subscriptionPiChild({ root: tempDir("subscription-child-anthropic-"), entry, model: smoke.ANTHROPIC_MODEL, notional: new Set(["anthropic"]) });
	assert.equal(child.answer, "child ok", `${child.errorMessage}\n${child.stderr.slice(-1500)}`);
	assert.deepEqual(child.requests.map((request) => [request.who, request.token]), [["child", true]], "one call, with the subscription's token as its bearer");
	assert.deepEqual([child.ledger.metered, child.ledger.totals.calls, child.ledger.modelRefused], [true, 1, 0]);
	assert.equal(child.fold.settledMicros, 0, "notional: no charge against the cap");
	assert.ok(child.billed.settledMicros > 0, "the control: priced as billed without the job's notional set");
});

test("an Anthropic adapter whose content is not the approved one admits nothing: the child's call is refused before it is sent", { skip, timeout: 120_000 }, async () => {
	const adapter = await stagedAdapter();
	const child = await smoke.subscriptionPiChild({ root: tempDir("subscription-child-digest-"), entry: smoke.subscriptionEntry("anthropic", { root: adapter.root, digest: "b".repeat(64) }), model: smoke.ANTHROPIC_MODEL, notional: new Set(["anthropic"]) });
	assert.deepEqual(child.requests, [], "nothing was sent");
	assert.equal(child.ledger?.modelRefused, 1, "refused, on the ledger the runner stops the job for");
	assert.equal(child.errorMessage, "pi-dispatch: model not allowed");
});

test("a second registration of the provider, at the spawner's load or after the seal, latches the conflict and the child is refused", { skip, timeout: 120_000 }, async () => {
	const adapter = await stagedAdapter();
	const entry = smoke.subscriptionEntry("anthropic", { root: adapter.root, digest: adapter.digest });
	for (const when of ["load", "after-seal"]) {
		const root = tempDir(`subscription-child-${when}-`);
		const child = await smoke.subscriptionPiChild({ root, entry, model: smoke.ANTHROPIC_MODEL, extensions: [registering(join(root, "spawner"), when)], notional: new Set(["anthropic"]) });
		assert.deepEqual(child.requests, [], `${when}: nothing was sent`);
		assert.notEqual(child.answer, "child ok", when);
		assert.equal(child.ledger?.totals.calls ?? 0, 0, `${when}: no call metered`);
	}
});

test("a pi child of a job with no subscription is as before: no adapter, no guard, its API-key call goes out", { skip, timeout: 120_000 }, async () => {
	assert.deepEqual(subscriptionAdapterRoots({}), []);
	assert.deepEqual(subscriptionAdapterRoots({ PI_SUBSCRIPTION_AUTH: "not json" }), []);
	assert.deepEqual(subscriptionAdapterRoots({ PI_SUBSCRIPTION_AUTH: JSON.stringify([smoke.subscriptionEntry("openai")]) }), [], "an OpenAI subscription has no adapter");
	assert.deepEqual(subscriptionAdapterRoots({ PI_SUBSCRIPTION_AUTH: JSON.stringify([smoke.subscriptionEntry("anthropic", { root: "relative/path" })]) }), [], "only an absolute root");
	// Folded with an OpenAI subscription's notional set: a child with no admission of its own (its spawner dropped the
	// entries) marks nothing, so its OpenAI call, made with a key it held, is charged in full, whatever its provider's name.
	const child = await smoke.subscriptionPiChild({ root: tempDir("subscription-child-none-"), entry: null, notional: new Set(["openai"]) });
	assert.equal(child.answer, "child ok", child.stderr.slice(-1500));
	assert.deepEqual([child.ledger.metered, child.ledger.totals.calls, child.ledger.modelRefused], [true, 1, 0]);
	assert.deepEqual([...child.ledger.rows.values()].map((row) => row.notional), [0], "no mark");
	assert.ok(child.fold.settledMicros > 0, "billed, as every call of a job with no subscription");
	assert.equal(child.fold.settledMicros, child.billed.settledMicros, "charged in full under the job's notional set too");
});

/** The tool a staged package might bring: it starts `pi` as a separate process and answers with that child's last answer. */
function spawningTool({ waitMs = 0 } = {}) {
	const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	return `import { spawn } from "node:child_process";
export default function (pi) {
	pi.registerTool({
		name: "spawn_child", label: "spawn_child", description: "Start a pi child.", parameters: { type: "object", properties: {} },
		async execute() {
			const out = await new Promise((resolve) => {
				const child = spawn(process.execPath, [${JSON.stringify(cli)}, "--mode", "json", "-p", "--no-session", "--model", "openai/gpt-4.1", "Task: check"], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
				let text = "";
				child.stdout.on("data", (chunk) => (text += chunk));
				child.on("close", (code) => resolve({ text, code }));
			});
			// Held before answering when asked, so the runner's child watch folds the child's ledger while the job runs.
			await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
			let answer = "no answer";
			for (const line of out.text.split("\\n")) {
				try { const event = JSON.parse(line); if (event.type === "message_end" && event.message?.role === "assistant") answer = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""); } catch {}
			}
			return { content: [{ type: "text", text: answer }], details: { code: out.code } };
		},
	});
}
`;
}

test("the real runner: a staged package's tool starts a pi child on the subscription, which answers, and the job completes with its call notional", { skip, timeout: 180_000 }, async () => {
	const job = await runner.subscriptionRunnerJob({ root: tempDir("pi-subscription-child-job-"), tool: "spawn_child", extension: spawningTool(), notional: true, ownProcesses: true });
	assert.equal(job.code, 0, `${JSON.stringify(job.exit)}\n${job.stderr.slice(-1500)}`);
	assert.deepEqual(job.requests.map((request) => request.who), ["root", "child", "root"], "the parent asked, the separate child answered, the parent went on");
	assert.ok(job.requests.every((request) => request.token), "every call carried the subscription's token");
	const tokens = job.exit.tokens;
	assert.deepEqual([tokens.calls, tokens.childProcesses, tokens.unmeteredChildren, tokens.modelRefused], [3, 1, 0, 0], "metered as a child process, nothing refused");
	assert.ok(tokens.childTotal > 0);
	assert.equal(tokens.costNotional, tokens.cost, "the child's call is notional, as the parent's own are");
});

test("the real runner judges the subscription allowance on its children's notional calls too, and stops the job", { skip, timeout: 180_000 }, async () => {
	// 44 micro-dollars of the runner's own, then 44 of the child's: 88 of 60. The tool holds its answer for a fold, so the
	// child watch sees the child's spend while the job runs, and the job stops there.
	const job = await runner.subscriptionRunnerJob({ root: tempDir("pi-subscription-child-allowance-"), tool: "spawn_child", extension: spawningTool({ waitMs: 2500 }), notional: true, allowanceMicros: 60, ownProcesses: true });
	assert.equal(job.exit?.reason, "subscription-allowance", JSON.stringify(job.exit));
	assert.deepEqual(job.requests.map((request) => request.who).slice(0, 2), ["root", "child"], "the parent's first call and the child's call went out");
	assert.ok(job.exit.tokens.costNotional > 0);
});

test("the real runner on a subscription with no child: its own last call past the allowance ends the job as before, not stopped by it", { skip, timeout: 180_000 }, async () => {
	// One call of 44 micro-dollars against an allowance of 1, and no tool to call: the guard judges the next call, and none follows.
	const job = await runner.subscriptionRunnerJob({ root: tempDir("pi-subscription-no-child-"), tool: "no_such_tool", notional: true, allowanceMicros: 1, ownProcesses: true });
	assert.deepEqual([job.code, job.exit?.reason], [0, "stop"], JSON.stringify(job.exit));
	assert.ok(job.exit.tokens.costNotional > 0.000001, "the premise: it did end above its allowance");
	assert.equal(job.exit.tokens.childProcesses, 0);
});

test("the real runner under a 1 micro-dollar cost cap: the child's subscription call passes its own cost guard as notional, stays out of its spend, and costs the cap nothing (#1098)", { skip, timeout: 180_000 }, async () => {
	// A billed call of 44 micro-dollars, the child's or the runner's, would be refused by its own guard or stop the job here.
	const job = await runner.subscriptionRunnerJob({ root: tempDir("pi-subscription-child-capped-"), tool: "spawn_child", extension: spawningTool(), notional: true, maxCostMicros: 1, ownProcesses: true });
	assert.equal(job.code, 0, `${JSON.stringify(job.exit)}\n${job.stderr.slice(-1500)}`);
	assert.deepEqual(job.requests.map((request) => request.who), ["root", "child", "root"]);
	const tokens = job.exit.tokens;
	assert.deepEqual([tokens.childProcesses, tokens.costRefused, tokens.costChargedMicros], [1, 0, 0], "nothing charged, the child's own spend included");
	assert.equal(tokens.costNotional, tokens.cost, "every call notional, the child's included");
});
