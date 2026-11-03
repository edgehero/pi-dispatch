/**
 * The operator console images the READMEs show, each a state the console's goldens already draw
 * (`admin/test/fixtures/console/`), and the transcript the live run page shows them with. Only these are committed, to
 * `docs/images/console/`: `render-images.mjs --console --all` renders every golden at both widths and themes on demand,
 * which is 1,944 images and would weigh down every clone for good.
 *
 * A pick is `{ name, golden, width, theme, height, selector, scale, transcript }`. The theme defaults to light, the width
 * to 1440 and the scale to 1.5. `height` keeps the top of the page, `selector` keeps one element, and neither keeps the
 * whole page. `transcript` names the run whose stream gets the canned entries below (the page's `/api/events` asks by run id).
 */
import { NOW } from "./fixture-deployment.mjs";

const SEC = 1000;
const MIN = 60 * SEC;

export const CONSOLE_PICKS = Object.freeze([
	{ name: "console-overview", golden: "overview.operator", height: 1180 },
	{ name: "console-overview-dark", golden: "overview.operator", height: 1180, theme: "dark" },
	{ name: "console-overview-phone", golden: "overview.operator", width: 375, height: 1500, scale: 2 },
	{ name: "console-run-live", golden: "panels/run-live-armed.operator", height: 1500, transcript: "gh-b3d7" },
	{ name: "console-steer-confirm", golden: "panels/run-steer-confirm.operator", selector: "#confirm-slot" },
	{ name: "console-question", golden: "panels/run-parked-question.operator", height: 975, transcript: "gh-2f6a" },
	{ name: "console-zero-touch", golden: "zero-touch.operator", height: 1000 },
	{ name: "console-setup", golden: "panels/setup-starting.operator", height: 1240 },
	{ name: "console-spend", golden: "insights.operator", height: 1100 },
	{ name: "console-fleet", golden: "fleet.operator", height: 1000 },
	{ name: "console-trigger", golden: "trigger.operator", height: 1000 },
	{ name: "console-budget-split", golden: "insights-budget-split.operator", height: 1000 },
	{ name: "console-capacity", golden: "insights-capacity.operator", height: 1000 },
	{ name: "console-flows", golden: "panels/spend-flows-map.viewer", height: 1000 },
	{ name: "console-models", golden: "panels/models-populated.operator", height: 1040 },
	{ name: "console-watch", golden: "watch.operator", height: 800 },
	{ name: "console-audit", golden: "audit.operator", height: 800 },
	{ name: "console-config", golden: "config.operator", height: 1000 },
	{ name: "console-subscription", golden: "panels/models-subscription.operator", selector: "#p-subscription-quota" },
	{ name: "console-approval", golden: "panels/parked-approval.operator", height: 780 },
	{ name: "console-draft", golden: "panels/answerer-populated.operator", height: 1160 },
	{ name: "console-recovery", golden: "panels/run-recovering.operator", height: 1000 },
	{ name: "console-sandboxes", golden: "panels/sandboxes-populated.operator", height: 1000 },
	{ name: "console-updates", golden: "panels/updates-newer-available.operator", height: 920 },
	{ name: "console-project", golden: "panels/project-populated.operator", height: 960 },
]);

/**
 * What each pick's run has said, by run id, as `readTranscriptSince` hands it to the page. A question is the agent's own
 * words, so its options are text: a flow asks for them in its instructions, and the person answers in the box.
 */
export const CONSOLE_TRANSCRIPT = Object.freeze({
	"gh-b3d7": Object.freeze([
	{ id: "1", kind: "user", ts: NOW - 12 * MIN, text: "Migrate the billing tables to the new schema. Keep the old columns until every reader has moved." },
	{ id: "2", kind: "assistant", ts: NOW - 11 * MIN, text: "I will survey the ten tables first, then migrate them one at a time and run the tests after each." },
	{ id: "3", kind: "tool-call", ts: NOW - 10 * MIN, tool: "read", text: JSON.stringify({ path: "db/schema.sql" }) },
	{ id: "4", kind: "tool-result", ts: NOW - 10 * MIN + 2 * SEC, tool: "read", text: "CREATE TABLE invoices (...)\nCREATE TABLE payments (...)" },
	{ id: "5", kind: "tool-call", ts: NOW - 2 * MIN, tool: "bash", text: JSON.stringify({ command: "npm test -- db/migrations" }) },
	{ id: "6", kind: "tool-result", ts: NOW - 2 * MIN + 40 * SEC, tool: "bash", error: true, text: "1 failed: payments keeps its old column until the reader moves" },
	{ id: "7", kind: "steer", ts: NOW - 70 * SEC, text: "Leave the payments reader for a later pull request, and say so in this one." },
	{ id: "8", kind: "assistant", ts: NOW - 60 * SEC, text: "Understood. Three of ten tables are migrated. I will skip the payments reader and note it in the pull request." },
	{ id: "9", kind: "tool-call", ts: NOW - 40 * SEC, tool: "bash", text: JSON.stringify({ command: "npm test -- db/migrations/orders" }) },
	]),
	"gh-2f6a": Object.freeze([
		{ id: "1", kind: "user", ts: NOW - 52 * MIN, text: "Issue acme/api#131: customers see a failed payment when the new rate limit is hit during checkout." },
		{ id: "2", kind: "tool-call", ts: NOW - 44 * MIN, tool: "read", text: JSON.stringify({ path: "src/checkout/retry.ts" }) },
		{ id: "3", kind: "tool-result", ts: NOW - 44 * MIN + 2 * SEC, tool: "read", text: "export async function retryPayment(order) { ... }" },
		{
			id: "4",
			kind: "assistant",
			ts: NOW - 26 * MIN,
			text: "I found the cause, and there are three ways to fix it. The choice changes what customers see, so I am asking rather than guessing.\n\nCheckout retries a failed payment at once, and the new rate limit blocks those retries for 60 seconds.\n\nA. Exempt payment retries from the limit. About 10 lines. Customers see no difference, but a client stuck in a loop could still hammer the API.\nB. Queue retries until the limit resets. About 80 lines. The safest for the API, but a retry can take up to a minute.\nC. Leave it and show a clear error. No code to speak of, but some customers will see a failed payment.\n\nI recommend A, with its own small limit on retries. Reply with A, B or C, or tell me what I have missed.",
		},
	]),
});
