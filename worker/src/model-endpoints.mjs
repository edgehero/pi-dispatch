/**
 * Declared model endpoints (issue #503, INT-MODEL-ENDPOINTS-FILE-CONTRACT): the local or LAN model servers
 * (Ollama, vLLM, llama.cpp, LM Studio) a job may reach through the egress proxy. One `model-endpoints.json` of
 * `{ "version": 1, "endpoints": [ { id, host, port, slots, keyless? } ] }` in the deployment folder.
 *
 * This module is pure and fs-injectable, in scoped-limits.mjs' style: `parseModelEndpoints` validates the file TEXT
 * and refuses, never repairs; `loadModelEndpoints` layers the one fs read on top; `endpointsForModel` derives which
 * endpoints a model uses from the overlay `models.json`; `renderEndpointsInclude` writes the squid include the proxy
 * reads. Nothing here enforces anything yet: the proxy include line, the mounts, the slot leases and the keyless
 * credential gate are later changes of the same issue, and they bind to this one implementation.
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

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join, resolve } from "node:path";
import { PROXY_LOCAL_ADDRESSES, isProxyLocalHost } from "./backends.mjs";
import { configError } from "./config.mjs";

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

const ID_RE = /^[a-z0-9-]{1,32}$/;
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
	// `name:port` or `[v6]:port`, the shape a URL writes, caught before the IPv6 test would call it a bad address.
	if (/^[^:[\]]+:[0-9]+$/.test(lower) || /^\[[^\]]*\]:[0-9]+$/.test(lower)) {
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
 * The overlay's `models.json` (`<globalPiDir>/models.json`), parsed as JSON and nothing else: no `$VAR` expansion,
 * because the host's environment is not the job's, and a derivation that expanded one would describe a server the
 * job never dials. `null` when there is no overlay or no file. Malformed JSON is a `configError`.
 */
export function readOverlayModels(globalPiDir, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	if (typeof globalPiDir !== "string" || globalPiDir === "") return null;
	const path = join(globalPiDir, "models.json");
	if (!existsSync(path)) return null;
	let parsed;
	try {
		parsed = JSON.parse(String(readFileSync(path, "utf8")));
	} catch (error) {
		throw configError(`overlay models.json is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw configError(`overlay models.json must be an object: ${path}`);
	return parsed;
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
