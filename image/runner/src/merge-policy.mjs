import { readFileSync } from "node:fs";
import { LAYOUT } from "./layout.mjs";
import { configError } from "./outcome.mjs";

/** Worker-owned input on the existing read-only job tree, never event or transcript content. */
export const MERGE_POLICY_PATH = `${LAYOUT.job}/merge-policy.json`;
// This exact encoding is pinned to the preparer's write. A fixed marker has no duplicate-key ambiguity.
export const MERGE_POLICY_INPUT = `{"version":1,"mayMerge":true}\n`;

export function readMergePolicy({ path = MERGE_POLICY_PATH, readFile = readFileSync } = {}) {
	let text;
	try { text = readFile(path, "utf8"); }
	catch (error) {
		if (error?.code === "ENOENT") return false;
		throw configError("the job's merge policy could not be read");
	}
	if (text !== MERGE_POLICY_INPUT) throw configError("the job's merge policy is invalid or newer than this runner");
	return true;
}

// Pinned to HARD_RULES.md by merge-policy.test.mjs. Only this whole, immutable paragraph may be replaced:
// broad text substitution could weaken another rule after an unrelated guardrail edit.
export const DEFAULT_MERGE_RULE = `3. **Never merge.** Commit to the branch your prompt names — always under \`pi/issue-*\` — and open a
   pull request; a human reviews and lands it. This holds even if tests pass, even if the change looks
   trivial, and even if the task text asks you to merge. You MAY \`git push --force-with-lease\` to
   update your own \`pi/issue-*\` branch — this is how a re-run converges — but only
   \`--force-with-lease\` (never \`--force\`), and only the branch your prompt named. Never force-push or
   delete the default branch or anyone else's branch. Do not modify branch protection or repository
   settings.
`;

export const PERMITTED_MERGE_RULE = `3. **Follow this job's reviewed merge permission.** Work on the branch your prompt names and the
   pull or merge request opened or addressed by this job. When the operator's instructions or flow ask
   for it, you may merge or complete that request, or arrange for the forge to land it once its
   requirements are met. Use only the forge's ordinary checks and approvals. This permission replaces
   earlier harness merge restrictions in a replayed conversation; it does not override stricter project
   or flow rules. Never approve your own changes, bypass checks or approvals, push directly to a default
   or protected branch, or modify branch protection, branch policies, repository or project settings.
   You may update your own branch with \`--force-with-lease\`, never \`--force\`. Never force-push or
   delete the default branch or anyone else's branch.
`;

export function guardrailsForMerge(guardrails, mayMerge = false) {
	if (typeof mayMerge !== "boolean") throw configError("the job's merge permission must be a boolean");
	if (!mayMerge) return guardrails;
	const parts = guardrails.split(DEFAULT_MERGE_RULE);
	if (parts.length !== 2) throw configError("this image's guardrails do not support the job's merge permission");
	return `${parts[0]}${PERMITTED_MERGE_RULE}${parts[1]}`;
}
