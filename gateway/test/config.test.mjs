import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { logsDirPath } from "@edgehero/pi-dispatch/config";
import { readConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { consoleConfig } from "../../admin/src/console/config.mjs";
import { gatewayRandom } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { makeGatewayAudit } from "../src/audit.mjs";
import { GATEWAY_DEPLOYMENT_KEYS, readGatewayConfig, validateGatewayConfig } from "../src/config.mjs";

const raw = (deployment) => ({ version: 1, origin: "https://gateway.example", consoleOrigin: "https://console.example", host: "host-a", deployment, sockets: { local: "/var/run/docker.sock", podman: "/run/user/1001/podman/podman.sock" } });
test("protected enrollment names one host and explicit runtime sockets without ambient authority", () => {
	assert.equal(validateGatewayConfig(raw("/deployment")).listen.host, "127.0.0.1");
	for (const mutate of [r => ({ ...r, token: "PRIVATE" }), r => ({ ...r, consoleOrigin: "https://gateway.example:7777" }), r => ({ ...r, sockets: { local: "tcp://runtime:1234" } }), r => ({ ...r, origin: "http://gateway.example" }), r => ({ ...r, listen: { host: "0.0.0.0", port: 8788 }, origin: "http://localhost:8788" })]) assert.throws(() => validateGatewayConfig(mutate(raw("/deployment"))));
});

test("the service reader takes only reviewed gateway keys, resolves host-relative logs and preserves host idle policy", () => {
	const dir = tempDir("gateway-config-");
	mkdirSync(join(dir, "deployment"));
	writeFileSync(join(dir, "deployment/.env"), "PI_WORKER_NAME=host-a\nPI_SANDBOX_IDLE_MINUTES=2000\nPI_LOGS_DIR=logs\nVALKEY_URL=redis://127.0.0.1:6379\nOPENAI_API_KEY=PRIVATE_PROVIDER\nGITHUB_TOKEN=PRIVATE_FORGE\n", { mode: 0o600 });
	const path = join(dir, "gateway.json"); writeFileSync(path, JSON.stringify(raw(join(dir, "deployment"))), { mode: 0o600 });
	const config = readGatewayConfig(path);
	assert.equal(config.idleMinutes, 2000);
	assert.equal(config.logsDir, join(dir, "deployment/logs"));
	assert.deepEqual(Object.keys(config.env).sort(), ["PI_WORKER_NAME", "PI_SANDBOX_IDLE_MINUTES", "PI_LOGS_DIR", "VALKEY_URL"].sort());
	assert.doesNotMatch(JSON.stringify(config), /PRIVATE_PROVIDER|PRIVATE_FORGE/);
	assert.ok(GATEWAY_DEPLOYMENT_KEYS.every(k => !/OPENAI|GITHUB|SECRET|TOKEN/.test(k)));
	chmodSync(path, 0o666); assert.throws(() => readGatewayConfig(path), /trusted regular file/);
});

// The deployment and its enrollment as the operator writes them, with `lines` as the deployment `.env`'s other lines.
function enrolled(lines) {
	const dir = tempDir("gateway-logs-"), deployment = join(dir, "deployment");
	mkdirSync(deployment);
	writeFileSync(join(deployment, ".env"), `PI_WORKER_NAME=host-a\n${lines}`, { mode: 0o600 });
	const path = join(dir, "gateway.json"); writeFileSync(path, JSON.stringify(raw(deployment)), { mode: 0o600 });
	return { dir, deployment, path };
}
const under = (parent, child) => { const rel = relative(parent, child); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };

test("with PI_LOGS_DIR unset or blank the gateway takes the worker's and the console's default, never a folder under the deployment", () => {
	for (const lines of ["", "PI_LOGS_DIR=\n"]) {
		const { dir, deployment, path } = enrolled(lines), home = join(dir, "home");
		const config = readGatewayConfig(path, { home });
		assert.equal(config.logsDir, join(home, ".pi-dispatch/logs"), JSON.stringify(lines));
		assert.equal(config.logsDir, logsDirPath({}, home), "the one derivation the worker and the console use");
		assert.equal(readGatewayConfig(path).logsDir, resolve(deployment, logsDirPath({})), "production reads this account's home");
		assert.equal(readGatewayConfig(path).logsDir, consoleConfig({ env: {}, dir: deployment }).logsDir, "the console's own setting for the same deployment");
		assert.equal(readGatewayConfig(path, { home: "" }).logsDir, logsDirPath({}, ""), "and with no home, the same fallback");
		for (const h of [home, undefined, ""]) assert.equal(under(deployment, readGatewayConfig(path, { home: h }).logsDir), false, `${JSON.stringify(lines)} ${h}`);
	}
	const elsewhere = join(tempDir("gateway-logs-abs-"), "logs"), { dir, path } = enrolled(`PI_LOGS_DIR=${elsewhere}\n`);
	assert.equal(readGatewayConfig(path, { home: join(dir, "home") }).logsDir, elsewhere, "an absolute PI_LOGS_DIR is kept as written");
});

test("with PI_LOGS_DIR unset, a browser attach is a row in the audit log the console reads and nothing lands in <deployment>/logs", async () => {
	const { dir, deployment, path } = enrolled(""), home = join(dir, "home");
	const logsDir = readGatewayConfig(path, { home }).logsDir;
	// Checked before anything is written: with a broken seam this test would append to the real audit log of whoever runs it.
	assert.equal(logsDir, join(home, ".pi-dispatch/logs"));
	const journal = makeGatewayAudit({ logsDir, now: () => Date.UTC(2026, 10, 3), pidAlive: () => false });
	const intent = { actor: { name: "ops", role: "operator", session: "a".repeat(12) }, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" } };
	const id = gatewayRandom(); await journal.record("opening", intent, id); await journal.record("open", intent, id);
	// The console's own derivation (admin/src/console/config.mjs, `logsDir`): logsDirPath resolved against its folder.
	const read = readConsoleAudit({ logsDir: resolve(deployment, logsDirPath({}, home)) });
	assert.deepEqual(read.rows.map((r) => r.kind).sort(), ["sandbox-browser-open", "sandbox-browser-opening"]);
	assert.equal(existsSync(join(deployment, "logs")), false);
});
