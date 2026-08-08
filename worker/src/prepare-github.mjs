/*
 * prepare-github.mjs — build the read-only /job inputs for a GitHub-triggered job by cloning the
 * serviced repo AT A PINNED SHA onto the host, then materialising its .pi/ and writing the prompt.
 *
 * This is the highest-risk host operation in the worker: it places attacker-influenced repository
 * bytes on the host filesystem before any container exists. Two properties make it safe, and both
 * are structural, not content filters:
 *
 *   1. THE CLONE RUNS NO REPO-SUPPLIED CODE. Every git invocation carries
 *      `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never
 *      -c credential.helper=` and `--no-pager`, and the fetch is `--no-recurse-submodules`. Hooks,
 *      the fsmonitor daemon, ext-protocol transports, credential helpers, and submodules are the
 *      paths by which a repo runs code during clone/checkout; all are disabled. `.pi/` is then read
 *      by object id via materializePiDir (`git cat-file`), never through the working tree, so no
 *      symlink/filter/hook runs there either. Per CONST-ISOLATION-CONTAINER-PER-JOB the agent runs
 *      in the container; the host only assembles the box's inputs and must not itself execute repo
 *      code.
 *
 *   2. THE TOKEN NEVER LANDS ANYWHERE THE AGENT OR THE REPO CAN READ IT. The per-job credential
 *      reaches git ONLY through a GIT_ASKPASS helper's env var (GIT_ASKPASS_TOKEN), never in argv, a
 *      remote URL, or the persisted `.git/config` (the remote is the tokenless
 *      `https://github.com/<owner>/<name>.git`, with no `x-access-token@` and no `url.*.insteadOf`).
 *      The askpass script itself holds no token — it prints the env var — and lives in a host temp
 *      dir OUTSIDE jobDir and workspace/, removed in a `finally`. jobDir is mounted `/job` :ro and IS
 *      agent-readable, so nothing token-bearing is written under it. See CONST-TOKEN-SCOPED-PER-JOB
 *      and no-token-in-agent-reachable-file.
 *
 * The /job inputs written here are exactly INT-CONTAINER-JOB-INPUTS: `prompt.md` (the user prompt,
 * issue text as DATA), `event.json` (the INT-WEBHOOK-PAYLOAD-SUBSET body fields only — never a
 * header, never the `X-Hub-Signature-256` signature, never the token; on issue_comment jobs the
 * named subset includes the invoking `comment` body fields, and the one non-webhook addition is
 * `matched` — the filter's decision record of which triggers.json entry fired, by raw file index,
 * harness-computed rather than taken from any payload), and `pi/` (materialised persona/skills).
 * Neither the token nor any issue text is logged.
 *
 * A determinate gone-SHA (the default branch advanced past the resolved tip before the fetch) is a
 * POLICY outcome, returned as `{ outcome: "policy", reason: "sha-gone" }` — NOT thrown, so the
 * processor does not retry a job that can never fetch that commit. Every other fetch failure
 * (DNS/connection/timeout/5xx/auth) throws InfraRetry and is retried. The discipline mirrors
 * github-host.mjs's 404-vs-other split: only the determinate class becomes policy.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildGithubPrompt } from "./github-prompt.mjs";
import { materializePiDir } from "./materialize.mjs";
import { InfraRetry } from "./processor.mjs";

const exec = promisify(execFile);

// The -c flags that make a clone/checkout run no repo-supplied code, applied to EVERY git invocation
// through `hardened()` below so they cannot be omitted at a call site. Matches materialize.mjs's bar
// (hooksPath, fsmonitor, --no-pager) plus the clone-specific transport/credential locks.
const HARDEN_FLAGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"credential.helper=",
	"--no-pager",
];

/** Prepend the hardening flags to a bare git subcommand's args. */
function hardened(args) {
	return [...HARDEN_FLAGS, ...args];
}

// stderr fragments that mean the resolved SHA is provably gone from the remote: the default branch
// advanced and git can no longer fetch/realise that commit. These are DETERMINATE, so they map to a
// policy refusal, never a retry. Any other failure stays retryable (see fetch catch below).
const SHA_GONE_MARKERS = [
	"couldn't find remote ref",
	"not our ref",
	"unadvertised object",
	"did not send all necessary objects",
	"reference is not a tree",
];

/** True only when a git error's output names one of the determinate gone-SHA conditions. */
function isShaGone(error) {
	const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`.toLowerCase();
	return SHA_GONE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Prepare a GITHUB job's read-only /job inputs. Clones `job.repo` at the caller-resolved default-
 * branch SHA into `jobDir/workspace`, materialises `.pi/` into `jobDir/pi`, and writes `prompt.md`
 * and `event.json`. Mirrors prepare-local's jobDir-in shape and return object.
 *
 * Collaborators are injected so tests run offline against fakes and never touch a real network/git:
 *   - `git(cwd, args, { env })`      transport for a single git invocation; default runs the real
 *                                     binary via execFile (no shell). Args arrive already hardened.
 *   - `resolveDefaultBranchSha(repo, token) => { sha }`  fresh default-branch tip (github-host).
 *   - `materialize({ gitDir, sha, destDir }) => string[]`  the .pi/ materialiser (git cat-file).
 *   - `writeFile` / `mkdir`          fs writes for the job inputs (default sync fs).
 *
 * On a determinate gone-SHA returns `{ outcome: "policy", reason: "sha-gone" }`. On success returns
 * `{ workspace, jobDir, sha, materialised }`.
 */
export async function prepareGithubWorkspace(
	job,
	token,
	{
		jobDir,
		git = defaultGit,
		resolveDefaultBranchSha,
		materialize = materializePiDir,
		writeFile = writeFileSync,
		mkdir = mkdirSync,
		// How this forge names a clone URL, and how it phrases the agent's envelope. Injected rather than
		// forked into a second copy of this function: everything else here -- the askpass helper, the
		// hardening flags, the gone-SHA markers, the pinned detached checkout, the :ro event.json -- is
		// git and this project, not GitHub, and a second copy is a second place to fix a clone bug.
		remoteUrlFor = (j) => `https://github.com/${String(j.repo).split("/")[0]}/${String(j.repo).split("/")[1]}.git`,
		buildPrompt = buildGithubPrompt,
		// REQ-RESUMABLE-SESSION. Both default to inert, so an unwired caller prepares what it always did.
		resolvePullRequestHead = null,
		resolveSession = () => null,
		piVersion = null,
	} = {},
) {
	// Fresh API resolve of the commit to clone at — never a webhook field, never the triggering branch.
	const { sha } = await resolveDefaultBranchSha(job, token);

	const workspace = join(jobDir, "workspace");
	mkdir(workspace, { recursive: true });

	// The remote URL is TOKENLESS; the credential comes from the askpass helper's env, never from here.
	const remoteUrl = remoteUrlFor(job);

	const askpass = createAskpassHelper();
	try {
		await git(workspace, hardened(["init"]));
		await git(workspace, hardened(["remote", "add", "origin", remoteUrl]));

		// The token reaches git ONLY here, via GIT_ASKPASS_TOKEN read by the helper — never argv/URL.
		const netEnv = {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: askpass.path,
			GIT_ASKPASS_TOKEN: token,
		};

		try {
			await git(
				workspace,
				hardened(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", sha]),
				{ env: netEnv },
			);
			await git(workspace, hardened(["checkout", "--detach", "FETCH_HEAD"]));
		} catch (error) {
			// Determinate gone-SHA => policy, no retry. Anything else (DNS/connection/timeout/5xx/auth)
			// => retryable infra. The cause carries git's output for debugging; it is token-free by
			// construction (tokenless remote URL + askpass), and BullMQ persists only message+stack.
			if (isShaGone(error)) {
				return { outcome: "policy", reason: "sha-gone" };
			}
			throw new InfraRetry(`prepare-github: fetch failed for ${job.repo}`, { cause: error });
		}

		// .pi/ is read by object id from the pinned SHA — symlink/submodule/exec safe, no working tree.
		const materialised = await materialize({ gitDir: workspace, sha, destDir: jobDir });

		// Which transcript, if any, this job continues. The head ref for a pull/merge-request target is
		// resolved from the FORGE, not the payload -- an issue_comment on a PR carries no head at all, and
		// head.repo.full_name in a webhook body is attacker-supplied. Both this lookup and the store itself
		// degrade to a cold start rather than failing the job: a cache miss must never cost a run.
		let resolved = {};
		if (job.resume === true && job.target?.type === "pull_request" && resolvePullRequestHead) {
			try {
				resolved = (await resolvePullRequestHead(job, token)) ?? {};
			} catch {
				resolved = {};
			}
		}
		const session = job.resume === true ? resolveSession(job, { jobDir, resolved, piVersion }) : null;

		// Issue text is DATA: it enters the USER prompt (buildGithubPrompt), never a system prompt.
		writeFile(
			join(jobDir, "prompt.md"),
			// `replica`/`replicas` (REQ-REPLICA-RUNS) are host-assigned integers off job.data, so they are safe
			// to interpolate, and they are what makes this job's branch differ from its sibling's. This is the
			// SHARED forge preparer, so the gitlab/forgejo/azure builders receive the two keys and destructure
			// them away -- harmless, and always undefined while replicas are github-only.
			// `review` rides beside `comment` and, like `replica`/`replicas`, is destructured away by the
			// gitlab/forgejo/azure builders -- harmless, and always undefined while reviews are github-only.
			buildPrompt({ flow: job.flow, target: job.target, comment: job.trigger?.comment, resumed: session?.resume === true, replica: job.replica, replicas: job.replicas, review: job.trigger?.review }),
			{ mode: 0o444 },
		);

		// The INT-WEBHOOK-PAYLOAD-SUBSET body fields ONLY — no header, no signature, no token. `matched`
		// is the single harness-computed addition: the filter's decision record, not a webhook field.
		//
		// `replica`/`replicas` are DELIBERATELY ABSENT, and that is a choice rather than an oversight. This
		// literal is the webhook's own body plus one decision record; an execution knob is not a fact about
		// the delivery. The agent already learns its index from the prompt and `PI_JOB_ID` already ends
		// `-r2`, so nothing here needs it -- and INT-CONTAINER-JOB-INPUTS and INT-WEBHOOK-PAYLOAD-SUBSET stay
		// untouched, which is worth more than the convenience.
		const subset = {
			event: job.trigger?.event,
			action: job.trigger?.action,
			delivery: job.trigger?.deliveryId,
			repository: { full_name: job.repo },
			...(job.target?.type === "pull_request" ? { pull_request: prEventBody(job.target) } : { issue: { number: job.target?.number, title: job.target?.title, body: job.target?.body } }),
			...(job.trigger?.comment ? { comment: { body: job.trigger.comment.body, author_association: job.trigger.comment.author_association } } : {}),
			// The invoking review, review-triggered jobs only (issue #66). Written as an explicit literal
			// rather than a spread, the same discipline as `comment` above: this object is the subset's
			// named fields, not whatever happened to reach the queue. Conditional for the same reason too --
			// a PR job without a review must stay byte-identical to the one this file wrote before #66.
			//
			// `action` above is `submitted` (GitHub's word) while `matched.action` below is
			// `review_submitted` (the triggers.json word). They differ on purpose; INT-CONTAINER-JOB-INPUTS
			// says which is which.
			...(job.trigger?.review ? { review: { id: job.trigger.review.id, body: job.trigger.review.body, state: job.trigger.review.state, author_association: job.trigger.review.author_association } } : {}),
			sender: { id: job.trigger?.sender?.id },
			...(job.trigger?.matched ? { matched: job.trigger.matched } : {}),
		};
		writeFile(join(jobDir, "event.json"), JSON.stringify(subset, null, 2), { mode: 0o444 });

		return { workspace, jobDir, sha, materialised, ...(session ? { session } : {}) };
	} finally {
		// The askpass machinery must not outlive the prepare, and must never be agent-reachable.
		rmSync(askpass.dir, { recursive: true, force: true });
	}
}

/**
 * The `pull_request` body for event.json, from the job's PR target. `head`/`base` are attacker-controlled
 * fork DATA carried for the flow's own `gh` use; they are surfaced here, never used as a clone ref. Absent
 * when the target lacks them (a comment-triggered PR job resolves them from the number via `gh`).
 */
function prEventBody(target) {
	const body = { number: target.number, title: target.title, body: target.body };
	if (target.head) body.head = target.head;
	if (target.base) body.base = target.base;
	return body;
}

/**
 * Write the GIT_ASKPASS helper to a fresh host temp dir OUTSIDE jobDir/workspace. The script holds no
 * token: it prints GIT_ASKPASS_TOKEN, which git sets in the child's env only for the network fetch.
 * Returns `{ dir, path }`; the caller removes `dir` in a finally.
 */
function createAskpassHelper() {
	const dir = mkdtempSync(join(tmpdir(), "pi-askpass-"));
	const path = join(dir, "askpass.sh");
	writeFileSync(path, "#!/bin/sh\nprintf '%s' \"$GIT_ASKPASS_TOKEN\"\n", { mode: 0o700 });
	chmodSync(path, 0o700);
	return { dir, path };
}

/**
 * Transport for one git invocation. `args` arrive already hardened by `hardened()`. Runs the real
 * binary via execFile (array args, NO shell); `cwd` is the workspace and `env` is passed only for the
 * network fetch (the askpass env), so local calls inherit the ambient environment.
 */
async function defaultGit(cwd, args, { env } = {}) {
	const { stdout } = await exec("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		env,
	});
	return stdout;
}
