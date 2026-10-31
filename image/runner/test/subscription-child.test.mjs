import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { tempDir } from "./helpers/temp-dir.mjs";
import { parseChildLedger, CHILD_LEDGER_NAME } from "../src/usage-meter.mjs";
import { prepareCommunityAuthAdapter } from "../src/community-auth-patches.mjs";

const preload = new URL("../src/child-preload.mjs", import.meta.url).href;
const runtimeURL = new URL("./core/model-runtime.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const aiURL = import.meta.resolve("@earendil-works/pi-ai");
const validationURL = new URL("../src/community-auth-adapter.mjs", import.meta.url).href;

function runChild(provider, managed) {
	const root = tempDir("subscription-child-");
	const ledger = tempDir("subscription-child-ledger-");
	const model = getBuiltinModels(provider).find((row) => row.api === (provider === "openai" ? "openai-responses" : "anthropic-messages") && !(row.compat?.allowedFallbackModels?.length));
	assert.ok(model);
	const script = join(root, "child.mjs");
	const clock = Date.now();
	let staged = {};
	if (managed && provider === "anthropic") {
		const packageRoot = join(root, "staged");
		mkdirSync(packageRoot);
		execFileSync("tar", ["-xzf", new URL("../../../worker/test/fixtures/community-auth/gotgenes-pi-anthropic-auth-3.4.3.tar.gz", import.meta.url).pathname, "--strip-components=1", "-C", packageRoot]);
		const approved = prepareCommunityAuthAdapter({ adapter: "@gotgenes/pi-anthropic-auth@3.4.3", root: packageRoot });
		staged = { root: packageRoot, digest: approved.digest };
	}
	const entries = managed ? [{ provider, connectionId: "selected", generation: 1, adapter: provider === "openai" ? "openai-chatgpt" : "@gotgenes/pi-anthropic-auth@3.4.3", expiresAt: clock + 3600_000, deadlineAt: clock + 30 * 60_000, ...staged }] : [];
	writeFileSync(script, `
import { ModelRuntime } from ${JSON.stringify(runtimeURL)};
import { createAssistantMessageEventStream } from ${JSON.stringify(aiURL)};
import { validateSubscriptionRequest, verifySubscriptionAuthEntries } from ${JSON.stringify(validationURL)};
const provider = ${JSON.stringify(provider)};
const clock = Date.now();
const entries = JSON.parse(process.env.PI_SUBSCRIPTION_AUTH ?? "[]");
verifySubscriptionAuthEntries(entries, { now: () => clock });
let wireCalls = 0;
const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false,
 credentials: { async read() { return { type: "api_key", key: provider === "openai" ? "sk-api-fixture" : "sk-ant-api-fixture" }; }, async list() { return []; }, async modify() {}, async delete() {} }
});
runtime.registerProvider(provider, { api: ${JSON.stringify(model.api)}, streamSimple(model) {
 wireCalls++;
 const stream = createAssistantMessageEventStream();
 const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api,
  provider: model.provider, model: model.id, stopReason: "stop", timestamp: clock,
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
 queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
 return stream;
} });
await runtime.refresh({ allowNetwork: false });
const model = runtime.getModel(provider, ${JSON.stringify(model.id)});
if (!validateSubscriptionRequest(model, entries, { now: () => clock })) throw new Error("fixture route is not canonical and current");
const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: clock }] }, { sessionId: "child-fixture" }).result();
const state = globalThis[Symbol.for("pi-dispatch.child-meter")]?.child;
process.stdout.write(JSON.stringify({ wireCalls, stopReason: result.stopReason, stop: state?.meter?.state?.stopReason,
 metered: state?.metered, modelRefused: state?.guard?.snapshot?.().modelRefused ?? 0 }));
`);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", preload, script], { cwd: root, env: { PATH: process.env.PATH, TMPDIR: root, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PI_DISPATCH_CHILD_LEDGER: ledger, PI_ALLOWED_MODELS: `${provider}/${model.id}`, ...(managed ? { PI_SUBSCRIPTION_AUTH: JSON.stringify(entries), [provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN"]: provider === "openai" ? "selected.oauth.access" : "sk-ant-oat01-selected" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("subscription child timed out")); }, 15_000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			try {
				assert.equal(code, 0, stderr);
				const reports = readdirSync(ledger).filter((name) => CHILD_LEDGER_NAME.test(name)).map((name) => parseChildLedger(readFileSync(join(ledger, name), "utf8")));
				assert.equal(reports.length, managed ? 0 : 1, `the lazy child ledger reflects actual dispatch: ${stdout}`);
				if (!managed) assert.ok(reports[0]);
				resolve({ ...JSON.parse(stdout), reports });
			} catch (error) { reject(error); }
		});
	});
}

for (const provider of ["openai", "anthropic"]) {
	test(`actual child preload refuses canonical ${provider} subscription without registered authority`, async () => {
		const result = await runChild(provider, true);
		assert.equal(result.metered, true);
		assert.equal(result.wireCalls, 0);
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.stop, "model-not-allowed");
		assert.equal(result.modelRefused, 1);
	});
	test(`actual child preload preserves ordinary ${provider} API-key inference`, async () => {
		const result = await runChild(provider, false);
		assert.equal(result.metered, true);
		assert.equal(result.wireCalls, 1);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.stop, null);
		assert.equal(result.modelRefused, 0);
	});
}
