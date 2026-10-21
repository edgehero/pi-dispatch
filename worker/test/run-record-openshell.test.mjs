import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { BACKEND_NAMES, OPENSHELL_BACKENDS } from "../src/backends.mjs";
import { secretProfileNeeded } from "../src/capabilities.mjs";
import { buildRecord, OPENSHELL_RULE_HOSTS_MAX, recordedOpenshell, recordedSecretsProfile } from "../src/run-history.mjs";
import { DEFAULT_SECRETS_PROFILE, secretsArmed } from "../src/secrets.mjs";

// Issue #712: the record's `openshell` (the sandbox policy's facts) and `secretsProfile` (the profile NAME run.secrets
// resolved through), each a conditional TAIL key (INT-RUN-HISTORY-FILE-CONTRACT).

const AT = { startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:05:00.000Z" };
const job = (data = {}) => ({ id: "j1", attemptsMade: 0, data: { kind: "github", repo: "acme/widget", target: { type: "issue", number: 7 }, ...data } });
const FACTS = { mode: "copy", ruleHosts: ["api.anthropic.com", "github.com", "*.github.com"], providers: 2, placeholders: 4 };

test("openshell: rebuilt, sorted, on the two OpenShell venues only and in the venue's own mode, TAIL position after liveSkipped", () => {
	const r = buildRecord({ job: job({ backend: "openshell" }), result: { outcome: "completed", exitCode: 0, openshell: FACTS, liveSkipped: "no-capability" }, ...AT });
	assert.deepEqual(r.openshell, { mode: "copy", ruleHosts: ["*.github.com", "api.anthropic.com", "github.com"], ruleHostCount: 3, providers: 2, placeholders: 4 });
	assert.deepEqual(Object.keys(r).slice(-2), ["liveSkipped", "openshell"]);
	const bind = buildRecord({ job: job({ backend: "openshell-bind" }), result: { outcome: "completed", openshell: { ...FACTS, mode: "bind" } }, ...AT });
	assert.equal(bind.openshell.mode, "bind");
	// The default venue counts as the venue: a trigger naming none runs on PI_BACKENDS[0].
	assert.equal(buildRecord({ job: job(), result: { openshell: FACTS }, defaultBackend: "openshell", ...AT }).openshell.mode, "copy");
	// The other mode's facts, or any other venue: no key, so every other record is byte-identical.
	assert.equal("openshell" in buildRecord({ job: job({ backend: "openshell-bind" }), result: { openshell: FACTS }, ...AT }), false, "copy facts on the bind venue");
	for (const venue of BACKEND_NAMES.filter((n) => !OPENSHELL_BACKENDS.includes(n))) {
		assert.equal("openshell" in buildRecord({ job: job({ backend: venue }), result: { openshell: FACTS }, ...AT }), false, venue);
	}
	// Every OpenShell venue has a mode the record admits (the module's own table, held to the registry's list).
	for (const venue of OPENSHELL_BACKENDS) assert.ok(["copy", "bind"].some((mode) => recordedOpenshell({ ...FACTS, mode }, venue) !== null), venue);
	assert.equal("openshell" in buildRecord({ job: job({ backend: "openshell" }), result: { outcome: "completed" }, ...AT }), false, "no facts, no key");
});

test("openshell: a host outside the host-name charset is dropped, never repaired; counts bounded; the list capped with its total kept", () => {
	const hostile = ["API.example.com", "a.com:443", "user@a.com", "a.com/path", "a b.com", "\u001b[2J.com", "*.*.com", "-a.com", "ok.example.com", "ok.example.com", 7, null];
	const r = recordedOpenshell({ ...FACTS, ruleHosts: hostile }, "openshell");
	assert.deepEqual(r.ruleHosts, ["ok.example.com"], "lowercase names only, deduplicated");
	assert.equal(r.ruleHostCount, 1);
	for (const bad of [{ ...FACTS, providers: -1 }, { ...FACTS, placeholders: 1.5 }, { ...FACTS, providers: "2" }, { ...FACTS, placeholders: 10_000 }, { ...FACTS, ruleHosts: "a.com" }, { ...FACTS, mode: "Copy" }, [], null, "x"]) {
		assert.equal(recordedOpenshell(bad, "openshell"), null, JSON.stringify(bad));
	}
	const many = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, "0")}.example.com`);
	const capped = recordedOpenshell({ ...FACTS, ruleHosts: many }, "openshell");
	assert.equal(capped.ruleHosts.length, OPENSHELL_RULE_HOSTS_MAX);
	assert.equal(capped.ruleHostCount, 40);
	// Read back (the admin's rebuild of a stored record): the stored total survives the capped list, a smaller or a
	// hostile one does not shrink or inflate past its bound.
	assert.equal(recordedOpenshell(capped, "openshell").ruleHostCount, 40);
	assert.equal(recordedOpenshell({ ...capped, ruleHostCount: 3 }, "openshell").ruleHostCount, OPENSHELL_RULE_HOSTS_MAX);
	assert.equal(recordedOpenshell({ ...capped, ruleHostCount: 1e9 }, "openshell").ruleHostCount, OPENSHELL_RULE_HOSTS_MAX);
	// Rebuilt, never the source's object: an extra key never reaches the record.
	assert.deepEqual(Object.keys(recordedOpenshell({ ...FACTS, secret: "sk-x" }, "openshell")), ["mode", "ruleHosts", "ruleHostCount", "providers", "placeholders"]);
});

test("secretsProfile: the profile name for an armed job (its own or the implicit default), absent otherwise, after openshell", () => {
	const named = buildRecord({ job: job({ secrets: { TOKEN: "op://v/i/f" }, secretsProfile: "prod" }), result: { outcome: "completed" }, ...AT });
	assert.equal(named.secretsProfile, "prod");
	assert.equal(Object.keys(named).at(-1), "secretsProfile");
	assert.equal(buildRecord({ job: job({ secrets: { TOKEN: "op://v/i/f" } }), result: { outcome: "policy", reason: "secret-unresolved" }, ...AT }).secretsProfile, DEFAULT_SECRETS_PROFILE);
	const both = buildRecord({ job: job({ backend: "openshell", secrets: { T: "r" } }), result: { openshell: FACTS }, ...AT });
	assert.deepEqual(Object.keys(both).slice(-2), ["openshell", "secretsProfile"], "the newest key last");
	assert.equal("secretsProfile" in buildRecord({ job: job(), result: { outcome: "completed" }, ...AT }), false, "no secrets, no key");
	assert.equal("secretsProfile" in buildRecord({ job: job({ secrets: {} }), result: {}, ...AT }), false, "an empty map arms nothing");
	assert.equal("secretsProfile" in buildRecord({ job: job({ secrets: { T: "r" }, secretsProfile: "a:b" }), result: {}, ...AT }), false, "a name outside the charset");
	assert.equal(JSON.stringify(named).includes("op://"), false, "never a reference");
	// One rule for "armed" and "which profile": the processor's predicate and the resolver's choice, through the router's
	// receiver-safe copy the record reads (capabilities.mjs `secretProfileNeeded`).
	const cases = [{}, { secrets: {} }, { secrets: { A: "r" } }, { secretsProfile: "p" }, { secrets: { A: "r" }, secretsProfile: "p" }, { secrets: { A: "r" }, secretsProfile: "" }, { secrets: null }];
	for (const data of cases) {
		assert.equal(secretProfileNeeded(data) !== undefined, secretsArmed(data), JSON.stringify(data));
		const wanted = typeof data.secretsProfile === "string" && data.secretsProfile !== "" ? data.secretsProfile : DEFAULT_SECRETS_PROFILE;
		assert.equal(recordedSecretsProfile(data), secretsArmed(data) ? wanted : null, JSON.stringify(data));
	}
});

test("BY SHAPE: the attempt's openshell facts are captured off runContainer and carried at the one settle every record site calls", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	assert.match(src, /openshellRan = r && typeof r === "object" && r\.openshell !== null && typeof r\.openshell === "object" \? r\.openshell : null;/);
	assert.match(src, /const carryLiveSkip = \(target\) => \{[\s\S]{0,400}target\.openshell = openshellRan;/);
	// The adapter sets them once its providers exist, and every path out of collectRun carries them.
	const adapter = readFileSync(new URL("../src/backend-openshell.mjs", import.meta.url), "utf8");
	assert.ok(adapter.indexOf("at.facts = {") > adapter.indexOf("for (const b of plan.bundles) await makeProvider(b);"), "after the providers are made");
	assert.match(adapter, /const collectRun = async \(result, \{ opts: built \}\) => withFacts\(await collectOutputs\(result, \{ opts: built \}\), attempts\.get\(built\)\);/);
});
