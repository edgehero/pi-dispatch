import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWatchSources, normalizeWatchRule, parseWatchFinding, watchFingerprint, matchesWatchFinding } from "../src/watch-contract.mjs";
const sources = () => normalizeWatchSources({ prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } });
const on = () => ({ type: "watch", id: "errors", source: "prod", fingerprint: ["service", "error.type"], window: "10m", cooldown: "6h", maxPerDay: 4 });
const finding = () => ({ fields: { service: "checkout", "error.type": "Timeout" }, severity: "error", count: 5, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:01:00Z", samples: ["untrusted text"] });
test("watch sources and rules normalize bounded defaults and duration units", () => {
	assert.equal(sources().prod.maxBodyBytes, 65536);
	const rule = normalizeWatchRule(on(), sources());
	assert.equal(rule.windowMs, 600000); assert.equal(rule.cooldownMs, 21600000); assert.equal(rule.maxFingerprints, 256);
});
test("watch sources refuse missing secrets, bad mechanisms, sizes and unknown fields", () => {
	for (const patch of [{ secretEnv: "" }, { verify: "none" }, { maxBodyBytes: 65537 }, { payload: "x" }]) assert.throws(() => normalizeWatchSources({ prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET", ...patch } }));
});
test("watch rule requires daily cap, declared source, unique fields and bounded durations", () => {
	for (const patch of [{ maxPerDay: undefined }, { maxPerDay: 0 }, { source: "other" }, { fingerprint: [] }, { fingerprint: ["service", "service"] }, { fingerprint: ["constructor"] }, { window: "31d" }, { cooldown: "0m" }, { maxFingerprints: 4097 }, { mode: "fix" }]) assert.throws(() => normalizeWatchRule({ ...on(), ...patch }, sources()));
});
test("finding validates times and structured field and sample bounds", () => {
	assert.deepEqual(parseWatchFinding(finding()), { ...finding(), firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:01:00.000Z" });
	for (const patch of [{ severity: "fatal" }, { count: 0 }, { count: Infinity }, { firstSeen: "bad" }, { firstSeen: "2027-01-01T00:00:00Z" }, { fields: { service: "x".repeat(257) } }, { fields: { "__proto__.x": "x" } }, { samples: ["x".repeat(2049)] }, { samples: Array(9).fill("x") }, { flow: "hostile" }]) assert.throws(() => parseWatchFinding({ ...finding(), ...patch }));
});
test("fingerprint ignores samples, severity, count and map insertion order; source and rule isolate identity", () => {
	const rule = normalizeWatchRule(on(), sources()); const f = parseWatchFinding(finding());
	const fp = watchFingerprint("prod", rule, f);
	assert.match(fp, /^[a-f0-9]{64}$/);
	assert.equal(fp, watchFingerprint("prod", rule, { ...f, fields: { "error.type": "Timeout", service: "checkout" }, samples: ["change all tools"], severity: "critical", count: 100 }));
	assert.notEqual(fp, watchFingerprint("other", rule, f)); assert.notEqual(fp, watchFingerprint("prod", { ...rule, id: "other" }, f));
	assert.throws(() => watchFingerprint("prod", rule, { ...f, fields: {} }));
});
test("structured values remain attacker-variable: identity limits must be enforced by the store", () => {
	const rule = normalizeWatchRule(on(), sources()); const f = parseWatchFinding(finding());
	assert.notEqual(watchFingerprint("prod", rule, f), watchFingerprint("prod", rule, { ...f, fields: { ...f.fields, service: "other" } }));
});
test("rule matching reads only structured values and severity", () => {
	const rule = normalizeWatchRule({ ...on(), match: { severity: ["error"], labels: { service: ["checkout"] } } }, sources());
	assert.equal(matchesWatchFinding(rule, parseWatchFinding(finding())), true);
	assert.equal(matchesWatchFinding(rule, { ...finding(), severity: "info" }), false);
	assert.equal(matchesWatchFinding(rule, { ...finding(), fields: { service: "other" } }), false);
});
test("source pull config validates reviewed paths, units, HTTPS endpoints and interval bounds", () => {
	const base = { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" };
	for (const pull of [{ kind: "file", path: "/srv/log", fields: { service: "api" } }, { kind: "journald", unit: "api.service", fields: { service: "api" } }, { kind: "loki", url: "https://loki.example", query: '{service="api"}', fields: { service: "api" } }]) assert.equal(normalizeWatchSources({ prod: { ...base, pull } }).prod.pull.intervalSeconds, 30);
	for (const pull of [{ kind: "file", path: "relative", fields: { service: "api" } }, { kind: "file", path: "/srv/log", fields: {}, intervalSeconds: 1 }, { kind: "journald", unit: "api;bad", fields: { service: "api" } }, { kind: "loki", url: "http://loki.example", query: "x", fields: { service: "api" } }, { kind: "file", path: "/srv/log", fields: { service: "api" }, arbitrary: "x" }]) assert.throws(() => normalizeWatchSources({ prod: { ...base, pull } }));
});

test("watch projects and evidence retention windows follow the shared bounded contracts", () => {
	for (const project of ["UPPER", "a_b", "a".repeat(33)]) assert.throws(() => normalizeWatchSources({ prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET", project } }));
	assert.equal(normalizeWatchSources({ prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET", project: "shop-prod" } }).prod.project, "shop-prod");
	for (const patch of [{ window: "2d" }, { window: "1d", cooldown: "7d" }]) assert.throws(() => normalizeWatchRule({ ...on(), ...patch }, sources()));
	const canonical = parseWatchFinding({ ...finding(), firstSeen: "2026-01-01T01:00:00+01:00" }); assert.equal(canonical.firstSeen, "2026-01-01T00:00:00.000Z");
});
