#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeRedisClient, valkeyContextFromKeys } from "@edgehero/pi-dispatch/connection";
import { makeGatewayStore } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { readGatewayConfig } from "./config.mjs";
import { makeGatewayRuntime } from "./runtime.mjs";
import { makeGatewayAudit } from "./audit.mjs";
import { createGatewayServer } from "./server.mjs";

export async function startGateway(config, { assets = null, readFile = readFileSync, makeClient = makeRedisClient, runtime = makeGatewayRuntime({ sockets: config.sockets }), journal = makeGatewayAudit({ logsDir: config.logsDir }), log = (word) => process.stderr.write(`${word}\n`) } = {}) {
	const source = assets ?? Object.fromEntries([["script", "gateway.js"], ["terminalScript", "terminal.js"], ["css", "gateway.css"]].map(([key, file]) => [key, readFile(new URL(`./static/${file}`, import.meta.url), "utf8")]));
	const redis = makeClient(config.env.VALKEY_URL ?? "redis://127.0.0.1:6379", { context: valkeyContextFromKeys({ env: config.env, fileKeys: config.env, envPath: `${config.deployment}/.env` }), noOfflineQueue: true, lazyConnect: true, disconnectTimeoutMs: 0 });
	redis.on("error", () => log("gateway_control_unavailable"));
	try {
		await redis.connect();
		journal.recover();
		const app = createGatewayServer({ config, store: makeGatewayStore({ redis }), runtime, assets: source, audit: journal.record, log });
		await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(config.listen.port, config.listen.host, resolve); });
		return { ...app, async close() { try { await app.close(); } finally { redis.disconnect(); } } };
	} catch (error) { redis.disconnect(); throw error; }
}

export async function runGateway(argv = process.argv.slice(2), { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
	let app;
	try {
		const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { config: { type: "string" }, help: { type: "boolean" } } });
		if (values.help) { out("pi-dispatch-sandbox-gateway --config /absolute/gateway.json\nStarts an explicitly enrolled gateway for existing sandbox shells. Off unless started.\n"); return 0; }
		if (!values.config || positionals.length) throw new Error("--config is required");
		const config = readGatewayConfig(values.config);
		// A dedicated gateway process needs neither forge/provider credentials nor Docker's ambient
		// endpoint defaults. The protected config already supplied the few deployment keys it reads.
		for (const key of Object.keys(process.env)) if (!["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key];
		app = await startGateway(config);
		out("sandbox gateway is listening on its configured address\n");
		const stop = () => { void app.close().finally(() => process.exit(0)); };
		process.once("SIGTERM", stop); process.once("SIGINT", stop);
		return 0;
	} catch { err("sandbox gateway could not start; check its protected config, deployment, assets, audit directory and Valkey connection\n"); await app?.close(); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) process.exitCode = await runGateway();
