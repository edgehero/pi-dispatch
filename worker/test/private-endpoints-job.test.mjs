import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { buildContainerEnv } from "../src/env-allowlist.mjs";
import { makeEgressPreflight } from "../src/egress.mjs";
import { isNonSecretEnvKey, secretValuesOf } from "../src/redact-secrets.mjs";
import { PRIVATE_ENDPOINT_ENV_PREFIX, isPrivateEndpointEnvName, privateEndpointEnvNames } from "../src/reserved-env.mjs";
import { isReservedEnvName, parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { RECORD_PRIVATE_ID_RE, RECORD_PRIVATE_MAX, recordedPrivateEndpoints } from "../src/run-history.mjs";
import { MODEL_ENDPOINT_ID_RE } from "../src/model-endpoints.mjs";
import { PRIVATE_ENDPOINTS_MAX } from "../src/triggers.mjs";

// Issue #918: what a job granted private endpoints gets, and what no other source can give it.

const BENCH = { id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 };
const LAB = { id: "lab-2", host: "[fd00::2]", port: 8022, slots: null };
const base = { provider: "anthropic", model: "claude-x", maxTurns: 20, jobId: "abc", githubToken: "ghs_scoped", forgeKind: "github", hostEnv: { ANTHROPIC_API_KEY: "sk-ant-real" } };

test("the variable names: the id upper-cased, - turned into _, one-to-one under the id grammar", () => {
	assert.equal(PRIVATE_ENDPOINT_ENV_PREFIX, "PI_DISPATCH_ENDPOINT_");
	assert.deepEqual(privateEndpointEnvNames("bench-device"), { host: "PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST", port: "PI_DISPATCH_ENDPOINT_BENCH_DEVICE_PORT" });
	assert.deepEqual(privateEndpointEnvNames("1lab"), { host: "PI_DISPATCH_ENDPOINT_1LAB_HOST", port: "PI_DISPATCH_ENDPOINT_1LAB_PORT" });
	assert.equal(isPrivateEndpointEnvName("PI_DISPATCH_ENDPOINT_X_HOST"), true);
	assert.equal(isPrivateEndpointEnvName("PI_DISPATCH_KEYLESS"), false);
});

test("buildContainerEnv writes each granted endpoint's host and port, and no forwarded or secret value can set one", () => {
	const env = buildContainerEnv({ ...base, privateEndpoints: [BENCH, LAB], forwardEnv: ["PI_DISPATCH_ENDPOINT_EVIL_HOST"], hostEnv: { ...base.hostEnv, PI_DISPATCH_ENDPOINT_EVIL_HOST: "1.2.3.4" }, secrets: { PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST: "6.6.6.6" } });
	assert.equal(env.PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST, "10.0.5.20");
	assert.equal(env.PI_DISPATCH_ENDPOINT_BENCH_DEVICE_PORT, "22");
	assert.equal(env.PI_DISPATCH_ENDPOINT_LAB_2_HOST, "[fd00::2]");
	assert.equal(env.PI_DISPATCH_ENDPOINT_LAB_2_PORT, "8022");
	assert.equal(env.PI_DISPATCH_ENDPOINT_EVIL_HOST, undefined, "a forwarded name with the prefix is dropped");
	const none = buildContainerEnv(base);
	assert.deepEqual(Object.keys(none).filter(isPrivateEndpointEnvName), [], "a job granted none gets none");
});

test("the prefix is reserved wherever a single reserved name is: a trigger secret, a bundle endpoint", () => {
	assert.equal(isReservedEnvName("PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST"), true);
	assert.equal(isReservedEnvName("GITHUB_TOKEN"), true, "the set as before");
	assert.equal(isReservedEnvName("MY_TOKEN"), false);
	const secret = { on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "x", secrets: { PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST: "op://v/i/f" } } };
	assert.throws(() => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [secret] }), "/t.json"), /PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST/);
});

test("the variables carry no secret: never redacted from a transcript, never a credential placeholder", () => {
	assert.equal(isNonSecretEnvKey("PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST"), true);
	assert.equal(isNonSecretEnvKey("ANTHROPIC_API_KEY"), false);
	const env = buildContainerEnv({ ...base, privateEndpoints: [BENCH] });
	const secrets = secretValuesOf(env);
	assert.ok(!secrets.includes("10.0.5.20") && !secrets.includes("22"), "the host and port stay readable");
	assert.ok(secrets.includes("sk-ant-real"), "the provider key still counts");
});

/** A spawn that answers `inspect --format={{.State.Status}}` and `inspect --format={{json .Mounts}}` separately. */
function proxySpawn(calls, { status = "running", mounts = [] } = {}) {
	return (cmd, args, opts) => {
		calls.push(args.join(" "));
		const child = new EventEmitter();
		const out = new EventEmitter();
		out.setEncoding = () => {};
		child.stdout = out;
		const text = args[1] === "--format={{.State.Status}}" ? `${status}\n` : args[1] === "--format={{json .Mounts}}" ? `${JSON.stringify(mounts)}\n` : "";
		queueMicrotask(() => {
			if (opts?.stdio?.[1] === "pipe") out.emit("data", text);
			child.emit("close", 0);
		});
		return child;
	};
}

test("the egress preflight asks for the proxy's mounts only for a job with private endpoints, and names the ones missing", async () => {
	const calls = [];
	const bare = makeEgressPreflight({ armed: true, spawnFn: proxySpawn(calls) });
	assert.deepEqual(await bare({ privateEndpoints: undefined }), { ok: true, proxy: "pi-dispatch-egress-proxy" });
	assert.equal(calls.length, 1, "every other job pays for no second inspect");
	const old = makeEgressPreflight({ armed: true, spawnFn: proxySpawn(calls, { mounts: [{ Destination: "/etc/squid/squid.conf" }] }) });
	assert.deepEqual(await old({ privateEndpoints: ["bench-device"] }), { ok: true, proxy: "pi-dispatch-egress-proxy", privateMissing: ["/etc/pi-dispatch/private", "/etc/pi-dispatch/grants"] });
	const current = makeEgressPreflight({ armed: true, spawnFn: proxySpawn(calls, { mounts: [{ Destination: "/etc/pi-dispatch/private" }, { Destination: "/etc/pi-dispatch/grants" }] }) });
	assert.deepEqual(await current({ privateEndpoints: ["bench-device"] }), { ok: true, proxy: "pi-dispatch-egress-proxy" });
	const unread = makeEgressPreflight({ armed: true, spawnFn: proxySpawn(calls, { mounts: "garbage" }) });
	const answer = await unread({ privateEndpoints: ["bench-device"] });
	assert.equal(answer.unavailable, "pi-dispatch-egress-proxy", "an unreadable answer is retried, never read as either");
});

test("the record's privateEndpoints holds ids and a known basis only, sorted, or is left out", () => {
	assert.deepEqual(recordedPrivateEndpoints({ ids: ["lab-2", "bench-device"], basis: "proxy" }), { ids: ["bench-device", "lab-2"], basis: "proxy" });
	assert.deepEqual(recordedPrivateEndpoints({ ids: ["bench-device"], basis: "unenforced" }), { ids: ["bench-device"], basis: "unenforced" });
	for (const bad of [null, {}, { ids: [], basis: "proxy" }, { ids: ["Bad"], basis: "proxy" }, { ids: ["a", "a"], basis: "proxy" }, { ids: ["a"], basis: "firewall" }, { ids: ["10.0.5.20:22"], basis: "proxy" }]) {
		assert.equal(recordedPrivateEndpoints(bad), null, JSON.stringify(bad));
	}
});

test("the record's id grammar and limit are the loaders' own, copied to keep the record module light and pinned here", () => {
	assert.equal(RECORD_PRIVATE_ID_RE.source, MODEL_ENDPOINT_ID_RE.source);
	assert.equal(RECORD_PRIVATE_ID_RE.flags, MODEL_ENDPOINT_ID_RE.flags);
	assert.equal(RECORD_PRIVATE_MAX, PRIVATE_ENDPOINTS_MAX);
});
