/**
 * doctor's project secret bundle lines (issue #704, REQ-TRIGGER-SECRETS, DES-PROJECT-SECRET-BUNDLES).
 *
 * Its own module, the doctor-openshell.mjs precedent: doctor.mjs is a ten-thousand-line file, and these lines read
 * three files and (with `--secrets`) spawn resolvers, so a seam per input keeps them testable without a host.
 *
 * WHAT IS CHECKED, and why each is a failure rather than a warning:
 *   - a bundle naming a profile this host does not declare (or declares twice, or declares in the panel outside
 *     PI_SECRET_RESOLVER_ROOTS): every job of that project refuses pre-spend on this host, deliberately;
 *   - a bundle naming a project projects.json does not hold: the binding can never apply, and the operator reads it
 *     as granting an environment. That is the silent no-op this project refuses;
 *   - bundle profiles declared with no triggers file to read: no job on this host can get a bundle, while the host
 *     reads as serving them.
 * Two bundles naming one project is refused by the triggers file's own validator, so it surfaces as that file's
 * parse failure, which doctor already prints, rather than as a second line here.
 *
 * And a WARNING per bundle whose project holds a folder: a local job's /workspace IS the operator's folder, so an
 * agent that writes a credential to `.env` there writes the whole bundle's into a real repository. The run.secrets
 * disclosure, raised to a warning because a bundle is a whole environment, not one field.
 *
 * `--secrets` (`secrets: true`) resolves each bundle ON THIS HOST and prints its variable NAMES and their count, never
 * a value. It is opt-in because it spawns every bundle resolver, which reads the manager (and counts against its
 * rate limit) once per bundle.
 */

import { FORGE_KINDS } from "./forges.mjs";
import { mergeSecretProfiles, parseSecretBundleProfiles, servableSecretProfiles } from "./secret-profiles.mjs";

/** Whether a projects.json member is a FOLDER (a local job's scope), not a forge-qualified repository. */
function isFolderMember(member) {
	return typeof member === "string" && !FORGE_KINDS.some((kind) => member.startsWith(`${kind}:`));
}

/** `PI_SECRET_BUNDLES`, never throwing: `{ bundles }` or `{ error }` (the worker refuses to boot on the latter). */
export function parseSecretBundleProfilesSafe(raw) {
	try {
		return { bundles: parseSecretBundleProfiles(raw), error: null };
	} catch (err) {
		return { bundles: {}, error: err?.message ?? "unparseable" };
	}
}

/**
 * The checks. Inputs, every one already read by the caller:
 *   - `bundles`: the triggers file's validated `secretBundles` (`{}` when none);
 *   - `triggersPresent`: whether the worker has a triggers file to read them from;
 *   - `projects` / `projectsError`: projects.json as the worker loads it, or its load failure;
 *   - `envRaw`: `PI_SECRET_BUNDLES` as set; `overlayBundles`: the overlay's `secretBundles`; `roots`: PI_SECRET_RESOLVER_ROOTS;
 *   - `realExecutablePath`: the resolver's own probe (secrets.mjs `realExecutable`), or null when pi did not load;
 *   - `resolveBundle`: `(binding) => resolve result`, only with `--secrets`.
 */
export async function secretBundleChecks({ bundles = {}, triggersPresent = true, projects = [], projectsError = null, envRaw, overlayBundles = {}, roots = [], realExecutablePath = null, resolveBundle = null } = {}) {
	const checks = [];
	const { bundles: envBundles, error } = parseSecretBundleProfilesSafe(envRaw);
	if (error) {
		checks.push({ ok: false, label: "PI_SECRET_BUNDLES does not parse", fix: `${error} -- the worker refuses to boot until this is fixed` });
		return checks;
	}
	const ids = Object.keys(bundles);
	const declaredNames = [...new Set([...Object.keys(envBundles), ...Object.keys(overlayBundles)])].sort();
	if (ids.length === 0 && declaredNames.length === 0) return checks;

	// The overlay half counts only where the worker would use it: an executable inside the roots (servableSecretProfiles
	// asks the resolver's own question). Without the probe (pi did not load) an overlay profile counts as written.
	const overlayPaths = Object.fromEntries(Object.entries(overlayBundles).map(([name, entry]) => [name, entry?.path]));
	const usableOverlay = realExecutablePath === null ? overlayPaths : servableSecretProfiles({ envProfiles: {}, overlayProfiles: overlayPaths, roots, realExecutablePath }).profiles;
	const ambiguous = mergeSecretProfiles(envBundles, overlayBundles).ambiguous !== undefined;
	const ambiguousNames = Object.keys(overlayBundles).filter((name) => Object.hasOwn(envBundles, name));

	if (declaredNames.length > 0) {
		checks.push({ ok: true, label: `Secret bundle profiles declared: ${declaredNames.map((n) => `${n} (${(Object.hasOwn(envBundles, n) ? envBundles[n] : overlayBundles[n])?.format ?? "?"})`).join(", ")}` });
		// The rate figure, stated once: what a manager's rate limit counts is job starts.
		checks.push({ ok: true, label: "A project with a secret bundle costs one resolver call per job start (never one per variable), so a secrets manager's rate limit counts job starts: size it for your busiest hour of jobs across every bundled project" });
		if (!triggersPresent) {
			checks.push({ ok: false, label: "secret bundle profiles are declared, but the worker has no triggers file to read secretBundles from", fix: "set PI_TRIGGERS_FILE (or put triggers.json in the worker's folder) on this host -- the worker reads which project holds a bundle from its own copy of that file, so without it no job on this host gets one" });
		}
	}
	if (ambiguous) {
		checks.push({ ok: false, label: `${ambiguousNames.length} secret bundle profile name(s) are declared in both PI_SECRET_BUNDLES and the settings overlay: ${ambiguousNames.join(", ")}`, fix: "remove each name from one of the two (neither source wins a collision) -- until then every bundled project's jobs refuse as secret-bundle-profile-ambiguous" });
	}

	const projectIds = new Set((projects ?? []).map((p) => p?.id));
	for (const id of ids) {
		const b = bundles[id];
		const fromEnv = Object.hasOwn(envBundles, b.profile);
		const fromOverlay = Object.hasOwn(overlayBundles, b.profile);
		const format = fromEnv ? envBundles[b.profile].format : fromOverlay ? overlayBundles[b.profile]?.format : null;
		checks.push({ ok: true, label: `secret bundle ${id}: profile ${b.profile}${format ? ` (${format})` : ""}, project ${b.project}${b.forkReviews === true ? ", fork reviews included" : ""}` });
		if (!fromEnv && !fromOverlay) {
			checks.push({ ok: false, label: `secret bundle ${id} names profile ${b.profile}, which this host does not declare`, fix: "declare it in PI_SECRET_BUNDLES as name:/absolute/path:format (format dotenv or json), on EVERY host that takes this project's jobs -- until then they refuse pre-spend as secret-bundle-profile-unknown" });
		} else if (!fromEnv && !Object.hasOwn(usableOverlay, b.profile)) {
			checks.push({ ok: false, label: `secret bundle ${id} names profile ${b.profile}, declared in the settings overlay but not usable`, fix: roots.length === 0 ? "PI_SECRET_RESOLVER_ROOTS is unset, so the worker uses no overlay-declared resolver: set it, or declare the profile in PI_SECRET_BUNDLES" : "the resolver must be an executable file whose real path sits inside PI_SECRET_RESOLVER_ROOTS" });
		}
		if (projectsError !== null) {
			checks.push({ ok: false, label: `secret bundle ${id} names project ${b.project}, and projects.json does not load`, fix: "fix projects.json (its own line above says why) -- a bundle applies to a project's jobs only once the worker knows the project" });
		} else if (!projectIds.has(b.project)) {
			checks.push({ ok: false, label: `secret bundle ${id} names project ${b.project}, which projects.json does not hold`, fix: "add the project to PI_PROJECTS_FILE, or correct the bundle's project -- until then the bundle reaches no job, while the file reads as granting it" });
		} else {
			const project = projects.find((p) => p?.id === b.project);
			const folders = (project?.members ?? []).filter(isFolderMember);
			if (folders.length > 0) {
				checks.push({ ok: true, warn: true, label: `secret bundle ${id}'s project ${b.project} holds ${folders.length} folder(s), whose local jobs run IN the operator's own folder with the whole bundle in their environment`, fix: "a value the agent writes to .env, .netrc or .git-credentials there lands in your real repository (and in a retained sandbox), and nothing scans for that: keep those folders out of anything you push, or set run.secretBundle: false on their triggers" });
			}
		}
	}

	if (typeof resolveBundle === "function") {
		for (const id of ids) {
			const b = bundles[id];
			let read;
			try {
				read = await resolveBundle({ id, ...b });
			} catch {
				read = { unreachable: true, failure: "spawn" };
			}
			if (read?.ok === true) {
				const names = Object.keys(read.vars).sort();
				checks.push({ ok: true, label: `secret bundle ${id} resolved on this host: ${names.length} variable(s): ${names.join(", ")}` });
			} else if (read?.reserved !== undefined) {
				checks.push({ ok: false, label: `secret bundle ${id} carries ${read.reserved}, a name this deployment reserves`, fix: "rename it in the secrets manager -- every job of the project refuses pre-spend as secret-name-reserved until you do" });
			} else if (read?.profileUnknown !== undefined || read?.ambiguous !== undefined) {
				// Already its own line above.
			} else {
				const what = read?.unreachable ? "could not reach its manager (exit 1, a timeout or a spawn fault: retried at job time)" : `was refused (${read?.failure ?? "unknown"}${read?.name ? `, variable ${read.name}` : ""}${read?.line ? `, line ${read.line}` : ""})`;
				checks.push({ ok: false, label: `secret bundle ${id}'s resolver ${what}`, fix: "run the profile's resolver by hand with the bundle's ref as its argument -- doctor prints no byte of what it printed" });
			}
		}
	}
	return checks;
}
