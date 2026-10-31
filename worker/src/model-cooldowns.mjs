/** Read-only configured cooldown observations, shared by failover and console. No keyspace enumeration. */
import { createHash } from "node:crypto";
import { providerFailureOf } from "./model-failover-protocol.mjs";

export const MODEL_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;
export const MODEL_RECHECK_MS = 60_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const modelCooldownKey = (ref) => `dispatch:model-cooldown:${digest(ref)}`;

export async function readModelCooldown(redis, ref, { now = () => Date.now() } = {}) {
	const raw = await redis.get(modelCooldownKey(ref));
	if (raw === null || raw === undefined) return null;
	let row;
	try { row = JSON.parse(raw); } catch { throw new Error("invalid model cooldown"); }
	if (!providerFailureOf(row) || !Number.isSafeInteger(row.until) || row.until < 0 || row.until > 253_402_300_799_999 || row.kind === "context-overflow") throw new Error("invalid model cooldown");
	return row.until > now() ? { ref, kind: row.kind, until: row.until } : null;
}

export async function readModelCooldowns(redis, refs, options = {}) {
	const rows = await Promise.all([...new Set(refs)].map((ref) => readModelCooldown(redis, ref, options)));
	return rows.filter(Boolean);
}
