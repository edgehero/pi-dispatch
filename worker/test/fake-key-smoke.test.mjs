import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP_MICROS, FAKE_KEY, smoke, smokeProblems, smokeWanted } from "../../.github/scripts/fake-key-smoke.mjs";

// Issue #587: the image job's zero-spend provider smoke. Its verdict on real runner output (the shape measured in the
// lab on the 1.0.3 image), and its split between a defect in the image and a runner that cannot reach Anthropic.

const METER = (capped) => JSON.stringify({ event: "usage_meter", ok: true, methods: ["streamSimple", "stream", "streamDeferred", "classify", "generateImages"], compat: "pi", fallback: true, capped: false, costCapped: capped, listed: false, brake: capped });
const EXIT = (capped, over = {}) =>
	JSON.stringify({
		event: "exit",
		code: 2,
		reason: "provider-auth-refused",
		message: '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}',
		turns: 1,
		tokens: { input: 0, output: 0, total: 0, cost: 0, metered: true, sessions: 1, calls: 1, ...(capped ? { costCapMicros: 5000000, costRefused: 0, costUnanswered: 1 } : {}) },
		usage: { v: 1, piAi: "1.0.3", models: [{ provider: "anthropic", model: "claude-sonnet-4-5-20250929", calls: 1, cost: 0 }] },
		...over,
	});
const run = (capped, exitOver, meter = METER(capped)) => ['{"event":"workspace_not_writable","path":"/workspace"}', "", meter, "", EXIT(capped, exitOver), ""].join("\n");

test("a run that reached Anthropic, got its 401, stayed metered on every method and cost nothing passes, capped or not", () => {
	assert.deepEqual(smokeProblems(run(false), { piVersion: "1.0.3", capped: false }), []);
	assert.deepEqual(smokeProblems(run(true), { piVersion: "1.0.3", capped: true }), []);
	assert.match(FAKE_KEY, /^sk-ant-api03-[0-9]{93}AA$/);
});

test("each way the smoke can be wrong is named", () => {
	const at = (output, capped = false) => smokeProblems(output, { piVersion: "1.0.3", capped });
	assert.match(at(run(false, {}, METER(false).replace('"classify",', ""))).join(), /not every method/);
	assert.match(at(run(false, {}, METER(false).replace('"ok":true', '"ok":false'))).join(), /usage_meter ok is false/);
	assert.match(at(run(false, {}, METER(false).replace('"compat":"pi"', '"compat":"hoisted"'))).join(), /not pi's own pi-ai/);
	assert.match(at(run(false, { code: 0, reason: "stop" })).join(), /exit 0 stop, want 2 provider-auth-refused/);
	assert.match(at(run(false, { message: "403 forbidden" })).join(), /not Anthropic's 401/);
	assert.match(at(run(false, { tokens: { calls: 0, cost: 0 } })).join(), /never reached the meter/);
	assert.match(at(run(false, { tokens: { calls: 1, cost: 0.01 } })).join(), /not \$0/);
	assert.match(at(run(false, { usage: { piAi: "1.0.2", models: [] } })).join(), /not the pin 1\.0\.3/);
	assert.match(at(run(true, { tokens: { calls: 1, cost: 0, costRefused: 1 } }), true).join(), /refused 1 call/);
	assert.match(at(run(false), true).join(), /costCapped is false, want true/);
	assert.deepEqual(at("not json at all"), ["no usage_meter line: the meter never reported installing", "no exit line: the runner did not finish"]);
});

test("a failed run is the image's fault when a plain fetch from the image reaches Anthropic, and infrastructure when it does not", () => {
	const calls = [];
	const docker = (answers) => (args) => {
		calls.push(args);
		return answers(args);
	};
	const ok = smoke({ image: "pi-job:ci", piVersion: "1.0.3", jobDir: "/j", docker: docker((args) => ({ status: 2, output: run(args.includes(`PI_MAX_COST_MICROS=${CAP_MICROS}`)) })) });
	assert.equal(ok.ok, true);
	assert.equal(calls.length, 2, "no control when both runs pass");
	assert.ok(calls.every((args) => args.includes(`ANTHROPIC_API_KEY=${FAKE_KEY}`) && args.at(-1) === "pi-job:ci" && args.includes("/j:/job:ro")));
	const down = (args) => (args.includes("--entrypoint") ? { status: 3, output: "unreachable ENOTFOUND\n" } : { status: 1, output: run(false, { code: 1, reason: "error", message: "Connection error." }) });
	const infra = smoke({ image: "i", piVersion: "1.0.3", jobDir: "/j", docker: docker(down) });
	assert.deepEqual([infra.ok, infra.infra], [false, true]);
	assert.match(infra.report.at(-1), /unreachable ENOTFOUND/);
	const answered = (status) => (args) => (args.includes("--entrypoint") ? { status: 0, output: `answered ${status}\n` } : { status: 1, output: run(false, { code: 1, reason: "error", message: "Connection error." }) });
	const defect = smoke({ image: "i", piVersion: "1.0.3", jobDir: "/j", docker: docker(answered(401)) });
	assert.deepEqual([defect.ok, defect.infra], [false, false], "the control's fake key got its 401, so the provider was there and the image is at fault");
	const control = calls.at(-1);
	assert.ok(control.includes(`ANTHROPIC_API_KEY=${FAKE_KEY}`), "the control sends the same fake key");
	for (const status of [500, 503, 529, 429, 200, 403]) {
		const weather = smoke({ image: "i", piVersion: "1.0.3", jobDir: "/j", docker: docker(answered(status)) });
		assert.deepEqual([weather.ok, weather.infra], [false, true], `a control answered ${status} is not the provider refusing a key: infrastructure`);
	}
});

test("the smoke runs on main, the schedule, a manual run and the pi bump's branch, and on a pull request only when it can move the result", () => {
	assert.equal(smokeWanted({ event: "push", headRef: "", changed: [] }).run, true);
	assert.equal(smokeWanted({ event: "schedule", headRef: "", changed: [] }).run, true);
	assert.equal(smokeWanted({ event: "workflow_dispatch", headRef: "", changed: [] }).run, true);
	assert.equal(smokeWanted({ event: "pull_request", headRef: "chore/pi-bump", changed: ["docs/x.md"] }).run, true);
	for (const path of ["package-lock.json", "package.json", "image/runner/package.json", "worker/package.json", "admin/package.json", "admin/src/index.ts", "image/Dockerfile", "image/runner/src/usage-meter.mjs", ".github/scripts/fake-key-smoke.mjs"]) {
		assert.deepEqual(smokeWanted({ event: "pull_request", headRef: "fix/x", changed: ["docs/a.md", path] }), { run: true, why: `the pull request changes ${path}` }, path);
	}
	for (const changed of [[], ["docs/a.md", "worker/src/doctor.mjs", "admin/src/panel.mjs", "imagery.md"]]) {
		assert.equal(smokeWanted({ event: "pull_request", headRef: "fix/x", changed }).run, false, changed.join());
	}
});
