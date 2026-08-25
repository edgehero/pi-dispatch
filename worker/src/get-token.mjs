/**
 * GitHub authentication for the worker: mint a per-job scoped token and resolve the harness's own
 * identity ONCE at construction. Three sources -- a user PAT, the `gh` CLI, or a GitHub App -- each
 * yielding the same `{ mintToken, selfId, source }` shape so the processor never branches on source.
 *
 * CONST-TOKEN-SCOPED-PER-JOB: the App path mints one installation token per job, scoped to the one
 * repo, expiring in an hour. That short-lived, repo-scoped expiry IS the blast-radius bound for an
 * exfiltrated environment (App: 1h; a single-owner fine-grained PAT: operator-set, still short).
 * The per-job SCOPING claim is the App path's property alone: `gh` and `pat` hand out the
 * operator-scoped credential and rely on the operator keeping that credential narrow (the
 * INT-CONTAINER-RUNTIME-CONTRACT trade-off note).
 *
 * Money-hole invariant: `mintToken` NEVER returns "" / null. `env-allowlist.mjs` forwards the token
 * as `GITHUB_TOKEN` only when truthy (`if (githubToken)`), so an empty token becomes an ABSENT
 * variable -- a silent anonymous run that still spends provider money. Every mint path routes through
 * `requireToken`, which throws `configError` on an empty/whitespace token instead of handing it out.
 *
 * All side-effecting collaborators are INJECTED (Octokit, createAppAuth, execFile, readFile, env),
 * each defaulting to the real import -- the budget.mjs / identity.mjs DI convention -- so the whole
 * module is testable offline with no GitHub, no `gh` binary, and no filesystem.
 */

import { execFile as realExecFile } from "node:child_process";
import { readFile as realReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createAppAuth as realCreateAppAuth } from "@octokit/auth-app";
import { Octokit as RealOctokit } from "@octokit/rest";
import { configError } from "./config.mjs";
import { resolveSelfId } from "./identity.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * Build the auth surface for `cfg = { source, patVar?, appId?, installationId?, privateKeyPath? }`.
 *
 * Returns `{ mintToken, selfId, source }`:
 *   - `mintToken(job)` -> a non-empty token string (rejects, never returns empty). It takes the whole
 *     job, not a repo, because that is the shape every forge's auth can implement: each reads whatever
 *     identifies the target on its own side (here `job.repo`) without the caller knowing which forge it
 *     asked. A local `run.github` cron job carries no `repo`, which the App path refuses below.
 *   - `selfId` -> the acting identity's integer user id (resolved once here, for the bot-loop guard).
 *   - `source` -> the configured source, echoed back.
 *
 * Fails CLOSED at construction: an empty PAT, an unreadable PEM, a logged-out `gh`, or an
 * unresolvable identity throws before returning, so a misconfigured worker refuses to boot.
 */
export async function makeGitHubAuth(cfg, deps = {}) {
	// The explicit, named opt-out for the gh-source resume refusal below (PI_SESSIONS_ALLOW_GH_SOURCE).
	// Read once at construction, and strictly `=== true` so a hand-set string cannot arm it.
	const allowGhResume = cfg?.allowGhResume === true;
	const {
		Octokit = RealOctokit,
		createAppAuth = realCreateAppAuth,
		execFile = realExecFile,
		readFile = realReadFile,
		env = process.env,
	} = deps;

	const source = cfg?.source;

	if (source === "pat") {
		const patVar = cfg.patVar ?? "GITHUB_PAT";
		const token = requireToken(env[patVar], patVar);
		const octokit = new Octokit({ auth: token });
		const selfId = await resolveSelfId({ source: "pat", octokit });
		const mintToken = async () => requireToken(token, patVar);
		return { mintToken, selfId, source };
	}

	if (source === "gh") {
		const execFileAsync = promisify(execFile);
		const ghToken = () => runGhAuthToken(execFileAsync);
		// Resolve identity from a token minted once here; each job mints its own below.
		const octokit = new Octokit({ auth: await ghToken() });
		const selfId = await resolveSelfId({ source: "gh", octokit });
		const mintToken = async (job) => {
			assertResumeAllowedOnGhSource(job, allowGhResume);
			return ghToken();
		};
		return { mintToken, selfId, source };
	}

	if (source === "app") {
		if (!cfg.appId || !cfg.installationId || (!cfg.privateKeyPath && !cfg.privateKey)) {
			throw configError(
				"app auth requires appId, installationId, and one of privateKeyPath / privateKey (see .env.example)",
			);
		}
		// The key is either already in hand (GITHUB_APP_PRIVATE_KEY, normalised and shape-checked at config
		// load) or on disk. loadGitHubAuth refuses both-set, so this is a fallback, never a precedence rule.
		const privateKey = cfg.privateKey ?? (await readPem(readFile, cfg.privateKeyPath));
		const auth = { appId: cfg.appId, privateKey, installationId: cfg.installationId };

		// App-JWT client: resolveSelfId's app path reads GET /app then GET /users/{slug}[bot].
		const octokit = new Octokit({ authStrategy: createAppAuth, auth });
		const selfId = await resolveSelfId({ source: "app", octokit });

		const mintToken = async (job) => {
			const repo = job?.repo;
			// A local run.github job carries no repo, and an installation token MUST be scoped to one
			// (CONST-TOKEN-SCOPED-PER-JOB) -- refuse deterministically rather than mint broad.
			if (!repo || !String(repo).trim()) {
				throw configError(
					"GITHUB_AUTH_SOURCE=app mints per-repo installation tokens, and a local run.github job has no repo to scope to -- use gh or pat for run.github cron triggers, or run the work as a github job",
				);
			}
			const repositoryNames = [repoNameOf(repo)]; // scope to the ONE repo; owner stripped
			let minted;
			try {
				const appAuth = createAppAuth(auth);
				minted = await appAuth({ type: "installation", repositoryNames });
			} catch (error) {
				throw classifyAppMintError(error);
			}
			return requireToken(minted?.token, "app installation token");
		};
		return { mintToken, selfId, source };
	}

	throw configError(`makeGitHubAuth: unknown or missing source: ${JSON.stringify(source)}`);
}

/**
 * Enforce the money-hole invariant: return a trimmed non-empty token, or throw `configError`.
 * Handing back "" would let `env-allowlist.mjs` drop `GITHUB_TOKEN` entirely and run anonymously.
 */
function requireToken(raw, what) {
	const token = (raw ?? "").trim();
	if (!token) {
		throw configError(
			`${what}: empty token -- refusing to run (an absent GITHUB_TOKEN runs anonymously on paid infra)`,
		);
	}
	return token;
}

/** Run `gh auth token` (array args, no shell) and return the trimmed token, or throw configError. */
async function runGhAuthToken(execFileAsync) {
	let stdout;
	try {
		({ stdout } = await execFileAsync("gh", ["auth", "token"]));
	} catch (error) {
		// ENOENT (binary absent) or a non-zero exit (logged out / broken) -- both deterministic.
		const detail = error?.code ?? error?.message ?? "unknown";
		throw configError(`\`gh auth token\` failed (${detail}); is the gh CLI installed and logged in?`);
	}
	// Logged-out gh can exit 0 with empty stdout; an empty token is the money hole, so refuse it.
	return requireToken(stdout, "gh auth token");
}

/** Read a PEM file as UTF-8, throwing configError on an unreadable or empty file. */
async function readPem(readFile, path) {
	let pem;
	try {
		pem = await readFile(path, "utf8");
	} catch (error) {
		throw configError(`could not read private key at ${path}: ${error?.code ?? error?.message ?? "unknown"}`);
	}
	if (!pem || !pem.trim()) {
		throw configError(`private key at ${path} is empty`);
	}
	return pem;
}

/** `"owner/name"` -> `"name"`. The installation token is scoped by repo NAME, not `owner/name`. */
function repoNameOf(repo) {
	const name = String(repo ?? "").split("/").pop()?.trim() ?? "";
	if (!name) {
		throw configError(`app token mint: invalid repo, expected "owner/name", got ${JSON.stringify(repo)}`);
	}
	return name;
}

/**
 * Map an octokit/auth-app rejection to the retry-vs-config distinction the queue depends on.
 * Retryable (InfraRetry): 429, 403 + Retry-After (secondary rate limit), 5xx, and status-less
 * network faults (ENOTFOUND/ECONNRESET/ETIMEDOUT). Deterministic (configError): 401 bad
 * credentials, 404 unknown installation, and any other 4xx. Collapsing all 4xx to config would
 * turn a transient rate-limit into a permanent failure, so the classes are kept disjoint.
 */
function classifyAppMintError(error) {
	const status = typeof error?.status === "number" ? error.status : undefined;
	const retryAfter = error?.response?.headers?.["retry-after"];

	if (status === 401) return configError("app token mint refused: bad app credentials (401)");
	if (status === 404) return configError("app token mint refused: unknown installation (404)");
	if (status === 429) return new InfraRetry("app token mint: rate limited (429)");
	if (status === 403 && retryAfter !== undefined) {
		return new InfraRetry("app token mint: secondary rate limit (403 + retry-after)");
	}
	if (status !== undefined && status >= 500) {
		return new InfraRetry(`app token mint: upstream error (${status})`);
	}
	if (status !== undefined) {
		return configError(`app token mint failed (${status}): ${error?.message ?? "unknown"}`);
	}
	// No HTTP status -> network-level fault. Retry per INT-RUNNER-EXIT-CODE-PROTOCOL.
	const detail = error?.code ? `${error.code}: ` : "";
	return new InfraRetry(`app token mint: network fault: ${detail}${error?.message ?? "unknown"}`);
}

/**
 * Refuse to mint the `gh` source's credential for a job that will persist its transcript
 * (REQ-RESUMABLE-SESSION x CONST-TOKEN-SCOPED-PER-JOB). Pure and total so the decision is testable
 * offline -- the gh path itself shells out to a real `gh`, and a security gate that needs a live CLI to
 * exercise is a gate nobody re-tests.
 *
 * Every property CONST-TOKEN-SCOPED-PER-JOB relies on assumes the credential is an ENV VALUE: it lives in
 * container memory and dies with the container, which is what makes `short-lived` do real work. A
 * persisted transcript is a FILE, and any command the agent ran that echoed its own authorization header
 * wrote the token into it -- on host disk, replayed into the next job on that key, for as long as
 * PI_SESSIONS_TTL_DAYS allows. This source is the operator's whole `gh` login: full-scope and
 * NON-EXPIRING, so the one bound that would have contained that exposure is absent exactly where the
 * exposure is most durable. The app and fine-grained-pat paths both carry an expiry.
 *
 * REFUSED rather than warned, and the asymmetry is the whole argument: a warning is read once at setup,
 * the disclosure is permanent and silent, and nothing downstream ever notices. The escape hatch is
 * explicit and named, following PI_GLOBAL_ALLOW_EXTENSIONS -- an operator who has read this can still take
 * the trade, but has to say so rather than miss a line in SECURITY.md.
 *
 * Refused at MINT time, the same shape and moment as the app-source refusal above, so it costs no budget
 * slot and no clone.
 */
export function assertResumeAllowedOnGhSource(job, allowGhResume) {
	if (job?.resume !== true || allowGhResume === true) return;
	throw configError(
		"GITHUB_AUTH_SOURCE=gh is a full-scope, non-expiring credential, and run.resume writes the agent's transcript to disk -- any command that echoed an auth header would persist it. Use GITHUB_AUTH_SOURCE=app or a short-expiry fine-grained PAT, drop run.resume from this trigger, or set PI_SESSIONS_ALLOW_GH_SOURCE=1 to accept the trade explicitly (docs/sessions.md, SECURITY.md)",
	);
}
