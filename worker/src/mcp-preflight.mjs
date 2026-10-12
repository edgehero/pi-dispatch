/**
 * The pickup's MCP question (REQ-MCP-OPERATOR-SERVERS, DES-MCP-EGRESS-PREFLIGHT): can this job use the overlay MCP
 * servers its trigger names (`run.mcp`)? Answered before anything is spent (CONST-BUDGET-BEFORE-TOKENS), from the
 * overlay's `mcp.json` read once for the job, and the answer carries the per-job document `prepare` writes to
 * `/job/mcp.json`, so the servers the job connects are exactly the servers this check passed.
 *
 * One of:
 *   { ok: true, document }        `document` null when the job names no server
 *   { refused, name, why }        a determinate refusal, returned (CONST-RETRY-INFRA-ONLY): `refused` is the reason
 *   { unavailable: code }         the overlay could not be read just now, an errno that may pass: retried
 *
 * The refusals, in the order they are asked:
 *   mcp-list-invalid         the job's own list is not one the loader writes (queue data from another version, or a
 *                            hand-added job);
 *   mcp-config-invalid       the overlay's mcp.json cannot be read whole (or there is no overlay, or no file);
 *   mcp-server-unknown       a name the file does not offer, offers disabled, or refuses (doctor names why);
 *   mcp-secret-reserved      a reference to a variable this deployment writes or pi reads for the job itself (a
 *                            credential the job spends with, `providerKeyNames`; a minted forge token; the egress or
 *                            runner variables): a server must never be handed the job's own credentials. Asked of
 *                            every reference before the next rule;
 *   mcp-secret-unmapped      a reference the job will not have: not a `run.secrets` name, and not a PI_FORWARD_ENV
 *                            name the worker's environment holds a value for;
 *   mcp-excluded             the trigger's own run.excludeTools leaves a server no way in that it had: its tools and
 *                            its resources reachable only through tools it removed (`mcpRouteProblem`);
 *   mcp-egress-unreachable   with the egress policy on, a streamable HTTP server the proxy would not let the job reach;
 *   mcp-package-runner       with the egress policy on, a package runner whose registry the allowlist does not hold.
 */
import { allowlistEntryFor, egressRefusalFor, packageRunnerHosts } from "./egress-allowlist.mjs";
import { jobMcpDocument, MCP_SERVER_NAME_RE, readOverlayMcp } from "./mcp-config.mjs";
import { MCP_SERVERS_MAX, mcpServerToolPattern } from "./triggers.mjs";

/**
 * Errnos a read of the overlay may pass on a second try. Restated from model-catalog.mjs `OVERLAY_TRANSIENT_READ_CODES`
 * rather than imported, since that module loads pi's catalog; mcp-preflight.test.mjs holds the two equal.
 */
export const MCP_TRANSIENT_READ_CODES = new Set(["EIO", "EAGAIN", "EMFILE", "ENFILE"]);

/** A variable reference in a pi config value, `$NAME` or `${NAME}`, anywhere in the string (pi's own grammar). */
const CONFIG_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The credentials a job is set up to spend with, as variable names: each builtin key variable of the providers it may
 * call (`providers`: its main provider and the ones on its model list), and every variable the overlay models.json
 * references anywhere (a custom provider's `apiKey` in any form, its headers, a model's or an override's headers),
 * since pi reads each of them for model calls. A builtin provider the job cannot call (its model list does not name
 * it, `jobProviders`) is not counted: its variable is one the operator may hand a server on purpose (`HF_TOKEN` for a
 * Hugging Face MCP server), as `run.secrets` may. A custom provider whose key is a `!command` names no variable this
 * can see: the operator who writes both files is the one who can avoid that pairing.
 */
export function providerKeyNames({ providers = [], candidatesOf = () => [], overlayModels = null } = {}) {
	const names = new Set();
	for (const provider of providers) for (const name of candidatesOf(provider) ?? []) if (typeof name === "string") names.add(name);
	const walk = (value) => {
		if (typeof value === "string") for (const match of value.matchAll(CONFIG_REF_RE)) names.add(match[1] ?? match[2]);
		else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
	};
	walk(overlayModels);
	return names;
}

/**
 * The providers a job may call: its own, and each on its model list (the trigger's, else the deployment's), which the
 * runner's model guard holds every call to. With no list there is no guard, and the job may call any provider whose
 * key its container holds (a pi child of its own, `--provider` and all), so every builtin provider (`everyProvider`)
 * counts. An operator who hands a server a provider's variable on purpose (`HF_TOKEN`) gives that trigger a list.
 */
export function jobProviders(job, { defaultProvider = null, allowedModels = null, everyProvider = [] } = {}) {
	const list = Array.isArray(job?.models) ? job.models : Array.isArray(allowedModels) ? allowedModels : null;
	const listed = list === null ? everyProvider : list.map((ref) => (typeof ref === "string" ? ref.split("/")[0] : ref?.provider));
	return [...new Set([job?.provider ?? defaultProvider, ...listed].filter((p) => typeof p === "string" && p !== ""))];
}

/**
 * The check, bound to this deployment. `reserved(job)` is the set of variable names the job's own container holds for
 * itself; `hostEnv` is the worker's environment, which decides whether a PI_FORWARD_ENV name reaches the job at all;
 * `allowlist()` and `endpoints()` are read only when a server needs them, and `allowlist()` throws what its read threw.
 */
export function makeMcpCheck({ globalPiDir, forwardEnv = [], hostEnv = {}, egress = false, reserved = () => new Set(), allowlist = () => [], endpoints = () => [], read = readOverlayMcp }) {
	return (job) => {
		const listed = job?.mcp;
		if (listed === undefined) return { ok: true, document: null };
		// The loader's shape, asked again: queue data is not always the current receiver's (an older or newer service,
		// a hand-added job, a stored repeatable), and a list that is not one must neither pass as "none" nor reach the
		// public comment. The name is withheld from the comment when it is not a valid name.
		if (!Array.isArray(listed) || listed.length === 0 || listed.length > MCP_SERVERS_MAX || new Set(listed).size !== listed.length || listed.some((name) => typeof name !== "string" || !MCP_SERVER_NAME_RE.test(name))) {
			return { refused: "mcp-list-invalid", name: null, why: "the job's run.mcp is not a list of server names the loader accepts" };
		}
		const names = listed;
		let parsed;
		try {
			parsed = read(globalPiDir || "");
		} catch (error) {
			if (!error?.mcpConfig && MCP_TRANSIENT_READ_CODES.has(error?.code)) return { unavailable: error.code };
			return { refused: "mcp-config-invalid", name: null, why: error?.mcpConfig ? "the overlay's mcp.json cannot be read whole" : `the overlay's mcp.json cannot be read (${error?.code ?? "unreadable"})` };
		}
		if (parsed === null) return { refused: "mcp-config-invalid", name: null, why: globalPiDir ? "the overlay holds no mcp.json" : "this deployment has no overlay (PI_GLOBAL_PI_DIR)" };
		const refusedHere = new Map(parsed.refused.map((r) => [r.name, r.problem]));
		for (const name of names) {
			const server = Object.hasOwn(parsed.servers, name) ? parsed.servers[name] : undefined;
			if (!server) return { refused: "mcp-server-unknown", name, why: refusedHere.has(name) ? "the overlay's mcp.json refuses it" : "the overlay's mcp.json does not offer it" };
			if (server.enabled === false) return { refused: "mcp-server-unknown", name, why: "the overlay's mcp.json turns it off" };
		}
		// A forwarded name reaches the job only when the worker holds a value for it (env-allowlist.mjs buildContainerEnv).
		const forwarded = forwardEnv.filter((ref) => typeof hostEnv[ref] === "string" && hostEnv[ref] !== "");
		const mapped = new Set([...Object.keys(job.secrets ?? {}), ...forwarded]);
		let own;
		try {
			own = reserved(job);
		} catch (error) {
			// The overlay models.json read inside `reserved` that may pass on a retry: without it, a custom provider's
			// credential would drop out of the set for this one pickup.
			if (MCP_TRANSIENT_READ_CODES.has(error?.code)) return { unavailable: error.code };
			throw error;
		}
		for (const name of names) {
			for (const ref of parsed.servers[name].refs) {
				if (own.has(ref)) return { refused: "mcp-secret-reserved", name, why: `it references ${ref}, which this deployment uses for the job's own credentials` };
			}
		}
		for (const name of names) {
			for (const ref of parsed.servers[name].refs) {
				if (!mapped.has(ref)) return { refused: "mcp-secret-unmapped", name, why: `it references ${ref}, which the trigger does not pass (run.secrets, or a PI_FORWARD_ENV name the worker holds a value for)` };
			}
		}
		const cut = mcpRouteProblem(parsed.servers, names, new Set(Array.isArray(job.excludeTools) ? job.excludeTools : []), { autoEnableCodemode: parsed.autoEnableCodemode });
		if (cut !== null) return { refused: "mcp-excluded", name: cut.name, why: cut.why };
		if (egress) {
			let list = null;
			let declared = null;
			// The allowlist read that may pass on a retry is retried, like the overlay's; any other failure refuses, since
			// without the list no server outside a declared endpoint can be judged reachable.
			const readList = () => {
				try {
					return allowlist();
				} catch (error) {
					if (MCP_TRANSIENT_READ_CODES.has(error?.code)) throw Object.assign(new Error("transient"), { transient: error.code });
					throw Object.assign(new Error("unreadable"), { unreadable: error?.code ?? "unreadable" });
				}
			};
			try {
				for (const name of names) {
					const server = parsed.servers[name];
					if (server.transport === "http") {
						list ??= readList();
						declared ??= endpoints();
						const refusal = egressRefusalFor(server.url, { allowlist: list, endpoints: declared });
						if (refusal !== null) return { refused: "mcp-egress-unreachable", name, why: refusal };
					} else if (server.packageRunner) {
						list ??= readList();
						const missing = packageRunnerHosts(server.command).filter((host) => allowlistEntryFor(list, host) === null);
						if (missing.length > 0) return { refused: "mcp-package-runner", name, why: `it fetches its server from ${missing.join(" and ")}, which egress-allowlist.conf does not hold` };
					}
				}
			} catch (error) {
				if (error?.transient) return { unavailable: error.transient };
				if (error?.unreadable) return { refused: "mcp-egress-unreachable", name: null, why: `egress-allowlist.conf cannot be read (${error.unreadable})` };
				throw error;
			}
		}
		return { ok: true, document: jobMcpDocument(parsed, names) };
	};
}

/**
 * A server's exposures as pi reads them (`getMcpToolExposure`): an exact tool name first, then the patterns in order,
 * the first that matches winning, else the server's own. So a pattern after `*` never applies, and `*` replaces the
 * default; any exact name and any earlier pattern may still match a tool.
 */
function exposuresOf(server) {
	const own = server.exposure ?? "codemode";
	const entries = Object.entries(server.toolExposure ?? {}).filter(([key]) => !key.startsWith("dispatch_"));
	const tools = entries.filter(([key]) => !key.includes("*")).map(([, value]) => value);
	let base = own;
	for (const [key, value] of entries.filter(([key]) => key.includes("*"))) {
		if (key === "*") {
			base = value;
			break;
		}
		tools.push(value);
	}
	return { own, tools: [base, ...tools] };
}

/**
 * Whether each named server keeps a way in through the tools `excluded` leaves, as pi 1.1.0 routes them: a `direct` tool
 * needs nothing; a `codemode` or `deferred` tool is reached by whichever discovery tool is active, since codemode calls
 * both kinds and tool_search loads both, and pi activates codemode when some server has a codemode tool (and
 * `autoEnableCodemode` is not false) and tool_search when some server has a deferred one; the resource tools take their
 * server's own exposure, and a `hidden` server's resources are never offered. Judged only for what the trigger's
 * exclusions take away: a server the overlay leaves no way in is the overlay's, not this trigger's to be refused for.
 * Returns `{ name, why }` for the first server the exclusions cut off, or null.
 */
export function mcpRouteProblem(servers, names, excluded, { autoEnableCodemode = true } = {}) {
	const routes = (removed) => {
		const all = names.map((name) => exposuresOf(servers[name]));
		const has = (kind) => all.some(({ own, tools }) => own === kind || tools.includes(kind));
		const discovery = (!removed.has("codemode") && autoEnableCodemode !== false && has("codemode")) || (!removed.has("tool_search") && has("deferred"));
		const reach = (exposure) => exposure === "direct" || ((exposure === "codemode" || exposure === "deferred") && discovery);
		const widest = ["direct", "codemode", "deferred"].find((kind) => all.some(({ own }) => own === kind)) ?? "hidden";
		return names.map((name, i) => {
			const { own, tools } = all[i];
			const toolRoute = !removed.has(mcpServerToolPattern(name)) && tools.some(reach);
			// pi registers the resource tools once, with the widest exposure among the servers that offer resources
			// and are not hidden (syncResourceTools), and read_mcp_resource reads any of them. Whether a server lists
			// resources is unknown until it connects, so each one that is not hidden is assumed to.
			const resourceRoute = !removed.has("read_mcp_resource") && own !== "hidden" && reach(widest);
			return toolRoute || resourceRoute;
		});
	};
	const before = routes(new Set());
	const after = routes(excluded);
	const i = names.findIndex((_, k) => before[k] && !after[k]);
	return i < 0 ? null : { name: names[i], why: "run.excludeTools removes every tool that reaches it (its own, the discovery tools that reach them, and read_mcp_resource)" };
}

/**
 * The refusal's public sentence, per reason. Fixed text: the comment posts on the issue, and `why` can name an
 * internal host or a variable, which belong in the worker's log, not in a thread anyone can read.
 */
export const MCP_REFUSAL_COMMENT = Object.freeze({
	"mcp-list-invalid": "the list this job carries is not one the triggers file's loader writes (a service in this deployment may be at another version)",
	"mcp-config-invalid": "this deployment's list of MCP servers (mcp.json in the overlay) cannot be used",
	"mcp-server-unknown": "this deployment does not offer that server",
	"mcp-secret-reserved": "that server would be handed a credential this deployment keeps for the job itself",
	"mcp-secret-unmapped": "a credential that server needs is not passed by this trigger",
	"mcp-excluded": "this trigger's run.excludeTools removes every way the job could reach that server",
	"mcp-egress-unreachable": "the egress policy does not let a job reach that server",
	"mcp-package-runner": "the egress policy does not let a job reach the registry that server is fetched from",
});
