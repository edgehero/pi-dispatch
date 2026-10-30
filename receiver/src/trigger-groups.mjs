/** The receiver's exact rule grouping, shared with read-only hypothetical matching (#750). */
import { FORGE_KINDS, PR_CLOSE_ACTIONS } from "@edgehero/pi-dispatch/triggers";

export function groupTriggers(parsed, { watchSources = {} } = {}) {
	// Every forge gets a group whether or not the file names it, so the filter can read
	// `cfg.triggers[kind].label` without a presence check and an unconfigured forge simply matches nothing.
	//
	// Built FROM the forge table rather than written out, because the failure of forgetting one is unusually
	// quiet: `groups[run.kind]` would be undefined, `group.label.push` would throw, and `config.mjs` reload
	// catches everything and KEEPS the previously-loaded triggers. The operator would see one
	// "invalid" message and their old rules would go on firing indefinitely. A test asserts this object's
	// keys are exactly FORGE_KINDS, so the two can never drift.
	const groups = Object.fromEntries(FORGE_KINDS.map((kind) => [kind, emptyGroup()]));
	const knownFlows = new Set();

	for (const [index, { on, run }] of parsed.entries()) {
		if (on.type === "cron" || on.type === "watch") continue;
		// Guarded because a command trigger (issue #189) has NO run.flow, and `Set.add(undefined)` would put
		// undefined into the comment `<phrase> <flow>` override allowlist. That set exists to bound which
		// names a collaborator's comment may summon; polluting it with a non-name is how a later loose
		// membership test (or a `[...set]` enumeration in a message) starts treating "no flow" as a flow.
		if (typeof run.flow === "string") {
			knownFlows.add(run.flow);
		}
		const group = groups[run.kind];
		if (on.type === "label") {
			group.label.push({ index, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, mcp: run.mcp, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, maxCostUsd: run.maxCostUsd, skillsDir: run.skillsDir, instructions: run.instructions, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas, repository: run.repository });
		} else if (on.type === "comment") {
			group.comment = { index, phrase: on.phrase, defaultFlow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, mcp: run.mcp, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, maxCostUsd: run.maxCostUsd, skillsDir: run.skillsDir, instructions: run.instructions, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas, repository: run.repository }; // parseTriggers guarantees at most one per forge
		} else if (on.type === "pull_request") {
			// The close-only split (issue #231): a close rule routes through the close gate (the CLOSER's
			// resolved authority) and every other PR rule through the author gate, so they live in separate
			// groups and neither route ever re-derives the distinction -- the loader already refused any
			// list mixing the close word with another action, which is what makes this split total. The
			// split reads the SHARED close-word table, never a re-typed word.
			const closeWord = PR_CLOSE_ACTIONS[run.kind];
			if (closeWord !== undefined && on.action.includes(closeWord)) {
				group.prClose.push({ index, actions: new Set(on.action), number: on.number, once: on.once, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, mcp: run.mcp, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, maxCostUsd: run.maxCostUsd, skillsDir: run.skillsDir, instructions: run.instructions, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
			} else {
				// `reviewStates` is null rather than an empty Set when unnarrowed: the filter tests it for
				// presence, and an empty Set would read as "no verdict matches" and silently refuse everything.
				group.pullRequest.push({ index, actions: new Set(on.action), reviewStates: on.reviewState ? new Set(on.reviewState) : null, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, mcp: run.mcp, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, maxCostUsd: run.maxCostUsd, skillsDir: run.skillsDir, instructions: run.instructions, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
			}
		} else if (on.type === "issue") {
			// The close-trigger kind (issue #231). No predicate and no reviewStates by construction (the
			// loader refused both), and `number`/`once` ride conditionally-present exactly as the loader
			// normalized them -- the filter's close route reads them, nothing else does.
			group.issue.push({ index, actions: new Set(on.action), number: on.number, once: on.once, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, mcp: run.mcp, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, maxCostUsd: run.maxCostUsd, skillsDir: run.skillsDir, instructions: run.instructions, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
		}
	}

	return { ...groups, knownFlows, ...(Object.keys(watchSources).length ? { watchSources, watch: parsed.filter(t => t.on.type === "watch") } : {}) };
}

function emptyGroup() {
	return { label: [], comment: null, pullRequest: [], issue: [], prClose: [] };
}
