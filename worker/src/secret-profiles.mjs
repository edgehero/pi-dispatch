/**
 * The operator's declared secret-resolver profiles: parsing, merging, and the path bound (issue #225).
 *
 * A PROFILE is a name and an absolute path to a script the operator wrote. A trigger names the NAME; it
 * can never name the path. That distinction is the whole reason `run.secretsProfile` is allowed to exist:
 * `DES-SERVICE-ENV-SETUP-SEAM` rejected "making this reachable from configuration, which would turn a
 * boot-time root-adjacent exec into something a trigger file could name", and selecting among execs the
 * operator already declared is not naming one.
 *
 * PURE AND FS-FREE, like `triggers.mjs` and for a weaker but real version of its reason: `config.mjs`
 * imports this module, `runtime-settings.mjs` imports `config.mjs`, and `admin/build.mjs` inlines that
 * chain into the published console. Whether a path EXISTS is asked once, in `secrets.mjs`, on the worker
 * that is about to spawn it.
 *
 * `configError` is a local copy rather than an import from `config.mjs`, which imports this module: the
 * cycle would resolve (function declarations hoist) but would be a trap for the next reader. The same
 * duplication, for a related reason, is in `env-allowlist.mjs`.
 */

import { isAbsolute, normalize, sep } from "node:path";

function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

/**
 * A profile name. Deliberately the same charset `triggers.mjs` allows in `run.secretsProfile`, and it has
 * to be: a name that fails here after passing there would be an operator-visible contradiction between two
 * files that are meant to agree. Excluding `,` and `:` is load-bearing rather than tidy, since those are
 * this variable's own separators -- a name carrying either could not round-trip through its declaration.
 */
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Parse `PI_SECRET_PROFILES`: `name:/abs/path,other:/abs/other`. Returns `{ [name]: path }`, empty when
 * unset. Throws (config-tagged, so the worker refuses to boot) on anything malformed.
 *
 * SET-BUT-GARBLED FAILS LOUD, which is `parsePollRepos`' doctrine and matters more here: a silently
 * dropped entry is a profile the operator believes is wired, and every trigger naming it would refuse at
 * delivery time with the operator looking at a line that appears to declare it.
 *
 * Each entry splits on its FIRST colon, so `prod:C:\pi\resolve.cmd` parses on Windows. That is the same
 * drive-letter hazard `config.mjs`'s `delimitedList` exists for, arriving from the other side: there the
 * colon must not be read as a separator, here exactly one of them must be.
 */
export function parseSecretProfiles(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return {};
	const profiles = {};
	for (const entry of String(raw).split(",")) {
		const text = entry.trim();
		if (text === "") continue; // a trailing comma is a typo, not a declaration
		const cut = text.indexOf(":");
		if (cut <= 0) {
			throw configError(`PI_SECRET_PROFILES entries must be name:/absolute/path, got ${JSON.stringify(text)}`);
		}
		const name = text.slice(0, cut).trim();
		const path = text.slice(cut + 1).trim();
		if (!PROFILE_NAME.test(name)) {
			throw configError(`PI_SECRET_PROFILES profile name ${JSON.stringify(name)} may use letters, digits, dot, dash and underscore only`);
		}
		if (name in profiles) {
			throw configError(`PI_SECRET_PROFILES declares ${JSON.stringify(name)} twice -- one of the two is not the resolver you think is running`);
		}
		if (path === "" || !isAbsolutePath(path)) {
			throw configError(`PI_SECRET_PROFILES profile ${JSON.stringify(name)} needs an ABSOLUTE path to its resolver -- a service manager's working directory is not your shell's, so a relative path is a different file on every host`);
		}
		profiles[name] = path;
	}
	return profiles;
}

/** Absolute on this platform, accepting a Windows drive letter or UNC root as `service.mjs` does. */
function isAbsolutePath(path) {
	return isAbsolute(path) || /^([A-Za-z]:[\\/]|\\\\)/.test(path);
}

/**
 * Union the env-declared profiles with the overlay-declared ones, refusing a name that appears in both.
 *
 * NEITHER SOURCE WINS, and that is a deliberate third answer. `runtime-settings.mjs` documents the
 * overlay's precedence as `overlay > env`, so quietly inverting it for this one key would leave two rules
 * in the codebase disagreeing about what an overlay is. But honouring it would let a settings file -- which
 * defaults into the OS temp directory -- redirect a profile the operator wrote in `.env`. So a collision is
 * refused instead, per delivery and naming only the profile name. This project already refuses ambiguity
 * rather than resolving it: `PI_EGRESS` refuses any value but 0 or 1 because "a typo must never leave you
 * believing you have a policy you do not", and two declarations of one profile is exactly that.
 *
 * Returns `{ profiles }` or `{ ambiguous }` naming the first colliding profile.
 */
export function mergeSecretProfiles(envProfiles = {}, overlayProfiles = {}) {
	for (const name of Object.keys(overlayProfiles)) {
		if (name in envProfiles) return { ambiguous: name };
	}
	return { profiles: { ...envProfiles, ...overlayProfiles } };
}

/**
 * Whether `candidate` sits inside one of `roots`. Empty roots means NOTHING passes.
 *
 * FAIL-CLOSED BY DEFAULT is the whole design: with `PI_SECRET_RESOLVER_ROOTS` unset, an overlay-declared
 * profile resolves to no usable path, so the panel can declare nothing and the deployment is env-only. The
 * operator opts in to panel authoring by naming the directory their resolvers already live in. This is
 * `PI_DISPATCH_RUN_ROOTS`' shape, and `DES-PER-TRIGGER-JOB-IMAGE` predicted it: "If a future tool ever
 * takes an image parameter, the allowlist arrives with that tool, and this row is the reason it must."
 *
 * The comparison is on NORMALIZED paths with a separator boundary, so `/opt/pi-evil` does not pass for the
 * root `/opt/pi`. Callers pass a path they have already realpath'd, because normalization alone cannot see
 * through a symlink and this is a boundary, not a hint.
 */
export function withinRoots(candidate, roots = []) {
	if (!Array.isArray(roots) || roots.length === 0) return false;
	const target = normalize(candidate);
	return roots.some((root) => {
		const base = normalize(root).replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "");
		return target === base || target.startsWith(base + sep);
	});
}
