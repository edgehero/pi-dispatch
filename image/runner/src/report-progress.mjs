/**
 * Issue #644: the tool a job armed with `run.progress` reports its plan's progress with.
 *
 * The agent names the phase it is in, and optionally how far through it is (`done` of `total`) and a short note.
 * The tool does nothing else: it validates the arguments and answers "recorded". What it reports lives only in the
 * transcript, where the worker's progress reducer reads the call (and its result: an error result is ignored). No
 * file, no network, no state here, and no `terminate`, so the loop goes on exactly as it would without the call.
 *
 * Progress is advisory and forgeable: the agent can write anything here, and it never feeds a decision. The phase
 * name and note are model text, so the worker redacts them and shows them to the operator only, never on a forge.
 *
 * An inline extension like await-input.mjs, for the same reasons (the loader's `extensionFactories`, no new
 * createAgentSession option). Its name is reserved the same way: another extension that registers a tool of the
 * same name would answer the calls the worker reads, so run-job refuses that before the prompt
 * (reportProgressShadow) and the tool_call hook blocks it after.
 */

export const REPORT_PROGRESS_TOOL = "report_progress";
export const REPORT_PROGRESS_FACTORY = "job-report-progress";
export const PHASE_MAX = 64;
export const NOTE_MAX = 200;

const OURS = `<inline:${REPORT_PROGRESS_FACTORY}>`;

const DESCRIPTION = [
	"Report where you are in your work, so the person who started this job can follow it.",
	"Call it when you start a new phase of your plan, and when you finish a countable part of one.",
	`\`phase\` is a short name for the current phase (1 to ${PHASE_MAX} characters); use the same name each time you report on`,
	"the same phase. `done` and `total` count the parts of the phase, when it has countable parts.",
	`\`note\` is an optional short remark (up to ${NOTE_MAX} characters). The tool only records the report; it changes nothing`,
	"and the run goes on.",
].join(" ");

// The schema pi validates against before execute (agent-loop.js prepareToolCall). Lengths are counted in code
// points, which a JSON schema maxLength does not promise, so execute holds them and the cross-field rule.
const PARAMETERS = {
	type: "object",
	properties: {
		phase: { type: "string", minLength: 1, description: `the current phase's short name, 1 to ${PHASE_MAX} characters` },
		done: { type: "integer", minimum: 0, description: "the parts of this phase finished so far" },
		total: { type: "integer", minimum: 1, description: "the parts this phase has in all" },
		note: { type: "string", description: `an optional short remark, up to ${NOTE_MAX} characters` },
	},
	required: ["phase"],
	additionalProperties: false,
};

const KEYS = new Set(["phase", "done", "total", "note"]);
const codePoints = (text) => [...text].length;
const count = (value, min) => Number.isSafeInteger(value) && value >= min;

/** Why the arguments are refused, or null when they are a valid report. Pure, so the tests pin every edge. */
export function progressArgsError(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return "the arguments must be an object";
	for (const key of Object.keys(args)) if (!KEYS.has(key)) return `unknown argument ${JSON.stringify(key)}`;
	const { phase, done, total, note } = args;
	if (typeof phase !== "string" || phase.trim() === "") return "phase must be a non-empty string";
	if (codePoints(phase) > PHASE_MAX) return `phase must be at most ${PHASE_MAX} characters`;
	if (done !== undefined && !count(done, 0)) return "done must be a whole number of 0 or more";
	if (total !== undefined && !count(total, 1)) return "total must be a whole number of 1 or more";
	if (done !== undefined && total !== undefined && done > total) return "done must not be more than total";
	if (note !== undefined && typeof note !== "string") return "note must be a string";
	if (note !== undefined && codePoints(note) > NOTE_MAX) return `note must be at most ${NOTE_MAX} characters`;
	return null;
}

/** The factory to hand the loader. No state: what the agent reported is read from the transcript, by the worker. */
export function createReportProgress() {
	const factories = [
		{
			name: REPORT_PROGRESS_FACTORY,
			factory: (api) => {
				api.registerTool({
					name: REPORT_PROGRESS_TOOL,
					label: "report progress",
					description: DESCRIPTION,
					promptSnippet: "report the phase of your plan you are in, and how far through it you are",
					parameters: PARAMETERS,
					async execute(_toolCallId, args) {
						const error = progressArgsError(args);
						// An error result, not a throw: the same isError the worker's reducer skips, without a stack in the transcript.
						if (error !== null) return { content: [{ type: "text", text: `not recorded: ${error}` }], details: {}, isError: true };
						return { content: [{ type: "text", text: "recorded" }], details: {} };
					},
				});
				// Held at every call, as in await-input.mjs: a later registration of the name is refused its call.
				api.on("tool_call", (event) => {
					if (event.toolName !== REPORT_PROGRESS_TOOL) return undefined;
					const tool = api.getAllTools().find((candidate) => candidate.name === REPORT_PROGRESS_TOOL);
					if (tool && tool.sourceInfo?.path !== OURS) return { block: true, reason: `${REPORT_PROGRESS_TOOL} is the job's own tool, and another extension registered it` };
					return undefined;
				});
			},
		},
	];
	return { factories };
}

/** The reserved name, when an extension other than ours registered it, else null. awaitInputShadow's shape. */
export function reportProgressShadow(tools) {
	for (const tool of tools) if (tool.name === REPORT_PROGRESS_TOOL && tool.sourceInfo?.path !== OURS) return tool.name;
	return null;
}
