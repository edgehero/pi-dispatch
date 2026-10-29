import { createHash } from "node:crypto";
import { isProjectId } from "./project-id.mjs";

export const WATCH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const WATCH_SEVERITIES = ["debug", "info", "warning", "error", "critical"];
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function fail(message) { const error = new Error(`watch: ${message}`); error.piDispatchConfig = true; throw error; }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`); }
function keys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} has an unknown field`); }
function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} is out of bounds`); return value; }
function id(value, name) { if (typeof value !== "string" || !WATCH_ID_RE.test(value)) fail(`${name} must be a bounded identifier`); return value; }
function field(value) { if (typeof value !== "string" || !FIELD_RE.test(value) || value.split(".").some(x => forbidden.has(x))) fail("invalid structured field name"); return value; }
export function watchDurationMs(value) {
	if (typeof value !== "string" || !/^[1-9][0-9]{0,4}[smhd]$/.test(value)) fail("duration must be a bounded s, m, h or d value");
	const ms = Number(value.slice(0, -1)) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[value.at(-1)];
	if (ms > 30 * 86400000) fail("duration exceeds 30 days");
	return ms;
}
export function normalizeWatchSources(value = {}) {
	object(value, "watchSources");
	if (Object.keys(value).length > 64) fail("too many sources");
	const sources = {};
	for (const [name, source] of Object.entries(value)) {
		id(name, "source"); object(source, "source"); keys(source, ["verify", "secretEnv", "maxBodyBytes", "project", "maxPerDay", "pull"], "source");
		if (source.verify !== "hmac-sha256") fail("source requires hmac-sha256");
		if (typeof source.secretEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(source.secretEnv)) fail("invalid source secretEnv");
		if (source.project !== undefined && !isProjectId(source.project)) fail("invalid source project id");
		sources[name] = { verify: source.verify, secretEnv: source.secretEnv, maxBodyBytes: integer(source.maxBodyBytes ?? 65536, 1, 65536, "maxBodyBytes"), maxPerDay: integer(source.maxPerDay ?? 1000, 1, 100000, "source maxPerDay"), ...(source.project !== undefined ? { project: source.project } : {}), ...(source.pull !== undefined ? { pull: normalizeWatchPullConfig(source.pull) } : {}) };
	}
	return sources;
}
export function normalizeWatchOn(on, sources) {
	object(on, "on"); keys(on, ["type", "id", "source", "match", "fingerprint", "minCount", "window", "cooldown", "maxPerDay", "maxFingerprints"], "on");
	if (on.type !== "watch") fail("on.type must be watch");
	id(on.id, "trigger id"); id(on.source, "source");
	if (sources && !Object.hasOwn(sources, on.source)) fail("source is not declared");
	if (!Array.isArray(on.fingerprint) || !on.fingerprint.length || on.fingerprint.length > 8 || new Set(on.fingerprint).size !== on.fingerprint.length) fail("fingerprint requires 1 to 8 unique fields");
	on.fingerprint.forEach(field);
	const match = on.match ?? {};
	object(match, "match"); keys(match, ["severity", "labels"], "match");
	if (match.severity !== undefined && (!Array.isArray(match.severity) || !match.severity.length || match.severity.length > 5 || match.severity.some(x => !WATCH_SEVERITIES.includes(x)))) fail("invalid match severity");
	const labels = match.labels ?? {}; object(labels, "match labels");
	if (Object.keys(labels).length > 16) fail("too many match labels");
	for (const [key, values] of Object.entries(labels)) { field(key); if (!Array.isArray(values) || !values.length || values.length > 16 || values.some(x => typeof x !== "string" || Buffer.byteLength(x) > 256)) fail("invalid match label values"); }
	if (watchDurationMs(on.window) > 86400000) fail("digest window exceeds one day"); if (watchDurationMs(on.window) + watchDurationMs(on.cooldown) > 7 * 86400000) fail("digest window plus cooldown exceeds seven-day finding retention");
	return { type: "watch", id: on.id, source: on.source, match: structuredClone(match), fingerprint: [...on.fingerprint], minCount: integer(on.minCount ?? 1, 1, 1000000, "minCount"), window: on.window, cooldown: on.cooldown, maxPerDay: integer(on.maxPerDay, 1, 10000, "maxPerDay"), maxFingerprints: integer(on.maxFingerprints ?? 256, 1, 4096, "maxFingerprints") };
}
export function parseWatchFinding(value) {
	object(value, "finding"); keys(value, ["source", "fields", "labels", "severity", "count", "firstSeen", "lastSeen", "samples"], "finding");
	if (value.source !== undefined) id(value.source, "source");
	if (!WATCH_SEVERITIES.includes(value.severity)) fail("invalid severity");
	const fields = value.fields ?? value.labels ?? {}; object(fields, "fields");
	if (Object.keys(fields).length > 32) fail("too many structured fields");
	for (const [key, val] of Object.entries(fields)) { field(key); if (typeof val !== "string" || Buffer.byteLength(val) > 256 || /[\u0000-\u001f]/.test(val)) fail("invalid structured field value"); }
	for (const key of ["firstSeen", "lastSeen"]) if (typeof value[key] !== "string" || value[key].length > 32 || !Number.isFinite(Date.parse(value[key]))) fail("invalid finding time");
	if (Date.parse(value.firstSeen) > Date.parse(value.lastSeen)) fail("finding times are reversed");
	const samples = value.samples ?? [];
	if (!Array.isArray(samples) || samples.length > 8 || samples.some(x => typeof x !== "string" || Buffer.byteLength(x) > 2048)) fail("samples exceed bounds");
	return { ...(value.source !== undefined ? { source: value.source } : {}), fields: { ...fields }, severity: value.severity, count: integer(value.count ?? 1, 1, 1000000, "count"), firstSeen: new Date(value.firstSeen).toISOString(), lastSeen: new Date(value.lastSeen).toISOString(), samples: [...samples] };
}
// A length-delimited JSON tuple prevents separators inside field values aliasing another identity.
// Cardinality still needs a source/rule cap in the atomic store: structured values are attacker data.
export function watchFingerprint(source, on, finding) {
	id(source, "source"); id(on.id, "trigger id");
	const values = on.fingerprint.map(key => { if (!Object.hasOwn(finding.fields, key)) fail("missing fingerprint field"); return [key, finding.fields[key]]; });
	return createHash("sha256").update(JSON.stringify([source, on.id, values])).digest("hex");
}
export function matchesWatchFinding(on, finding) {
	return (!on.match?.severity || on.match.severity.includes(finding.severity)) && Object.entries(on.match?.labels ?? {}).every(([key, values]) => values.includes(finding.fields[key]));
}

export function normalizeWatchRule(on, sources) {
	const rule = normalizeWatchOn(on, sources);
	return { ...rule, windowMs: watchDurationMs(rule.window), cooldownMs: watchDurationMs(rule.cooldown) };
}

export function normalizeWatchPullConfig(value) {
	object(value, "pull");
	const common = ["kind", "fields", "severity", "contains", "intervalSeconds"];
	const extra = { file: ["path"], journald: ["unit"], loki: ["url", "query", "secretEnv"] }[value.kind];
	if (!extra) fail("pull kind must be file, journald or loki");
	keys(value, [...common, ...extra], "pull");
	object(value.fields, "pull fields");
	if (!Object.keys(value.fields).length || Object.keys(value.fields).length > 32) fail("pull requires 1 to 32 reviewed fields");
	for (const [key, val] of Object.entries(value.fields)) { field(key); if (typeof val !== "string" || Buffer.byteLength(val) > 256 || /[\u0000-\u001f]/.test(val)) fail("invalid pull field value"); }
	if (value.severity !== undefined && !WATCH_SEVERITIES.includes(value.severity)) fail("invalid pull severity");
	if (value.contains !== undefined && (typeof value.contains !== "string" || value.contains.length > 256)) fail("invalid pull match");
	if (value.kind === "file" && (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.length > 4096 || /[\u0000-\u001f]/.test(value.path))) fail("pull file path must be absolute");
	if (value.kind === "journald" && (typeof value.unit !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(value.unit))) fail("invalid pull journal unit");
	if (value.kind === "loki") {
		let url; try { url = new URL(value.url); } catch { fail("invalid pull Loki URL"); }
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || typeof value.query !== "string" || !value.query.length || value.query.length > 4096) fail("invalid pull Loki query endpoint");
		if (value.secretEnv !== undefined && (typeof value.secretEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.secretEnv))) fail("invalid pull Loki secretEnv");
	}
	return { ...structuredClone(value), intervalSeconds: integer(value.intervalSeconds ?? 30, 5, 3600, "pull intervalSeconds") };
}
