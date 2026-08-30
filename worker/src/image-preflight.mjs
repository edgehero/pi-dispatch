import { spawn } from "node:child_process";

/**
 * Which image a job runs in, and whether it is on this host.
 *
 * Two facts, one module, because they must never disagree: the tag the preflight checked has to be the tag
 * `docker run` is handed. Both sides resolve through `resolveJobImage`, so there is one answer by
 * construction rather than by two call sites happening to match.
 *
 * This module imports nothing but `node:child_process` -- deliberately. `run-container.mjs` pulls in
 * `env-allowlist.mjs` and therefore `@earendil-works/pi-ai`, which is why its tests sit behind a
 * node-version skip guard. This is a money gate: it decides whether a budget slot is spent, so its tests
 * must run everywhere, unconditionally.
 */

/**
 * The image this job runs in: the job's own `image` when it carries one, otherwise the deployment default
 * (`PI_JOB_IMAGE`). Today nothing sets the per-job field, so every job resolves the default; the seam exists
 * because the preflight and the argv builder must never disagree about which tag they mean, and one function
 * is how that is guaranteed rather than hoped for.
 */
export function resolveJobImage(job, defaultImage) {
	return job?.image ?? defaultImage;
}

/**
 * Build the pre-spend image check. `image` is the deployment default; each call resolves the per-job value
 * against it.
 *
 * Resolves one of:
 *   { ok: true, image }   -- present on this host
 *   { missing: image }    -- the daemon answered and does not have it  => POLICY, refuse, do not retry
 *   { unavailable: image} -- docker itself did not answer              => INFRA, retry
 *   { forgeUnsupported }  -- present, but declares it cannot serve this job's forge => POLICY, refuse
 *   { replicaUnsupported }-- present, but does not declare replica support for a replica job => POLICY
 *   { commandUnsupported }-- present, but does not declare command support for a command job => POLICY
 *
 * A non-zero `docker image inspect` is AMBIGUOUS -- an absent image and an unreachable daemon both exit 1 --
 * so the failure path disambiguates POSITIVELY with `docker info` rather than by matching docker's stderr.
 * Matching text would be the cheaper option and is the wrong one: the wording differs across CLI versions
 * and platforms, and a mismatch would turn a transient daemon blip into a permanent, un-retried refusal of
 * a job whose image is fine. The extra probe runs ONLY on the failure path, so the happy path still costs
 * exactly one spawn.
 *
 * Racy in both directions, and correct in both: if the daemon dies between the two probes we report
 * `unavailable` and retry; if it comes up between them we report `missing` on an image that is genuinely
 * absent. Nothing is cached, deliberately -- see the note at the call site in start.mjs.
 */
export function makeImagePreflight({ image, spawnFn = spawn }) {
	return async function imagePreflight(job) {
		const wanted = resolveJobImage(job, image);
		// --format keeps docker from serialising the whole image manifest to a pipe we ignore.
		//
		// The pi version rides the SAME inspect rather than a second one, so the happy path still costs
		// exactly one spawn. It is needed pre-spend because a transcript outlives the pi that wrote it and
		// pi's own docs say what then breaks: an older session's stored tool-call arguments may not match
		// the current schema (docs/extensions.md, on prepareArguments). We cannot fix that mid-run -- the
		// repair hook is an extension-author API and we do not own pi's built-in tool schemas -- so the
		// answer is to refuse the resume, which needs the version before the container starts.
		//
		// The FORGES label rides the same inspect, for a different failure. `run.image` is optional, so an
		// azure trigger that forgets it runs on the default image, finds no `az`, and fails INSIDE a paid
		// container -- on every single delivery. The image declares which forges it can serve and this
		// refuses before the budget slot is taken.
		//
		// The CAPABILITIES label rides it too, for a failure the forges label cannot catch. A replica job's
		// user prompt names `pi/issue-<n>-r2`, but an image built before REQ-REPLICA-RUNS bakes a
		// HARD_RULES.md whose rule 3 hard-codes `pi/issue-<n>` -- and that is the SYSTEM prompt, which the
		// model treats as authoritative. Both replicas would converge on one branch and the feature would
		// become the push race it exists to avoid, with nothing in the run record saying so.
		const probe = await runDocker(spawnFn, ["image", "inspect", `--format={{.Id}}${FIELD_SEP}${PI_VERSION_TEMPLATE}${FIELD_SEP}${FORGES_TEMPLATE}${FIELD_SEP}${CAPABILITIES_TEMPLATE}`, wanted], true);
		if (probe.code === 0) {
			const [piVersion, forges, capabilities, imageDigest] = parseLabels(probe.stdout);
			const kind = job?.kind;
			// Absent label => ALLOW. The polarity matters and is the opposite of what "declare your
			// capabilities" suggests: every operator-built image predating this label (OQ-012) declares
			// nothing, and refusing those would break working deployments with no warning first. Only a label
			// that is PRESENT and excludes this job's forge refuses.
			if (forges !== null && kind !== undefined && kind !== "local" && !forges.includes(kind)) {
				return { forgeUnsupported: wanted, kind, declared: forges };
			}
			// Absent label => REFUSE, which is the OPPOSITE polarity to `forges` directly above, and the
			// asymmetry is deliberate rather than an oversight. `forges` is an EXCLUSION list, so no claim
			// excludes nothing; `capabilities` is an INCLUSION list, so no claim includes nothing. One rule
			// underlies both -- an image that declares nothing gets no benefit of the doubt about what it
			// contains -- and neither costs an UNFLAGGED job anything: this branch is unreachable unless the
			// job actually carries a replica index.
			if (job?.replica !== undefined && !(capabilities ?? []).includes("replicas")) {
				return { replicaUnsupported: wanted, declared: capabilities ?? [] };
			}
			// Same inclusion-list polarity as `replicas` directly above, and the same class of stale-image
			// failure it guards (issue #189): a runner that predates run.command reads no PI_COMMAND, so
			// the bare `/name args` prompt reaches the model as PROSE -- no handler runs, the agent
			// improvises, and the queue records a clean exit 0. Unreachable for a commandless job, so the
			// existing fleet pays nothing for it.
			if (job?.command !== undefined && !(capabilities ?? []).includes("commands")) {
				return { commandUnsupported: wanted, declared: capabilities ?? [] };
			}
			return { ok: true, image: wanted, piVersion, imageDigest };
		}
		if ((await runDocker(spawnFn, ["info"])).code === 0) return { missing: wanted };
		return { unavailable: wanted };
	};
}

/**
 * Exported so the test cannot drift from the format string above. `|` because an image id is
 * `sha256:<hex>` and a version is a version, so neither can contain one -- and because a literal control
 * character in source is the kind of thing that survives a copy/paste and then does not.
 */
export const FIELD_SEP = "|";
const PI_VERSION_LABEL = "dev.pi-dispatch.pi-version";
const PI_VERSION_TEMPLATE = `{{index .Config.Labels "${PI_VERSION_LABEL}"}}`;
export const FORGES_LABEL = "dev.pi-dispatch.forges";
const FORGES_TEMPLATE = `{{index .Config.Labels "${FORGES_LABEL}"}}`;
export const CAPABILITIES_LABEL = "dev.pi-dispatch.capabilities";
const CAPABILITIES_TEMPLATE = `{{index .Config.Labels "${CAPABILITIES_LABEL}"}}`;

/**
 * The image's declared pi version, forge list and capability list, each `null` when it declares none.
 *
 * `null` is the SAFE answer and is treated as "never resume" downstream, not as "assume it matches". An
 * operator-built image (OQ-012) that omits the label therefore runs every job cold rather than resuming
 * into a pi whose tool schemas may have moved -- the conformance checklist in
 * INT-CONTAINER-RUNTIME-CONTRACT gains this item, and like every other item on it, the failure it
 * prevents is a silent one.
 *
 * Go's text/template renders a missing map key as the literal "<no value>", which is why that string is
 * not a version rather than being compared as one.
 */
function parseLabels(stdout) {
	// A SPLIT, not two indexOf calls: the format string now has four fields, and the image id (which is
	// `sha256:<hex>`) is the first. Neither a version nor a comma-separated list can contain `|`, so the
	// split is unambiguous. A short line -- an older docker, a truncated pipe -- yields nulls, which is
	// the safe answer on every field. On `capabilities` "safe" means the caller refuses a replica job,
	// which is the same direction a genuinely unlabelled image goes.
	const parts = String(stdout ?? "").trim().split(FIELD_SEP);
	// Field 0 is `{{.Id}}`, the image's own digest. It has been fetched on every job since this format
	// string had four fields and was thrown away until issue #57, which needs it to answer "are these two
	// hosts running the same image?" -- a question `OQ-012` records as unanswerable and which turns out to
	// cost nothing to answer, because the inspect that would have asked it already runs.
	const imageDigest = label(parts[0]);
	const piVersion = label(parts[1]);
	// A label that is present but parses to nothing usable is treated as ABSENT rather than as an empty
	// list -- on `forges` the latter would refuse every job on an image whose label was merely malformed.
	return [piVersion, list(parts[2]), list(parts[3]), imageDigest];
}

/** One comma-separated label value as a non-empty array, or `null` when it declares nothing usable. */
function list(raw) {
	const value = label(raw);
	if (value === null) return null;
	const items = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
	return items.length > 0 ? items : null;
}

/** One label value, or `null`. Go's text/template renders a missing map key as the literal "<no value>". */
function label(raw) {
	const value = String(raw ?? "").trim();
	return value === "" || value === "<no value>" ? null : value;
}

/**
 * A spawned docker command's `{ code, stdout }`; `code` is `null` when it could not be launched at all.
 * `null !== 0` falls through to the same branch a non-zero exit does, which is what we want: no docker
 * binary is no answer. Same shape as doctor.mjs's own runCmd -- the two probes here are literally the two
 * doctor already runs, so doctor and the worker agree on what "present" means.
 *
 * `capture` is opt-in so the `docker info` disambiguation keeps its `stdio: "ignore"`: it exists only to
 * answer "did the daemon reply", and piping output we would not read is how a probe becomes a place a
 * large payload can arrive.
 */
function runDocker(spawnFn, args, capture = false) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn("docker", args, { stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		if (capture && child.stdout) {
			child.stdout.setEncoding?.("utf8");
			// Bounded: a --format string we control produces one short line, and a runaway pipe on a money
			// gate should not become the worker's memory problem.
			child.stdout.on("data", (chunk) => {
				if (stdout.length < 4096) stdout += chunk;
			});
		}
		child.on("error", () => resolve({ code: null, stdout: "" })); // ENOENT etc. -- docker is not on PATH
		child.on("close", (code) => resolve({ code, stdout }));
	});
}
