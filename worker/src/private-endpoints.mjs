/**
 * Declared PRIVATE ENDPOINTS (issue #918, INT-PRIVATE-ENDPOINTS-FILE-CONTRACT, DES-PRIVATE-ENDPOINT-GRANTS): one host
 * and one TCP port on the operator's network (a test device's SSH, say) that only the jobs of the triggers naming it
 * may reach, through the egress proxy, as a `CONNECT` tunnel to exactly that host and port. One
 * `private-endpoints.json` of `{ "version": 1, "endpoints": [ { id, host, port, slots? } ] }` in the deployment folder.
 *
 * Its own file, NOT rows in `model-endpoints.json`, for two reasons. An older worker refuses an unknown key and a higher
 * version there (`parseModelEndpoints`), so private rows in that file would take model endpoints down on every older
 * host of a mixed fleet. And a device is not a model server: doctor and the console must never call it one.
 *
 * This module is pure and fs-injectable, as model-endpoints.mjs is: `parsePrivateEndpoints` validates the TEXT and
 * refuses, never repairs; `loadPrivateEndpoints` layers the one fs read on top; `endpointsOverlap` is the rule across
 * the two files; `renderPrivateInclude` writes the squid include. The module enforces nothing itself. The include's
 * rules do, together with the grant the worker writes per job, which squid asks the shipped helper
 * (`deploy/egress-endpoint-grant`) about through an external ACL keyed by the proxy's own address on the job's network.
 *
 * Not settable by a model-callable tool or the settings overlay: the proxy's rules derive from it, so a write would
 * widen egress. The operator edits the file by hand.
 *
 * Custom: private endpoints validated inline per model-endpoints.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, lstatSync as fsLstatSync, readFileSync as fsReadFileSync, realpathSync as fsRealpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { configError } from "./config.mjs";
import { envelopeInsideJobPaths } from "./envelope.mjs";
import { GRANT_HELPER_NAME, GRANT_HELPER_TARGET, GRANT_VENUES, GRANTS_DIR_NAME, GRANTS_TARGET, PRIVATE_DIR_NAME, PRIVATE_DIR_TARGET, PRIVATE_INCLUDE_NAME, PRIVATE_INCLUDE_TARGET } from "./egress-proxy-state.mjs";
import { LOCAL_ADDRESSES, MAX_SLOTS, MODEL_ENDPOINT_ID_RE, PROXY_PORT, canonicalHost, valkeyPortOf } from "./model-endpoints.mjs";

/** The schema version this build reads. A file declaring a higher one is refused loudly. */
export const PRIVATE_ENDPOINTS_VERSION = 1;

/** The file `pi-dispatch init` scaffolds, and the one read when PI_PRIVATE_ENDPOINTS_FILE is unset. */
export const PRIVATE_ENDPOINTS_FILE_NAME = "private-endpoints.json";

/** The folders' and mounts' names live beside the proxy's other mounts (egress-proxy-state.mjs says why). */
export { GRANT_HELPER_NAME, GRANT_HELPER_TARGET, GRANT_VENUES, GRANTS_DIR_NAME, GRANTS_TARGET, PRIVATE_DIR_NAME, PRIVATE_DIR_TARGET, PRIVATE_INCLUDE_NAME, PRIVATE_INCLUDE_TARGET };

/**
 * The ports a private endpoint may not use. On 443 and 80 a listed name passes the proxy for EVERY job (a CONNECT
 * to 443, a plain request to 80), and the binding is by the host's spelling: an allowlisted name that resolves to the
 * device would reach it ungranted, and so would the OpenShell venue's per-host 443 rule. On every other port the
 * allowlist admits nothing, so the declared spelling is the only way in.
 */
export const REFUSED_PRIVATE_PORTS = Object.freeze([80, 443]);

/** How many private endpoints one file may declare. Each is one block of proxy rules. */
export const MAX_PRIVATE_ENDPOINTS = 64;

const ENDPOINT_KEYS = new Set(["id", "host", "port", "slots"]);
const FILE_KEYS = new Set(["version", "endpoints"]);

/** The empty file `init` scaffolds. */
export const EMPTY_PRIVATE_ENDPOINTS = `${JSON.stringify({ version: PRIVATE_ENDPOINTS_VERSION, endpoints: [] }, null, 2)}\n`;

/**
 * Parse, validate and normalise the file TEXT. Returns `{ id, host, port, slots }` literals in file order, `slots`
 * null when the file sets none (no bound). Throws `configError` naming the position. `valkeyPort` is the queue's
 * port, refused as an endpoint port.
 */
export function parsePrivateEndpoints(text, path, { valkeyPort = null } = {}) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`private-endpoints file is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`private-endpoints file must be an object with "version" and "endpoints": ${path}`);
	}
	const extra = Object.keys(parsed).filter((k) => !FILE_KEYS.has(k));
	if (extra.length > 0) throw configError(`private-endpoints file has unknown key(s) ${extra.map((k) => JSON.stringify(k)).join(", ")}: ${path}`);
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) throw configError(`private-endpoints file must have "version": 1 (an integer >= 1): ${path}`);
	if (version > PRIVATE_ENDPOINTS_VERSION) {
		throw configError(`private-endpoints file written by a newer pi-dispatch (version ${version}; this build understands ${PRIVATE_ENDPOINTS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.endpoints)) throw configError(`private-endpoints file must have an "endpoints" array: ${path}`);
	if (parsed.endpoints.length > MAX_PRIVATE_ENDPOINTS) throw configError(`private-endpoints file declares ${parsed.endpoints.length} endpoints, more than ${MAX_PRIVATE_ENDPOINTS}: ${path}`);
	const endpoints = parsed.endpoints.map((row, index) => normalizeEndpoint(row, index, path, valkeyPort));
	const ids = new Map();
	const pairs = new Map();
	endpoints.forEach((e, index) => {
		if (ids.has(e.id)) throw configError(`private endpoint at index ${index}: duplicate id ${JSON.stringify(e.id)} (first at index ${ids.get(e.id)}): ${path}`);
		ids.set(e.id, index);
		const pair = `${e.host} ${e.port}`;
		if (pairs.has(pair)) throw configError(`private endpoint at index ${index}: ${e.host} port ${e.port} is already declared as ${JSON.stringify(endpoints[pairs.get(pair)].id)}: ${path}`);
		pairs.set(pair, index);
	});
	return endpoints;
}

function normalizeEndpoint(row, index, path, valkeyPort) {
	const at = `private endpoint at index ${index}`;
	if (row === null || typeof row !== "object" || Array.isArray(row)) throw configError(`${at}: must be an object: ${path}`);
	const extra = Object.keys(row).filter((k) => !ENDPOINT_KEYS.has(k));
	if (extra.length > 0) throw configError(`${at}: unknown key(s) ${extra.map((k) => JSON.stringify(k)).join(", ")} (known: id, host, port, slots): ${path}`);
	if (typeof row.id !== "string" || !MODEL_ENDPOINT_ID_RE.test(row.id)) throw configError(`${at}: id must be 1 to 32 of a-z, 0-9 and -: ${path}`);
	const label = `private endpoint ${JSON.stringify(row.id)}`;
	let host;
	try {
		host = canonicalHost(row.host, { urlNote: false });
	} catch (err) {
		throw configError(`${label}: ${err.message}: ${path}`);
	}
	const port = row.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError(`${label}: port must be an integer from 1 to 65535: ${path}`);
	if (port === PROXY_PORT) throw configError(`${label}: port ${PROXY_PORT} is the egress proxy's own port: ${path}`);
	if (valkeyPort !== null && port === valkeyPort) throw configError(`${label}: port ${port} is the job queue's (VALKEY_URL), which a job must never reach: ${path}`);
	if (REFUSED_PRIVATE_PORTS.includes(port)) {
		throw configError(`${label}: port ${port} cannot be private: the allowlist opens ports 80 and 443 of a listed host to every job, so a listed name that resolves to this device would reach it without the grant: ${path}`);
	}
	const slots = row.slots === undefined ? null : row.slots;
	if (slots !== null && (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS)) throw configError(`${label}: slots must be an integer from 1 to ${MAX_SLOTS}, or left out for no bound: ${path}`);
	return { id: row.id, host, port, slots };
}

/**
 * The file's path and whether it was named. `PI_PRIVATE_ENDPOINTS_FILE` (config.privateEndpointsFile) wins; unset, it
 * is `private-endpoints.json` in the deployment folder (`cwd`).
 */
export function privateEndpointsPath(config, cwd = process.cwd()) {
	const named = config?.privateEndpointsFile;
	if (named === null || named === undefined) return { path: join(cwd, PRIVATE_ENDPOINTS_FILE_NAME), explicit: false };
	return { path: named === "" ? "" : resolve(cwd, named), explicit: true };
}

/**
 * Load and validate the file. A missing DEFAULT file is `[]`; a missing file that PI_PRIVATE_ENDPOINTS_FILE names is a
 * `configError`, since a typo there would silently declare nothing. fs and cwd are injectable for tests.
 */
export function loadPrivateEndpoints(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync, cwd = process.cwd() } = {}) {
	const { path, explicit } = privateEndpointsPath(config, cwd);
	if (explicit && path === "") throw configError("PI_PRIVATE_ENDPOINTS_FILE is set to an empty value: name the file, or remove the line to use private-endpoints.json in the deployment folder");
	if (!existsSync(path)) {
		if (!explicit) return [];
		throw configError(`private-endpoints file does not exist: ${path}`);
	}
	return parsePrivateEndpoints(String(readFileSync(path, "utf8")), path, { valkeyPort: valkeyPortOf(config?.valkeyUrl) });
}

/**
 * The rule across the two files, as sentences (empty when they agree). An id names one thing: endpoint slots are
 * leased under the id, so an id in both files would bound a model server and a device as one. A host and port in both
 * is one server under two rules, one of which every job may use: the device would not be private. Compared on the
 * canonical spelling both parsers produce, which is what the proxy matches (`dstdomain -n`): a model endpoint under
 * another name or address of the same device is not seen here, a residual the docs name.
 */
export function endpointsOverlap(modelEndpoints, privateEndpoints) {
	const problems = [];
	const modelIds = new Map((modelEndpoints ?? []).map((e) => [e.id, e]));
	const modelPairs = new Map((modelEndpoints ?? []).map((e) => [`${e.host} ${e.port}`, e]));
	for (const p of privateEndpoints ?? []) {
		if (modelIds.has(p.id)) problems.push(`id ${JSON.stringify(p.id)} is declared both as a model endpoint and as a private endpoint: give each its own id`);
		const model = modelPairs.get(`${p.host} ${p.port}`);
		if (model) problems.push(`${p.host} port ${p.port} is declared both as model endpoint ${JSON.stringify(model.id)}, which every job may reach, and as private endpoint ${JSON.stringify(p.id)}: a server is one or the other`);
	}
	return problems;
}

/**
 * The folders a job must never be able to write (issue #918): the private endpoints' folder, whose helper squid runs
 * inside the proxy, and each runtime's grant folder, which the proxy reads grants from. The LEAVES the proxy mounts, so a
 * job path at or above any of them (the deployment folder, `egress-grants/`) is found, as well as one that is a leaf.
 */
export const PRIVATE_GUARDED_FOLDERS = Object.freeze([PRIVATE_DIR_NAME, ...GRANT_VENUES.map((venue) => `${GRANTS_DIR_NAME}/${venue}`)]);

/**
 * The first private endpoint folder a job container can reach, as `{ folder, kind, path }` (`kind` and `path` the job
 * path's, as `envelopeInsideJobPaths` names them), `{ folder, link: true }` for one that is a symlink (a job that can
 * write where the link lives could repoint it, and the proxy would mount the target), or null. A job that can write a
 * grant folder can grant itself any private endpoint, and one that can write `egress-private/` can replace the helper
 * squid runs inside the proxy, which reaches every allowlisted host, so the worker refuses to start with either.
 *
 * Judged by the envelope file's containment rule (file identity, never path spelling) against a cron `run.folder`, a
 * `PI_DISPATCH_RUN_ROOTS` root, a `run.skillsDir` and `PI_GLOBAL_PI_DIR`. A RELATIVE run root is set aside here, as
 * doctor and the local job's own preparation set it aside: the envelope refuses one only because an envelope is set,
 * and this check runs on every deployment. A folder that does not exist yet holds nothing to protect. Throws what the
 * containment rule throws for a path it cannot read; the caller says so.
 */
export function privateFoldersInsideJobPaths(cwd, jobPaths, { inside = envelopeInsideJobPaths, realpath = fsRealpathSync.native, lstat = fsLstatSync } = {}) {
	const paths = { ...jobPaths, runRoots: (jobPaths?.runRoots ?? []).filter((root) => typeof root === "string" && isAbsolute(root)) };
	// The grant folders' parent first: lstat follows every part of a path but the last, so a linked egress-grants/ would
	// pass the leaf's own check while whoever can repoint the link chooses where the grants live.
	try {
		if (lstat(join(cwd, GRANTS_DIR_NAME)).isSymbolicLink()) return { folder: GRANTS_DIR_NAME, link: true };
	} catch (err) {
		if (err?.code !== "ENOENT") throw err;
	}
	for (const folder of PRIVATE_GUARDED_FOLDERS) {
		const path = join(cwd, folder);
		let st;
		try {
			st = lstat(path);
		} catch (err) {
			if (err?.code === "ENOENT") continue;
			throw err;
		}
		if (st.isSymbolicLink()) return { folder, link: true };
		const found = inside(realpath(path), paths, { directory: true });
		if (found) return { folder, kind: found.kind, path: found.path };
	}
	return null;
}

/** The sentence for `privateFoldersInsideJobPaths`'s answer: what is exposed, to what, and what to do. */
export function privateFolderInsideJobPathSentence(found) {
	if (found.link) return `${found.folder}/ in the deployment folder is a symlink, which whoever can write where the link lives could point elsewhere, and the egress proxy mounts wherever it points; make it a folder of the deployment folder`;
	return `${found.folder}/ in the deployment folder lies inside a job path (${found.kind} ${JSON.stringify(found.path)}) that a job container can see, so a job could ${found.folder === PRIVATE_DIR_NAME ? "replace the grant helper the egress proxy runs" : "grant itself any private endpoint"}; move the deployment folder, or that job path, so that neither holds the other`;
}

/** The header every rendered include starts with. A comments-only file is one squid starts on (measured). */
export const PRIVATE_INCLUDE_HEADER = [
	"# Generated by pi-dispatch from private-endpoints.json. Do not edit: regenerate it with `pi-dispatch egress render`.",
	"# Each private endpoint is a CONNECT tunnel to exactly one declared host and port, for the jobs the worker granted it",
	"# to, and nothing else (issue #918). The host ACL comes first on every line, so squid only ever resolves a declared name.",
].join("\n");

/**
 * The external ACL's definition, once, before any ACL that names it (squid's parse dies on a use before the type).
 *
 *   - `%>la`: the proxy's own address on the network the request came in on, which is one job's own network.
 *   - `ttl=0 negative_ttl=0 cache=0`: no answer is ever stored (squid 6.13's `maybeCacheable`), so a grant written or
 *     removed holds for the very next request, and an overloaded helper queue cannot fall back to a stored answer.
 *   - `children-startup=0`: no helper runs until the first request needs one, and squid's "helpers crashing too
 *     rapidly" FATAL, which would stop the proxy and every job's tunnel with it, can only fire below the startup
 *     count, so it never can. A broken helper is refused per request instead (measured, DES-PRIVATE-ENDPOINT-GRANTS).
 */
export const GRANT_ACL_TYPE = `external_acl_type pi_grant ttl=0 negative_ttl=0 cache=0 children-startup=0 children-max=8 queue-size=64 %>la ${GRANT_HELPER_TARGET}`;

/**
 * The squid include for these endpoints: deterministic, sorted by id, header first, and the external ACL's type only
 * when there is something to ask it about (a deployment with none never starts a helper). Per endpoint:
 *
 *   1. a deny for the declared name when it resolves to this host's loopback, as model endpoints have;
 *   2. the CONNECT allow, which also needs the grant;
 *   3. a deny of the pair for everything else, with no method, so a plain forward request and an ungranted CONNECT
 *      are refused here, before the allowlist's own allows further down could read them.
 *
 * The host ACL is `dstdomain -n` for a name and an IP literal alike, for model-endpoints.mjs's measured reason.
 */
export function renderPrivateInclude(endpoints) {
	const sorted = [...(endpoints ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const lines = [PRIVATE_INCLUDE_HEADER];
	if (sorted.length > 0) lines.push("", GRANT_ACL_TYPE);
	for (const e of sorted) {
		// Parser output only. Checked again because these lines are proxy rules: a newline in any would be a rule nobody
		// declared, and a refused port here would be a binding the allowlist undoes.
		if (typeof e.id !== "string" || !MODEL_ENDPOINT_ID_RE.test(e.id)) throw new Error(`renderPrivateInclude: bad id ${JSON.stringify(e.id)}`);
		if (typeof e.host !== "string" || !/^[a-z0-9_.:[\]-]+$/.test(e.host)) throw new Error(`renderPrivateInclude: bad host ${JSON.stringify(e.host)}`);
		if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || REFUSED_PRIVATE_PORTS.includes(e.port) || e.port === PROXY_PORT) throw new Error(`renderPrivateInclude: bad port ${JSON.stringify(e.port)}`);
		const n = `ppe_${e.id}`;
		lines.push(
			"",
			`# ${e.id}`,
			`acl ${n}_host dstdomain -n ${e.host}`,
			`acl ${n}_port port ${e.port}`,
			`acl ${n}_local dst ${LOCAL_ADDRESSES}`,
			`acl ${n}_grant external pi_grant ${e.id}`,
			`http_access deny ${n}_host ${n}_port ${n}_local`,
			`http_access allow CONNECT ${n}_host ${n}_port ${n}_grant`,
			`http_access deny ${n}_host ${n}_port`,
		);
	}
	return `${lines.join("\n")}\n`;
}
