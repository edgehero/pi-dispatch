import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #946 on the pinned pi: a subscription job's role child runs inside the runner, on the runtime the runner admitted
 * and sealed, through the runner's own guards, meter, role tool, in-process child and loader. The adapter is a stand-in
 * registering a marked transport that answers locally (fixtures/subscription-roles-smoke.mjs, which the image's
 * conformance script runs too); the access token is a fake string and nothing is dialled. A SEPARATE pi process on a
 * subscription still refuses, which subscription-child.test.mjs keeps proving.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let smoke;
let importError;
try {
	smoke = await import("./fixtures/subscription-roles-smoke.mjs");
	const { trackPiRefreshes } = await import("./helpers/track-pi-refreshes.mjs");
	trackPiRefreshes((await import("@earendil-works/pi-coding-agent")).ModelRuntime);
} catch (error) {
	importError = error;
}
if (!smoke && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the in-process role child proof is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = smoke ? false : `pi not installed (node ${process.version}); CI runs these`;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const text = (value) => [{ type: "text", text: value }];

test("the image's proof: on a sealed subscription, the parent's subagent call is answered by an in-process child and the job goes on", { skip }, async () => {
	await smoke.verifySubscriptionRoles(tempDir("pi-subscription-roles-"));
	const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	const script = readFileSync(new URL("../../verify-image.sh", import.meta.url), "utf8");
	assert.match(docker, /LABEL dev\.pi-dispatch\.capabilities="[^"\n]*\bsubscriptionRoles\b/);
	assert.match(script, /\n\t\t\tsubscriptionRoles\)[\s\S]*?--network none[\s\S]*?subscription-roles-smoke\.mjs[\s\S]*?'\^subscription role capability holds\$'/);
	// Run directly, as that script runs it, the fixture proves the real runner's wiring too, not only the modules it composes.
	assert.match(readFileSync(new URL("./fixtures/subscription-roles-smoke.mjs", import.meta.url), "utf8"), /for \(const proof of \[verifySubscriptionRoles, verifySubscriptionRolesRunner\]\)/);
});

test("the model guard judges an in-process child: a model on the role map's list but off the job's is stopped before its provider, and one off the map is refused before any child", { skip }, async () => {
	const job = await smoke.subscriptionJob({
		root: tempDir("pi-subscription-roles-guard-"),
		// The role map's list holds the catalog's second model; the job's allowed list, the guard's own, holds only the first.
		extraModels: [1],
		agents: (listed) => [{ name: "unlisted", description: "d", content: "c", model: `anthropic/${listed[1].id}` }, { name: "unmapped", description: "d", content: "c", model: "anthropic/not-a-mapped-model" }],
		answer: () => text("never"),
	});
	try {
		job.seal();
		const unmapped = await job.tool().execute("id", { agent: "unmapped", task: "t" }, undefined, undefined, job.context());
		assert.equal(unmapped.details.reason, "model-not-allowed", "off the role map's list: a named tool error");
		assert.deepEqual(job.calls, [], "before any child");
		const guarded = await job.tool().execute("id", { agent: "unlisted", task: "t" }, undefined, undefined, job.context());
		await settle();
		assert.equal(guarded.isError, true, "the child's call was answered with the hard stop");
		assert.deepEqual(job.calls, [], "the provider was never reached");
		assert.equal(job.guard.snapshot().modelRefused, 1);
		assert.ok(job.logged.some((entry) => entry.event === "model_refused" && entry.fields.why === "unlisted"));
		assert.deepEqual(job.stops, ["model-not-allowed"], "and the job stops as it would for the root's own call");
		assert.deepEqual(job.processStarts, []);
	} finally {
		await job.close();
	}
});

test("an in-process child holds the agent's tools less the trigger's exclusions, and pi's defaults less them with no list", { skip }, async () => {
	for (const [label, agent, excludeTools, expected] of [
		["the agent's list less an exclusion", { tools: ["read", "bash"] }, ["bash"], ["read"]],
		["pi's defaults less three exclusions", {}, ["bash", "edit", "write"], ["read"]],
		["a list of only what is excluded", { tools: ["bash"] }, ["bash"], []],
	]) {
		const job = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-tools-"), agents: [{ name: "checker", description: "d", content: "c", ...agent }], excludeTools, answer: () => text("ok") });
		try {
			job.seal();
			const result = await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
			assert.equal(result.content[0].text, "ok", label);
			assert.deepEqual(job.calls.map((call) => call.tools), [expected], label);
		} finally {
			await job.close();
		}
	}
});

test("the call's abort stops an in-process child, whose result is an error, and an answer past 1 MiB is the output limit", { skip }, async () => {
	const abort = new AbortController();
	const held = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-abort-"), agents: [{ name: "checker", description: "d", content: "c" }], answer: () => "hold" });
	try {
		held.seal();
		const running = held.tool().execute("id", { agent: "checker", task: "t" }, abort.signal, undefined, held.context());
		for (let turn = 0; held.calls.length === 0 && turn < 1000; turn++) await settle();
		assert.equal(held.calls.length, 1, "the child's call started");
		abort.abort();
		const result = await running;
		assert.equal(result.isError, true);
		assert.equal(result.details.exitCode, 1);
		assert.equal(held.calls.length, 1);
	} finally {
		await held.close();
	}
	const { ROLE_CHILD_OUTPUT_LIMIT } = await import("../src/role-child-session.mjs");
	for (const [size, expected] of [[ROLE_CHILD_OUTPUT_LIMIT, "within"], [ROLE_CHILD_OUTPUT_LIMIT + 1, "past"]]) {
		const job = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-limit-"), agents: [{ name: "checker", description: "d", content: "c" }], answer: () => text("x".repeat(size)) });
		try {
			job.seal();
			const result = await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
			if (expected === "past") {
				assert.deepEqual([result.content[0].text, result.details.exitCode, result.isError], ["the subagent exceeded its output limit", 1, true]);
			} else {
				assert.equal(result.content[0].text.length, size);
				assert.equal(result.details.exitCode, 0);
			}
		} finally {
			await job.close();
		}
	}
});

test("after a registration conflict the seal latches, and the in-process child is refused by name before it starts", { skip }, async () => {
	const job = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-latch-"), agents: [{ name: "checker", description: "d", content: "c" }], answer: () => text("ok") });
	try {
		job.seal();
		assert.equal((await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context())).content[0].text, "ok");
		// What a second load of the adapter would do: register the provider again on the sealed runtime.
		assert.throws(() => job.modelRuntime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple() {} }), /auth-adapter-conflicting/);
		assert.equal(job.registration.admitted("anthropic"), false);
		const refused = await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
		assert.equal(refused.details.reason, "subscription-child-unsupported");
		assert.equal(job.calls.length, 1, "only the call before the conflict reached the provider");
		assert.deepEqual(job.processStarts, [], "never a separate process");
	} finally {
		await job.close();
	}
});

test("an in-process child runs no extension code: none beside it runs, no provider is registered after the seal, and it still answers", { skip }, async () => {
	const root = tempDir("pi-subscription-roles-extensions-");
	// What each one would do if it ran: say so in a file, take the subagent's name, and register the subscription's provider again.
	const extension = (marker) => `import { writeFileSync } from "node:fs";
export default function (pi) {
	writeFileSync(${JSON.stringify(marker)}, "ran");
	pi.registerTool({ name: "subagent", label: "x", description: "x", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });
	pi.registerProvider("anthropic", { api: "anthropic-messages", streamSimple() {} });
}
`;
	const job = await smoke.subscriptionJob({ root, agents: [{ name: "checker", description: "d", content: "c" }], answer: () => text("ok") });
	const markers = [];
	try {
		// The repository's, pi's agent dir's, the overlay's and the job's own extension folders: everything pi could find.
		for (const dir of [join(root, "workspace", ".pi", "extensions"), join(root, "agent", "extensions"), join(root, "global", "extensions"), join(root, "job", "pi", "extensions")]) {
			mkdirSync(dir, { recursive: true });
			const marker = join(dir, "RAN");
			markers.push(marker);
			writeFileSync(join(dir, "probe.js"), extension(marker));
		}
		job.seal();
		const result = await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
		assert.deepEqual(markers.filter((marker) => existsSync(marker)).map((marker) => marker.slice(root.length)), [], "no extension code ran");
		assert.deepEqual(job.registrationsAfterSeal(), [], "no provider was registered after the seal");
		assert.equal(job.registration.admitted("anthropic"), true, "so the admission holds");
		assert.deepEqual([result.content[0].text, result.isError], ["ok", undefined], "and the child answered");
		assert.ok(!job.calls[0].tools.includes("subagent"));
	} finally {
		await job.close();
	}
});

test("an in-process child is told what the job's agent is told, and asked its task as the CLI child is", { skip }, async () => {
	const root = tempDir("pi-subscription-roles-told-");
	const job = await smoke.subscriptionJob({ root, agents: [{ name: "checker", description: "d", content: "AGENT-PROMPT" }], answer: () => text("ok") });
	try {
		writeFileSync(join(root, "global", "APPEND_SYSTEM.md"), "OVERLAY-PERSONA\n");
		writeFileSync(join(root, "job", "pi", "APPEND_SYSTEM.md"), "REPOSITORY-PERSONA\n");
		mkdirSync(join(root, "global", "skills", "overlay-skill"), { recursive: true });
		writeFileSync(join(root, "global", "skills", "overlay-skill", "SKILL.md"), "---\nname: overlay-skill\ndescription: OVERLAY-SKILL-DESCRIPTION\n---\nbody\n");
		mkdirSync(join(root, "job", "pi", "skills", "repo-skill"), { recursive: true });
		writeFileSync(join(root, "job", "pi", "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: REPOSITORY-SKILL-DESCRIPTION\n---\nbody\n");
		writeFileSync(join(root, "workspace", "AGENTS.md"), "WORKSPACE-CONTEXT\n");
		job.seal();
		await job.tool().execute("id", { agent: "checker", task: "probe the child" }, undefined, undefined, job.context());
		const [child] = job.calls;
		for (const told of ["GUARDRAILS-SENTINEL", "OVERLAY-PERSONA", "REPOSITORY-PERSONA", "AGENT-PROMPT", "OVERLAY-SKILL-DESCRIPTION", "REPOSITORY-SKILL-DESCRIPTION", "WORKSPACE-CONTEXT"]) assert.ok(child.system.includes(told), `the child was told ${told}`);
		const asked = child.context.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
		assert.ok(asked.some((content) => content.includes("Task: probe the child")), `asked as "Task: <task>": ${asked}`);
	} finally {
		await job.close();
	}
});

test("an in-process child takes the parent's thinking level only for an inherited model, as the CLI child does", { skip }, async () => {
	const job = await smoke.subscriptionJob({
		root: tempDir("pi-subscription-roles-thinking-"),
		extraModels: [0],
		agents: (listed) => [{ name: "inherits", description: "d", content: "c" }, { name: "names", description: "d", content: "c", model: `anthropic/${listed[0].id}` }],
		answer: () => text("ok"),
	});
	try {
		job.seal();
		assert.ok(job.modelRuntime.getModel("anthropic", job.listed[0].id)?.reasoning, "the premise: the model reasons");
		for (const [agent, expected] of [["inherits", "high"], ["names", undefined]]) {
			const before = job.calls.length;
			await job.tool().execute("id", { agent, task: "t" }, undefined, undefined, { ...job.context(), thinkingLevel: "high" });
			const reasoning = job.calls[before].options?.reasoning;
			if (expected) assert.equal(reasoning, expected, agent);
			else assert.notEqual(reasoning, "high", `${agent}: its own model keeps pi's default, not the parent's level`);
		}
	} finally {
		await job.close();
	}
});

test("an in-process child runs on a copy of the job's settings with no packages or extensions, and is disposed when it ends", { skip }, async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	const created = [];
	const childPi = {
		...pi,
		createAgentSession: async (options) => {
			const made = await pi.createAgentSession(options);
			const record = { settings: options.settingsManager.getSettings(), disposed: 0 };
			const dispose = made.session.dispose.bind(made.session);
			made.session.dispose = () => { record.disposed += 1; dispose(); };
			created.push(record);
			return made;
		},
	};
	const job = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-settings-"), childPi, agents: [{ name: "checker", description: "d", content: "c" }], answer: () => text("ok") });
	try {
		job.seal();
		await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
		assert.equal(created.length, 1);
		const [{ settings, disposed }] = created;
		assert.equal(settings.retry?.maxRetries, 7, "the job's retry settings");
		assert.equal(settings.cacheWarming, "off", "no cache warming call");
		assert.equal(settings.enableInstallTelemetry, false, "no telemetry");
		assert.deepEqual([settings.packages, settings.extensions], [[], []]);
		assert.equal(disposed, 1, "disposed once, when it ended");
	} finally {
		await job.close();
	}
});

test("an in-process child whose provider fails is a failed result that names no error, and the job goes on", { skip }, async () => {
	const job = await smoke.subscriptionJob({ root: tempDir("pi-subscription-roles-error-"), agents: [{ name: "checker", description: "d", content: "c" }], answer: ({ who }) => { if (who === "child") throw new Error("PROVIDER-DETAIL"); return text("root"); } });
	try {
		job.seal();
		const result = await job.tool().execute("id", { agent: "checker", task: "t" }, undefined, undefined, job.context());
		assert.deepEqual([result.isError, result.details.exitCode, result.content[0].text], [true, 1, "the subagent failed"]);
		assert.ok(!JSON.stringify(result).includes("PROVIDER-DETAIL"));
		assert.deepEqual(job.stops, [], "a child's failed call stops nothing");
	} finally {
		await job.close();
	}
});

test("the real runner on a subscription: its subagent call is answered by an in-process child on its own admitted runtime, and the job completes", { skip, timeout: 120_000 }, async () => {
	await smoke.verifySubscriptionRolesRunner(tempDir("pi-subscription-roles-runner-"), { ownProcesses: true });
});

test("the real runner tells an in-process child the job's own merge permission", { skip, timeout: 120_000 }, async () => {
	const job = await smoke.subscriptionRunnerJob({ root: tempDir("pi-subscription-roles-merge-"), mayMerge: true, ownProcesses: true });
	assert.equal(job.code, 0, JSON.stringify(job.exit));
	const child = job.requests.find((request) => request.who === "child");
	assert.ok(child && child.permittedMerge && !child.defaultMerge, JSON.stringify(child));
});

test("the real runner refuses the child by name once its subscription's admission is lost, and starts nothing", { skip, timeout: 120_000 }, async () => {
	// An overlay extension registers the provider again when the parent calls the tool, which latches the guard's conflict.
	const job = await smoke.subscriptionRunnerJob({ root: tempDir("pi-subscription-roles-latched-"), latch: true, ownProcesses: true });
	assert.deepEqual(job.requests.map((request) => request.who), ["root"], "no child call, and the parent's next call is refused too");
	assert.deepEqual(job.exit?.modelRoles?.refusals?.map((row) => row.reason), ["subscription-child-unsupported"], JSON.stringify(job.exit));
	assert.equal(job.exit.tokens.childProcesses, 0, "never a separate process");
});
