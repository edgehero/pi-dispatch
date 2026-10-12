/**
 * REQ-AWAIT-INPUT, the reply half (issue #625): the forge marker on an issue whose last run is waiting for an answer.
 *
 * Imported by both services, like capabilities.mjs, because the receiver routes on it and the worker writes it: two
 * spellings of one label would be two places for one to drift while every test stayed green.
 *
 * THE LABEL IS A HINT, THE SIDECAR IS THE TRUTH. The receiver cannot read the session store (on a fleet it may not
 * even run beside one), so a label the forge already sends in every comment payload is what lets it route a reply
 * that carries no trigger phrase. Anyone who may label an issue can set it, so it decides nothing on its own: the
 * worker refuses such a reply before any spend unless the key's `parked` sidecar exists (`not-parked`). And it
 * widens WHICH comments start a job, never WHO may: the comment trigger's author gate still runs first.
 */
export const PARKED_LABEL = "pi-awaiting-input";

/** Whether a subset's `[{ name }]` label list (or Azure's tag list, the same shape) carries the marker. */
export function hasParkedLabel(labels) {
	return Array.isArray(labels) && labels.some((label) => label?.name === PARKED_LABEL);
}
