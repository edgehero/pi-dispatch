import { REASONS } from "./reason-catalog.mjs";
import { createHash } from "node:crypto";
/** Host-only orchestration. Private snapshots never become job data, run records or telemetry. */
import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";
import { builtinModel } from "./model-catalog.mjs";
import { splitModelEntry, auxiliaryModelsProblem } from "./model-ref.mjs";
import { normalizeClaudeQuota, normalizeOpenAIQuota, normalizeSubscriptionQuotaError, SUBSCRIPTION_QUOTA_LIMITS } from "./subscription-quota.mjs";
import { LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH } from "./private-store-boundary.mjs";

/**
 * Issue #1008: how soon a job the quota reserve holds asks again. A reading's freshness bound, so a fresh reading over
 * the reserve with no reset is asked about again as it goes stale (a stale one with no reset no longer holds, and
 * `prepare` reads usage before it admits), and a trigger marked `run.quotaReserve` meanwhile starts its waiting jobs
 * within it. A known reset sooner than this ends the wait instead.
 */
export const QUOTA_RESERVE_RECHECK_MS = SUBSCRIPTION_QUOTA_LIMITS.freshMs;

/**
 * Issue #1008, the deployment quota reserve: the windows of a quota `status` that stand at or above `percent`, with the
 * latest reset among them (null when one has none), or null when no window does. `status` is the one admission judged,
 * already narrowed to the windows that count for the route (`statusForModel`), so the reserve counts exactly the windows
 * admission counts, monitoring preferences aside as they are there.
 *
 * Only a measured percent counts: unknown usage is not usage, and the reserve holds work back on evidence, never on a
 * guess. Usage only grows inside a window until it resets, so a reading over the reserve stays true until its reset: a
 * stale one with its reset still ahead counts. A window with no reset counts only on a fresh reading, since nothing
 * says when a stale one stopped being true; such a reading passes here and `prepare` reads usage again before it
 * admits (`needsUsage`). A reset already passed opens a new window and counts nothing.
 */
export function quotaReserveBlock(status, percent, at) {
	if (!Number.isInteger(percent) || percent < 1 || percent > 99 || !Array.isArray(status?.windows)) return null;
	const over = status.windows.filter((row) => typeof row?.usedPercent === "number" && row.usedPercent >= percent && (Number.isSafeInteger(row.resetAt) ? row.resetAt > at : row.fresh === true));
	if (over.length === 0) return null;
	return { windows: over, resetAt: over.every((row) => Number.isSafeInteger(row.resetAt)) ? Math.max(...over.map((row) => row.resetAt)) : null };
}

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
// Issue #968: once a random pool has drawn (the job carries the drawn provider and model), the drawn ref is its only
// root. A candidate it did not draw is not a route of the attempt at all unless it is also listed as an auxiliary model,
// and then it is admitted as an auxiliary is: it can neither refuse the attempt for its other class nor become a root.
// Before the draw (no provider yet) every candidate is a root, which is how the whole pool gets classified.
function auxiliaryRoute(job, ref) {
	const key = `${ref.provider}/${ref.id}`;
	const drawn = job.modelSelection !== undefined && job.modelSelection !== null && typeof job.provider === "string" && job.provider !== "" && typeof job.model === "string" && job.model !== "";
	const roots = [`${job.provider}/${job.model}`, ...(job.fallbackModels ?? []), ...(drawn ? [] : job.modelSelection?.candidates ?? [])];
	for (const role of [job.watchDecisionModel, job.questionGroupModel, job.answerDecisionModel]) if (role) roots.push(`${role.provider}/${role.id}`);
	return Array.isArray(job.auxiliaryModels) && job.auxiliaryModels.includes(key) && !roots.includes(key);
}

/**
 * `quotaReservePercent` is this host's `PI_QUOTA_RESERVE_PERCENT` (issue #1008), null for none; `reserveGranted(job)`
 * answers whether the job's trigger sets `run.quotaReserve: true` (triggers-file.mjs `makeCheckQuotaReserve`, a read of
 * the reviewed file), asked only for a job the reserve would hold. Its default grants nothing, so an unwired caller
 * holds every job above the reserve, the direction that spends nothing.
 */
export function makeSubscriptionRuntime({ auth, quota, now = Date.now, lookup = builtinModel, packageRootFor = () => null, defaultBackend = "local", isPrivateStoreExposed = () => false, quotaReservePercent = null, reserveGranted = () => false } = {}) {
	/**
	 * Whole-pool billing classification cannot return early on a quota wait and hide a paid alternative.
	 *
	 * Issue #968: `classes` names every root route's own class, "subscription" for a provider bound to a connection
	 * (also one that cannot authorize now: `auth.check` answers `managed: true` for a broken binding, so a failing
	 * subscription never reads as an API-key route) and "api" otherwise. A random pool may hold both, each draw then
	 * billing its own candidate's class under the trigger's cap (model-selection.mjs); every other route set refuses a
	 * mix as before. The whole-pool gates above stay whole-pool: an unbounded auxiliary grant, an exposed private store
	 * and an unavailable row refuse or retry whatever the draw would have been.
	 */
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
		const classes = {};
		for (const ref of subscriptionRoutes(job)) {
			const model = lookup(ref.provider, ref.id);
			const row = await auth.check(ref.provider, { model: ref.id, api: model?.api, baseUrl: model?.baseUrl, readOnly: true });
			if (row.unavailable) return recordRefusal(row);
			if (!auxiliaryRoute(job, ref)) {
				classes[`${ref.provider}/${ref.id}`] = row.managed ? "subscription" : "api";
				if (row.managed) managed = true; else unmanaged = true;
			}
			if (row.ok) bindings[`${ref.provider}/${ref.id}`] = row.managed ? subscriptionBindingDigest(row) : null;
		}
		return managed && unmanaged && !job.modelSelection ? { ok: false, managed: true, reason: "auth-mixed-billing" } : { ok: true, managed, bindings, classes };
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
			// Issue #1008, the deployment quota reserve: AFTER admission, so an exhausted window keeps its own wait and its
			// reselection rule, and only on Claude, whose windows carry percentages (a ChatGPT reading has none to judge).
			// A WAIT, never a refusal: the window drops at its reset, and holding a job costs nothing, where refusing it
			// would lose a delivery the owner wants run later. Its auxiliary attribution is the quota wait's, so a panel
			// member held here never grants the selected root a fresh random draw.
			if (ref.provider === "anthropic" && quotaReservePercent !== null) {
				const at = now();
				const held = quotaReserveBlock(available.status, quotaReservePercent, at);
				if (held !== null && (await reserveGranted(job)) !== true) return withRoot({ ok: false, managed: true, ...(job.auxiliaryModels === undefined ? {} : { auxiliary: !primary }), wait: "subscription-reserve", until: held.resetAt === null ? at + QUOTA_RESERVE_RECHECK_MS : Math.min(held.resetAt, at + QUOTA_RESERVE_RECHECK_MS), resetAt: held.resetAt, status: available.status });
			}
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
	/**
	 * Issue #960: settles a connection's trial after a verified exit line whose code matches the container's (0, 1 or 2)
	 * and was not aborted, for the attempt holding it (subscription-quota.mjs holds the trial and claim-time guards).
	 * - A rate or quota failure, on any provider (a quota read from prose names none), settles nothing here: `observe`
	 *   records that refusal and the trial with it.
	 * - A metered call on this connection's provider that returned output clears the refusals (`clearTrialEvidence`):
	 *   the provider answered, so the limit is open, whatever ended the run after (an overload later, a policy stop).
	 * - A run that provably never called that provider gives the trial back (`releaseTrial`): it proved nothing about the
	 *   limit. Proof is the rule the dollar settlement trusts (dollar-budget.mjs `modelDollarSettlement`): no ledger on a
	 *   line that counted no calls, or a ledger whose `truncated` is exactly 0, with no `other/other` row that made calls
	 *   (folded overflow and model-less calls land there) and no call in a row of that provider.
	 * - Anything else (calls that returned no output, a ledger that cannot rule the provider out) leaves the trial used,
	 *   and the next retest comes six hours after its claim. Only a row named for that provider counts as its answer,
	 *   never `other/other`.
	 * The usage ledger names calls by provider, not by session, and every call to that provider in the job used this
	 * connection: a provider is either the job's subscription or not (`auth-mixed-billing`). Only a snapshot whose binding
	 * still holds is settled, as `observe` records only for one. Each connection apart; a refused settlement is no error.
	 */
	async function settleTrial(job, result, snapshots, { attemptId } = {}) {
		if (result?.exitAuth !== "verified" || ![0, 1, 2].includes(result?.code) || result?.exitLineCode !== result?.code || result?.aborted === true || typeof attemptId !== "string") return [];
		if (["quota-exhausted", "rate-limited"].includes(result.providerFailure?.kind) || result.tokens?.metered !== true) return [];
		const models = Array.isArray(result.usage?.models) ? result.usage.models : null;
		const settled = [];
		for (const snapshot of snapshots) {
			const rows = models?.filter((row) => row?.provider === snapshot.provider) ?? [];
			const answered = rows.some((row) => row.calls > 0 && row.output > 0);
			const unasked = models === null ? result.tokens.calls === 0 : result.usage.truncated === 0 && !models.some((row) => row?.provider === "other" && row?.model === "other" && row.calls > 0) && !rows.some((row) => row.calls > 0);
			if (!answered && !unasked) continue;
			const route = job.auxiliaryModels === undefined ? { provider: snapshot.provider, id: job.model } : subscriptionRoutes(job).find((ref) => ref.provider === snapshot.provider);
			if (!route) continue;
			const model = lookup(route.provider, route.id);
			const bound = await auth.check(snapshot.provider, { model: route.id, api: model?.api, baseUrl: model?.baseUrl });
			if (!bound.ok || !bound.managed || !sameBinding(bound, snapshot)) continue;
			const identity = subscriptionIdentity(snapshot);
			const written = answered ? await quota.clearTrialEvidence(identity, { attemptId, observedAt: now() }) : await quota.releaseTrial(identity, { attemptId });
			if (written.ok) settled.push({ provider: snapshot.provider, trial: answered ? "cleared" : "released" });
		}
		return settled;
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
		// Issue #1008: the reserve on each Claude connection this host owns, the one host whose reserve holds its jobs.
		// A connection another host owns is held by that host's reserve, which that host publishes.
		const reserved = (row) => quotaReservePercent !== null && row.provider === "anthropic" && row.state !== "other-host";
		return { state: "ready", partial: false, connections: await Promise.all(rows.map(async (row) => ({ ...row, ...(row.accountGroup ? { quota: await quota.read(subscriptionIdentity(row)) } : {}), ...(reserved(row) ? { reservePercent: quotaReservePercent } : {}) }))) };
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
		if (next.provider !== snapshot.provider || next.connectionId !== snapshot.connectionId || next.bindingSignature !== snapshot.bindingSignature || next.adapter !== snapshot.adapter || next.accountGroup !== snapshot.accountGroup) return null;
		if (snapshot.renewable === true && next.deadlineAt === snapshot.deadlineAt && next.generation === snapshot.generation) return { wait: true, until: Math.max(now() + 60_000, next.refreshAt ?? 0) };
		return { ...snapshot, ...next };
	}
	async function current(snapshot, { signal } = {}) {
		if (!snapshot || snapshot.deadlineAt <= now() || typeof auth.readSnapshot !== "function") return null;
		const prepared = await auth.readSnapshot(snapshot.provider, { deadlineAt: snapshot.deadlineAt, signal, renewable: snapshot.renewable === true, extending: true });
		const next = prepared?.snapshot;
		if (!prepared?.ok || !next || next.generation <= snapshot.generation || next.deadlineAt !== snapshot.deadlineAt) return null;
		if (next.provider !== snapshot.provider || next.connectionId !== snapshot.connectionId || next.bindingSignature !== snapshot.bindingSignature || next.adapter !== snapshot.adapter || next.accountGroup !== snapshot.accountGroup) return null;
		return { ...snapshot, ...next };
	}
	return { check, inspectPolicy, prepare, validate, observe, settleTrial, usage, status, extend, current, watch: (snapshot, changed) => auth.watch?.(snapshot.connectionId, changed) };
}
