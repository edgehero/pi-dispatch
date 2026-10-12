/**
 * The overlay's `mcp.json` (REQ-MCP-OPERATOR-SERVERS, INT-OVERLAY-MCP-CONFIG): the MCP servers the operator offers to
 * jobs, in pi's own `mcpServers` shape, read on the host. A job connects only servers named here, and only those its
 * trigger names (`run.mcp`); a repo's `.pi/mcp.json` is never read for a job.
 *
 * The file is mounted into an adversarial-input container, so it carries no credential. A credential is written as a
 * `${NAME}` reference, NAME in capitals, digits and `_`, which the job fills in from the variables its trigger already
 * passes (`run.secrets`, PI_FORWARD_ENV), and it may go wherever servers put one:
 *   - an env value is exactly `${NAME}`, and a header value is `${NAME}` or an auth scheme before it
 *     (`Bearer ${NAME}`; `MCP_HEADER_SCHEMES`): a VALUE there is never written in the overlay at all;
 *   - each value of a url's query is exactly `${NAME}`, for the same reason;
 *   - a url's path and an argument may hold references amid literal text (`/mcp/${KEY}/sse`, `--token=${T}`).
 * A literal path segment or argument is written as is: nothing can tell a key from a file name there, and two rules
 * that tried (credential-like header and env names, credential-like flags) were measured refusing `--max-tokens 4096`
 * while passing `X-Goog-Key`, `GH_PAT` and `--api_key=sk-...`. So the place for a credential is a reference, and the
 * docs say plainly that a literal argument or path is readable by every job. A url carries no fragment and no user
 * name or password. pi's own resolver would run a value starting with `!` and expand bare `$NAME`; the job resolves
 * the references itself, never pi.
 *
 * Accepted is a subset of pi 1.1.0's schema (core/mcp-servers.js `validateMcpServerConfig`), strict on keys: a key
 * pi-dispatch does not know is refused, so a key a later pi adds is read before a job relies on it. Refused outright:
 * `auth` and `oauth` (a credential flow the container cannot finish, and a token file it must not hold), `cwd` (a job
 * runs its servers in the checkout), and the legacy `sse` type, which pi refuses too. `allowPackageRunner` is
 * pi-dispatch's own: it stays in the overlay's file and is stripped (`piEntry`) before a job hands an entry to pi.
 *
 * Pure apart from the one read (`readOverlayMcp`), which judges the file the way `readOverlayModels` judges the
 * overlay's `models.json`.
 */
import { lstatSync as fsLstatSync, readFileSync as fsReadFileSync } from "node:fs";
import { basename, isAbsolute, join, posix } from "node:path";
import { findDuplicateKey } from "./json-duplicates.mjs";

/** The file's name, in the overlay and in a host agent dir. */
export const MCP_CONFIG_FILE_NAME = "mcp.json";
/** The largest overlay `mcp.json` read, in bytes. A server list is a few hundred bytes; this is a bound, not a budget. */
export const MCP_CONFIG_MAX_BYTES = 64 * 1024;
/**
 * A server name: lowercase words of letters and digits joined by single `-`, up to 32. Narrower than pi's, so no two
 * names share pi's namespace: pi writes `-` as `_` in `mcp__<server>__<tool>`, and a trailing `-` or a `--` would let one
 * server's tool name read as another's (`a-` with `x` and `a` with `_x` are both `mcp__a___x`).
 */
export const MCP_SERVER_NAME_RE = /^(?=[a-z0-9-]{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The exposures pi 1.1.0 takes, by their current names (pi's alias `codemode-deferred` is refused, not translated). */
export const MCP_EXPOSURES = Object.freeze(["codemode", "deferred", "direct", "hidden"]);
/** Top-level keys. */
export const MCP_TOP_KEYS = Object.freeze(["autoEnableCodemode", "codemodeModels", "mcpServers"]);
/** Keys every server may carry. */
const COMMON_KEYS = ["type", "description", "exposure", "toolExposure", "timeout", "enabled"];
/** Keys of a streamable HTTP server. */
export const MCP_HTTP_KEYS = Object.freeze([...COMMON_KEYS, "url", "headers"]);
/** Keys of a stdio server. `allowPackageRunner` is pi-dispatch's own. */
export const MCP_STDIO_KEYS = Object.freeze([...COMMON_KEYS, "command", "args", "env", "allowPackageRunner"]);
/** pi keys refused with a reason, rather than as unknown. */
export const MCP_REFUSED_KEYS = Object.freeze({
	auth: "it sends a pi login's token, which a job does not hold",
	oauth: "OAuth needs a sign-in in a browser and a token file, and a job has neither",
	cwd: "a job runs its servers in the checkout",
});
/**
 * Commands that fetch the server they run from a package registry at start (`npx -y pkg`, `uvx pkg`). A job reaches a
 * registry only when the operator allowlists it, and runs whatever version it finds there, so such a server is
 * refused unless its entry says `allowPackageRunner: true`.
 */
export const MCP_PACKAGE_RUNNERS = Object.freeze(["npx", "npm", "pnpm", "pnpx", "yarn", "bunx", "bun", "uvx", "uv", "pipx"]);
/**
 * The folders an absolute stdio command may sit under: the job image's system folders and the overlay. Named rather
 * than excluded, since the job's root filesystem is writable and a list of folders the job writes (`/workspace`,
 * `/tmp`, `/var/tmp`, `/dev/shm`...) always has a next one. A bare name is looked up on the image's PATH.
 */
export const MCP_COMMAND_ROOTS = Object.freeze(["/usr", "/bin", "/sbin", "/opt", "/app"]);
/** The auth schemes a header value may name before its reference, compared without case. */
export const MCP_HEADER_SCHEMES = Object.freeze(["Bearer", "Basic", "Token", "Bot", "ApiKey", "Key", "Splunk", "SSWS", "Digest"]);
/** Names a plain object would not keep as its own key. */
const RESERVED_NAMES = ["__proto__", "constructor", "prototype"];
/** A header name, as HTTP takes it (RFC 9110 token). */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** An env value. */
const ENV_REF_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
/** A header value: a reference, optionally after an auth scheme and a space. */
const HEADER_REF_RE = new RegExp(`^(?:(?:${MCP_HEADER_SCHEMES.join("|")}) )?\\$\\{([A-Z_][A-Z0-9_]*)\\}$`, "i");
/** Any reference, as it is written. */
const REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name a header (`header: true`) or env value references, or `{ problem }`. Every such value is a reference.
 */
export function refValue(value, { header = false } = {}) {
	if (typeof value !== "string") return { problem: "is not a string" };
	const match = (header ? HEADER_REF_RE : ENV_REF_RE).exec(value);
	if (match) return { name: match[1] };
	const shape = header ? `\`\${NAME}\`, or an auth scheme and a space before it (\`Bearer \${NAME}\`; ${MCP_HEADER_SCHEMES.join(", ")})` : "exactly `${NAME}`";
	return { problem: `must be ${shape}, NAME in capitals, digits and \`_\`: a value is never written in the overlay, which every job can read` };
}

/**
 * Why text that may hold references amid literal text (a url path, an argument) breaks the grammar, or null; `refs`
 * collects the names. Every `${` opens a whole reference, so nothing reads one way here and another in the job.
 */
function mixedProblem(value, refs) {
	if (value.startsWith("!")) return "starts with `!`";
	const rest = value.replace(REF_RE, (_, name) => {
		refs.add(name);
		return "";
	});
	if (rest.includes("${")) return "has a `${` that is not a whole `${NAME}` reference (NAME in capitals, digits and `_`)";
	return null;
}

/** A name from the operator's file, quoted as JSON, so a control character in it is shown and never sent. */
const shown = (name) => JSON.stringify(name);

/**
 * The server, checked and normalised (`{ name, transport, ...pi keys }`), or `{ name, problem }`. `transport` is
 * "http" or "stdio"; `allowPackageRunner` is kept on the normalised entry for pi-dispatch and stripped by `piEntry`.
 */
function checkServer(name, raw) {
	const refuse = (problem) => ({ name, problem });
	if (!MCP_SERVER_NAME_RE.test(name)) return refuse("the name must be lowercase letters and digits, words joined by single `-`, up to 32");
	if (name.includes("dispatch")) return refuse("a name holding `dispatch` is reserved for the dispatch admin");
	if (!isRecord(raw)) return refuse("the entry is not an object");
	for (const key of Object.keys(raw)) {
		if (Object.hasOwn(MCP_REFUSED_KEYS, key)) return refuse(`\`${key}\` is not accepted: ${MCP_REFUSED_KEYS[key]}`);
	}
	const { type } = raw;
	if (type === "sse") return refuse("the legacy SSE transport is not supported; use the server's streamable HTTP URL");
	if (type !== undefined && !["http", "streamable-http", "stdio"].includes(type)) return refuse("`type` must be http, streamable-http or stdio");
	const hasUrl = raw.url !== undefined;
	const hasCommand = raw.command !== undefined;
	if (hasUrl === hasCommand) return refuse("the entry needs exactly one of `url` (streamable HTTP) or `command` (stdio)");
	const transport = hasUrl ? "http" : "stdio";
	if (type !== undefined && (type === "stdio") !== (transport === "stdio")) return refuse(`\`type\` ${type} does not match a server with \`${hasUrl ? "url" : "command"}\``);
	const allowed = transport === "http" ? MCP_HTTP_KEYS : MCP_STDIO_KEYS;
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) return refuse(`${shown(key)} is not a key a ${transport === "http" ? "streamable HTTP" : "stdio"} server takes here`);
	}

	if (typeof raw.description !== "string" || raw.description.trim() === "") return refuse("`description` is required: one sentence on what the server offers, which pi puts in the job's prompt");
	if (raw.description.length > 300 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw.description)) return refuse("`description` must be one line of at most 300 characters, with no control or format characters");
	if (raw.exposure !== undefined && !MCP_EXPOSURES.includes(raw.exposure)) return refuse(`\`exposure\` must be one of ${MCP_EXPOSURES.join(", ")}`);
	if (raw.toolExposure !== undefined) {
		if (!isRecord(raw.toolExposure)) return refuse("`toolExposure` must map tool names or `*` patterns to exposures");
		for (const [tool, exposure] of Object.entries(raw.toolExposure)) {
			if (!MCP_EXPOSURES.includes(exposure)) return refuse(`\`toolExposure\` ${shown(tool)} must be one of ${MCP_EXPOSURES.join(", ")}`);
		}
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return refuse("`enabled` must be true or false");
	if (raw.timeout !== undefined && !(Number.isInteger(raw.timeout) && raw.timeout > 0 && raw.timeout <= 600)) return refuse("`timeout` must be a whole number of seconds from 1 to 600");

	const entry = { name, transport };
	for (const key of ["description", "exposure", "toolExposure", "timeout", "enabled"]) if (raw[key] !== undefined) entry[key] = raw[key];
	const refs = new Set();

	if (transport === "http") {
		if (typeof raw.url !== "string") return refuse("`url` must be a string");
		if (raw.url.includes("#")) return refuse("`url` must not carry a fragment");
		const urlProblem = mixedProblem(raw.url, refs);
		if (urlProblem) return refuse(`\`url\` ${urlProblem}`);
		// Read as a URL parser reads it, never by cutting the text: the parser also takes `https:/h`, a backslash and a
		// tab as the start of the host. Parsed whole, with two different words standing in for each reference, the url
		// must be written exactly as the parser writes it back (one spelling, no guessing at the others), and its host
		// must come out the same both times, so no reference is ever part of it.
		const stand = (word) => raw.url.replace(REF_RE, word);
		if (!URL.canParse(stand("refa"))) return refuse("`url` is not a URL");
		const url = new URL(stand("refa"));
		if (url.host !== new URL(stand("refb")).host) return refuse("`url` holds a reference in its host; the host is written as is, since the egress check reads it before the job starts");
		if (url.href !== stand("refa") && url.href !== `${stand("refa")}/`) return refuse(`\`url\` must be written in its plain form, as a URL parser writes it back (${JSON.stringify(url.href.replaceAll("refa", "${...}"))})`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return refuse("`url` must be http or https");
		if (url.username !== "" || url.password !== "") return refuse("`url` must not carry a user name or password; send a credential in a header, as a `${NAME}` reference");
		const query = raw.url.includes("?") ? raw.url.slice(raw.url.indexOf("?") + 1) : undefined;
		if (query !== undefined) {
			for (const pair of query.split("&")) {
				const eq = pair.indexOf("=");
				const value = eq === -1 ? "" : pair.slice(eq + 1);
				if (!ENV_REF_RE.test(value)) return refuse(`\`url\` query value ${shown(eq === -1 ? pair : pair.slice(0, eq))} must be exactly \`\${NAME}\`: a query is where hosted servers put a key, so no value there is written in the overlay`);
			}
		}
		entry.url = raw.url;
		if (raw.headers !== undefined) {
			if (!isRecord(raw.headers)) return refuse("`headers` must map header names to strings");
			for (const [header, value] of Object.entries(raw.headers)) {
				if (!HEADER_NAME_RE.test(header) || RESERVED_NAMES.includes(header)) return refuse(`header name ${shown(header)} is not a valid HTTP header name`);
				const ref = refValue(value, { header: true });
				if (ref.problem) return refuse(`header ${shown(header)} ${ref.problem}`);
				refs.add(ref.name);
			}
			entry.headers = { ...raw.headers };
		}
	} else {
		if (typeof raw.command !== "string" || raw.command === "") return refuse("`command` must be a non-empty string");
		if (raw.command.startsWith("!")) return refuse("`command` starts with `!`");
		if (raw.command.includes("$")) return refuse("`command` holds a `$`; it is used as written, and a reference goes in an argument or `env`");
		if (raw.command.startsWith("~")) return refuse("`command` must not start with `~`, which pi reads as the job's home folder");
		if (!isAbsolute(raw.command) && raw.command.includes("/")) return refuse("`command` must be an absolute path or a bare name found on the job image's PATH");
		if (isAbsolute(raw.command)) {
			const normalised = posix.normalize(raw.command);
			if (!MCP_COMMAND_ROOTS.some((r) => normalised.startsWith(`${r}/`))) return refuse(`\`command\` must sit under ${MCP_COMMAND_ROOTS.join(", ")} (the job image's own folders and the overlay at /opt/pi-global); the job writes the others`);
		}
		if (raw.allowPackageRunner !== undefined && typeof raw.allowPackageRunner !== "boolean") return refuse("`allowPackageRunner` must be true or false");
		const runner = MCP_PACKAGE_RUNNERS.includes(basename(raw.command));
		if (runner && raw.allowPackageRunner !== true) return refuse(`\`command\` ${basename(raw.command)} fetches the server from a package registry at start; install it in the job image, or set \`allowPackageRunner: true\` and allowlist the registry`);
		entry.command = raw.command;
		if (raw.args !== undefined) {
			if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string")) return refuse("`args` must be a list of strings");
			for (const arg of raw.args) {
				const problem = mixedProblem(arg, refs);
				if (problem) return refuse(`an argument ${problem}`);
				if (arg.startsWith("~")) return refuse("an argument starts with `~`, which pi reads as the job's home folder, a folder the job writes");
			}
			entry.args = [...raw.args];
		}
		if (raw.env !== undefined) {
			if (!isRecord(raw.env)) return refuse("`env` must map variable names to strings");
			for (const [key, value] of Object.entries(raw.env)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || RESERVED_NAMES.includes(key)) return refuse(`env name ${shown(key)} is not a variable name`);
				const ref = refValue(value);
				if (ref.problem) return refuse(`env ${key} ${ref.problem}`);
				refs.add(ref.name);
			}
			entry.env = { ...raw.env };
		}
		entry.packageRunner = runner;
	}
	entry.refs = [...refs].sort();
	return entry;
}

/**
 * Parse an overlay `mcp.json`. Throws an Error (marked `mcpConfig`) for a file that cannot be read as a whole: not
 * JSON, a duplicate key, not an object, an unknown top-level key. Returns `{ autoEnableCodemode, servers, refused }`:
 * `servers` the accepted entries by name, `refused` `[{ name, problem }]` for each entry that is not accepted. A
 * refused entry is never offered to a job; doctor names it, and import-pi leaves it behind.
 */
export function parseOverlayMcp(text, path = MCP_CONFIG_FILE_NAME) {
	const fail = (why) => {
		const error = new Error(`${path}: ${why}`);
		error.mcpConfig = true;
		return error;
	};
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		// Never the parser's message: V8 quotes the text around the error, which can be a header's value.
		throw fail("not valid JSON");
	}
	const duplicate = findDuplicateKey(text);
	if (duplicate) throw fail(`the key ${JSON.stringify(duplicate.at)} appears twice; JSON keeps only the last, so the file would not say what it reads as`);
	if (!isRecord(value)) throw fail("expected an object with an `mcpServers` object");
	for (const key of Object.keys(value)) {
		if (!MCP_TOP_KEYS.includes(key)) throw fail(`${shown(key)} is not a top-level key here (accepted: ${MCP_TOP_KEYS.join(", ")})`);
	}
	if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== "boolean") throw fail("`autoEnableCodemode` must be true or false");
	// pi-dispatch's own (pi's loader ignores a top-level key it does not know): whether a job's codemode scripts may call
	// `models.classify()` and `models.generateImages()`. On by default, as in the pi CLI; every such call is metered,
	// held to the job's model list, and refused under a cost cap when it cannot be bounded (DES-MCP-CODEMODE-MODELS).
	if (value.codemodeModels !== undefined && typeof value.codemodeModels !== "boolean") throw fail("`codemodeModels` must be true or false");
	if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) throw fail("`mcpServers` must be an object of servers by name");
	const servers = {};
	const refused = [];
	for (const [name, raw] of Object.entries(value.mcpServers ?? {})) {
		const entry = checkServer(name, raw);
		if (entry.problem) refused.push(entry);
		else servers[name] = entry;
	}
	return { autoEnableCodemode: value.autoEnableCodemode ?? true, codemodeModels: value.codemodeModels ?? true, servers, refused };
}

/** The entry as pi takes it: pi's keys only, with `type` written out. */
export function piEntry(server) {
	const { name, transport, refs, packageRunner, ...rest } = server;
	return { type: transport === "http" ? "http" : "stdio", ...rest };
}

/** The per-job document's name in the job's folder, read in the container as `/job/mcp.json`. */
export const JOB_MCP_FILE = "mcp.json";
/** The per-job document's version: the runner refuses one it does not know. */
export const JOB_MCP_VERSION = 1;

/**
 * The per-job document the worker writes to `/job/mcp.json` (INT-CONTAINER-JOB-INPUTS) for the servers a job's
 * trigger names, in that order: each in pi's shape with every reference still a reference, `toolExposure` gaining
 * `"dispatch_*": "hidden"` (an MCP tool by that name is never offered, the admin's tools being the one recursion
 * vector), and the names each server references, so the runner resolves those and no other. Never a value: the
 * worker holds the trigger's resolved secrets, and none of them reaches this file. `codemodeModels` is the overlay's
 * (on unless it says false): codemode's `models.*` reach the runner's meter and guards like any model call
 * (image/runner/test/codemode-models.integration.test.mjs).
 */
export function jobMcpDocument(parsed, names) {
	const servers = {};
	const refs = {};
	for (const name of names) {
		const server = parsed.servers[name];
		const entry = piEntry(server);
		// pi takes an exact tool name before any pattern, and the patterns in order (core/mcp-servers.js
		// `getMcpToolExposure`), so the hide goes FIRST and a key of the operator's that names only such tools (an exact
		// `dispatch_` name, which would beat the pattern, or a narrower pattern) goes. Any other key stays as written: a
		// `dispatch*` pattern still governs `dispatcher_run`, and the hide, being first, still governs `dispatch_run`.
		const kept = Object.entries(entry.toolExposure ?? {}).filter(([key]) => !key.startsWith("dispatch_"));
		entry.toolExposure = Object.fromEntries([["dispatch_*", "hidden"], ...kept]);
		servers[name] = entry;
		refs[name] = [...server.refs];
	}
	return { version: JOB_MCP_VERSION, autoEnableCodemode: parsed.autoEnableCodemode, codemodeModels: parsed.codemodeModels !== false, servers, refs };
}

/** The text of an overlay `mcp.json` holding exactly `parsed`'s accepted servers, as import-pi writes it. */
export function overlayMcpText(parsed) {
	const mcpServers = {};
	for (const [name, server] of Object.entries(parsed.servers)) {
		const { type, ...entry } = piEntry(server);
		if (server.packageRunner) entry.allowPackageRunner = true;
		mcpServers[name] = server.transport === "http" ? { type, ...entry } : entry;
	}
	const out = { mcpServers };
	if (parsed.autoEnableCodemode === false) out.autoEnableCodemode = false;
	if (parsed.codemodeModels === false) out.codemodeModels = false;
	return `${JSON.stringify(out, null, 2)}\n`;
}

/** Where a server is: its URL's host and port, or its command's base name. Never a header, an env value or an argument. */
export function mcpServerWhere(server) {
	if (server.transport === "http") return URL.canParse(server.url) ? new URL(server.url).host : "an unreadable url";
	return basename(server.command);
}

const ABSENT_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENAMETOOLONG"]);

/**
 * The overlay's `mcp.json` (`<globalPiDir>/mcp.json`), parsed: `null` when there is none, the `parseOverlayMcp` result
 * otherwise. Judged as the overlay readers beside it judge `models.json` (`readOverlayModels`): a link of any kind, a
 * named pipe, socket or device, and a file over `MCP_CONFIG_MAX_BYTES` are refused (marked `mcpConfig`); any other fs
 * error is rethrown with its code.
 */
export function readOverlayMcp(globalPiDir, { readFileSync = fsReadFileSync, lstatSync = fsLstatSync } = {}) {
	if (typeof globalPiDir !== "string" || globalPiDir === "") return null;
	const path = join(globalPiDir, MCP_CONFIG_FILE_NAME);
	const fail = (why) => {
		const error = new Error(`${path}: ${why}`);
		error.mcpConfig = true;
		return error;
	};
	let text;
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink()) throw fail("is a link; replace it with the file itself (the job's read-only mount cannot follow links reliably)");
		if (!entry.isFile()) throw fail("is not a regular file; replace it with the file itself");
		if (entry.size > MCP_CONFIG_MAX_BYTES) throw fail(`is larger than ${MCP_CONFIG_MAX_BYTES} bytes`);
		text = String(readFileSync(path, "utf8"));
	} catch (error) {
		if (ABSENT_CODES.has(error?.code)) return null;
		throw error;
	}
	return parseOverlayMcp(text, path);
}
