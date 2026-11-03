import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
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
