import * as nodeFs from "node:fs";
import { join } from "node:path";

/**
 * Credentials renewed for a running job, the worker's half (issue #888, part 3, `INT-CREDENTIAL-DROP`,
 * `CONST-TOKEN-SCOPED-PER-JOB`).
 *
 * Since #888 a job runs as long as it keeps working, and two of the credentials it is handed expire on a clock of their
 * own: a GitHub App installation token lives an hour, and a subscription snapshot carries a deadline (30 minutes after
 * the pickup, the window `prepareSnapshot` guarantees the credential covers). Without renewal such a job had to keep the
 * 30-minute wall clock. With it, the worker renews each one before it runs out and drops the new values in a folder beside
 * the job directory, mounted read-only at `/run/pi-dispatch/credentials`, where the runner applies them
 * (image/runner/src/credential-refresh.mjs).
 *
 * WHAT STAYS BOUNDED. Each value is exactly what a fresh job would be handed: a GitHub token scoped to the job's one
 * repository that lives an hour, a subscription snapshot whose deadline is 30 minutes ahead. A stolen one works no longer
 * than it did; only a running job keeps receiving new ones, and it stops receiving them when it ends.
 *
 * WHEN A RENEWAL FAILS. It is tried again every minute. When the credential it renews is two minutes from running out,
 * the job is stopped (`credential-expired`, never retried): every call it makes after that would fail on a slot it keeps.
 */

/** The folder beside the job directory that holds the drop, and the drop's file in it. */
export const CREDENTIALS_DIR_SUFFIX = ".credentials";
export const CREDENTIALS_FILE = "current.json";
/** How often the refresher looks at what is due. */
export const CREDENTIAL_CHECK_MS = 60_000;
/** A GitHub App token is renewed this long before it expires. */
export const FORGE_RENEW_BEFORE_MS = 15 * 60_000;
/** A subscription snapshot is renewed this long before its deadline, and extended to this far ahead. */
export const SUBSCRIPTION_RENEW_BEFORE_MS = 10 * 60_000;
export const SUBSCRIPTION_DEADLINE_AHEAD_MS = 30 * 60_000;
/** A credential this close to running out, with no renewal, stops the job. */
export const CREDENTIAL_STOP_BEFORE_MS = 2 * 60_000;
/** The subscription token's variable by provider (auth-connections.mjs `prepareSnapshot`'s `env`). */
const SUBSCRIPTION_VARS = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_OAUTH_TOKEN" });

/**
 * Make the drop folder beside `jobDir`, fresh and owner-only (0700, the inbox's rule), and return its path, or null when it
 * cannot be made. A leftover from a crashed attempt is removed first: it holds credentials of a run that is gone.
 */
export function makeCredentialsDir(jobDir, { fs = nodeFs } = {}) {
	if (typeof jobDir !== "string" || jobDir === "") return null;
	const dir = `${jobDir}${CREDENTIALS_DIR_SUFFIX}`;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { mode: 0o700 });
		return dir;
	} catch {
		return null;
	}
}

/** Remove the drop folder. Best effort: the boot sweep removes a leftover one beside a crashed job's directory. */
export function removeCredentialsDir(dir, { fs = nodeFs } = {}) {
	if (typeof dir !== "string" || dir === "") return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {}
}

/**
 * Write one drop, atomically: a temp file (0444, the inbox files' mode, inside the 0700 folder), then a rename over
 * `current.json`. Throws on a failed write, so the caller can count it as a renewal that did not land.
 */
export function writeCredentialDrop(dir, payload, { fs = nodeFs } = {}) {
	const tmp = join(dir, `.${CREDENTIALS_FILE}.${payload.seq}.tmp`);
	fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o444, flag: "wx" });
	fs.renameSync(tmp, join(dir, CREDENTIALS_FILE));
}

/**
 * `makeCredentialRefresher({ dir, forge, subscriptions, extend, now, timers, onExpired, log, write })` ->
 * `{ start(), stop(), check(), state }`.
 *
 *   - `forge`: `{ expiresAt, mint }` for a GitHub App token, or null. `mint()` resolves `{ token, expiresAt }` (a FRESH
 *     token, never the auth library's cache) or throws.
 *   - `subscriptions`: the snapshots the job started with; `extend(snapshot, { deadlineAt })` resolves the renewed
 *     snapshot for the same connection, or null.
 *   - `check()` renews what is due, writes one drop when anything was renewed, and asks for a stop (`onExpired()`, once)
 *     when a credential that could not be renewed is CREDENTIAL_STOP_BEFORE_MS from running out.
 * Logs `credential_renewed { forge, subscriptions, seq }` and `credential_renew_failed { kind }`, never a value.
 */
export function makeCredentialRefresher({ dir, forge = null, subscriptions = [], extend = async () => null, now = () => Date.now(), timers = { setInterval, clearInterval }, onExpired = () => {}, log = () => {}, write = (payload) => writeCredentialDrop(dir, payload), checkMs = CREDENTIAL_CHECK_MS }) {
	const state = {
		seq: 0,
		forge: forge ? { expiresAt: forge.expiresAt, token: null } : null,
		subscriptions: subscriptions.map((s) => ({ ...s })),
		// What the RUNNER holds: the expiries of the values last written (or handed at the start). The stop rule reads these,
		// never the renewed values a failed write left only here.
		delivered: { forge: forge ? forge.expiresAt : null, subscriptions: subscriptions.map((s) => s.deadlineAt) },
		dirty: false,
		renewals: 0,
		failures: 0,
		expired: false,
	};
	let timer = null;
	let busy = false;

	const payload = () => ({
		v: 1,
		seq: state.seq,
		forge: state.forge?.token ? { token: state.forge.token } : null,
		subscriptions: state.subscriptions.map((s) => ({ provider: s.provider, connectionId: s.connectionId, generation: s.generation, expiresAt: s.expiresAt, deadlineAt: s.deadlineAt, token: s.env?.[SUBSCRIPTION_VARS[s.provider]] })),
	});

	const expire = (kind) => {
		if (state.expired) return;
		state.expired = true;
		log("credential_expired", { kind });
		try {
			onExpired(kind);
		} catch {}
	};

	async function check() {
		if (busy || state.expired) return;
		busy = true;
		try {
			const at = now();
			let forgeRenewed = false;
			let subsRenewed = 0;
			if (state.forge && at >= state.forge.expiresAt - FORGE_RENEW_BEFORE_MS) {
				try {
					const minted = await forge.mint();
					if (typeof minted?.token !== "string" || minted.token === "" || !Number.isSafeInteger(minted.expiresAt) || minted.expiresAt <= at) throw new Error("no usable token");
					state.forge = { expiresAt: minted.expiresAt, token: minted.token };
					forgeRenewed = true;
				} catch {
					state.failures += 1;
					log("credential_renew_failed", { kind: "forge-token" });
				}
			}
			for (let i = 0; i < state.subscriptions.length; i++) {
				const current = state.subscriptions[i];
				if (at < current.deadlineAt - SUBSCRIPTION_RENEW_BEFORE_MS) continue;
				let next = null;
				try {
					next = await extend(current, { deadlineAt: now() + SUBSCRIPTION_DEADLINE_AHEAD_MS });
				} catch {
					next = null;
				}
				const usable = next && next.connectionId === current.connectionId && next.provider === current.provider && Number.isSafeInteger(next.deadlineAt) && next.deadlineAt > current.deadlineAt && typeof next.env?.[SUBSCRIPTION_VARS[current.provider]] === "string";
				if (!usable) {
					state.failures += 1;
					log("credential_renew_failed", { kind: "subscription", provider: current.provider });
					continue;
				}
				state.subscriptions[i] = { ...current, ...next };
				subsRenewed += 1;
			}
			if (forgeRenewed || subsRenewed > 0) {
				state.seq += 1;
				state.dirty = true;
			}
			// A renewal the runner does not have yet (this one, or one a failed write left behind) is written now.
			if (state.dirty) {
				try {
					write(payload());
					state.dirty = false;
					state.renewals += 1;
					state.delivered = { forge: state.forge ? state.forge.expiresAt : null, subscriptions: state.subscriptions.map((s) => s.deadlineAt) };
					log("credential_renewed", { seq: state.seq, forge: forgeRenewed, subscriptions: subsRenewed });
				} catch {
					state.failures += 1;
					log("credential_renew_failed", { kind: "drop" });
				}
			}
			// The stop: a credential the runner holds is about to run out, and nothing newer reached it.
			const later = now();
			if (state.delivered.forge !== null && later >= state.delivered.forge - CREDENTIAL_STOP_BEFORE_MS) return expire("forge-token");
			if (state.delivered.subscriptions.some((deadline) => later >= deadline - CREDENTIAL_STOP_BEFORE_MS)) return expire("subscription");
		} finally {
			busy = false;
		}
	}

	return {
		state,
		check,
		start() {
			if (timer !== null) return;
			timer = timers.setInterval(() => void check(), checkMs);
			timer?.unref?.();
		},
		stop() {
			if (timer !== null) timers.clearInterval(timer);
			timer = null;
		},
	};
}
