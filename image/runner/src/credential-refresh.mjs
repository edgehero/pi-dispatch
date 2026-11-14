import * as nodeFs from "node:fs";
import { join } from "node:path";

/**
 * Credentials renewed in a running job (issue #888, part 3, `INT-CREDENTIAL-DROP`, `CONST-TOKEN-SCOPED-PER-JOB`).
 *
 * A job no longer ends at 30 minutes, and two of its credentials do not last that long by design: a GitHub App
 * installation token lives one hour, and a subscription sign-in's snapshot is handed over with a deadline (the worker's
 * rule, `auth-connections.mjs`) after which the runner refuses to use it. The worker renews both while the job runs and
 * writes them into a folder mounted READ-ONLY at `CREDENTIAL_DIR`; this module reads it and puts each renewed value where
 * the job uses it:
 *   - the forge token into this process's environment under the GitHub names, so every tool process started from now on
 *     (`git`, `gh`, a script) gets it. A process started earlier keeps the token it was given, which is the residual;
 *   - a subscription's new access token and deadline into the subscription guard (`subscription-credentials.mjs`
 *     `refresh`), which checks it is the same connection and only moves forward, and into the environment for a role
 *     child started from now on.
 *
 * WHY THE FOLDER IS TRUSTED. It is a read-only bind of a folder only the worker writes: the agent can read it (it can read
 * this process's environment too, which already holds the same kind of value) but cannot change it. Every value is still
 * held to its shape, and a drop is applied only when its `seq` is above the last one applied, so a stale file read twice
 * changes nothing.
 *
 * Off unless the worker asked (`PI_CREDENTIAL_REFRESH=1`, env-internal, removed once read). Never throws once started:
 * a drop that cannot be read or applied is logged by kind and the job keeps the credentials it has.
 */

/** Where the worker's drop is mounted, read-only. The worker's `CONTAINER_CREDENTIALS_DIR` is held to it by a test. */
export const CREDENTIAL_DIR = "/run/pi-dispatch/credentials";
/** The drop's file in it, written by the worker with an atomic rename. */
export const CREDENTIAL_FILE = "current.json";
/** How often the folder is read, and the most of the file read. */
export const CREDENTIAL_POLL_MS = 15_000;
const CREDENTIAL_FILE_MAX_BYTES = 64 * 1024;
/** The names a GitHub token is written under in a job (the worker's `MINTED_TOKEN_VARS.github`, held equal by a test). */
export const FORGE_TOKEN_VARS = Object.freeze(["GH_TOKEN", "GITHUB_TOKEN"]);
/** A subscription's token variable by provider (`subscription-credentials.mjs` `subscriptionAccess`). */
const SUBSCRIPTION_VARS = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_OAUTH_TOKEN" });

const TOKEN_RE = /^[\x21-\x7e]{8,4096}$/;
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether the worker asked for renewal: `PI_CREDENTIAL_REFRESH=1`, removed from the environment once read so no tool or
 * child inherits it. Any other value is not asked.
 */
export function readCredentialRefreshWanted(env = process.env) {
	// env-internal PI_CREDENTIAL_REFRESH: written by the worker into the job's closed env map, removed here once read.
	const wanted = env.PI_CREDENTIAL_REFRESH === "1";
	delete env.PI_CREDENTIAL_REFRESH;
	return wanted;
}

/**
 * A drop's contents held to their shape: `{ seq, forge: { token } | null, subscriptions: [{ provider, connectionId,
 * generation, expiresAt, deadlineAt, token }] }`, or null for anything else. Never a partial drop: one bad entry refuses
 * the whole file, so a half-written or tampered one is never half applied.
 */
export function parseCredentialDrop(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 1) return null;
	let forge = null;
	if (value.forge !== undefined && value.forge !== null) {
		if (!isRecord(value.forge) || typeof value.forge.token !== "string" || !TOKEN_RE.test(value.forge.token)) return null;
		forge = { token: value.forge.token };
	}
	const subscriptions = [];
	for (const row of value.subscriptions ?? []) {
		if (!isRecord(row) || !Object.hasOwn(SUBSCRIPTION_VARS, row.provider)) return null;
		if (typeof row.connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.connectionId)) return null;
		for (const key of ["generation", "expiresAt", "deadlineAt"]) if (!Number.isSafeInteger(row[key]) || row[key] < 0) return null;
		if (typeof row.token !== "string" || !TOKEN_RE.test(row.token)) return null;
		subscriptions.push({ provider: row.provider, connectionId: row.connectionId, generation: row.generation, expiresAt: row.expiresAt, deadlineAt: row.deadlineAt, token: row.token });
	}
	if (subscriptions.length > 2) return null;
	return { seq: value.seq, forge, subscriptions };
}

/** Read the drop in `dir`, or null. The folder is read-only to the job, and the file is still read as untrusted bytes. */
export function readCredentialDrop(dir = CREDENTIAL_DIR, { fs = nodeFs } = {}) {
	const path = join(dir, CREDENTIAL_FILE);
	let fd = null;
	try {
		const info = fs.lstatSync(path);
		if (!info.isFile() || info.size > CREDENTIAL_FILE_MAX_BYTES) return null;
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const buf = Buffer.alloc(CREDENTIAL_FILE_MAX_BYTES + 1);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		return parseCredentialDrop(buf.subarray(0, n).toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

/**
 * `createCredentialRefresher({ read, env, subscriptions, onForge, log, timers, pollMs })` -> `{ start(), stop(), apply() }`.
 *
 *   - `apply()` reads the drop once and applies it when its `seq` is new: the forge token into `env` under
 *     FORGE_TOKEN_VARS (only names the job already carries, so a job that was given no GitHub token gets none), and each
 *     subscription through `subscriptions.refresh(row)` (null without a guard), whose token then goes into `env` too.
 *     `onForge(token)` hears a new forge token (the forge MCP server's restart, `run-job.mjs`).
 *   - `start()` applies once now (a drop already there when the job starts) and then every `pollMs`, on an unref'd timer.
 * Logs `credential_refreshed { forge, subscriptions, seq }` (booleans and counts, never a value) or
 * `credential_refresh_refused { reason }`.
 */
export function createCredentialRefresher({ read = () => readCredentialDrop(), env = process.env, subscriptions = null, onForge = () => {}, onSubscriptions = () => {}, log = () => {}, timers = { setInterval, clearInterval }, pollMs = CREDENTIAL_POLL_MS }) {
	let lastSeq = 0;
	let timer = null;
	function apply() {
		let drop;
		try {
			drop = read();
		} catch {
			drop = null;
		}
		if (drop === null || drop.seq <= lastSeq) return false;
		lastSeq = drop.seq;
		let forge = false;
		if (drop.forge !== null) {
			for (const name of FORGE_TOKEN_VARS) {
				if (typeof env[name] === "string" && env[name] !== "") {
					env[name] = drop.forge.token;
					forge = true;
				}
			}
			if (forge) {
				try {
					onForge(drop.forge.token);
				} catch {}
			}
		}
		let renewed = 0;
		for (const row of drop.subscriptions) {
			let ok = false;
			try {
				ok = subscriptions?.refresh?.(row) === true;
			} catch {
				ok = false;
			}
			if (!ok) {
				log("credential_refresh_refused", { reason: "subscription", provider: row.provider });
				continue;
			}
			env[SUBSCRIPTION_VARS[row.provider]] = row.token;
			renewed += 1;
		}
		if (renewed > 0) {
			try {
				onSubscriptions();
			} catch {}
		}
		log("credential_refreshed", { seq: drop.seq, forge, subscriptions: renewed });
		return true;
	}
	return {
		apply,
		start() {
			if (timer !== null) return;
			apply();
			timer = timers.setInterval(apply, pollMs);
			timer?.unref?.();
		},
		stop() {
			if (timer !== null) timers.clearInterval(timer);
			timer = null;
		},
	};
}
