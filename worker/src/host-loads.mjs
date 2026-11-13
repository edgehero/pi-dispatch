/**
 * What a host's jobs can load (issue #800, `INT-DOCTOR-RESULTS-KEY`'s `doctor:loads:<name>`).
 *
 * Each host has its own overlay and its own staged packages, so a fresh sandbox, a project that runs on three machines and
 * a trigger's page all want to know what THAT host would hand a job. Nothing said so: doctor's record keeps a label only
 * for a warn or a fail (`doctor-results.mjs`), so a healthy host's extension names, skills and MCP servers were published
 * nowhere. One STRING per host, written by doctor after its own record, in one `SET ... PX`, for doctor's reasons.
 *
 * THE SAME TEST AS doctor:*: delete every key while the fleet runs and every host behaves exactly as before. Nothing reads
 * this to decide anything. And a reader that finds none says unknown, never that a host has nothing: a host on an older
 * release publishes none, and "the same" is the one thing that must never be read off its silence (`hostsAgree`).
 *
 * THE CONTENT RULE. Read by every console viewer, on another machine, so: names and closed words only, each held to its
 * charset, on the way in AND on the way out, since another host wrote what a reader parses. An overlay extension's first
 * path segment and whether it is a file or a folder; a skill's folder name; a server's name, transport, where it is
 * (`mcpServerWhere`: a url's host and port, or a command's base name, never a header, an argument or a value), exposure,
 * whether it is on, and the variable NAMES it references; a package's name and version; a trigger's position, flow name,
 * the tier it resolved in and a short hex digest of the trigger fields that answer was judged from (`flowBasisOf`). No path,
 * no value and no tool name: what a server or an extension offers is known only once it runs, and the run's own record says
 * that. The digest holds a path (`run.folder`, `run.skillsDir`) only as a hash cut to 8 hex digits, which names nothing a
 * reader can read back. These are the same facts the viewer's Connections page shows; a model's
 * projection (`modelConnections`) carries counts in place of `where` and the key names, and one of these rows gets the
 * same treatment when a tool reads it.
 *
 * The image and pi's version are not here: `host:h:<name>` already publishes them (INT-HOST-REGISTRY-CONTRACT), from the
 * beat, and a second copy here would only be able to disagree with it.
 *
 * APPROXIMATE, and in the safe direction, as doctor's flow lines are (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`). This reads
 * folders on the host and runs nothing: a frontmatter `name:` rename is invisible, and what a run really loaded is its
 * own record's `loaded`. Where a read cannot say, it says so (`unread`), never an empty list that reads as none.
 */
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join, resolve, sep } from "node:path";
import { DOCTOR_HOSTS, DOCTOR_HOSTS_MAX, DOCTOR_RESULTS_TTL_MS } from "./doctor-results.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { ABSENT_CODES, MCP_EXPOSURES, MCP_SERVER_NAME_RE, mcpServerWhere } from "./mcp-config.mjs";
import { parsePackageCanary } from "./package-canary-record.mjs";
import { isPackageName } from "./package-names.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

/** One host's record, beside `doctor:h:<name>` and under the same `doctor:hosts` index. */
export const hostLoadsKey = (name) => `doctor:loads:${name}`;
/** A reader refuses any other, so a later shape reads as unknown, never as something misread. */
export const HOST_LOADS_VERSION = 1;
/** Each list's cap. Past it the rest is counted in `more`, never dropped silently. */
export const HOST_LOADS_CAPS = Object.freeze({ extensions: 32, skills: 64, mcp: 32, keys: 4, packages: 64, flows: 128 });
/** The whole record, serialized. The caps alone allow more, so the fit below drops rows until it holds. */
export const HOST_LOADS_MAX_BYTES = 64 * 1024;
/** The order rows go when the whole record is over its bound: the most numerous and the longest first, a server last. */
const FIT_ORDER = Object.freeze(["flows", "packages", "skills", "extensions", "mcp"]);
/** The parts a read can fail to say, each then reading as unknown. */
export const HOST_LOADS_PARTS = Object.freeze(["extensions", "skills", "mcp", "packages"]);
/** What `more` can count: each list, and the keys a server's row left out. Each has a cap, so the caps name them. */
const HOST_LOADS_MORE = Object.freeze(Object.keys(HOST_LOADS_CAPS));
/** The record's five lists, every one of which a record must hold: a list it does not have is not an empty one. */
const HOST_LOADS_LISTS = Object.freeze(HOST_LOADS_MORE.filter((part) => part !== "keys"));
export const LOADS_EXTENSION_KINDS = Object.freeze(["file", "dir"]);
export const LOADS_TRANSPORTS = Object.freeze(["http", "stdio"]);
/** Where a flow resolved, the run record's words, with `unknown` for a tier this host cannot see. */
export const LOADS_FLOW_TIERS = Object.freeze(["repository", "trigger", "overlay", "package", "none", "unknown"]);
export const LOADS_REPO_STATES = Object.freeze(["present", "absent", "unknown"]);
/** How many of a host's own doctor intervals a record may age before it reads as old (`DOCTOR_STALE_INTERVALS`, pinned). */
export const HOST_LOADS_OLD_INTERVALS = 2;

const HOUR_MS = 3_600_000;
/** How long any one command may take, doctor-results.mjs's bound and for its reason. */
const OP_TIMEOUT_MS = 2_000;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

const EXTENSION_NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;
/** A variable a server references: `mcp-config.mjs`'s `${NAME}`, bounded here. */
const KEY_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A url's host and port, or a command's base name. No separator, so never a path; no space, so never prose. */
const WHERE_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/;
const INDEX_MAX = 1_000_000;

/**
 * The trigger fields `flowTierOf` reads, by the names its first argument gives them (issue #869). A flow row's `basis` is a
 * digest of exactly these, so a test holds this list to that argument's own names: a field `flowTierOf` came to read that
 * this list left out would let an edit to it keep the console answering for the file as it was.
 */
export const FLOW_INPUT_FIELDS = Object.freeze(["flow", "folder", "skillsDir", "packages", "excludeExtensions"]);
/**
 * How long a basis is, in hex digits: 32 bits. A collision costs one stale answer read as current, which is what every edit
 * cost before the basis, and the triggers file has no author but the operator, so nobody gains by aiming for one. Per edit the
 * odds are one in about four billion. REJECTED: a longer digest, which a flow row carries 128 times over in a record that already
 * trims its flow rows at its worst (`FIT_ORDER`), so each digit would put a trigger's answer out of the record on such a host.
 */
export const FLOW_BASIS_HEX = 8;
const FLOW_BASIS_RE = new RegExp(`^[0-9a-f]{${FLOW_BASIS_HEX}}$`);

/**
 * What `flowTierOf` is asked of a trigger as the loader parsed it (`parseTriggers`' entry): doctor's flow lines and its published
 * rows ask it this, and nothing else does. A field that is not there reads as `flowTierOf`'s own default. A disarmed one-shot is
 * the loader's sentinel, whose `run` is empty, so it names no flow and doctor publishes no row for it.
 */
export function flowInputOf(trigger) {
	const run = isObject(trigger?.run) ? trigger.run : {};
	return {
		flow: typeof run.flow === "string" ? run.flow : null,
		folder: typeof run.folder === "string" ? run.folder : null,
		skillsDir: typeof run.skillsDir === "string" ? run.skillsDir : null,
		packages: run.packages !== false,
		excludeExtensions: Array.isArray(run.excludeExtensions) ? run.excludeExtensions.filter((name) => typeof name === "string") : [],
	};
}

/**
 * The basis of a flow row (issue #869): a digest of what `flowTierOf` was asked of this trigger, from the trigger as the loader
 * parsed it. Doctor writes it beside each answer, and the console computes it from its own parse of the file it reads, through
 * this one function, so the two cannot compute it two ways. Where they differ, the answer was judged for the file as it was.
 * `flowTierOf` only asks whether a name is in `excludeExtensions`, so the list's order and a repeat change nothing here either.
 * REJECTED: leaving the list out under `"packages": false`, where `flowTierOf` does not look at it. An edit there would then keep
 * the answer, at the price of a copy of `flowTierOf`'s branches here that would have to move with them, and the cost of not doing
 * it is an answer read as unknown until doctor runs again, the safe direction.
 */
export function flowBasisOf(trigger) {
	const input = flowInputOf(trigger);
	const canonical = FLOW_INPUT_FIELDS.map((field) => (field === "excludeExtensions" ? [...new Set(input[field])].sort() : input[field]));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, FLOW_BASIS_HEX);
}

/** A first path segment: the shape a run's record holds, less the two a folder listing never returns and a path could. */
const extensionOf = (row) => (isObject(row) && typeof row.name === "string" && EXTENSION_NAME_RE.test(row.name) && row.name !== "." && row.name !== ".." && LOADS_EXTENSION_KINDS.includes(row.kind) ? { name: row.name, kind: row.kind } : null);
const skillOf = (name) => (typeof name === "string" && SKILL_NAME_RE.test(name) ? name : null);
const flowOf = (row) => {
	if (!isObject(row) || !Number.isSafeInteger(row.trigger) || row.trigger < 0 || row.trigger > INDEX_MAX) return null;
	if (!LOADS_FLOW_TIERS.includes(row.tier) || !LOADS_REPO_STATES.includes(row.repo)) return null;
	const flow = row.flow === null ? null : skillOf(row.flow);
	if (flow === null && row.flow !== null) return null;
	const pkg = row.package === null ? null : isPackageName(row.package) ? row.package : undefined;
	if (pkg === undefined || (pkg !== null && row.tier !== "package")) return null;
	// Absent is a row from a release before issue #869, which a reader answers from as it did. Any other shape is refused, never
	// read as absent: that would put a row of unknown basis back on the older rule, which answers whatever the file now says.
	if (row.basis !== undefined && (typeof row.basis !== "string" || !FLOW_BASIS_RE.test(row.basis))) return null;
	return { trigger: row.trigger, flow, tier: row.tier, package: pkg, repo: row.repo, ...(row.basis === undefined ? {} : { basis: row.basis }) };
};
/** One server's row, or null, with how many of its keys its cap left out. */
const serverOf = (row) => {
	if (!isObject(row) || typeof row.name !== "string" || !MCP_SERVER_NAME_RE.test(row.name)) return null;
	if (!LOADS_TRANSPORTS.includes(row.transport) || !MCP_EXPOSURES.includes(row.exposure) || typeof row.enabled !== "boolean" || !Array.isArray(row.keys)) return null;
	const where = typeof row.where === "string" && WHERE_RE.test(row.where) ? row.where : null;
	const keys = row.keys.filter((key) => typeof key === "string" && KEY_NAME_RE.test(key));
	return { row: { name: row.name, transport: row.transport, where, exposure: row.exposure, enabled: row.enabled, keys: keys.slice(0, HOST_LOADS_CAPS.keys) }, leftOut: row.keys.length - Math.min(keys.length, HOST_LOADS_CAPS.keys) };
};

/** A list kept through `of` and held to `cap`, with how many it did not keep: what failed its charset, and what is past the cap. */
function within(list, of, cap) {
	const kept = [];
	for (const entry of list) {
		const value = of(entry);
		if (value !== null && kept.length < cap) kept.push(value);
	}
	return { kept, rest: list.length - kept.length };
}

/** The servers, whose rows each carry their own count of keys left out. */
function serversWithin(list, cap) {
	const kept = [];
	let rest = 0;
	let keys = 0;
	for (const entry of list) {
		const server = serverOf(entry);
		if (server !== null && kept.length < cap) {
			kept.push(server.row);
			keys += server.leftOut;
		} else {
			rest += 1;
		}
	}
	return { kept, rest, keys };
}

/** Only the counts that are not zero: a record with nothing left out says `{}`. */
function moreOf(counts) {
	const out = {};
	for (const [part, value] of Object.entries(counts)) if (value > 0) out[part] = value;
	return out;
}

/**
 * The server rows of an overlay's parsed `mcp.json` (`readOverlayMcp`'s `servers`), as Connections reads them: a refused
 * entry is never offered to a job, so it is not what a job can load, and doctor names it. `redact` takes this run's secrets
 * out of `where`: a host is never a secret, except when someone put one there.
 */
export function mcpRowsOf(servers, { redact = (text) => text } = {}) {
	return Object.entries(servers ?? {}).map(([name, server]) => {
		const where = mcpServerWhere(server);
		return { name, transport: server.transport === "http" ? "http" : "stdio", where: redact(where) === where ? where : null, exposure: typeof server.exposure === "string" ? server.exposure : "codemode", enabled: server.enabled !== false, keys: Array.isArray(server.refs) ? [...server.refs].sort() : [] };
	});
}

/**
 * The record one doctor run publishes, from the parts it read. Pure. `at`, `every` and `by` are the doctor record's own,
 * since this is the same run. Bounded twice: each list by its cap, then the whole by `HOST_LOADS_MAX_BYTES`, since the
 * longest name of each kind at every cap is over it. Everything dropped, at either bound, is counted in `more`.
 */
export function buildHostLoads({ at, every = null, by = null, overlayExtensionsAllowed = true, extensions = [], skills = [], mcp = [], packages = [], flows = [], unread = [] }) {
	const parts = {
		extensions: within(extensions, extensionOf, HOST_LOADS_CAPS.extensions),
		skills: within(skills, skillOf, HOST_LOADS_CAPS.skills),
		packages: within(packages, parsePackageCanary, HOST_LOADS_CAPS.packages),
		flows: within(flows, flowOf, HOST_LOADS_CAPS.flows),
	};
	const servers = serversWithin(mcp, HOST_LOADS_CAPS.mcp);
	const more = { extensions: parts.extensions.rest, skills: parts.skills.rest, mcp: servers.rest, keys: servers.keys, packages: parts.packages.rest, flows: parts.flows.rest };
	const record = {
		v: HOST_LOADS_VERSION,
		at,
		every: count(every),
		by: { uid: count(by?.uid), worker: by?.worker === true },
		overlayExtensionsAllowed: overlayExtensionsAllowed === true,
		extensions: parts.extensions.kept,
		skills: parts.skills.kept,
		mcp: servers.kept,
		packages: parts.packages.kept,
		flows: parts.flows.kept,
		...(unread.length > 0 ? { unread: HOST_LOADS_PARTS.filter((part) => unread.includes(part)) } : {}),
		more: moreOf(more),
	};
	// The whole bound, from the tail of the part that can spare it, so the record that goes out always parses.
	const size = () => Buffer.byteLength(JSON.stringify(record), "utf8");
	for (const part of FIT_ORDER) {
		while (size() > HOST_LOADS_MAX_BYTES && record[part].length > 0) {
			record[part].pop();
			more[part] += 1;
			record.more = moreOf(more);
		}
	}
	return record;
}

/**
 * A record read back through an ALLOWLIST, or null where it does not read: text past `HOST_LOADS_MAX_BYTES`, which no builder
 * writes; JSON that does not parse; any `v` but this one, newer included; and a record with no shape. Another host wrote it,
 * so a row that fails its charset is dropped and COUNTED in `more`: a list shorter than what that host said can never read
 * as the same as another's. A list that is not there, or a `more` that cannot be read, is not that: nothing can be counted.
 * REJECTED: reading such a part as empty or off, as this did, which let `{"v":1,"at":1000}` parse as a real host
 * with nothing on it, agreeing with one. Null reads as unknown, and unknown is the rule (`hostsAgree`).
 */
export function parseHostLoads(text) {
	if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > HOST_LOADS_MAX_BYTES) return null;
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(doc) || doc.v !== HOST_LOADS_VERSION || !Number.isSafeInteger(doc.at) || doc.at < 0) return null;
	if (!HOST_LOADS_LISTS.every((part) => Array.isArray(doc[part])) || typeof doc.overlayExtensionsAllowed !== "boolean" || !isObject(doc.by)) return null;
	// `{ worker: "yes" }` read as false, which says an operator ran it, and `{ uid: "root" }` as no uid known. The builder writes
	// both keys always, a uid it does not know as null, so anything else is not this record's shape.
	if ((doc.by.uid !== null && count(doc.by.uid) === null) || typeof doc.by.worker !== "boolean") return null;
	// A word that is not there, or not a count, would read as nothing left out or as a host with no interval, which never ages.
	if (doc.every !== null && count(doc.every) === null) return null;
	// A key with no word here is refused too. Dropping it read `{ widgets: 3 }` as nothing left out, and `hostsAgree`, whose rule is
	// nothing in `more`, then said true of a host that says it left something out.
	if (!isObject(doc.more) || !Object.entries(doc.more).every(([part, value]) => HOST_LOADS_MORE.includes(part) && count(value) !== null)) return null;
	// Absent is none and the builder's own way of saying so. A part this reader has no word for is one it cannot say was read.
	if (doc.unread !== undefined && (!Array.isArray(doc.unread) || !doc.unread.every((part) => HOST_LOADS_PARTS.includes(part)))) return null;
	const parts = {
		extensions: within(doc.extensions, extensionOf, HOST_LOADS_CAPS.extensions),
		skills: within(doc.skills, skillOf, HOST_LOADS_CAPS.skills),
		packages: within(doc.packages, parsePackageCanary, HOST_LOADS_CAPS.packages),
		flows: within(doc.flows, flowOf, HOST_LOADS_CAPS.flows),
	};
	const servers = serversWithin(doc.mcp, HOST_LOADS_CAPS.mcp);
	const said = (part) => doc.more[part] ?? 0;
	const unread = HOST_LOADS_PARTS.filter((part) => doc.unread?.includes(part));
	return {
		at: doc.at,
		every: count(doc.every),
		by: { uid: count(doc.by?.uid), worker: doc.by?.worker === true },
		overlayExtensionsAllowed: doc.overlayExtensionsAllowed,
		extensions: parts.extensions.kept,
		skills: parts.skills.kept,
		mcp: servers.kept,
		packages: parts.packages.kept,
		flows: parts.flows.kept,
		unread,
		more: moreOf({ extensions: said("extensions") + parts.extensions.rest, skills: said("skills") + parts.skills.rest, mcp: said("mcp") + servers.rest, keys: said("keys") + servers.keys, packages: said("packages") + parts.packages.rest, flows: said("flows") + parts.flows.rest }),
	};
}

/** Reject rather than wait forever (`host-registry`'s `bounded`, and for its reason). */
function bounded(promise, ms) {
	return new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error("timeout")), ms);
		Promise.resolve(promise).then(
			(value) => (clearTimeout(timer), done(value)),
			(error) => (clearTimeout(timer), fail(error)),
		);
	});
}

/**
 * Write one host's record: one `SET ... PX`, the value and its expiry in one command, the reason `publishDoctorRecord` gives.
 * No index write: this comes after the doctor record, which has just put this host under `doctor:hosts`. Throws on a fault;
 * the caller is best effort.
 */
export async function publishHostLoads(redis, name, record, { ttlMs = DOCTOR_RESULTS_TTL_MS, timeoutMs = OP_TIMEOUT_MS } = {}) {
	if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) throw new Error("not a worker name");
	await bounded(redis.set(hostLoadsKey(name), JSON.stringify(record), "PX", ttlMs), timeoutMs);
	return record;
}

/**
 * Whether a parsed row is `current` or `old`: older than `HOST_LOADS_OLD_INTERVALS` of its own host's interval. A host whose
 * interval is 0 (its worker runs no doctor) or unknown is never called old, doctor-view.mjs's rule: only an operator's run
 * publishes there, and its age is shown.
 */
export function loadsFreshness(row, { now = Date.now() } = {}) {
	const ageMs = Math.max(0, now - row.at);
	return count(row.every) > 0 && ageMs > HOST_LOADS_OLD_INTERVALS * row.every * HOUR_MS ? "old" : "current";
}

/**
 * Every host's record: the live hosts a caller names first, then the index's other members (`readDoctorResults`'s rule, so
 * expired members can never push a live host out of the read), worker names only, at most `DOCTOR_HOSTS_MAX`, in one MGET.
 * Promises to write nothing: doctor's publish prunes the index it shares.
 *
 * A row is `{ name, state, ageMs, ...record }`, `state` being `current` or `old`, or `{ name, state: "unknown", why }` where
 * nothing can be said, `why` being `absent` (never published, an older host, or expired past its seven days) or `unreadable`
 * (does not parse, or a newer `v`). `{ unreachable }` and `{ hosts: [] }` are different answers, as for the doctor rows.
 */
export async function readHostLoads(redis, { names = [], now = () => Date.now(), timeoutMs = OP_TIMEOUT_MS } = {}) {
	let indexed;
	try {
		indexed = await bounded(redis.smembers(DOCTOR_HOSTS), timeoutMs);
		if (indexed !== null && indexed !== undefined && !Array.isArray(indexed)) throw new Error("smembers did not return a list");
	} catch (error) {
		return { unreachable: error?.message ?? "host loads unreadable" };
	}
	const live = [...new Set(names.filter((name) => typeof name === "string" && WORKER_NAME_RE.test(name)))].sort();
	const rest = [...new Set(indexed ?? [])].filter((name) => typeof name === "string" && WORKER_NAME_RE.test(name) && !live.includes(name)).sort();
	const all = [...live, ...rest];
	const wanted = all.slice(0, DOCTOR_HOSTS_MAX);
	if (wanted.length === 0) return { hosts: [], more: 0 };
	let values;
	try {
		values = await bounded(redis.mget(...wanted.map(hostLoadsKey)), timeoutMs);
		if (!Array.isArray(values)) throw new Error("mget did not return a list");
	} catch (error) {
		return { unreachable: error?.message ?? "host loads unreadable" };
	}
	const hosts = wanted.map((name, index) => {
		const value = values[index];
		if (value === null || value === undefined) return { name, state: "unknown", why: "absent" };
		const record = typeof value === "string" ? parseHostLoads(value) : null;
		if (record === null) return { name, state: "unknown", why: "unreadable" };
		const at = now();
		return { name, state: loadsFreshness(record, { now: at }), ageMs: Math.max(0, at - record.at), ...record };
	});
	hosts.sort((a, b) => a.name.localeCompare(b.name));
	return { hosts, more: all.length - wanted.length };
}

/** What two hosts must share to read as the same, each list in an order the file system did not choose. Package order is pi's load order, so it stays. */
function loadsFingerprint(row) {
	const sorted = (list, key) => [...list].sort((a, b) => key(a).localeCompare(key(b)));
	return JSON.stringify({
		overlayExtensionsAllowed: row.overlayExtensionsAllowed,
		extensions: sorted(row.extensions, (entry) => entry.name),
		skills: sorted(row.skills, (name) => name),
		mcp: sorted(row.mcp, (entry) => entry.name),
		packages: row.packages,
		flows: sorted(row.flows, (entry) => String(entry.trigger).padStart(10, "0")),
	});
}

/**
 * Whether every host's jobs can load the same things: true, false, or null when that cannot be said. NEVER true unless every
 * host named has a current record that lists everything. An unknown or old host, a part a host could not read and a list
 * past its cap are each a reason to say nothing, because each is what "the same" would be guessing at: a host on an older
 * release publishes no record and may run anything. So is a server whose `where` reads null: it failed its charset or held a
 * secret, and two different places read the same that way. Null also for no hosts at all. A difference between two known
 * hosts still reads as null beside an unknown third: this is a question about all of them.
 */
export function hostsAgree(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	if (!rows.every((row) => row?.state === "current" && Array.isArray(row.unread) && row.unread.length === 0 && isObject(row.more) && Object.keys(row.more).length === 0 && HOST_LOADS_LISTS.every((part) => Array.isArray(row[part])) && row.mcp.every((server) => server.where !== null))) return null;
	const [first, ...others] = rows.map(loadsFingerprint);
	return others.every((other) => other === first);
}

/**
 * Where a trigger's flow resolves on this host, in the loader's own precedence order (repository, trigger, overlay, staged
 * packages), first hit wins. The one reading behind doctor's check line and the published row, so the two cannot disagree
 * (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`). Keeps doctor's existential probe: an unknown tier does not stop the walk.
 *
 *   tier     the first tier that holds it; else `none` when every tier was checked, or `unknown` when one could not be.
 *            A forge's repository is not on a host, so a forge trigger found nowhere else is `unknown`, never `none`. A tier
 *            that could not be read is its caller's to say, through `flowProbes`: `fileExists` here has one answer
 *   package  the staged package's name, for `package` alone
 *   repo     what the repository tier answered: `present`, `absent` or `unknown`
 *   resolved, checked, unknown   the words of doctor's own line, which name folders and so are never published
 *
 * `repoFlowAtHead(folder, flow)` answers `present`, `absent` or anything else for not known. `staged` is `readStagedSkills`.
 * The first argument is `flowInputOf`'s, and its names are `FLOW_INPUT_FIELDS`: a new one goes in both, or a flow row's basis
 * would not change when it does (`worker/test/host-loads.test.mjs` reads them off this signature).
 */
export async function flowTierOf({ flow, folder = null, skillsDir = null, packages = true, excludeExtensions = [] }, { repoFlowAtHead, fileExists, overlay = null, staged = { skills: [], unenumerable: [] } }) {
	let tier = null;
	let pkg = null;
	let resolved = null;
	let repo = "unknown";
	const checked = [];
	const unknown = [];
	if (folder) {
		const state = await repoFlowAtHead(folder, flow);
		if (state === "present") {
			repo = "present";
			tier = "repository";
			resolved = `repo .pi/skills at HEAD of ${folder}`;
		} else if (state === "absent") {
			repo = "absent";
			checked.push("repo .pi/skills at HEAD");
		} else {
			unknown.push(`repo (${folder} is not readable as a git repo here)`);
		}
	} else {
		unknown.push("repo (a forge clone, not on this host)");
	}
	if (!resolved && skillsDir) {
		if (fileExists(join(skillsDir, flow, "SKILL.md"))) {
			tier = "trigger";
			resolved = `injected run.skillsDir ${skillsDir}`;
		} else {
			checked.push("injected run.skillsDir");
		}
	}
	if (!resolved && overlay) {
		if (fileExists(join(overlay, "skills", flow, "SKILL.md"))) {
			tier = "overlay";
			resolved = "the overlay skills/";
		} else {
			checked.push("overlay skills/");
		}
	}
	if (!resolved) {
		if (!packages) {
			checked.push("staged packages (withheld: run.packages false)");
		} else {
			// A package this trigger leaves out by name (issue #800) brings it no skill, so such a package is no answer here.
			const hit = staged.skills.find((skill) => skill.name === flow && !excludeExtensions.includes(skill.package));
			// And no such package is a doubt either: what its globs might hold, the job does not load.
			const unenumerable = staged.unenumerable.filter((name) => !excludeExtensions.includes(name));
			if (hit) {
				tier = "package";
				pkg = hit.package;
				resolved = `staged package ${hit.package}`;
			} else if (unenumerable.length > 0) {
				unknown.push(`staged package(s) ${unenumerable.join(", ")} (manifest patterns, not enumerable here)`);
			} else {
				checked.push("staged packages");
			}
		}
	}
	return { tier: tier ?? (unknown.length > 0 ? "unknown" : "none"), package: pkg, repo, resolved, checked, unknown };
}

/**
 * The flow tiers' readers, each answering exactly as before so doctor's own lines do not move, and saying whether any met a
 * failure that is not absence. `readStagedSkills` swallows such a failure ("no readable package.json: pi would skip it too") and
 * `existsSync` answers false on `EACCES`, so a package, a skills folder or a `run.skillsDir` this uid cannot enter read as not
 * holding the flow, and the row as `none`, with `unread` empty. `none` says every tier was checked, and that one was not.
 * REJECTED: answering differently, or throwing, on such a failure: doctor's line says "visible here", which is still true. A
 * `fileExists` seam keeps the answer; the `stat` beside it only notes why it might be false, since `existsSync` cannot say.
 */
export function flowProbes({ fileExists, fs = nodeFs }) {
	let blind = false;
	const noting = (read) => (...args) => {
		try {
			return read(...args);
		} catch (error) {
			if (!ABSENT_CODES.has(error?.code)) blind = true;
			throw error;
		}
	};
	const stat = noting((path) => fs.statSync(path));
	return {
		fileExists: (path) => {
			try {
				stat(path);
			} catch {
				// noted; the answer stays the seam's
			}
			return fileExists(path);
		},
		readFile: noting((path) => fs.readFileSync(path, "utf8")),
		readDir: noting((path, options) => fs.readdirSync(path, options)),
		blind: () => blind,
	};
}

/** The ignore files a job's discovery honours (image/runner/src/loader.mjs `EXTENSION_IGNORE_FILES`, pinned). */
export const LOADS_IGNORE_FILES = Object.freeze([".gitignore", ".ignore", ".fdignore"]);

/**
 * Whether a path is there, by the one answer that says so: only `ABSENT_CODES` mean it is not, and anything else THROWS.
 * REJECTED: `existsSync`, which answers false on EACCES too, so an overlay at mode 000 or an operator's doctor run under
 * another uid read as a host with nothing on it, over the worker's good record, with `unread` empty.
 */
export function pathIsThere(path, fs = nodeFs) {
	try {
		fs.statSync(path);
		return true;
	} catch (error) {
		if (ABSENT_CODES.has(error?.code)) return false;
		throw error;
	}
}

/** A file's text, or null where it is absent. Anything else throws, as `pathIsThere` does and for its reason. */
function readIfThere(path, fs) {
	try {
		return fs.readFileSync(path, "utf8");
	} catch (error) {
		if (ABSENT_CODES.has(error?.code)) return null;
		throw error;
	}
}

/** Whether a file holds an ignore pattern at all, the job's own test: an empty one or one of comments changes nothing. */
function holdsPatterns(path, fs) {
	const text = readIfThere(path, fs);
	return text !== null && text.split(/\r?\n/).some((line) => {
		const trimmed = line.trim();
		return trimmed !== "" && (!trimmed.startsWith("#") || trimmed.startsWith("\\#"));
	});
}

/**
 * A directory's own entries by the job's first step (`directoryExtensionEntries`): a manifest's `pi.extensions` that exist, a
 * directory among them being skipped as the job skips it, else `index.ts`, else `index.js`, else null. A manifest that does
 * not parse is the job's "declares nothing"; one that cannot be read throws, since what it declares is then not known.
 */
function ownEntries(dir, fs) {
	const text = readIfThere(join(dir, "package.json"), fs);
	if (text !== null) {
		let declared = [];
		try {
			const listed = JSON.parse(text.replace(/^﻿/, ""))?.pi?.extensions;
			declared = Array.isArray(listed) ? listed.filter((entry) => typeof entry === "string") : [];
		} catch {
			declared = [];
		}
		const found = declared.map((entry) => resolve(dir, entry)).filter((entry) => pathIsThere(entry, fs));
		if (found.length > 0) return found.filter((entry) => !fs.statSync(entry).isDirectory());
	}
	for (const index of ["index.ts", "index.js"]) if (pathIsThere(join(dir, index), fs)) return [join(dir, index)];
	return null;
}

/**
 * The overlay's `extensions/` as `{ name, kind }` rows, by the rule a job discovers them by (image/runner/src/loader.mjs
 * `discoverExtensionEntries`): one level, skipping dot entries and `node_modules`, a `*.ts` or `*.js` file, or a folder with
 * its own entries; a folder that is itself a package is that package. Each row's name is a first path segment, the name a
 * run's record uses. `null`, for "this read cannot say", when an ignore file holds a pattern: the job honours it with pi's
 * own matcher, which the host does not have, and listing what it ignores would name an extension no job loads. Throws on
 * a read that fails for any reason but absence, a folder of one extension included: leaving that one out would be a list
 * that looks whole. No folder is no extensions.
 */
export function readOverlayExtensionRows(overlay, { fs = nodeFs } = {}) {
	if (typeof overlay !== "string" || overlay === "") return [];
	const dir = join(overlay, "extensions");
	if (!pathIsThere(dir, fs)) return [];
	const own = ownEntries(dir, fs);
	if (own !== null) {
		// An entry a manifest points outside the folder is no first segment of it, so it has no name here.
		const base = `${resolve(dir)}${sep}`;
		const segments = [...new Set(own.filter((entry) => resolve(entry).startsWith(base)).map((entry) => resolve(entry).slice(base.length).split(sep)[0]))];
		return segments.map((name) => ({ name, kind: fs.statSync(join(dir, name)).isDirectory() ? "dir" : "file" }));
	}
	if (LOADS_IGNORE_FILES.some((name) => holdsPatterns(join(dir, name), fs))) return null;
	const rows = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			if (!pathIsThere(path, fs)) continue;
			const stats = fs.statSync(path);
			isDir = stats.isDirectory();
			isFile = stats.isFile();
		}
		if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) rows.push({ name: entry.name, kind: "file" });
		else if (isDir && (ownEntries(path, fs) ?? []).length > 0) rows.push({ name: entry.name, kind: "dir" });
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The overlay's `skills/` by folder name, each holding a `SKILL.md`: the layout doctor's flow line reads, so the two agree.
 * pi names a skill `frontmatter.name` or else its folder, so a rename reads under the folder's name here (that line's own
 * residual). No folder is no skills; any other failed read throws, a skill's own folder included.
 */
export function readOverlaySkillNames(overlay, { fs = nodeFs } = {}) {
	if (typeof overlay !== "string" || overlay === "") return [];
	const dir = join(overlay, "skills");
	if (!pathIsThere(dir, fs)) return [];
	const names = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (pathIsThere(join(dir, entry.name, "SKILL.md"), fs)) names.push(entry.name);
	}
	return names.sort((a, b) => a.localeCompare(b));
}
