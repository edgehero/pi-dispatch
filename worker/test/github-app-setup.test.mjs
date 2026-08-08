import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { buildFormPage, buildManifest, defaultAppName, mintAppJwt, runGithubAppSetup, sanitizeAppName } from "../src/github-app-setup.mjs";

// A REAL RSA keypair, generated once: the conversion response carries the private half as its `pem`,
// so the wizard's hand-rolled JWT is signed with a key the test can VERIFY against the public half —
// the sign/verify roundtrip is the point, not a fixture string.
const { publicKey: PUBLIC_PEM, privateKey: PRIVATE_PEM } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Distinctive on purpose: the no-secret-in-output assertions grep for exactly these.
const HOOK_SECRET = "hooksecret-3f9a1c".repeat(3);
const CLIENT_SECRET = "clientsecret-77aa0b".repeat(3);

const APP = {
	id: 4242,
	slug: "pi-dispatch-testbox",
	pem: PRIVATE_PEM,
	webhook_secret: HOOK_SECRET,
	client_secret: CLIENT_SECRET,
	client_id: "Iv1.notasecret",
	html_url: "https://github.com/apps/pi-dispatch-testbox",
};

const PEM_PATH = "/deploy/github-app-pi-dispatch-testbox.pem";
const ENV_PATH = "/deploy/.env";
// A .env in the pre-setup shape: gh source, App keys scaffolded empty (like .env.example).
const SEED_ENV = "GITHUB_AUTH_SOURCE=gh\nGITHUB_APP_ID=\nGITHUB_APP_PRIVATE_KEY_PATH=\nWEBHOOK_SECRET=\n";

// A fake fetch: route keys are URL substrings mapped to `{ status, body }` (body objects are
// JSON-stringified) or an Error to throw. Every call is recorded (url, opts) so tests can assert the
// method, headers, and the Authorization JWT.
function fakeFetch(routes, calls) {
	return async (url, opts = {}) => {
		calls.push({ url, opts });
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (key === undefined) throw new Error(`unrouted fetch in test: ${url}`);
		const outcome = routes[key];
		if (outcome instanceof Error) throw outcome;
		const { status = 200, body = "" } = outcome;
		return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
	};
}

const greenRoutes = () => ({
	"/app-manifests/": { status: 201, body: APP },
	"/app/installations": { status: 200, body: [{ id: 987654, account: { login: "edgehero" } }] },
});

// Everything injected, everything recorded — the up.test.mjs harness shape. `files` seeds the
// in-memory fs; `writes` records every writeFileSync (path, data, opts) so "declined writes NOTHING"
// is an assertion about the recorder, not about the store's final state.
function harness({ argv, answers = [], files = {}, routes = greenRoutes(), code = "onetimecode", listenError, waitError, nowMs = 1_700_000_000_000, timeoutMs } = {}) {
	const buf = [];
	const promptCalls = [];
	const opened = [];
	const fetchCalls = [];
	const writes = [];
	const store = new Map(Object.entries(files));
	let pageFor = null;
	let closed = 0;
	const deps = {
		env: {},
		fetchFn: fakeFetch(routes, fetchCalls),
		listen: async (pf) => {
			if (listenError) throw new Error(listenError);
			pageFor = pf;
			return {
				port: 43210,
				url: "http://127.0.0.1:43210",
				waitForCode: async () => {
					if (waitError) throw new Error(waitError);
					return code;
				},
				close: () => closed++,
			};
		},
		openBrowser: (u) => opened.push(u),
		out: (s) => buf.push(s),
		prompt: async (q) => {
			promptCalls.push(q);
			return answers.shift() ?? "";
		},
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p) => {
				if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				return store.get(p);
			},
			writeFileSync: (p, data, opts) => {
				writes.push([p, data, opts]);
				store.set(p, data);
			},
			renameSync: (from, to) => {
				store.set(to, store.get(from));
				store.delete(from);
			},
			statSync: () => ({ mode: 0o100600 }),
			chmodSync: () => {},
		},
		cwd: "/deploy",
		now: () => nowMs,
		...(timeoutMs === undefined ? {} : { codeTimeoutMs: timeoutMs }),
	};
	return {
		run: () => runGithubAppSetup(argv ?? ["--webhook-url", "https://hooks.example/github"], deps),
		text: () => buf.join(""),
		promptCalls,
		opened,
		fetchCalls,
		writes,
		store,
		getPageFor: () => pageFor,
		closedCount: () => closed,
	};
}

/** The one rule with no exceptions: pem, webhook secret, client secret never reach output. */
function assertNoSecrets(text) {
	assert.ok(!text.includes(HOOK_SECRET), "the webhook secret must never reach output");
	assert.ok(!text.includes(CLIENT_SECRET), "the client secret must never reach output");
	// The PEM is multi-line; its body lines are the load-bearing bytes, so check a middle chunk too.
	assert.ok(!text.includes(PRIVATE_PEM), "the private key must never reach output");
	assert.ok(!text.includes(PRIVATE_PEM.split("\n")[2]), "no line of the private key may reach output");
}

// -- flags: the webhook shape is a choice, never a default ---------------------------------------------

test("setup github: neither --webhook-url nor --no-webhook is a refusal with guidance, before any listener", async () => {
	const h = harness({ argv: [] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /choose a webhook shape/);
	assert.match(h.text(), /--webhook-url <URL>/, "the usage block is shown");
	assert.equal(h.getPageFor(), null, "no listener was ever bound");
	assert.equal(h.fetchCalls.length, 0, "nothing was fetched");
});

test("setup github: --webhook-url plus --no-webhook is a refusal (they contradict)", async () => {
	const h = harness({ argv: ["--webhook-url", "https://x.example", "--no-webhook"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /contradict/);
});

test("setup github: an unknown flag fails loud with the usage block", async () => {
	const h = harness({ argv: ["--frobnicate"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /usage: pi-dispatch setup github/);
});

// -- the manifest: exact shape for both webhook modes --------------------------------------------------

test("buildManifest: --webhook-url shape is exactly the narrow permission/event set with the hook URL", () => {
	assert.deepEqual(buildManifest({ name: "pi-dispatch-x", redirectUrl: "http://127.0.0.1:1/callback", webhookUrl: "https://hooks.example/github" }), {
		name: "pi-dispatch-x",
		url: "https://github.com/edgehero/pi-dispatch",
		redirect_url: "http://127.0.0.1:1/callback",
		hook_attributes: { url: "https://hooks.example/github" },
		public: false,
		default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
		default_events: ["issues", "issue_comment", "pull_request", "pull_request_review"],
	});
});

test("buildManifest: no webhook URL yields hook_attributes {active:false} — the polling-ready shape", () => {
	const manifest = buildManifest({ name: "pi-dispatch-x", redirectUrl: "http://127.0.0.1:1/callback", webhookUrl: undefined });
	assert.deepEqual(manifest.hook_attributes, { active: false });
	assert.deepEqual(manifest.default_permissions, { contents: "write", pull_requests: "write", issues: "write", metadata: "read" });
	assert.deepEqual(manifest.default_events, ["issues", "issue_comment", "pull_request", "pull_request_review"]);
});

// -- the served form page: embeds the manifest, POSTs to the right target ------------------------------

/** Recover the manifest JSON the page embeds (it is HTML-escaped into the hidden input). */
function embeddedManifest(page) {
	const m = page.match(/name="manifest" value="([^"]*)"/);
	assert.ok(m, "the page carries a hidden manifest input");
	const json = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	return JSON.parse(json);
}

test("form page: embeds the exact manifest, POSTs to the USER endpoint, and auto-submits", async () => {
	const h = harness({ argv: ["--webhook-url", "https://hooks.example/github", "--name", "my-app"], answers: [""] });
	await h.run();
	const page = h.getPageFor()("http://127.0.0.1:43210");
	assert.match(page, /action="https:\/\/github\.com\/settings\/apps\/new"/, "no --org means the user-account endpoint");
	assert.match(page, /method="post"/);
	assert.match(page, /<script>document\.getElementById\("m"\)\.submit\(\);<\/script>/, "the form self-submits — a link cannot carry the payload");
	const manifest = embeddedManifest(page);
	assert.equal(manifest.name, "my-app");
	assert.equal(manifest.redirect_url, "http://127.0.0.1:43210/callback", "the redirect comes back to the listener's own /callback");
	assert.deepEqual(manifest.hook_attributes, { url: "https://hooks.example/github" });
});

test("form page: --org switches the POST target to the organization endpoint", async () => {
	const h = harness({ argv: ["--no-webhook", "--org", "acme"], answers: [""] });
	await h.run();
	const page = h.getPageFor()("http://127.0.0.1:43210");
	assert.match(page, /action="https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new"/);
	assert.deepEqual(embeddedManifest(page).hook_attributes, { active: false });
});

test("buildFormPage: the embedded JSON is HTML-escaped (quotes cannot break out of the input value)", () => {
	const manifest = buildManifest({ name: "x", redirectUrl: "http://l/callback" });
	const page = buildFormPage(manifest, "https://github.com/settings/apps/new");
	assert.ok(page.includes("&quot;name&quot;"), "JSON quotes are escaped into the attribute");
	const embedded = page.match(/name="manifest" value="([^"]*)"/)[1];
	assert.ok(!/[<>]/.test(embedded), "no raw angle brackets survive inside the attribute");
	assert.deepEqual(embeddedManifest(page), manifest, "unescaping recovers the exact manifest — nothing was lost to escaping");
});

// -- conversion → the shown plan, and the decline path -------------------------------------------------

test("setup github: the conversion result is shown as exact .env lines, secrets absent from ALL output", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: [""] }); // decline at the write gate
	assert.equal(await h.run(), 0, "declining is not an error");
	const text = h.text();
	assert.match(text, /GITHUB_AUTH_SOURCE=app/);
	assert.match(text, /GITHUB_APP_ID=4242/);
	assert.match(text, new RegExp(`GITHUB_APP_PRIVATE_KEY_PATH=${PEM_PATH.replace(/[./]/g, "\\$&")}`));
	assert.match(text, /WEBHOOK_SECRET=<value not shown>/, "the secret line is announced, never echoed");
	assertNoSecrets(text);
	// The conversion call itself: POST, the code in the path, no auth (the code IS the proof).
	const conversion = h.fetchCalls.find((c) => c.url.includes("/app-manifests/"));
	assert.equal(conversion.url, "https://api.github.com/app-manifests/onetimecode/conversions");
	assert.equal(conversion.opts.method, "POST");
	assert.equal(conversion.opts.headers.accept, "application/vnd.github+json");
	assert.ok(conversion.opts.headers["user-agent"], "GitHub requires a User-Agent");
	assert.equal(conversion.opts.headers.authorization, undefined, "the conversion is unauthenticated by design");
});

test("setup github: declining the write gate writes NOTHING and names the App's URL + how to delete it", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["n"] });
	assert.equal(await h.run(), 0);
	assert.deepEqual(h.writes, [], "the fs recorder is empty — nothing was written");
	assert.equal(h.store.get(ENV_PATH), SEED_ENV, ".env is byte-identical");
	assert.match(h.text(), /the App itself DOES now exist on GitHub: https:\/\/github\.com\/apps\/pi-dispatch-testbox/);
	assert.match(h.text(), /Delete GitHub App/);
	assert.equal(h.promptCalls.length, 1, "declined at the first gate — no further prompts");
});

// -- the accept path: PEM 0600, exact transforms, overwrite vs if-empty split --------------------------

test("setup github: accepting writes the PEM 0600 and applies the exact .env transforms", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "y"] });
	assert.equal(await h.run(), 0);
	const pemWrite = h.writes.find(([p]) => p === PEM_PATH);
	assert.ok(pemWrite, "the PEM was written");
	assert.equal(pemWrite[1], PRIVATE_PEM, "the PEM content is the conversion response's pem, verbatim");
	assert.deepEqual(pemWrite[2], { mode: 0o600 }, "the key file lands mode 0600");
	// The three consented values went through the OVERWRITE transform (gh was replaced), the secret
	// through the if-empty one (the empty scaffold line was filled) — asserted as one exact file.
	assert.equal(
		h.store.get(ENV_PATH),
		`GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=4242\nGITHUB_APP_PRIVATE_KEY_PATH=${PEM_PATH}\nWEBHOOK_SECRET=${HOOK_SECRET}\nGITHUB_APP_INSTALLATION_ID=987654\n`,
	);
	assert.deepEqual(
		h.promptCalls,
		["write these? [y/N] ", "installed? [y/N] ", "write it? [y/N] "],
		"every write is individually consented; there is no --yes on this wizard",
	);
	assertNoSecrets(h.text());
});

test("setup github: an operator's existing WEBHOOK_SECRET is KEPT (if-empty), while GITHUB_AUTH_SOURCE is overwritten", async () => {
	const seeded = "GITHUB_AUTH_SOURCE=gh\nWEBHOOK_SECRET=operator-chose-this\n";
	const h = harness({ files: { [ENV_PATH]: seeded }, answers: ["y", "y", "y"] });
	assert.equal(await h.run(), 0);
	const env = h.store.get(ENV_PATH);
	assert.match(env, /^GITHUB_AUTH_SOURCE=app$/m, "the consented auth-source line IS replaced");
	assert.match(env, /^WEBHOOK_SECRET=operator-chose-this$/m, "the existing secret is untouched — working deliveries stay valid");
	assert.ok(!env.includes(HOOK_SECRET), "the minted secret was not planted anywhere else either");
	assert.match(h.text(), /WEBHOOK_SECRET already set in \.env — kept/);
	assert.ok(!h.text().includes("operator-chose-this"), "existing values are secrets too");
});

test("setup github: --no-webhook never touches WEBHOOK_SECRET and says the App is hook-inactive", async () => {
	const h = harness({ argv: ["--no-webhook"], files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "y"] });
	assert.equal(await h.run(), 0);
	assert.match(h.store.get(ENV_PATH), /^WEBHOOK_SECRET=$/m, "the empty scaffold line stays empty — nothing will sign deliveries with it");
	assert.doesNotMatch(h.text(), /WEBHOOK_SECRET=<value not shown>/, "no secret line is even offered");
	assert.match(h.text(), /webhook INACTIVE \(--no-webhook\)/);
	assert.match(h.text(), /[Pp]olling/, "the follow-up transport is named so the shape is not a surprise");
	assertNoSecrets(h.text());
});

test("setup github: an existing file at the PEM path is a refusal — key files are never clobbered", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV, [PEM_PATH]: "OLD KEY MATERIAL" }, answers: ["y"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /refusing to overwrite the existing key file/);
	assert.deepEqual(h.writes, [], "nothing was written — not the PEM, not .env");
	assert.equal(h.store.get(PEM_PATH), "OLD KEY MATERIAL", "the old key file is untouched");
	assert.equal(h.store.get(ENV_PATH), SEED_ENV);
});

test("setup github: with no .env, one is created holding exactly the approved lines", async () => {
	const h = harness({ files: {}, answers: ["y", "y", "y"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /no \.env existed here — created one/);
	assert.equal(
		h.store.get(ENV_PATH),
		`GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=4242\nGITHUB_APP_PRIVATE_KEY_PATH=${PEM_PATH}\nWEBHOOK_SECRET=${HOOK_SECRET}\nGITHUB_APP_INSTALLATION_ID=987654\n`,
	);
});

// -- the JWT: decoded, sane, and verifiable against the minted key's public half -----------------------

test("setup github: the installations call carries an RS256 JWT — iss = app id, iat/exp sane, signature verifies", async () => {
	const nowMs = 1_700_000_000_000;
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "y"], nowMs });
	assert.equal(await h.run(), 0);
	const call = h.fetchCalls.find((c) => c.url.endsWith("/app/installations"));
	assert.ok(call, "installations were fetched");
	const jwt = call.opts.headers.authorization.replace(/^Bearer /, "");
	const [headerB64, payloadB64, signatureB64] = jwt.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(headerB64, "base64url").toString()), { alg: "RS256", typ: "JWT" });
	const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
	assert.equal(payload.iss, "4242", "iss is the app id");
	const nowSeconds = Math.floor(nowMs / 1000);
	assert.equal(payload.iat, nowSeconds - 60, "iat is backdated 60s for clock drift");
	assert.equal(payload.exp - payload.iat, 600, "the lifetime stays inside GitHub's 10-minute maximum");
	assert.ok(payload.exp > nowSeconds, "the token is not already expired");
	const verifier = createVerify("RSA-SHA256");
	verifier.update(`${headerB64}.${payloadB64}`);
	assert.ok(verifier.verify(PUBLIC_PEM, Buffer.from(signatureB64, "base64url")), "the signature verifies against the minted key's public half");
	assert.ok(!h.text().includes(jwt), "the JWT is a live credential — never printed");
});

test("mintAppJwt: direct sign/verify roundtrip with a test keypair", () => {
	const jwt = mintAppJwt(7, PRIVATE_PEM, 1000000);
	const [h, p, s] = jwt.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
	assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iat: 999940, exp: 1000540, iss: "7" });
	const verifier = createVerify("RSA-SHA256");
	verifier.update(`${h}.${p}`);
	assert.ok(verifier.verify(PUBLIC_PEM, Buffer.from(s, "base64url")));
});

// -- installation discovery: one / multiple / none / not-yet -------------------------------------------

test("setup github: 'installed?' declined skips discovery entirely and exits 0 with the manual hint", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", ""] });
	assert.equal(await h.run(), 0);
	assert.equal(h.fetchCalls.filter((c) => c.url.endsWith("/app/installations")).length, 0, "no discovery without the operator's say-so");
	assert.match(h.text(), /GITHUB_APP_INSTALLATION_ID=<id>/, "the manual line is spelled out");
	assert.doesNotMatch(h.store.get(ENV_PATH), /GITHUB_APP_INSTALLATION_ID=\d/);
	assert.match(h.text(), /setup github: summary/);
});

test("setup github: multiple installations are listed (login + id) and the chosen one is written", async () => {
	const routes = {
		"/app-manifests/": { status: 201, body: APP },
		"/app/installations": { status: 200, body: [{ id: 11, account: { login: "acme" } }, { id: 22, account: { login: "edgehero" } }] },
	};
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y", "22", "y"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /11\s+acme/);
	assert.match(h.text(), /22\s+edgehero/);
	assert.match(h.store.get(ENV_PATH), /^GITHUB_APP_INSTALLATION_ID=22$/m);
	assert.match(h.text(), /GITHUB_APP_INSTALLATION_ID=22 \(account: edgehero\)/, "the line is shown before the write consent");
});

test("setup github: a blank answer to the multi-installation pick skips gracefully (exit 0, nothing written)", async () => {
	const routes = {
		"/app-manifests/": { status: 201, body: APP },
		"/app/installations": { status: 200, body: [{ id: 11, account: { login: "acme" } }, { id: 22, account: { login: "edgehero" } }] },
	};
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y", ""] });
	assert.equal(await h.run(), 0);
	assert.doesNotMatch(h.store.get(ENV_PATH), /GITHUB_APP_INSTALLATION_ID=\d/);
	assert.match(h.text(), /skipped —/);
});

test("setup github: an answer that is not a listed installation id fails loud with the manual hint", async () => {
	const routes = {
		"/app-manifests/": { status: 201, body: APP },
		"/app/installations": { status: 200, body: [{ id: 11, account: { login: "acme" } }, { id: 22, account: { login: "edgehero" } }] },
	};
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y", "33", "y"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /33 is not one of the listed installation ids/);
	assert.doesNotMatch(h.store.get(ENV_PATH), /GITHUB_APP_INSTALLATION_ID=\d/);
});

test("setup github: zero installations exits 0 gracefully with install + manual guidance", async () => {
	const routes = { "/app-manifests/": { status: 201, body: APP }, "/app/installations": { status: 200, body: [] } };
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /no installations yet/);
	assert.match(h.text(), /https:\/\/github\.com\/apps\/pi-dispatch-testbox\/installations\/new/);
	assert.doesNotMatch(h.store.get(ENV_PATH), /GITHUB_APP_INSTALLATION_ID=\d/);
	assert.match(h.text(), /setup github: summary/);
});

test("setup github: declining the installation-id write keeps .env without it (the id gate is its own)", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "n"] });
	assert.equal(await h.run(), 0);
	assert.doesNotMatch(h.store.get(ENV_PATH), /GITHUB_APP_INSTALLATION_ID=\d/);
	assert.match(h.text(), /declined —/);
});

// -- failure modes: all fail-loud, all with guidance, all scrubbed -------------------------------------

test("setup github: a listener bind failure is a clean 1 with guidance, before anything was created", async () => {
	const h = harness({ listenError: "EADDRINUSE" });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /could not bind a loopback listener \(EADDRINUSE\)/);
	assert.equal(h.fetchCalls.length, 0);
});

test("setup github: timing out waiting for the redirect closes the listener and explains the single-use code", async () => {
	const h = harness({ waitError: "no redirect after 600s" });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /gave up waiting for GitHub's redirect/);
	assert.match(h.text(), /single-use and expires after an hour/);
	assert.equal(h.closedCount(), 1, "the listener is closed on the way out");
	assert.equal(h.fetchCalls.length, 0, "no conversion was attempted without a code");
});

test("setup github: a non-201 conversion shows status + body snippet and names the single-use/1h rule", async () => {
	const routes = { "/app-manifests/": { status: 404, body: { message: "Not Found" } } };
	const h = harness({ routes });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /returned 404 \(expected 201\)/);
	assert.match(h.text(), /Not Found/, "the body snippet is shown — a failed conversion carries no secrets");
	assert.match(h.text(), /SINGLE-USE and expires after one hour/);
});

test("setup github: a conversion network error fails loud with egress guidance", async () => {
	const routes = { "/app-manifests/": new Error("getaddrinfo ENOTFOUND api.github.com") };
	const h = harness({ routes });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /could not reach https:\/\/api\.github\.com/);
	assert.match(h.text(), /ENOTFOUND/);
});

test("setup github: an unparseable 201 body is withheld entirely (it may contain the private key)", async () => {
	const routes = { "/app-manifests/": { status: 201, body: `not json ${HOOK_SECRET} ${CLIENT_SECRET}` } };
	const h = harness({ routes });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /not parseable JSON \(body withheld/);
	assertNoSecrets(h.text());
});

test("setup github: secrets are scrubbed even from a hostile error message on the discovery path", async () => {
	// An error whose message embeds every secret — the scrubber, not luck, is what keeps output clean.
	const routes = {
		"/app-manifests/": { status: 201, body: APP },
		"/app/installations": new Error(`boom ${PRIVATE_PEM} ${HOOK_SECRET} ${CLIENT_SECRET}`),
	};
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /could not reach .* to list installations/);
	assert.match(h.text(), /\[redacted\]/, "the scrubbed placeholder proves the scrubber ran");
	assertNoSecrets(h.text());
	assert.match(h.text(), /credentials above ARE written/, "the operator is told what state they are in");
});

test("setup github: a non-200 installations response fails loud but points at the manual path", async () => {
	const routes = { "/app-manifests/": { status: 201, body: APP }, "/app/installations": { status: 401, body: { message: "bad credentials" } } };
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, routes, answers: ["y", "y"] });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /returned 401/);
	assert.match(h.text(), /GITHUB_APP_INSTALLATION_ID=<id>/);
});

// -- operator ergonomics: the printed URL is the contract, the browser spawn a convenience -------------

test("setup github: both URLs are printed AND handed to the opener; the port-forward hint is up front", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "y"] });
	await h.run();
	assert.deepEqual(h.opened, ["http://127.0.0.1:43210/", "https://github.com/apps/pi-dispatch-testbox/installations/new"]);
	assert.match(h.text(), /http:\/\/127\.0\.0\.1:43210\//, "the form URL is printed for headless operators");
	assert.match(h.text(), /ssh -L 43210:127\.0\.0\.1:43210/, "the remote-server hint names the exact forward");
	assert.match(h.text(), /ON THE MACHINE RUNNING THIS WIZARD/);
});

test("setup github: the webhook-path summary points at the receiver", async () => {
	const h = harness({ files: { [ENV_PATH]: SEED_ENV }, answers: ["y", "y", "y"] });
	await h.run();
	assert.match(h.text(), /setup github: summary/);
	assert.match(h.text(), /pi-dispatch-receiver/);
});

// -- name derivation ------------------------------------------------------------------------------------

test("sanitizeAppName: lowercases, collapses non [a-z0-9-] runs, trims edge hyphens, caps at 34", () => {
	assert.equal(sanitizeAppName("My.Host_Name"), "my-host-name");
	assert.equal(sanitizeAppName("--weird--"), "weird");
	assert.equal(sanitizeAppName("x".repeat(50)).length, 34);
	assert.ok(!sanitizeAppName(`${"x".repeat(33)}-y`).endsWith("-"), "a truncation never leaves a trailing hyphen");
	assert.equal(sanitizeAppName("!!!"), "pi-dispatch", "nothing usable falls back to the bare name");
});

test("defaultAppName: pi-dispatch-<host>, sanitized end-to-end", () => {
	assert.equal(sanitizeAppName(defaultAppName("Robs-MacBook.local")), "pi-dispatch-robs-macbook-local");
});

test("setup github: an over-long --name is sanitized into the manifest", async () => {
	const h = harness({ argv: ["--no-webhook", "--name", "My Very Long And Fancy App Name For GitHub"], answers: [""] });
	await h.run();
	const manifest = embeddedManifest(h.getPageFor()("http://127.0.0.1:43210"));
	assert.equal(manifest.name, "my-very-long-and-fancy-app-name-fo");
	assert.ok(manifest.name.length <= 34);
});
