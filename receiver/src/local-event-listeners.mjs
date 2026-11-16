/**
 * Forge events wake reviewed local commands without carrying their text into the local workspace (#911).
 * Matching reuses each forge's existing pure filter, one listener at a time, so independent local listeners
 * neither shadow each other nor change the first-match rule for ordinary forge jobs.
 */
import { sourceForgeOf } from "@edgehero/pi-dispatch/triggers";
import { makeLocalEventStore } from "@edgehero/pi-dispatch/local-event-store";
import { groupTriggers } from "./trigger-groups.mjs";
import { filter, hasCloseTriggers, wantsCloserAuthority } from "./filter.mjs";
import { filterGitLab } from "./filter-gitlab.mjs";
import { filterForgejo } from "./filter-forgejo.mjs";
import { filterAzure } from "./filter-azure.mjs";

function listenerGroup(trigger) {
	const kind = sourceForgeOf(trigger);
	return groupTriggers([{ on: trigger.on, run: { ...trigger.run, kind } }]);
}

export function localEventVerdicts({ kind, event, subset, triggers, selfId, authorized, deliveryId }) {
	const verdicts = [];
	for (const trigger of triggers?.[kind]?.localEvents ?? []) {
		const groups = listenerGroup(trigger);
		const options = { matchOnly: true, reviewAuthors: trigger.on.reviewAuthors };
		let verdict;
		if (kind === "github") verdict = filter(event, subset, { triggers: groups }, selfId, deliveryId, authorized, options);
		else if (kind === "gitlab") verdict = filterGitLab(subset, groups.gitlab, groups.knownFlows, selfId, authorized, deliveryId, options);
		else if (kind === "forgejo") verdict = filterForgejo(event, subset, groups.forgejo, groups.knownFlows, selfId, authorized, deliveryId, options);
		else if (kind === "azure") verdict = filterAzure(subset, groups.azure, groups.knownFlows, selfId, authorized, deliveryId, options);
		verdicts.push({ trigger, enqueue: verdict?.enqueue === true, ...(verdict?.reason ? { reason: verdict.reason } : {}) });
	}
	return verdicts;
}

export function matchingLocalEvents(input) {
	return localEventVerdicts(input).filter(verdict => verdict.enqueue).map(verdict => verdict.trigger);
}

/** Close authorization is shared with the ordinary route, including its self and item-number guards. */
export function localEventsWantCloserAuthority(event, subset, group, selfId) {
	return (group?.localEvents ?? []).some(trigger => wantsCloserAuthority(event, subset, listenerGroup(trigger).github, selfId));
}

export function hasLocalCloseListeners(group) {
	return (group?.localEvents ?? []).some(trigger => hasCloseTriggers(listenerGroup(trigger).github));
}

/**
 * The store borrows an existing client and therefore opens no connection or timer to close. Construct it only
 * after a listener matched: old deployments and rejected deliveries never touch the new state family.
 */
export function makeLocalEventAdmission({ client, store, log = () => {} }) {
	let sharedStore = store;
	return async function admitLocalEvents(input) {
		const matches = matchingLocalEvents(input);
		if (matches.length === 0) return [];
		const accepted = [];
		try {
			sharedStore ??= makeLocalEventStore({ redis: await client() });
			for (const trigger of matches) {
				// Never spread input here. The only durable source data is the delivery identity; the command,
				// folder, destination and policy all come from the same normalized, operator-reviewed trigger.
				const result = await sharedStore.signal({ trigger, deliveryId: input.deliveryId });
				if (result?.accepted !== true) throw new Error("local-event-not-accepted");
				accepted.push(result);
				log({ event: result.coalesced === true ? "local_event_coalesced" : "local_event_accepted", delivery: input.deliveryId, kind: input.kind, triggerId: trigger.on.id, worker: trigger.run.worker });
			}
		} catch {
			// Both transport failure paths log an error's message. Redis diagnostics can repeat command
			// arguments, so cross that boundary with a fixed reason instead of the persistence exception.
			throw new Error("local-event-state-unavailable");
		}
		return accepted;
	};
}
