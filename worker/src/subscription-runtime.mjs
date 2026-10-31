import { REASONS } from "./reason-catalog.mjs";
/** Host-only orchestration. Private snapshots never become job data, run records or telemetry. */
import { builtinModel } from "./model-catalog.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { normalizeClaudeQuota, normalizeOpenAIQuota, normalizeSubscriptionQuotaError } from "./subscription-quota.mjs";
import { LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH } from "./private-store-boundary.mjs";

// Lifecycle errors remain precise on the host terminal; run records use the closed operator catalog.
function recordRefusal(value) {
	if (!value?.reason?.startsWith("auth-") || Object.hasOwn(REASONS, value.reason)) return value;
	const reason = value.reason.startsWith("auth-adapter-") ? "auth-adapter-unavailable" : value.reason.startsWith("auth-store-") ? "auth-store-unavailable" : value.reason.startsWith("auth-policy-") ? "auth-policy-invalid" : "auth-reauth-required";
	return { ...value, reason };
}

export const subscriptionIdentity = (row) => ({ connectionId: row.connectionId ?? row.id, owner: row.ownerHost, accountDigest: row.accountGroup, bucket: `${row.provider}:subscription`, generation: row.generation });
export function subscriptionRoutes(job) {
	const refs = new Map();
	const add = (provider, id) => { if (provider && id) refs.set(`${provider}/${id}`, { provider, id }); };
	add(job.provider, job.model);
	for (const entry of job.models ?? []) { const ref = splitModelEntry(entry); if (ref) add(ref.provider, ref.model); }
	for (const role of [job.watchDecisionModel, job.questionGroupModel, job.answerDecisionModel]) add(role?.provider, role?.id);
	return [...refs.values()];
}

export function makeSubscriptionRuntime({ auth, quota, now = Date.now, lookup = builtinModel, packageRootFor = () => null, defaultBackend = "local", isPrivateStoreExposed = () => false } = {}) {
	async function check(job, { attemptId = null, consumeTrial = false } = {}) {
		try {
			if (await isPrivateStoreExposed(job)) return { ok: false, managed: true, reason: LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH };
		} catch (error) {
			return { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: error?.transient !== false };
		}
		const managed = [];
		let unmanaged = false;
		for (const ref of subscriptionRoutes(job)) {
			const model = lookup(ref.provider, ref.id);
			const row = await auth.check(ref.provider, { model: ref.id, api: model?.api, baseUrl: model?.baseUrl });
			if (!row.managed) { unmanaged = true; continue; }
			if (!row.ok) return row.reason === "auth-owner-host" ? { ok: false, managed: true, wait: "subscription-owner", until: now() + 60_000 } : recordRefusal(row);
			if (!model?.api || !model?.baseUrl) return { ok: false, managed: true, reason: "auth-model-unverified" };
			// A finite list fences tools, child sessions and compaction as well as the root call. An unrestricted
			// subscription job could otherwise switch to an unadmitted provider after this free gate.
			if (!Array.isArray(job.models) || job.models.length === 0) return { ok: false, managed: true, reason: "auth-route-unbounded" };
			if (ref.provider === "openai" && (job.watchDecisionModel?.provider === "openai" || job.questionGroupModel?.provider === "openai" || job.answerDecisionModel?.provider === "openai")) return { ok: false, managed: true, reason: "auth-capability-unsupported" };
			if (["openshell", "openshell-bind"].includes(job.backend ?? defaultBackend) || job.canary === true) return { ok: false, managed: true, reason: "auth-venue-unsupported" };
			if (ref.provider === "anthropic") {
				if (job.packages === false) return { ok: false, managed: true, reason: "auth-adapter-disabled" };
				const staged = packageRootFor(row.adapter);
				if (!staged) return { ok: false, managed: true, reason: "auth-adapter-unavailable" };
				if (staged.refused) return { ok: false, managed: true, reason: staged.refused };
			}
			const paid = Number.isSafeInteger(row.extraUsageCreditMicros) && row.extraUsageCreditMicros > 0;
			if (paid && (!Number.isSafeInteger(job.maxCostMicros) || job.maxCostMicros > row.extraUsageCreditMicros)) return { ok: false, managed: true, reason: "auth-credit-cap-required" };
			const available = await quota.admit(subscriptionIdentity(row), { attemptId, consumeTrial, windows: row.quotaWindows ?? ["five-hour", "seven-day"], allowExtraUsage: paid, maxCreditMicros: row.extraUsageCreditMicros, requireExtraUsageKnownDisabled: ref.provider === "anthropic" });
			const needsUsage = ref.provider === "anthropic" && (available.requiresUsage === true || available.status?.fresh === false && available.status?.state !== "exhausted");
			if (!available.ok && !(consumeTrial === false && needsUsage && available.reason === "subscription-extra-usage" && available.status?.extraUsage?.enabled === null)) return available.reason === "subscription-quota" ? { ...available, managed: true, wait: "subscription-quota", until: available.until ?? now() + 60_000 } : { ...available, managed: true };
			if (!managed.some((entry) => entry.provider === row.provider)) managed.push({ ...row, needsUsage });
		}
		if (managed.length && unmanaged) return { ok: false, managed: true, reason: "auth-mixed-billing" };
		return { ok: true, managed };
	}
	async function prepare(job, { deadlineAt, signal, attemptId } = {}) {
		const preview = await check(job);
		if (!preview.ok) return preview;
		for (const row of preview.managed) if (row.needsUsage) {
			const result = await usage(row.id, { signal });
			if (result.kind !== "observation") return { ok: false, managed: true, reason: "auth-usage-unavailable", unavailable: true };
		}
		const checked = await check(job, { attemptId, consumeTrial: true });
		if (!checked.ok) return checked;
		const snapshots = [];
		for (const row of checked.managed) {
			const prepared = await auth.prepareSnapshot(row.provider, { deadlineAt, signal });
			if (!prepared.ok) return recordRefusal(prepared);
			if (!prepared.snapshot) return { ok: false, managed: true, reason: "auth-binding-changed" };
			snapshots.push({ ...prepared.snapshot, ownerHost: row.ownerHost, ...packageRootFor(row.adapter) });
		}
		return { ok: true, snapshots };
	}
	async function validate(snapshots) {
		for (const snapshot of snapshots) {
			if (!(await auth.validateSnapshot(snapshot))) return false;
			if (snapshot.provider === "anthropic") {
				const staged = packageRootFor(snapshot.adapter);
				if (!staged || staged.refused || staged.root !== snapshot.root || staged.digest !== snapshot.digest) return false;
			}
		}
		return true;
	}
	async function observe(job, result, snapshots) {
		if (result?.exitAuth !== "verified" || result?.exitLineCode !== result?.code || result?.aborted === true) return;
		const snapshot = snapshots.find((row) => row.provider === result.providerFailure?.subscriptionProvider);
		if (snapshot?.provider === "anthropic" && ["quota-exhausted", "rate-limited"].includes(result.providerFailure?.kind)) {
			await quota.invalidate(subscriptionIdentity(snapshot), { observedAt: now() });
			const refreshed = await usage(snapshot.connectionId, { signal: AbortSignal.timeout(15_000) });
			if (refreshed.kind !== "observation") throw new Error("subscription usage unavailable after throttling");
			return;
		}
		if (!snapshot || result.providerFailure?.kind !== "quota-exhausted" || !result.providerFailure.subscriptionCode) return;
		const observation = normalizeSubscriptionQuotaError({ provider: snapshot.provider, code: result.providerFailure.subscriptionCode, status: 429, resetAt: result.providerFailure.resetAt }, { observedAt: now() });
		if (observation) await quota.record(subscriptionIdentity(snapshot), observation);
	}
	async function usage(id, options) {
		const before = (await auth.status()).find((entry) => entry.id === id && entry.active);
		if (!before?.accountGroup) return { kind: "unavailable", reason: "auth-binding-changed" };
		const version = (await quota.read(subscriptionIdentity(before))).version;
		const result = await auth.usage(id, options);
		if (result.kind !== "observation") return result;
		const row = (await auth.status()).find((entry) => entry.id === id && entry.active);
		if (!row || row.provider !== result.provider || row.ownerHost !== result.ownerHost || row.accountGroup !== result.accountGroup || row.generation !== result.generation) return { kind: "unavailable", reason: "auth-binding-changed" };
		const observation = (row.provider === "anthropic" ? normalizeClaudeQuota : normalizeOpenAIQuota)(result.payload, { observedAt: result.observedAt });
		const written = await quota.record(subscriptionIdentity(row), observation, { expectedVersion: version });
		return { kind: written.ok ? "observation" : "unavailable", reason: written.reason ?? null, quota: written.status };
	}
	async function status() {
		const rows = await auth.status();
		return { state: "ready", partial: false, connections: await Promise.all(rows.map(async (row) => ({ ...row, ...(row.accountGroup ? { quota: await quota.read(subscriptionIdentity(row)) } : {}) }))) };
	}
	return { check, prepare, validate, observe, usage, status };
}
