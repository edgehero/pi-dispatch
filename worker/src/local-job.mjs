/** Reviewed local execution fields shared by schedules and event commands (#911). Never accept an event subset here. */
export function localRunData(run) {
	return {
		kind: "local", folder: run.folder, flow: run.flow, task: run.task,
		...(run.command !== undefined && { command: run.command }),
		provider: run.provider, model: run.model, maxTurns: run.maxTurns,
		github: run.github, packages: run.packages, image: run.image,
		...Object.fromEntries([
			"backend", "excludeTools", "excludeExtensions", "excludeExtensionTools", "mcp", "models", "fallbackModels", "modelSelection",
			"maxCostUsd", "idleTimeoutMinutes", "stallTimeoutMinutes", "maxMinutes", "skillsDir", "secrets", "secretsProfile", "secretBundle",
		].filter((key) => run[key] !== undefined).map((key) => [key, run[key]])),
		resume: run.resume,
		...(run.portfolio !== undefined && { portfolio: run.portfolio }),
		...(run.progress === true && { progress: true }),
		...(run.steer === true && { steer: true }),
		...(run.worker !== undefined && { worker: run.worker }),
	};
}
