import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_PACKAGE, restoreEnvProxyDispatcher } from "../src/env-proxy.mjs";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeUndici() {
	const installed = [];
	class EnvHttpProxyAgent {}
	return { installed, EnvHttpProxyAgent, setGlobalDispatcher: (d) => installed.push(d) };
}

test("an env-proxy dispatcher is installed exactly when the worker armed one (issue #427)", () => {
	const undici = fakeUndici();
	assert.equal(restoreEnvProxyDispatcher({ env: { NODE_USE_ENV_PROXY: "1" }, loadUndici: () => undici }), true);
	assert.equal(undici.installed.length, 1);
	assert.ok(undici.installed[0] instanceof undici.EnvHttpProxyAgent);
});

test("with no policy armed, pi's dispatcher is left alone and undici is not even loaded", () => {
	for (const env of [{}, { NODE_USE_ENV_PROXY: "0" }, { NODE_USE_ENV_PROXY: "" }, { HTTPS_PROXY: "http://p:3128" }]) {
		const loadUndici = () => assert.fail(`loaded undici for ${JSON.stringify(env)}`);
		assert.equal(restoreEnvProxyDispatcher({ env, loadUndici }), false);
	}
});

test("run-job.mjs restores the dispatcher after pi is loaded and before auth, the model or any spend", () => {
	const src = readFileSync(join(RUNNER_DIR, "run-job.mjs"), "utf8");
	const call = src.indexOf("\trestoreEnvProxyDispatcher();");
	assert.ok(call > 0, "run-job.mjs no longer calls restoreEnvProxyDispatcher()");
	assert.ok(call > src.indexOf("enforceOfflineMode(process.env);"), "called before the offline mode is enforced");
	assert.ok(call < src.indexOf("AuthStorage.create("), "called after auth is built");
	assert.ok(call < src.indexOf("createAgentSession("), "called after the session is created");
});

/**
 * The real pi, the real `undici` it resolves, and a real `fetch`, in a child process so the dispatcher it installs
 * cannot leak into this one. The "proxy" is a local server that accepts the tunnel and answers through it itself, and the
 * target is a `.invalid` name (RFC 2606), which no resolver answers: a request that reaches the server went through
 * the proxy, and one that tried to go direct fails to resolve. Nothing leaves the machine either way.
 */
let piImportable = true;
try {
	await import(PI_PACKAGE);
} catch {
	piImportable = false;
}
if (!piImportable && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") {
	throw new Error(`${PI_PACKAGE} must be importable here; a skip would hide issue #427 coming back.`);
}
const skip = piImportable ? false : "pi not installed; CI runs these";

async function fetchAfterPi({ restore }) {
	const seen = [];
	// undici's proxy agent TUNNELS every request, http:// ones included (a plain request handler never sees it and the
	// fetch hangs), so this answers CONNECT, as squid does for the provider's https, and then plays the origin itself.
	const server = createServer((req, res) => res.writeHead(405).end());
	server.on("connect", (req, socket) => {
		seen.push(req.url);
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy"));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const proxy = `http://127.0.0.1:${server.address().port}`;
	const script = `
		// The restoring path is loadPiThenRestore, the one doctor's canary takes; the runner's own static import followed
		// by restoreEnvProxyDispatcher() is the same two steps, and the order in run-job.mjs is pinned above.
		if (${restore}) await (await import(${JSON.stringify(pathToFileURL(join(RUNNER_DIR, "src/env-proxy.mjs")).href)})).loadPiThenRestore();
		else await import(${JSON.stringify(PI_PACKAGE)});
		try {
			const res = await fetch("http://pi-dispatch-427.invalid/");
			console.log("reached", res.status, await res.text());
		} catch (error) {
			console.log("direct", error.cause?.code ?? error.message);
		}
		// The proxy connection is kept alive and would hold this child open until the timeout.
		process.exit(0);`;
	try {
		const stdout = await new Promise((resolve, reject) =>
			execFile(
				process.execPath,
				["--no-warnings", "--input-type=module", "-e", script],
				{ cwd: RUNNER_DIR, timeout: 30_000, env: { PATH: process.env.PATH, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "", NODE_USE_ENV_PROXY: "1" } },
				(error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out.trim())),
			),
		);
		return { stdout, seen };
	} finally {
		server.close();
	}
}

test("after pi is loaded, a provider fetch goes through the proxy once the runner restores the dispatcher", { skip }, async () => {
	const { stdout, seen } = await fetchAfterPi({ restore: true });
	assert.equal(stdout, "reached 200 via-proxy");
	assert.deepEqual(seen, ["pi-dispatch-427.invalid:80"]);
});

test("control: without the restore the same fetch never reaches the proxy", { skip }, async () => {
	// On a Node that honours NODE_USE_ENV_PROXY (22.21 and later, the image's 22.23 among them) this is pi's import
	// taking the proxy away; on an older one the flag was never read. Either way the proxy must see nothing, which
	// is what shows the positive case above is the restore and not the environment.
	const { stdout, seen } = await fetchAfterPi({ restore: false });
	assert.match(stdout, /^direct /);
	assert.deepEqual(seen, []);
});
