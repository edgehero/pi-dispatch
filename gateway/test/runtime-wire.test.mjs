import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { GATEWAY_AMBIENT_RUNTIME_KEYS } from "../src/runtime.mjs";

const execute = promisify(execFile);
test("the pinned output-only attach ends its zero-byte request, never upgrades stdin or resizes, and exposes no write capability", async () => {
	const target = { host: "host-a", id: "run:one", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const socketPath = join(tempDir("gw-watch-wire-"), "engine.sock"), sockets = new Set(), requests = [];
	let attachHeaders, body = Buffer.alloc(0), upgrades = 0;
	const server = createServer((req, res) => {
		requests.push([req.method, req.url]);
		if (req.url.endsWith("/json")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ Id: target.containerId, Name: "/pi-sandbox-run_one", Config: { Tty: true, OpenStdin: true, Labels: { "org.pi-dispatch.sandbox-session": target.nonce } }, State: { Running: true } }));
		} else {
			attachHeaders = req.headers; req.on("data", chunk => { body = Buffer.concat([body, chunk]); });
			req.once("end", () => { res.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" }); res.end("READ_ONLY_✓_界\n"); });
		}
	});
	server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.on("upgrade", (_req, socket) => { upgrades++; socket.destroy(); });
	await new Promise(resolve => server.listen(socketPath, resolve));
	const source = `import assert from 'node:assert/strict'; import {makeGatewayRuntime} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)}; const c=await makeGatewayRuntime({sockets:{local:${JSON.stringify(socketPath)}}}).attachWatch(${JSON.stringify(target)}); assert.equal(c.stream.write,undefined); assert.equal(c.resize,undefined); const chunks=[]; for await(const b of c.stream)chunks.push(b); assert.equal(Buffer.concat(chunks).toString(),'READ_ONLY_✓_界\\n'); c.detach();`;
	try {
		const env = { ...process.env }; for (const key of GATEWAY_AMBIENT_RUNTIME_KEYS) delete env[key];
		await execute(process.execPath, ["--input-type=module", "-e", source], { env, timeout: 10000 });
		assert.equal(upgrades, 0); assert.equal(body.length, 0); assert.equal(attachHeaders["content-length"], "0"); assert.equal(attachHeaders["transfer-encoding"], undefined);
		assert.equal(requests.length, 2);
		const params = new URL(requests[1][1], "http://engine").searchParams;
		assert.equal(params.get("stdin"), "false"); assert.equal(params.get("logs"), "false");
		assert.equal(params.get("stdout"), "true"); assert.equal(params.get("stderr"), "true");
		assert.equal(requests.some(([, path]) => path.includes("/resize")), false);
	} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
test("the exact maintained modem sends an empty attach request and the first stdin is only operator input", async () => {
	const require = createRequire(import.meta.url);
	assert.equal(require("docker-modem/package.json").version, "5.0.7");
	const target = { host: "host-a", id: "run:one", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const socketPath = join(tempDir("gw-wire-"), "engine.sock"), sockets = new Set();
	const inputs = [], requests = []; let headers;
	const server = createServer((req, res) => {
		requests.push([req.method, req.url]);
		if (req.url.endsWith("/json")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Id: target.containerId, Name: "/pi-sandbox-run_one", Config: { Tty: true, OpenStdin: true, Labels: { "org.pi-dispatch.sandbox-session": target.nonce } }, State: { Running: true } })); }
		else { req.resume(); req.once("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); }
	});
	server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.on("upgrade", (req, socket, head) => {
		headers = req.headers; requests.push([req.method, req.url]); inputs.push(head);
		socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
		socket.on("data", bytes => { inputs.push(bytes); if (Buffer.concat(inputs).includes(Buffer.from("OPERATOR_FIRST_INPUT\n"))) socket.write("ENGINE_OUTPUT\n"); });
	});
	await new Promise(resolve => server.listen(socketPath, resolve));
	const moduleUrl = new URL("../src/runtime.mjs", import.meta.url).href;
	const source = `import {makeGatewayRuntime} from ${JSON.stringify(moduleUrl)}; const runtime=makeGatewayRuntime({sockets:{local:${JSON.stringify(socketPath)}}}); const channel=await runtime.attach(${JSON.stringify(target)},{cols:80,rows:24}); channel.stream.on('error',()=>{}); const output=new Promise(resolve=>channel.stream.once('data',resolve)); channel.stream.write('OPERATOR_FIRST_INPUT\\n'); const received=await output; if(!received.toString().includes('ENGINE_OUTPUT')) throw new Error('no output'); channel.detach();`;
	try {
		const env = { ...process.env }; for (const key of GATEWAY_AMBIENT_RUNTIME_KEYS) delete env[key];
		await execute(process.execPath, ["--input-type=module", "-e", source], { env, timeout: 10000 });
		assert.equal(headers["content-length"], "0"); assert.equal(headers["transfer-encoding"], undefined);
		assert.deepEqual(Buffer.concat(inputs).subarray(0, Buffer.byteLength("OPERATOR_FIRST_INPUT\n")), Buffer.from("OPERATOR_FIRST_INPUT\n"));
		assert.ok(requests.every(([method, path]) => method === "GET" && path === `/v1.40/containers/${target.containerId}/json` || method === "POST" && (path.startsWith(`/v1.40/containers/${target.containerId}/attach?`) || path.startsWith(`/v1.40/containers/${target.containerId}/resize?`))));
	} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
test("ambient endpoint, prefix and eager certificate defaults refuse before the maintained constructor reads them", async () => {
	const env = { ...process.env }; for (const key of GATEWAY_AMBIENT_RUNTIME_KEYS) delete env[key];
	const source = `import {makeGatewayRuntime} from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)}; const runtime=makeGatewayRuntime({sockets:{local:'/does-not-exist/engine.sock'}}); const result=await runtime.inspect({host:'host-a',id:'run',nonce:'${"a".repeat(32)}',containerId:'${"b".repeat(64)}',venue:'local'}); process.stdout.write(JSON.stringify(result));`;
	for (const bad of [{ DOCKER_HOST: "not a valid endpoint" }, { DOCKER_HOST: "tcp://127.0.0.1:9", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/must-not-be-read/missing-cert" }, { DOCKER_PATH_PREFIX: "/other/daemon" }]) {
		const result = await execute(process.execPath, ["--input-type=module", "-e", source], { env: { ...env, ...bad }, timeout: 10000 });
		assert.deepEqual(JSON.parse(result.stdout), { refused: "runtime-environment" }); assert.equal(result.stderr, "");
	}
});
