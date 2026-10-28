import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { modelEntryOf } from "./model-endpoints.mjs";
import { FORK_THINKING_LEVELS } from "./fork-job.mjs";

/** The pinned provider composer's two reasoning fields, including its per-level override merge. */
export function thinkingModel({ models, provider, modelId, builtinModel = () => null }) {
	const { defined, override } = modelEntryOf(models, provider, modelId);
	const base = defined ? { reasoning: defined.reasoning ?? false, thinkingLevelMap: defined.thinkingLevelMap } : builtinModel(provider, modelId);
	if (!base) return null;
	return {
		reasoning: override?.reasoning ?? base.reasoning,
		thinkingLevelMap: override?.thinkingLevelMap ? { ...base.thinkingLevelMap, ...override.thinkingLevelMap } : base.thinkingLevelMap,
	};
}
export function thinkingLevelAllowed(job, { models, builtinModel } = {}) {
	if (!FORK_THINKING_LEVELS.includes(job.thinkingLevel)) return false;
	const model = thinkingModel({ models, provider: job.provider, modelId: job.model, builtinModel });
	return model !== null && clampThinkingLevel(model, job.thinkingLevel) === job.thinkingLevel;
}
