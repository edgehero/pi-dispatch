import { imageRefProblem } from "./image-ref.mjs";
import { MCP_SERVER_NAME_RE } from "./mcp-config.mjs";
import { EXACT_VERSION_RE, NPM_NAME_RE } from "./package-names.mjs";

/**
 * What a run loaded, on its record (issue #800, INT-RUN-HISTORY-FILE-CONTRACT's `loaded`). The one place in the worker that
 * reads the runner's `loaded` field (INT-RUNNER-EXIT-CODE-PROTOCOL), so a change to that field changes this file alone.
 *
 * THE MAC DOES NOT VOUCH FOR THE CONTENT, and that is the whole reason this file exists rather than a copy of the field.
 * A repository's extension runs in the runner's process and can patch `JSON.stringify`, `RegExp.prototype.test` or
 * `Array.prototype.map` before the line is signed, so a line that verifies can hold ANY string, and the runner's own shape
 * checks cover ordinary API use and no more (the OQ-003 residual). THIS FILE IS THE BOUNDARY: every string kept is checked
 * here, in the worker's process, against a closed list, a closed pattern or what the worker itself knows (the packages it
 * handed over, the overlay's folder, the trigger's servers, pi's own tool names), and any one violation makes the whole
 * field `runner: "invalid"`: half of a line that lied about something is not a fact. What the worker knows by itself stays
 * either way. REJECTED: dropping only the bad part, which would let a forged line choose what the record is silent about. The one
 * exception is a tool's name the job's own redactor would change, withheld alone and counted (`readExtTools` says why).
 *
 * WHAT SURVIVES IT, said plainly. Three things the line alone says, which the worker holds to a shape because it has nothing
 * to compare them with, so a repository extension in the same process can forge each:
 *   - an extension tool's name, `LOADED_TOOL_NAME_RE`: no space, no markup, no path, though `ignore-all-previous` passes. A
 *     chip made from such a name can only narrow what a job has, while a wrong one refuses the job.
 *   - `pi`, `PI_VERSION_RE`: three dotted numbers, at most 32 characters. Digits, then, and no word.
 *   - every count, an integer up to `LOADED_COUNT_MAX`. It can be wrong, and a forger can spell digits in a run of them.
 * A `pi` holding one of the job's secrets or a known token's shape is refused anyway, and such a tool name is withheld (`known.redact`); a secret
 * transformed, or cut across two values, or spelled in counts, is not caught, as everywhere the redactor stands (redact-secrets.mjs,
 * NOT DEFENDED). Every other string kept is a closed word, a folder listing's name, or the worker's own: a package's name and
 * version off its stage manifest, a server's name off the trigger, the image, `leftOut` and the base commit. A package's version
 * keeps its pre-release tail because the line cannot choose it; it picks a row by position and the worker writes what is in
 * that row.
 *
 * Never read to decide anything: a display, as `resources` is.
 *
 * Imports no spawn, no Valkey and no triggers file parser, because `run-history.mjs`, which the admin loads inside pi,
 * imports this. `known.ownTools` is therefore handed in by the one caller that has `EXCLUDABLE_TOOL_NAMES`.
 */

/** This field's own shape version on the record. A new key leaves it alone, as the record's own `v` is left alone. */
export const LOADED_RECORD_VERSION = 1;
/** The version of the runner's field this file can read. */
export const LOADED_LINE_VERSION = 1;
/**
 * Whether the runner said: it said and it held up (`reported`), it never said (`absent`), it said and it did not hold up
 * (`invalid`), or it had something to say and there was no room for it (`cut`): on its line, or on the record past
 * `LOADED_RECORD_MAX_BYTES`. `cut` is not `absent`: the job got as far as noting what it loaded, and a reader saying "an older
 * release wrote this" would be wrong about the run.
 */
export const LOADED_RUNNER_WORDS = Object.freeze(["reported", "absent", "invalid", "cut"]);
/** The most the field may take on a record, serialized. Measured against every cap in the tests. */
export const LOADED_RECORD_MAX_BYTES = 16 * 1024;
/**
 * The largest count the field may hold, anywhere: past it the whole field is a violation. A package row, a server and `active`
 * have tighter clamps below; this bounds what has none (`tiers`, which keep true totals, `cut`'s counts and the `problems`
 * totals). A million of anything loaded is no job's, and it is what makes the worst case above a number rather than sixteen
 * digits a slot. The runner clamps none of these: a job past it reads as `invalid`, the word for a line that cannot be believed.
 */
export const LOADED_COUNT_MAX = 999_999;
/**
 * `pi` on the line and `imagePi` from the image: `usage.piAi`'s rule (run-history.mjs). REJECTED: `EXACT_VERSION_RE`, whose
 * `-...` and `+...` tails are free text, so a forged line read as `reported` with `pi: "1.5.0-ghs0123456789abcdef"`, a job's
 * own token, and `1.5.0-ignore.all.previous-instr` beside it. A pi pin is an exact release (`CONST-PI-VERSION-PINNED`), and the
 * runner holds to this too, so a genuine line never trips it.
 */
export const PI_VERSION_RE = /^\d+\.\d+\.\d+$/;

// The runner's vocabulary and caps (image/runner/src/loaded.mjs, which the worker cannot import because it ships in the
// job image), restated here and held to the source by worker/test/loaded-record.test.mjs.
export const LOADED_STAGES = Object.freeze(["start", "none", "loader", "session", "ready"]);
export const LOADED_TIERS = Object.freeze(["package", "repository", "trigger", "overlay", "other"]);
export const LOADED_FLOW_WORDS = Object.freeze([...LOADED_TIERS, "none"]);
export const LOADED_MCP_STATES = Object.freeze(["connected", "failed", "timeout", "pending", "disabled"]);
export const LOADED_ROW = Object.freeze(["extensions", "skills", "prompts", "themes", "tools", "failed", "dropped", "shadowed"]);
export const LOADED_FORMS = Object.freeze(["full", "compact", "minimal"]);
export const LOADED_MAX_PACKAGES = 16;
export const LOADED_MAX_SERVERS = 8;
export const LOADED_MAX_OVERLAY_NAMES = 16;
export const LOADED_MAX_EXT_TOOLS = 24;
export const LOADED_MAX_COUNT = 999;
export const LOADED_MAX_PROBLEM_COUNT = 99;
export const LOADED_MAX_TOOL_COUNT = 9999;
export const LOADED_OVERLAY_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,48}$/;
export const LOADED_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const LOADED_JOB_TOOLS = Object.freeze(["report_progress", "await_human_input", "request_approval", "subagent", "codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "query_logs", "decide", "board_write", "read_question", "list_repository", "read_repository", "read_standing_answer", "read_reply", "list_replies", "submit_answer_draft"]);

/** Where a row's counts stop being a resource count, whose cap is LOADED_MAX_COUNT, and become a problem count. */
const FIRST_PROBLEM_SLOT = LOADED_ROW.indexOf("failed");
const FAILED_SLOT = FIRST_PROBLEM_SLOT;
const DROPPED_SLOT = LOADED_ROW.indexOf("dropped");
/** The longest reference a runtime takes, near enough: a name, a tag and a digest. A bound for the record, not a rule. */
const IMAGE_MAX = 512;
/** `sha256:` and 64 hex: `normalizeImageId` gives every runtime's id this one spelling (image-preflight.mjs). */
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/**
 * The commit a run's workspace was prepared at, in full, sha1 or sha256: what `validPin` (prepare-github.mjs) holds a pin to
 * and what `git rev-parse` prints. Exported because a surface that builds a link from it holds it to this same rule, so a
 * link's words and its address cannot disagree about which records name a commit. REJECTED: a short hash, which a forge may
 * not resolve or may resolve to another commit as the repository grows.
 */
export const LOADED_BASE_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PI_VERSION_MAX = 32;
/** A package's name and version as `parsePackageCanary` bounds them. */
const PACKAGE_NAME_MAX = 214;
const PACKAGE_VERSION_MAX = 128;
/** An `excludeTools` entry: a tool's name, or a server's pattern (`mcp__<server>__*`, triggers.mjs `mcpServerToolPattern`). */
const LEFT_OUT_TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}\*?$/;
/** Pi's own, the MCP tools and a pattern per server of a trigger's at most eight (triggers.mjs): far under this. */
const LEFT_OUT_TOOLS_MAX = 32;
/** How many own tools a line may name, a bound on a list `known.ownTools` then judges by name. */
const OWN_TOOLS_MAX = 16;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value, max = LOADED_COUNT_MAX) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const isPiVersion = (value) => typeof value === "string" && value.length <= PI_VERSION_MAX && PI_VERSION_RE.test(value);
/** Whether the job's own redactor would change this: it holds a value of the job's, or a known token's shape. */
const holdsSecret = (text, redact) => typeof redact === "function" && redact(text) !== text;
const isToolName = (value) => typeof value === "string" && LOADED_TOOL_NAME_RE.test(value);
const isOverlayName = (value) => typeof value === "string" && LOADED_OVERLAY_NAME_RE.test(value);
/** A package row's slot held to its clamp: a resource count, then a problem count. */
const slotMax = (slot) => (slot < FIRST_PROBLEM_SLOT ? LOADED_MAX_COUNT : LOADED_MAX_PROBLEM_COUNT);
const rowFields = (row) => Object.fromEntries(LOADED_ROW.map((name, slot) => [name, row[slot]]));

/** A package as the worker knows it, or null: the two facts it joins onto a positional row. */
function knownPackage(value) {
	if (!isObject(value)) return null;
	const { name, version } = value;
	if (typeof name !== "string" || name.length > PACKAGE_NAME_MAX || !NPM_NAME_RE.test(name)) return null;
	if (typeof version !== "string" || version.length > PACKAGE_VERSION_MAX || !EXACT_VERSION_RE.test(version)) return null;
	return { name, version };
}

/**
 * What the worker itself left out of this job, in its own words, because the runner cannot tell: it reads no `run.packages`
 * and sees only what reached it, so `"packages": false` and nothing staged read the same from inside (env-allowlist.mjs).
 * `overlayExtensions` is this job's overlay switch as the worker was built with it: the host's `PI_GLOBAL_ALLOW_EXTENSIONS=0`,
 * or a canary replay, which runs every job with the overlay shut (canary-runtime.mjs). Not the value handed to a restricted
 * job, which is forced off for it alone: that is `restricted`, a different statement with a different fix.
 * `tools` keeps what passes the shape. The loader validated the field, so a name failing here is a hand-built job's.
 */
export function leftOutOf(job, { allowGlobalExtensions = true } = {}) {
	const tools = Array.isArray(job?.excludeTools) ? [...new Set(job.excludeTools.filter((name) => typeof name === "string" && LEFT_OUT_TOOL_RE.test(name)))].slice(0, LEFT_OUT_TOOLS_MAX) : [];
	return { tools, packages: job?.packages === false, overlayExtensions: allowGlobalExtensions === false, restricted: Boolean(job?.watch || job?.answerDraft || job?.questionGrouping) };
}

/** Whether `leftOut` says anything: a run with no line and nothing left out has no worker fact worth a key of its own. */
export function leavesOut(leftOut) {
	return isObject(leftOut) && (leftOut.packages === true || leftOut.overlayExtensions === true || leftOut.restricted === true || (Array.isArray(leftOut.tools) && leftOut.tools.length > 0));
}

/** The field with no runner part: what the worker knows when the runner said nothing, or nothing that held up. */
function workerOnly(runner, { image = null, imageDigest = null, imagePi = null, leftOut = null } = {}) {
	return { v: LOADED_RECORD_VERSION, runner, at: null, cut: null, image, imageDigest, imagePi, pi: null, flow: null, sources: [], mcp: null, tools: null, problems: null, leftOut };
}

/**
 * What the sink hands on for a line that says `loadedCut: true` and holds no `loaded`: the runner noted one and the line had
 * no room for even its smallest form. One object, compared by identity, so nothing a line writes can be taken for it.
 */
export const LOADED_LINE_CUT = Object.freeze({ cut: true });

/** Raised inside `readLine` with a fixed word, never line text, and caught by `rebuildLoaded`. */
class LineViolation extends Error {
	constructor(word) {
		super(word);
		this.word = word;
	}
}
const refuse = (word) => {
	throw new LineViolation(word);
};

function readCut(raw) {
	if (!isObject(raw) || !LOADED_FORMS.includes(raw.form)) refuse("cut");
	for (const key of ["packages", "servers", "names", "counts"]) if (!isCount(raw[key])) refuse("cut");
	return { form: raw.form, packages: raw.packages, servers: raw.servers, names: raw.names, counts: raw.counts };
}

function readFlow(raw, form, packages) {
	if (raw.flow === undefined) {
		if (raw.flowPackage !== undefined) refuse("flow");
		return null;
	}
	if (!LOADED_FLOW_WORDS.includes(raw.flow)) refuse("flow");
	if (raw.flow !== "package") {
		if (raw.flowPackage !== undefined) refuse("flow");
		return { tier: raw.flow, package: null };
	}
	// The minimal form drops which package and keeps that it was one. The worker holds the whole list past the row cap.
	if (raw.flowPackage === undefined && form === "minimal") return { tier: "package", package: null };
	if (!isCount(raw.flowPackage) || raw.flowPackage >= packages.length) refuse("flow-package");
	return { tier: "package", package: packages[raw.flowPackage]?.name ?? null };
}

function readTiers(raw) {
	if (!isObject(raw)) refuse("tiers");
	const out = {};
	for (const tier of LOADED_TIERS) {
		const row = raw[tier];
		if (!Array.isArray(row) || row.length !== LOADED_ROW.length || !row.every((value) => isCount(value))) refuse("tiers");
		out[tier] = row;
	}
	return out;
}

/** The rows, as many as the worker handed over up to the cap, and the cap's count agreeing with the list. */
function readPackageRows(raw, packages) {
	if (!Array.isArray(raw) || raw.length !== Math.min(packages.length, LOADED_MAX_PACKAGES)) refuse("packages-length");
	for (const row of raw) {
		if (!Array.isArray(row) || row.length !== LOADED_ROW.length || !row.every((value, slot) => isCount(value, slotMax(slot)))) refuse("packages-row");
	}
	return raw;
}

/** Each name a first path segment the overlay's folder really holds: a name not on this disk came from nowhere the worker staged. */
function readOverlay(raw, onDisk) {
	if (!isObject(raw) || !Array.isArray(raw.loaded) || !Array.isArray(raw.failed)) refuse("overlay");
	if (raw.loaded.length + raw.failed.length > LOADED_MAX_OVERLAY_NAMES) refuse("overlay");
	for (const name of [...raw.loaded, ...raw.failed]) {
		if (!isOverlayName(name)) refuse("overlay-name");
		if (!onDisk.has(name)) refuse("overlay-not-on-disk");
	}
	return { loaded: raw.loaded, failed: raw.failed };
}

/**
 * `extTools` by source: `[[index, ...names]]`, each index in range once and every name in the shape, within the overall
 * cap. The shape admits a bare token (`ghp_...` is one word of letters and digits), and an extension in the signer's process
 * can read the job's environment, so a name holding one of this job's secrets or a known token's shape never reaches the
 * record: `redact` is the job's own redactor, the worker's only way to know a value when it sees one.
 *
 * Such a name is WITHHELD alone, and counted, where every other check here voids the field, because it is no sign of a lie. The
 * redactor takes every env value outside the structural allowlist for a secret (`NON_SECRET_ENV_KEYS`, inverted on purpose), so
 * `SEARCH_INDEX=docs_search` forwarded through `PI_FORWARD_ENV`, beside a staged package that registers `docs_search`, read every
 * run of that trigger as `invalid`, all its counts and problems lost, with nothing forged. A forged line gains nothing from this:
 * it could leave any name off anyway, and the row's count still says how many there were.
 */
function readExtTools(raw, packageCount, overlayCount, redact) {
	if (!isObject(raw) || !Array.isArray(raw.p) || !Array.isArray(raw.o)) refuse("ext-tools");
	let total = 0;
	let withheld = 0;
	const side = (rows, limit) => {
		const out = new Map();
		for (const row of rows) {
			if (!Array.isArray(row) || row.length < 2) refuse("ext-tools");
			const [index, ...names] = row;
			if (!isCount(index) || index >= limit || out.has(index)) refuse("ext-tools-index");
			if (!names.every(isToolName)) refuse("ext-tools-name");
			total += names.length;
			const kept = names.filter((name) => !holdsSecret(name, redact));
			withheld += names.length - kept.length;
			out.set(index, kept);
		}
		return out;
	};
	const p = side(raw.p, packageCount);
	const o = side(raw.o, overlayCount);
	if (total > LOADED_MAX_EXT_TOOLS) refuse("ext-tools-cap");
	return { p, o, withheld };
}

function readMcp(raw, servers) {
	if (!Array.isArray(raw) || raw.length !== Math.min(servers.length, LOADED_MAX_SERVERS)) refuse("mcp-length");
	return raw.map((row, index) => {
		if (!Array.isArray(row) || row.length !== 2 || !LOADED_MCP_STATES.includes(row[0]) || !isCount(row[1], LOADED_MAX_TOOL_COUNT)) refuse("mcp-row");
		const name = servers[index];
		return { name: typeof name === "string" && MCP_SERVER_NAME_RE.test(name) ? name : null, state: row[0], tools: row[1] };
	});
}

function readTools(raw, form, ownTools) {
	if (!isObject(raw) || !isCount(raw.active, LOADED_MAX_TOOL_COUNT)) refuse("tools");
	if (form === "compact") return { active: raw.active, own: null, job: null };
	if (!Array.isArray(raw.own) || raw.own.length > OWN_TOOLS_MAX || new Set(raw.own).size !== raw.own.length || !raw.own.every((name) => ownTools.has(name))) refuse("tools-own");
	if (!Array.isArray(raw.job) || new Set(raw.job).size !== raw.job.length || !raw.job.every((name) => LOADED_JOB_TOOLS.includes(name))) refuse("tools-job");
	return { active: raw.active, own: raw.own, job: raw.job };
}

const totalOf = (tiers, slot) => Object.values(tiers).reduce((sum, row) => sum + row[slot], 0);
const badServers = (mcp) => (mcp === null ? null : mcp.filter((row) => row.state === "failed" || row.state === "timeout").length);

/** The sources a tiers-only line can say: one unnamed package row of true totals, and the rest of the tiers. */
function tierSources(tiers, { packageRows = null, overlay = null } = {}) {
	const out = packageRows ?? [{ tier: "package", name: null, version: null, ...rowFields(tiers.package), toolNames: null }];
	out.push({ tier: "overlay", names: overlay?.names ?? null, failedNames: overlay?.failedNames ?? null, ...rowFields(tiers.overlay), namedTools: overlay?.namedTools ?? null });
	for (const tier of ["repository", "trigger", "other"]) out.push({ tier, ...rowFields(tiers[tier]) });
	return out;
}

/** The line as the record's runner part, or a thrown LineViolation with a fixed word. */
function readLine(raw, known) {
	if (!isObject(raw)) refuse("not-an-object");
	if (raw.v !== LOADED_LINE_VERSION) refuse("version");
	if (!LOADED_STAGES.includes(raw.at)) refuse("stage");
	if (raw.pi !== null && !isPiVersion(raw.pi)) refuse("pi");
	// A numeric token passes the shape: digits are all it has, and the job's own value is still the one thing it may not be.
	if (raw.pi !== null && holdsSecret(raw.pi, known?.redact)) refuse("pi-secret");
	const cut = readCut(raw.cut);
	const packages = (Array.isArray(known?.packages) ? known.packages : []).map(knownPackage);
	const servers = Array.isArray(known?.servers) ? known.servers : [];
	const early = raw.at === "start" || raw.at === "none";
	const live = raw.at === "session" || raw.at === "ready";
	const shownCut = cut.form === "full" && cut.packages === 0 && cut.servers === 0 && cut.names === 0 && cut.counts === 0 ? null : cut;
	const runner = { at: raw.at, cut: shownCut, pi: raw.pi, flow: null, sources: [], mcp: null, tools: null, problems: null };
	if (early) {
		// Those stages say the runner's version and no more: a count before anything loaded would be a claim.
		if (raw.tiers !== undefined || raw.flow !== undefined) refuse("early-facts");
		return runner;
	}
	// Every form keeps `cut`, and each of its two list counts agrees with the list the worker handed over.
	if (cut.packages !== Math.max(0, packages.length - LOADED_MAX_PACKAGES)) refuse("packages-cut");
	if (live && cut.servers !== Math.max(0, servers.length - LOADED_MAX_SERVERS)) refuse("servers-cut");
	runner.flow = readFlow(raw, cut.form, packages);

	if (cut.form === "minimal") {
		if (!isCount(raw.failed) || !isCount(raw.dropped)) refuse("minimal");
		if (live ? !isCount(raw.mcpBad, LOADED_MAX_SERVERS) : raw.mcpBad !== undefined) refuse("minimal");
		runner.problems = { failed: raw.failed, dropped: raw.dropped, mcp: live ? raw.mcpBad : null };
		return runner;
	}

	const tiers = readTiers(raw.tiers);
	if (live) {
		runner.mcp = readMcp(raw.mcp, servers);
		runner.tools = readTools(raw.tools, cut.form, known?.ownTools instanceof Set ? known.ownTools : new Set(known?.ownTools ?? []));
	} else if (raw.mcp !== undefined || raw.tools !== undefined) {
		refuse("stage-facts");
	}
	const failed = totalOf(tiers, FAILED_SLOT);
	const dropped = totalOf(tiers, DROPPED_SLOT);
	// Each tier held and their sum need not: a total past the bound is the same violation as a count past it.
	if (!isCount(failed) || !isCount(dropped)) refuse("tiers-total");
	runner.problems = { failed, dropped, mcp: badServers(runner.mcp) };
	if (cut.form === "compact") {
		runner.sources = tierSources(tiers);
		return runner;
	}

	const rows = readPackageRows(raw.packages, packages);
	const overlay = readOverlay(raw.overlay, new Set(Array.isArray(known?.overlayExtensions) ? known.overlayExtensions : []));
	const extTools = live ? readExtTools(raw.extTools, packages.length, overlay.loaded.length, known?.redact) : { p: new Map(), o: new Map(), withheld: 0 };
	// A package past the row cap can still name tools: the line indexes the worker's whole list. It has no row to hold them
	// here, so they are counted as cut, the runner's own word for a name the record does not keep, as a withheld name is.
	const rowless = [...extTools.p].reduce((sum, [index, names]) => sum + (index >= rows.length ? names.length : 0), 0);
	if (rowless + extTools.withheld > 0) runner.cut = { ...cut, names: cut.names + rowless + extTools.withheld };
	if (extTools.withheld > 0) {
		try {
			known?.onWithheld?.(extTools.withheld);
		} catch {
			// a log that throws costs the line, never the field
		}
	}
	const packageRows = rows.map((row, index) => ({ tier: "package", name: packages[index]?.name ?? null, version: packages[index]?.version ?? null, ...rowFields(row), toolNames: extTools.p.get(index) ?? [] }));
	const namedTools = [...extTools.o].filter(([, names]) => names.length > 0).sort(([a], [b]) => a - b).map(([index, names]) => ({ name: overlay.loaded[index], tools: names }));
	runner.sources = tierSources(tiers, { packageRows, overlay: { names: overlay.loaded, failedNames: overlay.failed, namedTools } });
	return runner;
}

/**
 * The record's `loaded` from the line's field and what the worker knows. `raw` undefined or null (an older image, a line
 * the supervisor wrote, no verified line at all) is `absent`, `LOADED_LINE_CUT` is `cut`, and anything that fails a check
 * is `invalid`, each with the worker's own facts kept. Never throws.
 *
 *   known.packages           one `{ name, version }` or null per path in this job's PI_PACKAGES, in that order, the
 *                            candidate of a canary at its place. Rows are positional, so this is what names them
 *   known.overlayExtensions  the names in `<overlay>/extensions` on this host
 *   known.servers            the trigger's server names, in PI_MCP_SERVERS order
 *   known.ownTools           pi's own tool names (`EXCLUDABLE_TOOL_NAMES`)
 *   known.leftOut            `leftOutOf`, which the worker alone can say
 *   known.redact             this job's own redactor (`makeRedactor`): a tool's name kept comes through it unchanged
 *   known.onViolation        hears the fixed word of a check that failed, for the worker's log. Never line text
 *   known.onWithheld         hears how many tool names `redact` kept off the record, for the worker's log. Never a name
 */
export function rebuildLoaded(raw, known = {}) {
	const facts = { leftOut: isObject(known?.leftOut) ? known.leftOut : null };
	if (raw === undefined || raw === null) return workerOnly("absent", facts);
	if (raw === LOADED_LINE_CUT) return workerOnly("cut", facts);
	let runner;
	try {
		runner = readLine(raw, known);
	} catch (error) {
		try {
			known?.onViolation?.(error instanceof LineViolation ? error.word : "unreadable");
		} catch {
			// a log that throws costs the line, never the field
		}
		return workerOnly("invalid", facts);
	}
	const built = recordedLoaded({ ...workerOnly("reported", facts), ...runner });
	if (built === null) {
		try {
			known?.onViolation?.("record");
		} catch {
			// as above
		}
		return workerOnly("invalid", facts);
	}
	return built;
}

/**
 * The field with the image's facts added: what the preflight read before the container started (`imagePreflight`), or the
 * image alone when the container's own field is null (it was refused, or never reported anything). `imageDigest` is the
 * runtime's local image id (`{{.Id}}`): two local builds of one tag differ, so it is THIS HOST'S id for what ran and never
 * a thing to compare across hosts. `null` when the preflight named no image, which keeps a record with no image at all
 * byte-identical to what it was.
 */
export function loadedWithImage(loaded, img) {
	if (typeof img?.image !== "string") return loaded ?? null;
	const facts = { image: img.image, imageDigest: img.imageDigest ?? null, imagePi: img.piVersion ?? null };
	return { ...(loaded ?? workerOnly("absent")), ...facts };
}

/**
 * The field with the commit this run's workspace was prepared at, which only the worker can say: a repository extension in the
 * runner's process can write anything on its line, so a line's `baseSha` is never read (`readLine` names what it keeps) and this
 * value replaces whatever the object held. Null stays null, undefined or a non-string adds nothing: a record that has no base
 * to name has no key, and a preflight's image-only field before the workspace was prepared is byte-identical to what it was.
 * The shape is held where every other fact's is, at `recordedLoaded`.
 */
export function loadedWithBase(loaded, baseSha) {
	if (loaded === null || loaded === undefined) return null;
	return typeof baseSha === "string" ? { ...loaded, baseSha } : loaded;
}

const namesWithin = (value, max, ok) => Array.isArray(value) && value.length <= max && value.every(ok);

/** A count field of a source, or undefined when any is not a count: its tier's row, by name. */
function sourceCounts(source) {
	const out = {};
	for (const name of LOADED_ROW) {
		if (!isCount(source[name])) return undefined;
		out[name] = source[name];
	}
	return out;
}

/** One `sources` row, REBUILT, by its tier's own shape, or null. */
function recordedSource(source) {
	if (!isObject(source) || !LOADED_TIERS.includes(source.tier)) return null;
	const counts = sourceCounts(source);
	if (counts === undefined) return null;
	if (source.tier === "package") {
		// Null is a package the worker could not name, and the unnamed row of a form that keeps only the totals.
		const named = source.name === null && source.version === null ? { name: null, version: null } : knownPackage(source);
		if (named === null) return null;
		if (source.toolNames !== null && !namesWithin(source.toolNames, LOADED_MAX_EXT_TOOLS, isToolName)) return null;
		return { tier: "package", ...named, ...counts, toolNames: source.toolNames };
	}
	if (source.tier === "overlay") {
		const names = (value) => value === null || namesWithin(value, LOADED_MAX_OVERLAY_NAMES, isOverlayName);
		if (!names(source.names) || !names(source.failedNames)) return null;
		let namedTools = null;
		if (source.namedTools !== null) {
			if (!Array.isArray(source.namedTools) || source.namedTools.length > LOADED_MAX_OVERLAY_NAMES) return null;
			namedTools = [];
			for (const row of source.namedTools) {
				if (!isObject(row) || !isOverlayName(row.name) || !namesWithin(row.tools, LOADED_MAX_EXT_TOOLS, isToolName)) return null;
				namedTools.push({ name: row.name, tools: row.tools });
			}
		}
		return { tier: "overlay", names: source.names, failedNames: source.failedNames, ...counts, namedTools };
	}
	return { tier: source.tier, ...counts };
}

function recordedCut(cut) {
	if (cut === null) return null;
	try {
		return readCut(cut);
	} catch {
		return undefined;
	}
}

function recordedLeftOut(leftOut) {
	if (leftOut === null) return null;
	if (!isObject(leftOut) || !namesWithin(leftOut.tools, LEFT_OUT_TOOLS_MAX, (name) => typeof name === "string" && LEFT_OUT_TOOL_RE.test(name))) return undefined;
	for (const key of ["packages", "overlayExtensions", "restricted"]) if (typeof leftOut[key] !== "boolean") return undefined;
	return { tools: leftOut.tools, packages: leftOut.packages, overlayExtensions: leftOut.overlayExtensions, restricted: leftOut.restricted };
}

/** The runner's half of the record, REBUILT, or undefined on any violation. */
function recordedRunnerPart(value) {
	if (!LOADED_STAGES.includes(value.at)) return undefined;
	if (value.pi !== null && !isPiVersion(value.pi)) return undefined;
	const cut = recordedCut(value.cut);
	if (cut === undefined) return undefined;
	let flow = null;
	if (value.flow !== null) {
		if (!isObject(value.flow) || !LOADED_FLOW_WORDS.includes(value.flow.tier)) return undefined;
		const named = value.flow.package;
		if (named !== null && (value.flow.tier !== "package" || typeof named !== "string" || named.length > PACKAGE_NAME_MAX || !NPM_NAME_RE.test(named))) return undefined;
		flow = { tier: value.flow.tier, package: named };
	}
	if (!Array.isArray(value.sources) || value.sources.length > LOADED_MAX_PACKAGES + LOADED_TIERS.length - 1) return undefined;
	const sources = value.sources.map(recordedSource);
	if (sources.includes(null)) return undefined;
	let mcp = null;
	if (value.mcp !== null) {
		if (!Array.isArray(value.mcp) || value.mcp.length > LOADED_MAX_SERVERS) return undefined;
		mcp = [];
		for (const row of value.mcp) {
			if (!isObject(row) || !(row.name === null || (typeof row.name === "string" && MCP_SERVER_NAME_RE.test(row.name))) || !LOADED_MCP_STATES.includes(row.state) || !isCount(row.tools, LOADED_MAX_TOOL_COUNT)) return undefined;
			mcp.push({ name: row.name, state: row.state, tools: row.tools });
		}
	}
	let tools = null;
	if (value.tools !== null) {
		if (!isObject(value.tools) || !isCount(value.tools.active, LOADED_MAX_TOOL_COUNT)) return undefined;
		if (value.tools.own !== null && !namesWithin(value.tools.own, OWN_TOOLS_MAX, isToolName)) return undefined;
		if (value.tools.job !== null && !namesWithin(value.tools.job, LOADED_JOB_TOOLS.length, (name) => LOADED_JOB_TOOLS.includes(name))) return undefined;
		tools = { active: value.tools.active, own: value.tools.own, job: value.tools.job };
	}
	let problems = null;
	if (value.problems !== null) {
		if (!isObject(value.problems) || !isCount(value.problems.failed) || !isCount(value.problems.dropped) || !(value.problems.mcp === null || isCount(value.problems.mcp, LOADED_MAX_SERVERS))) return undefined;
		problems = { failed: value.problems.failed, dropped: value.problems.dropped, mcp: value.problems.mcp };
	}
	return { at: value.at, cut, pi: value.pi, flow, sources, mcp, tools, problems };
}

/**
 * The record's `loaded` (issue #800), REBUILT, never the source's object, the posture of every other field of the record:
 * or null on any violation, and then the record has no such key. What reaches this was made by `rebuildLoaded` and
 * `loadedWithImage`, so null here is a hand-built source and no ordinary run. Only `reported` carries a runner part, whatever
 * the source said. Past `LOADED_RECORD_MAX_BYTES` it reads as `cut`, the worker's facts kept. Never throws.
 */
export function recordedLoaded(value) {
	if (!isObject(value) || value.v !== LOADED_RECORD_VERSION || !LOADED_RUNNER_WORDS.includes(value.runner)) return null;
	const image = typeof value.image === "string" && value.image.length <= IMAGE_MAX && imageRefProblem(value.image) === null ? value.image : null;
	const imageDigest = typeof value.imageDigest === "string" && IMAGE_DIGEST_RE.test(value.imageDigest) ? value.imageDigest : null;
	const imagePi = isPiVersion(value.imagePi) ? value.imagePi : null;
	// A CONDITIONAL key, the last of the field. Null, as `image` is, would change the bytes of every record written before the
	// workspace was prepared, and those have nothing to say about a commit.
	const base = typeof value.baseSha === "string" && LOADED_BASE_SHA_RE.test(value.baseSha) ? { baseSha: value.baseSha } : {};
	const leftOut = recordedLeftOut(value.leftOut ?? null);
	if (leftOut === undefined) return null;
	let runnerPart = { at: null, cut: null, pi: null, flow: null, sources: [], mcp: null, tools: null, problems: null };
	if (value.runner === "reported") {
		runnerPart = recordedRunnerPart(value);
		if (runnerPart === undefined) return null;
	}
	const { at, cut, pi, flow, sources, mcp, tools, problems } = runnerPart;
	const out = { v: LOADED_RECORD_VERSION, runner: value.runner, at, cut, image, imageDigest, imagePi, pi, flow, sources, mcp, tools, problems, leftOut, ...base };
	if (Buffer.byteLength(JSON.stringify(out), "utf8") <= LOADED_RECORD_MAX_BYTES) return out;
	// No job's line gets here today (the tests measure the worst one); a cap that grows would. REJECTED: null, as this read
	// until a check found it. The bound falls after the image's facts are added, so a line that had passed every check then
	// left no key at all, and the run read like an older worker's. What is left always fits: the image's three facts and at
	// most 32 left-out tools and the base commit, a few KiB between them.
	return { ...out, runner: "cut", at: null, cut: null, pi: null, flow: null, sources: [], mcp: null, tools: null, problems: null };
}
