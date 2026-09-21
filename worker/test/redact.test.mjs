import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCRUBBED_MAX, scrubCredentials } from "../src/redact.mjs";

/**
 * The credential scrubber every unattended sweep's fault line goes through (issue #339).
 *
 * BOTH HALVES MATTER EQUALLY. What it removes is the point; what it LEAVES is why this is a scrubber and
 * not a fixed token, and a change that quietly widened it into eating diagnoses would be a regression the
 * removal half could not see.
 */

const REDACTED = [
	["docker, unparseable DOCKER_HOST", 'Command failed: docker ps\nFailed to initialize: parse "ssh://bob:hunter2@remote": invalid port', ["bob", "hunter2"]],
	// Go quotes the offending fragment a SECOND time in its own words, outside the URL. Measured shape.
	["docker, the fragment echoed outside the URL", 'Failed to initialize: parse "ssh://bob:pa?ss@remote": invalid port ":pa" after host', ["bob", "pa?ss", '":pa"']],
	["a password holding whitespace, quoted by Go", 'parse "ssh://bob:pa ss@remote": invalid character', ["bob", "pa ss"]],
	["creds in the daemon address", "Cannot connect to the Docker daemon at tcp://bob:hunter2@127.0.0.1:2375. Is the docker daemon running?", ["bob", "hunter2"]],
	["podman's own connection URI", "Error: ssh://core@localhost:53841/run/user/1000/podman/podman.sock: ssh: handshake failed", ["core@"]],
	["podman's identity file, a home path", "Error: failed to read identity file /Users/alice/.ssh/id_ed25519: permission denied", ["alice"]],
	["a windows home path", "C:\\Users\\alice\\.docker\\config.json", ["alice"]],
];

// The half that is easy to lose: a fault whose message IS the diagnosis must come through untouched.
const UNTOUCHED = [
	"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
	"EACCES: permission denied, scandir '/var/lib/pi-dispatch/sandboxes'",
	"Error: failed to connect: dial unix /run/user/1000/podman/podman.sock: connect: no such file",
	"makeSandboxReaperFn is not a function",
	"network pi-job-abc-net not found",
	"daemon down",
	"boom",
	"connect ECONNREFUSED 127.0.0.1:6379",
];

test("a credential in a userinfo position never survives, and the host and the sentence do (#339)", () => {
	for (const [name, message, secrets] of REDACTED) {
		const out = scrubCredentials(message);
		for (const s of secrets) assert.ok(!out.includes(s), `${name}: ${JSON.stringify(s)} survived in ${JSON.stringify(out)}`);
		assert.ok(out.includes("[redacted]"), `${name}: something must be named as removed`);
	}
	// The host survives, which is the whole reason this is not a fixed token.
	assert.match(scrubCredentials('parse "ssh://bob:hunter2@remote:22": bad'), /remote:22/);
	assert.match(scrubCredentials("Cannot connect to the Docker daemon at tcp://bob:pw@10.1.2.3:2375."), /10\.1\.2\.3:2375/);
});

test("a message that is its own diagnosis is not touched at all (#339)", () => {
	// A fixed token would delete every one of these. Five of the twelve sites carry filesystem faults and two
	// exist to catch a throwing factory, where the message is the entire value of the line.
	for (const message of UNTOUCHED) assert.equal(scrubCredentials(message), message, JSON.stringify(message));
});

test("the scrub is idempotent, and a non-string is a word rather than a crash (#339)", () => {
	for (const [, message] of REDACTED) assert.equal(scrubCredentials(scrubCredentials(message)), scrubCredentials(message));
	for (const message of UNTOUCHED) assert.equal(scrubCredentials(scrubCredentials(message)), message);
	// `undefined` reaches here whenever something is thrown that is not an Error.
	for (const v of [undefined, null, 42, {}, ""]) assert.equal(scrubCredentials(v), "unknown", JSON.stringify(v));
});

test("the cap is applied AFTER the scrub, never before (#339)", () => {
	// Cutting first can land inside a credential and leave its prefix, which is the failure mode this file
	// exists to prevent. Measured both ways when this was written.
	const out = scrubCredentials(`${"x".repeat(SCRUBBED_MAX - 10)} tcp://bob:hunter2@h`);
	assert.ok(!out.includes("bob") && !out.includes("hunter2"), `a cut must not reveal a prefix: ${JSON.stringify(out.slice(-40))}`);
	assert.ok(out.length <= SCRUBBED_MAX + 1, "and the result is still capped");
});

test("an exhaustive sweep of hostile password bodies leaves none of itself (#339)", () => {
	// Deterministic rather than random, and it is the Go-quoted form because that is what both runtimes
	// print for an endpoint they could not parse.
	const alphabet = [..."abz09:@/?#.%[]-_\\"];
	let checked = 0;
	for (const a of alphabet) {
		for (const b of alphabet) {
			for (const c of alphabet) {
				const body = a + b + c;
				const out = scrubCredentials(`parse "ssh://bob:${body}@remote": invalid port`);
				assert.ok(!out.includes("bob:"), `bob: survived for ${JSON.stringify(body)}`);
				checked++;
			}
		}
	}
	assert.ok(checked > 4000, "the sweep must actually run");
});

test("the residual is stated, and it is the one neither runtime produces (#339)", () => {
	// A credential holding whitespace or a quote that the runtime printed UNQUOTED. Closing it needs a rule
	// that crosses whitespace, and such a rule eats the useful half of every line holding an unrelated `@`.
	// This test exists so the limit is a recorded measurement rather than a sentence in a comment.
	const unquoted = "parse ssh://bob:pa ss@remote failed";
	const out = scrubCredentials(unquoted);
	assert.match(out, /\[redacted\]@remote/, "the run up to the last @ still goes");
	assert.ok(out.includes("pa "), "but the half before the whitespace survives, which is the stated residual");
	// And a fragment ECHOED unquoted, or shorter than two characters, survives the second pass.
	assert.ok(scrubCredentials('parse "ssh://bob:a@remote": invalid port "a"').includes('"a"'), "a one-character echo is left, deliberately");
});

test("no sweep logs a raw error message (#339)", () => {
	// Reads the SOURCE rather than behaviour, and says so: it sees the call SHAPE, never the truth. The
	// behavioural tests beside each site are the oracle. This exists because the treatment spans twelve
	// near-identical catches and the thirteenth will be written by copying one of them.
	const files = ["backend-local.mjs", "backend-registry.mjs", "sandbox-store.mjs", "retention-sweep.mjs", "start.mjs", "index.mjs", "run-history.mjs", "session-store.mjs"];
	for (const f of files) {
		const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
		for (const [, line] of src.split("\n").entries()) {
			if (!/_reaper_skipped|_sweep_skipped|stop_container_failed/.test(line)) continue;
			if (!/err\?\.message/.test(line)) continue;
			assert.match(line, /scrubCredentials\(/, `${f}: a sweep fault line must scrub: ${line.trim()}`);
		}
	}
});
