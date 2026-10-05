#!/usr/bin/env node
/**
 * The portfolio manager's report (issue #506): what this run REQUESTED, what the last plan met, and what each project
 * has spent. It reads the snapshot (`/job/portfolio.json`) and the plan this run wrote (`/outbox/priorities.json`) and
 * posts one short markdown report to the operator's own channel. Node only, no dependencies: the job image has Node
 * and `gh`, and nothing is installed at run time.
 *
 * WHY IT SAYS "REQUESTED" AND NEVER "APPLIED". The host judges the plan after the job ends, so this run cannot know
 * whether it applied, was clamped or was refused. The next run's snapshot carries the answer as `lastAttempt`, and the
 * report opens with it. A report that claimed the split it asked for would be wrong exactly when it matters: on a
 * refusal.
 *
 * WHY THE EXIT CODE IS ALWAYS 0. The plan in `/outbox` is collected only after a completed exit. A report that failed
 * the job over a dead webhook would throw the plan away with it. A failed post prints `report-not-sent: <reason>`, a
 * fixed token that never quotes the URL (a webhook URL is a credential) or a server's answer.
 *
 * The channel, first configured wins:
 *   - GitHub: `REPORT_GH_TOKEN` set, and `report-repo` and `report-issue` in the front matter of priorities.md.
 *     Runs `gh issue comment <n> --repo <owner/name> --body-file -` with `GH_TOKEN` set to that token for gh alone.
 *   - A webhook: `REPORT_WEBHOOK_URL` set. POSTs `{ "text": <markdown> }`, the body Slack, Mattermost and Discord's
 *     Slack-compatible endpoint accept. Change `webhookBody` below for another shape.
 *
 * Options: `--dry-run` prints the report and posts nothing; `--snapshot`, `--plan` and `--priorities` name other
 * files (for a test on your own machine).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_PATH = "/job/portfolio.json";
export const PLAN_PATH = "/outbox/priorities.json";
export const PRIORITIES_PATH = "/workspace/priorities.md";
/** How long one post may take before it is given up. */
export const POST_TIMEOUT_MS = 30_000;
/**
 * The plan fields a refusal can name, a copy of `PLAN_FIELDS` in worker/src/priorities.mjs (this script runs in the
 * job, where the worker's modules are not). worker/test/portfolio-report.test.mjs pins the two lists equal.
 */
export const PLAN_FIELDS = Object.freeze(["body", "plan", "version", "basis", "validUntil", "projects", "projects.id", "projects.weight", "projects.reason", "projects.repos", "projects.repos.ref", "projects.repos.weight"]);
/** The hosts a plain `http:` webhook may name: this machine only. Anywhere else the URL, a credential, would cross a network in clear. */
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "[::1]", "localhost"]);

// owner/name, each starting with a letter or a digit: gh reads an argument that starts with `-` as an option.
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ISSUE_RE = /^[1-9][0-9]{0,9}$/;
const TOKEN_RE = /^[a-z][a-z0-9.-]{0,63}$/;
// A project id (`_other` included) or a plan id: what the snapshot holds in those fields.
const ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
// Every control, format, surrogate, private-use and unassigned character, and the line and paragraph separators:
// each can change what a reader sees. Agent text (a plan reason) is shown only after this gate.
const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
const REASON_MAX = 200;

/** Micro-dollars as dollars and cents, or `n/a` for a value that is not one. */
export function dollars(micros) {
	if (!Number.isSafeInteger(micros) || micros < 0) return "n/a";
	const cents = Math.round(micros / 10_000);
	return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Text for one table cell: unsafe characters become spaces, at most 200 characters, inside a code span. */
export function cell(value) {
	const text = [...String(value ?? "").replace(UNSAFE_RE, " ").replace(/\s+/g, " ").trim()].slice(0, REASON_MAX).join("");
	// A code span keeps a reason from mentioning people, linking or rendering HTML. A backtick would end the span and
	// a pipe would end the cell, so both are replaced.
	// `<` and `>` are replaced too: inside `{ "text" }`, Slack reads `<!here>` as a mention and `<url|text>` as a
	// link even in a code span.
	return text === "" ? "" : `\`${text.replace(/`/g, "'").replace(/</g, "\u2039").replace(/>/g, "\u203a").replace(/\|/g, "\\|")}\``;
}

/** A plain enum token from the snapshot, or `?` for anything else. */
function token(value) {
	return typeof value === "string" && TOKEN_RE.test(value) ? value : "?";
}

/** A plan field a refusal named, from the fixed list, or `?` for anything else. */
function field(value) {
	return typeof value === "string" && PLAN_FIELDS.includes(value) ? value : "?";
}

/** A project id or a plan id from the snapshot, or `?` for anything else. */
function id(value) {
	return typeof value === "string" && ID_RE.test(value) ? value : "?";
}

/** The key: value lines of a leading `---` block. Nothing else of the file is read. */
export function frontMatter(text) {
	const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? "").replace(/^\uFEFF/, ""));
	const out = {};
	if (!block) return out;
	for (const line of block[1].split(/\r?\n/)) {
		const m = /^([a-z][a-z0-9-]*):\s*(.*?)\s*$/.exec(line);
		if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

/** The first line: what the last plan of this trigger met, from `snapshot.lastAttempt`. */
function lastPlanLine(snapshot, snapshotProblem) {
	if (!snapshot) return `Last plan: unknown (${snapshotProblem})`;
	const last = snapshot.lastAttempt;
	if (!last) return "Last plan: none yet";
	const outcome = token(last.outcome);
	if (outcome === "applied") return "Last plan: applied";
	if (outcome === "refused" || last.reason) {
		const detail = last.field ? `${token(last.reason)}: ${field(last.field)} ${token(last.rule)}` : token(last.reason);
		return `Last plan: ${outcome} (${detail})`;
	}
	return `Last plan: ${outcome}`;
}

/**
 * The split in force now, from `snapshot.plan`. `plan.writer` is the split's LAST writer. A re-base keeps the plan's id
 * and weights and only moves the amounts onto a changed envelope, so `envelope-change` with a plan is said as a
 * re-base: "from envelope-change" read as if the envelope change had written the plan (issue #507).
 */
function inForceLine(snapshot) {
	if (!snapshot) return "In force: unknown without a snapshot.";
	const plan = snapshot.plan;
	if (!plan) return "In force: the neutral split (the envelope's default weights).";
	const by = plan.writer === "envelope-change" ? "re-based onto a changed envelope" : `from ${token(plan.writer)}`;
	const parts = [`In force: plan ${id(plan.id)} ${by}`];
	if (plan.appliedAt) parts.push(`since ${instant(plan.appliedAt)}`);
	if (plan.validUntil) parts.push(`until ${instant(plan.validUntil)}`);
	return `${parts.join(", ")}${plan.clamped ? ", clamped by the step limit" : ""}.`;
}

/** An ISO instant from the snapshot, or `?`. */
function instant(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ? value : "?";
}

/** The plan section: what this run asked for, or why it asked for nothing. */
function requestedSection(plan, planError) {
	const lines = ["## Requested this week", ""];
	if (planError) {
		lines.push(`Nothing requested: ${planError}.`);
		return lines;
	}
	const projects = Array.isArray(plan?.projects) ? plan.projects : null;
	if (!projects) {
		lines.push("Nothing requested: the plan file has no projects list.");
		return lines;
	}
	lines.push("The host judges this request after the job ends. The next report says what it met.", "");
	lines.push("| Project | Weight | Reason |", "|---|---:|---|");
	for (const p of projects) {
		const weight = Number.isInteger(p?.weight) ? String(p.weight) : "?";
		lines.push(`| ${cell(p?.id)} | ${weight} | ${cell(p?.reason)} |`);
	}
	return lines;
}

/** The spend section: per project, spent in the window, its share and its floor, from the snapshot. */
function spendSection(snapshot, snapshotProblem) {
	if (!snapshot) return ["## Spend so far", "", `Unknown: ${snapshotProblem}.`];
	const w = snapshot.window ?? {};
	const lines = [`## Spend so far (${token(w.kind)} from ${String(w.start ?? "?").replace(/[^0-9-]/g, "")})`, ""];
	lines.push("| Project | Spent | Share | Floor |", "|---|---:|---:|---:|");
	let spent = 0;
	for (const p of Array.isArray(snapshot.projects) ? snapshot.projects : []) {
		if (Number.isSafeInteger(p?.spentMicros)) spent += p.spentMicros;
		lines.push(`| ${id(p?.id)} | ${dollars(p?.spentMicros)} | ${dollars(p?.allocationMicros)} | ${dollars(p?.floorMicros)} |`);
		for (const m of Array.isArray(p?.members) ? p.members : []) {
			if (!Number.isInteger(m?.weight)) continue;
			lines.push(`| ${id(p?.id)} ${cell(m.label)} | ${dollars(m.spentMicros)} | ${dollars(m.allocationMicros)} | |`);
		}
	}
	lines.push("", `Total spent ${dollars(spent)} of ${dollars(snapshot.envelope?.totalMicros)}.`);
	if (snapshot.fleet?.runsComplete !== true) lines.push("Run counts in the snapshot cover this host only.");
	return lines;
}

/**
 * The report text. `snapshot` and `plan` are parsed objects or null; `snapshotProblem` and `planError` say why one is
 * missing; `now` is the clock (a Date). The first line is always `Last plan: ...`.
 */
export function buildReport({ snapshot = null, snapshotProblem = "no snapshot: is run.portfolio set?", plan = null, planError = null, now }) {
	const lines = [lastPlanLine(snapshot, snapshotProblem), "", inForceLine(snapshot), "", ...requestedSection(plan, planError), "", ...spendSection(snapshot, snapshotProblem)];
	lines.push("", `Written ${now.toISOString()} by the portfolio-manager flow.`);
	return `${lines.join("\n")}\n`;
}

/** The webhook body. Slack's `{ "text" }`; change it here for an endpoint that wants another shape. */
export function webhookBody(text) {
	return JSON.stringify({ text });
}

/** The channel to post to, or `{ problem }` when one is half configured, or null when none is. */
export function pickChannel(env, front) {
	if (env.REPORT_GH_TOKEN) {
		const repo = front["report-repo"];
		const issue = front["report-issue"];
		if (repo || issue) {
			if (!REPO_RE.test(repo ?? "") || !ISSUE_RE.test(issue ?? "")) return { problem: "report-repo-invalid" };
			return { kind: "github", repo, issue };
		}
	}
	if (env.REPORT_WEBHOOK_URL) {
		let url;
		try {
			url = new URL(env.REPORT_WEBHOOK_URL);
		} catch {
			return { problem: "webhook-url-invalid" };
		}
		if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) return { problem: "webhook-url-invalid" };
		return { kind: "webhook", url: url.href };
	}
	return null;
}

/** Post with gh. Resolves to null when sent, or a reason token. */
function postGithub({ repo, issue }, text, { env, spawn, timeoutMs }) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (reason) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(reason);
		};
		let child;
		try {
			// GH_TOKEN is set for this one gh call only. It is a reserved forge token name, so the trigger binds the
			// token as REPORT_GH_TOKEN, and the job never holds a GH_TOKEN of its own.
			child = spawn("gh", ["issue", "comment", issue, "--repo", repo, "--body-file", "-"], { env: { ...env, GH_TOKEN: env.REPORT_GH_TOKEN }, stdio: ["pipe", "ignore", "ignore"] });
		} catch {
			resolve("gh-not-started");
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish("gh-timeout");
		}, timeoutMs);
		child.on("error", (error) => finish(error?.code === "ENOENT" ? "gh-missing" : "gh-not-started"));
		child.on("close", (code) => finish(code === 0 ? null : `gh-exit-${code ?? "signal"}`));
		child.stdin.on("error", () => {});
		child.stdin.end(text);
	});
}

/** POST to the webhook. Resolves to null when sent, or a reason token. Never quotes the URL or the answer. */
async function postWebhook({ url }, text, { fetch, timeoutMs }) {
	try {
		// No redirect is followed: a 3xx would carry the report, and the request, to a host nobody configured.
		const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: webhookBody(text), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
		await res.arrayBuffer().catch(() => {});
		return res.ok ? null : `webhook-status-${res.status}`;
	} catch (error) {
		return error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError" ? "webhook-timeout" : "webhook-error";
	}
}

/** A JSON file, or `{ missing }` / `{ error }`. */
function readJson(path, readFile) {
	let text;
	try {
		text = readFile(path, "utf8");
	} catch (error) {
		return error?.code === "ENOENT" ? { missing: true } : { error: "unreadable" };
	}
	try {
		return { value: JSON.parse(text) };
	} catch {
		return { error: "not valid JSON" };
	}
}

function option(argv, name, fallback) {
	const at = argv.indexOf(name);
	return at >= 0 && typeof argv[at + 1] === "string" ? argv[at + 1] : fallback;
}

/**
 * Build, print and post the report. Returns the exit code, which is 0 on every path: see the header. Every input is
 * injectable: `env`, `now`, `readFile`, `spawn` (gh), `fetch` (the webhook), `out` (stdout lines) and `timeoutMs`
 * (how long one post may take).
 */
export async function main(argv = process.argv.slice(2), { env = process.env, now = () => new Date(), readFile = readFileSync, spawn = nodeSpawn, fetch = globalThis.fetch, out = (line) => process.stdout.write(line), timeoutMs = POST_TIMEOUT_MS } = {}) {
	try {
		const snap = readJson(option(argv, "--snapshot", SNAPSHOT_PATH), readFile);
		const snapshot = snap.value && typeof snap.value === "object" && !Array.isArray(snap.value) ? snap.value : null;
		const snapshotProblem = snap.missing ? "no snapshot: is run.portfolio set?" : `the snapshot is ${snap.error ?? "not an object"}`;
		const read = readJson(option(argv, "--plan", PLAN_PATH), readFile);
		const planError = read.missing ? "no plan file was written" : read.error ? `the plan file is ${read.error}` : read.value && typeof read.value === "object" ? null : "the plan file is not an object";
		const text = buildReport({ snapshot, snapshotProblem, plan: planError ? null : read.value, planError, now: now() });
		out(text);
		if (argv.includes("--dry-run")) return 0;

		let front = {};
		try {
			front = frontMatter(readFile(option(argv, "--priorities", PRIORITIES_PATH), "utf8"));
		} catch {
			// No priorities file: no GitHub channel, the webhook may still be set.
		}
		const channel = pickChannel(env, front);
		if (!channel) {
			out("report-not-sent: no-channel\n");
			return 0;
		}
		if (channel.problem) {
			out(`report-not-sent: ${channel.problem}\n`);
			return 0;
		}
		const reason = channel.kind === "github" ? await postGithub(channel, text, { env, spawn, timeoutMs }) : await postWebhook(channel, text, { fetch, timeoutMs });
		out(reason === null ? `report-sent: ${channel.kind}\n` : `report-not-sent: ${reason}\n`);
		return 0;
	} catch {
		// Even the line saying so must not throw: an exit code other than 0 throws the plan away.
		try {
			out("report-not-sent: report-error\n");
		} catch {
			// Nothing left to tell anyone.
		}
		return 0;
	}
}

function isMain() {
	try {
		return typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isMain()) process.exitCode = await main();
