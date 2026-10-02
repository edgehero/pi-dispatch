import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { githubFailureFields, octokitLog } from "../src/octokit-log.mjs";

// Issue #530. A worker booted with GITHUB_AUTH_SOURCE=pat and a refused token printed Octokit's own plain line,
// `GET /user - 401 with id ... in 12ms`, beside its JSON `github_auth_unavailable` line.

test("octokitLog keeps a client's warning as one JSON event and drops its request lines (#530)", () => {
	const seen = [];
	const log = octokitLog((event, fields) => seen.push({ event, ...fields }));
	log.debug("request", { method: "GET" });
	log.info("GET /user - 200 with id A in 3ms");
	log.error("GET /user - 401 with id A in 3ms");
	log.warn('[@octokit/request] "GET /x" is deprecated.');
	assert.deepEqual(seen, [{ event: "github_client_warning", message: '[@octokit/request] "GET /x" is deprecated.' }]);
});

test("githubFailureFields names a GitHub answer's status and request id, from the error or its causes, and no more (#530)", async () => {
	// A REAL RequestError: the real auth and Octokit, with only the fetch replaced (Octokit's own option, no global).
	const { Octokit } = await import("@octokit/rest");
	const { makeGitHubAuth } = await import("../src/get-token.mjs");
	const answer = (requestId) => async () =>
		new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json", "x-github-request-id": requestId } });
	const refusing = (requestId) =>
		class extends Octokit {
			constructor(options) {
				super({ ...options, request: { ...options.request, fetch: answer(requestId) } });
			}
		};
	const failure = (requestId) => makeGitHubAuth({ source: "pat" }, { Octokit: refusing(requestId), env: { GITHUB_PAT: "ghp_secret530" }, log: () => {} }).then(() => assert.fail("refused"), (e) => e);

	const err = await failure("C0DE:530.1");
	assert.equal(err.piDispatchConfig, true, "still the determinate refusal");
	assert.equal(err.cause?.name, "HttpError", "the RequestError rides as the cause");
	assert.ok(!JSON.stringify(githubFailureFields(err)).includes("ghp_secret530"));
	assert.deepEqual(githubFailureFields(err), { status: 401, requestId: "C0DE:530.1" });
	assert.deepEqual(githubFailureFields(err.cause), { status: 401, requestId: "C0DE:530.1" });
	// GitHub's text is kept only in its own shape.
	assert.deepEqual(githubFailureFields(await failure("C0DE 530\"injected\":1")), { status: 401 });
	// Nothing from an error that is not a GitHub answer.
	for (const other of [new Error("connect ETIMEDOUT"), Object.assign(new Error("x"), { status: 401 }), null, undefined, "text"]) {
		assert.deepEqual(githubFailureFields(other), {}, String(other));
	}
	assert.deepEqual(githubFailureFields(Object.assign(new Error("fetch failed"), { name: "HttpError", status: 500 })), { status: 500 }, "no response, no id");
});

/**
 * The real clients, in a child process, so both of its streams are what is judged and this runner's own stdout is never
 * touched (issue #266). `fetch` is stubbed in the child: Octokit reads `globalThis.fetch` at each request, so every
 * GitHub client the worker builds runs unmodified against a GitHub that refuses the token. One host call answers 200
 * with a deprecation header first, so a warning has to come through too, as JSON. And one App is accepted, so its
 * per-job installation-token mint runs: `@octokit/auth-app` makes that request with its OWN client, not the Octokit's.
 */
const CHILD = `
import { generateKeyPairSync } from "node:crypto";
const { makeGitHubAuth } = await import(${JSON.stringify(fileURLToPath(new URL("../src/get-token.mjs", import.meta.url)))});
const { makeGitHubHost } = await import(${JSON.stringify(fileURLToPath(new URL("../src/github-host.mjs", import.meta.url)))});
const headers = { "content-type": "application/json", "x-github-request-id": "C0DE:1234" };
let appAccepted = false;
globalThis.fetch = async (input) => {
	const url = String(input?.url ?? input);
	const deprecated = { ...headers, deprecation: "true", sunset: "2027-01-01" };
	if (url.endsWith("/repos/o/r")) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: deprecated });
	if (appAccepted && url.endsWith("/app")) return new Response(JSON.stringify({ slug: "pd" }), { status: 200, headers });
	if (appAccepted && url.endsWith("/users/pd%5Bbot%5D")) return new Response(JSON.stringify({ id: 7 }), { status: 200, headers });
	if (appAccepted && url.endsWith("/app/installations/3/access_tokens")) {
		return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "selected" }), { status: 201, headers: deprecated });
	}
	return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers });
};
const log = (event, fields) => process.stdout.write(JSON.stringify({ event, ...fields }) + "\\n");
const caught = (what, error) => log("caught", { what, status: error?.status ?? null });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const execFile = (_file, _args, cb) => cb(null, { stdout: "gho_refused\\n", stderr: "" });
const sources = {
	pat: [{ source: "pat" }, { env: { GITHUB_PAT: "ghp_refused" } }],
	gh: [{ source: "gh" }, { execFile }],
	app: [{ source: "app", appId: "1", installationId: "2", privateKey }, {}],
};
for (const [what, [cfg, deps]] of Object.entries(sources)) {
	try {
		await makeGitHubAuth(cfg, { ...deps, log });
		log("resolved", { what });
	} catch (error) {
		caught(what, error);
	}
}
try {
	await makeGitHubHost({ log }).resolveDefaultBranchSha("o/r", "tok");
	log("resolved", { what: "host" });
} catch (error) {
	caught("host", error);
}
appAccepted = true;
const minted = await makeGitHubAuth({ source: "app", appId: "1", installationId: "3", privateKey }, { log });
log("minted", { ok: (await minted.mintToken({ repo: "o/r" })) === "ghs_minted" });
`;

function runChild() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

test("every GitHub client a refused token meets writes JSON lines only, on both streams (#530)", async () => {
	const { code, stdout, stderr } = await runChild();
	assert.equal(code, 0, stderr);
	assert.equal(stderr, "", "nothing on stderr: Octokit's console.error and console.warn are never reached");
	const lines = stdout.split("\n").filter((line) => line !== "");
	for (const line of lines) {
		assert.doesNotThrow(() => JSON.parse(line), `not a JSON line: ${line}`);
		assert.ok(!line.includes("with id"), `a request line got through: ${line}`);
	}
	const events = lines.map((line) => JSON.parse(line));
	// Not vacuous: each client really met the refusal, and the deprecation warning came through as an event.
	assert.deepEqual(
		events.filter((e) => e.event === "caught").map((e) => e.what),
		["pat", "gh", "app", "host"],
	);
	assert.deepEqual(events.filter((e) => e.event === "minted"), [{ event: "minted", ok: true }], stdout);
	// The set, not the list: the identity client may make the same POST before the per-job mint does.
	assert.deepEqual(
		[...new Set(events.filter((e) => e.event === "github_client_warning").map((e) => e.message))],
		[
			'[@octokit/request] "GET https://api.github.com/repos/o/r" is deprecated. It is scheduled to be removed on 2027-01-01',
			'[@octokit/request] "POST https://api.github.com/app/installations/3/access_tokens" is deprecated. It is scheduled to be removed on 2027-01-01',
		],
		stdout,
	);
});
