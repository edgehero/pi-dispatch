/**
 * Declared model endpoints (issue #503, INT-MODEL-ENDPOINTS-FILE-CONTRACT): the local or LAN model servers
 * (Ollama, vLLM, llama.cpp, LM Studio) a job may reach through the egress proxy. One `model-endpoints.json` of
 * `{ "version": 1, "endpoints": [ { id, host, port, slots, keyless? } ] }` in the deployment folder.
 *
 * This module is pure and fs-injectable, in scoped-limits.mjs' style: `parseModelEndpoints` validates the file TEXT
 * and refuses, never repairs; `loadModelEndpoints` layers the one fs read on top; `endpointsForModel` derives which
 * endpoints a model uses from the overlay `models.json`; `renderEndpointsInclude` writes the squid include the proxy
 * reads. The module enforces nothing itself: the proxy include enforces the route, and the pickup gate in index.mjs
 * enforces `slots` through a lease per endpoint (`DES-FLEET-LEASES-FOR-SHARED-BOUNDS`), and the credential gate
 * passes a custom provider served by keyless endpoints alone (`keylessVerdict`). All of them bind to this one
 * implementation.
 *
 * Which models use an endpoint is DERIVED, never listed twice: a model uses endpoint E when its effective `baseUrl`
 * (the model's own, else its provider's) has E's host and port. A second list of model names here could disagree
 * with models.json, and the disagreement would decide egress.
 *
 * Stricter than scoped-limits.json on unknown keys: they are REFUSED, not dropped. This file decides proxy rules,
 * so a key an old worker drops is a rule the operator believes in and does not have.
 *
 * Not settable by a model-callable tool or by the settings overlay: the proxy rules derive from it, so a write
 * would widen egress. The operator edits the file by hand.
 *
 * Custom: model endpoints validated inline per scoped-limits.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, lstatSync as fsLstatSync, readFileSync as fsReadFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join, resolve } from "node:path";
import { PROXY_LOCAL_ADDRESSES, isProxyLocalHost } from "./backends.mjs";
import { configError } from "./config.mjs";
import { KEYLESS_ENV_NAME } from "./reserved-env.mjs";
import { parseModelsJson } from "./models-json.mjs";

/** The schema version this build reads. A file declaring a higher one is refused loudly. */
export const MODEL_ENDPOINTS_VERSION = 1;

/** The file `pi-dispatch init` scaffolds, and the one the worker reads when PI_MODEL_ENDPOINTS_FILE is unset. */
export const MODEL_ENDPOINTS_FILE_NAME = "model-endpoints.json";

/** The proxy include rendered from it, beside it in the deployment folder. */
export const MODEL_ENDPOINTS_INCLUDE_NAME = "model-endpoints.conf";

/** The egress proxy's own listening port. An endpoint on it would be a tunnel back into the proxy. */
export const PROXY_PORT = 3128;

/** The largest `slots` value: a bound this large is already no bound for one server. */
export const MAX_SLOTS = 64;

/**
 * An endpoint id. EXPORTED for doctor's dead-pid sweep, which matches a probe container's name by this same class:
 * one rule, so the sweep cannot drift from what the parser accepts.
 */
export const MODEL_ENDPOINT_ID_RE = /^[a-z0-9-]{1,32}$/;
const ID_RE = MODEL_ENDPOINT_ID_RE;
const ENDPOINT_KEYS = new Set(["id", "host", "port", "slots", "keyless"]);
const FILE_KEYS = new Set(["version", "endpoints"]);
// A DNS label as the proxy and a URL both read it, lowercased. `_` is allowed because a container or compose name
// may carry one and a URL keeps it.
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** The empty file `init` scaffolds. */
export const EMPTY_MODEL_ENDPOINTS = `${JSON.stringify({ version: MODEL_ENDPOINTS_VERSION, endpoints: [] }, null, 2)}\n`;

/**
 * VALKEY_URL's port, the queue's. An endpoint on it could reach the queue on a host where Valkey listens on the
 * address the endpoint names. `null` when the URL does not parse (config's own checks refuse that elsewhere).
 */
export function valkeyPortOf(valkeyUrl) {
	if (typeof valkeyUrl !== "string" || valkeyUrl === "") return null;
	try {
		const url = new URL(valkeyUrl);
		return url.port === "" ? 6379 : Number(url.port);
	} catch {
		return null;
	}
}

/**
 * A declared host, checked and put in the one spelling squid and a WHATWG URL both use. Returns the canonical host
 * or throws a message (the caller adds the position). Three kinds:
 *
 *   - an IPv4 literal in dotted-decimal form (`net.isIPv4`, which refuses `010.1.1.1` and `127.1`);
 *   - an IPv6 literal, bare or in brackets, stored in BRACKETS and compressed lowercase (`[fd00::2]`). Measured on
 *     squid 6.13, 2026-09-30: squid canonicalises a CONNECT's IPv6 host to that bracketed form before `dstdomain`
 *     compares it, so `dstdomain -n [fd00::2]` matches `[fd00:0:0::2]` and `[FD00::2]`, and a bare `fd00::2`
 *     matches nothing;
 *   - a DNS name, lowercased. A trailing dot is REFUSED rather than stripped: refuse, never repair, and a URL keeps
 *     the dot, so a stripped declaration would not match the baseUrl it was written for.
 */
function canonicalHost(raw) {
	if (typeof raw !== "string" || raw === "") throw new Error("host must be a non-empty string");
	if (raw !== raw.trim()) throw new Error("host must not carry spaces");
	const lower = raw.toLowerCase();
	// `name:port` or `[v6]:port`, the shape a URL writes, caught before the IPv6 test would call it a bad address. The
	// port may be empty (`a.lan:`): that is still a host with a port separator, not an IPv6 address with an IPv4 tail.
	if (/^[^:[\]]+:[0-9]*$/.test(lower) || /^\[[^\]]*\]:[0-9]*$/.test(lower)) {
		throw new Error(`host ${JSON.stringify(raw)} carries a port: put the host alone in "host" and the port in "port"`);
	}
	if (isIPv4(lower)) {
		if (isProxyLocalHost("ipv4", lower)) {
			const why =
				lower === "0.0.0.0"
					? "the unspecified address, which is loopback on Linux"
					: lower.startsWith("127.")
						? "a loopback address, which inside the proxy is the proxy itself: declare the host's own address or host.docker.internal"
						: "slirp4netns's host alias, which the proxy denies as host-local: declare host.containers.internal";
			throw new Error(`host ${JSON.stringify(raw)} is ${why}`);
		}
		return lower;
	}
	if (lower.includes(":") || lower.startsWith("[")) return canonicalIPv6(raw, lower);
	return canonicalName(raw, lower);
}

function canonicalIPv6(raw, lower) {
	const inner = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
	if (inner.includes("%")) throw new Error(`host ${JSON.stringify(raw)} carries a zone id, which a URL cannot hold`);
	if (inner.includes(".")) throw new Error(`host ${JSON.stringify(raw)} is an IPv6 address with an IPv4 tail: declare the IPv4 address itself`);
	let host;
	try {
		host = new URL(`http://[${inner}]/`).hostname;
	} catch {
		throw new Error(`host ${JSON.stringify(raw)} is not a DNS name, an IPv4 address or an IPv6 address`);
	}
	// The first 96 bits zero: `::`, `::1`, and the deprecated IPv4-compatible block, whose text squid and a URL spell
	// differently (inet_ntop writes `::1.2.3.4`, a URL `::102:304`), so a rule for it would never match.
	if (isProxyLocalHost("ipv6", host.slice(1, -1)) || /^\[::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)?\]$/.test(host)) {
		throw new Error(`host ${JSON.stringify(raw)} is a loopback, unspecified or IPv4-compatible IPv6 address`);
	}
	// IPv4-mapped (::ffff:0:0/96): the same spelling split, and it is an IPv4 address anyway.
	if (/^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(host)) {
		throw new Error(`host ${JSON.stringify(raw)} is an IPv4-mapped IPv6 address: declare the IPv4 address itself`);
	}
	return host;
}

function canonicalName(raw, lower) {
	if (lower.endsWith(".")) throw new Error(`host ${JSON.stringify(raw)} ends in a dot: write it without the dot, as the baseUrl in models.json does`);
	if (lower.length > 253) throw new Error(`host ${JSON.stringify(raw)} is longer than 253 characters`);
	const labels = lower.split(".");
	for (const label of labels) {
		if (!LABEL_RE.test(label)) throw new Error(`host ${JSON.stringify(raw)} is not a DNS name, an IPv4 address or an IPv6 address`);
	}
	// A URL reads a host whose last label is a number (`127.1`, `10.0x10`) as an IPv4 address, so such a "name"
	// would reach an address nobody declared.
	const last = labels[labels.length - 1];
	if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) {
		throw new Error(`host ${JSON.stringify(raw)} is neither a DNS name nor an IPv4 address in dotted-decimal form`);
	}
	if (isProxyLocalHost("name", lower)) {
		throw new Error(`host ${JSON.stringify(raw)} is loopback, which inside the proxy is the proxy itself: declare the host's own address or host.docker.internal`);
	}
	return lower;
}

/**
 * Parse, validate and normalise the endpoints file TEXT. Returns the endpoints as explicit
 * `{ id, host, port, slots, keyless }` literals in file order. Throws `configError` on anything malformed, naming
 * the position. `path` is for messages only; `valkeyPort` is the queue's port, refused as an endpoint port.
 */
export function parseModelEndpoints(text, path, { valkeyPort = null } = {}) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`model-endpoints file is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`model-endpoints file must be an object with "version" and "endpoints": ${path}`);
	}
	const extra = Object.keys(parsed).filter((k) => !FILE_KEYS.has(k));
	if (extra.length > 0) throw configError(`model-endpoints file has unknown key(s) ${extra.map((k) => JSON.stringify(k)).join(", ")}: ${path}`);
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) {
		throw configError(`model-endpoints file must have "version": 1 (an integer >= 1): ${path}`);
	}
	if (version > MODEL_ENDPOINTS_VERSION) {
		throw configError(`model-endpoints file written by a newer pi-dispatch (version ${version}; this build understands ${MODEL_ENDPOINTS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.endpoints)) throw configError(`model-endpoints file must have an "endpoints" array: ${path}`);
	const endpoints = parsed.endpoints.map((row, index) => normalizeEndpoint(row, index, path, valkeyPort));
	const ids = new Map();
	const pairs = new Map();
	endpoints.forEach((e, index) => {
		if (ids.has(e.id)) throw configError(`model endpoint at index ${index}: duplicate id ${JSON.stringify(e.id)} (first at index ${ids.get(e.id)}): ${path}`);
		ids.set(e.id, index);
		// Two ids for one server would split its slots in two, so each id would admit its own share and the server
		// would get both.
		const pair = `${e.host} ${e.port}`;
		if (pairs.has(pair)) throw configError(`model endpoint at index ${index}: ${e.host} port ${e.port} is already declared as ${JSON.stringify(endpoints[pairs.get(pair)].id)}: ${path}`);
		pairs.set(pair, index);
	});
	return endpoints;
}

function normalizeEndpoint(row, index, path, valkeyPort) {
	const at = `model endpoint at index ${index}`;
	if (row === null || typeof row !== "object" || Array.isArray(row)) throw configError(`${at}: must be an object: ${path}`);
	const extra = Object.keys(row).filter((k) => !ENDPOINT_KEYS.has(k));
	if (extra.length > 0) throw configError(`${at}: unknown key(s) ${extra.map((k) => JSON.stringify(k)).join(", ")} (known: id, host, port, slots, keyless): ${path}`);
	if (typeof row.id !== "string" || !ID_RE.test(row.id)) throw configError(`${at}: id must be 1 to 32 of a-z, 0-9 and -: ${path}`);
	const label = `model endpoint ${JSON.stringify(row.id)}`;
	let host;
	try {
		host = canonicalHost(row.host);
	} catch (err) {
		throw configError(`${label}: ${err.message}: ${path}`);
	}
	const port = row.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError(`${label}: port must be an integer from 1 to 65535: ${path}`);
	if (port === PROXY_PORT) throw configError(`${label}: port ${PROXY_PORT} is the egress proxy's own port: ${path}`);
	if (valkeyPort !== null && port === valkeyPort) throw configError(`${label}: port ${port} is the job queue's (VALKEY_URL), which a job must never reach: ${path}`);
	const slots = row.slots;
	if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw configError(`${label}: slots must be an integer from 1 to ${MAX_SLOTS}: ${path}`);
	const keyless = row.keyless === undefined ? false : row.keyless;
	if (typeof keyless !== "boolean") throw configError(`${label}: keyless must be true or false: ${path}`);
	return { id: row.id, host, port, slots, keyless };
}

/**
 * The endpoints file's path and whether it was named. `PI_MODEL_ENDPOINTS_FILE` (config.modelEndpointsFile) wins;
 * unset, it is `model-endpoints.json` in the deployment folder (`cwd`), the folder `init` scaffolds it in.
 */
export function modelEndpointsPath(config, cwd = process.cwd()) {
	const named = config?.modelEndpointsFile;
	if (named === null || named === undefined) return { path: join(cwd, MODEL_ENDPOINTS_FILE_NAME), explicit: false };
	return { path: named === "" ? "" : resolve(cwd, named), explicit: true };
}

/**
 * Load and validate the endpoints file. A missing DEFAULT file is `[]` (no endpoints, a valid deployment); a
 * missing file that PI_MODEL_ENDPOINTS_FILE names is a `configError`, since a typo there would silently declare
 * nothing. An empty value is named, and refused the same way. fs and cwd are injectable for tests.
 */
export function loadModelEndpoints(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync, cwd = process.cwd() } = {}) {
	const { path, explicit } = modelEndpointsPath(config, cwd);
	if (explicit && path === "") throw configError("PI_MODEL_ENDPOINTS_FILE is set to an empty value: name the file, or remove the line to use model-endpoints.json in the deployment folder");
	if (!existsSync(path)) {
		if (!explicit) return [];
		throw configError(`model-endpoints file does not exist: ${path}`);
	}
	return parseModelEndpoints(String(readFileSync(path, "utf8")), path, { valkeyPort: valkeyPortOf(config?.valkeyUrl) });
}

/**
 * The errnos a read of the overlay `models.json` reads as NO FILE, the way the job sees it (PR #553's review). The
 * runner picks the overlay with `existsSync("/opt/pi-global/models.json")` (image/runner/run-job.mjs) and pi reads
 * no overlay at all when that answers false, with no error. With `models.json` itself never a link (below), ELOOP,
 * ENOTDIR and ENAMETOOLONG can come only from the folder's own path, and there is no file content to lose.
 */
const OVERLAY_ABSENT_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENAMETOOLONG"]);

/** The fixed text of the refusal for a `models.json` that is a link: what to do, and why. */
export const OVERLAY_LINK_FIX = "models.json in the overlay folder is a link; replace it with the file itself (the job's read-only mount cannot follow links reliably)";

/** The determinate fault of a `models.json` that is a link of any kind; `overlayLink` marks it. */
function overlayLinkError(path) {
	const error = configError(`${OVERLAY_LINK_FIX}: ${path}`);
	error.overlayLink = true;
	return error;
}

/** The fixed text of the refusal for a `models.json` that is a FIFO, socket or device: what to do, and why. */
export const OVERLAY_NOT_A_FILE_FIX = "models.json in the overlay folder is not a regular file (a named pipe, socket or device); replace it with the file itself (reading one can block, and pi in the job cannot load it)";

/** The determinate fault of a `models.json` that is neither a regular file nor a folder; `overlayNotAFile` marks it. */
function overlayNotAFileError(path) {
	const error = configError(`${OVERLAY_NOT_A_FILE_FIX}: ${path}`);
	error.overlayNotAFile = true;
	return error;
}

/**
 * The overlay's `models.json` (`<globalPiDir>/models.json`), parsed as JSON and nothing else: no `$VAR` expansion,
 * because the host's environment is not the job's, and a derivation that expanded one would describe a server the
 * job never dials. ONE rule for every caller (the pickup snapshot in index.mjs, doctor), judged as the JOB sees the
 * file (PR #553's review), in five outcomes:
 *   - `null` when the job has no overlay: `models.json` is missing, or the folder's path fails with ELOOP, ENOTDIR or
 *     ENAMETOOLONG, which the runner's `existsSync` (image/runner/run-job.mjs) answers false for;
 *   - a `configError` marked `overlayLink` when `models.json` is a link of ANY kind, dangling included (`lstat`). The
 *     job's read-only mount resolves a link differently from the host (an absolute target, a target outside the
 *     folder, a trailing `/` or a `..` through a file each differ), and two rounds of following links the way the
 *     mount does kept finding cases, so the rule is the simple one: the file itself, never a link. The overlay FOLDER
 *     may be a link: the runtime follows it when it mounts the folder, and both sides then read the same file;
 *   - a `configError` marked `overlayNotAFile` when `models.json` is a named pipe, a socket or a device (issue #556),
 *     judged from the same `lstat` and never opened: a FIFO with no writer blocks `readFileSync` forever, on every
 *     pickup and in doctor. A folder is not this case: its read fails at once with EISDIR, rethrown below;
 *   - ANY other fs error is RETHROWN as-is, its `code` intact (EACCES, EPERM, EISDIR, EIO...), so a caller can tell
 *     it from a verdict. The caller classifies the code: `isTransientOverlayRead` (model-catalog.mjs) names the few
 *     that may pass, and in the job pi loads none of the file for all the rest (the runner's existence check, or
 *     pi's own read, fails);
 *   - text pi would not load is a `configError`: a determinate fault the operator fixes. "Would not load" is pi's own
 *     rule since issue #502 (`parseModelsJson`): a BOM, `//` comments and trailing commas are fine, and a schema
 *     error anywhere in the document refuses all of it, because pi drops the whole file over one.
 * The read is NOT inside the parse's try, and there is no `existsSync` first. Both were here (PR #520 round 2): the
 * try turned EACCES and EIO into "not valid JSON", and `existsSync` answers false for a file under an unreadable
 * directory, which read as absence. A `lstat` or read that throws is the only honest question.
 */
export function readOverlayModels(globalPiDir, { readFileSync = fsReadFileSync, lstatSync = fsLstatSync } = {}) {
	if (typeof globalPiDir !== "string" || globalPiDir === "") return null;
	const path = join(globalPiDir, "models.json");
	let text;
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink()) throw overlayLinkError(path);
		if (!entry.isFile() && !entry.isDirectory()) throw overlayNotAFileError(path);
		text = String(readFileSync(path, "utf8"));
	} catch (error) {
		if (OVERLAY_ABSENT_CODES.has(error?.code)) return null;
		throw error;
	}
	// Parsed the way pi parses it (issue #502, `models-json.mjs`): a BOM, `//` comments and trailing commas are
	// accepted, and a document pi's schema refuses anywhere is refused whole, because pi then loads none of it.
	const { value, error } = parseModelsJson(text);
	if (error !== undefined) throw configError(`overlay models.json ${error}: ${path}`);
	return value;
}

/**
 * The `host` and `port` a baseUrl dials, as a URL reads it: lowercase hostname (an IPv6 one in brackets), the
 * scheme's default port when none is written. `null` for anything that is not an http(s) URL.
 */
export function baseUrlTarget(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl === "") return null;
	let url;
	try {
		url = new URL(baseUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
	// ONE trailing dot is stripped here, while a declaration with one is refused. squid tunnels `name.` (measured 200 on
	// 2026-09-30) to the same server as `name`, so a baseUrl spelled with the dot reaches the endpoint, and matching
	// nothing would let it skip the endpoint's slot lease and keyless gate. The declaration stays strict: refuse, never
	// repair, in the file the operator writes.
	const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
	return { host, port };
}

function providerOf(models, provider) {
	const providers = models?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return null;
	if (!Object.hasOwn(providers, provider)) return null;
	const entry = providers[provider];
	return entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

function modelsOf(entry) {
	return Array.isArray(entry?.models) ? entry.models.filter((m) => m !== null && typeof m === "object" && typeof m.id === "string") : [];
}

function matching(baseUrl, endpoints) {
	const target = baseUrlTarget(baseUrl);
	if (target === null || !Array.isArray(endpoints)) return [];
	return endpoints.filter((e) => e.host === target.host && e.port === target.port);
}

/**
 * The declared endpoints a model uses: those whose host AND port its effective baseUrl dials. The effective baseUrl
 * is the model's own `baseUrl`, else its provider's. A model the overlay does not list takes the provider's. `[]`
 * when nothing matches, including when there is no overlay or no such provider. One endpoint at most, since a host
 * and port pair is declared once.
 */
export function endpointsForModel({ models, provider, modelId, endpoints }) {
	const entry = providerOf(models, provider);
	if (entry === null) return [];
	const model = modelsOf(entry).find((m) => m.id === modelId);
	const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl : entry.baseUrl;
	return matching(baseUrl, endpoints);
}

/**
 * Every model a provider lists in the overlay, each with the endpoints it uses, in the overlay's order. For a
 * question about the whole provider ("is every one of its models on a keyless endpoint"); `[]` when the provider
 * lists no models.
 */
export function endpointsForProvider({ models, provider, endpoints }) {
	const entry = providerOf(models, provider);
	if (entry === null) return [];
	return modelsOf(entry).map((m) => ({ modelId: m.id, endpoints: matching(typeof m.baseUrl === "string" ? m.baseUrl : entry.baseUrl, endpoints) }));
}

/**
 * The cost table pi would bill one model by, as the overlay composes it (issue #503 part 7), or `null` when that
 * cannot be told. pi 0.99.1's provider composer (`pi-coding-agent/dist/core/provider-composer.js`) builds it in two
 * steps, mirrored here:
 *   1. the BASE: a model the overlay's `providers.<p>.models` defines takes that entry's `cost`, and an entry with no
 *      `cost` gets all zeros (`modelFromJson`: "an absent cost table counts as zero"), whatever the builtin catalog
 *      says, because the overlay entry REPLACES the builtin model. Any other model takes the builtin catalog's cost
 *      (`builtinModel(provider, id)`, injected so this module never imports pi). Neither: `null`;
 *   2. the OVERRIDE: `modelOverrides.<id>.cost`, field by field over the base (`applyModelOverride`), and only on a
 *      chat model (pi skips the override on an image or classifier model). The overlay's own models are chat models.
 */
function composedCost({ models, provider, modelId, builtinModel }) {
	const entry = providerOf(models, provider);
	const defined = modelsOf(entry).find((m) => m.id === modelId);
	let base;
	let chat = true;
	if (defined !== undefined) {
		base = defined.cost === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : defined.cost;
	} else {
		const builtin = typeof builtinModel === "function" ? builtinModel(provider, modelId) : null;
		if (builtin === null || builtin === undefined || typeof builtin !== "object") return null;
		base = builtin.cost;
		chat = (builtin.type ?? "chat") === "chat";
	}
	if (base === null || typeof base !== "object" || Array.isArray(base)) return null;
	const overrides = entry?.modelOverrides;
	const override = chat && overrides !== null && typeof overrides === "object" && !Array.isArray(overrides) && Object.hasOwn(overrides, modelId) ? overrides[modelId] : undefined;
	const cost = override !== null && typeof override === "object" ? override.cost : undefined;
	if (cost === undefined || cost === null) return base;
	if (typeof cost !== "object" || Array.isArray(cost)) return null;
	return { input: cost.input ?? base.input, output: cost.output ?? base.output, cacheRead: cost.cacheRead ?? base.cacheRead, cacheWrite: cost.cacheWrite ?? base.cacheWrite, tiers: cost.tiers ?? base.tiers };
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

/** Every rate of a cost table and of each of its tiers is exactly 0. A rate that is absent or not a number is not 0. */
function isZeroCost(cost) {
	if (cost === null || typeof cost !== "object") return false;
	if (!RATE_KEYS.every((k) => cost[k] === 0)) return false;
	if (cost.tiers === undefined || cost.tiers === null) return true;
	return Array.isArray(cost.tiers) && cost.tiers.every((t) => t !== null && typeof t === "object" && RATE_KEYS.every((k) => t[k] === 0));
}

/**
 * Can this job spend nothing, so that a dollar window needs to hold nothing for it (issue #503 part 7, issue #501)?
 * `{ zeroRated: true }` only when EVERY model the job may call is BOTH:
 *   - served by a declared endpoint (`endpointsForModel`): a local or LAN server the operator runs, not a hosted
 *     provider that bills; and
 *   - zero-rated as pi would compose it (`composedCost`: the overlay entry's cost, else the builtin's, then the
 *     override): every rate of every table 0.
 * Else `{ zeroRated: false, why }`, a fixed phrase naming the first model that is not (for the log, never a comment).
 *
 * "Every model the job may call" is `refs`: the job's effective allowed-model list when it has one (issue #502), else
 * its main model alone. With a list, the MAIN model alone is not enough: the job may switch to any listed model, and
 * a hosted one would then spend with nothing reserved. Without a list a mid-run switch to another model is the named
 * residual of #503 (an unrestricted job's endpoint set is its main model's), and the runner still holds such a job to
 * a per-job cap of 0, which refuses every priced call before it is made.
 *
 * `models` null (no overlay, or one that could not be read) or no endpoints is never zero-rated: fail closed, and the
 * job reserves as usual. Pure: it reads only what it is handed, so the processor and any later reader agree by input.
 */
export function zeroRatedVerdict({ models, endpoints, refs, builtinModel = () => null }) {
	if (!Array.isArray(refs) || refs.length === 0) return { zeroRated: false, why: "no model to judge" };
	if (models === null || models === undefined || !Array.isArray(endpoints) || endpoints.length === 0) return { zeroRated: false, why: "no declared endpoint or no overlay models.json" };
	for (const ref of refs) {
		if (ref === null || typeof ref?.provider !== "string" || typeof ref?.id !== "string") return { zeroRated: false, why: "a list entry is not provider/model" };
		const label = `${ref.provider}/${ref.id}`;
		if (endpointsForModel({ models, provider: ref.provider, modelId: ref.id, endpoints }).length === 0) return { zeroRated: false, why: `${label} is not served by a declared endpoint` };
		if (!isZeroCost(composedCost({ models, provider: ref.provider, modelId: ref.id, builtinModel }))) return { zeroRated: false, why: `${label} is not zero-rated` };
	}
	return { zeroRated: true };
}

/**
 * The models the overlay makes report no usage while they cost money (issue #571), as `[{ provider, modelId }]`: the
 * calls on such a model reach the meter with pi's zero usage, so it counts every one as `costUnreported` and the job
 * settles at the floor. pi's openai-completions api asks for usage in the stream unless the model's composed
 * `compat.supportsUsageInStreaming` is `false`, and most servers then send none. Composed as pi 0.99.1's
 * provider-composer.js does:
 *   - a model the overlay DEFINES (`providers.<p>.models`): the provider's `compat`, then the model's own, then its
 *     `modelOverrides` entry, each key overriding the one before; its cost is composedCost's;
 *   - a BUILTIN chat model of that provider the overlay does not redefine (`builtinChatModels(provider)`, injected so
 *     this module never imports pi): the catalog's compat, then the provider's `compat`, then the `modelOverrides`
 *     entry; only when the overlay itself sets the flag `false` (the catalog's own value is pi's, not the operator's);
 *     its cost is the catalog's with the override's applied.
 * A model whose api is set to another api is skipped, since only openai-completions reads the flag; a defined model
 * with no api of its own or its provider's is kept. In the overlay's order, defined models before builtin ones.
 */
export function unreportedUsageModels(models, { builtinModel = () => null, builtinChatModels = () => [] } = {}) {
	const providers = models?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return [];
	const found = [];
	const flag = (compat) => (compat !== null && typeof compat === "object" ? compat.supportsUsageInStreaming : undefined);
	for (const provider of Object.keys(providers)) {
		const entry = providerOf(models, provider);
		if (entry === null) continue;
		const overrides = entry.modelOverrides !== null && typeof entry.modelOverrides === "object" && !Array.isArray(entry.modelOverrides) ? entry.modelOverrides : {};
		const overrideOf = (id) => (Object.hasOwn(overrides, id) ? overrides[id] : undefined);
		const defined = modelsOf(entry);
		for (const model of defined) {
			const api = model.api ?? entry.api;
			if (typeof api === "string" && api !== "openai-completions") continue;
			const usage = flag(overrideOf(model.id)?.compat) ?? flag(model.compat) ?? flag(entry.compat);
			if (usage !== false) continue;
			const cost = composedCost({ models, provider, modelId: model.id, builtinModel });
			if (cost !== null && isZeroCost(cost)) continue;
			found.push({ provider, modelId: model.id });
		}
		const listed = typeof builtinChatModels === "function" ? builtinChatModels(provider) : [];
		for (const builtin of Array.isArray(listed) ? listed : []) {
			if (builtin === null || typeof builtin !== "object" || typeof builtin.id !== "string") continue;
			if (defined.some((m) => m.id === builtin.id) || builtin.api !== "openai-completions") continue;
			if ((flag(overrideOf(builtin.id)?.compat) ?? flag(entry.compat)) !== false) continue;
			const cost = composedCost({ models, provider, modelId: builtin.id, builtinModel: () => builtin });
			if (cost !== null && isZeroCost(cost)) continue;
			found.push({ provider, modelId: builtin.id });
		}
	}
	return found;
}

/**
 * The priced models a declared endpoint serves on openai-completions whose output cap does not travel as `max_tokens`
 * (issue #507), as `[{ provider, modelId }]`. pi 0.99.1 sends the cap as `max_completion_tokens` unless the model's
 * composed `compat.maxTokensField` is `"max_tokens"`, and Ollama ignores that field, so the runner's cost guard
 * (`completionsOwnServer`, image/runner/src/usage-meter.mjs) counts every such call unboundable and refuses it under a
 * dollar cap. Composed the way unreportedUsageModels composes `supportsUsageInStreaming`: a defined model's provider
 * compat, then its own, then its `modelOverrides` entry; a builtin chat model's catalog compat, then the provider's,
 * then the override. Only models `endpointsForModel` puts on a declared endpoint, and not zero-rated ones (a zero
 * bound needs no output cap). A model whose api is set to another api is skipped. In the overlay's order.
 */
export function ignoredOutputCapModels({ models, endpoints, builtinModel = () => null, builtinChatModels = () => [] }) {
	const providers = models?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers) || !Array.isArray(endpoints) || endpoints.length === 0) return [];
	const found = [];
	const field = (compat) => (compat !== null && typeof compat === "object" ? compat.maxTokensField : undefined);
	const judge = (provider, modelId, maxTokensField, cost) => {
		if (maxTokensField === "max_tokens") return;
		if (endpointsForModel({ models, provider, modelId, endpoints }).length === 0) return;
		if (cost !== null && isZeroCost(cost)) return;
		found.push({ provider, modelId });
	};
	for (const provider of Object.keys(providers)) {
		const entry = providerOf(models, provider);
		if (entry === null) continue;
		const overrides = entry.modelOverrides !== null && typeof entry.modelOverrides === "object" && !Array.isArray(entry.modelOverrides) ? entry.modelOverrides : {};
		const overrideOf = (id) => (Object.hasOwn(overrides, id) ? overrides[id] : undefined);
		const defined = modelsOf(entry);
		for (const model of defined) {
			const api = model.api ?? entry.api;
			if (typeof api === "string" && api !== "openai-completions") continue;
			judge(provider, model.id, field(overrideOf(model.id)?.compat) ?? field(model.compat) ?? field(entry.compat), composedCost({ models, provider, modelId: model.id, builtinModel }));
		}
		const listed = typeof builtinChatModels === "function" ? builtinChatModels(provider) : [];
		for (const builtin of Array.isArray(listed) ? listed : []) {
			if (builtin === null || typeof builtin !== "object" || typeof builtin.id !== "string") continue;
			if (defined.some((m) => m.id === builtin.id) || builtin.api !== "openai-completions") continue;
			judge(provider, builtin.id, field(overrideOf(builtin.id)?.compat) ?? field(entry.compat) ?? field(builtin.compat), composedCost({ models, provider, modelId: builtin.id, builtinModel: () => builtin }));
		}
	}
	return found;
}

/** The exact `apiKey` a keyless provider's models.json entry carries: pi resolves `$NAME` from the job's environment. */
export const KEYLESS_API_KEY = `$${KEYLESS_ENV_NAME}`;

/**
 * The second way into the credential gate, said once for every refusal and doctor line that names it (issue #503).
 */
export const KEYLESS_HOW = `for a custom provider served by a local model server, declare that server in model-endpoints.json with "keyless": true and set "apiKey": "${KEYLESS_API_KEY}" on the provider in models.json (docs/egress.md, "Local model servers")`;

/**
 * Is this overlay provider keyless (issue #503, part 4)? `{ keyless: true, endpoints: [ids] }` only when ALL of these
 * hold, else `{ keyless: false, why }` (`why` null when the overlay does not define the provider at all):
 *   - the overlay `models.json` defines the provider and lists at least one model;
 *   - EVERY one of its models (effective baseUrl) is served by a declared endpoint, and every such endpoint is
 *     `keyless: true`. EVERY and not SOME: the job may switch to any model of its provider, and one model on a hosted
 *     server would then run with no key the gate ever looked at;
 *   - its `apiKey` is exactly `"$PI_DISPATCH_KEYLESS"`. pi composes a models.json provider only with SOME key (at 0.99.1,
 *     `provider-composer.js` "no authentication method configured"), and the worker sets that one variable, fixed and
 *     non-secret, on this branch alone. Any other value means pi sends something the gate never saw: a literal key (a
 *     secret in a mounted file, which `import-pi` already refuses), another `$VAR` (unset in the closed container env,
 *     so the runner exits 2 after the container started), or `!cmd` (a shell in the job). Refused rather than guessed;
 *   - it carries NO other credential of any kind: no `headers` on the provider, on any model or in any
 *     `modelOverrides` entry, no `oauth`, and no userinfo (`user:pass@`) in the provider's or any model's baseUrl.
 *     Keyless means no credentials, and this is the simple rule rather than a judgement of which header looks like a
 *     secret. Nothing of it would reach a hosted service (every model must be on a declared endpoint), but a header
 *     value is a pi config value too (`!cmd` runs a shell, `$VAR` is unset in the closed env), and a secret in the
 *     overlay is a secret in a mounted file;
 *   - every model entry is an object with a non-empty string `id`. pi validates models.json strictly and refuses the
 *     WHOLE file over one bad entry, so skipping it here would pass a job whose runner then exits 2 in a container.
 *
 * The overlay is read the way pi reads it (`readOverlayModels`, issue #502): a file pi loads (comments, a BOM, a
 * trailing comma) is read here too, and a file pi drops is refused here, so nothing in it is keyless: fail closed.
 *
 * Whether pi itself knows the provider is NOT asked here: this module never imports pi. The callers ask that first,
 * with the same predicate as the credential gate (`env-allowlist.mjs`), and only an unknown provider reaches this.
 * Pure: it reads the snapshot it is handed and nothing else, so the gate, the env writer and doctor agree by input.
 */
export function keylessVerdict({ models, provider, endpoints }) {
	const entry = providerOf(models, provider);
	if (entry === null) return { keyless: false, why: null };
	if (entry.apiKey !== KEYLESS_API_KEY) return { keyless: false, why: `its models.json "apiKey" is not "${KEYLESS_API_KEY}"` };
	const credential = otherCredential(entry);
	if (credential !== null) return { keyless: false, why: `it sets ${credential}, and keyless means no credentials of any kind` };
	if (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.some((m) => m === null || typeof m !== "object" || Array.isArray(m) || typeof m.id !== "string" || m.id === ""))) {
		return { keyless: false, why: 'a model entry in models.json is not an object with a non-empty string "id", so pi would refuse the file' };
	}
	const served = endpointsForProvider({ models, provider, endpoints });
	if (served.length === 0) return { keyless: false, why: "it lists no models in models.json" };
	const ids = new Set();
	for (const { modelId, endpoints: used } of served) {
		if (used.length === 0) return { keyless: false, why: `its model ${JSON.stringify(modelId)} is not served by a declared model endpoint` };
		for (const e of used) {
			if (e.keyless !== true) return { keyless: false, why: `the endpoint ${e.id} serving its model ${JSON.stringify(modelId)} is not "keyless": true` };
			ids.add(e.id);
		}
	}
	return { keyless: true, endpoints: [...ids].sort() };
}

/** The first credential a keyless provider must not carry besides its apiKey, named for the refusal; null when none. */
function otherCredential(entry) {
	if (entry.headers !== undefined) return "provider headers";
	if (entry.oauth !== undefined) return '"oauth"';
	if (hasUserinfo(entry.baseUrl)) return "a user or password in its baseUrl";
	for (const m of Array.isArray(entry.models) ? entry.models : []) {
		if (m === null || typeof m !== "object") continue;
		if (m.headers !== undefined) return `headers on its model ${JSON.stringify(m.id)}`;
		if (hasUserinfo(m.baseUrl)) return `a user or password in the baseUrl of its model ${JSON.stringify(m.id)}`;
	}
	const overrides = entry.modelOverrides;
	if (overrides !== null && typeof overrides === "object") {
		for (const [id, o] of Object.entries(overrides)) if (o !== null && typeof o === "object" && o.headers !== undefined) return `headers in modelOverrides ${JSON.stringify(id)}`;
	}
	return null;
}

function hasUserinfo(baseUrl) {
	if (typeof baseUrl !== "string") return false;
	try {
		const url = new URL(baseUrl);
		return url.username !== "" || url.password !== "";
	} catch {
		return false;
	}
}

/**
 * The loopback addresses a declared name must not resolve to: `to_host_local`'s set (deploy/egress-proxy.conf) minus
 * 169.254.0.0/16 and fe80::/10. Those two are left out on purpose: on Podman 5.3 and later `host.containers.internal`
 * is 169.254.1.2 (pasta's --map-guest-addr, measured 2026-09-30 on Podman 5.8.1), which is how a rootless job reaches a
 * server on its own host. 10.0.2.2 (slirp4netns's host alias) stays, as in `to_host_local`. Built from
 * `PROXY_LOCAL_ADDRESSES` in backends.mjs, the one source the parser's refusal and `hostRouteFor` read too.
 */
export const LOCAL_ADDRESSES = PROXY_LOCAL_ADDRESSES.join(" ");

/** The header every rendered include starts with. A comments-only file is one squid starts on (measured). */
export const ENDPOINTS_INCLUDE_HEADER = [
	"# Generated by pi-dispatch from model-endpoints.json. Do not edit: regenerate it with `pi-dispatch egress render`.",
	"# Each endpoint is a CONNECT tunnel to exactly one declared host and port, and nothing else (issue #503).",
	"# The host ACL comes first on every line, so squid only ever resolves a declared name.",
].join("\n");

/**
 * The squid include for these endpoints: deterministic, sorted by id, header first. Per endpoint, a host ACL, a
 * port ACL, a loopback ACL, a deny for the declared name when it resolves to loopback, and a CONNECT allow for the
 * pair. No plain forward request is allowed: pi sends every provider call as a CONNECT tunnel.
 *
 * The host ACL is `dstdomain -n` for a name AND for an IP literal. Measured on squid 6.13, 2026-09-30: a `dst <ip>`
 * ACL makes squid resolve the name of every CONNECT that reaches the line, a DNS channel out of the job, and admits
 * any name that resolves to that address; `dstdomain -n <ip>` does neither.
 */
export function renderEndpointsInclude(endpoints) {
	const sorted = [...(endpoints ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const lines = [ENDPOINTS_INCLUDE_HEADER];
	for (const e of sorted) {
		// Parser output only. Checked again here because these lines are proxy rules: a newline in either would be a
		// rule nobody declared.
		if (typeof e.id !== "string" || !ID_RE.test(e.id)) throw new Error(`renderEndpointsInclude: bad id ${JSON.stringify(e.id)}`);
		if (typeof e.host !== "string" || !/^[a-z0-9_.:[\]-]+$/.test(e.host)) throw new Error(`renderEndpointsInclude: bad host ${JSON.stringify(e.host)}`);
		if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error(`renderEndpointsInclude: bad port ${JSON.stringify(e.port)}`);
		const n = `pde_${e.id}`;
		lines.push(
			"",
			`# ${e.id}`,
			`acl ${n}_host dstdomain -n ${e.host}`,
			`acl ${n}_port port ${e.port}`,
			`acl ${n}_local dst ${LOCAL_ADDRESSES}`,
			`http_access deny CONNECT ${n}_host ${n}_port ${n}_local`,
			`http_access allow CONNECT ${n}_host ${n}_port`,
		);
	}
	return `${lines.join("\n")}\n`;
}
