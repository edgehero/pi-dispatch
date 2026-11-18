import * as nodeFs from "node:fs";
import { isTransientOverlayRead } from "./model-catalog.mjs";
import { modelSelectionProblem, modelListProblem, modelOnList, splitModelEntry } from "./model-ref.mjs";
import { DISARMED_TYPE, parseTriggersDocument } from "./triggers.mjs";
import { isForgeTriggerOf } from "./trigger-identity.mjs";

const changed = () => ({ refused: "model-selection-policy-changed" });
const samePool = (a, b) => a.length === b.length && a.every((ref) => b.includes(ref));

/** Re-read reviewed random policy at pickup. A changed pool refuses; it never grants a different draw. */
export function makeCheckModelSelectionPolicy({ triggersPath, allowedModels = null, fs = nodeFs } = {}) {
	return function checkModelSelectionPolicy(job, { queueJobId } = {}) {
		if (job?.modelSelection === undefined) return { ok: true };
		if (modelSelectionProblem(job.modelSelection) !== null) return changed();
		const matched = job.trigger?.matched;
		const hasMatched = matched !== undefined;
		const cronId = job.kind === "local" && typeof job.trigger?.id === "string" ? job.trigger.id : null;
		// CLI and outbox children have no live trigger identity. Their producer's reviewed policy is
		// immutable job input; candidate admission still enforces its effective ceiling before spending.
		if (!hasMatched && cronId === null) return { ok: true };
		if (hasMatched && (!Number.isSafeInteger(matched?.index) || matched.index < 0 || typeof matched.type !== "string")) return changed();
		if (typeof triggersPath !== "string" || !triggersPath) return changed();
		let text;
		try { text = fs.readFileSync(triggersPath, "utf8"); }
		catch (error) {
			if (isTransientOverlayRead(error?.code) || !error?.code) throw new Error("the reviewed random model policy could not be read", { cause: error });
			return changed();
		}
		let entries;
		try { entries = parseTriggersDocument(text, triggersPath).triggers; }
		catch (error) { return error?.newer === true ? { newer: true } : changed(); }
		if (hasMatched && entries[matched.index]?.on?.type === DISARMED_TYPE && typeof queueJobId === "string") {
			// A one-shot's own retry keeps the same authority. A foreign disarm revokes it.
			const raw = JSON.parse(text);
			if (raw.triggers[matched.index]?.on?.disarmed?.jobId === queueJobId) {
				delete raw.triggers[matched.index].on.disarmed;
				try { entries = parseTriggersDocument(JSON.stringify(raw), triggersPath).triggers; }
				catch { return changed(); }
			}
		}
		let entry;
		if (hasMatched) {
			entry = entries[matched.index];
			// The identity every pre-spend check shares (issue #933). A reviewed comment rule permits a flow override, but
			// only to a flow the receiver could have routed it to (a forge trigger's in the file), no longer to any flow.
			if (!isForgeTriggerOf(entries, entry, job)) return changed();
		} else {
			entry = entries.find((candidate) => candidate.on.type === "cron" && candidate.on.id === cronId && ["folder", "flow", "command", "task"].every((key) => candidate.run[key] === job[key]));
		}
		if (modelSelectionProblem(entry?.run?.modelSelection) !== null || !samePool(entry.run.modelSelection.candidates, job.modelSelection.candidates)) return changed();
		const ceiling = entry.run.models ?? allowedModels;
		if (modelListProblem(ceiling) !== null) return changed();
		return job.modelSelection.candidates.every((ref) => {
			const { provider, model } = splitModelEntry(ref);
			return modelOnList(ceiling, provider, model);
		}) ? { ok: true } : changed();
	};
}
