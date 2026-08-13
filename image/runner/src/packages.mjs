/**
 * What a job's session is allowed to load: the staged-package questions (INT-CONTAINER-JOB-INPUTS) and
 * the admin-extension recursion guard (REQ-ADMIN-VIA-PI-EXTENSION).
 *
 * Every helper here is PURE -- plain objects in (pi diagnostics, path strings, loaded-extension
 * records), a decision out. No filesystem, no pi import; `node:path` is string arithmetic and reads
 * nothing. So every decision this file encodes is testable without a container.
 */
import { basename, dirname } from "node:path";

/**
 * Roots whose skills a staged package must never be able to replace, most specific FIRST.
 *
 * The middle entry is a trigger's injected skills (REQ-PER-TRIGGER-SKILLS, issue #60), and it sits
 * between the repo and the overlay for the same reason it does in additionalSkillPaths: "for THIS
 * trigger" is a narrower operator statement than "for this deployment", and narrower wins.
 */
export const PROTECTED_SKILL_ROOTS = ["/job/pi/skills", "/job/trigger-skills", "/opt/pi-global/skills"];

/**
 * The admin extension, BY NAME -- a deliberate duplicate of `ADMIN_RE` in worker/src/import-pi.mjs.
 *
 * It cannot be imported. The job image installs the RUNNER's dependencies and the runner's source; the
 * worker's is not in the container at all, so there is nothing to import from. The duplication is
 * therefore forced, and the copy is the hazard: widen the worker's ADMIN_RE (a renamed admin package, a
 * second admin name) without widening this one and the runner quietly stops recognising the very thing
 * the worker refuses to stage -- a hole that opens with no failing test and no log line. CHANGE BOTH,
 * IN THE SAME COMMIT. worker/src/import-pi.mjs is the original; worker/src/packages.mjs imports it for
 * staged package names and dirs, and this file is the third reader.
 */
export const ADMIN_EXTENSION_RE = /pi-dispatch|dispatch-admin/i;

/**
 * The admin surface's tool namespace, which is what the guard is ACTUALLY defending against.
 *
 * A name catches an entry that admits what it is; this catches one that does not. The vector is not a
 * filename, it is `dispatch_run` (enqueues a PAID job from inside a paid job), `dispatch_set` (moves
 * the daily cap) and `dispatch_pause`/`_resume`/`_trigger_*` (durable queue controls) becoming
 * LLM-callable inside a container whose prompt carries adversarial issue text. This project's own
 * `.pi/extensions/dispatch.ts` is exactly that shape: two lines, a name no pattern would flag, and the
 * whole admin tool set behind it. An extension that registers these tools IS the admin surface however
 * it is spelled on disk.
 *
 * The cost is stated rather than hidden: a serviced repo whose own extension registers a `dispatch_*`
 * tool loses it in job containers. That is a loud, logged drop an operator can rename around, traded
 * against a silent paid recursion -- and no read tool is worth the other side of that trade.
 */
export const ADMIN_TOOL_RE = /^dispatch_/;

/** `index.*` names nothing -- the DIRECTORY does. Covers the extensions pi will resolve: .ts and .js. */
const INDEX_ENTRY_RE = /^index\.[cm]?[jt]sx?$/i;

/**
 * The name an extension is KNOWN BY: its file's basename, or `<dir>/index.js` when the file is the
 * index pi resolved a directory to, because there the directory is the name.
 *
 * The name and NOT the full path, and that choice is the guard's whole precision. Matching
 * ADMIN_EXTENSION_RE against a full path tests every ANCESTOR too, and an ancestor is not the
 * extension: a checkout that happens to sit under a directory called `pi-dispatch` (this repo, on the
 * operator's own host, and the tmpdir these tests run in) would have every one of its extensions
 * dropped -- the guard failing open into "the serviced repo loads nothing", which is the failure mode
 * that gets a guard deleted. The container's own roots are fixed (/workspace, /job/pi, /opt/pi-global),
 * so a path test buys nothing there anyway.
 *
 * What the name test therefore catches: an entry that carries the admin name itself -- `pi-dispatch.ts`,
 * `dispatch-admin/index.js`, `PI-Dispatch-admin.js`, a staged package dir named for the admin package.
 * What it CANNOT catch: a re-export under any other name. That gap is real and it is why the tool-name
 * signal above exists; neither signal alone closes this.
 */
export function extensionEntryName(path) {
	if (typeof path !== "string" || path === "") return "";
	const name = basename(path);
	return INDEX_ENTRY_RE.test(name) ? `${basename(dirname(path))}/${name}` : name;
}

/** pi hands back a Map of registered tools; tests and callers may hand back plain names. */
function toolNames(tools) {
	if (tools instanceof Map) return [...tools.keys()];
	if (Array.isArray(tools)) return tools;
	return [];
}

/**
 * Why this loaded extension must not reach the session, or null to keep it. Two independent signals,
 * reported separately so a run log says which one fired -- they fail in different directions and an
 * operator debugging a missing extension needs to know whether it was the name or the surface.
 */
export function adminExtensionReason(extension) {
	if (ADMIN_EXTENSION_RE.test(extensionEntryName(extension?.path))) return "admin-name";
	if (toolNames(extension?.tools).some((tool) => ADMIN_TOOL_RE.test(tool))) return "admin-tools";
	return null;
}

/**
 * Split pi's loaded extensions into the ones a job's session may have and the ones it may not
 * (REQ-ADMIN-VIA-PI-EXTENSION Scope: the admin surface is the operator's, never a job's).
 *
 * FILTER, NOT REFUSE. The operator services this very repo, and this very repo ships an admin shim at
 * `.pi/extensions/dispatch.ts` -- refusing the job would make self-hosting the one thing pi-dispatch
 * cannot do. Dropping one extension leaves the job exactly as capable as it was before native
 * extension discovery was turned on.
 *
 * `kept` is the ORIGINAL objects (order preserved: extension resolution is first-path-wins and the
 * trust ordering lives in that order). `dropped` is a record built to be LOGGED -- entry name, owning
 * root, reason -- and it carries no path field at all, so no caller can leak a host path or file
 * content through it by accident. `roots` should be listed most-specific first; a staged package root
 * lives UNDER /opt/pi-global, so an overlay-first list would attribute a package's extension to the
 * overlay.
 */
export function partitionAdminExtensions(extensions = [], { roots = [] } = {}) {
	const kept = [];
	const dropped = [];
	for (const extension of extensions ?? []) {
		const reason = adminExtensionReason(extension);
		if (!reason) {
			kept.push(extension);
			continue;
		}
		dropped.push({ name: extensionEntryName(extension?.path), root: owningRoot(extension?.path, roots), reason });
	}
	return { kept, dropped };
}

/**
 * Find staged-package skills that TRIED to shadow a repo or operator-overlay skill
 * (REQ-GLOBAL-PI-OVERLAY).
 *
 * What pi does, stated exactly: skillPaths is `mergePaths(cliEnabledSkills, additionalSkillPaths)`,
 * so the paths a staged package contributes through its `pi` manifest come FIRST and our
 * `/job/pi/skills` and `/opt/pi-global/skills` come after -- whatever order we listed the package in.
 * `loadSkills` is then first-path-wins: the first skill with a given name is kept, every later
 * same-named skill is DROPPED, and the loss survives only as a `{type:"collision"}` diagnostic naming
 * the winner and the loser. Left at that, a package's `deploy` replaces the repo's, which inverts
 * REQ-GLOBAL-PI-OVERLAY's documented "repo wins on conflict".
 *
 * That ordering is not ours to set -- but the RESULT is. `DefaultResourceLoaderOptions.skillsOverride`
 * is a declared option on the pinned loader, invoked on `{skills, diagnostics}` the moment loadSkills
 * returns, and loader.mjs uses it (enforceProtectedSkillPrecedence) to put the protected skill back in
 * force. So the repo does win, and this function is no longer a reason to refuse the job.
 *
 * It is still the VISIBILITY signal, and that is why it survives: the operator has to be told that a
 * staged package shipped a name the repo had already published, because the package's own flow was
 * written against a procedure that is not the one now running. It reads pi's UNMODIFIED diagnostic --
 * the true record of what the raw load produced -- so it keeps reporting the attempt even though the
 * outcome has been reversed. It is also the tripwire on the pin: if a future pi reorders skillPaths so
 * the repo already wins, this goes quiet at the same moment the override becomes a no-op.
 *
 * Returns ONLY the inverted direction. A collision the repo won (winner under a protected root) is
 * the documented, allowed overlay behaviour and yields nothing; so does a collision between two
 * non-package roots (a repo skill shadowing an overlay skill of the same name -- exactly what
 * REQ-GLOBAL-PI-OVERLAY promises).
 */
export function findShadowedSkills(diagnostics, { packageRoots = [], protectedRoots = PROTECTED_SKILL_ROOTS } = {}) {
	const shadowed = [];
	for (const diagnostic of diagnostics ?? []) {
		if (diagnostic?.type !== "collision") continue;
		const collision = diagnostic.collision;
		if (!collision || collision.resourceType !== "skill") continue;
		// winnerPath is the skill pi KEPT, loserPath the one it dropped. Flag only
		// package-beats-protected; every other pairing is the allowed direction.
		if (!isUnderAnyRoot(collision.winnerPath, packageRoots)) continue;
		if (!isUnderAnyRoot(collision.loserPath, protectedRoots)) continue;
		shadowed.push(collision);
	}
	return shadowed;
}

/**
 * Per-root `{extensions, skills}` counts for the `packages_loaded` log line.
 *
 * `extensionPaths` are the loaded extensions' own paths, `skillPaths` the loaded skills' SKILL.md
 * file paths -- both as pi reports them AFTER loading, so a package that shipped a manifest entry
 * pi refused to load is not counted as if it had worked.
 *
 * A root that contributed nothing still appears, reporting 0. That is the whole point of logging
 * per-root rather than a total: a staged package that mounted but resolved to no resources at all
 * (an unbuilt extension, a manifest pointing at files that are not there) is otherwise
 * indistinguishable from one that worked, and the job runs without the tools its flow expects.
 */
export function countPackageResources({ packageRoots = [], extensionPaths = [], skillPaths = [] } = {}) {
	return packageRoots.map((root) => ({
		root,
		extensions: extensionPaths.filter((path) => isUnderRoot(path, root)).length,
		skills: skillPaths.filter((path) => isUnderRoot(path, root)).length,
	}));
}

/**
 * Does the trigger's flow name any skill pi actually loaded? (Issue #189.)
 *
 * Exact name equality against the LOADED set, which makes this the one check in the system that is
 * not an approximation: doctor probes tier directories host-side and a dir name can lie (pi names a
 * skill `frontmatter.name || parentDirName` at the 0.80.7 pin, skills.js:221), but here the names
 * come off the skills the loader materialised for THIS job, after every tier and override.
 *
 * A `disableModelInvocation` skill still counts as loaded -- it is absent from the system-prompt
 * catalogue but present in the session, invocable as /skill:name, so the flow it names is not the
 * silent no-op this check exists to catch.
 *
 * `flow` null/empty returns true: no flow, nothing to verify, no line. Malformed skill entries
 * (no `name`) are skipped rather than crashing a job over a diagnostic input.
 */
export function isFlowLoaded(flow, skills) {
	if (flow === null || flow === undefined || flow === "") return true;
	return (skills ?? []).some((skill) => skill?.name === flow);
}

/**
 * Containment by path SEGMENT, not by string prefix -- `/opt/pi-global/packages/tool` must not
 * claim a path under `/opt/pi-global/packages/tools`. Trailing slashes on a root are tolerated
 * because an operator-supplied PI_PACKAGES entry may carry one.
 */
function isUnderRoot(path, root) {
	if (typeof path !== "string" || typeof root !== "string" || root === "") return false;
	const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
	return path === normalized || path.startsWith(`${normalized}/`);
}

/**
 * Exported because loader.mjs decides skill precedence against the SAME roots. A second containment
 * test written next to the loader would be a second place for the segment-boundary bug to live, and
 * the two would disagree exactly once -- on the collision that matters.
 */
export function isUnderAnyRoot(path, roots) {
	return (roots ?? []).some((root) => isUnderRoot(path, root));
}

/**
 * The first root that CONTAINS the path, or null. Used to name the root that actually won a skill
 * collision in the log line: reporting the winning root is what makes the enforcement observable,
 * and reporting a whole file path would put image layout into shipped run logs.
 */
export function owningRoot(path, roots) {
	return (roots ?? []).find((root) => isUnderRoot(path, root)) ?? null;
}
