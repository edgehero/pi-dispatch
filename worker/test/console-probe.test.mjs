import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleProbeTarget, probeConsole } from "../src/console-probe.mjs";

// The `node:http` request seam: records every request's options and answers as `answer` says, without a socket.
//   { status }  the response arrives with that status code
//   { error }   the request emits an error with that code
//   "hang"      nothing ever arrives (the probe's own timer has to end it)
function fakeRequest(answer, seen) {
	return (options, onResponse) => {
		seen.push(options);
		const handlers = {};
		const req = {
			destroyed: false,
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
			end() {
				queueMicrotask(() => {
					if (answer === "hang") return;
					if (answer.error) handlers.error?.(Object.assign(new Error(answer.error), { code: answer.error }));
					else onResponse({ statusCode: answer.status, resume() {} });
				});
			},
			destroy() {
				this.destroyed = true;
			},
		};
		return req;
	};
}

test("probe targets: loopback as written, an any-address bind on its own family's loopback, the socket by path, and nothing else", () => {
	assert.deepEqual(consoleProbeTarget(undefined), { kind: "tcp", host: "127.0.0.1", port: 4790, shown: "127.0.0.1:4790" }, "unset is the console's default");
	assert.deepEqual(consoleProbeTarget("   "), { kind: "tcp", host: "127.0.0.1", port: 4790, shown: "127.0.0.1:4790" }, "whitespace is unset, as the console trims it");
	assert.deepEqual(consoleProbeTarget(" 127.0.0.2:4800 "), { kind: "tcp", host: "127.0.0.2", port: 4800, shown: "127.0.0.2:4800" });
	assert.deepEqual(consoleProbeTarget("[::1]:4791"), { kind: "tcp", host: "::1", port: 4791, shown: "[::1]:4791" });
	assert.deepEqual(consoleProbeTarget("0.0.0.0:4790"), { kind: "tcp", host: "127.0.0.1", port: 4790, shown: "127.0.0.1:4790" });
	for (const any of ["[::]:4790", "[::0]:4790", "[0:0:0:0:0:0:0:0]:4790"]) assert.deepEqual(consoleProbeTarget(any), { kind: "tcp", host: "::1", port: 4790, shown: "[::1]:4790" }, any);
	assert.deepEqual(consoleProbeTarget("unix:/run/pd/console.sock"), { kind: "unix", path: "/run/pd/console.sock", shown: "unix:/run/pd/console.sock" });
	for (const [value, why] of [
		["127.0.0.1:0", /port 0/],
		["[::]:0", /port 0/],
		["192.168.1.5:4790", /not a loopback address/],
		["[2001:db8::1]:4790", /not a loopback address/],
		["localhost:4790", /not an IP literal/],
		["::1:4790", /not ip:port/],
		["127.0.0.1:65536", /not ip:port/],
		["unix:relative.sock", /relative socket path/],
	]) {
		const target = consoleProbeTarget(value);
		assert.equal(target.kind, undefined, value);
		assert.match(target.unknown, why, value);
	}
});

test("probeConsole: one GET /healthz with Host 127.0.0.1, answered running, not running or unknown", async () => {
	const seen = [];
	assert.deepEqual(await probeConsole({}, { request: fakeRequest({ status: 200 }, seen) }), { target: "127.0.0.1:4790", state: "running" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].method, "GET");
	assert.equal(seen[0].path, "/healthz");
	assert.deepEqual(seen[0].headers, { host: "127.0.0.1" }, "the console's rebinding guard accepts it for every listener");
	assert.equal(seen[0].host, "127.0.0.1");
	assert.equal(seen[0].port, 4790);

	const other = await probeConsole({}, { request: fakeRequest({ status: 404 }, []) });
	assert.equal(other.state, "not-running");
	assert.match(other.reason, /HTTP 404, not the console's 200/);
	const refused = await probeConsole({}, { request: fakeRequest({ error: "ECONNREFUSED" }, []) });
	assert.deepEqual(refused, { target: "127.0.0.1:4790", state: "not-running", reason: "nothing listens there" });
	const gone = await probeConsole({ PI_CONSOLE_LISTEN: "unix:/run/pd.sock" }, { request: fakeRequest({ error: "ENOENT" }, []) });
	assert.equal(gone.reason, "nothing listens there");
	const reset = await probeConsole({}, { request: fakeRequest({ error: "ECONNRESET" }, []) });
	assert.match(reset.reason, /ECONNRESET/);
	const hung = await probeConsole({}, { request: fakeRequest("hang", []), timeoutMs: 20 });
	assert.deepEqual(hung, { target: "127.0.0.1:4790", state: "not-running", reason: "nothing answered within 20 ms" });
	const threw = await probeConsole({}, {
		request: () => {
			throw Object.assign(new Error("bad"), { code: "ERR_INVALID_ARG_VALUE" });
		},
	});
	assert.equal(threw.state, "not-running");
});

test("probeConsole: the socket is asked through socketPath, an any-address bind on loopback, and port 0 or a public address contacts NOTHING", async () => {
	const seen = [];
	const request = fakeRequest({ status: 200 }, seen);
	assert.equal((await probeConsole({ PI_CONSOLE_LISTEN: "unix:/run/pd.sock" }, { request })).state, "running");
	assert.equal(seen.at(-1).socketPath, "/run/pd.sock");
	assert.equal(seen.at(-1).host, undefined, "a socket request names no host to connect to");
	await probeConsole({ PI_CONSOLE_LISTEN: "[::]:4790" }, { request });
	assert.deepEqual([seen.at(-1).host, seen.at(-1).port, seen.at(-1).family], ["::1", 4790, 6]);
	await probeConsole({ PI_CONSOLE_LISTEN: "0.0.0.0:4790" }, { request });
	assert.deepEqual([seen.at(-1).host, seen.at(-1).family], ["127.0.0.1", 4]);
	const before = seen.length;
	for (const value of ["127.0.0.1:0", "10.0.0.7:4790", "[fe80::1]:4790", "console.example:4790", "nonsense"]) {
		const res = await probeConsole({ PI_CONSOLE_LISTEN: value }, { request });
		assert.equal(res.state, "unknown", value);
		assert.ok(res.reason, value);
	}
	assert.equal(seen.length, before, "no request for an address the probe may not or cannot ask");
	// Every host the probe ever contacted is loopback.
	for (const opts of seen) assert.ok(opts.socketPath || ["127.0.0.1", "::1"].includes(opts.host), JSON.stringify(opts));
});
