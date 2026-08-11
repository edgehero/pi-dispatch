/**
 * `pi-dispatch setup github` — mint GitHub App credentials via the App Manifest flow (issue #81,
 * DES-GH-APP-MANIFEST-SETUP).
 *
 * Today the App source is the strongest credential this system supports (per-repo, one-hour
 * installation tokens — CONST-TOKEN-SCOPED-PER-JOB) and also the most manual mile of setup: five
 * settings pages, a hand-invented webhook secret, an installation id hunted out of URLs. The manifest
 * flow compresses all of it into ONE browser click: a throwaway listener on this machine's loopback
 * serves a self-submitting form that POSTs the manifest to github.com, GitHub bounces the browser back
 * to the listener with a single-use code (valid 1h), and the UNAUTHENTICATED
 * `POST /app-manifests/{code}/conversions` returns `{ id, slug, pem, webhook_secret, … }` in one
 * response.
 *
 * Trust framing, which every edit here must preserve: NOTHING crosses a maintainer-controlled
 * service. The listener is the operator's own 127.0.0.1; GitHub is the only remote party; the
 * conversion code is single-use and expires. The wizard's own doctrine on top of that:
 *
 *   - There is deliberately NO `--yes` flag. Unlike `up`'s docker actions, every write here carries a
 *     credential (a private key, a webhook secret, the auth source the worker will boot with), so each
 *     one is shown verbatim and individually consented — a wizard that can be waved through end-to-end
 *     is a wizard that writes keys nobody looked at.
 *   - Secrets never reach output. The pem, webhook_secret, and client_secret are registered with a
 *     scrubber the moment they exist, and EVERY byte this module prints — including error paths —
 *     passes through it. The .env plan names keys and paths, never secret values.
 *   - The PEM lands mode 0600 and NEVER clobbers: an existing file at the target path is a refusal,
 *     because overwriting a key file destroys a credential this tool cannot restore.
 *   - An existing WEBHOOK_SECRET is kept (setEnvKeyIfEmpty): the operator's configured forge hooks
 *     verify against it, and rotating it here would silently break every working delivery. The three
 *     values the operator DID just consent to replacing (source, app id, key path) go through the
 *     overwrite transform — the consent prompt above is exactly the gate env-file.mjs documents.
 *
 * Everything side-effecting is injected (fetch, the listener, the browser opener, prompt, fs, clock),
 * defaulting to the real thing — the up.mjs convention — so the whole flow is testable offline.
 */
import { createSign } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { updateEnvFile } from "./env-file.mjs";
import { openBrowser as defaultOpenBrowser } from "./open-browser.mjs";
import { defaultPrompt } from "./up.mjs";

const API_ROOT = "https://api.github.com";
// GitHub rejects requests without a User-Agent, and node's fetch does not always send one.
const USER_AGENT = "pi-dispatch-setup-github";
// The repo homepage, shown on the App's about page — informational, not a trust anchor.
const HOMEPAGE = "https://github.com/edgehero/pi-dispatch";
// GitHub app names are GLOBALLY unique and capped at 34 characters.
const NAME_MAX = 34;

const FLAG_HELP = `usage: pi-dispatch setup github (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]

  --webhook-url <URL>  the public URL of your pi-dispatch-receiver — GitHub delivers events there
  --no-webhook         create the App with its webhook INACTIVE (the polling-ready shape; no public URL needed)
  --org <org>          create the App under an organization instead of your user account
  --name <appName>     the App's name (globally unique on GitHub, max ${NAME_MAX} chars; default pi-dispatch-<host>)`;

/**
 * Run the wizard. `deps` (all injected, all defaulted):
 *   env, fetchFn, listen, openBrowser, out, prompt, fs, cwd, now — plus codeTimeoutMs, the ceiling on
 *   how long the listener waits for the browser to come back with the conversion code.
 */
export async function runGithubAppSetup(argv = [], deps = {}) {
	const {
		env = process.env,
		fetchFn = fetch,
		listen = defaultListen,
		openBrowser = defaultOpenBrowser,
		out = (s) => process.stdout.write(s),
		prompt = defaultPrompt,
		fs = { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync },
		cwd = process.cwd(),
		now = () => Date.now(),
		codeTimeoutMs = 600000, // ~10 min for a human to click through GitHub's create-app page
	} = deps;

	// Every byte printed goes through the scrubber. Secrets are registered the moment they exist, so
	// even an error path that stringifies something secret-bearing cannot leak it into a scrollback.
	const secrets = [];
	const scrub = (s) => secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), String(s));
	const say = (s) => out(scrub(s));
	const summary = [];

	// -- flags ------------------------------------------------------------------------------------
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				org: { type: "string" },
				name: { type: "string" },
				"webhook-url": { type: "string" },
				"no-webhook": { type: "boolean", default: false },
			},
		}));
	} catch (error) {
		say(`error: ${error.message}\n\n${FLAG_HELP}\n`);
		return 1;
	}
	const webhookUrl = values["webhook-url"];
	const noWebhook = values["no-webhook"];
	// Deliberately UNDEFAULTED, like GITLAB_WEBHOOK_MODE: a receiver URL cannot be guessed, and
	// silently creating a hook-inactive App for an operator who wanted deliveries is the kind of
	// "helpful" default that surfaces as a webhook that never fires.
	if (!webhookUrl && !noWebhook) {
		say(`error: choose a webhook shape — pass --webhook-url <public receiver URL>, or --no-webhook for the hook-inactive (polling-ready) shape\n\n${FLAG_HELP}\n`);
		return 1;
	}
	if (webhookUrl && noWebhook) {
		say(`error: --webhook-url and --no-webhook contradict each other — pass exactly one\n\n${FLAG_HELP}\n`);
		return 1;
	}
	const appName = sanitizeAppName(values.name ?? defaultAppName(hostname()));
	const postTarget = values.org
		? `https://github.com/organizations/${encodeURIComponent(values.org)}/settings/apps/new`
		: "https://github.com/settings/apps/new";

	say("pi-dispatch setup github — mint GitHub App credentials in one browser click (App Manifest flow)\n");
	say("nothing is written locally without your explicit consent; secrets are never printed\n\n");

	// -- (b) loopback listener + the self-submitting form -----------------------------------------
	// The manifest flow REQUIRES a browser form POST — a plain link cannot carry the payload — so the
	// listener serves GET / (the auto-submitting form) and GET /callback?code=… (the bounce-back).
	// The manifest is built lazily against the listener's final URL, because redirect_url needs the port.
	let listener;
	try {
		listener = await listen((baseUrl) =>
			buildFormPage(buildManifest({ name: appName, redirectUrl: `${baseUrl}/callback`, webhookUrl: noWebhook ? undefined : webhookUrl }), postTarget),
		);
	} catch (error) {
		say(`error: could not bind a loopback listener (${error?.message ?? "unknown"})\n`);
		say("    → nothing was created or written; free a local port (the listener picks a random one on 127.0.0.1) and re-run `pi-dispatch setup github`\n");
		return 1;
	}

	try {
		say(`Open this URL in a browser to create the App (name: ${appName}, target: ${values.org ? `org ${values.org}` : "your user account"}):\n\n`);
		say(`  ${listener.url}/\n\n`);
		// The redirect lands on THIS machine's 127.0.0.1 — said out loud, because on a remote server
		// the browser cannot reach it without help, and the failure mode otherwise is a silent hang.
		say(`note: GitHub will redirect the browser back to 127.0.0.1:${listener.port} ON THE MACHINE RUNNING THIS WIZARD.\n`);
		say(`      Setting up a remote server? Open the URL in a browser on that machine, or forward the port first:\n`);
		say(`      ssh -L ${listener.port}:127.0.0.1:${listener.port} <your-server>   then open the URL locally.\n\n`);
		openBrowser(`${listener.url}/`);

		let code;
		try {
			code = await listener.waitForCode(codeTimeoutMs);
		} catch (error) {
			say(`error: gave up waiting for GitHub's redirect (${error?.message ?? "timeout"})\n`);
			say("    → no credentials were minted or written. If you completed the GitHub page after the timeout, the App may\n");
			say("      exist without local credentials — delete it under Settings → Developer settings → GitHub Apps, then\n");
			say("      re-run `pi-dispatch setup github` (each conversion code is single-use and expires after an hour)\n");
			return 1;
		}

		// -- (c) the conversion: code -> credentials. UNAUTHENTICATED by design (the code IS the proof),
		// single-use, valid 1h.
		let response;
		try {
			response = await fetchFn(`${API_ROOT}/app-manifests/${encodeURIComponent(code)}/conversions`, {
				method: "POST",
				headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
			});
		} catch (error) {
			say(`error: could not reach ${API_ROOT} to convert the manifest code (${error?.message ?? "network error"})\n`);
			say("    → check this machine's network egress and re-run `pi-dispatch setup github`; the code is single-use, so a fresh run mints a fresh one\n");
			return 1;
		}
		const body = await response.text();
		if (response.status !== 201) {
			// A failed conversion carries no secrets (that is the failure), so a snippet is safe — and
			// still scrubbed, one rule for all output.
			say(`error: the manifest conversion returned ${response.status} (expected 201): ${body.slice(0, 300)}\n`);
			say("    → the conversion code is SINGLE-USE and expires after one hour — a re-used or stale code fails exactly like this. Re-run `pi-dispatch setup github` for a fresh one\n");
			return 1;
		}
		let app;
		try {
			app = JSON.parse(body);
		} catch {
			// The 201 body carries the private key, so on a parse failure it is NEVER echoed.
			say("error: GitHub's conversion response was not parseable JSON (body withheld — it may contain the private key)\n");
			say("    → the App may now exist on GitHub without local credentials; check Settings → Developer settings → GitHub Apps, delete it, and re-run\n");
			return 1;
		}
		// Register the secrets BEFORE any further printing — from here on nothing can echo them.
		for (const secret of [app.pem, app.webhook_secret, app.client_secret]) {
			if (typeof secret === "string" && secret !== "") secrets.push(secret);
		}
		if (!app.id || !app.slug || !app.pem) {
			say("error: the conversion response is missing id/slug/pem — refusing to continue (response withheld; it may contain credentials)\n");
			return 1;
		}

		// -- (d) show EXACTLY what would be written, then ONE consent -----------------------------
		const pemPath = join(cwd, `github-app-${app.slug}.pem`);
		const envPath = join(cwd, ".env");
		// The secret is only worth writing when the App actually delivers webhooks: under --no-webhook
		// nothing will ever sign a delivery with it, and planting it would only shadow whatever the
		// operator sets when they wire a real receiver later.
		const offerSecret = !noWebhook && typeof app.webhook_secret === "string" && app.webhook_secret !== "";
		say(`\nGitHub created the App "${app.slug}" (id ${app.id}). Nothing is written locally yet.\n\n`);
		say("setup would write:\n");
		say(`  ${pemPath}\n`);
		say("      the App's private key, mode 0600 (contents never shown; refuses if the file already exists)\n");
		say(`  ${envPath}\n`);
		say("      GITHUB_AUTH_SOURCE=app\n");
		say(`      GITHUB_APP_ID=${app.id}\n`);
		say(`      GITHUB_APP_PRIVATE_KEY_PATH=${pemPath}\n`);
		if (offerSecret) {
			say("      WEBHOOK_SECRET=<value not shown> — only if .env has none; an existing secret is KEPT, because your configured hooks verify deliveries against it\n");
		}
		if (!(await consent(prompt, "write these? [y/N] "))) {
			say("\ndeclined — nothing was written locally.\n");
			say(`note: the App itself DOES now exist on GitHub: ${app.html_url ?? `https://github.com/apps/${app.slug}`}\n`);
			say("      to remove it: its settings page → Advanced → Delete GitHub App (or keep it and re-run setup later — a fresh run mints a fresh key)\n");
			return 0;
		}

		// -- (e) the consented writes -------------------------------------------------------------
		// Key files are never clobbered: the old file may be the only copy of a credential still in
		// use somewhere, and this tool cannot restore what it overwrites.
		if (fs.existsSync(pemPath)) {
			say(`error: refusing to overwrite the existing key file at ${pemPath}\n`);
			say("    → move or delete it first (is another App's key living there?), then re-run `pi-dispatch setup github`. Nothing was written\n");
			return 1;
		}
		fs.writeFileSync(pemPath, app.pem, { mode: 0o600 });
		summary.push(["private key", `written to ${pemPath} (mode 0600)`]);
		if (!fs.existsSync(envPath)) {
			// The consent above was for ".env lines"; with no .env the lines need a file. Created
			// EMPTY here (not scaffolded — that is init's job) so the consented lines are all it gains.
			fs.writeFileSync(envPath, "");
			say(`note: no .env existed here — created one for the lines you approved\n`);
		}
		updateEnvFile(envPath, "GITHUB_AUTH_SOURCE", "app", { fs, overwrite: true });
		updateEnvFile(envPath, "GITHUB_APP_ID", String(app.id), { fs, overwrite: true });
		updateEnvFile(envPath, "GITHUB_APP_PRIVATE_KEY_PATH", pemPath, { fs, overwrite: true });
		summary.push(["auth source", "GITHUB_AUTH_SOURCE=app (+ app id and key path) written to .env"]);
		if (offerSecret) {
			// setEnvKeyIfEmpty, NOT overwrite: an operator's existing webhook secret is what their
			// already-configured hooks sign with — replacing it would invalidate working deliveries.
			const { changed } = updateEnvFile(envPath, "WEBHOOK_SECRET", app.webhook_secret, { fs });
			say(changed ? "✓ WEBHOOK_SECRET set in .env (value not shown)\n" : "✓ WEBHOOK_SECRET already set in .env — kept (your configured hooks keep verifying)\n");
			summary.push(["WEBHOOK_SECRET", changed ? "set from the App's minted secret (value not shown)" : "already set — kept, so existing deliveries stay valid"]);
		}
		say(`✓ credentials written\n`);

		// -- (f) install, then discover the installation id ---------------------------------------
		const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
		say(`\nInstall the App on the repositories it should work on (a GitHub consent screen — deliberately not automated):\n\n  ${installUrl}\n\n`);
		openBrowser(installUrl);
		const manualIdHint = `find the id later under the App's settings → Install App (the number in the installation URL), then set GITHUB_APP_INSTALLATION_ID=<id> in ${envPath}`;
		if (!(await consent(prompt, "installed? [y/N] "))) {
			say(`\nno problem — install it whenever you like at the URL above; ${manualIdHint}\n`);
			summary.push(["installation id", "not discovered (App not installed yet) — set GITHUB_APP_INSTALLATION_ID by hand after installing"]);
			printSummary(say, summary, { noWebhook });
			return 0;
		}
		// A ~15-line hand-rolled RS256 JWT (mintAppJwt below), deliberately NOT @octokit/auth-app:
		// this runs once at setup time, and a dependency-light, auditable JWT is worth more here than
		// library reuse — the operator can read every byte that touches their brand-new key. Job-time
		// minting (get-token.mjs) keeps using @octokit/auth-app, unchanged.
		const jwt = mintAppJwt(app.id, app.pem, Math.floor(now() / 1000));
		secrets.push(jwt); // short-lived, but a valid credential for ~9 minutes — same no-print rule
		let instResponse;
		let instBody;
		try {
			instResponse = await fetchFn(`${API_ROOT}/app/installations`, {
				headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT },
			});
			instBody = await instResponse.text();
		} catch (error) {
			say(`error: could not reach ${API_ROOT} to list installations (${error?.message ?? "network error"})\n`);
			say(`    → the credentials above ARE written and valid; ${manualIdHint}\n`);
			return 1;
		}
		if (instResponse.status !== 200) {
			say(`error: GET /app/installations returned ${instResponse.status} (expected 200): ${String(instBody).slice(0, 300)}\n`);
			say(`    → the credentials above ARE written; ${manualIdHint}\n`);
			return 1;
		}
		let installations;
		try {
			installations = JSON.parse(instBody);
		} catch {
			say(`error: GitHub's installations response was not parseable JSON\n    → ${manualIdHint}\n`);
			return 1;
		}

		let chosen;
		if (installations.length === 0) {
			say(`\nGitHub reports no installations yet — the install may still be in flight.\n`);
			say(`    → install at ${installUrl}, then ${manualIdHint}\n`);
			summary.push(["installation id", "none found — install the App, then set GITHUB_APP_INSTALLATION_ID by hand"]);
			printSummary(say, summary, { noWebhook });
			return 0;
		}
		if (installations.length === 1) {
			chosen = installations[0];
		} else {
			say("\nthe App is installed in more than one place:\n");
			for (const inst of installations) say(`  ${String(inst.id).padEnd(12)} ${inst.account?.login ?? "(unknown account)"}\n`);
			const answer = String((await prompt("installation id to use (blank to skip): ")) ?? "").trim();
			if (answer === "") {
				say(`skipped — ${manualIdHint}\n`);
				summary.push(["installation id", "skipped — set GITHUB_APP_INSTALLATION_ID by hand"]);
				printSummary(say, summary, { noWebhook });
				return 0;
			}
			chosen = installations.find((inst) => String(inst.id) === answer);
			if (!chosen) {
				say(`error: ${answer} is not one of the listed installation ids\n    → ${manualIdHint}\n`);
				return 1;
			}
		}
		// Consented and shown first, like every other write in this wizard — an id is not a secret,
		// so this one IS printed in full.
		say(`\nsetup would write to ${envPath}:\n      GITHUB_APP_INSTALLATION_ID=${chosen.id}${chosen.account?.login ? ` (account: ${chosen.account.login})` : ""}\n`);
		if (await consent(prompt, "write it? [y/N] ")) {
			updateEnvFile(envPath, "GITHUB_APP_INSTALLATION_ID", String(chosen.id), { fs, overwrite: true });
			say("✓ GITHUB_APP_INSTALLATION_ID written\n");
			summary.push(["installation id", `GITHUB_APP_INSTALLATION_ID=${chosen.id} written to .env`]);
		} else {
			say(`declined — ${manualIdHint}\n`);
			summary.push(["installation id", "declined — set GITHUB_APP_INSTALLATION_ID by hand"]);
		}

		// -- (g) summary ---------------------------------------------------------------------------
		printSummary(say, summary, { noWebhook });
		return 0;
	} finally {
		listener.close();
	}
}

/** What was written and what remains — up.mjs's summary voice, so the two wizards read as one tool. */
function printSummary(say, summary, { noWebhook }) {
	say("\nsetup github: summary\n");
	for (const [name, note] of summary) say(`  ${name.padEnd(17)} ${note}\n`);
	say("\nNext:\n");
	if (noWebhook) {
		say("  the App was created with its webhook INACTIVE (--no-webhook) — the polling-ready shape.\n");
		say("  Polling delivery is a follow-up; until it lands, forge triggers for this App will not fire on their own.\n");
	} else {
		say("  start the receiver so deliveries have somewhere to land: `pi-dispatch-receiver`\n");
		say("  (or the deploy/docker-compose.yml receiver profile), reachable at the --webhook-url you gave GitHub.\n");
	}
	say("  `pi-dispatch doctor` re-checks the whole deployment, including these credentials.\n");
}

/** up.mjs's consent contract: default No; only an explicit y/yes (any case) accepts. */
async function consent(prompt, question) {
	const answer = await prompt(question);
	return /^y(es)?$/i.test(String(answer ?? "").trim());
}

/** `pi-dispatch-<host>`, before sanitization — split out so the derivation is testable without os. */
export function defaultAppName(host) {
	return `pi-dispatch-${host ?? ""}`;
}

/**
 * Fit a name into GitHub's App-name rules: ≤34 chars, and kept to lowercase letters, digits, and
 * hyphens so the name survives GitHub's own slugging predictably (the slug becomes the install URL
 * and the PEM filename). Anything else collapses to a hyphen; runs and edge hyphens are trimmed.
 */
export function sanitizeAppName(raw) {
	const cleaned = String(raw ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, NAME_MAX)
		.replace(/-$/, "");
	return cleaned || "pi-dispatch";
}

/**
 * The manifest GitHub converts into the App — the narrowest shape this system needs
 * (SECURITY.md's auth-source ladder): write on exactly the three surfaces jobs touch, metadata read
 * because the API requires it, private, and only the event families the triggers file can name.
 * `hook_attributes` carries the receiver URL, or `active: false` under --no-webhook — the
 * no-public-URL shape the polling transport will consume.
 *
 * `pull_request_review` (issue #66) is subscribed for every new App, armed trigger or not. That is the
 * posture `pull_request` already has for a label-only deployment: an unsubscribed event cannot be turned
 * on later without a visit to the App's settings page, while a subscribed one an operator does not want
 * costs a 204 and a log line. Existing Apps predate this and must add the event by hand.
 */
export function buildManifest({ name, redirectUrl, webhookUrl }) {
	return {
		name,
		url: HOMEPAGE,
		redirect_url: redirectUrl,
		hook_attributes: webhookUrl ? { url: webhookUrl } : { active: false },
		public: false,
		default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
		default_events: ["issues", "issue_comment", "pull_request", "pull_request_review"],
	};
}

/**
 * The page the loopback listener serves at GET /: a form that POSTs `manifest=<json>` to the GitHub
 * create-from-manifest endpoint. A FORM, not a link, because the manifest flow requires the payload
 * in a browser POST body. Auto-submits via script; the visible button is the no-JS fallback and the
 * human-readable statement of what is about to be sent where.
 */
export function buildFormPage(manifest, postTarget) {
	const json = escapeHtml(JSON.stringify(manifest));
	const target = escapeHtml(postTarget);
	return `<!doctype html>
<meta charset="utf-8">
<title>pi-dispatch setup github</title>
<body>
<p>Submitting the GitHub App manifest to <code>${target}</code> …</p>
<form id="m" action="${target}" method="post">
	<input type="hidden" name="manifest" value="${json}">
	<button type="submit">Create the GitHub App</button>
</form>
<script>document.getElementById("m").submit();</script>
</body>`;
}

function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * An RS256 app JWT, hand-rolled on node:crypto — deliberately NOT @octokit/auth-app, although it is
 * already a dependency: this signature runs ONCE at setup time with a key minted seconds ago, and
 * ~15 auditable lines the operator can read beat a library call they have to trust. `iat` is
 * backdated 60s (GitHub's own clock-drift allowance) and `exp` stays inside the 10-minute maximum.
 * `iss` is the app id, stringified — GitHub accepts either form.
 */
export function mintAppJwt(appId, pem, nowSeconds) {
	const b64url = (s) => Buffer.from(s).toString("base64url");
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const iat = nowSeconds - 60;
	const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	const signature = signer.sign(pem).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

/**
 * The default listener seam: node:http on 127.0.0.1, port 0 (kernel-assigned, so nothing collides).
 * Serves GET / with `pageFor(url)` (built lazily — the manifest's redirect_url needs the final port)
 * and GET /callback?code=… as the capture. Returns exactly `{ port, url, waitForCode, close }`;
 * `waitForCode(timeoutMs)` resolves with the code or rejects on timeout. Loopback-only by
 * construction: the bind address is 127.0.0.1, so nothing off-machine can reach the form or the code.
 */
async function defaultListen(pageFor) {
	const { createServer } = await import("node:http");
	let resolveCode;
	const codePromise = new Promise((resolve) => {
		resolveCode = resolve;
	});
	let url = "";
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url, "http://127.0.0.1");
		if (req.method === "GET" && requestUrl.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(pageFor(url));
			return;
		}
		if (req.method === "GET" && requestUrl.pathname === "/callback") {
			const code = requestUrl.searchParams.get("code");
			if (!code) {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("missing ?code — this URL is GitHub's redirect target, not a page to open by hand\n");
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<!doctype html><meta charset=\"utf-8\"><p>Got it — return to the terminal running <code>pi-dispatch setup github</code>. You can close this tab.</p>");
			resolveCode(code);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found\n");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	url = `http://127.0.0.1:${port}`;
	return {
		port,
		url,
		waitForCode: (timeoutMs) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no redirect after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
				codePromise.then((code) => {
					clearTimeout(timer);
					resolve(code);
				});
			}),
		close: () => server.close(),
	};
}

// The best-effort platform opener moved to its own module (issue #54) so the admin's graph export
// shares this one reviewed argv table instead of hand-copying it; the print-the-URL-first doctrine
// lives in its docstring and is unchanged here.
