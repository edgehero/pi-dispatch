import { REASONS } from "./reason-catalog.mjs";
import { createHash } from "node:crypto";
/** Host-only orchestration. Private snapshots never become job data, run records or telemetry. */
import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";
import { builtinModel } from "./model-catalog.mjs";
import { splitModelEntry, auxiliaryModelsProblem } from "./model-ref.mjs";
import { normalizeClaudeQuota, normalizeOpenAIQuota, normalizeSubscriptionQuotaError } from "./subscription-quota.mjs";
import { LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH } from "./private-store-boundary.mjs";

// Lifecycle errors remain precise on the host terminal; run records use the closed operator catalog.
function recordRefusal(value) {
	if (!value?.reason?.startsWith("auth-") || Object.hasOwn(REASONS, value.reason)) return value;
	const reason = value.reason.startsWith("auth-adapter-") ? "auth-adapter-unavailable" : value.reason.startsWith("auth-store-") ? "auth-store-unavailable" : value.reason.startsWith("auth-policy-") ? "auth-policy-invalid" : "auth-reauth-required";
	return { ...value, reason };
}

export const subscriptionIdentity = (row) => ({ connectionId: row.connectionId ?? row.id, owner: row.ownerHost, accountDigest: row.accountGroup, bucket: `${row.provider}:subscription`, generation: row.generation });
/** Credential refresh may change generation; another account, connection or authored binding is a different route. */
export function subscriptionBindingDigest(row) {
	const parts = [row.connectionId ?? row.id, row.provider, row.ownerHost, row.accountGroup, row.adapter, row.bindingSignature ?? null];
	if (parts.slice(0, 5).some((part) => typeof part !== "string" || !part)) return null;
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function subscriptionRoutes(job) {
	const refs = new Map();
	const add = (provider, id) => { if (provider && id) refs.set(`${provider}/${id}`, { provider, id }); };
	add(job.provider, job.model);
	for (const entry of [...(job.models ?? []), ...(job.auxiliaryModels ?? [])]) { const ref = splitModelEntry(entry); if (ref) add(ref.provider, ref.model); }
	for (const role of [job.watchDecisionModel, job.questionGroupModel, job.answerDecisionModel]) add(role?.provider, role?.id);
	return [...refs.values()];
}

// Auxiliary authority never changes a root candidate's billing class, even when an operator also lists
// that candidate as an auxiliary model. The latter is useful for panels that include the chosen root.
function auxiliaryRoute(job, ref) {
	const key = `${ref.provider}/${ref.id}`;
	const roots = [`${job.provider}/${job.model}`, ...(job.fallbackModels ?? []), ...(job.modelSelection?.candidates ?? [])];
	for (const role of [job.watchDecisionModel, job.questionGroupModel, job.answerDecisionModel]) if (role) roots.push(`${role.provider}/${role.id}`);
	return Array.isArray(job.auxiliaryModels) && job.auxiliaryModels.includes(key) && !roots.includes(key);
}

export function makeSubscriptionRuntime({ auth, quota, now = Date.now, lookup = builtinModel, packageRootFor = () => null, defaultBackend = "local", isPrivateStoreExposed = () => false } = {}) {
	/** Whole-pool billing classification cannot return early on a quota wait and hide a paid alternative. */
	async function inspectPolicy(job) {
		if (job.auxiliaryModels !== undefined && (auxiliaryModelsProblem(job.auxiliaryModels, job.models) !== null || !Number.isSafeInteger(job.maxCostMicros) || job.maxCostMicros <= 0)) return { ok: false, managed: true, reason: "auth-route-unbounded" };
		try {
			if (await isPrivateStoreExposed(job)) return { ok: false, managed: true, reason: LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH };
		} catch (error) {
			return { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: error?.transient !== false };
		}
		let managed = false;
		let unmanaged = false;
		const bindings = {};
		for (const ref of subscriptionRoutes(job)) {
			const model = lookup(ref.provider, ref.id);
			const row = await auth.check(ref.provider, { model: ref.id, api: model?.api, baseUrl: model?.baseUrl, readOnly: true });
			if (row.unavailable) return recordRefusal(row);
			if (!auxiliaryRoute(job, ref)) { if (row.managed) managed = true; else unmanaged = true; }
			if (row.ok) bindings[`${ref.provider}/${ref.id}`] = row.managed ? subscriptionBindingDigest(row) : null;
		}
		return managed && unmanaged ? { ok: false, managed: true, reason: "auth-mixed-billing" } : { ok: true, managed, bindings };
	}
	async function check(job, { attemptId = null, consumeTrial = false } = {}) {
		if (job.auxiliaryModels !== undefined && (auxiliaryModelsProblem(job.auxiliaryModels, job.models) !== null || !Number.isSafeInteger(job.maxCostMicros) || job.maxCostMicros <= 0)) return { ok: false, managed: true, reason: "auth-route-unbounded" };
		try {
			if (await isPrivateStoreExposed(job)) return { ok: false, managed: true, reason: LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH };
		} catch (error) {
			return { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: error?.transient !== false };
		}
		const managed = [];
		let unmanaged = false;
		let rootManaged = false;
		const withRoot = (result) => job.auxiliaryModels === undefined ? result : { ...result, rootManaged };
		for (const ref of subscriptionRoutes(job)) {
			const model = lookup(ref.provider, ref.id);
			const row = await auth.check(ref.provider, { model: ref.id, api: model?.api, baseUrl: model?.baseUrl });
			const primary = ref.provider === job.provider && ref.id === job.model;
			if (primary) rootManaged = row.managed === true;
			if ((primary || job.auxiliaryModels === undefined) && (job.modelSelectionBilling === "subscription" && !row.managed || job.modelSelectionBilling === "api" && row.managed || job.modelSelectionBinding && row.ok && subscriptionBindingDigest(row) !== job.modelSelectionBinding)) return withRoot({ ok: false, managed: true, reason: "auth-binding-changed" });
			if (!row.managed) { if (!auxiliaryRoute(job, ref)) unmanaged = true; continue; }
			if (!row.ok) return withRoot(row.reason === "auth-owner-host" ? { ok: false, managed: true, wait: "subscription-owner", until: now() + 60_000 } : recordRefusal(row));
			if (!model?.api || !model?.baseUrl) return withRoot({ ok: false, managed: true, reason: "auth-model-unverified" });
			// A finite list fences tools, child sessions and compaction as well as the root call. An unrestricted
			// subscription job could otherwise switch to an unadmitted provider after this free gate.
			if (!Array.isArray(job.models) || job.models.length === 0) return withRoot({ ok: false, managed: true, reason: "auth-route-unbounded" });
			if (ref.provider === "openai" && (job.watchDecisionModel?.provider === "openai" || job.questionGroupModel?.provider === "openai" || job.answerDecisionModel?.provider === "openai")) return withRoot({ ok: false, managed: true, reason: "auth-capability-unsupported" });
			if (["openshell", "openshell-bind"].includes(job.backend ?? defaultBackend) || job.canary === true) return withRoot({ ok: false, managed: true, reason: "auth-venue-unsupported" });
			if (ref.provider === "anthropic") {
				// Excluded by name too (issue #800): the adapter is a staged package, and left out of PI_PACKAGES it would stop the job at its load, inside a started
				// container with its budget held. `row.adapter` is the policy's key, `pi-anthropic-oauth@0.3.6`, which the loader refuses as an extension's name; a trigger
				// names the package, as the worker omits it (run-container.mjs) and `isSubscriptionAdapter` reads it, so the key's `package` is what compares.
				if (job.packages === false || (Array.isArray(job.excludeExtensions) && job.excludeExtensions.includes(COMMUNITY_AUTH_ADAPTERS[row.adapter]?.package))) return withRoot({ ok: false, managed: true, reason: "auth-adapter-disabled" });
				const staged = packageRootFor(row.adapter);
				if (!staged) return withRoot({ ok: false, managed: true, reason: "auth-adapter-unavailable" });
				if (staged.refused) return withRoot({ ok: false, managed: true, reason: staged.refused });
			}
			const paid = Number.isSafeInteger(row.extraUsageCreditMicros) && row.extraUsageCreditMicros > 0;
			if (paid && (!Number.isSafeInteger(job.maxCostMicros) || job.maxCostMicros > row.extraUsageCreditMicros)) return withRoot({ ok: false, managed: true, reason: "auth-credit-cap-required" });
			const available = await quota.admit(subscriptionIdentity(row), { modelRef: `${ref.provider}/${ref.id}`, attemptId, consumeTrial, windows: row.quotaWindows ?? ["five-hour", "seven-day"], allowExtraUsage: paid, maxCreditMicros: row.extraUsageCreditMicros, requireExtraUsageKnownDisabled: ref.provider === "anthropic" });
			const needsUsage = ref.provider === "anthropic" && (available.requiresUsage === true || available.status?.fresh === false && available.status?.state !== "exhausted");
			if (!available.ok && !(consumeTrial === false && needsUsage && available.reason === "subscription-extra-usage" && available.status?.extraUsage?.enabled === null)) return withRoot(available.reason === "subscription-quota" ? { ...available, managed: true, ...(job.auxiliaryModels === undefined ? {} : { auxiliary: !primary }), wait: "subscription-quota", until: available.until ?? now() + 60_000 } : { ...available, managed: true });
			if (!managed.some((entry) => entry.provider === row.provider)) managed.push({ ...row, needsUsage });
		}
		const rootSubscriptions = managed.filter(row => subscriptionRoutes(job).some(ref => ref.provider === row.provider && !auxiliaryRoute(job, ref)));
		if (rootSubscriptions.length && unmanaged) return withRoot({ ok: false, managed: true, reason: "auth-mixed-billing" });
		const rootConnection = job.auxiliaryModels === undefined ? (managed.length === 1 ? managed[0] : null) : managed.find(row => row.provider === job.provider);
		return withRoot({ ok: true, managed, ...(job.modelSelection ? { binding: rootConnection ? subscriptionBindingDigest(rootConnection) : null } : {}) });
	}
	async function prepare(job, { deadlineAt, signal, attemptId, renewable = false } = {}) {
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
			const prepared = await auth.prepareSnapshot(row.provider, { deadlineAt, signal, renewable });
			if (!prepared.ok) return recordRefusal(prepared);
			if (!prepared.snapshot) return { ok: false, managed: true, reason: "auth-binding-changed" };
			// A provider rebound between quota admission and snapshot preparation needs fresh admission. Ordinary
			// access-token refresh may change generation, which the stable binding digest deliberately excludes.
			if (job.auxiliaryModels !== undefined && (!subscriptionBindingDigest(row) || subscriptionBindingDigest({ ...prepared.snapshot, ownerHost: row.ownerHost }) !== subscriptionBindingDigest(row))) return { ok: false, managed: true, reason: "auth-binding-changed" };
			if (job.modelSelectionBinding && (row.provider === job.provider || job.auxiliaryModels === undefined) && subscriptionBindingDigest({ ...prepared.snapshot, ownerHost: row.ownerHost }) !== job.modelSelectionBinding) return { ok: false, managed: true, reason: "auth-binding-changed" };
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
		if (result?.exitAuth !== "verified" || result?.code !== 1 || result?.exitLineCode !== result?.code || result?.aborted === true) return;
		const snapshot = snapshots.find((row) => row.provider === result.providerFailure?.subscriptionProvider);
		if (!snapshot) return;
		const route = job.auxiliaryModels === undefined ? { provider: snapshot.provider, id: job.model } : subscriptionRoutes(job).find((ref) => ref.provider === snapshot.provider);
		if (!route) return;
		const model = lookup(route.provider, route.id);
		const bound = await auth.check(snapshot.provider, { model: route.id, api: model?.api, baseUrl: model?.baseUrl });
		if (!bound.ok || !bound.managed || !sameBinding(bound, snapshot)) return;
		if (snapshot?.provider === "anthropic" && ["quota-exhausted", "rate-limited"].includes(result.providerFailure?.kind)) {
			await quota.invalidate(subscriptionIdentity(snapshot), { observedAt: now() });
			const refreshed = await usage(snapshot.connectionId, { signal: AbortSignal.timeout(15_000), expectedBinding: snapshot });
			if (refreshed.kind !== "observation") throw new Error("subscription usage unavailable after throttling");
			return refreshed.quota?.state === "exhausted" && refreshed.quota?.bindingValid !== false && (job.auxiliaryModels === undefined || snapshot.provider === job.provider) ? { quotaExhausted: true } : undefined;
		}
		if (!snapshot || result.providerFailure?.kind !== "quota-exhausted" || !result.providerFailure.subscriptionCode) return;
		const observation = normalizeSubscriptionQuotaError({ provider: snapshot.provider, code: result.providerFailure.subscriptionCode, status: 429, resetAt: result.providerFailure.resetAt }, { observedAt: now() });
		if (observation) {
			const written = await quota.record(subscriptionIdentity(snapshot), observation);
			if (written.ok && written.status?.state === "exhausted" && written.status?.bindingValid !== false && (job.auxiliaryModels === undefined || snapshot.provider === job.provider)) return { quotaExhausted: true };
		}
	}
	function sameBinding(row, snapshot) {
		return (row.connectionId ?? row.id) === snapshot.connectionId && row.provider === snapshot.provider && row.ownerHost === snapshot.ownerHost && row.accountGroup === snapshot.accountGroup && row.generation === snapshot.generation && row.adapter === snapshot.adapter && (row.bindingSignature === undefined || row.bindingSignature === snapshot.bindingSignature);
	}
	async function usage(id, { expectedBinding = null, ...options } = {}) {
		const before = (await auth.status()).find((entry) => entry.id === id && entry.active);
		if (!before?.accountGroup || expectedBinding && !sameBinding(before, expectedBinding)) return { kind: "unavailable", reason: "auth-binding-changed" };
		const version = (await quota.read(subscriptionIdentity(before))).version;
		const result = await auth.usage(id, options);
		if (result.kind !== "observation") return result;
		const row = (await auth.status()).find((entry) => entry.id === id && entry.active);
		if (!row || row.provider !== result.provider || row.ownerHost !== result.ownerHost || row.accountGroup !== result.accountGroup || row.generation !== result.generation || expectedBinding && !sameBinding(row, expectedBinding)) return { kind: "unavailable", reason: "auth-binding-changed" };
		const observation = (row.provider === "anthropic" ? normalizeClaudeQuota : normalizeOpenAIQuota)(result.payload, { observedAt: result.observedAt });
		const written = await quota.record(subscriptionIdentity(row), observation, { expectedVersion: version });
		return { kind: written.ok ? "observation" : "unavailable", reason: written.reason ?? null, quota: written.status };
	}
	async function status() {
		const rows = await auth.status();
		return { state: "ready", partial: false, connections: await Promise.all(rows.map(async (row) => ({ ...row, ...(row.accountGroup ? { quota: await quota.read(subscriptionIdentity(row)) } : {}) }))) };
	}
	/**
	 * Issue #888, part 3: a running job's snapshot renewed, its deadline moved to `deadlineAt` (the credential refreshed
	 * first when eligible, or a renewable lease clipped to expiry), an eligibility wait, or null. ONLY the same connection under the same
	 * binding as the snapshot the job started with: a binding changed since (another account, another adapter) is never
	 * handed to a job that started under the old one. No quota admission and no trial: the job was admitted at its pickup.
	 */
	async function extend(snapshot, { deadlineAt, signal } = {}) {
		if (!snapshot || typeof snapshot.provider !== "string") return null;
		const prepared = await auth.prepareSnapshot(snapshot.provider, { deadlineAt, signal, renewable: snapshot.renewable === true, extending: true });
		if (!prepared?.ok || !prepared.snapshot) return prepared?.wait === "subscription-auth" ? { wait: true, until: prepared.until } : null;
		const next = prepared.snapshot;
		if (next.connectionId !== snapshot.connectionId || next.bindingSignature !== snapshot.bindingSignature || next.adapter !== snapshot.adapter || next.accountGroup !== snapshot.accountGroup) return null;
		if (snapshot.renewable === true && next.deadlineAt === snapshot.deadlineAt && next.generation === snapshot.generation) return { wait: true, until: Math.max(now() + 60_000, next.refreshAt ?? 0) };
		return { ...snapshot, ...next };
	}
	return { check, inspectPolicy, prepare, validate, observe, usage, status, extend };
}
