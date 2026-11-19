import assert from "node:assert/strict";
import { test } from "node:test";
import { FORGE_KINDS, PR_ACTIONS, PR_CLOSE_ACTIONS } from "@edgehero/pi-dispatch/triggers";
import { groupTriggers } from "../src/trigger-groups.mjs";

// Grouping is a separate copying boundary before the per-forge filter. Every route keeps the
// reviewed auxiliary grant; an absent grant must not become a present undefined versioned field.
test("receiver grouping preserves auxiliary grants for every forge route and local event", () => {
	for (const kind of FORGE_KINDS) for (const auxiliaryModels of [undefined, ["openrouter/google/gemini-4-neon"]]) {
		const run = { kind, flow: "fix", ...(auxiliaryModels !== undefined && { auxiliaryModels, models: auxiliaryModels, maxCostUsd: "1" }) };
		const ons = [{ type: "label", any: ["pi"] }, { type: "comment", phrase: "@pi" }, { type: "pull_request", action: [[...PR_ACTIONS[kind]].find(word => word !== PR_CLOSE_ACTIONS[kind])] }];
		if (PR_CLOSE_ACTIONS[kind]) ons.push({ type: "pull_request", action: [PR_CLOSE_ACTIONS[kind]] }, { type: "issue", action: [PR_CLOSE_ACTIONS[kind]] });
		const grouped = groupTriggers([...ons.map(on => ({ on, run })), { on: { type: "pull_request", forge: kind, action: ons[2].action }, run: { ...run, kind: "local", folder: "/repo", command: "checks" } }]);
		const group = grouped[kind];
		const rows = [...group.label, group.comment, ...group.pullRequest, ...group.issue, ...group.prClose, group.localEvents[0].run];
		assert.equal(rows.length, ons.length + 1);
		for (const row of rows) {
			assert.deepEqual(row.auxiliaryModels, auxiliaryModels, `${kind}: grant`);
			assert.equal(Object.hasOwn(row, "auxiliaryModels"), auxiliaryModels !== undefined, `${kind}: presence`);
			if (auxiliaryModels) {
				assert.deepEqual(row.models, auxiliaryModels);
				assert.equal(row.maxCostUsd, "1");
			}
		}
	}
});
