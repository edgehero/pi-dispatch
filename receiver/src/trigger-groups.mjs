/** The receiver's exact rule grouping, shared with read-only hypothetical matching (#750). */
import { mergePolicyDigest } from "@edgehero/pi-dispatch/merge-policy";
import { FORGE_KINDS, PR_CLOSE_ACTIONS, sourceForgeOf } from "@edgehero/pi-dispatch/triggers";
import { routableFlows } from "@edgehero/pi-dispatch/trigger-identity";

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
	// The flows a comment's `<phrase> <flow>` may summon. Built by the worker's `routableFlows` (issue #933), the same
	// function its pre-spend checks use to recognise a comment job routed to another trigger's flow, so the set the
	// receiver routes by and the set the worker confirms a routed job by cannot differ. A command trigger (issue #189)
	// has no run.flow and contributes nothing: `undefined` in the set would read as a flow a collaborator could summon.
	const knownFlows = routableFlows(parsed);

	for (const [index, { on, run }] of parsed.entries()) {
		if (on.type === "cron" || on.type === "watch") continue;
		// A local listener is additional work, never a rule that can steal the first forge match. Keep
		// its reviewed configuration whole: the durable signal has no need for any payload-derived job.
		if (run.kind === "local") {
			const group = groups[sourceForgeOf({ on, run })];
			(group.localEvents ??= []).push({ on, run });
			continue;
		}
		const group = groups[run.kind];
		const mergePolicy = run.mayMerge === true ? { mayMerge: true, mayMergePolicy: mergePolicyDigest({ on, run }) } : {};
		if (on.type === "label") {
			group.label.push({ index, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, excludeExtensions: run.excludeExtensions, excludeExtensionTools: run.excludeExtensionTools, mcp: run.mcp, privateEndpoints: run.privateEndpoints, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}), maxCostUsd: run.maxCostUsd, idleTimeoutMinutes: run.idleTimeoutMinutes, stallTimeoutMinutes: run.stallTimeoutMinutes, maxMinutes: run.maxMinutes, skillsDir: run.skillsDir, instructions: run.instructions, ...mergePolicy, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretFiles: run.secretFiles, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas, repository: run.repository });
		} else if (on.type === "comment") {
			group.comment = { index, phrase: on.phrase, defaultFlow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, excludeExtensions: run.excludeExtensions, excludeExtensionTools: run.excludeExtensionTools, mcp: run.mcp, privateEndpoints: run.privateEndpoints, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}), maxCostUsd: run.maxCostUsd, idleTimeoutMinutes: run.idleTimeoutMinutes, stallTimeoutMinutes: run.stallTimeoutMinutes, maxMinutes: run.maxMinutes, skillsDir: run.skillsDir, instructions: run.instructions, ...mergePolicy, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretFiles: run.secretFiles, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas, repository: run.repository }; // parseTriggers guarantees at most one per forge
		} else if (on.type === "pull_request") {
			// The close-only split (issue #231): a close rule routes through the close gate (the CLOSER's
			// resolved authority) and every other PR rule through the author gate, so they live in separate
			// groups and neither route ever re-derives the distinction -- the loader already refused any
			// list mixing the close word with another action, which is what makes this split total. The
			// split reads the SHARED close-word table, never a re-typed word.
			const closeWord = PR_CLOSE_ACTIONS[run.kind];
			if (closeWord !== undefined && on.action.includes(closeWord)) {
				group.prClose.push({ index, actions: new Set(on.action), number: on.number, once: on.once, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, excludeExtensions: run.excludeExtensions, excludeExtensionTools: run.excludeExtensionTools, mcp: run.mcp, privateEndpoints: run.privateEndpoints, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}), maxCostUsd: run.maxCostUsd, idleTimeoutMinutes: run.idleTimeoutMinutes, stallTimeoutMinutes: run.stallTimeoutMinutes, maxMinutes: run.maxMinutes, skillsDir: run.skillsDir, instructions: run.instructions, ...mergePolicy, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretFiles: run.secretFiles, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
			} else {
				// `reviewStates` is null rather than an empty Set when unnarrowed: the filter tests it for
				// presence, and an empty Set would read as "no verdict matches" and silently refuse everything.
				group.pullRequest.push({ index, actions: new Set(on.action), reviewStates: on.reviewState ? new Set(on.reviewState) : null, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, excludeExtensions: run.excludeExtensions, excludeExtensionTools: run.excludeExtensionTools, mcp: run.mcp, privateEndpoints: run.privateEndpoints, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}), maxCostUsd: run.maxCostUsd, idleTimeoutMinutes: run.idleTimeoutMinutes, stallTimeoutMinutes: run.stallTimeoutMinutes, maxMinutes: run.maxMinutes, skillsDir: run.skillsDir, instructions: run.instructions, ...mergePolicy, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretFiles: run.secretFiles, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
			}
		} else if (on.type === "issue") {
			// The close-trigger kind (issue #231). No predicate and no reviewStates by construction (the
			// loader refused both), and `number`/`once` ride conditionally-present exactly as the loader
			// normalized them -- the filter's close route reads them, nothing else does.
			group.issue.push({ index, actions: new Set(on.action), number: on.number, once: on.once, flow: run.flow, command: run.command, packages: run.packages, image: run.image, backend: run.backend, excludeTools: run.excludeTools, excludeExtensions: run.excludeExtensions, excludeExtensionTools: run.excludeExtensionTools, mcp: run.mcp, privateEndpoints: run.privateEndpoints, provider: run.provider, model: run.model, maxTurns: run.maxTurns, models: run.models, fallbackModels: run.fallbackModels, ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}), maxCostUsd: run.maxCostUsd, idleTimeoutMinutes: run.idleTimeoutMinutes, stallTimeoutMinutes: run.stallTimeoutMinutes, maxMinutes: run.maxMinutes, skillsDir: run.skillsDir, instructions: run.instructions, ...mergePolicy, resume: run.resume, awaitInput: run.awaitInput, ...(run.gates !== undefined ? { gates: run.gates, ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) } : {}), progress: run.progress, statusComment: run.statusComment, recover: run.recover, steer: run.steer, secrets: run.secrets, secretFiles: run.secretFiles, secretsProfile: run.secretsProfile, waitFor: run.waitFor, replicas: run.replicas });
		}
	}

	return { ...groups, knownFlows, ...(Object.keys(watchSources).length ? { watchSources, watch: parsed.filter(t => t.on.type === "watch") } : {}) };
}

function emptyGroup() {
	return { label: [], comment: null, pullRequest: [], issue: [], prClose: [] };
}
