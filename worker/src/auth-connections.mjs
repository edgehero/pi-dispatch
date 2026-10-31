import { SUBSCRIPTION_CONNECTION_LIMIT } from "./subscription-limits.mjs";
/** Explicit subscription bindings. A configured connection owns its provider, including on failure. */
import { randomUUID, createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { AUTH_ID_RE, authError, createAuthStore, validateAuthCredential } from "./auth-store.mjs";
import { createDefaultAuthAdapters, COMMUNITY_AUTH_ADAPTERS } from "./community-auth-adapters.mjs";
import { MAX_USD_MICROS } from "./money.mjs";

export const AUTH_CONNECTIONS_VERSION = 1;
export const AUTH_SNAPSHOT_MARGIN_MS = 5 * 60_000 + 60_000;
const PROVIDERS = new Set(["openai", "anthropic"]);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
export const authBindingSignature = (connection) => createHash("sha256").update(JSON.stringify(connection)).digest("hex");
function authFailure(error, fallback) {
	const code = typeof error?.code === "string" && /^auth-[a-z-]+$/.test(error.code) ? error.code : null;
	return { ok: false, managed: true, reason: code ?? fallback, unavailable: code === null || error.transient === true };
}
export function parseAuthConnections(text) {
	let value;
	try { value = typeof text === "string" ? JSON.parse(text) : text; } catch { throw authError("auth-policy-invalid"); }
	if (!value || value.version !== 1 || !onlyKeys(value, ["version", "connections", "bindings"]) || !Array.isArray(value.connections) || value.connections.length > SUBSCRIPTION_CONNECTION_LIMIT || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) throw authError("auth-policy-invalid");
	const ids = new Set();
	const connections = value.connections.map((row) => {
		if (!row || !onlyKeys(row, ["id", "provider", "adapter", "ownerHost", "root", "digest", "extraUsageCreditMicros", "quotaWindows"]) || typeof row.id !== "string" || !AUTH_ID_RE.test(row.id) || ids.has(row.id) || !PROVIDERS.has(row.provider) || typeof row.ownerHost !== "string" || !AUTH_ID_RE.test(row.ownerHost)) throw authError("auth-policy-invalid");
		ids.add(row.id);
		const adapter = COMMUNITY_AUTH_ADAPTERS[row.adapter];
		if (!adapter || adapter.provider !== row.provider) throw authError("auth-adapter-unsupported");
		if (adapter.community && (typeof row.root !== "string" || !isAbsolute(row.root) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest))) throw authError("auth-adapter-unapproved");
		if (!adapter.community && (row.root !== undefined || row.digest !== undefined)) throw authError("auth-policy-invalid");
		if (row.extraUsageCreditMicros !== undefined && (!Number.isSafeInteger(row.extraUsageCreditMicros) || row.extraUsageCreditMicros <= 0 || row.extraUsageCreditMicros > MAX_USD_MICROS)) throw authError("auth-policy-invalid");
		const quotaWindows = row.quotaWindows ?? ["five-hour", "seven-day"];
		if (!Array.isArray(quotaWindows) || quotaWindows.length > 2 || new Set(quotaWindows).size !== quotaWindows.length || quotaWindows.some((item) => !["five-hour", "seven-day"].includes(item))) throw authError("auth-policy-invalid");
		return { id: row.id, provider: row.provider, adapter: row.adapter, ownerHost: row.ownerHost, quotaWindows: [...quotaWindows], ...(row.extraUsageCreditMicros === undefined ? {} : { extraUsageCreditMicros: row.extraUsageCreditMicros }), ...(adapter.community ? { root: row.root, digest: row.digest } : {}) };
	});
	const bindings = {};
	for (const [provider, id] of Object.entries(value.bindings)) {
		if (!PROVIDERS.has(provider) || !connections.some((row) => row.id === id && row.provider === provider)) throw authError("auth-policy-invalid");
		bindings[provider] = id;
	}
	return { version: 1, connections, bindings };
}

export function createAuthService({ policy = null, readPolicy = () => policy, storeDir, host, adapters = null, now = () => Date.now(), fetch = globalThis.fetch, fs, store = createAuthStore({ dir: storeDir, ...(fs ? { fs } : {}) }), marginMs = AUTH_SNAPSHOT_MARGIN_MS } = {}) {
	adapters ??= createDefaultAuthAdapters({ now, fetch });
	const read = async () => parseAuthConnections(await readPolicy());
	const bindingStillCurrent = async (row) => { const current = await read(); return current.bindings[row.provider] === row.id && authBindingSignature(current.connections.find((entry) => entry.id === row.id)) === authBindingSignature(row); };
	const connection = async (id) => { const row = (await read()).connections.find((entry) => entry.id === id); if (!row) throw authError("auth-connection-missing"); return row; };
	const initial = (row) => ({ version: 1, id: row.id, provider: row.provider, adapter: row.adapter, generation: 0, accountGroup: randomUUID(), state: "disconnected", credential: null, registration: { hostId: randomUUID() }, lastRefreshAt: null });
	function matching(row, saved) { return saved && saved.provider === row.provider && saved.adapter === row.adapter; }
	async function validate(row) {
		if (row.ownerHost !== host) throw authError("auth-owner-host");
		const adapter = adapters[row.adapter];
		if (!adapter) throw authError("auth-adapter-unavailable");
		await adapter.validate?.(row);
		return adapter;
	}
	function safe(row, saved, active, state = saved?.state ?? "disconnected", compatibility = state === "adapter-unavailable" ? "unavailable" : state === "other-host" ? "unknown" : "verified") {
		return { id: row.id, provider: row.provider, adapter: row.adapter, ownerHost: row.ownerHost, active, state, compatibility, expiresAt: saved?.credential?.expires ?? null, generation: saved?.generation ?? 0, accountGroup: saved?.accountGroup ?? null, lastRefreshAt: saved?.lastRefreshAt ?? null, extraUsage: saved?.extraUsage ?? "unknown", extraUsageCreditMicros: row.extraUsageCreditMicros ?? null, quotaWindows: [...row.quotaWindows] };
	}
	async function status() {
		const config = await read();
		return Promise.all(config.connections.map(async (row) => {
			if (row.ownerHost !== host) return safe(row, null, config.bindings[row.provider] === row.id, "other-host");
			let saved;
			try { saved = store.read(row.id); if (saved && !matching(row, saved)) return safe(row, null, config.bindings[row.provider] === row.id, "adapter-unavailable"); await validate(row); }
			catch (error) { const compatibility = error.code === "ENOENT" ? "unstaged" : error.code === "auth-adapter-version-mismatch" ? "version-mismatch" : ["auth-adapter-source-mismatch", "auth-adapter-unpinned"].includes(error.code) ? "unpinned" : "unavailable"; return safe(row, null, config.bindings[row.provider] === row.id, "adapter-unavailable", compatibility); }
			return safe(row, saved, config.bindings[row.provider] === row.id);
		}));
	}
	async function check(provider, requested = {}) {
		let config;
		try { config = await read(); } catch (error) { return authFailure(error, "auth-policy-unavailable"); }
		const id = config.bindings[provider];
		if (!id) return { ok: true, managed: false };
		const row = config.connections.find((entry) => entry.id === id);
		try {
			await validate(row);
			if (requested.api && requested.api !== (provider === "openai" ? "openai-responses" : "anthropic-messages")) throw authError("auth-capability-unsupported");
			if (requested.baseUrl && requested.baseUrl.replace(/\/$/, "") !== (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com")) throw authError("auth-endpoint-unsupported");
			const judge = async (saved) => {
				if (!matching(row, saved) || !saved.credential || saved.state !== "connected") throw authError(saved?.state === "refresh-uncertain" ? "auth-refresh-uncertain" : "auth-reauth-required");
				const publicRow = safe(row, saved, true);
				return { ok: true, managed: true, ...publicRow, connectionId: id, connection: publicRow, bindingSignature: authBindingSignature(row), extraUsageCreditMicros: row.extraUsageCreditMicros ?? null };
			};
			const saved = store.read(id);
			// Ordinary metadata reads are atomic and write nothing. Workers wait out an in-flight renewal;
			// doctor explicitly asks for readOnly and reports its observed marker without acquiring a lock.
			return await (saved?.state === "refresh-uncertain" && requested.readOnly !== true ? store.transaction(id, judge) : judge(saved));
		} catch (error) { return authFailure(error, "auth-store-unavailable"); }
	}
	async function login(id, { interaction, signal } = {}) {
		const row = await connection(id);
		const adapter = await validate(row);
		return store.transaction(id, async (saved, write) => {
			const current = matching(row, saved) ? saved : initial(row);
			const disabled = { ...current, generation: current.generation + 1, state: "disconnected", credential: null };
			await write(disabled);
			const result = await adapter.login({ interaction, signal, connection: row, previous: current });
			const credential = validateAuthCredential(result.credential ?? result, { provider: row.provider });
			if (credential.expires <= now()) throw authError("auth-credential-expired");
			const next = { ...disabled, state: "connected", credential, registration: result.registration ?? current.registration, lastRefreshAt: now() };
			await write(next);
			return safe(row, next, (await read()).bindings[row.provider] === id);
		}, { signal });
	}
	async function prepareSnapshotWithPolicy(provider, { deadlineAt, signal } = {}) {
		if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now()) return { ok: false, reason: "auth-deadline-invalid" };
		const checked = await check(provider);
		if (!checked.ok || !checked.managed) return { ...checked, ...(!checked.managed ? { snapshot: null } : {}) };
		const row = await connection(checked.connectionId);
		const adapter = await validate(row);
		return store.transaction(row.id, async (saved, write) => {
			if (!(await bindingStillCurrent(row))) return { ok: false, reason: "auth-binding-changed" };
			if (!matching(row, saved) || saved.state !== "connected" || !saved.credential) return { ok: false, reason: saved?.state === "refresh-uncertain" ? "auth-refresh-uncertain" : "auth-reauth-required" };
			const neededUntil = deadlineAt + marginMs;
			let current = saved;
			if (current.credential.expires <= neededUntil) {
				if (Number.isSafeInteger(current.credential.earliestRefreshAt) && current.credential.earliestRefreshAt > now()) return { ok: false, reason: "auth-refresh-too-early", wait: "subscription-auth", until: current.credential.earliestRefreshAt, unavailable: false };
				await write({ ...current, state: "refresh-uncertain" });
				try {
					// Once renewal begins, caller cancellation cannot discard a rotated replacement.
					const credential = validateAuthCredential(await adapter.refresh({ credential: current.credential, connection: row, previous: current, signal: AbortSignal.timeout(15_000) }), { provider: row.provider });
					current = { ...current, credential, state: "connected", generation: current.generation + 1, lastRefreshAt: now() };
					await write(current);
				} catch (error) {
					if (error.code?.startsWith("auth-") && error.uncertain !== true) await write({ ...current, state: error.transient ? "connected" : "reauth-required", ...(error.transient ? {} : { credential: null }) });
					return { ok: false, reason: error.code?.startsWith("auth-") ? error.code : "auth-refresh-uncertain", unavailable: error.transient === true };
				}
			}
			signal?.throwIfAborted();
			if (!(await bindingStillCurrent(row))) return { ok: false, reason: "auth-binding-changed" };
			if (current.credential.expires <= neededUntil || deadlineAt <= now()) return { ok: false, reason: "auth-snapshot-too-short" };
			const variable = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN";
			return { ok: true, managed: true, snapshot: { kind: "subscription", provider, connectionId: row.id, adapter: row.adapter, accountGroup: current.accountGroup, generation: current.generation, expiresAt: current.credential.expires, deadlineAt, bindingSignature: authBindingSignature(row), env: { [variable]: current.credential.access } } };
		}, { signal });
	}
	async function prepareSnapshot(provider, options = {}) {
		try { return await prepareSnapshotWithPolicy(provider, options); }
		catch (error) { if (options.signal?.aborted) throw error; return authFailure(error, "auth-state-unavailable"); }
	}
	async function validateSnapshot(snapshot) {
		const checked = await check(snapshot?.provider);
		if (!(checked.ok === true && checked.managed === true && snapshot.kind === "subscription" && checked.connectionId === snapshot.connectionId && checked.bindingSignature === snapshot.bindingSignature && checked.generation === snapshot.generation && checked.accountGroup === snapshot.accountGroup && snapshot.expiresAt > snapshot.deadlineAt + marginMs && snapshot.deadlineAt > now())) return false;
		return store.transaction(snapshot.connectionId, async (saved) => {
			const variable = snapshot.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN";
			return saved?.state === "connected" && saved.generation === snapshot.generation && saved.adapter === snapshot.adapter && saved.credential?.expires === snapshot.expiresAt && snapshot.env && Object.keys(snapshot.env).length === 1 && snapshot.env[variable] === saved.credential.access;
		});
	}
	async function logout(id, { signal } = {}) {
		const row = await connection(id);
		if (row.ownerHost !== host) throw authError("auth-owner-host");
		return store.transaction(id, async (saved, write) => {
			const current = matching(row, saved) ? saved : initial(row);
			await write({ ...current, generation: current.generation + 1, state: "disconnected", credential: null });
			let confirmed = false;
			try { const adapter = await validate(row); confirmed = current.credential ? (await adapter.revoke?.({ credential: current.credential, signal: signal ?? AbortSignal.timeout(15_000) }))?.confirmed === true : !saved?.credential; } catch {}
			return { id, state: "disconnected", remoteRevocationConfirmed: confirmed };
		}, { signal });
	}
	async function usage(id, { signal } = {}) {
		const row = await connection(id);
		const prepared = await prepareSnapshot(row.provider, { deadlineAt: now() + 1_000, signal });
		if (!prepared.ok || prepared.snapshot?.connectionId !== id) return { kind: "unavailable", reason: prepared.reason ?? "auth-connection-inactive" };
		const adapter = await validate(row);
		if (!adapter.usage) return { kind: "unavailable", reason: "auth-usage-unsupported" };
		return { kind: "observation", observedAt: now(), connectionId: id, provider: row.provider, ownerHost: row.ownerHost, accountGroup: prepared.snapshot.accountGroup, generation: prepared.snapshot.generation, payload: await adapter.usage({ access: Object.values(prepared.snapshot.env)[0], signal }) };
	}
	return { status, check, login, logout, prepareSnapshot, validateSnapshot, usage };
}
