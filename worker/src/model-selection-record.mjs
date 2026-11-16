import { modelSelectionProblem } from "./model-ref.mjs";

/** Only reviewed physical identities cross into public history; never the host's selection state. */
export function recordedModelSelection(value) {
	if (!value || modelSelectionProblem({ strategy: value.strategy, candidates: value.candidates }) !== null) return null;
	if (value.previous !== undefined && modelSelectionProblem({ strategy: "random", candidates: [value.previous] }) !== null) return null;
	return { strategy: "random", candidates: [...value.candidates], ...(value.previous !== undefined ? { previous: value.previous } : {}) };
}

// In-process queue acknowledgement only: never serialized into job data, a result or public history.
export const MODEL_SELECTION_FINISH = Symbol("model-selection-finish");
