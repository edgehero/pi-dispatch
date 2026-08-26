/**
 * Per-trigger secret references, resolved HOST-SIDE before a container starts (REQ-TRIGGER-SECRETS, #225).
 *
 * A trigger may carry `run.secrets`, a map of environment variable name to an OPAQUE REFERENCE, and
 * `run.secretsProfile`, the name of one resolver the operator declared. The worker runs that resolver once
 * per reference, takes its stdout as the value, and injects the values into the closed container env map
 * exactly as the provider credential is injected. The job holds no manager credential, reaches no vault,
 * and cannot enumerate one -- so `docs/secrets.md`'s rule stays literally true: what crosses the container
 * boundary is a value, never the thing that can fetch values.
 *
 * THE REFERENCE GRAMMAR IS NOT OURS. `op://vault/item/field`, `secret/data/ci#stripe` and a bare name are
 * all correct inputs, because what parses them is a two-line script the operator wrote. #206 refused
 * "endorsing a vendor" and #209 refused "depending on, or blessing, any particular secrets manager -- the
 * seam is a command". This module is that seam, moved from boot time (`DES-SERVICE-ENV-SETUP-SEAM`'s
 * `--env-setup`) to job time, and it must never grow a regex that recognises one manager's notation.
 */

/**
 * The profile a trigger selects when it names none. A single-manager deployment declares one profile
 * called `default` and never writes the field.
 *
 * A LOOKUP KEY, never a fallback: there is deliberately no "if only one profile is declared, use it" rule.
 * `env-allowlist.mjs` records what that costs -- its forge lookup was once an `if gitlab / else github`,
 * and the `else` handed a credential to the wrong host. A rule whose meaning changes the day an operator
 * declares a second profile is that mistake with a slower fuse.
 */
export const DEFAULT_SECRETS_PROFILE = "default";

/**
 * Whether this job asked for secrets at all.
 *
 * EITHER field arms it. `secretsProfile` alone cannot reach a wired worker (parseTriggers refuses a profile
 * that resolves nothing), but this predicate also guards the processor's fail-closed default, which runs
 * under wirings that never saw the validator -- a bare `makeProcessor` in a test, or a job whose data was
 * queued by a different version. Treating a lone profile as unarmed there would silently start a job the
 * operator believes is bound to a vault.
 *
 * Exported so the gate and its default share ONE definition of "armed", which is the discipline
 * `processor.mjs` already keeps for `run.resume` (`=== true`, spelled the same in the gate and in
 * prepare-github, "so the gate and the feature cannot disagree about what armed means").
 */
export function secretsArmed(job) {
	if (typeof job?.secretsProfile === "string" && job.secretsProfile !== "") return true;
	const secrets = job?.secrets;
	return secrets !== null && typeof secrets === "object" && Object.keys(secrets).length > 0;
}
