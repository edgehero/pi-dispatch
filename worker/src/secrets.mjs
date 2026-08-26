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
 *
 * THE RESOLVER'S EXIT CODE IS THE RUNNER'S EXIT CODE. `INT-RUNNER-EXIT-CODE-PROTOCOL` is reused verbatim
 * rather than invented here: 0 carries the value, 1 says "I could not reach my manager" and RETRIES, 2 says
 * "that reference is wrong" and does not. Folding every nonzero exit into a refusal, which is the obvious
 * design, breaks `CONST-RETRY-INFRA-ONLY` in the expensive direction: a vault unreachable for twenty
 * seconds would permanently burn a delivery that BullMQ's `attempts: 2` would have recovered, and a webhook
 * does not redeliver itself. `docs/secrets.md` already tells operators to ask what a manager does to their
 * exit code, so the question is one they are pointed at rather than one this invents for them.
 */

import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { EXIT_INFRA, EXIT_POLICY } from "./exit-code.mjs";
import { mergeSecretProfiles, withinRoots } from "./secret-profiles.mjs";

/**
 * The largest value a resolver may print. `outbox.mjs` caps a request file at 4 KiB, which is too small
 * here (a 4096-bit PEM chain, a service-account JSON -- this project already carries
 * `GITHUB_APP_PRIVATE_KEY` as an env value), and `materialize.mjs` allows git 16 MiB, which per reference
 * is a memory bomb. 64 KiB holds any real credential and bounds a full 16-reference job at 1 MiB.
 *
 * On overflow the child is killed and the job refuses. NEVER TRUNCATED: a silently shortened credential is
 * the exact failure this gate exists to prevent, and it is the direction `execFile`'s own `maxBuffer` takes.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

/** SIGTERM, then this long, then SIGKILL. doctor's capture helper does a bare kill() with no escalation, */
/** which is fine for a diagnostic and not for something holding a pipe in front of a paid container. */
const KILL_GRACE_MS = 2000;

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

/**
 * Run one resolver against one reference. Resolves a discriminated result; never throws, never rejects.
 *
 * `failure` is OUR vocabulary, never the resolver's words:
 *   - `policy`   the reference is wrong, absent or denied (exit 2), or the output was empty, oversized,
 *                or carried a NUL. Determinate: retrying cannot change the answer.
 *   - `infra`    the manager could not be reached (exit 1), an unrecognised exit, a spawn fault, a timeout.
 *
 * An unrecognised exit code is INFRA on `decideRetry`'s own reasoning: a runner that exits with something
 * we do not recognise is one we cannot reason about, and retrying-then-alerting beats accepting it as done.
 */
function runResolver(spawnFn, path, reference, { timeoutMs, hostEnv, signal }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(path, [reference], {
				// stdin IGNORED, so a resolver that prompts (`op signin`, `vault login`) dies at once rather
				// than blocking to the timeout behind an invisible password prompt on a headless host.
				//
				// stdout and stderr are SEPARATE pipes. doctor's capture helper merges them, and its stated
				// reason (gh moves human output between the two) does not survive here: a merge splices a
				// deprecation warning into the secret, and because the value is printed nowhere the corruption
				// stays invisible until the container authenticates with a wrong string and the agent writes a
				// plausible report about why the integration is down.
				stdio: ["ignore", "pipe", "pipe"],
				// The worker's own environment, verbatim. The resolver has to authenticate to the manager, and
				// the whole architecture of docs/secrets.md is that its credential lives here. Narrowing would
				// mean naming each vendor's variables, which is blessing vendors, and would be theatre anyway:
				// a script running as the worker user can read /proc/self/environ. What it does NOT see is a
				// forge token, and that is free rather than arranged -- this runs before the mint.
				env: hostEnv,
				// An ARRAY and never a shell string: no interpolation, no injection. docker-run.mjs states the
				// rule for the only other place this project spawns on the job path.
				shell: false,
			});
		} catch {
			resolve({ value: null, failure: "infra", detail: "spawn", code: null, stderrBytes: 0 });
			return;
		}

		const chunks = [];
		let bytes = 0;
		let stderrBytes = 0;
		let done = false;
		let overflowed = false;
		let killTimer = null;

		const finish = (result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
			resolve(result);
		};
		// SIGTERM, then SIGKILL after a grace. The kill timer is deliberately NOT cleared by `finish`: the
		// promise settles now, and the escalation still has to land on a child that ignored the first signal.
		const stop = (why) => {
			try {
				child.kill();
			} catch {}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS);
			killTimer.unref?.();
			finish({ value: null, failure: why === "overflow" ? "policy" : "infra", detail: why, code: null, stderrBytes });
		};

		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const onAbort = () => stop("aborted");
		signal?.addEventListener?.("abort", onAbort, { once: true });

		child.stdout?.on("data", (d) => {
			bytes += d.length;
			if (bytes > MAX_SECRET_BYTES) {
				overflowed = true;
				stop("overflow");
				return;
			}
			chunks.push(d);
		});
		// A COUNTER, never a string. Keeping the bytes would leave the resolver's own words one refactor away
		// from a public issue comment, and a resolver's stderr can echo the reference, the vault path, or in a
		// careless tool the value itself. A count still tells an operator to go run it by hand.
		child.stderr?.on("data", (d) => (stderrBytes += d.length));
		child.on("error", () => finish({ value: null, failure: "infra", detail: "spawn", code: null, stderrBytes }));
		child.on("close", (code) => {
			if (overflowed || done) return;
			if (code === EXIT_POLICY) return finish({ value: null, failure: "policy", detail: "exit", code, stderrBytes });
			if (code !== 0) return finish({ value: null, failure: "infra", detail: "exit", code, stderrBytes });
			const value = stripOneNewline(Buffer.concat(chunks).toString("utf8"));
			// Exit 0 printing nothing is the silent-no-op class: a vault CLI that says nothing and succeeds
			// would otherwise bind an empty variable and let the job run as though it were configured.
			if (value === "") return finish({ value: null, failure: "policy", detail: "empty", code, stderrBytes });
			// `-e NAME=VALUE` is an execve argv element and truncates at a NUL, silently handing the container
			// a shortened credential. Interior NEWLINES are fine and must stay fine: it is an argv, not a
			// shell string, and a PEM has them.
			if (/\u0000/.test(value)) return finish({ value: null, failure: "policy", detail: "nul", code, stderrBytes });
			finish({ value, failure: null, detail: null, code, stderrBytes });
		});
	});
}

/**
 * Strip EXACTLY ONE trailing newline, and a `\r` before it only if that strip happened.
 *
 * Every CLI in this space terminates with one newline (`vault kv get -field=`, `pass show`, `gcloud secrets
 * versions access`), and leaving it in puts a newline inside an HTTP header value: some clients reject it,
 * some send it, and the failure names nothing. `op read --no-newline` prints none and must keep working,
 * which is why this is idempotent rather than a loop.
 *
 * NOT `.trim()`, in either direction. A passphrase may legitimately begin or end with a space, and a PEM
 * ends with a newline whose removal must not cascade into the body. Silently mangling a credential is the
 * same class of harm as splicing stderr into it.
 */
function stripOneNewline(text) {
	if (text.endsWith("\r\n")) return text.slice(0, -2);
	if (text.endsWith("\n")) return text.slice(0, -1);
	return text;
}

/**
 * Build the pre-spend resolver the processor injects.
 *
 * `(job) => { ok, secrets } | { profileUnknown } | { ambiguous } | { unresolved, ... } | { unreachable, ... }`
 *
 * `envProfiles` is parsed at BOOT by `config.mjs`; `overlayProfiles` arrives per job, because the settings
 * overlay is read at each job start (INT-CONFIG-OVERLAY-CONTRACT) and an operator who declares a profile in
 * the panel should not have to restart the worker. The processor never reads a file: the table arrives
 * already parsed, exactly as `sessionsDir` does.
 *
 * SEQUENTIAL, in the operator's own writing order, deduped by unique reference. Not throughput: with two
 * broken references `Promise.all` refuses on whichever loses the race, so one broken trigger would blame a
 * different variable on different runs. Sequential always names the first, so an operator fixes them in the
 * order they wrote them. It also caps the blast radius of a refusal at the references BEFORE the failure,
 * rather than pulling all sixteen live credentials into memory for a job that will never run, and spares
 * every managed vault a burst of N x PI_CONCURRENCY parallel reads nobody sized for. The cost is nil: this
 * band is followed immediately by a git clone measured in tens of seconds.
 *
 * NOTHING IS ZEROED, and saying so is the honest half. JS strings are immutable and unzeroable; pretending
 * otherwise would be theatre. What IS true: the returned map is a block-scoped local in `runJob`, never
 * attached to `job` or `prepared`, never returned in a result, never passed to `log`, `comment` or
 * `recordRun` -- and `buildRecord` is an explicit literal with no spread, so it cannot pick it up by
 * accident. That property is load-bearing now, not incidental.
 */
export function makeSecretsResolver({
	envProfiles = {},
	roots = [],
	timeoutMs = 10000,
	spawnFn = spawn,
	hostEnv = process.env,
	// Injected so the executable probe is testable without a real script on disk. `statSync`, NOT `lstat`,
	// which is a deliberate divergence from processor.mjs's isReadableDir: that one judges a symlinked
	// DIRECTORY on its own inode, while this must answer the same question `spawn` will ask, and `spawn`
	// follows symlinks -- so `lstat` would refuse an ordinary /usr/local/bin/op -> ../Cellar/... The mode is
	// deliberately NOT checked here: a group- or world-writable resolver is a doctor WARNING, on the
	// env-setup precedent, because refusing a job over a mode bit at job time is a new class of refusal.
	realExecutablePath = (p) => {
		const real = realpathSync(p);
		const st = statSync(real);
		return st.isFile() && (st.mode & 0o111) !== 0 ? real : null;
	},
	log = () => {},
} = {}) {
	return async function resolveSecrets(job, { signal, overlayProfiles = {} } = {}) {
		const merged = mergeSecretProfiles(envProfiles, overlayProfiles);
		if (merged.ambiguous) return { ambiguous: merged.ambiguous };

		const wanted = typeof job?.secretsProfile === "string" && job.secretsProfile !== "" ? job.secretsProfile : DEFAULT_SECRETS_PROFILE;
		const declared = merged.profiles[wanted];
		// A LOOKUP, never a fallback. There is deliberately no "if only one profile is declared, use it"
		// rule: env-allowlist.mjs records what the last `else` of that shape cost, and a default whose
		// meaning changes the day a second profile appears is that mistake with a slower fuse.
		if (typeof declared !== "string") return { profileUnknown: wanted };

		let path;
		try {
			path = realExecutablePath(declared);
		} catch {
			path = null;
		}
		if (!path) return { profileUnknown: wanted };
		// The bound is checked on the REALPATH, and in the WORKER rather than only where a profile is
		// written. A panel-side check alone would be cosmetic: the settings overlay defaults into the OS
		// temp directory, so on a multi-user host the directory can be pre-created by anyone. Checking here
		// caps a tampered overlay at "choose among scripts the operator allowlisted" instead of "name any
		// executable on the host". An env-declared profile is exempt: PI_SECRET_PROFILES already lives
		// beside the forge tokens and the App key, so requiring roots for it would bound nothing and would
		// break every deployment that never wanted panel authoring.
		const fromOverlay = !(wanted in envProfiles);
		if (fromOverlay && !withinRoots(path, roots)) return { profileUnknown: wanted };

		const references = job?.secrets ?? {};
		const secrets = {};
		const seen = new Map();
		for (const [name, reference] of Object.entries(references)) {
			if (seen.has(reference)) {
				// Two names sharing one reference resolve once, so they are guaranteed identical rather than
				// straddling a rotation that lands between two reads.
				secrets[name] = seen.get(reference);
				continue;
			}
			const outcome = await runResolver(spawnFn, path, reference, { timeoutMs, hostEnv, signal });
			if (outcome.failure) {
				// The NAME, our own failure vocabulary, the script's small integer exit and a byte COUNT.
				// Never the resolver's words, never the reference, never the path (no-pii-in-logs).
				log("secret_resolve_failed", { name, failure: outcome.failure, detail: outcome.detail, code: outcome.code ?? null, stderrBytes: outcome.stderrBytes });
				const shape = { failure: outcome.detail, code: outcome.code ?? null, stderrBytes: outcome.stderrBytes };
				// The whole job refuses, never a partial set: a job missing one of three secrets fails deep
				// inside a paid container in a way that reads as a flow bug.
				return outcome.failure === "infra" ? { unreachable: name, ...shape } : { unresolved: name, ...shape };
			}
			seen.set(reference, outcome.value);
			secrets[name] = outcome.value;
		}
		return { ok: true, secrets };
	};
}
