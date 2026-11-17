// Issue #918, part 3: what `pi-dispatch doctor` says about private endpoints (REQ-PRIVATE-ENDPOINTS), from plain facts.
//
// Pure apart from the address lookup it is handed: the declared endpoints (`private-endpoints.json` as the service reads
// it), the triggers that name them (`privateRunsOf`, from the loaders' own parse), the egress posture, whether this host
// is one of a fleet, the venues and the model endpoints. doctor.mjs reads those and pushes what this returns; its proxy
// reads (the include inside the running proxy, the helper's answer) and the canary's probes sit beside its model
// endpoint ones.

import { isIP } from "node:net";
import { backendFor } from "./backends.mjs";

/**
 * Whether a venue's jobs are refused a grant (`private-endpoint-venue-unsupported`): the processor's own rule, a venue
 * whose table entry declares its own egress layer (`credentialCustody: "layer"`), read from the same table.
 */
const refusesGrant = (venue) => backendFor(venue)?.credentialCustody === "layer";

/** How a line names its trigger, as doctor's `triggerLabel` does: a cron entry by its id, any other by file position. */
function labelOf(t, index) {
	return t?.on?.type === "cron" ? `cron "${t.on.id}"` : `${t?.on?.type} trigger #${index}`;
}

/**
 * The triggers that name private endpoints, from the parsed entries (`parseTriggersDocument`'s `triggers`, so file
 * positions are the raw ones): `{ index, label, ids, kind, forge, onType, backend, eventDriven, ownQueue, served }`.
 * `eventDriven` is a job an issue, a pull request or a comment starts (a forge trigger, or a local event's), whose agent
 * reads text the operator did not write. `ownQueue` is a job queued on its host's own queue (a cron or local job, never
 * handed to another host); `served` whether this host runs the trigger's jobs at all (`servedHere`, doctor's own
 * predicate for a cron's placement and a local event's `run.worker`; every trigger when none is given). A disarmed entry
 * names nothing.
 */
export function privateRunsOf(triggers, { servedHere = () => true } = {}) {
	const runs = [];
	(Array.isArray(triggers) ? triggers : []).forEach((t, index) => {
		const ids = t?.run?.privateEndpoints;
		if (!Array.isArray(ids) || ids.length === 0) return;
		const local = t.run.kind === "local";
		const forge = local ? (typeof t.on?.forge === "string" ? t.on.forge : null) : t.run.kind;
		runs.push({ index, label: labelOf(t, index), ids: [...ids], kind: t.run.kind, forge, onType: t.on?.type ?? null, backend: typeof t.run.backend === "string" ? t.run.backend : null, eventDriven: t.on?.type !== "cron", ownQueue: local || t.on?.type === "cron", served: servedHere(t) !== false });
	});
	return runs;
}

/** `host:port` as declared (an IPv6 literal is stored bracketed). */
const pairOf = (e) => `${e.host}:${e.port}`;

/**
 * The plain lines, in this order: each declared endpoint and the triggers granted it; a trigger naming an id this host
 * does not declare; a trigger whose jobs run on a venue that refuses a grant; a trigger whose jobs an issue or comment
 * starts (the device's blast radius); the egress policy off. Every line names ids, hosts and ports from the operator's
 * own files and trigger positions, never a trigger's text.
 *
 *   - `endpoints`: the declaration, `[{ id, host, port, slots }]`.
 *   - `runs`: `privateRunsOf`.
 *   - `egressArmed`: whether a proxy enforces the grants (`PI_EGRESS` not 0).
 *   - `fleet`: whether this host is one of several on a shared queue (a declared worker name), where a FORGE job naming an
 *     id this host lacks waits for a host that declares it rather than being refused; a cron or local job is queued on
 *     its host's own queue, and is refused there whatever the fleet. A trigger this host does not serve is not judged.
 *   - `defaultBackend`: the venue a trigger with no `run.backend` runs on (the first blessed).
 */
export function privateEndpointChecks({ endpoints = [], runs = [], egressArmed = true, fleet = false, defaultBackend = "local" }) {
	const checks = [];
	const declared = new Map(endpoints.map((e) => [e.id, e]));
	const sorted = [...endpoints].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const e of sorted) {
		const named = runs.filter((r) => r.ids.includes(e.id)).map((r) => r.label);
		const bound = Number.isInteger(e.slots) ? `${e.slots} job${e.slots === 1 ? "" : "s"} at a time` : "no bound on jobs at a time";
		checks.push(
			named.length > 0
				? { ok: true, label: `Private endpoint ${e.id} (${pairOf(e)}, ${bound}) is granted to ${named.join(", ")}` }
				: { ok: false, warn: true, label: `Private endpoint ${e.id} (${pairOf(e)}) is declared, but no trigger names it, so no job reaches it`, fix: `name it in a trigger's run.privateEndpoints, or take it out of private-endpoints.json and run \`pi-dispatch egress render\`` },
		);
	}
	const here = runs.filter((r) => r.served !== false);
	for (const r of here) {
		const missing = r.ids.filter((id) => !declared.has(id));
		if (missing.length === 0) continue;
		const what = `${r.label} names private endpoint${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, which this host does not declare`;
		checks.push(
			fleet && r.ownQueue !== true
				? { ok: false, warn: true, label: `${what}: its jobs on the shared queue wait for a host that declares ${missing.length === 1 ? "it" : "them"}, and one routed to this host is refused (private-endpoint-unknown)`, fix: "declare it in private-endpoints.json on the host that reaches the device, or take it out of the trigger" }
				: { ok: false, label: `${what}: its jobs are refused before they spend (private-endpoint-unknown)`, fix: "declare it in private-endpoints.json and run `pi-dispatch egress render`, or take it out of the trigger" },
		);
	}
	for (const r of here) {
		const venue = r.backend ?? defaultBackend;
		if (!refusesGrant(venue)) continue;
		checks.push({ ok: false, label: `${r.label} names private endpoints, but its jobs run on the ${venue} venue, which cannot carry a grant yet: they are refused before they spend (private-endpoint-venue-unsupported)`, fix: "run that trigger's jobs on the local or podman venue (run.backend), or take the private endpoints out of it" });
	}
	for (const r of here) {
		if (!r.eventDriven) continue;
		const ids = r.ids.filter((id) => declared.has(id));
		if (ids.length === 0) continue;
		checks.push({
			ok: false,
			warn: true,
			label: `${r.label} grants ${ids.join(", ")} to jobs ${r.forge ? `an event on ${r.forge}` : "a forge event"} starts: their agent reads text anyone who can post there wrote, and can do on the device whatever its account there allows`,
			fix: "name a device only on the triggers that need it, and give the job a device account that can do only what the flow needs (SECURITY.md)",
		});
	}
	if (!egressArmed && endpoints.length > 0) {
		checks.push({ ok: false, warn: true, label: `The egress policy is off (PI_EGRESS=0), so no proxy enforces private endpoints: every job can reach ${sorted.map((e) => e.id).join(", ")}`, fix: "turn the egress policy on (unset PI_EGRESS) to bind each device to the triggers that name it" });
	}
	return checks;
}

/**
 * A model endpoint and a private endpoint that are one server under two names (issue #918): the same port, and a name
 * of one resolving to an address the other has (`lookup(host) => [address, ...]`, a literal resolving to itself). The
 * proxy matches each by its declared spelling, so a model endpoint's rule opens the device to every job. A host that
 * does not resolve here is not judged. Returns warn lines.
 */
export async function sharedServerChecks({ endpoints = [], modelEndpoints = [], lookup }) {
	if (endpoints.length === 0 || modelEndpoints.length === 0 || typeof lookup !== "function") return [];
	const bare = (host) => String(host).replace(/^\[(.*)\]$/, "$1");
	const resolved = new Map();
	const addressesOf = async (host) => {
		const h = bare(host);
		if (resolved.has(h)) return resolved.get(h);
		let list = [];
		if (isIP(h)) list = [h];
		else {
			try {
				list = (await lookup(h)).filter((a) => typeof a === "string");
			} catch {
				list = [];
			}
		}
		resolved.set(h, list);
		return list;
	};
	const checks = [];
	for (const p of endpoints) {
		const mine = await addressesOf(p.host);
		if (mine.length === 0) continue;
		for (const m of modelEndpoints) {
			if (m.port !== p.port) continue;
			const theirs = await addressesOf(m.host);
			const shared = theirs.find((a) => mine.includes(a));
			if (shared === undefined) continue;
			checks.push({ ok: false, warn: true, label: `Model endpoint ${m.id} (${pairOf(m)}) and private endpoint ${p.id} (${pairOf(p)}) are one server (${shared.includes(":") ? `[${shared}]` : shared}:${p.port}): every job reaches the device through the model endpoint's rule`, fix: "declare a device once, in private-endpoints.json, and take it out of model-endpoints.json; then `pi-dispatch egress render`" });
		}
	}
	return checks;
}
