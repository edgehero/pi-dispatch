import { randomUUID } from "node:crypto";
import { modelListProblem } from "./model-ref.mjs";
import { parseUsdMicros, optionalUsdMicros } from "./money.mjs";
import { MODEL_ROLE_RE } from "./model-roles.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";

/** A canary pays for fresh isolated runs, never for a modification to the role map. */
export function canaryOptions({ role, model, flow, count = 3, capUsd }) {
	if (typeof role !== "string" || !MODEL_ROLE_RE.test(role) || role === "inherit") throw new Error("--role must name a configured model role");
	if (modelListProblem([model]) !== null) throw new Error("--model must be provider/model");
	if (typeof flow !== "string" || !SKILL_NAME_RE.test(flow)) throw new Error("--flow must name a flow");
	if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 10) throw new Error("--count must be 1 to 10");
	const capMicros = parseUsdMicros(capUsd, "--cap-usd");
	return { role, model, flow, count: Number(count), capMicros };
}

export function selectCanarySources(records, options, { now, windowMs = 7 * 86400_000 }) {
	return records.filter((r) => r && !r.canary && r.modelRole === options.role && r.flow === options.flow && r.outcome === "completed" && typeof r.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(r.jobId) && Number.isFinite(Date.parse(r.endedAt)) && Date.parse(r.endedAt) <= now && Date.parse(r.endedAt) >= now - windowMs)
		.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.jobId.localeCompare(b.jobId)).slice(0, options.count);
}

/**
 * Allocate the whole experiment before starting. Unreported spend never buys another replay: each
 * original gets at most its fixed share, even if a prior container died without a trustworthy meter.
 * Every source is checked first, so an expired last source cannot strand a paid partial experiment.
 */
export async function executeCanary(options, { records, now = Date.now, inspectSource, execute, deploymentCapUsd = null, id = () => `canary-${randomUUID()}` }) {
	const originals = selectCanarySources(records, options, { now: now() });
	if (originals.length === 0) throw new Error("no completed jobs of this flow in the last seven days; run the flow with sandbox retention enabled first");
	const sources = [];
	for (const original of originals) sources.push(await inspectSource(original));
	const share = Math.floor(options.capMicros / sources.length);
	const perJob = Math.min(share, optionalUsdMicros(deploymentCapUsd, "maxCostUsd") ?? share);
	if (perJob < 1) throw new Error("the canary cap is too small to allocate one micro-dollar per job");
	const rows = [];
	for (let i = 0; i < sources.length; i++) {
		const jobId = id();
		const result = await execute({ source: sources[i], original: originals[i], jobId, options, maxCostMicros: perJob });
		rows.push({ sourceJobId: originals[i].jobId, jobId, original: { model: `${originals[i].provider}/${originals[i].model}`, outcome: originals[i].outcome, cost: originals[i].tokens?.cost ?? null }, candidate: { model: options.model, outcome: result.outcome, reason: result.reason ?? null, cost: result.tokens?.cost ?? null }, capMicros: perJob });
	}
	return { role: options.role, flow: options.flow, model: options.model, capMicros: options.capMicros, allocatedMicros: perJob * rows.length, whatIf: `/insights?whatif=${encodeURIComponent(options.model)}&flow=${encodeURIComponent(options.flow)}`, rows };
}

export function canaryText(report) {
	const money = (value) => typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "unknown";
	return [`Canary ${report.role}: ${report.model}, cap $${(report.capMicros / 1e6).toFixed(6)}`, "Original run | original cost / outcome | candidate run | candidate cost / outcome", ...report.rows.map((r) => `${r.sourceJobId} | ${money(r.original.cost)} / ${r.original.outcome} | ${r.jobId} | ${money(r.candidate.cost)} / ${r.candidate.outcome}${r.candidate.reason ? ` (${r.candidate.reason})` : ""}`), `What-if: ${report.whatIf}`, "The role map is unchanged. Workspaces are disposable; forge access is blocked.", ""].join("\n");
}
