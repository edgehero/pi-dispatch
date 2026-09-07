import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideRetry, EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "../src/exit-code.mjs";

// INT-RUNNER-EXIT-CODE-PROTOCOL / CONST-RETRY-INFRA-ONLY. The whole point: only infra retries.

test("exit 0 (agent ran, incl. 'can't fix') is success, NOT retried", () => {
	assert.deepEqual(decideRetry(EXIT_COMPLETED), { retry: false, outcome: "completed" });
});

test("exit 2 (budget/policy) is determinate, NOT retried -- paying twice for a refusal is the bug", () => {
	assert.equal(decideRetry(EXIT_POLICY).retry, false);
});

test("exit 1 (infra) is the ONLY retryable class", () => {
	assert.equal(decideRetry(EXIT_INFRA).retry, true);
});

test("an unknown exit code is retried-then-visible, not silently accepted as done", () => {
	// A runner we can't reason about must not be recorded as a clean success.
	const d = decideRetry(137); // SIGKILL, e.g. OOM
	assert.equal(d.retry, true);
	assert.match(d.outcome, /unknown-exit-137/);
});

// ── The copies of EXIT_POLICY that live outside this module ──────────────────────────────────────
//
// Exit 2 means "never restart, never retry: paying twice for a determinate refusal is the bug". That
// meaning is enforced in three artifact families that CANNOT import this constant, so each retypes the
// literal `2` and each was pinned only by tests asserting the literal too -- so every one of them would
// have stayed green if `EXIT_POLICY` moved. These assert against the CONSTANT instead.
//
// Pins, never derives, and the reason differs per family: `image/runner` ships inside the container with a
// two-package dependency list and no path to the worker, and the deploy artifacts are systemd units, an
// nssm script and two shell wrappers. Only the ROOT `deploy/` is read here -- worker/test/publish.test.mjs
// already pins `worker/deploy/*` byte-identical to it, so covering root covers both.
const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

test("the runner's retyped EXIT_POLICY is the same integer -- the container cannot import ours", () => {
	const src = repoFile("image/runner/src/outcome.mjs");
	const m = src.match(/export const EXIT_POLICY = (\d+);/);
	assert.ok(m, "image/runner/src/outcome.mjs no longer declares EXIT_POLICY in a form this pin can read");
	assert.equal(
		Number(m[1]),
		EXIT_POLICY,
		"image/runner/src/outcome.mjs must retype worker/src/exit-code.mjs's value because the runner ships in the container with no worker dependency. worker/src/exit-code.mjs is canonical -- change the runner to follow it.",
	);
});

test("every service unit refuses to restart EXIT_POLICY, by its own spelling of the number", () => {
	for (const unit of ["deploy/worker.service", "deploy/receiver.service"]) {
		assert.match(repoFile(unit), new RegExp(`RestartPreventExitStatus=${EXIT_POLICY}\\b`), `${unit} must not restart a determinate refusal`);
	}
	assert.match(repoFile("deploy/nssm-install.cmd"), new RegExp(`AppExit ${EXIT_POLICY} Exit`), "nssm must not restart a determinate refusal");
});

test("both wrappers convert EXIT_POLICY to a clean exit, keyed on the constant's value", () => {
	// The wrappers are what a service manager WITHOUT an exit-code exclusion depends on, so these two are
	// the last line rather than a convenience.
	assert.match(repoFile("deploy/worker-env-wrapper.sh"), new RegExp(`\\[ "\\$rc" -eq ${EXIT_POLICY} \\]`), "the sh wrapper keys on EXIT_POLICY");
	assert.match(repoFile("deploy/worker-env-wrapper.cmd"), new RegExp(`if "%RC%"=="${EXIT_POLICY}"`), "the cmd wrapper keys on EXIT_POLICY");
});
