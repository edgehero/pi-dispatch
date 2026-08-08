import { existsSync, readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { isUnderAnyRoot, partitionAdminExtensions } from "./packages.mjs";

/** Where the image bakes the guardrails. Outside agentDir, on purpose -- see buildResourceLoader. */
export const GUARDRAILS_PATH = "/opt/pi-dispatch/HARD_RULES.md";

/** Where the image bakes the outbox protocol. Documentation for the /outbox signal channel. */
export const OUTBOX_PROTOCOL_PATH = "/opt/pi-dispatch/OUTBOX_PROTOCOL.md";

/** Read-write mount a local job receives; its presence is what makes the outbox protocol relevant. */
export const OUTBOX_MOUNT = "/outbox";

/** Read-only mount the worker materialises the project's .pi/ into, from the default-branch SHA. */
export const JOB_PI_DIR = "/job/pi";

/**
 * Read-only mount of the operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global
 * skills, and a global persona from the operator's own ~/.pi/agent, present only when configured. It is
 * operator deploy-time config -- the same trust class as the baked floor -- layered UNDER each repo's .pi/.
 */
export const GLOBAL_PI_DIR = "/opt/pi-global";

export const WORKSPACE = "/workspace";

function readIfExists(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The fallback log writer, matching run-job.mjs's line shape exactly.
 *
 * run-job.mjs passes its own `log` so the real job path has ONE writer. This default exists because the
 * alternative default is silence, and a security drop nobody can see is the failure this whole change is
 * about: a caller that forgets to pass a log must still leave the drop in the run log.
 */
function defaultLog(event, fields = {}) {
	process.stdout.write(`${JSON.stringify({ event, jobId: process.env.PI_JOB_ID, ...fields })}\n`);
}

/**
 * Keep the admin surface out of the job's session -- the recursion guard, enforced at pi's own seam.
 *
 * The fact this exists for: `noExtensions: false` turned on native discovery, so a serviced repo's
 * /workspace/.pi/extensions now loads (project resources are gated on isProjectTrusted(), which is TRUE
 * here). This repo SHIPS such an extension -- `.pi/extensions/dispatch.ts`, a two-line re-export of the
 * admin extension -- and the operator services this very repo. Without this, a job container gets
 * LLM-callable `dispatch_run` (enqueues a PAID job), `dispatch_set` (moves the daily cap) and the
 * pause/resume/trigger writes, driven by a session whose prompt carries adversarial issue text. That is
 * the same recursion vector worker/src/import-pi.mjs refuses to copy into the overlay and
 * worker/src/packages.mjs refuses to stage; discovery re-opened a door two other paths keep shut.
 *
 * Stated plainly, because the seam does NOT do what a reader might hope: discovery still resolves the
 * file, jiti still imports it, and its factory has already RUN by the time we are called
 * (loadFinalExtensionSet -> extensionsOverride, in that order). What we refuse is handing the result
 * over. `extensionsOverride` is a declared option on the pinned loader, invoked on the LoadExtensionsResult
 * before the loader stores anything, and createAgentSession builds its ExtensionRunner from
 * `resourceLoader.getExtensions().extensions` -- so an extension removed here registers no tool, receives
 * no event, and contributes no command to the session. Module-level side effects of the import itself are
 * NOT prevented by this and never could be at this layer; the container sandbox is what bounds those.
 *
 * `errors` and `runtime` are passed through untouched: `runtime` is what the session needs, and the errors
 * are pi's own record of the load. Nothing dropped means the base object is returned as-is, so the
 * overwhelmingly common job pays nothing and no diagnostic claims something happened.
 */
export function dropAdminExtensions(base, { roots = [], log = defaultLog } = {}) {
	const { kept, dropped } = partitionAdminExtensions(base?.extensions ?? [], { roots });
	if (dropped.length === 0) return base;
	// Entry names and mount roots only -- never the full path, never a byte of the file. `dropped` is
	// built by partitionAdminExtensions to carry nothing else, so this line cannot grow a path by edit.
	log("extension_dropped", { reason: "admin-recursion-guard", extensions: dropped });
	return { ...base, extensions: kept };
}

/**
 * Re-impose protected-root precedence on the skills pi loaded -- REQ-GLOBAL-PI-OVERLAY's "repo wins
 * on conflict", enforced rather than merely documented.
 *
 * The fact this exists for: pi builds skillPaths as `mergePaths(cliEnabledSkills,
 * additionalSkillPaths)`, so the paths a staged package contributes through its `pi` manifest come
 * FIRST regardless of where we listed the package in additionalExtensionPaths, and `loadSkills` is
 * first-path-wins. Left alone, a package's `deploy` is the one pi KEEPS and the repo's is dropped to a
 * `{type:"collision"}` diagnostic. Reordering our own paths cannot change that -- that ordering is
 * pi's.
 *
 * The RESULT, though, is ours. `DefaultResourceLoaderOptions.skillsOverride` is a declared option on
 * the pinned loader, called with `{skills, diagnostics}` the moment loadSkills returns and before the
 * loader stores anything. This is not a workaround for a missing lever; it IS the lever, and using it
 * is what keeps the requirement's promise true instead of leaving the job to be refused for a
 * precedence the SDK was willing to hand over.
 *
 * The substitute comes from pi's own public `loadSkillsFromDir` with `source: "path"` -- the source
 * `loadSkills` itself assigns to an explicit skill path -- so the skill that ends up in force is what
 * pi would have kept had the package never shipped the name. Parsing SKILL.md here instead would be a
 * second, divergent reader of a format we do not own, and it would drift silently.
 *
 * Protected roots are consulted IN ORDER, first name wins, mirroring additionalSkillPaths (repo before
 * overlay) -- so a repo skill still beats an overlay skill of the same name.
 *
 * pi's collision diagnostic is left EXACTLY as pi wrote it. It is a true record of what the raw load
 * produced and it is what packages.mjs findShadowedSkills reads to tell the operator that a staged
 * package tried to take a repo skill's name. The substitution appends its OWN collision diagnostic
 * naming the enforced winner, so both stages are on the record and neither has to be inferred from the
 * other.
 *
 * A job with no staged packages returns untouched, which is also why the protected roots are not read
 * a second time on the overwhelmingly common path. `loadDir` is injected only so the decision is
 * unit-testable without a skills tree on disk.
 */
export function enforceProtectedSkillPrecedence(
	base,
	{ packageRoots = [], protectedRoots = [], loadDir = loadSkillsFromDir } = {},
) {
	const skills = base?.skills ?? [];
	const diagnostics = base?.diagnostics ?? [];
	if (packageRoots.length === 0 || protectedRoots.length === 0) return { skills, diagnostics };

	const protectedByName = new Map();
	for (const dir of protectedRoots) {
		// loadSkillsFromDir returns empty for a directory that is not there, so an unmounted overlay
		// contributes nothing rather than throwing -- the same shape pi's own load takes for it.
		for (const skill of loadDir({ dir, source: "path" })?.skills ?? []) {
			if (!protectedByName.has(skill.name)) protectedByName.set(skill.name, skill);
		}
	}

	const enforced = [];
	const resolved = skills.map((skill) => {
		// Only a skill pi kept FROM A PACKAGE can be displacing a protected one. A protected skill that
		// already won (a future pi that reorders skillPaths) is left alone, so this stays a no-op rather
		// than becoming a second, opposite bug.
		if (!isUnderAnyRoot(skill.filePath, packageRoots)) return skill;
		const winner = protectedByName.get(skill.name);
		if (!winner || winner.filePath === skill.filePath) return skill;
		enforced.push({
			type: "collision",
			message: `name "${skill.name}" collision -- protected root wins (REQ-GLOBAL-PI-OVERLAY)`,
			path: skill.filePath,
			collision: {
				resourceType: "skill",
				name: skill.name,
				winnerPath: winner.filePath,
				loserPath: skill.filePath,
			},
		});
		return winner;
	});

	return { skills: resolved, diagnostics: [...diagnostics, ...enforced] };
}

/**
 * Build the resource loader exactly as a job does.
 *
 * The contract tests import THIS function rather than constructing a loader of their
 * own -- a test that builds its own loader tests the test, not the runner.
 *
 * Every option here is load-bearing; see INT-SDK-SESSION-OPTIONS.
 *
 * THE POSTURE, stated once because three of the options below only make sense together: a job's
 * /workspace is ALWAYS the base repo at its DEFAULT-BRANCH sha. prepare-github.mjs resolves that sha
 * from a fresh API call, fetches that one commit and checks it out detached; a PR's head/base ride in
 * event.json as DATA and are never used as a clone ref. Workspace content is therefore merge-gated --
 * only someone who can land a commit on the default branch can influence it -- and merge-gated content
 * is allowed to write our agent's standing instructions. Webhook issue/PR TEXT is NOT: it stays data in
 * the user prompt, and CONST-ISSUE-TEXT-IS-DATA is untouched by any of this.
 *
 * - `noContextFiles: false` -- the repo's AGENTS.md loads, which is what pi does by default.
 *   loadProjectContextFiles walks agentDir plus EVERY ancestor of cwd; cwd is /workspace, so in the
 *   container that is the repo's own file. CONST-NO-CONTEXT-FILES-MANDATORY currently mandates `true`
 *   and is being AMENDED in this same change -- read the two together, not as a disagreement. The
 *   constraint's own wording ("anyone who can land a PR in a serviced repo") describes exactly the
 *   merge-gated population above, and its stated accepted cost was losing the repo's legitimate
 *   conventions. That is the trade being reversed. Written out rather than omitted on purpose: this
 *   option is the one the constraint's history is about, so its value is a decision on the record.
 *
 * - `noExtensions: false` -- pi discovers /workspace/.pi/extensions natively. Two non-obvious facts
 *   hold this up. (1) The flag alone is not what makes discovery fire: project resources are gated on
 *   SettingsManager.isProjectTrusted(), and SettingsManager.inMemory (run-job.mjs) reports TRUE --
 *   trust defaults to granted and nothing here revokes it, so flipping that default would silently
 *   turn this flag back into a no-op. (2) There is no double-load to worry about, because the worker's
 *   materialiser copies ONLY .pi/APPEND_SYSTEM.md and the declared files of .pi/skills/<name>/ (whole
 *   skill directories since issue #60, not just each SKILL.md) -- /job/pi/extensions is STILL never
 *   written, so discovery remains the only path a repo extension has ever had. The premise widened;
 *   the conclusion did not.
 *   What discovery may NOT bring in is the admin extension: see extensionsOverride below. A serviced
 *   repo can ship one (this repo does), and it would hand a job container the paid-enqueue tools.
 *
 * - `extensionsOverride` is the recursion guard, and it is the reason discovery is affordable at all.
 *   It drops admin-like extensions from the loaded set -- filter, not refuse, because the operator
 *   services this repo and a refusal would end self-hosting. See dropAdminExtensions.
 *
 * - `noSkills` STAYS `true`, and that asymmetry is deliberate. The repo's skills already reach the
 *   agent through the materialised /job/pi/skills below: the same content, read out of the pinned sha
 *   with `git cat-file` (no working tree, no symlink following) onto a read-only mount. Discovery would
 *   register every one of them a SECOND time under /workspace/.pi/skills, and pi's loadSkills is
 *   first-path-wins over the merged path list with the discovered copy FIRST -- so the mount would stop
 *   being the copy in force and would be demoted to a `{type:"collision"}` diagnostic. That also feeds
 *   the skillsOverride enforcement below, which decides between package roots and protected roots and
 *   has no case for the same protected skill arriving twice. Same content, no benefit, real breakage.
 *
 * - Guardrails are read EXPLICITLY, not discovered -- and that matters MORE under the relaxed flags,
 *   not less. A trusted project's .pi/APPEND_SYSTEM.md shadows the global one via an early return in
 *   discoverAppendSystemPromptFile, and the project IS trusted, so a repo could otherwise silently
 *   delete the safety floor. appendSystemPromptOverride discards the discovered value entirely, which
 *   removes the class: discovery cannot shadow what it does not supply. (Project trust already routed
 *   .pi/SYSTEM.md into getSystemPrompt() before this change -- that path is gated by trust alone, not
 *   by any of the three flags here, and is not touched.)
 *
 * - `skillsOverride` is where REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict" is actually
 *   enforced. Path order cannot carry it -- pi puts a staged package's skill paths first --
 *   so precedence is re-imposed on the loaded result instead. See
 *   enforceProtectedSkillPrecedence.
 */
export function buildResourceLoader({
	cwd = WORKSPACE,
	guardrailsPath = GUARDRAILS_PATH,
	jobPiDir = JOB_PI_DIR,
	globalPiDir = GLOBAL_PI_DIR,
	outboxMount = OUTBOX_MOUNT,
	outboxProtocolPath = OUTBOX_PROTOCOL_PATH,
	// ON, matching the runtime posture (REQ-GLOBAL-PI-OVERLAY): the operator staged that dir themselves,
	// so loading it is the default and PI_GLOBAL_ALLOW_EXTENSIONS=0 is the opt-out. run-job.mjs always
	// passes an explicit value, so this default is only ever seen by a directly-constructed loader --
	// which is exactly why it must not say the opposite of what a job does.
	allowGlobalExtensions = true,
	packagePaths = [],
	settingsManager,
	log = defaultLog,
} = {}) {
	const guardrails = readFileSync(guardrailsPath, "utf8");
	const projectPersona = readIfExists(`${jobPiDir}/APPEND_SYSTEM.md`);
	// The operator's global overlay (REQ-GLOBAL-PI-OVERLAY), present only when the /opt/pi-global mount
	// exists. Persona layers BETWEEN the immutable floor and the repo persona; skills layer UNDER the
	// repo's (repo path first => repo wins a name collision, since pi's loadSkills is first-path-wins).
	const globalPersona = readIfExists(`${globalPiDir}/APPEND_SYSTEM.md`);
	const globalSkills = `${globalPiDir}/skills`;
	const globalExtensions = `${globalPiDir}/extensions`;
	// Only a local job carries an /outbox mount; a github job has none, so its prompt never
	// pays for the protocol. Evaluated ONCE here at loader build, not per message, so the
	// assembled prompt is byte-identical across turns (CONST-PERSONA-IN-CACHED-PREFIX).
	const outboxProtocol = existsSync(outboxMount) ? readIfExists(outboxProtocolPath) : undefined;
	// The roots a staged package may never take a skill name from. Both are listed unconditionally: a
	// root that is not mounted contributes no skill to protect, so gating it would only add a way to
	// forget one.
	const protectedSkillRoots = [`${jobPiDir}/skills`, globalSkills];
	// Roots the recursion guard can NAME in its log line, most specific FIRST: a staged package sits
	// under the overlay, so an overlay-first list would report a package's extension as the operator's.
	// The workspace is last because it is the catch-all -- a discovered repo extension is anywhere in it.
	const extensionRoots = [...packagePaths, `${jobPiDir}/extensions`, globalExtensions, cwd];

	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		// Context files and extensions are DISCOVERED, as in any pi run: /workspace is the base repo's
		// default-branch sha, so its files are merge-gated content (see the posture note above).
		// CONST-NO-CONTEXT-FILES-MANDATORY is amended in this same change.
		noContextFiles: false,
		noExtensions: false,
		// Skills are the exception, and it is not an oversight: the repo's skills are already mounted at
		// /job/pi/skills from the pinned sha, so discovery would only re-register the same files under a
		// second path and take the mount out of force on a first-path-wins collision. See the docstring.
		noSkills: true,
		// Repo path FIRST so a repo skill overrides a global one of the same name (first-path-wins).
		additionalSkillPaths: [`${jobPiDir}/skills`, ...(existsSync(globalSkills) ? [globalSkills] : [])],
		// Global overlay extensions load whenever the dir is present -- staging them IS the operator's
		// decision, so a second arming step was friction rather than safety. PI_GLOBAL_ALLOW_EXTENSIONS=0
		// is the opt-out, and any other value is refused at config load so a typo cannot silently mean
		// "load third-party code into every container" (worker/src/config.mjs, image/runner/src/config.mjs).
		// Staged pi packages (INT-CONTAINER-JOB-INPUTS) come LAST, and they do NOT ride that option: the
		// packagePaths spread below is unconditional. Two switches, deliberately, because they withhold two
		// different things. PI_GLOBAL_ALLOW_EXTENSIONS=0 makes the OVERLAY's own extensions/ dormant;
		// `run.packages: false` on a trigger withholds the staged set from that trigger's jobs, and the
		// worker has already applied it before emitting PI_PACKAGES (worker/src/env-allowlist.mjs) -- so an
		// empty packagePaths here already means "this job loads none" and re-gating it on the overlay's
		// opt-out would withhold packages the operator did arm. The honest answer to "how do I stop ALL
		// third-party extension code loading in my containers" is therefore BOTH, which is what
		// docs/global-pi-overlay.md's withhold table and docs/workflows.md tell the operator. One staged dir
		// contributes extensions AND skills AND prompts AND themes through its package.json "pi"
		// manifest: resolveExtensionSources reads the manifest and returns all four resource kinds,
		// and reload() keeps cliEnabledExtensions/cliEnabledSkills REGARDLESS of noExtensions/noSkills
		// -- those flags suppress only cwd/package DISCOVERY, never what an explicit path contributes.
		// Listed last so nothing a package ships can shadow a repo or overlay EXTENSION (first-path-
		// wins). That ordering fix does NOT extend to skills: pi puts package skill paths FIRST in
		// skillPaths no matter where the package sat here, so on the raw load a package skill wins a
		// name collision against the repo's. Skill precedence is therefore re-imposed AFTER the load,
		// through skillsOverride below.
		// With noExtensions off, reload() merges the paths DISCOVERED under /workspace/.pi/extensions
		// AFTER this whole list (`mergePaths(cliEnabledExtensions, enabledExtensions)`), so the trust
		// ordering above survives discovery: a workspace extension is last of all and shadows nothing.
		// The jobPiDir entry stays for symmetry and is normally absent -- the materialiser writes only
		// APPEND_SYSTEM.md and skills -- which is why pi reports one "path does not exist" extension
		// error on an ordinary job. Harmless, and load-bearing for tests that scope errors by root.
		additionalExtensionPaths: [
			`${jobPiDir}/extensions`,
			...(allowGlobalExtensions && existsSync(globalExtensions) ? [globalExtensions] : []),
			...packagePaths,
		],
		// The recursion guard (REQ-ADMIN-VIA-PI-EXTENSION Scope), run on the loaded extension set before
		// the loader stores it -- so the admin surface a serviced repo can now ship through discovery
		// never reaches the session's ExtensionRunner. See dropAdminExtensions.
		extensionsOverride: (loaded) => dropAdminExtensions(loaded, { roots: extensionRoots, log }),
		// REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict", made true rather than merely asserted. This
		// is the loader's own declared seam, run on loadSkills' result before anything is stored, so the
		// precedence pi's path ordering hands to a staged package is taken back here. Without it the
		// repo's skill is gone by the time anyone can look.
		skillsOverride: (loaded) =>
			enforceProtectedSkillPrecedence(loaded, {
				packageRoots: packagePaths,
				protectedRoots: protectedSkillRoots,
			}),
		appendSystemPromptOverride: () => [guardrails, outboxProtocol, globalPersona, projectPersona].filter(Boolean),
	});
}

/**
 * Build and load. Separate from buildResourceLoader so tests can assert on a
 * half-built loader if they need to, but nothing should skip this.
 *
 * createAgentSession only calls reload() on a loader it constructed ITSELF
 * (`if (!resourceLoader)`). Pass your own and nothing reloads it -- and reload() is
 * what populates the prompt. getAppendSystemPrompt() is a plain getter with no lazy
 * load, so a forgotten reload() yields an empty persona with no error and a job that
 * succeeds. This is why the tests assert the sentinel rather than trusting the wiring.
 *
 * reload() has no early return: it re-runs the entire load every call. Call it once.
 */
export async function buildLoadedResourceLoader(options = {}) {
	const loader = buildResourceLoader(options);
	await loader.reload();
	return loader;
}
