import * as nodeFs from "node:fs";
import { join } from "node:path";

/**
 * Credentials renewed for a running job, the worker's half (issue #888, part 3, `INT-CREDENTIAL-DROP`,
 * `CONST-TOKEN-SCOPED-PER-JOB`).
 *
 * Since #888 a job runs as long as it keeps working, and two of the credentials it is handed expire on a clock of their
 * own: a GitHub App installation token lives an hour, and a subscription snapshot carries a bounded authorization
 * lease (at most 30 minutes, clipped to usable token expiry on a compatible image). Without renewal such a job had to keep the
 * 30-minute wall clock. With it, the worker renews each one before it runs out and drops the new values in a folder beside
 * the job directory, mounted read-only at `/run/pi-dispatch/credentials`, where the runner applies them
 * (image/runner/src/credential-refresh.mjs).
 *
 * WHAT STAYS BOUNDED. Each value is exactly what a fresh job would be handed: a GitHub token scoped to the job's one
 * repository that lives an hour, a subscription lease no more than 30 minutes ahead. A local lease does not revoke a
 * stolen bearer: the provider's actual expiry bounds that value. Only a running job keeps receiving replacements.
 *
 * WHEN A RENEWAL FAILS. It is tried again every minute. When the credential it renews is two minutes from running out,
 * the job is stopped (`credential-expired`, never retried): every call it makes after that would fail on a slot it keeps.
 */

/** The folder beside the job directory that holds the drop, and the drop's file in it. */
export const CREDENTIALS_DIR_SUFFIX = ".credentials";
export const CREDENTIALS_FILE = "current.json";
/** How often the refresher looks at what is due. */
export const CREDENTIAL_CHECK_MS = 60_000;
/** Includes lock acquisition and provider work, not just the HTTP request. */
export const CREDENTIAL_RENEW_TIMEOUT_MS = 60_000;
/** A GitHub App token is renewed this long before it expires. */
export const FORGE_RENEW_BEFORE_MS = 15 * 60_000;
/** A subscription snapshot is renewed this long before its deadline, and extended to this far ahead. */
export const SUBSCRIPTION_RENEW_BEFORE_MS = 10 * 60_000;
export const SUBSCRIPTION_DEADLINE_AHEAD_MS = 30 * 60_000;
/** A credential this close to running out, with no renewal, stops the job. */
export const CREDENTIAL_STOP_BEFORE_MS = 2 * 60_000;
/** The subscription token's variable by provider (auth-connections.mjs `prepareSnapshot`'s `env`). */
const SUBSCRIPTION_VARS = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_OAUTH_TOKEN" });

// Held to the runner's parseCredentialDrop and subscription guard by credential-refresh.test.mjs.
// A successful rename is not delivery if the runner must refuse the bytes it contains.
export const credentialDropTokenAllowed = (token) => typeof token === "string" && /^[\x21-\x7e]{8,4096}$/.test(token);
const subscriptionShaped = (row) => Object.hasOwn(SUBSCRIPTION_VARS, row?.provider)
	&& typeof row.connectionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.connectionId)
	&& [row.generation, row.expiresAt, row.deadlineAt].every((value) => Number.isSafeInteger(value) && value >= 0)
	&& row.expiresAt > row.deadlineAt && credentialDropTokenAllowed(row.token)
	&& (row.provider === "openai" ? !row.token.startsWith("sk-") : row.token.startsWith("sk-ant-oat"));
const subscriptionRow = (snapshot) => ({ provider: snapshot.provider, connectionId: snapshot.connectionId, generation: snapshot.generation, expiresAt: snapshot.expiresAt, deadlineAt: snapshot.deadlineAt, token: snapshot.env?.[SUBSCRIPTION_VARS[snapshot.provider]] });

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
 *     snapshot for the same connection, { wait: true, until } for expected eligibility waiting, or null.
 *   - `check()` renews what is due, publishes each independent renewal, and asks for a stop (`onExpired()`, once)
 *     when a credential that could not be renewed is CREDENTIAL_STOP_BEFORE_MS from running out.
 * Logs `credential_renewed { forge, subscriptions, seq }` and `credential_renew_failed { kind }`, never a value.
 */
export function makeCredentialRefresher({ dir, forge = null, subscriptions = [], extend = async () => null, current = null, watch = null, now = () => Date.now(), timers = { setInterval, clearInterval }, onExpired = () => {}, onCredentials = () => {}, log = () => {}, renewalTimeout = () => AbortSignal.timeout(CREDENTIAL_RENEW_TIMEOUT_MS), write = (payload) => writeCredentialDrop(dir, payload), checkMs = CREDENTIAL_CHECK_MS }) {
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
	let stopped = false;
	const pending = new Set();
	const controllers = new Set();
	const nextChecks = subscriptions.map(() => 0);
	const syncWanted = new Set();
	const unwatch = [];
	const say = (event, fields) => { try { log(event, fields); } catch {} };

	const payload = () => ({
		v: 1,
		seq: state.seq,
		forge: state.forge?.token ? { token: state.forge.token } : null,
		subscriptions: state.subscriptions.map(subscriptionRow),
	});

	const expire = (kind) => {
		if (state.expired) return;
		state.expired = true;
		say("credential_expired", { kind });
		try {
			onExpired(kind);
		} catch {}
	};

	// This watchdog never awaits a mint or a store lock. Even a hung adapter cannot
	// keep a slot alive after the last credential published to the runner runs out.
	function checkExpiry() {
		if (stopped || state.expired) return;
		const at = now();
		if (state.delivered.forge !== null && at >= state.delivered.forge - CREDENTIAL_STOP_BEFORE_MS) return expire("forge-token");
		if (state.delivered.subscriptions.some((deadline) => at >= deadline - CREDENTIAL_STOP_BEFORE_MS)) expire("subscription");
	}
	function failed(kind, provider) {
		state.failures += 1;
		say("credential_renew_failed", { kind, ...(provider ? { provider } : {}) });
	}
	function publish() {
		if (!state.dirty || stopped || state.expired) return;
		try {
			const drop = payload();
			if (!Number.isSafeInteger(drop.seq) || drop.seq < 1 || (drop.forge !== null && !credentialDropTokenAllowed(drop.forge.token)) || drop.subscriptions.length > 2 || !drop.subscriptions.every(subscriptionShaped)) throw new Error("unusable credential drop");
			// Register new literal secrets before a tool can print one. A failed collector
			// prevents publication, just like a failed disk write.
			onCredentials(drop);
			write(drop);
			state.dirty = false;
			state.renewals += 1;
			state.delivered = { forge: state.forge ? state.forge.expiresAt : null, subscriptions: state.subscriptions.map((s) => s.deadlineAt) };
			say("credential_renewed", { seq: state.seq, forge: Boolean(drop.forge), subscriptions: drop.subscriptions.length });
		} catch { failed("drop"); }
	}
	async function renew(key, call, accept, kind, provider) {
		if (pending.has(key)) return;
		pending.add(key);
		const controller = new AbortController();
		controllers.add(controller);
		const signal = AbortSignal.any([controller.signal, renewalTimeout()]);
		let abort;
		// A timed-out rotation may still need to persist its replacement. Keep this
		// lane occupied until it settles, but neither wait on it nor accept its late result.
		const work = Promise.resolve().then(() => call(signal));
		try {
			const cancelled = new Promise((_, reject) => {
				abort = () => reject(new Error("credential renewal ended"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
			const result = await Promise.race([work, cancelled]);
			if (stopped || state.expired || signal.aborted) return;
			if (accept(result)) {
				state.seq += 1;
				state.dirty = true;
				publish();
			}
		} catch { if (!stopped && !state.expired) failed(kind, provider); }
		finally {
			signal.removeEventListener("abort", abort);
			// A timed-out rotation keeps the lane until its durable write settles. A watch arriving
			// during it is replayed afterwards, never raced against an older extension result.
			void work.catch(() => {}).finally(() => {
				pending.delete(key); controllers.delete(controller);
				for (const i of syncWanted) if (key === `subscription:${i}`) { syncWanted.delete(i); void synchronize(i); }
			});
		}
	}
	async function synchronize(i) {
		if (!current || stopped || state.expired) return;
		const key = `subscription:${i}`;
		if (pending.has(key)) { syncWanted.add(i); return; }
		const before = state.subscriptions[i];
		await renew(key, (signal) => current(before, { signal }), (next) => {
			if (!next) return false;
			const present = state.subscriptions[i];
			if (!subscriptionShaped(subscriptionRow(next)) || next.connectionId !== present.connectionId || next.provider !== present.provider || next.generation <= present.generation || next.deadlineAt !== present.deadlineAt || next.deadlineAt <= now() + CREDENTIAL_STOP_BEFORE_MS) return false;
			state.subscriptions[i] = { ...present, ...next };
			return true;
		}, "subscription", before.provider);
	}
	async function check() {
		checkExpiry();
		if (stopped || state.expired) return;
		publish();
		const at = now();
		const work = [];
		if (state.forge && at >= state.forge.expiresAt - FORGE_RENEW_BEFORE_MS) {
			work.push(renew("forge", (signal) => forge.mint({ signal }), (minted) => {
				if (!credentialDropTokenAllowed(minted?.token) || !Number.isSafeInteger(minted.expiresAt) || minted.expiresAt <= now() + CREDENTIAL_STOP_BEFORE_MS) throw new Error("no usable token");
				state.forge = { expiresAt: minted.expiresAt, token: minted.token };
				return true;
			}, "forge-token"));
		}
		for (let i = 0; i < state.subscriptions.length; i++) {
			const current = state.subscriptions[i];
			if (at < current.deadlineAt - SUBSCRIPTION_RENEW_BEFORE_MS || at < nextChecks[i]) {
				// The watch is prompt; periodic reads cover missed events without holding up
				// another provider or the forge's independent renewal lane.
				work.push(synchronize(i));
				continue;
			}
			work.push(renew(`subscription:${i}`, (signal) => extend(current, { deadlineAt: now() + SUBSCRIPTION_DEADLINE_AHEAD_MS, signal }), (next) => {
				if (next?.wait === true && Number.isSafeInteger(next.until) && next.until > now()) { nextChecks[i] = next.until; return false; }
				const usable = next && subscriptionShaped(subscriptionRow(next)) && next.connectionId === current.connectionId && next.provider === current.provider && next.generation >= current.generation && next.deadlineAt > current.deadlineAt && next.deadlineAt > now() + CREDENTIAL_STOP_BEFORE_MS;
				if (!usable) throw new Error("no usable lease");
				state.subscriptions[i] = { ...current, ...next };
				return true;
			}, "subscription", current.provider));
		}
		await Promise.all(work);
		checkExpiry();
	}

	return {
		state,
		check,
		checkExpiry,
		start() {
			if (timer !== null || stopped) return;
			for (let i = 0; i < state.subscriptions.length; i++) {
				try {
					const stop = watch?.(state.subscriptions[i], (event) => {
						if (event?.watchFailed === true) say("credential_watch_unavailable", { kind: "subscription" });
						void synchronize(i);
					});
					if (typeof stop === "function") unwatch.push(stop);
					else if (current) say("credential_watch_unavailable", { kind: "subscription" });
				} catch { say("credential_watch_unavailable", { kind: "subscription" }); }
				// Subscribe before reading: a rotation between admission and start cannot be lost.
				void synchronize(i);
			}
			timer = timers.setInterval(() => void check(), checkMs);
			timer?.unref?.();
		},
		stop() {
			stopped = true;
			for (const stop of unwatch.splice(0)) { try { stop(); } catch {} }
			syncWanted.clear();
			for (const controller of controllers) controller.abort();
			if (timer !== null) timers.clearInterval(timer);
			timer = null;
		},
	};
}
