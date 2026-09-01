import { DEFAULT_BACKEND, DOCKER_NEVER_STARTED_EXITS } from "./backends.mjs";
import { lstatSync } from "node:fs";
import { checkTokenCap, recordTokenSpend, releaseBudget, reserveBudget } from "./budget.mjs";
import { configError } from "./config.mjs";
import { scopeKeyPrefix } from "./scoped-limits.mjs";
import { DEFAULT_SECRETS_PROFILE, secretsArmed } from "./secrets.mjs";
import { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "./exit-code.mjs";

/**
 * The job orchestration. Deliberately a pure-ish function over INJECTED side-effecting deps, so
 * the money-safety ORDER can be tested without GitHub, Docker, or Redis.
 *
 * The order is the contract, and every step before `runContainer` must be free of provider spend:
 *
 *   0. refuse a job image this host does not have  -- INT-CONTAINER-RUNTIME-CONTRACT
 *   1. REFUSE an armed `run.resume` with no session store to persist into (the one fail-CLOSED case)
 *                                                 -- REQ-RESUMABLE-SESSION
 *   2. mint a scoped token (GitHub jobs, and local jobs opted in via `github: true`)
 *                                                 -- CONST-TOKEN-SCOPED-PER-JOB
 *   3. REFUSE an unprotected default branch (GitHub jobs only -- a local job has no repo)
 *                                                 -- REQ-BRANCH-PROTECTION-PRECONDITION
 *   4. resolve the default-branch SHA (fresh API), clone at it, materialise .pi/, write the prompt
 *   5. reserve a budget slot                      -- CONST-BUDGET-BEFORE-TOKENS
 *   6. ONLY NOW run the container (the only step that spends provider tokens)
 *   7. map the container exit code to retry-vs-success
 *
 * Budget is reserved as late as possible but strictly before the container, so a refusal from an
 * earlier free gate (unprotected repo, an armed resume with no store, clone failure) never consumes a
 * daily slot. The container is the only thing that spends money, so "before tokens" means "before this
 * line".
 *
 * Returns a result object on a non-retryable outcome; THROWS on a retryable (infra) one so BullMQ
 * retries per `attempts`. The caller (the BullMQ processor) turns the thrown/returned distinction
 * into the queue's retry behaviour -- that is INT-RUNNER-EXIT-CODE-PROTOCOL.
 */
export async function runJob(job, deps) {
	const {
		redis,
		caps, // { day, week, month }; week/month null when that window is disabled (REQ-SPEND-CAPS-MULTI-WINDOW)
		softHoldPct, // int 1-99 or null; the soft-hold band applied to every active window
		tokenCap = null, // int or null; the daily TOKEN cap (issue #25). Check-AFTER, so it gates the NEXT job on prior spend
		// { scope, caps: { day, week, month } } | null -- this job's scoped budget windows (issue #242,
		// INT-SCOPED-LIMITS-FILE-CONTRACT), resolved by the wiring from the same watched-limits snapshot the
		// pickup gate read. Null when the file is unset or the scope's row is concurrency-only; the default
		// keeps an unwired processor byte-identical. The folder MUTEX does not live here -- it is the pickup
		// gate's, pre-everything; this is only the money half.
		scopedCaps = null,
		recordSpend = recordTokenSpend, // injected so the post-container INCRBY is testable/stubbable
		// (job) => { ok } | { missing: <ref> } | { unavailable: <ref> }. The pre-spend check that the image
		// this job names is on this host (image-preflight.mjs). Default admits everything, so a wiring that
		// omits it behaves exactly as before -- the container's own failure stays the backstop.
		imagePreflight = async () => ({ ok: true }),
		// (job) => { ok } | { refused, at, jobId }. The one-shot pre-spend check (issue #231,
		// DES-ONE-SHOT-DISARM-IN-THE-FILE). Default admits everything -- an unwired processor behaves
		// exactly as before, and the gate below only calls it for a job whose matched rule was a
		// one-shot, so the default is never a probe running on every delivery.
		checkOnceSpent = async () => ({ ok: true }),
		// Issue #230. Admit-everything by default, like checkOnceSpent above and for its reason: an
		// unwired seam must not refuse, and the wiring is what turns the check on.
		checkWaitSkew = async () => ({ ok: true }),
		// REQ-EGRESS-ALLOWLIST. Default admits everything, so a wiring that omits it behaves exactly as a
		// deployment with no egress policy does -- which is also what the real factory returns when unarmed.
		egressPreflight = async () => ({ ok: true }),
		// (session, { piVersion, context }) => { promoted, reason, bytes }. Promotes this job's transcript back into
		// the store, on a COMPLETED exit only. Never throws. The default is a no-op so a wiring that omits
		// it behaves exactly as before -- no store, no promotion, no session in the record.
		promoteSession = () => null,
		// The session store's root, or null when the feature is unavailable (REQ-RESUMABLE-SESSION). Read
		// ONLY to answer the fail-closed gate below -- nothing here opens it, and it never reaches the
		// container env (docker-run.mjs mounts a per-job COPY, never the store).
		//
		// The default is the env read config.mjs itself performs (`env.PI_SESSIONS_DIR || null`) rather than
		// a bare `null`, and the difference is not cosmetic. A `null` default would make the gate refuse
		// EVERY armed job under any wiring that does not pass this key -- a false refusal that looks exactly
		// like the true one -- whereas the env is the single source both readers derive from, so the two
		// cannot disagree about whether a store exists. A wiring may still pass `sessionsDir` explicitly to
		// make the seam visible; it resolves to the same value.
		sessionsDir = process.env.PI_SESSIONS_DIR || null,
		// REQ-PER-TRIGGER-SKILLS. Injected so the pre-spend gate is testable without a real directory, and
		// lstat rather than stat so a symlinked skillsDir is judged on its own inode -- the habit copy-tree.mjs,
		// outbox.mjs and sandbox-store.mjs all keep. A throw is a refusal: an unreadable path is still absent
		// as far as this job is concerned.
		isReadableDir = (p) => {
			try {
				return lstatSync(p).isDirectory();
			} catch {
				return false;
			}
		},
		// (job) => { ok: true, secrets } | { profileUnknown } | { unresolved, ... }. The wiring binds the
		// abort signal into it (index.mjs), the way it binds name+signal into runContainer.
		// REQ-TRIGGER-SECRETS. Resolves this trigger's `run.secrets` references through the operator's own
		// resolver, HOST-SIDE, before anything spends. Injected so the gate is testable without a real script.
		//
		// The default FAILS CLOSED, deliberately unlike imagePreflight's and egressPreflight's
		// admit-everything defaults, and for the reason the sessionsDir default states above: an admitting
		// default would let a job that armed run.secrets start with those variables UNSET under any wiring
		// that omits this key. That is a false success which looks exactly like the feature working, and it
		// is the inversion this whole gate exists to prevent. It can be UNCONDITIONALLY refusing because the
		// gate below only calls it when the job is armed -- putting the arming test in the default instead
		// would leave an INJECTED resolver running on every job, which is how a probe nobody wanted starts
		// spawning a subprocess per delivery to learn nothing.
		resolveSecrets = async (job) => ({ profileUnknown: job.secretsProfile ?? DEFAULT_SECRETS_PROFILE }),
		// #227. Which backends this deployment BLESSED (PI_BACKENDS). Defaults to the one name every
		// deployment already runs rather than to admit-everything: a wiring that says nothing blesses
		// `local` only, so a job naming anything else is refused instead of running somewhere the operator
		// never approved. That is the same fail-closed direction `resolveSecrets` above defaults in, and it
		// is safe to default at all only because the gate below fires ONLY when a job names a backend --
		// an unflagged job never consults this list.
		blessedBackends = [DEFAULT_BACKEND],
		// #227. The exit codes THIS JOB'S venue uses for "the runner never ran" -- a function of the job,
		// not of the wiring, because which venue ran it is a per-job fact and the registry resolves it per
		// job for every other backend function too. Docker's triple is the default because it is the only
		// runtime this repo ships, so a wiring that omits this keeps today's behaviour exactly; an adapter
		// that normalises to `container-never-started` itself returns an empty list.
		neverStartedExits = () => DOCKER_NEVER_STARTED_EXITS,
		// (job) => scoped short-lived token. Takes the JOB, not the repo: which forge mints -- and therefore
		// which credential the container gets -- is a property of `job.kind`, and only the wiring knows the
		// map. Called for forge-backed jobs and for local jobs opted in via `github: true`; unflagged local
		// jobs never mint (token stays null).
		mintToken,
		isDefaultBranchProtected, // (job, token) => boolean; same reason -- the forge is the job's, not the process's
		prepareWorkspace, // (job, token) => { workspaceDir, jobDir }  (clone+materialise+prompt)
		// runContainer({ job, token, prepared, secrets, name, signal }) => { code, aborted, turns, tokens, session, usage, context }.
		// `secrets` is the resolved map from the gate above: values, already fetched, host-side. It MUST honour
		// `signal`: stop the container on abort, and reject/exit promptly if `signal.aborted` is already
		// true at entry (the timeout can fire during a slow prepare). The wiring injects name + signal.
		runContainer,
		cleanup, // (dirs) => void
		comment, // (job, text) => void   (issue status; no-op for local jobs)
		log = () => {},
		// The outbox chain collector (INT-OUTBOX-CONTRACT). No-op default so a job whose wiring omits it --
		// or a github job with no /outbox -- chains nothing. It NEVER throws (outbox.mjs), so its counts are
		// additive telemetry that can never flip the parent's completed outcome (CONST-RETRY-INFRA-ONLY).
		collectChain = async () => ({ enqueued: 0, refused: 0 }),
		now = new Date(),
	} = deps;

	// "Forge-backed" is the negation of local, not an enumeration of forges: a job that is not editing a
	// folder on this host is working against a remote, and every gate below applies for the same reason
	// regardless of WHICH remote. Written this way so a new forge inherits the gates rather than having to
	// be added to them -- the failure mode of an enumeration is a forge that silently skips a money gate.
	const isForgeBacked = job.kind !== "local";
	// A local job opted in via `github: true` (cron trigger opt-in, INT-TRIGGERS-FILE-CONTRACT) mints the
	// same scoped per-job token the github path mints (CONST-TOKEN-SCOPED-PER-JOB). Unflagged local jobs
	// stay tokenless, exactly as before.
	const wantsForgeToken = isForgeBacked || job.github === true;
	let token = null;
	let prepared = null;
	let reserved = false;
	let scopedReserved = false;

	try {
		// The one-shot pre-spend check (issue #231), FIRST on the ladder: one file read, cheaper than
		// the docker inspect below, free, determinate, credential-less. Only a FOREIGN positive
		// disarmed mark refuses -- the check excuses this queue job's own id, so a retry of the
		// delivery that spent the trigger still runs (attempts:2 stays attempts:2) -- and anything
		// unreadable or changed means "run": fail-open, because the disarm writer owns the loud
		// refusals, and a broken read must never wedge every once job. In the compose topology the
		// receiver reads a dead inode until restart, so this check is the once-enforcement layer
		// there, not optional hardening.
		if (job.trigger?.matched?.once === true) {
			const spent = await checkOnceSpent(job);
			if (spent.refused) {
				// Commented like every sibling policy refusal: explainability is this refusal's whole
				// purpose, and only a DISTINCT re-close reaches it past the GUID dedup, so the noise
				// bound is the operator's own reopen-close rate. `at`/`jobId` are harness-written
				// provenance, never payload text.
				await comment(job, `Refused: this one-shot trigger was already spent${spent.at ? ` at ${spent.at}` : ""}${spent.jobId ? ` by job ${spent.jobId}` : ""}. The close that armed it has already produced a run; delete on.disarmed from the trigger entry to re-arm it. Not run.`);
				log("refused_once_already_spent", { triggerIndex: job.trigger?.matched?.index ?? null });
				return { outcome: "policy", reason: "once-already-spent", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// The wait-skew check (issue #230), second on the ladder and for the first one's reasons: the same
		// file read, free, determinate, credential-less, and pre-spend. It answers a question no other layer
		// can: does the AUTHORED trigger carry wait conditions this job arrived without? That happens when a
		// service below the version floor dropped the field as an unknown key, and the resulting run is
		// byte-identical to a correct one everywhere it is recorded -- so this refusal is the only thing
		// standing between a stale receiver and a paid job that ran when the operator wrote "wait".
		{
			const skew = await checkWaitSkew(job);
			if (skew.skewed) {
				// Named for the operator, not the payload: how many conditions were authored, never what
				// they say. The fix is a version, so the comment says which one.
				// The message names BOTH causes, because the more likely one is not a version at all. In the
				// compose topology the receiver's single-file `:ro` mount pins a dead inode, so an operator
				// who ADDS `waitFor` to an existing rule gets this refusal on every delivery from a service
				// that is perfectly up to date and merely holding an older copy of the file. Naming only the
				// version would send them looking for an upgrade they do not need.
				await comment(job, `Refused: this trigger declares ${skew.conditions} wait condition${skew.conditions === 1 ? "" : "s"}, but the job reached the worker without them, which means it would have run immediately. Either a service in this deployment is below the version that carries the field, or one is still running against an older copy of the triggers file and needs restarting. Not run.`);
				log("refused_wait_skew", { triggerIndex: job.trigger?.matched?.index ?? null, conditions: skew.conditions });
				return { outcome: "policy", reason: "wait-skew", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false };
			}
		}

		// #227. WHERE this job wants to run, against what this deployment blessed. FREE, determinate and
		// credential-less, so it precedes the image inspect below for that gate's own stated reason: a job
		// that names a venue this host will not use must refuse before anything spawns, mints or clones.
		//
		// The LOADER already refused a name this build does not know; what it could not check is PI_BACKENDS,
		// which is a per-host setting a reviewed file must not be refused over -- the same split
		// `run.secretsProfile` draws between its charset check at load and `secret-profile-unknown` here.
		//
		// Enforced HERE and not only in the panel's picker, because `DES-PER-TRIGGER-SECRET-PROFILE` says the
		// overlay is not the reviewed artifact: a tool-side allowlist bounds what an operator can pick, and
		// this bounds what actually runs.
		if (job.backend !== undefined && !blessedBackends.includes(job.backend)) {
			await comment(job, `Refused: this trigger asks to run on the "${job.backend}" backend, which this deployment does not bless. Not run.`);
			// The backend NAME is operator-authored config, never payload, so naming it is PII-safe -- the
			// same class as the image ref below.
			log("refused_backend_unblessed", { backend: job.backend, blessed: blessedBackends });
			return { outcome: "policy", reason: "backend-unblessed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// The job image must exist on THIS host before anything else happens. Free, determinate and
		// credential-less, so it precedes the mint, the clone and the reservation: a host that cannot run the
		// image refuses without minting a credential it will not use, cloning a repo it will not read, or
		// burning a cap slot. Jobs run with --pull=never (docker-run.mjs), so an absent image is never
		// fetched -- this refusal IS the whole diagnosis, not a race with a background pull.
		const img = await imagePreflight(job);
		// The image's declared pi version, read on the inspect the preflight already ran. Needed BEFORE the
		// container starts, because a transcript written by a different pi may hold tool-call arguments the
		// current schema no longer accepts -- so the resume has to be refused, not repaired mid-run. Null
		// when the image declares none, which downstream means "never resume": the safe direction.
		const piVersion = img.piVersion ?? null;
		if (img.missing) {
			await comment(job, `Refused: the job image "${img.missing}" is not present on the worker host. Not run.`);
			log("refused_image_missing", { image: img.missing });
			// The image ref is operator-authored config (PI_JOB_IMAGE), never payload, so naming it is PII-safe
			// -- the same class as `repo` above.
			// exitCode/turns/tokens null and budgetReserved false: refused pre-container AND pre-reserve.
			// provider/model ride every terminal result from here down (INT-RUN-HISTORY-FILE-CONTRACT):
			// runJob's `job` IS the effectiveJob (index.mjs), so these are the HOST-effective,
			// overlay-resolved dispatch facts -- never anything a container printed -- and even a
			// pre-container refusal attributes which (provider, model) it was dispatched for. There is
			// deliberately NO `usage` key on the pre-container branches: no run, no ledger, and
			// buildRecord defaults the absent field to null.
			return { outcome: "policy", reason: "job-image-missing", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.forgeUnsupported) {
			// The image is present and says it cannot serve this forge -- it ships no CLI for it. Determinate,
			// so a refusal rather than a retry, and pre-spend, because the alternative is a paid container
			// that fails at step 3 on every single delivery with nothing to distinguish it from a bad run.
			//
			// The message names the LIKELY CAUSE rather than the label that detected it: a trigger that
			// forgot `run.image`. The failure is upstream of the thing that noticed it, and an operator
			// reading "the image does not declare azure" has further to walk than one reading "set run.image".
			await comment(
				job,
				`Refused: the job image "${img.forgeUnsupported}" does not support ${img.kind} jobs (it declares: ${img.declared.join(", ")}). Set this trigger's \`run.image\` to an image that does. Not run.`,
			);
			log("refused_image_forge_unsupported", { image: img.forgeUnsupported, kind: img.kind, declared: img.declared });
			return { outcome: "policy", reason: "job-image-forge-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.replicaUnsupported) {
			// The image is present and does not declare replica support (REQ-REPLICA-RUNS), so its baked
			// HARD_RULES.md predates the amendment and still hard-codes `pi/issue-<n>` as a SYSTEM rule --
			// which the model treats as authoritative over the user prompt naming `pi/issue-<n>-r2`. Both
			// replicas would push to one branch: not an error, just the push race the feature exists to
			// avoid, with two runs billed and one pull request to show for it.
			//
			// Determinate, so a refusal rather than a retry, and pre-spend, because no version of this gets
			// better by running. Like the forge branch above, the message names the FIX rather than the label
			// that noticed it -- an operator reading "rebuild the image" is already where they need to be.
			await comment(
				job,
				`Refused: the job image "${img.replicaUnsupported}" does not declare replica support (\`dev.pi-dispatch.capabilities\` ${img.declared.length > 0 ? `declares: ${img.declared.join(", ")}` : "is absent"}), so its baked guardrails would name the wrong branch. Rebuild the image from a version that has this feature. Not run.`,
			);
			log("refused_image_replicas_unsupported", { image: img.replicaUnsupported, declared: img.declared });
			return { outcome: "policy", reason: "job-image-replicas-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.commandUnsupported) {
			// The image is present and does not declare command support (issue #189), so its runner
			// predates run.command: it reads no PI_COMMAND, and the bare `/name args` prompt reaches the
			// model as PROSE -- no handler runs, the agent improvises, and the queue records a clean exit
			// 0. The in-container half of the gate (the runner's own command-unregistered refusal) does
			// not exist on such an image, which is exactly why the host must refuse first.
			//
			// Determinate, so a refusal rather than a retry, and pre-spend, because no version of this
			// gets better by running. Like the replica branch above, the message names the FIX rather
			// than the label that noticed it.
			await comment(
				job,
				`Refused: the job image "${img.commandUnsupported}" does not declare command support (\`dev.pi-dispatch.capabilities\` ${img.declared.length > 0 ? `declares: ${img.declared.join(", ")}` : "is absent"}), so its runner would not dispatch \`run.command\`. Rebuild the image from a version that has this feature. Not run.`,
			);
			log("refused_image_commands_unsupported", { image: img.commandUnsupported, declared: img.declared });
			return { outcome: "policy", reason: "job-image-commands-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.unavailable) {
			// docker itself did not answer -- transient infra, NOT a determinate refusal. THROWN so BullMQ
			// retries (CONST-RETRY-INFRA-ONLY). `container-never-started` is literally true here, and it reuses
			// the refund path below: a no-op pre-reserve, and still honest if this gate ever moves.
			// provider/model attribute even this pre-container death; no usage -- nothing ran to emit one.
			throw new InfraRetry("docker unavailable, image preflight could not run", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// REQ-EGRESS-ALLOWLIST. The egress policy this deployment claims must be able to serve this job
		// BEFORE the job costs anything. It is one `docker inspect` when the policy is armed and ZERO spawns
		// when it is not, so a deployment without one pays nothing at all.
		//
		// PLACEMENT, and it is the same ladder the image preflight sits at the top of. A missing proxy blocks
		// EVERY job of EVERY kind on this host -- like a missing image -- and unlike a missing image it blocks
		// them EXPENSIVELY: the container starts, the provider is unreachable, the runner exits 1, exit 1 is
		// the retryable class, `attempts: 2`, and `releaseBudget` refunds only `container-never-started` --
		// this container started. So each such job spends two job-count slots and buys nothing with either,
		// and a cron-driven deployment empties its daily cap before anyone reads the first failure. That cost
		// is what makes this a pre-spend gate rather than a doc: measured at three provider attempts,
		// `Request timed out.`, exit 1, ~40 seconds, zero tokens (docs/egress.md).
		//
		// A RETURN, never a throw (CONST-RETRY-INFRA-ONLY): retrying never makes an absent proxy appear.
		const egress = await egressPreflight(job);
		if (egress.proxyMissing || egress.proxyStopped) {
			const proxy = egress.proxyMissing ?? egress.proxyStopped;
			const state = egress.proxyMissing ? "is not on this host" : "is not running";
			await comment(job, `Refused: this deployment runs jobs behind an egress policy and its allowlist proxy "${proxy}" ${state}, so the job could not reach the provider and would burn its budget slot proving it. Start it with \`docker compose -f deploy/docker-compose.yml --profile egress up -d\`, or set PI_EGRESS=0 to run without an egress policy. Not run.`);
			// The proxy's NAME is operator-authored deployment config, never payload -- the same PII class as
			// the image ref on the refusal above.
			log(egress.proxyMissing ? "refused_egress_proxy_missing" : "refused_egress_proxy_stopped", { proxy });
			return {
				outcome: "policy",
				reason: egress.proxyMissing ? "egress-proxy-missing" : "egress-proxy-stopped",
				exitCode: null,
				turns: null,
				tokens: null,
				provider: job.provider ?? null,
				model: job.model ?? null,
				budgetReserved: false, // refused before reserveBudget, so no job-count slot was consumed
			};
		}
		if (egress.unavailable) {
			// The daemon did not answer, so this is indeterminate rather than a refusal -- the same
			// determinate/indeterminate split the image preflight draws one gate up, and thrown for the same
			// reason. Pre-reserve, so the refund below is a no-op and still honest if this gate ever moves.
			throw new InfraRetry("docker unavailable, egress preflight could not run", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// REQ-RESUMABLE-SESSION's one fail-CLOSED case. Everything else in that feature fails OPEN and
		// NAMES itself -- absent, expired, too-large, unparseable, locked, promote-failed -- because a cold
		// start is a correct run. This one cannot be: with no `sessionsDir`, resolveSession returns null
		// (session-store.mjs), so nothing is staged, no /session is mounted, the transcript dies with the
		// container, and the NEXT job on that key cold-starts too. The job would exit 0 and look like the
		// feature worked. That is an operator who believes a disclosure is on while it is off, with a green
		// run to confirm the belief -- the inversion validatePackagesFlag's comment describes one flag over,
		// arriving from the other direction.
		//
		// PLACEMENT IS THE POINT. Free, determinate, credential-less and I/O-less -- the answer is two
		// values already in hand -- so it belongs among the free policy refusals and strictly before
		// anything that spends: before the mint (no credential is needed to know the answer, so none is
		// created only to be discarded), before the branch check's API call, before prepareWorkspace's
		// clone, before checkTokenCap's read and before reserveBudget's INCR -- hence `budgetReserved:
		// false`. It sits AFTER the image preflight for the reporting reason the token-cap comment below
		// already states: a missing image blocks EVERY job of EVERY kind on this host, so it is the one an
		// operator must fix first either way, while this blocks only the triggers that armed the flag.
		//
		// Strict `=== true`, the same test prepare-github.mjs uses to decide whether to resolve a session at
		// all, so the gate and the feature cannot disagree about what "armed" means. Kind-agnostic on
		// purpose: only forge jobs can arm the flag today (triggers.mjs refuses it on cron, and a CLI or
		// chained job has no trigger entry that could set it), but a gate written as an enumeration of kinds
		// is a gate the next kind skips silently.
		if (job.resume === true && !sessionsDir) {
			await comment(job, "Refused: this trigger set `run.resume` but PI_SESSIONS_DIR is unset, so there is nowhere to persist the transcript -- the job would run with no session and still report success. Set PI_SESSIONS_DIR to a private directory outside every repo, or drop `run.resume` from this trigger. Not run.");
			// The variable NAME, never a value: there is no path to print here (its absence IS the refusal),
			// and the store's path is the one setting SECURITY.md calls a PII store. `kind` is host-assigned,
			// the same PII class as the `repo` on the branch refusal below.
			log("refused_sessions_dir_unset", { kind: job.kind ?? null });
			// exitCode/turns/tokens null and budgetReserved false: refused pre-container AND pre-reserve,
			// exactly as the image refusals above. RETURNED, not thrown: an unset environment variable is
			// determinate, and no number of retries sets it (CONST-RETRY-INFRA-ONLY).
			return { outcome: "policy", reason: "sessions-dir-unset", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// REQ-PER-TRIGGER-SKILLS. A trigger that named a skills directory the worker cannot see would run
		// its flow WITHOUT the skills it was written against, produce a plausible report, and exit 0. Free
		// and determinate -- one lstat, no credential needed to know the answer -- so it belongs among the
		// free refusals and strictly before anything that spends: before the mint (no token is created only
		// to be discarded), before the clone, before the token-cap read and before reserveBudget
		// (CONST-BUDGET-BEFORE-TOKENS). Last among the free gates because it is the NARROWEST: a missing
		// image blocks every job on this host, an unset sessions dir blocks every armed trigger, a bad
		// skillsDir blocks one trigger.
		if (job.skillsDir && !isReadableDir(job.skillsDir)) {
			await comment(job, "Refused: this trigger set `run.skillsDir`, and that path is absent or is not a directory on the worker host. The job would have run without the skills the flow was written against. Not run.");
			// The FIELD name, never its value. `comment` posts publicly on the issue, so a host path here
			// would publish the operator's filesystem layout to anyone reading the thread; the log line is
			// the same restraint refused_sessions_dir_unset keeps.
			log("refused_skills_dir_missing", { kind: job.kind ?? null });
			return { outcome: "policy", reason: "skills-dir-missing", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// REQ-TRIGGER-SECRETS. A trigger that named secret references the worker cannot resolve would run its
		// flow with those variables UNSET, get a 401 from whatever it was meant to reach, write a plausible
		// report about why the integration is down, and exit 0.
		//
		// PLACEMENT. Strictly before the mint below, the clone in prepareWorkspace, the token-cap read and
		// reserveBudget, so a refusal here costs nothing (CONST-BUDGET-BEFORE-TOKENS). But it is NOT one of the
		// "free, determinate, credential-less and I/O-less" gates above, and this comment must not claim it is:
		// resolving spawns a subprocess per reference against the operator's manager, which is none of those
		// four things. The precedent it actually follows is one gate LATER -- prepareWorkspace already performs
		// a full network clone before the budget is reserved. An I/O-bound pre-budget step is established here;
		// a free one it is not. It sits last among the pre-mint gates because it is both the narrowest and the
		// only one that can block, so every cheaper answer is already in hand when it runs.
		//
		// There is deliberately no cheap "would this resolve?" probe. The reference grammar belongs to the
		// resolver (#206, #209: the seam is a command), so this project has nothing it could validate short of
		// asking -- the same shape the branch-protection check takes, where the check IS the real call.
		//
		// Guarded by `secretsArmed` at the CALL SITE, not inside the resolver: an unflagged job must not reach
		// it under ANY wiring, and a guard that lives in the default is a guard an injected resolver skips.
		const resolved = secretsArmed(job) ? await resolveSecrets(job) : { ok: true, secrets: {} };
		if (resolved.profileUnknown) {
			await comment(job, "Refused: this trigger set `run.secrets`, and the resolver profile it names is not usable on this worker host. No profile of that name is declared, or its resolver is absent or not executable. The job would have started with those variables unset, and an agent that gets a 401 writes a plausible report and exits 0. Run `pi-dispatch doctor` on the worker to see which profiles it has. Not run.");
			// The operator's own profile LABEL, and never a path, a reference, or a byte the resolver printed.
			// `comment` posts publicly on the issue: a resolver path there publishes the operator's filesystem
			// layout, and the DECLARED profile names would publish their vault topology -- which is why the
			// message points at doctor for the list instead of enumerating it. The label itself is
			// operator-authored trigger config, the same class as the image ref the job-image refusals name.
			log("refused_secret_profile_unknown", { kind: job.kind ?? null, profile: resolved.profileUnknown });
			return { outcome: "policy", reason: "secret-profile-unknown", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.ambiguous) {
			// Two sources declared one profile name. Neither wins, deliberately: runtime-settings documents the
			// overlay's precedence as overlay > env, so inverting it here would leave two rules disagreeing about
			// what an overlay is, while honouring it would let a settings file in a world-writable default
			// directory redirect a profile the operator wrote in .env. This project already refuses ambiguity
			// rather than resolving it (PI_EGRESS: "a typo must never leave you believing you have a policy you
			// do not"), and an operator who sees this fixes it in seconds.
			await comment(job, "Refused: this trigger set `run.secrets`, and the resolver profile it names is declared twice on this worker host, once in the environment and once in the settings overlay. Neither wins, on purpose: the job would otherwise run against whichever one happened to be picked. Remove one of the two. Not run.");
			log("refused_secret_profile_ambiguous", { kind: job.kind ?? null, profile: resolved.ambiguous });
			return { outcome: "policy", reason: "secret-profile-ambiguous", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.reserved) {
			// A key the worker itself writes, and one parseTriggers could not have caught: the provider
			// credential's variable names depend on this job's resolved provider and on what this host has set,
			// and PI_FORWARD_ENV is an operator env list. Both are deployment state, so this is the same
			// load-time / pre-spend split run.resume makes against PI_SESSIONS_DIR.
			//
			// It matters most in the direction that is hardest to see: buildContainerEnv writes the provider
			// credential BEFORE this feature's values, so a trigger binding ANTHROPIC_API_KEY would silently
			// redirect which credential every job of that trigger spends.
			await comment(job, `Refused: this trigger's \`run.secrets\` binds \`${resolved.reserved}\`, and the worker sets that variable itself for every job. The container would receive the worker's value rather than this trigger's, and the trigger would look like it worked. Rename it in the triggers file. Not run.`);
			// The variable NAME only. It is the operator's own choice of name, not payload, and naming it is what
			// makes the refusal actionable -- but the REFERENCE behind it never appears.
			log("refused_secret_name_reserved", { kind: job.kind ?? null, name: resolved.reserved });
			return { outcome: "policy", reason: "secret-name-reserved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.unresolved) {
			// DETERMINATE: the resolver said exit 2, printed nothing, overran the size cap, or returned a value
			// with a NUL in it. Retrying cannot change any of those, so this RETURNS (CONST-RETRY-INFRA-ONLY).
			const why = SECRET_FAILURES[resolved.failure] ?? "did not return a value";
			await comment(job, `Refused: this trigger set \`run.secrets\`, and the resolver for \`${resolved.unresolved}\` ${why}. The job would have started with that variable unset, and an agent that gets a 401 writes a plausible report and exits 0. Run your profile's resolver by hand against that reference to see why: this comment carries neither the reference, nor the resolver's path, nor a byte of what it printed. Not run.`);
			// The variable NAME, never a value -- the restraint refused_sessions_dir_unset keeps, and the name is
			// the operator's own choice rather than payload. `failure` is OUR enum, `code` the script's small
			// integer exit, `stderrBytes` a COUNT: never the resolver's words.
			log("refused_secret_unresolved", { kind: job.kind ?? null, name: resolved.unresolved, failure: resolved.failure ?? null, code: resolved.code ?? null, stderrBytes: resolved.stderrBytes ?? 0 });
			return { outcome: "policy", reason: "secret-unresolved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.unreachable) {
			// INDETERMINATE: exit 1 ("could not reach my manager"), an exit code we do not recognise, a spawn
			// fault, or a timeout. THROWS, so BullMQ retries per `attempts` -- the determinate/indeterminate split
			// the image and egress preflights already draw, decided here by the resolver's own exit code rather
			// than by matching its stderr, which image-preflight.mjs forbids for good reason. Folding this into
			// the refusal above would permanently burn a delivery over a twenty-second vault blip, and a webhook
			// does not redeliver itself. Nothing has spent: `budgetReserved` computes false in the catch below
			// because `reserved` is still false here.
			log("secret_resolver_unreachable", { kind: job.kind ?? null, name: resolved.unreachable, failure: resolved.failure ?? null, code: resolved.code ?? null, stderrBytes: resolved.stderrBytes ?? 0 });
			throw new InfraRetry(`secret resolver could not answer for ${resolved.unreachable}`, { reason: "secret-resolver-unreachable", provider: job.provider ?? null, model: job.model ?? null });
		}
		const secrets = resolved.secrets ?? {};

		if (wantsForgeToken) {
			token = await mintToken(job);

			// Defense-in-depth at the DI seam: mintToken is injected, so we cannot assume it routed
			// through get-token's own empty-token guard. An empty credential here would reach
			// env-allowlist's `if (githubToken)` as a falsy value -> GITHUB_TOKEN omitted -> an
			// anonymous paid run. Refuse before reserveBudget so a bad token burns no cap slot.
			if (typeof token !== "string" || token.trim() === "") {
				throw configError("mintToken returned an empty credential");
			}
		}

		if (isForgeBacked) {
			// REQ-BRANCH-PROTECTION-PRECONDITION. The agent's token can merge, so branch protection is the
			// only technical barrier to a self-merge. Refuse before spending anything. Forge-backed jobs
			// only: a local job has no remote branch to protect.
			if (!(await isDefaultBranchProtected(job, token))) {
				await comment(job, "Refused: the default branch is not protected. See SECURITY.md.");
				log("refused_unprotected", { repo: job.repo });
				// exitCode/turns/tokens null: refused pre-container, so no container exit, turn, or token count exists.
				return { outcome: "policy", reason: "unprotected-branch", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		prepared = await prepareWorkspace(job, token, { piVersion }); // resolves SHA, clones, materialises .pi/, writes prompt

		// A determinate prepare refusal -- sha-gone (the default branch advanced past the resolved tip),
		// or a `pi-*` materialiser cap breach (the repo's .pi/ is too large to place in /job, issue #60)
		// -- is POLICY: return before reserveBudget so it burns no cap slot and is never retried.
		// Mirrors the branch-protection policy return above. Spread-plus-attribution: the prepare
		// result keeps its own reason and fields, and the host-effective provider/model land beside
		// them exactly as on every other terminal result.
		if (prepared?.outcome === "policy") {
			return { ...prepared, provider: job.provider ?? null, model: job.model ?? null };
		}

		// Daily TOKEN cap (issue #25): the deliberate check-AFTER control. Token cost is only known
		// post-run, so this cannot check-and-increment before the spend the way the job-count cap does
		// (CONST-BUDGET-BEFORE-TOKENS). It is a read-only GET of prior jobs' recorded spend -- it consumes
		// nothing, so it precedes reserveBudget's INCR and a refusal here burns no job-count slot. It can
		// only stop the NEXT job once the day's accumulated spend has reached the cap; the actual INCRBY
		// happens post-container via recordSpend. Reported before the job-count cap only because both are
		// spend gates; the more-actionable branch-protection precondition is still reported first above --
		// behind only the image check, which outranks it because a missing image blocks EVERY job of EVERY
		// kind on this host, so it is the one the operator must fix first either way.
		const tokenGate = await checkTokenCap(redis, { cap: tokenCap, now });
		if (!tokenGate.allowed) {
			await comment(job, `Over the daily token cap (${tokenGate.spent}/${tokenGate.cap} tokens). Not run.`);
			log("over_token_budget", { spent: tokenGate.spent, cap: tokenGate.cap });
			// budgetReserved false: refused before reserveBudget, so no job-count slot was consumed.
			return { outcome: "policy", reason: "daily-token-cap", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// Per-scope budget windows (issue #242, INT-SCOPED-LIMITS-FILE-CONTRACT): the NARROWER ledger
		// reserves FIRST, so a noisy scope's refusals never consume a global slot -- the global INCR below
		// runs only for jobs the scope admitted. Same atomic INCR, same refused-still-counts invariant,
		// through budget.mjs's keyPrefix seam (dayKey/weekKey/monthKey under budget:s:<hash16>). softHoldPct
		// is deliberately GLOBAL-ONLY: the band is one operator brake on overall spend, not a per-row knob;
		// scoped windows are hard caps (DES-SCOPED-LIMITS-AND-FOLDER-MUTEX).
		if (scopedCaps) {
			// A redis fault BETWEEN this reserve and the global one below strands the scoped INCR with no
			// run and no refund -- the pre-existing mid-reserve posture, shared with the global ledger's
			// own partial-INCR seam; the compensating release below covers REFUSALS, not faults.
			const scoped = await reserveBudget(redis, { caps: scopedCaps.caps, now, keyPrefix: scopeKeyPrefix(scopedCaps.scope) });
			scopedReserved = true;
			if (!scoped.allowed) {
				const w = scoped.blockedWindow;
				const win = scoped.windows[w];
				// A local job's scope is a full host path and its "comment" is not dropped -- the wiring's
				// local adapter LOGS the text (start.mjs forgeFor fallthrough) -- so the path must never
				// enter the message; "this folder" is enough beside the jobId the adapter logs. A forge
				// scope IS the repo the comment posts on, safe to name.
				const scopeLabel = job.kind === "local" ? "this folder" : scopedCaps.scope;
				await comment(job, `Over the ${w} run cap for ${scopeLabel} (${win.cap}). Not run.`);
				// The scope rides the log as its 16-hex key, NEVER the raw string: a folder-scoped cap would
				// put a full host path in the worker log against no-pii-in-logs (the record keeps only
				// basename(folder) for the same reason). The admin recomputes the key from the configured
				// scope to join it back.
				log("over_scope_budget", { scopeKey: scopeKeyPrefix(scopedCaps.scope), window: w, reserved: win.reserved, cap: win.cap, kind: job.kind === "local" ? "local" : "forge" });
				// budgetReserved false: the GLOBAL slot was never touched (scoped reserves first). The scoped
				// counter did INCR and keeps it -- its own refused-reservation-still-counts, per ledger.
				return { outcome: "policy", reason: "scope-cap", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// GLOBAL budget last-but-before-container. A refusal here spends nothing (no container starts). Reserves across
		// every active window (day + optional week/month) and the soft-hold band in one atomic pass.
		const budget = await reserveBudget(redis, { caps, softHoldPct, now });
		reserved = true;
		if (!budget.allowed) {
			// The scoped reserve above committed before this global refusal -- give that slot back. Without
			// this, an exhausted global window drains every arriving scope's own day/week/month counters
			// with zero runs to show for it (a storm against a spent global daily cap would empty a repo's
			// week by noon). The scoped ledger's refused-still-counts covers the SCOPE's own refusal above,
			// never a refusal it did not issue.
			if (scopedReserved && scopedCaps) {
				await releaseBudget(redis, { caps: scopedCaps.caps, now, keyPrefix: scopeKeyPrefix(scopedCaps.scope) });
			}
			const w = budget.blockedWindow;
			const win = budget.windows[w];
			if (budget.reason === "soft-hold") {
				await comment(job, `Soft-hold: ${w} spend ${win.reserved}/${win.cap} is inside the ${softHoldPct}% hold band. New starts paused; not run.`);
				log("soft_hold", { window: w, reserved: win.reserved, cap: win.cap, pct: softHoldPct });
			} else {
				await comment(job, `Over the ${w} budget cap (${win.cap}). Not run.`);
				log("over_budget", { window: w, reserved: win.reserved, cap: win.cap });
			}
			// budgetReserved true: the slot is reserved above and kept (a refused reservation still counts). Both
			// over-budget and soft-hold are POLICY, RETURNED (not retried) -- the agent never ran.
			return { outcome: "policy", reason: budget.reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: true }; // return => not retried
		}

		const { code, aborted, turns, tokens, session, usage, context } = await runContainer({ job, token, prepared, secrets });
		log("container_exit", { exitCode: code, aborted });

		// Record token spend post-run (the check-AFTER half of the lagging token cap). The container ran,
		// so it spent real tokens on EVERY path that reaches here -- abort, completed, policy, AND the infra
		// throws below (an exit-1 container still spent before failing). Record before classifying so all of
		// them are accounted. Only when the cap is enabled (nothing reads the counter otherwise) and the run
		// reported a positive total. NEVER throws: money is already spent, so a Redis blip here must not turn
		// a completed paid job into a failure (mirrors the sink/comment/cleanup fault-isolation posture).
		const tokensSpent = tokens?.total ?? 0;
		if (tokenCap !== null && tokenCap !== undefined && tokensSpent > 0) {
			await recordSpend(redis, tokensSpent, { now }).catch((err) => log("token_spend_error", { reason: err?.message }));
		}

		// A WORKER-initiated stop (30-min timeout via cancelJob, or graceful-shutdown docker stop) kills
		// the container -> exit 143/137. That is our decision, not an infra fault: it is POLICY and must
		// NOT retry, or a wedged job re-runs into a second PR / double spend. Keyed on the abort FLAG,
		// not the code -- an unbidden 137 (kernel OOM) carries `aborted: false`, falls to the switch, and
		// stays infra-retryable.
		// exitCode/turns/tokens carry the container's own exit, turn count, and usage totals; budgetReserved true post-reserve.
		if (aborted) return { outcome: "policy", reason: "worker-abort", exitCode: code, turns, tokens, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true };

		switch (code) {
			case EXIT_COMPLETED: {
				// The SOLE chain-collection point. Read the completed parent's /outbox and enqueue children
				// BEFORE the `finally` deletes jobDir -- the await resolves inside this case, so the read
				// finishes before control leaves to cleanup. NOT reached on any other branch (policy, abort,
				// over-budget, infra): an InfraRetry job is retried, so chaining there would double-enqueue.
				// collectChain never throws; chainEnqueued/chainRefused are additive telemetry only.
				const chain = await collectChain({ job, prepared });
				// COMPLETED-ONLY PROMOTION, and the exclusivity is the point rather than an optimisation.
				// A policy or infra exit leaves the canonical transcript byte-identical to what it was
				// before this run, so a retry starts from exactly what the first attempt did -- promote on
				// every exit and "retry" quietly stops meaning re-run and starts meaning continue
				// (CONST-RETRY-INFRA-ONLY). Same completed-only rule INT-OUTBOX-CONTRACT already uses, and
				// it sits beside the chain collection for the same reason: both must happen before the
				// `finally` deletes jobDir. Never throws.
				const promoted = prepared.session ? promoteSession(prepared.session, { piVersion, context }) : null;
				return {
					outcome: "completed",
					exitCode: code,
					turns,
					tokens,
					// The validated per-model ledger the sink rebuilt off the exit line (parseExitUsage), or
					// null for a fallback-metered or pre-ledger runner. `?? null` keeps the result shape
					// stable under an injected runContainer that predates the field.
					usage: usage ?? null,
					provider: job.provider ?? null,
					model: job.model ?? null,
					session: mergeSession(prepared, session, promoted),
					budgetReserved: true,
					chainEnqueued: chain.enqueued,
					chainRefused: chain.refused,
				};
			}
			case EXIT_POLICY:
				// A policy exit still ran a paid container, so it carries the ledger like the completed
				// branch does -- the spend is real whichever way the runner classified itself.
				return { outcome: "policy", reason: "runner-policy", exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true };
			case EXIT_INFRA:
				throw new InfraRetry(`infra failure, container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session) });
			default:
				// THE RUNTIME NEVER HANDED CONTROL TO THE RUNNER, in whatever integers this venue spells that
				// (issue #227). For docker it is 125 (`docker run` itself failed), 126 (the entrypoint exists
				// but is not executable) and 127 (the entrypoint was not found). Nothing was spent -- which is
				// exactly what `container-never-started` means -- so this reuses the refund below rather than
				// keeping a slot the agent never used. They used to fall to the unknown-exit branch, which
				// kept the slot AND retried, burning a second one.
				//
				// ASKED OF THE BACKEND rather than hardcoded, because those integers are Docker's and they
				// COLLIDE with the runner's own channel (`INT-RUNNER-EXIT-CODE-PROTOCOL`). Assuming them is
				// silently wrong for any venue where 125 is a real runner exit, and the assumption was
				// invisible while there was one runtime. An adapter declares its own set, or declares none
				// and normalises to this outcome itself.
				if ((neverStartedExits(job) ?? []).includes(code)) {
					throw new InfraRetry(`the runtime could not start the container, exit ${code}`, { reason: "container-never-started", exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session) });
				}
				throw new InfraRetry(`unknown container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session) });
		}
	} catch (e) {
		// A spawn fault (docker daemon down / binary missing) reserved a slot but never started a
		// container, so nothing was spent -- give the slot back before the retry. Every other throw
		// here (exit-1 infra, unknown exit) means the container ran and legitimately spent its slot,
		// so `reason` gates the release to the never-started case only. Guarded on `reserved` and run
		// once per invocation; a BullMQ retry reserves afresh, so this cannot double-release.
		// budgetReserved reflects whether a slot stays spent: false when never-started refunds below,
		// true for a real container that ran and spent (exit-1 infra / unknown exit).
		if (e instanceof InfraRetry) e.budgetReserved = reserved && e.reason !== "container-never-started";
		if (e instanceof InfraRetry && e.reason === "container-never-started") {
			// Both-or-neither (issue #242): a never-started container can only follow BOTH reserves (the
			// scoped one precedes the global one, and the container follows both), so they refund
			// together -- and a scoped refusal returned above without ever touching the global ledger.
			if (reserved) await releaseBudget(redis, { caps, now });
			if (scopedReserved && scopedCaps) await releaseBudget(redis, { caps: scopedCaps.caps, now, keyPrefix: scopeKeyPrefix(scopedCaps.scope) });
		}
		throw e;
	} finally {
		if (prepared) await cleanup(prepared).catch(() => {});
	}
}

/** Thrown for the retryable (infra) class only. The BullMQ processor lets this propagate to retry. */
/**
 * The one `session` object the run record carries, from the host's intent and the container's report
 * (INT-RUN-HISTORY-FILE-CONTRACT).
 *
 * Both halves matter and neither is sufficient. The host knows whether a key resolved and which gate
 * refused; only the container knows what pi actually did with the file it was handed. A host that staged
 * a transcript while the runner reports `resumed: false` is a real event -- a corrupt file, a degrade --
 * and with one number alone it is indistinguishable from an ordinary cold start.
 *
 * The runner's verdict WINS on `resumed`, because it is the one that observed the outcome. The host's
 * reason is kept when the runner has none to give (a container that died before its exit line), AND when
 * the host itself refused -- see the second precedence rule below.
 *
 * PII-free by construction: a boolean, a fixed enum, an integer. The key and the branch name are
 * deliberately absent -- this record holds no attacker-chosen string, and a branch name is one.
 */
function mergeSession(prepared, fromRunner, promoted = null) {
	const host = prepared?.session;
	if (!host && !fromRunner) return null;
	// A HOST GATE THAT REFUSED OUTRANKS THE RUNNER'S `absent`, and without this rule it never reached a
	// record at all. A refused read stages a 0-byte file rather than nothing (session-store.mjs, where the
	// reasoning is pi's EEXIST race), the container is handed that file either way, and pi opens it and
	// finds no messages -- so the runner reports `absent` on EVERY host refusal. Letting that win overwrote
	// the answer with a restatement of the question: `expired` and `pi-version-changed` reached no
	// completed record in the feature's whole life, and `docs/sessions.md`'s promise that every cold start
	// is nameable in the record was false for them.
	//
	// Narrow on purpose, `host.resume === false` and the runner's token exactly `absent`. When the host
	// DID stage a transcript and the runner still reports `absent`, the two genuinely disagree, and that
	// disagreement is the event this object exists to show; the runner keeps winning there. So does its
	// `unparseable`, which reports a degrade the host could not see.
	const hostRefused = host?.resume === false && typeof host.reason === "string";
	return {
		resumed: fromRunner ? fromRunner.resumed : false,
		// A promotion that was refused is the more useful reason to surface: "locked" or
		// "not-a-regular-file" says why the NEXT run will cold-start, which is the thing an operator
		// chasing "it never resumes" needs. It only ever replaces a reason on the completed path.
		reason:
			(promoted && !promoted.promoted ? promoted.reason : null) ??
			(hostRefused && fromRunner?.reason === "absent" ? host.reason : null) ??
			fromRunner?.reason ??
			host?.reason ??
			null,
		bytes: promoted?.bytes ?? host?.bytes ?? null,
	};
}

/**
 * Our own words for why a resolver did not produce a value, turned into a phrase at the refusal site --
 * the shape the egress refusal already uses for its `state` discriminator. The `??` fallback in the caller
 * is not decoration: a failure code added in secrets.mjs must degrade to a generic sentence rather than
 * print `undefined` on a public issue.
 */
const SECRET_FAILURES = {
	exit: "refused that reference",
	empty: "printed nothing",
	overflow: "printed more than the size cap allows",
	nul: "printed a value containing a NUL byte, which cannot survive the container's argv",
};

export class InfraRetry extends Error {
	constructor(message, { cause, reason, exitCode, turns, tokens, session, usage, provider, model, budgetReserved } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "InfraRetry";
		this.piDispatchRetry = true;
		this.reason = reason ?? message;
		this.exitCode = exitCode ?? null;
		this.turns = turns ?? null;
		this.tokens = tokens ?? null;
		// A deliberate in-passing repair: the EXIT_INFRA throw has passed `session` since the resume
		// feature landed, but this destructure never read it, so every infra-retry record silently
		// recorded session:null and a degrade seen only on a retried attempt left no trace. Latent
		// because buildRecord's `?? null` made the drop indistinguishable from an honest absence.
		this.session = session ?? null;
		// The usage-ledger trio (INT-RUN-HISTORY-FILE-CONTRACT): carried on the throw path so a
		// catch-path record attributes exactly what the return path would have.
		this.usage = usage ?? null;
		this.provider = provider ?? null;
		this.model = model ?? null;
		this.budgetReserved = budgetReserved ?? null;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
