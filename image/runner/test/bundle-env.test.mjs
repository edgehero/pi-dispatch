import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBundleEnv, BUNDLE_ENV_FILE, BUNDLE_ENV_FLAG } from "../src/bundle-env.mjs";

/**
 * Issue #704 part 3: a project secret bundle's plain variables, read from the job's own directory into the runner's
 * environment (pi's) on a gateway venue, instead of the exec's argv, which the gateway logs.
 */

const reader = (text) => (path) => {
	if (!path.endsWith(`/${BUNDLE_ENV_FILE}`)) throw new Error(`unexpected ${path}`);
	if (text === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	return text;
};

test("no flag, nothing read, nothing set", () => {
	const env = { PATH: "/bin" };
	assert.equal(applyBundleEnv({ env, read: () => assert.fail("never read") }), 0);
	assert.deepEqual(env, { PATH: "/bin" });
});

test("the flag reads the file into the environment, a multi-line value intact, and leaves the environment itself", () => {
	const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n";
	const env = { [BUNDLE_ENV_FLAG]: "1", PATH: "/bin" };
	assert.equal(applyBundleEnv({ env, read: reader(JSON.stringify({ DB_URL: "postgres://u:p@db/x", SIGNING_PEM: pem })) }), 2);
	assert.deepEqual(env, { PATH: "/bin", DB_URL: "postgres://u:p@db/x", SIGNING_PEM: pem });
	assert.equal(BUNDLE_ENV_FLAG in env, false, "the flag reaches no child");
});

test("every refusal is a config failure (exit 2) before any variable is set, and names no value", () => {
	const cases = [
		[{ [BUNDLE_ENV_FLAG]: "yes" }, "{}"],
		[{ [BUNDLE_ENV_FLAG]: "1" }, null],
		[{ [BUNDLE_ENV_FLAG]: "1" }, "not json"],
		[{ [BUNDLE_ENV_FLAG]: "1" }, "[]"],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", "bad-name": "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", PI_MODEL: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", OPENSHELL_X: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1", HOME: "/home/pi" }, JSON.stringify({ OK: "v", HOME: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", TERM: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1", SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem" }, JSON.stringify({ OK: "v", SSL_CERT_FILE: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1", ANTHROPIC_API_KEY: "openshell:resolve:env:v1_ANTHROPIC_API_KEY" }, JSON.stringify({ ANTHROPIC_API_KEY: "secretvalue" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", N: 1 })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", E: "" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, JSON.stringify({ OK: "v", Z: "a\u0000b" })],
		[{ [BUNDLE_ENV_FLAG]: "1" }, "x".repeat(1024 * 1024 + 1)],
	];
	for (const [start, text] of cases) {
		const env = { ...start };
		assert.throws(() => applyBundleEnv({ env, read: reader(text) }), (e) => e.piDispatchExit === 2 && !e.message.includes("secretvalue"), JSON.stringify(start) + String(text).slice(0, 60));
		assert.equal(env.OK, undefined, "nothing applied from a refused file");
	}
});

test("a name the job image's ENV set is replaced, as -e replaces it on local; a protected or placeholder name is not (final review round)", () => {
	const env = { [BUNDLE_ENV_FLAG]: "1", LANG: "C.UTF-8", APP_MODE: "image-default" };
	assert.equal(applyBundleEnv({ env, read: reader(JSON.stringify({ APP_MODE: "from-bundle" })) }), 1);
	assert.equal(env.APP_MODE, "from-bundle");
	assert.equal(env.LANG, "C.UTF-8");
});
