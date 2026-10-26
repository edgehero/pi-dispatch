/**
 * The reason catalog (issue #710, `INT-REASON-CATALOG`): one sentence and one next step for every reason a run record can
 * carry, so the operator console and the `/dispatch` panel can say what happened and what to do instead of printing a
 * token.
 *
 * BUILT FROM THE COMMENT TABLES, NEVER FROM A COPY. Where the worker already posts a FIXED sentence for a reason (its
 * forge comment), that sentence IS the catalog's, read from the table the call site posts from (comment-tables.mjs, and
 * mcp-preflight.mjs for the MCP refusals' one template, filled without a server name). A copy here would drift from the
 * comment the issue actually got, and `AGENTS.md`'s rule is that a hand-written table restating a derivable source is
 * derived or pinned. The test (reason-catalog.test.mjs) holds every derived entry identical to its source, and makes any
 * table keyed by a reason the catalog's source for it unless the reason is named there as ambiguous.
 *
 * WRITTEN HERE, AND SAID SO, for three kinds of reason:
 *   - a reason whose comment carries runtime values (a wait profile, an image ref, a cap's numbers, a proxy name): the
 *     template stays at its call site and this holds a general sentence for the reason;
 *   - a reason that posts no comment (a prepare-stage refusal, a silent one, a failed retry);
 *   - a reason two or more paths share with different comments, where the record cannot say which one ran, so the
 *     general sentence covers them all: `model-not-allowed` (before starting and from the runner), `mcp-config-invalid`
 *     (from the pickup and from the runner), `secret-name-reserved` (for `run.secrets` and for a bundle),
 *     `operator-cancel` (cancelled while running, or before it started: index.mjs posts CANCELLED_BEFORE_START_COMMENT),
 *     `awaiting-input` (the issue's reply line, the pull request's comment-phrase one, or the held reply already taken),
 *     `job-user-unmappable` (JOB_USER_COMMENTS' cause rows), `envelope-mismatch` (ENVELOPE_MISMATCH_COMMENTS' cause
 *     rows) and `podman-conf-widens-job` (PODMAN_CONF_COMMENTS' source and finding rows).
 * `next` is always written here: no table had a "what to do" line.
 *
 * EVERY STRING IS FIXED. No sentence and no next step takes a record value, and none holds a control byte, so a surface
 * may print them without escaping beyond its own (the console still escapes everything it renders). A token that is not
 * a key here (a newer worker's reason, or anything else) is `{ known: false }`, never a guess: the caller shows the
 * token as it is and says it has no explanation yet.
 *
 * `anchor` points at the token's own heading in `docs/reasons.md`, whose `###` headings are exactly these keys (a test
 * holds them both ways).
 */

import {
	BUNDLE_COMMENTS,
	MODEL_NOT_ALLOWED_COMMENTS,
	FAILED_COMMENT_BY_REASON,
	OPENSHELL_REFUSALS,
	RECOVERY_COMMENTS,
	RECOVERY_HOST_LOST_COMMENT,
	REFUSAL_COMMENTS,
	SIZE_REFUSAL_COMMENTS,
	TERMINAL_COMMENTS,
	modelUnknownComment,
} from "./comment-tables.mjs";
import { mcpRefusalComment } from "./mcp-preflight.mjs";

/** The page every anchor points into, relative to the repository root. */
export const REASONS_DOC = "docs/reasons.md";

const imageRefusal = (what, so) => `Refused: the job image does not declare ${what}, so ${so}. Rebuild the image from a version that has this feature. Not run.`;
const REBUILD = "Rebuild the job image from a release that declares the feature, or set the trigger's `run.image` to one that does.";

/**
 * Every top-level reason: `[token, sentence, next]`. Grouped as `docs/reasons.md` groups them. A sentence written as a
 * table read is derived; a string literal is written here for one of the three reasons in the header.
 */
const ROWS = [
	// ── Stopped while running ───────────────────────────────────────────────────────────────────────────────────────
	["worker-abort", TERMINAL_COMMENTS["worker-abort"], "Check the worker log for the 30-minute limit or a shutdown, then run the job again if its work is still wanted."],
	["operator-cancel", "Stopped: the operator cancelled this run. If it had started, partial work may exist; if it was cancelled before it started, nothing was spent. Not retried.", "Nothing to fix. Run the job again if its work is still wanted."],
	["runner-policy", TERMINAL_COMMENTS["runner-policy"], "Read the job log for the turn or token budget it reached, or the refusal inside the container, and adjust the trigger."],
	["provider-auth-refused", TERMINAL_COMMENTS["provider-auth-refused"], "Check the provider key on the worker and what it may use, then run the job again."],
	["cost-cap", TERMINAL_COMMENTS["cost-cap"], "Raise the trigger's `run.maxCostUsd` or the deployment's `PI_MAX_COST_USD` if the work needs more, then run the job again."],
	["model-not-allowed", "Stopped: an AI model this job would call is not on its list of allowed models, or the run tried to change an AI request in a way it does not allow, so that call was not made. When this was decided before the job started, no container was started and nothing was spent.", "Check the trigger's `run.models` and `PI_ALLOWED_MODELS`, and list every model the job may call, fallbacks included, or check the job log for a refused request."],
	["cost-cap-unenforceable", TERMINAL_COMMENTS["cost-cap-unenforceable"], "Update the job image to a release that enforces cost limits, then run the job again."],
	["model-policy-unenforceable", TERMINAL_COMMENTS["model-policy-unenforceable"], "Update the job image to a release that enforces model lists, then run the job again."],
	["oom-killed", TERMINAL_COMMENTS["oom-killed"], "Raise this project's job memory size, or make the job use less memory, then run it again."],
	["awaiting-input", "The run asked a question and stopped to wait for the answer. Its work so far is saved, and the next run continues from there. If a reply arrived while it was stopping, that reply was taken as the answer and the run continues on its own.", "If no reply was taken yet, answer the question: reply on the issue or pull request (on a pull request, start the reply with this repository's pi-dispatch comment phrase), or answer from the console's run page."],
	["not-parked", "Not run: a reply reached this job as the answer to a waiting run, but no run on this issue was waiting, so it was ordinary conversation. Nothing was spent.", "Nothing to fix. The stale waiting marker was removed from the issue."],
	// ── Budgets and caps ────────────────────────────────────────────────────────────────────────────────────────────
	["over-budget", "Refused: the deployment's cap on how many jobs may start in the day, week or month was already reached, so no container was started. Not run.", "Wait for the window to roll over, or raise the cap with `/dispatch set` if it is too low."],
	["soft-hold", "Refused: the spend in a budget window is inside the soft-hold band below its cap, so new starts are paused. Not run.", "Wait for the window to roll over, or raise the cap or narrow the hold band."],
	["daily-token-cap", "Refused: the tokens spent today had already reached the daily token cap, so no container was started. Not run.", "Wait for the next UTC day, or raise the daily token cap."],
	["dollar-cap", "Refused: a dollar budget (the deployment's, a repository's or folder's, a project's or a model's) had no room left for this run's cost limit, or is smaller than it, so no container was started and nothing was spent. Not run.", "Wait for the window to roll over, or raise that budget or lower the run's cost limit."],
	["allocation-cap", "Refused: the share of the budget split for this job's project had no room left for this run's cost limit, or is smaller than it, so no container was started and nothing was spent. Not run.", "Wait for the window to roll over or for the next priorities plan. The split sets this number, so raising a budget does not help."],
	["envelope-mismatch", "Refused: this worker's budget envelope is missing, or differs from the one the applied budget split was made for, so no container was started and nothing was spent. Not run.", "Run `pi-dispatch doctor` on each worker and make their envelopes agree, or turn delegated allocation off on all of them."],
	["portfolio-no-envelope", "Refused: this portfolio job writes a priorities plan, and this worker has no envelope that lets a portfolio job apply one, so it was not run and nothing was spent.", "Install the envelope with delegation on and `portfolio-job` among its writers, or remove the portfolio flag from the trigger."],
	["portfolio-snapshot-oversize", "Refused: the portfolio snapshot this job would read is larger than a job may carry, so no container was started and nothing was spent. Not run.", "Govern fewer projects or members in the envelope, then run the job again."],
	["scope-cap", "Refused: this repository's or folder's run cap for the window was already reached, so no container was started and nothing was spent. Not run.", "Wait for the window to roll over, or raise that row in `scoped-limits.json`."],
	["project-cap", "Refused: this project's run cap for the window was already reached, so no container was started and nothing was spent. Not run.", "Wait for the window to roll over, or raise the project's row in `scoped-limits.json`."],
	["job-size-exceeds-host", SIZE_REFUSAL_COMMENTS["job-size-exceeds-host"], "Lower this project's job size, or raise the worker's host budget (`pi-dispatch doctor` shows both)."],
	["job-size-exceeds-share", SIZE_REFUSAL_COMMENTS["job-size-exceeds-share"], "Lower this project's job size, or raise its host share (`pi-dispatch doctor` shows both)."],
	// ── Triggers and waits ──────────────────────────────────────────────────────────────────────────────────────────
	["once-already-spent", "Refused: this one-shot trigger was already spent by an earlier run, so a later close did not start another. Not run.", "Delete `on.disarmed` from the trigger entry to arm it again."],
	["trigger-skew", "Refused: the trigger sets a field the job reached the worker without, so it would have run as though the trigger did not set it. Not run.", "Run the job again if the trigger changed after it was queued; otherwise update or restart the stale service."],
	["wait-skew", "Refused: the trigger declares wait conditions, but the job reached the worker without them, so it would have run at once. Not run.", "Update the service below the version that carries the field, or restart the one still reading an older triggers file."],
	["wait-unreadable", "Refused: this job carries wait conditions the worker cannot read or cannot hand to a check, so it cannot honour them. Not run.", "Run the worker at the release of the service that queued the job, or fix the condition in the trigger."],
	["wait-profile-unknown", "Refused: the job waits on a check that no wait profile on this deployment declares. Not run.", "Declare the wait profile on the worker, or fix its name in the trigger's `waitFor`."],
	["wait-superseded", "Not run: another delivery for the same target is already waiting, or already finished waiting, on the same conditions.", "Nothing to fix. The other delivery carries the work."],
	["wait-after-beyond-max", "Refused: the trigger's `after` instant is further out than this deployment lets a job wait. Not run.", "Move the `after` instant closer, or raise the deployment's maximum wait."],
	["wait-refused", "Not run: the wait check reported that its condition will never clear.", "Read the check's answer in the worker log, then fix the condition or the check."],
	["wait-unanswerable", "Not run: the wait check could not answer several times in a row.", "Run the wait profile's check by hand on the worker to see why it fails."],
	["wait-expired", "Not run: the job gave up waiting, because its condition did not clear within the maximum wait or number of checks.", "Run the job again once the condition holds, or allow a longer wait."],
	// ── Models and providers ────────────────────────────────────────────────────────────────────────────────────────
	["model-unknown", modelUnknownComment(null), "Check the trigger's model and provider names, or fix the overlay `models.json` that `pi-dispatch doctor` names."],
	["provider-unconfigured", "Refused: this deployment has no usable credential for the job's AI provider, so no container was started and nothing was spent. Not run.", "Run `pi-dispatch doctor` on the worker: it names the variable to set."],
	// ── The job image ───────────────────────────────────────────────────────────────────────────────────────────────
	["job-image-missing", "Refused: the job image this job runs is not present on the worker host, so no container was started and nothing was spent. Not run.", "Pull or build the image on the worker, or set the trigger's `run.image` to one that is there."],
	["job-image-forge-unsupported", "Refused: the job image does not support this job's forge (it ships no client for it). Not run.", "Set the trigger's `run.image` to an image that declares this forge."],
	["job-image-replicas-unsupported", imageRefusal("replica support", "its baked guardrails would name the wrong branch"), REBUILD],
	["job-image-commands-unsupported", imageRefusal("command support", "its runner would not dispatch `run.command`"), REBUILD],
	["job-image-exclude-tools-unsupported", imageRefusal("exclude-tools support", "its runner would ignore `run.excludeTools`"), REBUILD],
	["job-image-model-policy-unsupported", imageRefusal("allowed-model support", "its runner cannot hold this job to the models it may use"), REBUILD],
	["job-image-cost-cap-unsupported", imageRefusal("cost-cap support", "its runner would ignore the per-job dollar cap"), REBUILD],
	["job-image-any-uid-unsupported", imageRefusal("`anyUid`", "it cannot run as this worker's own uid, which this host's container runtime requires"), REBUILD],
	["job-image-mcp-unsupported", imageRefusal("MCP support", "its runner would not connect the servers `run.mcp` names"), REBUILD],
	["job-image-forge-mcp-unsupported", imageRefusal("the forge's own MCP server", "it does not carry the server `run.mcp` names as `forge`"), REBUILD],
	["job-image-await-input-unsupported", imageRefusal("support for stopping to wait for an answer", "its runner would ignore `run.awaitInput`"), REBUILD],
	["job-image-progress-unsupported", imageRefusal("support for reporting progress", "its runner would ignore `run.progress`"), REBUILD],
	["job-image-recover-unsupported", imageRefusal("support for continuing a lost run", "its runner would ignore `run.recover`"), REBUILD],
	["job-image-steer-unsupported", imageRefusal("support for receiving messages while it runs", "its runner would ignore `run.steer`"), REBUILD],
	["job-image-sandbox-layout-unsupported", imageRefusal("support for a venue that copies the job's files into its sandbox", "its runner would not find them"), REBUILD],
	["job-image-observable-runner-unsupported", imageRefusal("support for a venue whose sandbox must observe the runner", "the job could reach neither its model nor anything else"), REBUILD],
	// ── The venue and the host ──────────────────────────────────────────────────────────────────────────────────────
	["backend-unblessed", "Refused: the trigger asks for a venue this deployment does not bless (`PI_BACKENDS`). Not run.", "Add the venue to `PI_BACKENDS` on the worker, or change the trigger's `run.backend`."],
	["backend-floor-unobserved", "Refused: this deployment's `PI_BACKEND_FLOOR` requires a guarantee this host is not observed to provide right now, so the job was not run. Not run.", "Run `pi-dispatch doctor` on the worker to see which observation failed, then fix the runtime or lower the floor."],
	["venue-local-folders-unsupported", "Refused: this job runs against a folder on this machine, and its venue copies a job's files instead of editing a folder in place. Not run.", "Run it on a venue that mounts folders (local or podman) with the trigger's `run.backend`."],
	["job-user-unmappable", "Refused: the worker host's container runtime cannot give this job a non-root user that can read and write its own files, or answered in a form the worker cannot read, so the job had no user it could safely run as. Not run.", "Run `pi-dispatch doctor` on the worker: it names the cause (for example a rootless daemon, userns-remap, a worker running as root, a worker whose primary group is root or the Docker socket's, or a runtime answer it cannot read)."],
	["podman-conf-widens-job", "Refused: the worker host's Podman configuration (rootful Podman's, the podman venue's files, or its running rootless network) lets a job's container reach more than the venue allows, or could not be read in full. Not run.", "Run `pi-dispatch doctor` on the worker: it names the file and key to change, or the network to restart."],
	["podman-service-restart-hold-expired", FAILED_COMMENT_BY_REASON["podman-service-restart-hold-expired"], "Restart rootful Podman's service while no local job runs, then run the job again."],
	["netns-keeper-not-holding", FAILED_COMMENT_BY_REASON["netns-keeper-not-holding"], "Run `pi-dispatch doctor` on the worker for the exact fix, then run the job again."],
	["netns-keeper-crash-loop", FAILED_COMMENT_BY_REASON["netns-keeper-crash-loop"], "Read the keeper's log (`journalctl --user -u pi-dispatch-netns-keeper.service`) and run `pi-dispatch doctor`."],
	["egress-proxy-missing", "Refused: this deployment runs jobs behind an egress policy, and its allowlist proxy is not on this host, so the job could not have reached its provider. Not run.", "Start the proxy (`pi-dispatch up` from the deployment folder, or as `docs/podman.md` says for the podman venue), or set `PI_EGRESS=0`."],
	["egress-proxy-stopped", "Refused: this deployment runs jobs behind an egress policy, and its allowlist proxy is not running, so the job could not have reached its provider. Not run.", "Start the proxy (`pi-dispatch up` from the deployment folder, or as `docs/podman.md` says for the podman venue), or set `PI_EGRESS=0`."],
	["container-never-started", "Failed: the container runtime never handed control to the job (it could not create or start the container, or a check before it could not run), so nothing was spent. The job was retried and did not start.", "Run `pi-dispatch doctor` on the worker and check the container runtime, then run the job again."],
	["container-detached", "Failed: the job's container outlived the command that started it (a lost connection to the runtime), so the worker could not see how it ended. The job was retried.", "Check the worker's connection to its container runtime, and stop any job container left running."],
	["container-infra-exit", "Failed: the job's container ended with the runner's infrastructure exit (an AI provider error or rate limit, a lost network, or a crash inside the container), so the worker counted it as an infrastructure fault and retried it while attempts were left. Partial work may exist.", "Read the `exit` line in the job log for what the runner met, then run the job again if every attempt was used."],
	["container-exit-unknown", "Failed: the job's container ended with an exit code the runner never uses (for example a container stopped from outside the worker), so the worker could not tell what happened and retried it while attempts were left. Partial work may exist.", "Read the job log for how the container ended: a job image older or newer than the worker, or a container stopped from outside the worker, can cause this."],
	["worker-error", "Failed: the worker met an error it has no reason for (a forge or Valkey call that failed, or a fault in the worker itself). The record keeps none of the error's own words, which can name an API path or a repository.", "Read the worker log's `job_failed` line for this job, then run the job again."],
	["config-refused", REFUSAL_COMMENTS["config-refused"], "Run `pi-dispatch doctor` on the worker: it names the setting or file to fix."],
	["settings-overlay-invalid", "Refused: the deployment's settings file (the overlay `/dispatch set` writes) is present but invalid, so every job is refused rather than run on settings nobody chose. Not run.", "Fix the key `pi-dispatch doctor` names, or delete the settings file to start from an empty overlay."],
	// ── The OpenShell venues ────────────────────────────────────────────────────────────────────────────────────────
	["openshell-gateway-not-local", OPENSHELL_REFUSALS["openshell-gateway-not-local"], "Run the OpenShell gateway on this host, or run the job on another venue."],
	["openshell-global-policy", OPENSHELL_REFUSALS["openshell-global-policy"], "Remove the gateway-wide policy from the OpenShell gateway, or run the job on another venue."],
	["openshell-landlock-missing", OPENSHELL_REFUSALS["openshell-landlock-missing"], "Run OpenShell jobs on a host whose kernel offers Landlock, or run the job on another venue."],
	["openshell-recover-unsupported", OPENSHELL_REFUSALS["openshell-recover-unsupported"], "Run the job on another venue, or drop `run.recover` from the trigger."],
	["openshell-credential-reads-value", OPENSHELL_REFUSALS["openshell-credential-reads-value"], "Run the job on another venue, or with a provider whose key is sent as it is."],
	["openshell-gateway-untested", OPENSHELL_REFUSALS["openshell-gateway-untested"], "Run the OpenShell release this pi-dispatch release names (`pi-dispatch doctor` says which)."],
	["openshell-egress-untranslatable", OPENSHELL_REFUSALS["openshell-egress-untranslatable"], "Change the egress allowlist entry `pi-dispatch doctor` names, or run the job on another venue."],
	["openshell-bind-mounts-disabled", OPENSHELL_REFUSALS["openshell-bind-mounts-disabled"], "Allow driver config and bind mounts in the gateway's `gateway.toml`, turn resource admission off, and restart the gateway."],
	["openshell-ptrace-scope-unprotected", OPENSHELL_REFUSALS["openshell-ptrace-scope-unprotected"], "Set `kernel.yama.ptrace_scope` to 1 on the worker host."],
	["openshell-ptrace-scope-too-strict", OPENSHELL_REFUSALS["openshell-ptrace-scope-too-strict"], "Set `kernel.yama.ptrace_scope` to exactly 1 on the worker host."],
	["openshell-bind-sandbox-lingering", OPENSHELL_REFUSALS["openshell-bind-sandbox-lingering"], "Check the sandbox on the OpenShell gateway and remove it, then check the folder's files before running the job again."],
	["openshell-bundle-endpoint-not-allowed", OPENSHELL_REFUSALS["openshell-bundle-endpoint-not-allowed"], "Add the host to `egress-allowlist.conf` as itself, or remove it from the bundle's endpoints."],
	["openshell-bundle-endpoint-shared", OPENSHELL_REFUSALS["openshell-bundle-endpoint-shared"], "Remove that host from the bundle's endpoints."],
	["openshell-bundle-endpoint-unknown", OPENSHELL_REFUSALS["openshell-bundle-endpoint-unknown"], "Fix the name in the bundle's endpoints, or add the variable in the secrets manager."],
	["openshell-bundle-name-taken", OPENSHELL_REFUSALS["openshell-bundle-name-taken"], "Rename the variable in the secrets manager."],
	["openshell-bundle-unpassable", OPENSHELL_REFUSALS["openshell-bundle-unpassable"], "Run the project on another venue, or change the bundle's endpoints."],
	["openshell-bundle-image-too-old", OPENSHELL_REFUSALS["openshell-bundle-image-too-old"], "Rebuild the job image from a release that declares `bundleEnvFile`."],
	// ── The repository or folder ────────────────────────────────────────────────────────────────────────────────────
	["unprotected-branch", REFUSAL_COMMENTS["unprotected-branch"], "Protect the repository's default branch, then run the job again."],
	["sha-gone", "Refused: the commit this job was resolved to is no longer on the forge (the default branch moved past it), so it could not be fetched. Not run.", "Run the job again: it resolves the default branch afresh."],
	["local-folder-not-a-repo", "Refused: this job's folder is not a git repository (it has no `.git` at its root). Not run.", "Run `git init` in the folder and commit once, or point the job at a repository."],
	["local-folder-no-commit", "Refused: this job's folder is a git repository with no commit yet. Not run.", "Commit once in the folder, then run the job again."],
	["local-folder-unreadable-repo", "Refused: git could not read this job's repository (its HEAD, a ref or an object could not be resolved). Not run.", "Run `git status` in the folder to see what is wrong, and repair the repository."],
	["local-folder-escaped", "Refused: this job's folder is named inside a run root or a cron trigger's folder, but it now resolves outside it through a link, so it was not mounted. Not run.", "List the real folder as a run root or as the trigger's `run.folder`, or remove the link."],
	["local-folder-holds-envelope", "Refused: this job's folder is the budget envelope's folder or a folder above it, so a job there could edit the envelope. Not run.", "Keep the envelope file outside every job's folder."],
	["local-folder-project-changed", REFUSAL_COMMENTS["local-folder-project-changed"], "Check the links inside the run root, and list the folder under the project it really belongs to."],
	["pi-too-many-files", "Refused: the repository's `.pi/` holds more files than a job may carry, in all or in one skill. Not run.", "Remove files from `.pi/` on the default branch, then run the job again."],
	["pi-file-too-large", "Refused: the repository's `.pi/` holds a file larger than a job may carry. Not run.", "Move the large file out of `.pi/` on the default branch, then run the job again."],
	["pi-too-large", "Refused: the repository's `.pi/` holds more bytes in all than a job may carry. Not run.", "Trim `.pi/` on the default branch, then run the job again."],
	["pi-path-collision", "Refused: the repository's `.pi/` holds two paths that differ only in letter case, which a host that ignores case would write as one. Not run.", "Rename one of the two paths in `.pi/` on the default branch."],
	["skills-dir-missing", REFUSAL_COMMENTS["skills-dir-missing"], "Create the directory on the worker host, or fix the trigger's `run.skillsDir`."],
	["skills-dir-empty", "Refused: the trigger's `run.skillsDir` holds no skill directory, so the job would have run without the skills its flow was written against. Not run.", "Put the skills in the directory, or fix the trigger's `run.skillsDir`."],
	["skills-dir-too-large", "Refused: the trigger's `run.skillsDir` holds more skill directories or more bytes than one trigger may inject. Not run.", "Split the skills across triggers, or remove the ones this trigger does not need."],
	["skills-dir-too-many-files", "Refused: the trigger's `run.skillsDir` holds more files than one trigger may inject. Not run.", "Remove files from the skills, or split them across triggers."],
	["skills-dir-too-deep", "Refused: the trigger's `run.skillsDir` nests folders deeper than one trigger may inject. Not run.", "Flatten the skills' folders."],
	["skills-dir-unreadable", "Refused: the worker could not read the trigger's `run.skillsDir` (a file or folder in it is unreadable). Not run.", "Fix the permissions of the skills directory on the worker host."],
	// ── Sessions and secrets ────────────────────────────────────────────────────────────────────────────────────────
	["sessions-dir-unset", REFUSAL_COMMENTS["sessions-dir-unset"], "Set `PI_SESSIONS_DIR` on the worker, or drop `run.resume` from the trigger."],
	["secret-profile-unknown", REFUSAL_COMMENTS["secret-profile-unknown"], "Run `pi-dispatch doctor` on the worker to see which profiles it has, then declare the profile or fix its name."],
	["secret-profile-ambiguous", REFUSAL_COMMENTS["secret-profile-ambiguous"], "Remove the profile from either the environment or the settings overlay."],
	["secret-name-reserved", "Refused: a secret this job would receive (from `run.secrets` or its project's bundle) uses a name this deployment already uses for the job's own credentials or configuration, so one of the two values would be silently ignored. Not run.", "Rename the variable in the triggers file or in the secrets manager (the worker log names it)."],
	["secret-unresolved", "Refused: a secret resolver (for `run.secrets` or for the project's bundle) refused, printed nothing, or printed something unusable, so the job would have started without that secret. Not run.", "Run the resolver by hand on the worker against its reference to see why."],
	["secret-resolver-unreachable", "Failed: a secret resolver could not answer (it could not reach its manager, timed out, or exited in a way it does not use for a refusal), so the job was retried and did not start.", "Check that the secrets manager is reachable from the worker, then run the job again."],
	["secret-bundle-profile-unknown", BUNDLE_COMMENTS["secret-bundle-profile-unknown"], "Declare the bundle profile on the worker, or fix its name in the triggers file's `secretBundles`."],
	["secret-bundle-profile-ambiguous", BUNDLE_COMMENTS["secret-bundle-profile-ambiguous"], "Remove the bundle profile from either the environment or the settings overlay."],
	["secret-bundle-resume", BUNDLE_COMMENTS["secret-bundle-resume"], "Set `\"secretBundle\": false` on the trigger, or drop `run.resume`."],
	["secret-bundle-trigger-changed", BUNDLE_COMMENTS["secret-bundle-trigger-changed"], "Run the job again from the current trigger."],
	// ── MCP servers ─────────────────────────────────────────────────────────────────────────────────────────────────
	["mcp-list-invalid", mcpRefusalComment("mcp-list-invalid", null), "Run every service of the deployment at the same release, then run the job again."],
	["mcp-config-invalid", "Refused: the list of MCP servers could not be used: the overlay `mcp.json` before the job started, or the list the worker wrote for the job inside its container. Not run.", "Fix the overlay `mcp.json` (`pi-dispatch doctor` checks it), and run a worker and a job image of the same release."],
	["mcp-server-unknown", mcpRefusalComment("mcp-server-unknown", null), "Declare the server in the overlay `mcp.json`, or fix the name in `run.mcp`."],
	["mcp-secret-unmapped", mcpRefusalComment("mcp-secret-unmapped", null), "Pass the credential the server needs in the trigger's `run.secrets`."],
	["mcp-secret-reserved", mcpRefusalComment("mcp-secret-reserved", null), "Give the server's credential a variable of its own."],
	["mcp-excluded", mcpRefusalComment("mcp-excluded", null), "Remove the server from `run.mcp`, or keep a tool that reaches it out of `run.excludeTools`."],
	["mcp-egress-unreachable", mcpRefusalComment("mcp-egress-unreachable", null), "Add the server's host to the egress allowlist, or drop the server from `run.mcp`."],
	["mcp-package-runner", mcpRefusalComment("mcp-package-runner", null), "Allow the package registry in the egress allowlist, or install the server in the job image."],
	["mcp-unavailable", TERMINAL_COMMENTS["mcp-unavailable"], "Check that the server starts and accepts the job's credentials (the job log names it on the `exit` line)."],
	["mcp-config-mismatch", TERMINAL_COMMENTS["mcp-config-mismatch"], "Run a worker and a job image of the same release."],
	["mcp-secret-missing", TERMINAL_COMMENTS["mcp-secret-missing"], "Check the secrets the trigger passes in `run.secrets`."],
	["mcp-command-missing", TERMINAL_COMMENTS["mcp-command-missing"], "Install the server's program in the job image or the overlay."],
	["mcp-shadowed", TERMINAL_COMMENTS["mcp-shadowed"], "Remove the extension that registers the server's tools, or the trigger's MCP servers."],
	// ── Answers, progress and steering ──────────────────────────────────────────────────────────────────────────────
	["await-input-shadowed", TERMINAL_COMMENTS["await-input-shadowed"], "Remove the extension that registers the wait tool, or the trigger's `run.awaitInput`."],
	["await-input-without-session", TERMINAL_COMMENTS["await-input-without-session"], "Run a worker and a job image of the same release."],
	["report-progress-shadowed", TERMINAL_COMMENTS["report-progress-shadowed"], "Remove the extension that registers the progress tool, or the trigger's `run.progress`."],
	["steer-inbox-missing", TERMINAL_COMMENTS["steer-inbox-missing"], "Run a worker and a job image of the same release."],
	["steer-no-exit-key", TERMINAL_COMMENTS["steer-no-exit-key"], "Run a worker and a job image of the same release."],
	// ── Durable runs ────────────────────────────────────────────────────────────────────────────────────────────────
	["recover-store-unset", RECOVERY_COMMENTS["recover-store-unset"], "Set `PI_CHECKPOINTS_DIR` or `PI_SESSIONS_DIR` on the worker, or drop `run.recover` from the trigger."],
	["recovery-enqueued", "Failed, continuing: this attempt was lost to an infrastructure fault, and the run continues from its last checkpoint in a recovery job.", "Nothing to do yet. Follow the recovery job's own run."],
	["recovery-host-lost", RECOVERY_HOST_LOST_COMMENT, "Check the worker that held the checkpoint, then run the job again."],
	["recovery-cap", RECOVERY_COMMENTS["recovery-cap"], "Read the worker log for why each attempt was lost, then run the job again."],
	["recovery-checkpoint-absent", RECOVERY_COMMENTS["recovery-checkpoint-absent"], "Read the worker log for why the checkpoint could not be used, then run the job again."],
	["recovery-superseded", "Not run: the run this recovery would continue had already reached its final outcome, so there was nothing left to continue.", "Nothing to fix."],
	["recovery-unsafe-extensions", RECOVERY_COMMENTS["recovery-unsafe-extensions"], "Run the job again from the start. A repository with `.pi/extensions/` is never recovered."],
	["recovery-failed", RECOVERY_COMMENTS["recovery-failed"], "Read the worker log for why the continuation was lost, then run the job again."],
];

const entry = (anchor, sentence, next) => Object.freeze({ sentence, next, anchor });
/**
 * A frozen token table from rows. A token twice is a load-time error, not a silent override: `Object.fromEntries` keeps
 * the LAST row, so a second row added for a token (a copy-paste, a merge) would quietly replace the first one's text.
 */
function tableOf(rows, anchorOf) {
	const out = {};
	for (const [token, sentence, next] of rows) {
		if (Object.hasOwn(out, token)) throw new Error(`reason-catalog: the token ${token} has two rows`);
		out[token] = entry(anchorOf(token), sentence, next);
	}
	return Object.freeze(out);
}

/** token -> `{ sentence, next, anchor }`, every reason the run record's `reason` can carry (INT-RUN-HISTORY-FILE-CONTRACT). */
export const REASONS = tableOf(ROWS, (token) => `${REASONS_DOC}#${token}`);

/**
 * The `why` variants: a record whose `why` says which of a reason's comments was posted gets that comment as its
 * sentence. Only where the comment table is keyed by it; every other `why` keeps the reason's own sentence.
 */
export const WHY_VARIANTS = Object.freeze({
	"model-unknown": (why) => (typeof why === "string" && why.startsWith("overlay-") ? modelUnknownComment(why) : null),
	"model-not-allowed": (why) => (why === "fallback-unlisted" ? MODEL_NOT_ALLOWED_COMMENTS["fallback-unlisted"] : null),
});

// ── The nested reasons ──────────────────────────────────────────────────────────────────────────────────────────────

const SESSION_ANCHOR = `${REASONS_DOC}#session-reasons`;
const RESUME_NEXT = "Nothing to fix: the job ran from the start. See the session docs if you expected it to continue.";

/** The record's `session.reason` (run-history.mjs `SESSION_REASONS`): why a job resumed, or ran from the start. */
export const SESSION_REASON_TEXT = tableOf(
	[
		["resumed", "The job continued the conversation saved for its key.", "Nothing to do."],
		["absent", "No saved conversation: the first run for this key, or the previous one saved nothing, so the job ran from the start.", "Nothing to do."],
		["expired", "The saved conversation was older than the session time to live, so the job ran from the start.", "Raise `PI_SESSIONS_TTL_DAYS` if conversations should last longer."],
		["conversation-too-old", "The conversation began longer ago than the session's maximum age, so the job ran from the start.", "Raise `PI_SESSION_MAX_AGE_DAYS` if conversations should run longer."],
		["resume-chain-too-long", "This conversation had been continued as many times in a row as allowed, so the job ran from the start.", "Raise `PI_SESSION_MAX_RESUME_CHAIN` if longer chains are wanted."],
		["context-too-full", "The saved conversation already filled too much of its model's context window, so the job ran from the start.", "Raise `PI_SESSION_MAX_CONTEXT_PCT`, or use a model with a larger window."],
		["compaction-summary-empty", "The saved conversation holds a compaction with an empty summary, so continuing it would silently lose earlier turns. The job ran from the start.", "Check the token or cost cap that cut the summary call short."],
		["too-large", "The saved conversation was larger than the session size cap, so the job ran from the start.", "Raise `PI_SESSION_MAX_BYTES` if larger conversations are wanted."],
		["unparseable", "The saved conversation is not a pi session file, so the job ran from the start. It is rejected again on every run until it is replaced or expires.", "Remove the key's transcript from the session store, or wait for the next completed run to replace it."],
		["not-a-regular-file", "The saved conversation is not a regular file (a link, for one), so it was not used.", "Remove what stands at the key's transcript in the session store."],
		["key-not-a-directory", "The key's folder in the session store is not a folder, so its conversation was neither read nor saved.", "Remove what stands at the key's name in the session store."],
		["transcript-diverted", "The worker could not confirm the conversation was saved at its key, so it was not saved.", "Check what else writes into the session store."],
		["venue-changed", "The saved conversation was written on another venue than this job runs on, so the job ran from the start.", "Run the trigger on one venue if its conversations should continue."],
		["pi-version-changed", "The job image runs another pi than wrote the saved conversation, so the job ran from the start.", RESUME_NEXT],
		["transcript-replaced", "The saved conversation changed while this job was reading it (usually another run on the key saving a new one), so the job ran from the start.", RESUME_NEXT],
		["locked", "Another job was saving this key's conversation at the same time, so this run's conversation was not saved.", "Nothing to fix: the other job's save stands."],
		["promote-failed", "Saving the conversation failed (a full disk, or a permission change in the session store), so this run's conversation was not saved.", "Check the session store's disk and permissions on the worker."],
		["disabled", "The trigger does not set `run.resume`, so the job did not continue a saved conversation.", "Set `run.resume` on the trigger if its runs should continue one conversation."],
	],
	() => SESSION_ANCHOR,
);

/** The record's `recoverSkipped` (run-history.mjs `RECOVER_SKIPPED_REASONS`): why a job that set `run.recover` ran without it. */
export const RECOVER_SKIPPED_TEXT = tableOf(
	[
		["local", "A folder job is never recovered, so it ran as it would without `run.recover`.", "Nothing to fix: only forge jobs are recovered."],
		["no-run-id", "The job's queue id could not be derived from its data, so nothing could be kept for it, and it ran without recovery.", "Check the worker log; a job queued by another release can cause this."],
		["base-unprimed", "The checkpoint store could not take the run's base commit, so no checkpoint of it could ever be restored, and it ran without recovery.", "Check the checkpoint store's disk and permissions on the worker."],
		["workspace-extensions", "The repository's base commit holds `.pi/extensions/`, whose imports could load code the agent wrote, so the run was not armed for recovery.", "Nothing to fix: such a repository runs without recovery by design."],
	],
	() => `${REASONS_DOC}#recovery-skipped-reasons`,
);

const PLAN_ANCHOR = `${REASONS_DOC}#plan-reasons`;

/** The record's `plan.reason` (run-history.mjs `PLAN_RECORD_REASONS`): why a portfolio job's priorities plan did not apply. */
export const PLAN_REASON_TEXT = tableOf(
	[
		["plan-absent", "The portfolio job completed without writing a priorities plan.", "Check the flow's prompt, and the next report's opening line."],
		["plan-not-portfolio", "A plan was written by a job that is not a portfolio job (its flag was removed, or it was a manual or chained run), so it was refused.", "Run the plan from the trigger that carries the portfolio flag."],
		["plan-oversize", "The plan file was larger than a plan may be, so it was refused.", "Check the flow: a plan is a small file."],
		["plan-not-regular-file", "The plan was not a regular file (a link or a folder), so it was refused.", "Check the flow: it must write the plan as a plain file."],
		["plan-unreadable", "The plan file could not be read, so it was refused.", "Check the worker log for the error."],
		["plan-parse-error", "The plan file was not valid JSON, so it was refused.", "Check the flow's output; a smaller model often gets the format wrong."],
		["plan-collect-error", "The worker could not tell what became of the plan (it may have applied), so it wrote nothing more.", "Read the allocation audit file and the worker log."],
		["plan-invalid", "The plan broke a rule of the plan format, so it was refused.", "Read the audit file for the field and the rule."],
		["delegation-off", "The envelope does not delegate allocation, so no plan may apply.", "Turn delegation on in the envelope if plans should apply."],
		["writer-not-allowed", "The envelope does not list this writer among the ones that may apply a plan.", "Add `portfolio-job` to the envelope's writers if this job should apply plans."],
		["envelope-mismatch", "This worker's envelope differs from the one the current split was made for, so the plan was refused.", "Run `pi-dispatch doctor` on each worker and make their envelopes agree."],
		["plan-duplicate", "The same plan had already been applied, so nothing changed.", "Nothing to fix."],
		["plan-stale", "Another plan applied after the one this plan was written against, so it was refused.", "Nothing to fix: the next plan starts from the current split."],
		["plan-too-soon", "The plan came sooner after the last one than the envelope's minimum interval allows, so it was refused.", "Wait out the interval, or shorten `minIntervalHours`."],
		["plan-incomplete", "The plan left out a project or member it must name, so it was refused.", "Read the audit file for what was missing."],
		["plan-busy", "Another plan or a revert was being applied at the same moment, so this plan was refused.", "Run the portfolio job again if this plan should still apply."],
	],
	() => PLAN_ANCHOR,
);

/** The nested tables `explainReason` reads by `field`, keyed by the record's field path. */
export const NESTED_REASONS = Object.freeze({ "session.reason": SESSION_REASON_TEXT, recoverSkipped: RECOVER_SKIPPED_TEXT, "plan.reason": PLAN_REASON_TEXT });

// ── Why a run went without a feature (moved from admin/src/read-model.mjs in issue #710, which re-exports them) ───────
// Each is a CLAUSE the surfaces print after the token ("skipped (fork): ..."), not a sentence, so they keep their shape.

/**
 * Why a job ran without its project's bundle, one sentence per `bundleSkipped` reason (the worker's
 * BUNDLE_SKIPPED_REASONS, held to this table by a test so a new reason cannot render as nothing).
 */
export const BUNDLE_SKIPPED_TEXT = Object.freeze({
	manual: "a manual run (no trigger made it), so it got no bundle",
	chained: "a chained /outbox child, so it got no bundle: the grant was to the trigger, not to what its job queues",
	"opted-out": "its trigger sets run.secretBundle: false",
	fork: "a pull request from another repository, and the bundle does not set forkReviews",
	"head-unverified": "the forge would not say whose pull request this is (401, 403 or 404), so it ran as a fork's, without the bundle",
});

/** Why a steer-armed run went without steering (the record's `steerSkipped`), keyed like STEER_SKIPPED_REASONS. */
export const STEER_SKIPPED_TEXT = Object.freeze({
	"venue-copies": "its venue copies the job's files (no /inbox mount) and its job image does not declare steerStdin, so no message could reach the run",
	"no-exit-key": "its job image does not declare exitAuth, so no delivery could be verified",
	"no-transcript": "nothing could read the delivery acks: on a venue that copies the job's files its job image does not declare transcriptStderr (the acks come back over that stream), or no transcript could be staged, or this worker has no tail or relay wired",
	"no-inbox": "the run's inbox directory could not be made",
});

/** Why a run had no live transcript, and so no live progress (the record's `liveSkipped`), keyed like LIVE_SKIPPED_REASONS. */
export const LIVE_SKIPPED_TEXT = Object.freeze({
	"venue-copies": "its venue copies the job's files and does not stream the transcript back",
	"no-capability": "its venue streams the transcript only from a job image that declares transcriptStderr, and this one does not",
	"no-exit-key": "its job image does not declare exitAuth, so a streamed transcript could not be verified",
});

/**
 * Explain a reason: `{ known: true, token, sentence, next, anchor }`, or `{ known: false }` for anything that is not a
 * key of the table (a newer worker's token, a non-string, `__proto__`). `why` picks a variant of the sentence where the
 * reason has one (`WHY_VARIANTS`); `field` names a nested reason (`session.reason`, `recoverSkipped`, `plan.reason`)
 * instead of the record's top-level `reason`. Never throws, whatever it is given: `opts` may be absent, `null` or any
 * value (a non-object reads as no options), and a throwing getter on it answers `{ known: false }` rather than escaping
 * into a surface that renders a list of records.
 */
export function explainReason(token, opts) {
	try {
		const { why = null, field = null } = opts !== null && typeof opts === "object" ? opts : {};
		const table = field === null ? REASONS : typeof field === "string" && Object.hasOwn(NESTED_REASONS, field) ? NESTED_REASONS[field] : null;
		if (table === null || typeof token !== "string" || !Object.hasOwn(table, token)) return { known: false };
		const found = table[token];
		const variant = field === null && Object.hasOwn(WHY_VARIANTS, token) ? WHY_VARIANTS[token](why) : null;
		return { known: true, token, sentence: variant ?? found.sentence, next: found.next, anchor: found.anchor };
	} catch {
		return { known: false };
	}
}
