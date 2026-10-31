import { SUBSCRIPTION_CONNECTION_LIMIT, SUBSCRIPTION_QUOTA_BYTES } from "./subscription-limits.mjs";

// One maximum quota record per connection plus its bounded safe projection fields.
export const SUBSCRIPTION_STATUS_BYTES = SUBSCRIPTION_CONNECTION_LIMIT * (SUBSCRIPTION_QUOTA_BYTES + 16_384);
export const subscriptionStatusKey = (host) => `dispatch:subscription-status:${host}`;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A bounded, ephemeral projection. Credential data and binding digests never enter this keyspace. */
export async function publishSubscriptionStatus(redis, host, runtime) {
	if (!SAFE_HOST.test(host)) throw new Error("invalid subscription owner host");
	const status = await runtime.status();
	const connections = status.connections.map(({ accountGroup, generation, quota, ...row }) => ({ ...row, ...(quota ? { quota: Object.fromEntries(Object.entries(quota).filter(([key]) => !["accountDigest", "generation", "bucket"].includes(key))) } : {}) }));
	const payload = JSON.stringify({ ...status, connections });
	if (connections.length > SUBSCRIPTION_CONNECTION_LIMIT || Buffer.byteLength(payload) > SUBSCRIPTION_STATUS_BYTES) throw new Error("subscription status exceeds its bounds");
	await redis.set(subscriptionStatusKey(host), payload, "PX", 90_000);
}
export async function readSubscriptionStatus(redis, hosts, { timeoutMs = 2500 } = {}) {
	const requested = [...new Set(hosts)].filter((host) => SAFE_HOST.test(host));
	const names = requested.slice(0, 64);
	let timer;
	let results;
	try { results = await Promise.race([Promise.all(names.map((name) => redis.get(subscriptionStatusKey(name)))), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("subscription status unavailable")), timeoutMs); timer.unref?.(); })]); }
	finally { clearTimeout(timer); }
	let partial = requested.length > names.length || names.length === 0 || results.some((raw) => raw === null);
	const connections = new Map();
	for (const [index, raw] of results.entries()) {
		if (raw === null) continue;
		try {
			if (Buffer.byteLength(raw) > SUBSCRIPTION_STATUS_BYTES) throw new Error("oversized status");
			const value = JSON.parse(raw);
			if (value.state !== "ready" || !Array.isArray(value.connections) || value.connections.length > SUBSCRIPTION_CONNECTION_LIMIT) throw new Error("invalid status");
			if (value.partial !== false) partial = true;
			for (const row of value.connections) {
				if (!row || !SAFE_HOST.test(row.ownerHost) || !SAFE_HOST.test(row.id)) { partial = true; continue; }
				const key = `${row.ownerHost}:${row.id}`;
				const owner = row.ownerHost === names[index];
				if (owner || !connections.has(key)) connections.set(key, { owner, row: owner ? row : { ...row, state: "other-host" } });
			}
		} catch { partial = true; }
	}
	if ([...connections.values()].some((value) => !value.owner)) partial = true;
	return { state: partial ? "partial" : "ready", partial, connections: [...connections.values()].map((value) => value.row) };
}
