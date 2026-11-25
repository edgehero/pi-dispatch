/**
 * Offline proof of the `subscriptionChildren` capability (issue #1098) against the image's own runner code: a separate
 * pi process, started as a job's tool would start one (the pinned pi CLI, with the runner's preload and child ledger in
 * its environment, as openChildLedger leaves them), uses the job's subscription through an admission of its OWN. The
 * preload puts the child meter first (child-preload.mjs); the meter verifies the subscription entries, installs the
 * credential and registration guards before any other extension registers a provider, seals once the session's runtime
 * exists, and hands its model guard the admission (usage-meter.mjs startChildMeter `admit`). Its ledger then shows the
 * call, and the runner's fold, with the job's notional set, takes it as notional: no charge against the cap, part of
 * `costNotional` and of what the subscription allowance judges.
 *
 * No provider, no real credential, no network: the access token is a fake string, and every request is answered in the
 * child (fixtures/offline-fetch.mjs, which also refuses every outbound socket). Run directly, as the image's conformance
 * script runs it, it proves an OpenAI subscription child, which needs no staged package; the repository's tests prove a
 * staged Anthropic adapter's too, from the runner tests' own fixture of it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerIdentity } from "../../src/child-route.mjs";
import { PRELOAD_FLAG } from "../../src/child-watch.mjs";
import { CHILD_LEDGER_NAME, createUsageMeter, foldChildLedgers, parseChildLedger } from "../../src/usage-meter.mjs";

export const OPENAI_MODEL = "openai/gpt-4.1";
export const ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-5-20250929";
const CLI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const OFFLINE = fileURLToPath(new URL("./offline-fetch.mjs", import.meta.url));

/**
 * One real pi child, in `root`. `entry` is the subscription entry (null for a job with none), `model` what the child is
 * asked to run on, `allowed` the job's model list, `extensions` files the spawner hands the child (`-e`, after the
 * preload's own). Resolves with the exit code, the child's last answer, its parsed ledger, the fold of its ledger
 * directory under the job's `notional` set (and with none, for the control), and the requests it sent.
 */
export async function subscriptionPiChild({ root, entry, model = OPENAI_MODEL, allowed = [model], extensions = [], notional = null, extraEnv = {}, timeoutMs = 60_000 }) {
	const ledger = join(root, "ledger");
	for (const dir of [join(root, "home"), join(root, "agent"), join(root, "work")]) mkdirSync(dir, { recursive: true });
	mkdirSync(ledger, { mode: 0o700 });
	const requests = join(root, "requests.jsonl");
	writeFileSync(requests, "");
	const env = {
		PATH: process.env.PATH,
		HOME: join(root, "home"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		// What openChildLedger leaves in a job's environment for every descendant.
		PI_DISPATCH_CHILD_LEDGER: ledger,
		PI_DISPATCH_RUNNER_PID: runnerIdentity(process.pid),
		NODE_OPTIONS: `--import=${OFFLINE} ${PRELOAD_FLAG}`,
		OFFLINE_FETCH_LOG: requests,
		PI_ALLOWED_MODELS: allowed.join(","),
		OPENAI_API_KEY: "fixture.oauth.access",
		ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-fixture-not-a-token",
		...(entry ? { PI_SUBSCRIPTION_AUTH: JSON.stringify([entry]) } : {}),
		...extraEnv,
	};
	const child = spawn(process.execPath, [CLI, ...extensions.flatMap((path) => ["-e", path]), "--mode", "json", "-p", "--no-session", "--model", model, "Task: say ok"], { cwd: join(root, "work"), env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const code = await new Promise((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
	clearTimeout(timer);
	let last = null;
	for (const line of stdout.split("\n")) {
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") last = event.message;
		} catch {
			// Not a protocol line.
		}
	}
	const names = readdirSync(ledger).filter((name) => CHILD_LEDGER_NAME.test(name));
	const parsed = names.length === 1 ? parseChildLedger(readFileSync(join(ledger, names[0]), "utf8")) : null;
	return {
		code,
		answer: last?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? null,
		stopReason: last?.stopReason ?? null,
		errorMessage: last?.errorMessage ?? null,
		ledgers: names.length,
		ledger: parsed,
		fold: foldChildLedgers({ dir: ledger, notional }),
		billed: foldChildLedgers({ dir: ledger }),
		requests: existsSync(requests) ? readFileSync(requests, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
		stderr,
	};
}

/** A subscription entry as the runner keeps it in PI_SUBSCRIPTION_AUTH, current for an hour. */
export function subscriptionEntry(provider, extra = {}) {
	const at = Date.now();
	return { provider, adapter: provider === "openai" ? "openai-chatgpt" : "@gotgenes/pi-anthropic-auth@3.4.3", connectionId: "fixture", generation: 1, expiresAt: at + 2 * 3_600_000, deadlineAt: at + 1_800_000, notional: true, ...extra };
}

/** The image's proof, on an OpenAI subscription: the child is admitted, its call is metered, and the job's fold takes it as notional. */
export async function verifySubscriptionChildren(root) {
	const notional = new Set(["openai"]);
	const admitted = await subscriptionPiChild({ root: join(root, "admitted"), entry: subscriptionEntry("openai"), notional });
	const said = `${JSON.stringify({ code: admitted.code, answer: admitted.answer, error: admitted.errorMessage, ledger: admitted.ledger?.totals })}\n${admitted.stderr.slice(-1500)}`;
	assert.equal(admitted.answer, "child ok", `the child used the subscription through its own admission: ${said}`);
	assert.deepEqual(admitted.requests.map((request) => [request.who, request.token, request.model]), [["child", true, "gpt-4.1"]], "one call, carrying the subscription's token");
	assert.equal(admitted.ledgers, 1, "one ledger, the child's");
	assert.ok(admitted.ledger?.metered, "metered");
	assert.deepEqual([admitted.ledger.totals.calls, admitted.ledger.modelRefused], [1, 0]);
	const cost = admitted.ledger.totals.cost;
	assert.ok(cost > 0, "priced");
	assert.deepEqual([...admitted.ledger.rows.values()].map((row) => [row.provider, row.notional === row.cost]), [["openai", true]], "its ledger marks the call as let through by its own admission");
	assert.equal(admitted.fold.settledMicros, 0, "with the job's notional set, the runner charges the cap nothing for it");
	assert.ok(admitted.billed.settledMicros > 0, "the control: without it, its price is charged");
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: notional });
	meter.setChildren(admitted.fold);
	assert.equal(meter.snapshot().costNotional, cost, "and its price is the job's notional cost");
	assert.ok(meter.notionalMicros() > 0, "which the subscription allowance judges");
	const offList = await subscriptionPiChild({ root: join(root, "off-list"), entry: subscriptionEntry("openai"), model: "openai/gpt-4.1-mini", allowed: [OPENAI_MODEL], notional });
	assert.deepEqual(offList.requests, [], "a model off the job's list is never sent");
	assert.equal(offList.ledger?.modelRefused, 1, "and its refusal is on the ledger, where the runner stops the job for it");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = mkdtempSync(join(tmpdir(), "pi-subscription-children-"));
	try {
		await verifySubscriptionChildren(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log("subscription child capability holds");
}
