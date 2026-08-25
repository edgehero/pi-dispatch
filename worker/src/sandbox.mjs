import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { configError } from "./config.mjs";
import { buildDockerRunArgs } from "./docker-run.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { readManifest } from "./sandbox-store.mjs";

/**
 * sandbox.mjs -- the operator session's container shape (INT-SANDBOX-CONTRACT).
 *
 * A SECOND container shape, deliberately not a second copy of the first. The argv comes from
 * `buildDockerRunArgs` through its `extraFlags` seam, so `ISOLATION_FLAGS`, `--memory` and `--cpus` reach
 * this container BY CONSTRUCTION: a future change to the boundary cannot land on job containers and miss
 * this one, which is the whole reason for reusing the builder rather than writing a leaner argv here.
 *
 * What differs from a job, and every difference is the point:
 *   - `-i -t --entrypoint bash`. `INT-CONTAINER-RUNTIME-CONTRACT` says "No TTY (`-it` absent)" and stays
 *     true; this is a different contract for a different object, not an amendment to that one.
 *   - NO CREDENTIALS. Not the minted forge token, not the provider key, not one forwarded host variable.
 *     `buildContainerEnv` is deliberately NOT reused: it writes the mint into that forge's variable names
 *     (env-allowlist.mjs) and throws outright when no provider credential resolves, so a credential-free
 *     container cannot be produced from it. The env here is two variables, both about the terminal.
 *   - No `/outbox`, no `/session`, no `/opt/pi-global`. The agent is not running; there is nothing to
 *     chain, no transcript to continue and no overlay to layer.
 *
 * The agent is not running. The operator is at the keyboard and brings their own auth if they need it.
 */

const exec = promisify(execFile);

/**
 * The name namespace, and it is load-bearing. The boot reaper filters `name=pi-job-`
 * (`makeReaper` in start.mjs) and docker matches that as a SUBSTRING, so a sandbox must not contain it --
 * otherwise a worker restart kills the shell an operator is sitting in. `pi-sandbox-` is outside that
 * filter on purpose, and a test pins it.
 */
export const SANDBOX_NAME_PREFIX = "pi-sandbox-";

/** `pi-sandbox-<jobId>`. `sanitizeJobId` already maps to `[A-Za-z0-9._-]`, which is a legal docker name. */
export function sandboxContainerName(jobId) {
	return `${SANDBOX_NAME_PREFIX}${sanitizeJobId(jobId)}`;
}

/**
 * Turn `--publish` values into docker flags, BOUND TO LOOPBACK, always.
 *
 * `3000` publishes container 3000 on host 3000; `8080:3000` publishes container 3000 on host 8080. An
 * explicit bind address is refused rather than honoured: this container holds whatever the agent wrote,
 * and the deployment's own admin surface is 127.0.0.1-only for the same reason
 * (`DES-PANEL-SEPARATE-FROM-RECEIVER`). Making the LAN case merely inconvenient would be a worse answer
 * than making it unavailable.
 */
export function parsePublish(values = []) {
	const flags = [];
	for (const raw of values) {
		const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(String(raw).trim());
		const host = match && Number(match[1]);
		const container = match && Number(match[2] ?? match[1]);
		if (!match || !inPortRange(host) || !inPortRange(container)) {
			throw configError(`invalid --publish ${JSON.stringify(raw)} (want <port> or <hostPort>:<containerPort>; the bind address is always 127.0.0.1)`);
		}
		flags.push("-p", `127.0.0.1:${host}:${container}`);
	}
	return flags;
}

function inPortRange(n) {
	return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Build the `docker run` argv for one operator session (excluding the leading "docker").
 *
 * @param image        the image the original run used, from its manifest
 * @param name         `pi-sandbox-<jobId>`
 * @param workspace    host path mounted /workspace:rw -- the retained clone, or the operator's own folder
 * @param jobDir       the retained per-job dir, mounted /job:ro exactly as the run had it
 * @param publish      already-parsed `-p` flags
 * @param term         the host's TERM, so the shell renders
 * @param idleSeconds  bash's own TMOUT; 0 omits it
 * @param network      this session's own egress network (REQ-EGRESS-ALLOWLIST); null = the default bridge
 * @param egressEnv    the proxy variables that go with it, or {} when no policy is armed
 */
export function buildSandboxRunArgs({ image, name, workspace, jobDir, publish = [], term, idleSeconds = 0, network = null, egressEnv: proxyEnv = {} }) {
	return buildDockerRunArgs({
		image,
		name,
		workspace,
		jobDir,
		// The ONLY two variables, and neither is a credential. TERM so the shell renders; TMOUT so a
		// forgotten session closes itself. `buildDockerRunArgs` skips undefined, so an unset TERM or a
		// disabled idle timeout emits nothing rather than an empty string.
		// A sandbox joins the SAME kind of network a job did, by the same builder, so the boundary cannot
		// land on job containers and miss this one. Leaving sandboxes on the default bridge was the tempting
		// alternative and it is the wrong one: it reads as a convenience (install a missing dependency while
		// debugging) and it is a WIDER reach than the run the sandbox exists to reproduce. A shell that can
		// go where the run could not is not reproducing the run. Nothing an operator wants is lost, because
		// the forge and the registry are on the allowlist a job needed anyway.
		network,
		env: {
			TERM: term || undefined,
			TMOUT: idleSeconds > 0 ? String(idleSeconds) : undefined,
			// Still NO CREDENTIALS, and that clause is untouched: a proxy URL is not a credential, and
			// buildContainerEnv is still not reused here. The env is two variables about the terminal and,
			// when a policy is armed, three about the network.
			...proxyEnv,
		},
		// Ahead of the env and the mounts, and well ahead of the image, which buildDockerRunArgs keeps as
		// the final positional. `--entrypoint` also clears the image's CMD; this repo's Dockerfile sets
		// none, so `bash` runs bare and `-it` makes it interactive, in the baked WORKDIR as the baked
		// non-root USER.
		extraFlags: ["-i", "-t", "--entrypoint", "bash", ...publish],
	});
}

/**
 * The JOB IDS of sandboxes running right now -- ids, not container names, because that is the shape both
 * consumers want: the reaper compares them to directory names, and `--list` marks rows.
 *
 * THROWS when docker cannot be asked, and that is the point: "none are running" and "I could not find out"
 * must not arrive as the same empty array. The reaper deletes directories, and it treats the second case as
 * a reason to skip the whole sweep -- swallowing the error here would quietly turn a docker outage into a
 * blind sweep that can pull a bind mount out from under a live shell. The CLI, which only draws a column,
 * degrades on its own.
 *
 * TIMED, unlike the boot container reaper's own `docker ps`: an unreachable daemon does not fail the CLI
 * fast, it blocks, and this call sits in front of a worker that has not started draining yet.
 */
export async function listRunningSandboxes({ execFn = exec } = {}) {
	const { stdout } = await execFn("docker", ["ps", "--filter", `name=${SANDBOX_NAME_PREFIX}`, "--format", "{{.Names}}"], { timeout: 5000 });
	return stdout
		.split("\n")
		.map((n) => n.trim())
		.filter((n) => n.startsWith(SANDBOX_NAME_PREFIX))
		.map((n) => n.slice(SANDBOX_NAME_PREFIX.length));
}

/**
 * Resolve one retained run into a launchable argv, or a NAMED refusal.
 *
 * Split out from the launch so both callers -- the CLI and the admin panel -- refuse identically, and so
 * the whole decision is testable without docker. Every refusal names what to do next, the posture
 * `doctor` sets: a bare "not found" for a run the operator watched finish ten minutes ago is the least
 * useful thing this could say.
 */
export function resolveSandbox({ jobId, sandboxDir, retentionHours, publish = [], fs, fileExists = existsSync }) {
	if (!jobId) return { refused: "no-job-id", message: "a job id is required (see `pi-dispatch sandbox --list`)" };

	const manifest = readManifest({ sandboxDir, jobId, ...(fs ? { fs } : {}) });
	if (!manifest) {
		return retentionHours === 0
			? { refused: "retention-off", message: "workspace retention is off — set PI_SANDBOX_RETENTION_HOURS to a positive number to make future runs resurrectable" }
			: { refused: "absent", message: `no retained workspace for ${jobId} — it was swept after ${retentionHours}h, or the run predates retention (\`pi-dispatch sandbox --list\` shows what is left)` };
	}
	if (!manifest.image) {
		return { refused: "no-image", message: `the manifest for ${jobId} names no image, so the sandbox cannot reproduce the run` };
	}
	if (!manifest.workspace || !fileExists(manifest.workspace)) {
		// The common cause for a local run: the operator's folder moved or was deleted. Naming the path is
		// the whole diagnosis, so name it.
		return { refused: "workspace-gone", message: `the workspace for ${jobId} is no longer at ${manifest.workspace} — a local folder that moved cannot be re-opened` };
	}

	return { manifest, name: sandboxContainerName(jobId), publish };
}

/**
 * Launch one operator session, attached to the caller's terminal, and resolve its exit code.
 *
 * `spawn`, never `spawnSync`, and `stdio: "inherit"`: the same shape pi itself uses to hand the terminal
 * to `$EDITOR` (`extension-editor.js`), whose comment records why the synchronous form is wrong -- on
 * Windows it can keep libuv's console read active and race the child for input.
 *
 * The caller owns the terminal around this: the CLI simply has one, and the admin panel brackets the call
 * with `tui.stop()`/`tui.start()`.
 */
export function launchSandbox({ args, spawnFn = spawn }) {
	return new Promise((resolve) => {
		const child = spawnFn("docker", args, { stdio: "inherit" });
		child.on("error", (err) => resolve({ code: null, error: err }));
		child.on("close", (code) => resolve({ code }));
	});
}
