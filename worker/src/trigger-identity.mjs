/**
 * Which triggers.json entry queued a forge job (issue #933): ONE reading for every pre-spend check that goes back to the
 * file for a job it already holds, so the checks cannot drift apart again.
 *
 * `trigger.matched.index` is a RAW array position. An insertion, a delete above it or a reorder moves another trigger to
 * that index, so no check may trust the position alone; each confirms that the entry there is still the trigger the job
 * came from. Five checks did, with five hand-written readings, and they had drifted: the skew check refused nothing for
 * the two job shapes below (so a narrowing field a stale receiver dropped ran on a clean record), and the secret bundle
 * lookup refused one of them outright as a changed trigger. What each check DOES with a mismatch stays its own (the skew
 * check runs the job, the merge policy refuses it); only the question "is this the entry" lives here.
 *
 * The entry is the job's when all of these hold:
 *   - it is of the job's forge (`run.kind`);
 *   - its `on.type` is the one the job matched, or the job is a GitLab merge request a LABEL matched on a `pull_request`
 *     rule: GitLab reports that route as `matched.type: "label"` while the rule is a merge request rule
 *     (`receiver/src/filter-gitlab.mjs`, `routeMergeRequest`), and the job's target says it is a pull request;
 *   - it dispatches the job's lane: the same command for a command job; for a flow job no command, and either the same
 *     flow or a `comment` entry whose `<phrase> <flow>` override named another trigger's flow. The receiver lets a comment
 *     summon only a flow in `knownFlows`, and copies the COMMENT entry's own `run` fields onto such a job, so the comment
 *     entry is the one whose fields the job carries. `routableFlows` is that set, one derivation for both services;
 *   - it still holds what the job matched: the action, the label (in `on.any` or `on.all`) and the phrase.
 *
 * REJECTED: position alone (any edit above the entry hands a job another trigger's fields); flow alone (two rules sharing
 * a flow are indistinguishable); a comment entry accepting ANY flow (wider than anything the receiver can produce, so a
 * flow no trigger in the file holds any more is a changed file, not this trigger).
 *
 * Reads raw entries (the skew and secret bundle checks parse the file themselves, unvalidated) and the loader's normalized
 * ones alike: every access is guarded, a list is used only when it is an array, and a disarmed one-shot is read as the
 * loader reads it, which is as no trigger's flow.
 */
import { DISARMED_TYPE } from "./triggers.mjs";

const list = (value) => Array.isArray(value) ? value : [];

/**
 * The flows a comment's `<phrase> <flow>` may summon: every `run.flow` of a forge entry, that is not a cron or watch
 * entry, a local event listener, or a disarmed one-shot. The receiver's `knownFlows` (`receiver/src/trigger-groups.mjs`)
 * is built by this function.
 */
export function routableFlows(entries) {
	const flows = new Set();
	for (const entry of list(entries)) {
		const type = entry?.on?.type;
		if (type === "cron" || type === "watch" || type === DISARMED_TYPE || entry?.on?.disarmed !== undefined) continue;
		if (entry?.run?.kind === "local") continue;
		// A command entry has no flow, and `undefined` in the set would read as a flow a comment could name.
		if (typeof entry?.run?.flow === "string") flows.add(entry.run.flow);
	}
	return flows;
}

/**
 * The first way `entry` (one of `entries`) is NOT the forge trigger that queued `job`, or null when it is: `"entry"` (no
 * entry, or no matched record on the job), `"kind"`, `"type"`, `"action"`, `"label"`, `"phrase"` or `"lane"` (the flow or
 * command). The order is the console's, which names the first change in its refusal (`admin/src/job-actions.mjs`,
 * `currentTriggerFor`); every other caller only asks `isForgeTriggerOf`.
 */
export function forgeTriggerMismatch(entries, entry, job) {
	const matched = job?.trigger?.matched;
	if (entry === null || typeof entry !== "object" || matched === null || typeof matched !== "object") return "entry";
	const on = entry.on ?? {};
	const run = entry.run ?? {};
	if (run.kind !== job.kind) return "kind";
	if (on.type !== matched.type && !(matched.type === "label" && on.type === "pull_request" && job.target?.type === "pull_request")) return "type";
	if (typeof matched.action === "string" && !list(on.action).includes(matched.action)) return "action";
	if (typeof matched.label === "string" && !list(on.any).includes(matched.label) && !list(on.all).includes(matched.label)) return "label";
	if (typeof matched.phrase === "string" && on.phrase !== matched.phrase) return "phrase";
	const sameLane = job.command !== undefined
		? run.command === job.command
		: run.command === undefined && (run.flow === job.flow || (on.type === "comment" && typeof job.flow === "string" && routableFlows(entries).has(job.flow)));
	return sameLane ? null : "lane";
}

/** Whether `entry` (one of `entries`) is the forge trigger that queued `job`, by the rules above. */
export function isForgeTriggerOf(entries, entry, job) {
	return forgeTriggerMismatch(entries, entry, job) === null;
}
