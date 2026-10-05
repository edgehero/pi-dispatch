/**
 * The zero-spend provider smoke on a built job image (issue #587): a real job, through the image's own entrypoint,
 * with a well-formed but fake ANTHROPIC_API_KEY. It must reach Anthropic, be refused with a 401, be metered on every
 * method the meter wraps, exit 2 as `provider-auth-refused`, and cost $0. Once uncapped, and once under a dollar cap,
 * which shows the cost guard admits the default model and lets its call go out.
 *
 * WHY A REAL PROVIDER, and why it is free. Every other in-image check runs offline against a fake provider, which
 * proves the runner's wiring but not that the PINNED pi still reaches a real provider through the meter: a bump that
 * moved the request path past the meter, or broke the provider's client, looks identical to a quiet success offline.
 * Anthropic answers a bad key with a 401 before any token is generated, so the call is real and the bill is zero.
 * The key has the real key's shape and is not a key.
 *
 * WHEN IT FAILS FOR A REASON OUTSIDE THE IMAGE. A runner that cannot reach Anthropic at all (DNS, an outage, a
 * blocked egress) cannot tell us anything about the image, so the verdict is not read as one. After a failed run a
 * control fetch from the same image, with the same fake key, says which it was: if the control does not get
 * Anthropic's 401 either, the job fails with "infrastructure, re-run" (the canaries' doctrine: never a verdict from a
 * probe that did not run); if it does, the failure is the image's. It still FAILS in the infrastructure case rather than passing:
 * this runs in a required check, and a skipped proof that reads as green is the failure this workflow exists to
 * prevent. Only Anthropic's 401 to the control's own fake key counts as "reachable": a 5xx, a 529 or a 429 is the
 * provider's bad minute, not the image's.
 *
 * Usage: node .github/scripts/fake-key-smoke.mjs <image> [--changed <file of changed paths>]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_RESULT_METHODS, RUNTIME_STREAM_METHODS } from "../../image/runner/src/usage-meter.mjs";
import { BUMP_PATHS } from "./pi-bump.mjs";

/** Shaped like an Anthropic key (prefix, 93 characters, the AA tail) and not one. */
export const FAKE_KEY = `sk-ant-api03-${"0".repeat(93)}AA`;
export const MODEL = "claude-sonnet-4-5-20250929";
export const CAP_MICROS = "5000000";
/**
 * The control: the same fake key, sent by a plain fetch from the same image. Only Anthropic's 401 for it shows the
 * provider was reachable and answering keys. A 5xx, a 529 or a 429 is Anthropic having a bad minute, and a network
 * error is the runner's, so anything but a 401 makes the failure infrastructure.
 */
export const CONTROL = `fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(20000),
		headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
		body: JSON.stringify({ model: "${MODEL}", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) })
	.then((r) => { console.log("answered " + r.status); })
	.catch((e) => { console.log("unreachable " + (e.cause?.code ?? e.name)); process.exit(3); });`;

/** The JSON lines a run printed, by event. */
export function events(output) {
	const lines = [];
	for (const line of output.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// a line of something else that happened to start with a brace
		}
	}
	return { meter: lines.find((l) => l.event === "usage_meter"), exit: lines.findLast((l) => l.event === "exit") };
}

/** What is wrong with one smoke run, as sentences; [] when it holds. */
export function smokeProblems(output, { piVersion, capped }) {
	const { meter, exit } = events(output);
	const problems = [];
	if (!meter) problems.push("no usage_meter line: the meter never reported installing");
	else {
		if (meter.ok !== true) problems.push(`usage_meter ok is ${JSON.stringify(meter.ok)}, not true`);
		const want = [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS].sort();
		if (JSON.stringify([...(meter.methods ?? [])].sort()) !== JSON.stringify(want)) problems.push(`the meter wrapped ${JSON.stringify(meter.methods)}, not every method (${want.join(", ")})`);
		if (meter.compat !== "pi") problems.push(`the meter's compat half is ${JSON.stringify(meter.compat)}, not pi's own pi-ai`);
		if (meter.costCapped !== capped) problems.push(`costCapped is ${meter.costCapped}, want ${capped}`);
	}
	if (!exit) return [...problems, "no exit line: the runner did not finish"];
	if (exit.code !== 2 || exit.reason !== "provider-auth-refused") problems.push(`exit ${exit.code} ${exit.reason}, want 2 provider-auth-refused (${String(exit.message ?? "").slice(0, 200)})`);
	else if (!/\b401\b/.test(String(exit.message))) problems.push(`the refusal is not Anthropic's 401: ${String(exit.message).slice(0, 200)}`);
	if (!(exit.tokens?.calls >= 1)) problems.push(`calls is ${exit.tokens?.calls}: the call never reached the meter`);
	if (exit.tokens?.cost !== 0 || (exit.usage?.models ?? []).some((m) => m.cost !== 0)) problems.push(`the run cost ${exit.tokens?.cost}, not $0`);
	if (exit.usage?.piAi !== piVersion) problems.push(`the run used pi-ai ${exit.usage?.piAi}, not the pin ${piVersion}`);
	if (capped && exit.tokens?.costRefused !== 0) problems.push(`the cost guard refused ${exit.tokens?.costRefused} call(s) of the default model under a $5 cap`);
	return problems;
}

/** Runs docker, returning its combined output and status. The seam the test replaces. */
function defaultDocker(args) {
	const run = spawnSync("docker", args, { encoding: "utf8", timeout: 300_000 });
	return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/**
 * Both runs and, when one fails, the control. Returns { ok, infra, report } and never throws on a verdict.
 */
export function smoke({ image, piVersion, docker = defaultDocker, jobDir }) {
	const report = [];
	let failed = false;
	for (const capped of [false, true]) {
		const args = ["run", "--rm", "-v", `${jobDir}:/job:ro`, "-e", "PI_PROVIDER=anthropic", "-e", `PI_MODEL=${MODEL}`, "-e", "PI_MAX_TURNS=1", "-e", `ANTHROPIC_API_KEY=${FAKE_KEY}`];
		if (capped) args.push("-e", `PI_MAX_COST_MICROS=${CAP_MICROS}`);
		const { output } = docker([...args, image]);
		const problems = smokeProblems(output, { piVersion, capped });
		const label = capped ? `capped at ${CAP_MICROS} micros` : "uncapped";
		const { exit } = events(output);
		if (problems.length === 0) report.push(`OK (${label}): reached Anthropic, 401, exit 2 provider-auth-refused, ${exit.tokens.calls} call(s) metered, $0, pi-ai ${exit.usage.piAi}`);
		else {
			failed = true;
			report.push(`FAILED (${label}):`, ...problems.map((p) => `  - ${p}`), "  last lines:", ...output.trim().split("\n").filter((l) => l.trim() !== "").slice(-6).map((l) => `    ${l.slice(0, 400)}`));
		}
	}
	if (!failed) return { ok: true, infra: false, report };
	const control = docker(["run", "--rm", "-e", `ANTHROPIC_API_KEY=${FAKE_KEY}`, "--entrypoint", "node", image, "-e", CONTROL]);
	const reached = /^answered 401$/m.test(control.output);
	report.push(`control fetch from the image: ${control.output.trim().split("\n").pop() ?? "(no output)"}`);
	return { ok: false, infra: !reached, report };
}

/**
 * The paths whose change can move what this smoke proves: every pi pin site, the lockfile, the image, and this script.
 * pi-bump.mjs's table is the list of pin sites, so a site added there is a site that triggers the smoke here.
 */
export const SMOKE_PATHS = Object.freeze([...BUMP_PATHS, "image/", ".github/scripts/fake-key-smoke.mjs"]);

/**
 * Whether the smoke runs, or why not. It reaches a real provider, so a pull request that cannot move the result (a docs
 * change, a worker fix) does not pay its minute or its exposure to Anthropic's weather in a REQUIRED job; the job
 * still reports, green, with the reason. A push to main, the schedule and a manual run always run it, and so does
 * the pi bump's own branch.
 */
export function smokeWanted({ event, headRef, changed }) {
	if (event !== "pull_request") return { run: true, why: `a ${event} always runs the smoke` };
	if (headRef === "chore/pi-bump") return { run: true, why: "the pi bump's pull request" };
	const hit = changed.find((path) => SMOKE_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)));
	return hit ? { run: true, why: `the pull request changes ${hit}` } : { run: false, why: "the pull request changes no pi pin, lockfile, image or smoke file" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--changed");
	const changedFile = at >= 0 ? args.splice(at, 2)[1] : null;
	const image = args[0];
	if (!image) {
		console.error("usage: node .github/scripts/fake-key-smoke.mjs <image> [--changed <file of changed paths>]");
		process.exit(2);
	}
	const wanted = smokeWanted({ event: process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch", headRef: process.env.GITHUB_HEAD_REF ?? "", changed: changedFile ? readFileSync(changedFile, "utf8").split("\n").filter(Boolean) : [] });
	console.log(`${wanted.run ? "running" : "skipped"}: ${wanted.why}`);
	if (!wanted.run) process.exit(0);
	const piVersion = JSON.parse(readFileSync(new URL("../../image/runner/package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
	const jobDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "pd-smoke-"));
	let result;
	try {
		writeFileSync(join(jobDir, "prompt.md"), "Reply with the single word ok.\n");
		chmodSync(jobDir, 0o755);
		chmodSync(join(jobDir, "prompt.md"), 0o644);
		result = smoke({ image, piVersion, jobDir });
	} finally {
		rmSync(jobDir, { recursive: true, force: true });
	}
	for (const line of result.report) console.log(line);
	if (result.ok) process.exit(0);
	if (result.infra) console.error("::error::a plain fetch from the image with the same fake key did not get Anthropic's 401 either (a network error, a 5xx, a 529 or a 429): an infrastructure failure, not a verdict on the image. Re-run before reading anything into it.");
	else console.error("::error::a fake-key job in the built image did not reach Anthropic, get its 401, and stay metered at $0, while a plain fetch from the image with the same key got Anthropic's 401. The image is at fault: read the problems above.");
	process.exit(1);
}
