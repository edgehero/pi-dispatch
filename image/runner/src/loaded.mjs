import { owningRoot } from "./packages.mjs";

/**
 * What a job loaded, on its signed exit line (issue #800, INT-RUNNER-EXIT-CODE-PROTOCOL).
 *
 * A failed load only logs and the job carries on, so a flow found nowhere or an extension that threw can exit 0 and read
 * as fine. The runner is the one place that sees what pi really loaded, and it says so here: counts per source, closed
 * words, and only such names as the deployment staged or configured.
 *
 * THE HOSTILE-NAME RULE, the reason for the file's shape. A repository picks its skill and extension names, its paths
 * and the text its extensions throw, and the run record holds no string a repository chose. So through ordinary API use a
 * repository's part is counts and nothing else: every name on the line is either one of the closed words below, an overlay
 * extension's first path segment, or a tool attributed to a staged package or an overlay extension, and each of those two
 * passes a shape check here. Package and server names are not on the line at all: rows are positional, aligned with
 * PI_PACKAGES and PI_MCP_SERVERS, and the worker joins them with what it staged. REJECTED: filtering a list of names at the
 * worker, which would put repository strings on a line a tool can read off the pipe, and trust a filter to take them back out.
 *
 * WHAT THE CHECKS HERE ARE NOT (the OQ-003 residual). A repository extension shares this process, so it can put ANY string
 * on the line: patching `RegExp.prototype.test`, `Array.prototype.map` or `JSON.stringify` is enough, with a source path
 * mutated to read as a package's, and the runner signs what comes out. So the shape checks here cover ordinary API use and
 * no more, and the signature vouches for the runner's channel and not for what is on it. The worker's rebuild is the
 * boundary (worker/src/loaded-record.mjs `rebuildLoaded`): it checks every string it keeps against the same closed patterns,
 * in its own process. What survives that is a token of a closed shape (a tool's name, for which the worker has no list to
 * check against, so it can only narrow what a later chip excludes; pi's version, three dotted numbers) and the counts.
 *
 * Everything here is pure and handed its inputs, so it tests without pi or a container. packages.mjs is the one import,
 * for its segment-safe containment, and it reads no pi.
 */

export const LOADED_VERSION = 1;
/** How far the job got when this was noted. */
export const LOADED_STAGES = Object.freeze(["start", "none", "loader", "session", "ready"]);
/** Where a resource came from. Rows and the flow use these words, the flow adding `none`. */
export const LOADED_TIERS = Object.freeze(["package", "repository", "trigger", "overlay", "other"]);
export const LOADED_FLOW_WORDS = Object.freeze([...LOADED_TIERS, "none"]);
export const LOADED_MCP_STATES = Object.freeze(["connected", "failed", "timeout", "pending", "disabled"]);
/** Each row's positions: a `packages` row and a `tiers` row alike, so one reader reads both. */
export const LOADED_ROW = Object.freeze(["extensions", "skills", "prompts", "themes", "tools", "failed", "dropped", "shadowed"]);
const SLOT = Object.freeze(Object.fromEntries(LOADED_ROW.map((name, index) => [name, index])));
/**
 * The caps, each of which raises `cut` rather than dropping silently. `tiers` is exempt: it keeps true totals. The worker
 * reads a total past 999,999 as `invalid` (`LOADED_COUNT_MAX`), and clamping one here would only hide that behind a false count.
 */
export const LOADED_MAX_PACKAGES = 16;
export const LOADED_MAX_SERVERS = 8;
export const LOADED_MAX_OVERLAY_NAMES = 16;
export const LOADED_MAX_EXT_TOOLS = 24;
/** A package row's resource counts, then its problem counts, then a tool count on `mcp` and `tools.active`. */
export const LOADED_MAX_COUNT = 999;
export const LOADED_MAX_PROBLEM_COUNT = 99;
export const LOADED_MAX_TOOL_COUNT = 9999;
const FIRST_PROBLEM_SLOT = SLOT.failed;
/** A first path segment: never `.` or `..`, which are a path's parts and name no extension, though the charset holds them. */
export const LOADED_OVERLAY_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,48}$/;
export const LOADED_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/**
 * The tools the job's own factories can register, by name: the only tools `tools.job` may name, so `active` adds up for a
 * reader who sees pi's own and the extensions' beside it. Written out rather than imported, because the modules that hold
 * these names read pi and this one reads none; a test holds the list to each of those constants. Not the servers' direct
 * `mcp__` tools: those are the operator's servers' and a server's row counts them.
 */
export const LOADED_JOB_TOOLS = Object.freeze([
	"report_progress",
	"await_human_input",
	"request_approval",
	"subagent",
	"codemode",
	"tool_search",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"query_logs",
	"decide",
	"board_write",
	"read_question",
	"list_repository",
	"read_repository",
	"read_standing_answer",
	"read_reply",
	"list_replies",
	"submit_answer_draft",
]);
/** pi's own version constant, read as a version only: pi falls back to this spelling when it cannot read its package. */
const PI_VERSION_UNKNOWN = "0.0.0";
/**
 * Three dotted numbers, the worker's own rule (`PI_VERSION_RE`, worker/src/loaded-record.mjs, held equal by a test there).
 * A pre-release reads as null here, which says only that the job's pi did not name itself; written out, it would turn this
 * whole line `invalid` at the worker, because a `-...` tail is free text.
 */
export const PI_VERSION_RE = /^\d+\.\d+\.\d+$/;
const PI_VERSION_MAX = 32;
/** The prefix on a tool's source path when pi itself provides it (source-info.js BUILTIN_PATH_PREFIX, pinned). */
const BUILTIN_TOOL_PREFIX = "builtin:";
/** The prefix on the source path of a factory the job itself passed (`tierOf` reads these as no tier's). */
const INLINE_PATH_PREFIX = "<inline:";

/**
 * The tier of a path, by containment, or null for what no tier owns: no path, or `<inline:...>`, a factory the job itself
 * passed (the job's MCP, its tools), which no source chose. Roots are tested most specific first, because a staged
 * package sits under the overlay and an overlay-first test would call a package's extension the operator's. Reuses
 * `owningRoot`, so `/opt/pi-global/packages/tool` never claims a path under `/opt/pi-global/packages/tools`.
 */
export function tierOf(path, { packages = [], jobPi, triggerSkills, overlay, workspace } = {}) {
	if (typeof path !== "string" || path === "" || path.startsWith(INLINE_PATH_PREFIX)) return null;
	// Containment is by prefix, so a path that climbs reads as the root it climbs out of. pi normalises what it hands back at
	// the pin and nothing pins that, so a segment that climbs is no tier's.
	if (path.split("/").includes("..")) return "other";
	const ordered = [...packages.map((root) => [root, "package"]), [jobPi, "repository"], [triggerSkills, "trigger"], [overlay, "overlay"], [workspace, "repository"]];
	const owner = owningRoot(path, ordered.map(([root]) => root));
	return owner === null ? "other" : ordered.find(([root]) => root === owner)[1];
}

/** The folder under the overlay its extensions load from, as the loader's own constant builds it. */
const overlayExtensionsOf = (roots) => `${roots.overlay}/extensions`;

/** A path's first segment under `dir`, or null when `dir` does not hold it, or when the rest of it climbs or is a path's own part. The name an operator's overlay knows it by. */
function firstSegmentUnder(path, dir) {
	if (typeof path !== "string" || !path.startsWith(`${dir}/`)) return null;
	const segments = path.slice(dir.length + 1).split("/");
	return segments.includes("..") || segments.includes(".") ? null : segments[0];
}

/**
 * Tee the log the loader writes through, keeping what the record needs from its load findings, so the two cannot
 * disagree: an extension is failed on the record exactly when the log says so. Of each entry only its `root` and `kind`
 * are kept, plus, for an overlay entry alone, the first path segment. Those lines name repository paths, and that stops
 * at this function. One entry per extension, however many lines name it: pi reports a tool conflict per name, and one
 * extension with two conflicts is one failed extension. A throw in here never reaches the log's own write.
 */
export function createLoadTee(log, { overlayExtensions } = {}) {
	const failures = new Map();
	const drops = new Map();
	const capture = (event, fields) => {
		const entries = Array.isArray(fields?.extensions) ? fields.extensions : [];
		if (event === "extension_load_failed") {
			for (const { entry, root, kind } of entries) {
				failures.set(`${root} ${entry}`, { root: root ?? null, kind, ...(root === overlayExtensions && typeof entry === "string" ? { name: entry.split("/")[0] } : {}) });
			}
		} else if (event === "extension_dropped") {
			for (const { name, root } of entries) drops.set(`${root} ${name}`, { root: root ?? null });
		} else if (event === "overlay_extensions_withheld") {
			// The whole overlay held back, so a job that looks like it has none says something failed.
			failures.set(`${fields.root} withheld`, { root: fields.root ?? null, kind: "withheld" });
		}
	};
	return {
		log(event, fields) {
			try {
				capture(event, fields);
			} catch {
				// the record may be short of one line; the log is not
			}
			log(event, fields);
		},
		failures: () => [...failures.values()],
		drops: () => [...drops.values()],
	};
}

const emptyRow = () => LOADED_ROW.map(() => 0);

/**
 * `facts` as the line's `loaded` field, its largest form (`fitLoaded` makes the two smaller ones). Holds only what its
 * stage knows: `start` and `none` say pi and no more, because a `failed: 0` before anything loaded would be a claim;
 * `loader` adds the tiers and the flow; `session` and `ready` add the tools and the servers.
 *
 * `flow` is absent when the job names none, and `none` when it names one that loaded in no tier. Those two read
 * differently because the second is the failure this field exists to surface.
 */
export function buildLoaded({ at, pi, roots, flow = null, extensions = [], skills = [], prompts = [], themes = [], failures = [], drops = [], shadowed = [], tools = null, active = [], ownNames = [], mcp = null }) {
	const cut = { form: "full", packages: 0, servers: 0, names: 0, counts: 0 };
	const out = { v: LOADED_VERSION, at, pi: typeof pi === "string" && pi !== PI_VERSION_UNKNOWN && pi.length <= PI_VERSION_MAX && PI_VERSION_RE.test(pi) ? pi : null };
	if (roots === undefined) return { ...out, cut };

	const packages = roots.packages ?? [];
	const tiers = Object.fromEntries(LOADED_TIERS.map((tier) => [tier, emptyRow()]));
	const rows = packages.map(() => emptyRow());
	const count = (path, slot) => {
		const tier = tierOf(path, roots);
		if (tier === null) return;
		tiers[tier][slot]++;
		if (tier === "package") rows[packages.indexOf(owningRoot(path, packages))][slot]++;
	};
	for (const path of extensions) count(path, SLOT.extensions);
	for (const skill of skills) count(skill?.filePath, SLOT.skills);
	for (const path of prompts) count(path, SLOT.prompts);
	for (const path of themes) count(path, SLOT.themes);
	// A log line's root is one of the loader's fixed roots, or null for an entry none of them holds: that is `other`.
	const countRoot = (root, slot) => (typeof root === "string" ? count(root, slot) : tiers.other[slot]++);
	for (const { root } of failures) countRoot(root, SLOT.failed);
	for (const { root } of drops) countRoot(root, SLOT.dropped);
	for (const collision of shadowed) count(collision?.winnerPath, SLOT.shadowed);

	if (typeof flow === "string" && flow !== "") {
		const skill = skills.find((candidate) => candidate?.name === flow);
		out.flow = skill ? (tierOf(skill.filePath, roots) ?? "other") : "none";
		if (out.flow === "package") out.flowPackage = packages.indexOf(owningRoot(skill.filePath, packages));
	}

	// The overlay's own names. Failed ones first: past the cap, what went wrong is what a person needs named.
	const overlayDir = overlayExtensionsOf(roots);
	const namesFrom = (found) => {
		const kept = [];
		for (const name of new Set(found)) {
			if (LOADED_OVERLAY_NAME_RE.test(name)) kept.push(name);
			else cut.names++;
		}
		return kept;
	};
	const failedNames = namesFrom(failures.filter((failure) => typeof failure.name === "string").map((failure) => failure.name));
	const loadedNames = namesFrom(extensions.map((path) => firstSegmentUnder(path, overlayDir)).filter((name) => name !== null));
	const keptFailed = failedNames.slice(0, LOADED_MAX_OVERLAY_NAMES);
	const keptLoaded = loadedNames.slice(0, LOADED_MAX_OVERLAY_NAMES - keptFailed.length);
	cut.names += failedNames.length - keptFailed.length + loadedNames.length - keptLoaded.length;

	const toolRows = (tools ?? []).filter((tool) => typeof tool?.path === "string");
	for (const tool of toolRows) if (!tool.path.startsWith(BUILTIN_TOOL_PREFIX)) count(tool.path, SLOT.tools);

	const clamp = (value, max) => {
		if (value <= max) return value;
		cut.counts++;
		return max;
	};
	out.packages = rows.slice(0, LOADED_MAX_PACKAGES).map((row) => row.map((value, slot) => clamp(value, slot < FIRST_PROBLEM_SLOT ? LOADED_MAX_COUNT : LOADED_MAX_PROBLEM_COUNT)));
	cut.packages = Math.max(0, rows.length - LOADED_MAX_PACKAGES);
	out.tiers = tiers;
	out.overlay = { loaded: keptLoaded, failed: keptFailed };

	if (mcp !== null) {
		out.mcp = mcp.slice(0, LOADED_MAX_SERVERS).map(([state, count]) => [state, clamp(count, LOADED_MAX_TOOL_COUNT)]);
		cut.servers = Math.max(0, mcp.length - LOADED_MAX_SERVERS);
	}
	if (tools !== null) {
		const builtin = new Set(toolRows.filter((tool) => tool.path.startsWith(BUILTIN_TOOL_PREFIX)).map((tool) => tool.name));
		const own = new Set(ownNames);
		// By name AND by source, as `own` is: another extension's tool of a job tool's name is not the job's.
		const job = new Set(toolRows.filter((tool) => tool.path.startsWith(INLINE_PATH_PREFIX) && LOADED_JOB_TOOLS.includes(tool.name)).map((tool) => tool.name));
		out.tools = { active: clamp(active.length, LOADED_MAX_TOOL_COUNT), own: active.filter((name) => own.has(name) && builtin.has(name)), job: active.filter((name) => job.has(name)) };
		out.extTools = extensionTools({ tools: toolRows, roots, overlayNames: keptLoaded, cut });
	}
	out.cut = cut;
	return out;
}

/**
 * The names of the tools a staged package or an overlay extension brought, for a later chip that excludes one:
 * `{ p: [[row, ...names]], o: [[overlayIndex, ...names]] }`, by source and sorted, so the same job writes the same bytes.
 * `row` is the position in PI_PACKAGES and `overlayIndex` in `overlay.loaded`. A repository's tools are counts only, by
 * the rule at the top of this file, and never reach here. A name that fails the shape, belongs to an overlay name the
 * cap cut, or lies past the overall cap is counted in `cut.names`: the worker cannot be handed half an answer unsaid.
 */
function extensionTools({ tools, roots, overlayNames, cut }) {
	const packages = roots.packages ?? [];
	const overlayDir = overlayExtensionsOf(roots);
	const bySource = { p: new Map(), o: new Map() };
	for (const { name, path } of tools) {
		const tier = tierOf(path, roots);
		let side;
		let index;
		if (tier === "package") {
			side = bySource.p;
			index = packages.indexOf(owningRoot(path, packages));
		} else if (tier === "overlay" && firstSegmentUnder(path, overlayDir) !== null) {
			side = bySource.o;
			index = overlayNames.indexOf(firstSegmentUnder(path, overlayDir));
		} else {
			continue;
		}
		if (index < 0 || typeof name !== "string" || !LOADED_TOOL_NAME_RE.test(name)) {
			cut.names++;
			continue;
		}
		if (!side.has(index)) side.set(index, []);
		side.get(index).push(name);
	}
	let room = LOADED_MAX_EXT_TOOLS;
	const rowsOf = (side) => {
		const rows = [];
		for (const index of [...side.keys()].sort((a, b) => a - b)) {
			const names = side.get(index).sort();
			const kept = names.slice(0, room);
			room -= kept.length;
			cut.names += names.length - kept.length;
			if (kept.length > 0) rows.push([index, ...kept]);
		}
		return rows;
	};
	return { p: rowsOf(bySource.p), o: rowsOf(bySource.o) };
}

/**
 * The field's three forms, largest first, for the writer to pick from by measuring the line (exit-line.mjs). Tool names
 * go first: compact keeps what a person needs to know whether the run was fine and loses what names things.
 *   - full: everything;
 *   - compact: no package rows, no overlay names, no own or job tools, no extension tools;
 *   - minimal: v, at, pi, flow, the failed and dropped totals, and how many servers failed or timed out.
 * Each says which it is in `cut.form`.
 */
export function fitLoaded(loaded) {
	const { packages: _packages, overlay: _overlay, extTools: _extTools, tools, cut, ...kept } = loaded;
	const compact = { ...kept, ...(tools ? { tools: { active: tools.active } } : {}), cut: { ...cut, form: "compact" } };
	const total = (slot) => Object.values(loaded.tiers).reduce((sum, row) => sum + row[slot], 0);
	const minimal = {
		v: loaded.v,
		at: loaded.at,
		pi: loaded.pi,
		...(loaded.flow !== undefined ? { flow: loaded.flow } : {}),
		...(loaded.tiers ? { failed: total(SLOT.failed), dropped: total(SLOT.dropped) } : {}),
		...(loaded.mcp ? { mcpBad: loaded.mcp.filter(([state]) => state === "failed" || state === "timeout").length } : {}),
		cut: { ...cut, form: "minimal" },
	};
	return [loaded, compact, minimal];
}

/**
 * One job's record as it grows: each stage adds its facts and notes the field again, so whatever ends the run next finds
 * the latest. `facts` is a thunk, and nothing it does can reach the job: a throw here (a repository extension shares this
 * process and can leave pi's objects in any state) keeps the last note and says so by name, because a job must never
 * stop or change its exit over the record of what it loaded.
 */
export function createLoadedRecorder({ pi, note, log, build = buildLoaded }) {
	let known = { pi };
	return {
		record(at, facts = () => ({})) {
			try {
				known = { ...known, ...facts(), at };
				note(build(known));
			} catch {
				log("loaded_unavailable", { at });
			}
		},
	};
}
