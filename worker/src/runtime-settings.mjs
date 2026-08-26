import * as nodeFs from "node:fs";
import { dirname } from "node:path";
import { defaultSettingsFile } from "./config.mjs";

/**
 * Runtime-settings overlay: the shared, durable truth between the admin extension and the worker
 * (INT-CONFIG-OVERLAY-CONTRACT, DES-RUNTIME-SETTINGS-FILE-OVERLAY). A flat `settings.json` with ten
 * optional keys -- `model`, `provider` (non-empty strings), `maxTurns`, `dailyCap`, `weeklyCap`,
 * `monthlyCap`, `maxTokens`, `dailyTokenCap` (int >= 1), `concurrency` (int 1-10), `softHoldPct`
 * (int 1-99) -- read by the worker at each job start and written atomically by the admin extension
 * (tmp + rename). `maxTokens`/`dailyTokenCap` are the optional token controls (issue #25).
 *
 * `readOverlay` NEVER throws: a bad settings file returns a discriminated `{ invalid }` rather than an
 * exception, so the processor RETURNS a policy refusal (`settings-overlay-invalid`) instead of letting
 * its catch classify the file as retryable infra and pay to retry a job that can never succeed
 * (CONST-RETRY-INFRA-ONLY). A present-but-unreadable file fails closed -- it never degrades to an empty
 * overlay that would silently restore env's higher `dailyCap` (DES-RUNTIME-SETTINGS-FILE-OVERLAY).
 *
 * Precedence resolved here is overlay > env > default only; `config` already encodes env > default. The
 * `job.data` precedence layer belongs to the processor, not here.
 *
 * Invalid reasons name the offending KEY and its constraint, never the value: settings values may echo
 * operator input, so only key names are safe to surface in logs and refusals (no-pii-in-logs).
 *
 * Custom: overlay validated inline per config.mjs precedent; zod not in deps
 */

export const KNOWN_KEYS = ["model", "provider", "maxTurns", "dailyCap", "weeklyCap", "monthlyCap", "maxTokens", "dailyTokenCap", "concurrency", "softHoldPct"];

/**
 * Overlay keys the OVERLAY accepts but no model-callable tool may set. `secretProfiles` maps a profile name
 * to an absolute path to a script the worker executes, which is plainly "a capability the model would
 * GAIN" -- the test `admin/src/index.ts` already applies to `run.image` and `run.resume`.
 *
 * The mechanism is the OMISSION from KNOWN_KEYS above: `dispatch_set` narrows its open string parameter
 * with `KNOWN_KEYS.includes(...)`, and the panel's generic settings dialog is a `ui.select` over the same
 * array, so leaving the key out closes both doors at once. This constant exists so that omission has a NAME
 * and a reason attached to it. Without one, `KNOWN_KEYS` silently stops meaning "keys the overlay accepts"
 * and the next contributor tidies the gap away as an oversight.
 *
 * A profile is declared through the operator-typed `/dispatch` command instead, which pi reaches only from
 * its own user-input path, and every declared path is bounded by PI_SECRET_RESOLVER_ROOTS in the worker.
 */
export const OPERATOR_ONLY_KEYS = ["secretProfiles"];

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

function isIntAtLeast(value, min) {
	return Number.isInteger(value) && value >= min;
}

function isIntInRange(value, min, max) {
	return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The absolute path of the settings overlay. Mirrors config.mjs: `PI_SETTINGS_FILE` wins, an unset or
 * empty value falls back to the shared default so the admin extension and the worker resolve the same
 * path without either coupling to the other.
 */
export function settingsFilePath(env = process.env) {
	return env.PI_SETTINGS_FILE || defaultSettingsFile();
}

/**
 * Validate a parsed overlay against the key contract, returning the sanitized overlay (known keys only)
 * or `{ invalid }`. Shared by `readOverlay` (post-parse) and `writeOverlay` (pre-write) so a single
 * definition governs both directions. Unknown keys are dropped and logged, leaving the overlay valid;
 * any invalid known key fails the WHOLE object.
 */
function validateOverlay(candidate, log) {
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
		return { invalid: "root must be a JSON object" };
	}
	const overlay = {};
	for (const key of Object.keys(candidate)) {
		const value = candidate[key];
		switch (key) {
			case "model":
			case "provider":
				if (!isNonEmptyString(value)) return { invalid: `${key} must be a non-empty string` };
				overlay[key] = value;
				break;
			case "maxTurns":
			case "dailyCap":
			case "weeklyCap":
			case "monthlyCap":
			case "maxTokens":
			case "dailyTokenCap":
				// Overlay caps are positive ints. A window/cap is DISABLED by absence, not by a 0 -- `unset weeklyCap`
				// drops the key so it falls through to env, which unset means the window is off (config.mjs). The
				// token knobs (maxTokens, dailyTokenCap) follow the same "absent = disabled" shape (issue #25).
				if (!isIntAtLeast(value, 1)) return { invalid: `${key} must be an integer >= 1` };
				overlay[key] = value;
				break;
			case "concurrency":
				// Range-checked here, not via config's positiveInt: that helper has no upper bound and parses
				// env strings, so it cannot enforce the 1-10 ceiling this key carries over a JSON number.
				if (!isIntInRange(value, 1, 10)) return { invalid: "concurrency must be an integer 1-10" };
				overlay[key] = value;
				break;
			case "secretProfiles": {
				// REQ-TRIGGER-SECRETS. `{ [name]: "/abs/path" }`, the panel-authored half of the resolver
				// table. The shape is checked here and the PATH BOUND is not: whether a path is allowed is
				// PI_SECRET_RESOLVER_ROOTS' question, and it is asked in the worker at resolution time rather
				// than here, because this same validator runs inside the admin extension where a "yes" would
				// prove nothing about the host the job will run on.
				//
				// An invalid value fails the WHOLE overlay, which is this function's documented rule and is
				// deliberate here too: a half-read profile table is a deployment that believes it has a
				// resolver it does not.
				if (value === null || typeof value !== "object" || Array.isArray(value)) {
					return { invalid: "secretProfiles must be an object mapping profile names to resolver paths" };
				}
				for (const name of Object.keys(value)) {
					if (!/^[A-Za-z0-9._-]+$/.test(name)) {
						return { invalid: "secretProfiles names may use letters, digits, dot, dash and underscore only" };
					}
					if (typeof value[name] !== "string" || value[name].trim() === "") {
						return { invalid: `secretProfiles.${name} must be a non-empty absolute path` };
					}
				}
				overlay[key] = { ...value };
				break;
			}
			case "softHoldPct":
				// A percentage of each active cap; 100 would equal the hard wall (no band) and 0 has no meaning,
				// so the enforced band is 1-99. Absence disables the soft-hold entirely.
				if (!isIntInRange(value, 1, 99)) return { invalid: "softHoldPct must be an integer 1-99" };
				overlay[key] = value;
				break;
			default:
				log("settings_overlay_unknown_key", { key });
		}
	}
	return { overlay };
}

/**
 * Read the overlay at `path`. Returns `{ overlay }` (known keys only) on success, or `{ invalid }` with
 * a key-only reason on failure. NEVER throws.
 *
 * A missing file (ENOENT) is the normal empty overlay `{ overlay: {} }`. Any OTHER read error
 * (EACCES, EISDIR, ...) is `{ invalid }`: a present-but-unreadable file must fail closed, not silently
 * become an empty overlay that restores env's higher `dailyCap`. Unparseable JSON, a non-object root,
 * or an invalid known key is `{ invalid }`.
 */
export function readOverlay(path, { fs = nodeFs, log = () => {} } = {}) {
	let text;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (err) {
		if (err?.code === "ENOENT") return { overlay: {} }; // missing file is a normal empty overlay
		return { invalid: `settings file unreadable (${err?.code ?? "read-error"})` };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { invalid: "settings file is not valid JSON" };
	}
	return validateOverlay(parsed, log);
}

/**
 * Resolve the ten effective settings from `config` and a validated `overlay`: overlay value where the
 * overlay sets it, else the config value. Precedence is overlay > env > default only -- `config`
 * already carries env > default. `weeklyCap`/`monthlyCap`/`maxTokens`/`dailyTokenCap`/`softHoldPct` may
 * resolve to `null` (their config value when unset), meaning that window / cap / band is disabled.
 * `job.data` is NOT merged here; that layer is the processor's.
 */
export function effectiveSettings(config, overlay) {
	const o = overlay ?? {};
	return {
		provider: o.provider ?? config.provider,
		model: o.model ?? config.model,
		maxTurns: o.maxTurns ?? config.maxTurns,
		dailyCap: o.dailyCap ?? config.dailyCap,
		weeklyCap: o.weeklyCap ?? config.weeklyCap,
		monthlyCap: o.monthlyCap ?? config.monthlyCap,
		maxTokens: o.maxTokens ?? config.maxTokens,
		dailyTokenCap: o.dailyTokenCap ?? config.dailyTokenCap,
		concurrency: o.concurrency ?? config.concurrency,
		softHoldPct: o.softHoldPct ?? config.softHoldPct,
	};
}

/**
 * Write `candidate` to `path` atomically. Validates with the same rules as `readOverlay` (an invalid
 * candidate returns `{ invalid }` and touches no file; an empty `{}` candidate is valid), serialises
 * the validated overlay with 2-space indent and a trailing newline, writes a same-directory
 * `<path>.tmp`, then renames it over `path`. NEVER throws.
 *
 * The rename is retried once on EPERM to ride out a Windows AV/indexer briefly locking the destination;
 * a second failure surfaces as `{ invalid }`, never a throw. Returns `{ ok: true }` on success.
 */
export function writeOverlay(path, candidate, { fs = nodeFs, log = () => {} } = {}) {
	const result = validateOverlay(candidate, log);
	if (result.invalid) return { invalid: result.invalid };

	try {
		fs.mkdirSync(dirname(path), { recursive: true });
	} catch (err) {
		return { invalid: `settings dir unwritable (${err?.code ?? "mkdir-error"})` };
	}

	const tmp = `${path}.tmp`;
	const data = `${JSON.stringify(result.overlay, null, 2)}\n`;
	try {
		fs.writeFileSync(tmp, data);
	} catch (err) {
		return { invalid: `settings write failed (${err?.code ?? "write-error"})` };
	}

	try {
		fs.renameSync(tmp, path);
	} catch (err) {
		if (err?.code !== "EPERM") return { invalid: `settings rename failed (${err?.code ?? "rename-error"})` };
		try {
			fs.renameSync(tmp, path); // single retry: Windows AV/indexer lock is transient
		} catch (retryErr) {
			return { invalid: `settings rename failed (${retryErr?.code ?? "rename-error"})` };
		}
	}
	return { ok: true };
}
