import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as nodeRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { askYesNo, backoffMs, consoleAddressOf, ConsoleError, consoleToken, dotenvTrustRefusal, endedOf, isLoopbackAddress, makeConsoleClient, makeSseParser, oneLine, parseConsoleAddress, RELOGIN_WINDOW_MS, retryAfterMs, SSE_EVENT_MAX_BYTES, STREAM_SHUTDOWN } from "../src/console-client.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #647: the terminal chat's console client, against a node:http fake of the console. Every request is recorded,
// so the headers the guards judge (Host, Origin, the JSON content type, no Sec-Fetch-Site) are asserted on the wire.

const TOKEN = "pdc_secret-token-value-0123456789";
const TEXT = "the private message text";

/** A fake console. `routes[path](req, res, body)` overrides; every request lands in `seen`. */
function fakeConsole({ routes = {}, cookieValue = () => "sess1" } = {}) {
	const seen = [];
	let logins = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			const body = text === "" ? null : JSON.parse(text);
			const url = new URL(req.url, "http://x");
			seen.push({ method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body });
			const json = (status, value, headers = {}) => {
				res.writeHead(status, { "content-type": "application/json", ...headers });
				res.end(JSON.stringify(value));
			};
			const signedIn = /(^|;\s*)pdc_session=sess/.test(req.headers.cookie ?? "");
			if (routes[url.pathname]) return routes[url.pathname](req, res, body, { json, signedIn, seen });
			if (url.pathname === "/login") {
				logins += 1;
				if (body?.token !== TOKEN) return json(401, { error: "that token is not valid for this console" });
				return json(200, { ok: true, name: "rob", role: "operator" }, { "set-cookie": `pdc_session=${cookieValue(logins)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
			}
			if (!signedIn) return json(401, { error: "sign in first" }, { "set-cookie": "pdc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
			if (url.pathname === "/api/whoami") return json(200, { name: "rob", role: "operator", readOnly: false });
			if (url.pathname === "/api/run") return json(200, { run: { jobId: url.searchParams.get("id") }, mode: "live" });
			return json(404, { error: "there is no such page on this console" });
		});
	});
	return {
		seen,
		get logins() {
			return logins;
		},
		listen(at) {
			return new Promise((resolve) => {
				if (at) server.listen(at, () => resolve(at));
				else server.listen(0, "127.0.0.1", () => resolve(server.address().port));
			});
		},
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		}),
	};
}

const sse = (res) => res.writeHead(200, { "content-type": "text/event-stream" });

/**
 * node:http's request, except that a connection `down(opts)` names is refused (ECONNREFUSED, as from a console that
 * is restarting) without reaching any server: the client's own `request` seam.
 */
function flakyRequest(down) {
	return (opts) => {
		if (!down(opts)) return nodeRequest(opts);
		const req = new EventEmitter();
		req.write = () => true;
		req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" })));
		req.destroy = () => {};
		return req;
	};
}

test("addresses: host:port, http://, IPv6, unix, wildcards dialled on loopback, https and paths refused", () => {
	assert.deepEqual(parseConsoleAddress("127.0.0.1:4790"), { kind: "tcp", host: "127.0.0.1", port: 4790, hostHeader: "127.0.0.1:4790", shown: "http://127.0.0.1:4790" });
	assert.equal(parseConsoleAddress("http://localhost:8080/").hostHeader, "localhost:8080");
	assert.deepEqual(parseConsoleAddress("[::1]:4790"), { kind: "tcp", host: "::1", port: 4790, hostHeader: "[::1]:4790", shown: "http://[::1]:4790" });
	assert.equal(parseConsoleAddress("0.0.0.0:4790").host, "127.0.0.1");
	assert.equal(parseConsoleAddress("[::]:4790").hostHeader, "[::1]:4790");
	assert.deepEqual(parseConsoleAddress("unix:/run/pd/console.sock"), { kind: "unix", socketPath: "/run/pd/console.sock", hostHeader: "localhost", shown: "unix:/run/pd/console.sock" });
	for (const bad of ["", "https://127.0.0.1:4790", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:99999", "http://h:1/path", "user@h:1", "unix:rel.sock", "[::1]4790", "h_x:1"]) {
		assert.ok(parseConsoleAddress(bad).refusal, `${JSON.stringify(bad)} is refused`);
	}
});

test("which console: --console, then PI_CONSOLE_URL, then the deployment's PI_CONSOLE_LISTEN, then the default", () => {
	let asked = 0;
	const deployment = () => {
		asked += 1;
		return { env: { PI_CONSOLE_LISTEN: "unix:/s/c.sock" } };
	};
	assert.equal(consoleAddressOf({ flag: "127.0.0.1:1", env: { PI_CONSOLE_URL: "127.0.0.1:2" }, deployment }).address.port, 1);
	assert.equal(consoleAddressOf({ env: { PI_CONSOLE_URL: "127.0.0.1:2" }, deployment }).address.port, 2);
	assert.equal(asked, 0, "the deployment is not read when the shell names the console");
	assert.equal(consoleAddressOf({ env: {}, deployment }).address.socketPath, "/s/c.sock");
	assert.equal(consoleAddressOf({ env: {}, deployment: () => ({ env: {} }) }).address.hostHeader, "127.0.0.1:4790");
	assert.match(consoleAddressOf({ env: {}, deployment: () => ({ problem: "PI_CONSOLE_LISTEN disagrees" }) }).refusal, /disagrees.*--console/);
	assert.match(consoleAddressOf({ flag: "https://x:1" }).refusal, /^--console: /);
});

test("the token comes from this shell's PI_CONSOLE_TOKEN, else a hidden prompt, else a refusal", async () => {
	assert.deepEqual(await consoleToken({ env: { PI_CONSOLE_TOKEN: ` ${TOKEN} ` } }), { token: TOKEN });
	const asked = [];
	assert.deepEqual(await consoleToken({ env: {}, askHidden: async (q) => (asked.push(q), TOKEN) }), { token: TOKEN });
	assert.match(asked[0], /hidden/);
	const refused = await consoleToken({ env: {}, askHidden: async () => null });
	assert.match(refused.refusal, /PI_CONSOLE_TOKEN/);
});

test("backoff doubles to its cap with jitter in the upper half; Retry-After is read in seconds and clamped", () => {
	assert.equal(backoffMs(1, { random: () => 0 }), 250);
	assert.equal(backoffMs(1, { random: () => 1 }), 500);
	assert.equal(backoffMs(3, { random: () => 1 }), 2000);
	assert.equal(backoffMs(20, { random: () => 1 }), 30_000);
	assert.equal(backoffMs(20, { random: () => 0 }), 15_000);
	assert.equal(retryAfterMs("7"), 7000);
	assert.equal(retryAfterMs("0"), 1000);
	assert.equal(retryAfterMs("999999"), 60_000, "a confused server cannot park the client past a minute");
	assert.equal(retryAfterMs("61"), 60_000);
	assert.equal(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT"), null);
	assert.equal(retryAfterMs(undefined), null);
});

test("the SSE parser: split chunks, CRLF and CR, comments, multi-line data, ids, retry", () => {
	const events = [];
	const retries = [];
	const p = makeSseParser({ onEvent: (e) => events.push(e), onRetry: (ms) => retries.push(ms) });
	const stream = "retry: 2000\r\n\r\n: ping\n\nid: 1-1\nevent: entry\ndata: {\"a\":\ndata: 1}\n\nid: 1-2\revent: done\rdata: {}\r\r";
	for (const ch of Buffer.from(stream)) p.push(Buffer.from([ch]));
	assert.deepEqual(retries, [2000]);
	assert.deepEqual(events, [
		{ event: "entry", data: '{"a":\n1}', id: "1-1" },
		{ event: "done", data: "{}", id: "1-2" },
	]);
	assert.equal(p.lastEventId, "1-2");
	// A multi-byte character split across chunks decodes whole.
	const got = [];
	const q = makeSseParser({ onEvent: (e) => got.push(e.data) });
	const bytes = Buffer.from("data: héllo ✓\n\n");
	q.push(bytes.subarray(0, 8));
	q.push(bytes.subarray(8));
	assert.deepEqual(got, ["héllo ✓"]);
});

test("the SSE parser drops an event over 256 KiB whole, including one endless line, and keeps the next", () => {
	const events = [];
	let oversize = 0;
	const p = makeSseParser({ onEvent: (e) => events.push(e), onOversize: () => (oversize += 1) });
	const big = "x".repeat(64 * 1024);
	p.push("event: entry\n");
	for (let i = 0; i < 6; i += 1) p.push(`data: ${big}\n`);
	p.push("\n");
	// One line that never ends, fed in pieces well past the cap: nothing of it is kept.
	p.push("event: entry\ndata: ");
	for (let i = 0; i < 8; i += 1) p.push(big);
	p.push("\n\n");
	p.push("event: entry\ndata: small\n\n");
	assert.equal(oversize, 2);
	assert.deepEqual(events, [{ event: "entry", data: "small", id: null }]);
	assert.ok(SSE_EVENT_MAX_BYTES === 256 * 1024);
});

test("over tcp: login holds the cookie; Host, Origin and the JSON type are sent, Sec-Fetch-Site never; nothing secret escapes", async () => {
	const fake = fakeConsole();
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN });
		assert.deepEqual(await client.whoami(), { name: "rob", role: "operator", readOnly: false });
		const run = await client.run({ id: "j1" });
		assert.equal(run.json.run.jobId, "j1");
		assert.equal(fake.logins, 1, "one sign-in serves every later request");
		for (const r of fake.seen) {
			assert.equal(r.headers.host, `127.0.0.1:${port}`);
			assert.equal(r.headers.origin, `http://127.0.0.1:${port}`);
			assert.equal(r.headers["sec-fetch-site"], undefined, "a non-browser client never claims to be the console's page");
		}
		const login = fake.seen.find((r) => r.path === "/login");
		assert.equal(login.headers["content-type"], "application/json");
		assert.equal(login.headers.cookie, undefined);
		assert.equal(fake.seen.find((r) => r.path === "/api/whoami").headers.cookie, "pdc_session=sess1");
		// A refused token: the sentence names the address and the console's words, never the token or a cookie.
		const bad = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: "pdc_wrong-token" });
		await assert.rejects(bad.whoami(), (e) => e instanceof ConsoleError && /refused the token/.test(e.message) && !e.message.includes("pdc_wrong-token") && !e.message.includes("sess"));
	} finally {
		await fake.close();
	}
});

test("over a unix socket: Host is localhost and Origin http://localhost", async () => {
	const fake = fakeConsole();
	const sock = join(tempDir("cc-"), "c.sock");
	await fake.listen(sock);
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`unix:${sock}`), token: TOKEN });
		await client.whoami();
		assert.ok(fake.seen.length >= 2);
		for (const r of fake.seen) {
			assert.equal(r.headers.host, "localhost");
			assert.equal(r.headers.origin, "http://localhost");
		}
	} finally {
		await fake.close();
	}
});

test("a 401 signs in again once and retries; a second 401 is answered, never looped", async () => {
	let n = 0;
	const fake = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/run": (req, res, body, { json, signedIn }) => {
				n += 1;
				if (!signedIn || /sess1\b/.test(req.headers.cookie)) return json(401, { error: "sign in first" });
				return json(200, { ok: true });
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN });
		const got = await client.run({ id: "j1" });
		assert.equal(got.status, 200);
		assert.equal(fake.logins, 2);
		assert.equal(n, 2);
		const always = fakeConsole({ routes: { "/api/run": (req, res, body, { json }) => json(401, { error: "sign in first" }) } });
		const p2 = await always.listen();
		try {
			const c2 = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${p2}`), token: TOKEN });
			assert.equal((await c2.run({ id: "j1" })).status, 401);
			assert.equal(always.logins, 2, "one fresh sign-in, then the 401 is the answer");
		} finally {
			await always.close();
		}
	} finally {
		await fake.close();
	}
});

test("act: preview prints the summary and reserve, confirm sends the ticket; a no sends nothing; a refusal is verbatim", async () => {
	const confirms = [];
	const fake = fakeConsole({
		routes: {
			"/api/act/steer/preview": (req, res, body, { json }) => {
				if (body.text === "") return json(400, { error: "the message is empty; nothing was sent" });
				return json(200, { ticket: "t-1", summary: ["Send a steer to running job j1, as rob (message abc, 24 bytes)"], reserve: { dollarsMicros: 2_500_000 }, diffHtml: `<pre>${body.text}</pre>` });
			},
			"/api/act/steer/confirm": (req, res, body, { json }) => {
				confirms.push(body);
				json(200, { ok: true, id: "ab".repeat(16), state: "queued" });
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN });
		const printed = [];
		const yes = await client.act("steer", { jobId: "j1", text: TEXT, mode: "steer" }, { print: (l) => printed.push(l), confirm: async () => true });
		assert.equal(yes.ok, true);
		assert.equal(yes.result.state, "queued");
		assert.deepEqual(confirms, [{ ticket: "t-1" }]);
		assert.match(printed.join("\n"), /Send a steer/);
		assert.match(printed.join("\n"), /\$2\.50/);
		assert.ok(!printed.join("\n").includes(TEXT), "the message text is never printed back (the diff is not shown)");
		const no = await client.act("steer", { jobId: "j1", text: TEXT }, { confirm: async () => false });
		assert.deepEqual(no, { declined: true });
		assert.equal(confirms.length, 1);
		const refused = await client.act("steer", { jobId: "j1", text: "" }, { confirm: async () => true });
		assert.deepEqual(refused, { refusal: "the message is empty; nothing was sent", status: 400 });
		const preview = fake.seen.find((r) => r.path === "/api/act/steer/preview");
		assert.equal(preview.headers["content-type"], "application/json");
		assert.equal(preview.headers["sec-fetch-site"], undefined);
	} finally {
		await fake.close();
	}
});

test("a stream resumes with Last-Event-ID after a cut, waits Retry-After on 429, and ends on done", { timeout: 10_000 }, async () => {
	let opens = 0;
	const lastIds = [];
	const fake = fakeConsole({
		routes: {
			"/api/transcript": (req, res, body, { json }) => {
				opens += 1;
				lastIds.push(req.headers["last-event-id"] ?? null);
				if (opens === 1) {
					sse(res);
					res.write("retry: 2000\n\n");
					res.write('id: 1-1\nevent: entry\ndata: {"id":"1-1","kind":"user","text":"a"}\n\n');
					res.write('id: 1-2\nevent: entry\ndata: {"id":"1-2","kind":"assistant","text":"b"}\n\n');
					return res.end();
				}
				if (opens === 2) return json(429, { error: "the console holds as many live streams as it allows" }, { "retry-after": "7" });
				sse(res);
				res.write('id: 1-3\nevent: entry\ndata: {"id":"1-3","kind":"end","outcome":"completed"}\n\n');
				res.write('event: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const waits = [];
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async (ms) => (waits.push(ms), true), random: () => 1 });
		const ids = [];
		const end = await client.stream("/api/transcript?id=j1&format=json", { onEvent: (e) => ids.push(e.id) });
		assert.deepEqual(end, { done: "completed" });
		assert.deepEqual(ids, ["1-1", "1-2", "1-3"]);
		assert.deepEqual(lastIds, [null, "1-2", "1-2"]);
		assert.equal(waits[1], 7000, "the 429's Retry-After is honoured");
		assert.ok(waits[0] >= 2000, "the server's retry: raises the backoff floor");
		assert.equal(fake.seen.find((r) => r.path === "/api/transcript").headers.accept, "text/event-stream");
	} finally {
		await fake.close();
	}
});

test("an end event signs in again once; a second end right after the fresh sign-in gives up with a sentence", { timeout: 10_000 }, async () => {
	// A session's end names why (issue #737); an older console's `{}`, data that is not JSON and a word that only looks
	// like the shutdown one are ends all the same: only the exact STREAM_SHUTDOWN is a dropped connection.
	for (const data of ['{"ended":"revoked"}', '{"ended":"elsewhere"}', "{}", "not json", '{"ended":"Shutdown"}', '{"ended":"shutdown "}', '{"ended":["shutdown"]}']) {
		let opens = 0;
		const fake = fakeConsole({
			cookieValue: (k) => `sess${k}`,
			routes: {
				"/api/transcript": (req, res) => {
					opens += 1;
					sse(res);
					res.write(`event: end\ndata: ${data}\n\n`);
					res.end();
				},
			},
		});
		const port = await fake.listen();
		try {
			const states = [];
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async () => true });
			await assert.rejects(client.stream("/api/transcript?id=j1&format=json", { onState: (st) => states.push(st) }), (e) => e instanceof ConsoleError && /ended this sign-in again/.test(e.message) && !e.message.includes(TOKEN), data);
			assert.equal(opens, 2, data);
			assert.equal(fake.logins, 2, `${data}: exactly one re-login`);
			assert.deepEqual(states, [{ relogin: true }], `${data}: never taken for the console stopping`);
		} finally {
			await fake.close();
		}
	}
});

test("endedOf: the reason an end's data names, a short lowercase word or null; the shutdown word is the console's", () => {
	assert.equal(STREAM_SHUTDOWN, "shutdown");
	assert.equal(endedOf('{"ended":"shutdown"}'), STREAM_SHUTDOWN);
	assert.equal(endedOf('{"ended":"revoked"}'), "revoked");
	for (const data of ["{}", '{"ended":null}', '{"ended":7}', '{"ended":"Shutdown"}', '{"ended":"shut down"}', `{"ended":"${"x".repeat(21)}"}`, "not json", "", "null", '"shutdown"', '["shutdown"]']) {
		assert.equal(endedOf(data), null, data);
	}
});

test("SHUTDOWN IS A DROPPED CONNECTION: backed off and reconnected with the same cookie, never a re-login, and twice in a minute is not fatal", { timeout: 10_000 }, async () => {
	let opens = 0;
	const cookies = [];
	const fake = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/transcript": (req, res) => {
				opens += 1;
				cookies.push(req.headers.cookie);
				sse(res);
				if (opens === 1) res.write("id: 1-1\nevent: entry\ndata: {}\n\n");
				res.write(opens < 3 ? `event: end\ndata: {"ended":"${STREAM_SHUTDOWN}"}\n\n` : 'event: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const waits = [];
		const states = [];
		// One instant for the whole stream: two ends inside RELOGIN_WINDOW_MS would be fatal, two shutdowns are not.
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async (ms) => (waits.push(ms), true), random: () => 1 });
		assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json", { onState: (st) => states.push(st) }), { done: "completed" });
		assert.equal(opens, 3);
		assert.equal(fake.logins, 1, "the sign-in is kept: a stopping console is not a session that ended");
		assert.deepEqual(cookies, ["pdc_session=sess1", "pdc_session=sess1", "pdc_session=sess1"]);
		assert.deepEqual(states, [{ shutdown: true }, { waiting: 500 }, { shutdown: true }, { waiting: 1000 }], "said, then waited, each time");
		assert.deepEqual(waits, [500, 1000], "the dropped connection's backoff, not the re-login's pause");
		assert.equal(fake.seen.filter((r) => r.path === "/api/transcript")[1].headers["last-event-id"], "1-1", "resumed from the last entry");
	} finally {
		await fake.close();
	}
});

test("a console restart: shutdown, refused while it is down, its 401 signs in again, and a sign-in it refuses mid-restart is retried, not the end", { timeout: 10_000 }, async () => {
	let phase = "old";
	let downLeft = 0;
	let loginDown = 0;
	const asked = [];
	const fake = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/transcript": (req, res, body, { json }) => {
				asked.push([phase, req.headers.cookie, req.headers["last-event-id"] ?? null]);
				if (phase === "old") {
					sse(res);
					res.write("id: 1-1\nevent: entry\ndata: {}\n\n");
					res.write(`event: end\ndata: {"ended":"${STREAM_SHUTDOWN}"}\n\n`);
					res.end();
					// The process stops: two connections are refused, then a new one that knows no session answers.
					phase = "new";
					downLeft = 2;
					loginDown = 1;
					return;
				}
				if (req.headers.cookie !== "pdc_session=sess2") return json(401, { error: "sign in first", ended: "restart" }, { "set-cookie": "pdc_session=; Path=/; Max-Age=0" });
				sse(res);
				res.write('id: 1-2\nevent: entry\ndata: {}\n\nevent: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const states = [];
		const ids = [];
		const request = flakyRequest((opts) => {
			if (downLeft > 0) return ((downLeft -= 1), true);
			if (opts.path === "/login" && loginDown > 0) return ((loginDown -= 1), true);
			return false;
		});
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, request, sleep: async () => true, random: () => 1 });
		const end = await client.stream("/api/transcript?id=j1&format=json", { onEvent: (e) => ids.push(e.id), onState: (st) => states.push(st) });
		assert.deepEqual(end, { done: "completed" });
		assert.deepEqual(ids, ["1-1", "1-2"]);
		assert.equal(fake.logins, 2, "one sign-in, and one after the restarted console said 401");
		assert.deepEqual(asked, [["old", "pdc_session=sess1", null], ["new", "pdc_session=sess1", "1-1"], ["new", "pdc_session=sess2", "1-1"]], "the old cookie is tried first: only the 401 signs in again");
		assert.deepEqual(states.map((st) => Object.keys(st)[0]), ["shutdown", "waiting", "waiting", "waiting", "relogin", "waiting"], "shutdown, two refused reconnects, the 401's re-login, the refused sign-in waited out");
	} finally {
		await fake.close();
	}
});

test("a sign-in the console answers with a refusal inside the stream's retry is not waited out: a revoked token is the end", { timeout: 10_000 }, async () => {
	const fake = fakeConsole({
		routes: {
			"/api/transcript": (req, res, body, { json }) => json(401, { error: "sign in first" }, { "set-cookie": "pdc_session=; Path=/; Max-Age=0" }),
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: "pdc_revoked-token", sleep: async () => true });
		await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e instanceof ConsoleError && e.status === 401 && /refused the token/.test(e.message));
		assert.equal(fake.logins, 1, "asked once: retrying cannot make a refused token valid");
	} finally {
		await fake.close();
	}
});

test("a determinate refusal of a stream (403) is not retried; an aborted stream detaches", { timeout: 10_000 }, async () => {
	const fake = fakeConsole({
		routes: {
			"/api/transcript": (req, res, body, { json }) => {
				if (req.url.includes("id=no")) return json(403, { error: "this needs the operator role, and the signed-in token has the viewer role" });
				sse(res);
				res.write(": ping\n\n");
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async () => true });
		await assert.rejects(client.stream("/api/transcript?id=no&format=json"), (e) => e.status === 403 && /operator role/.test(e.message));
		const abort = new AbortController();
		const running = client.stream("/api/transcript?id=j1&format=json", { signal: abort.signal });
		setTimeout(() => abort.abort(), 50);
		assert.deepEqual(await running, { detached: true });
	} finally {
		await fake.close();
	}
});

test("an unreachable console is one sentence naming the address and the code", async () => {
	const client = makeConsoleClient({ address: parseConsoleAddress("127.0.0.1:1"), token: TOKEN });
	await assert.rejects(client.whoami(), (e) => e instanceof ConsoleError && /127\.0\.0\.1:1 could not be reached \(ECONNREFUSED\)/.test(e.message) && !e.message.includes(TOKEN));
});

test("loopback: a unix socket, localhost, 127.0.0.0/8 and ::1 (wildcards dialled there) are; any other host is not", () => {
	for (const ok of ["unix:/s/c.sock", "127.0.0.1:1", "127.255.0.9:1", "localhost:1", "LOCALHOST:1", "[::1]:1", "0.0.0.0:1", "[::]:1"]) assert.equal(isLoopbackAddress(parseConsoleAddress(ok)), true, ok);
	for (const no of ["10.0.0.1:1", "128.0.0.1:1", "127.0.0.1.evil.test:1", "localhost.evil.test:1", "console.example.com:1", "[fe80::1]:1", "[::2]:1"]) assert.equal(isLoopbackAddress(parseConsoleAddress(no)), false, no);
	assert.equal(isLoopbackAddress(null), false);
});

test("an address from the deployment's .env must be loopback or a socket; --console and PI_CONSOLE_URL may name another host, marked so", () => {
	const fromEnv = (listen) => consoleAddressOf({ env: {}, deployment: () => ({ env: { PI_CONSOLE_LISTEN: listen } }) });
	const refused = fromEnv("evil.example.com:80");
	assert.match(refused.refusal, /PI_CONSOLE_LISTEN in the deployment's \.env names http:\/\/evil\.example\.com:80, which is not a loopback address or a unix socket/);
	assert.match(refused.refusal, /--console <host:port> or PI_CONSOLE_URL/);
	assert.ok(fromEnv("10.1.2.3:4790").refusal);
	assert.equal(fromEnv("0.0.0.0:4790").loopback, true, "a wildcard listen is dialled on loopback");
	assert.equal(fromEnv("unix:/s/c.sock").loopback, true);
	assert.equal(consoleAddressOf({ env: {} }).loopback, true, "the default is loopback");
	const flag = consoleAddressOf({ flag: "console.example.com:4790" });
	assert.equal(flag.loopback, false);
	assert.equal(flag.address.hostHeader, "console.example.com:4790");
	assert.equal(consoleAddressOf({ env: { PI_CONSOLE_URL: "10.0.0.5:4790" } }).loopback, false);
});

test("a PI_CONSOLE_LISTEN the shell does not set is taken only from a .env this account controls, loopback or not", () => {
	let asked = 0;
	const deployment = () => ({ env: { PI_CONSOLE_LISTEN: "127.0.0.1:4791" } });
	const distrust = () => ((asked += 1), "/w/.env, which is a symbolic link");
	const refused = consoleAddressOf({ env: {}, deployment, envTrust: distrust });
	assert.match(refused.refusal, /^PI_CONSOLE_LISTEN comes from \/w\/\.env, which is a symbolic link, so the console token is not sent where it names; name the console with --console <host:port> or PI_CONSOLE_URL$/);
	assert.equal(consoleAddressOf({ env: { PI_CONSOLE_LISTEN: "127.0.0.1:4791" }, deployment, envTrust: distrust }).address.port, 4791, "the shell's value is not the file's");
	assert.equal(asked, 1);
	assert.equal(consoleAddressOf({ flag: "127.0.0.1:1", deployment, envTrust: distrust }).address.port, 1);
	assert.equal(asked, 1, "the file is not judged when it is not read");

	const dir = tempDir("console-env-");
	assert.match(dotenvTrustRefusal({ dir }), /\.env, which could not be checked \(ENOENT\)/);
	const file = join(dir, ".env");
	writeFileSync(file, "PI_CONSOLE_LISTEN=127.0.0.1:4791\n");
	chmodSync(file, 0o600);
	assert.equal(dotenvTrustRefusal({ dir }), null, "this account's closed file");
	chmodSync(file, 0o602);
	assert.match(dotenvTrustRefusal({ dir }), /\.env, which is owned by .* writable by every account/);
	chmodSync(file, 0o620);
	assert.match(dotenvTrustRefusal({ dir }), /writable by the members of its group/);
	chmodSync(file, 0o600);
	assert.match(dotenvTrustRefusal({ dir, uid: process.geteuid() + 1 }), /not by this account or root/);
	const linked = join(dir, "linked");
	mkdirSync(linked);
	symlinkSync(file, join(linked, ".env"));
	assert.match(dotenvTrustRefusal({ dir: linked }), /linked\/\.env, which is a symbolic link$/, "even to a file that would pass");
});

test("the SSE parser: a CRLF split between two chunks is one line end, so a two-line event stays one event", () => {
	const events = [];
	const p = makeSseParser({ onEvent: (e) => events.push(e) });
	p.push("event: entry\r\ndata: x\r");
	p.push("\ndata: y\r");
	p.push("\n\r");
	p.push("\n");
	assert.deepEqual(events, [{ event: "entry", data: "x\ny", id: null }]);
	// A lone CR still ends a line when the next chunk does not start with LF.
	const lone = [];
	const q = makeSseParser({ onEvent: (e) => lone.push(e.data) });
	q.push("data: a\r");
	q.push("data: b\r\r");
	assert.deepEqual(lone, ["a\nb"]);
});

test("the SSE parser ignores an id that is not printable ASCII or is too long: it would go back as a header", () => {
	const ids = [];
	const p = makeSseParser({ onEvent: (e) => ids.push(e.id) });
	p.push("id: 1-1\ndata: a\n\n");
	for (const bad of ["1-2\u0000", "1-\u00013", "1-\u007f", "1-✓", "x".repeat(1025)]) p.push(`id: ${bad}\ndata: b\n\n`);
	assert.deepEqual(ids, ["1-1", null, null, null, null, null]);
	assert.equal(p.lastEventId, "1-1", "Last-Event-ID stays the last good id");
	p.push(`id: ${"y".repeat(1024)}\ndata: c\n\n`);
	assert.equal(p.lastEventId, "y".repeat(1024));
});

test("a Set-Cookie with Max-Age of zero or less, or an Expires already past, clears the session whatever its value", async () => {
	for (const clear of ["pdc_session=zzz; Path=/; Max-Age=0", "pdc_session=zzz; Path=/; Max-Age=-1", "pdc_session=zzz; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]) {
		const fake = fakeConsole({
			routes: {
				"/api/whoami": (req, res, body, { json }) => json(200, { name: "rob", role: "operator", readOnly: false }, { "set-cookie": clear }),
			},
		});
		const port = await fake.listen();
		try {
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => Date.parse("2026-10-18T00:00:00Z") });
			await client.whoami();
			await client.run({ id: "j1" });
			assert.ok(!fake.seen.some((r) => (r.headers.cookie ?? "").includes("zzz")), `${clear}: the cleared value is never sent`);
			assert.equal(fake.logins, 2, `${clear}: the next request signs in again`);
		} finally {
			await fake.close();
		}
	}
	// An Expires still ahead keeps the cookie.
	const keep = fakeConsole({ routes: { "/api/whoami": (req, res, body, { json }) => json(200, { name: "rob", role: "operator" }, { "set-cookie": "pdc_session=sess7; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT" }) } });
	const port = await keep.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => Date.parse("2026-10-18T00:00:00Z") });
		await client.whoami();
		await client.run({ id: "j1" });
		assert.equal(keep.logins, 1);
		assert.equal(keep.seen.at(-1).headers.cookie, "pdc_session=sess7");
	} finally {
		await keep.close();
	}
});

test("act with no confirm is a no: the preview is asked, nothing is confirmed", async () => {
	const confirms = [];
	const fake = fakeConsole({
		routes: {
			"/api/act/steer/preview": (req, res, body, { json }) => json(200, { ticket: "t-1", summary: ["Send a steer"] }),
			"/api/act/steer/confirm": (req, res, body, { json }) => {
				confirms.push(body);
				json(200, { ok: true });
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN });
		assert.deepEqual(await client.act("steer", { jobId: "j1", text: TEXT }), { declined: true });
		assert.deepEqual(await client.act("steer", { jobId: "j1", text: TEXT }, { confirm: "yes" }), { declined: true }, "a confirm that is not a function is no answer");
		assert.deepEqual(confirms, []);
	} finally {
		await fake.close();
	}
});

test("a connection that delivered entries resets the failure count, so a stream cut after every entry never gives up", { timeout: 10_000 }, async () => {
	let opens = 0;
	const fake = fakeConsole({
		routes: {
			"/api/transcript": (req, res) => {
				opens += 1;
				sse(res);
				if (opens > 5) {
					res.write('event: done\ndata: {"outcome":"completed"}\n\n');
					return res.end();
				}
				res.write(`id: 1-${opens}\nevent: entry\ndata: {}\n\n`);
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const waits = [];
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async (ms) => (waits.push(ms), true), random: () => 1, backoff: { baseMs: 100, capMs: 1000, maxFailures: 3 } });
		assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json"), { done: "completed" });
		assert.equal(opens, 6);
		assert.deepEqual(waits, [100, 100, 100, 100, 100], "every wait is the first step: the count went back to one each time");
	} finally {
		await fake.close();
	}
});

test("re-login is paced and capped over a stream's life: an entry then end, forever, signs in at most once per window", { timeout: 10_000 }, async () => {
	let opens = 0;
	const fake = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/transcript": (req, res) => {
				opens += 1;
				sse(res);
				res.write(`id: 1-${opens}\nevent: entry\ndata: {}\n\nevent: end\ndata: {"ended":"revoked"}\n\n`);
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		let t = 1_000_000;
		const waits = [];
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => t, sleep: async (ms) => (waits.push(ms), (t += ms), true), random: () => 1 });
		const states = [];
		await assert.rejects(client.stream("/api/transcript?id=j1&format=json", { onState: (s) => states.push(s) }), (e) => e instanceof ConsoleError && e.status === 401 && /again within 60 s of a fresh one/.test(e.message));
		assert.equal(fake.logins, 2, "one sign-in and one re-login, though an entry arrived between the two ends");
		assert.equal(opens, 2);
		assert.equal(waits.length, 1, "the re-login waited first");
		assert.ok(waits[0] > 0);
		assert.deepEqual(states, [{ relogin: true }]);
		assert.equal(RELOGIN_WINDOW_MS, 60_000);
	} finally {
		await fake.close();
	}
	// Ends spaced further apart than the window each get their re-login.
	let n = 0;
	const spaced = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/transcript": (req, res) => {
				n += 1;
				sse(res);
				res.write(n > 3 ? 'event: done\ndata: {"outcome":"completed"}\n\n' : 'event: end\ndata: {"ended":"idle"}\n\n');
				res.end();
			},
		},
	});
	const p2 = await spaced.listen();
	try {
		let t = 0;
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${p2}`), token: TOKEN, now: () => (t += 61_000), sleep: async () => true });
		assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json"), { done: "completed" });
		assert.equal(spaced.logins, 4);
	} finally {
		await spaced.close();
	}
});

/**
 * A fake console whose transcript route plays `script` in order, one step per connection: `["entry", id, reason]` (an
 * entry, then an end with that reason), `["cut", id]` (an entry, then the connection closes with no end: a killed
 * console), `["open"]` (open, then closed with nothing at all), `["401", ended]` (a 401, with that `ended` or none),
 * `["end", reason]`, or done (also every step past the last). The cookie a step is sent with is recorded.
 */
function scriptedConsole(steps) {
	let n = 0;
	const cookies = [];
	const fake = fakeConsole({
		cookieValue: (k) => `sess${k}`,
		routes: {
			"/api/transcript": (req, res, body, { json }) => {
				const step = steps[n] ?? ["done"];
				n += 1;
				cookies.push(req.headers.cookie ?? null);
				if (step[0] === "401") return json(401, step[1] === undefined ? { error: "sign in first" } : { error: "sign in first", ended: step[1] });
				sse(res);
				if (step[0] === "entry") res.write(`id: ${step[1]}\nevent: entry\ndata: {}\n\nevent: end\ndata: {"ended":"${step[2]}"}\n\n`);
				else if (step[0] === "cut") res.write(`id: ${step[1]}\nevent: entry\ndata: {}\n\n`);
				else if (step[0] === "open") res.write(": ping\n\n");
				else if (step[0] === "end") res.write(`event: end\ndata: {"ended":"${step[1]}"}\n\n`);
				else res.write('event: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	return { fake, cookies, get opens() {
		return n;
	} };
}

test("a console restarted twice inside a minute keeps the chat (issue #737): a restart's 401, and the first re-login after a shutdown, use up no re-login window", { timeout: 10_000 }, async () => {
	// One instant for the whole stream: any two counted re-logins would be inside RELOGIN_WINDOW_MS.
	for (const [label, steps] of [
		["the 401 says restart", [["entry", "1-1", STREAM_SHUTDOWN], ["401", "restart"], ["entry", "1-2", STREAM_SHUTDOWN], ["401", "restart"], ["done"]]],
		["the first re-login after a shutdown, whatever its 401 says", [["entry", "1-1", STREAM_SHUTDOWN], ["401"], ["entry", "1-2", STREAM_SHUTDOWN], ["401"], ["done"]]],
		// A killed console: the stream is cut with no end, and the reconnect meets the new process's 401.
		["a restart's 401 with no shutdown before it (a killed console)", [["cut", "1-1"], ["401", "restart"], ["cut", "1-2"], ["401", "restart"], ["done"]]],
	]) {
		const c = scriptedConsole(steps);
		const port = await c.fake.listen();
		try {
			const states = [];
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async () => true, random: () => 1 });
			assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json", { onState: (st) => states.push(st) }), { done: "completed" }, label);
			assert.equal(c.fake.logins, 1 + steps.filter((s) => s[0] === "401").length, `${label}: one sign-in per restart`);
			assert.equal(states.filter((st) => st.relogin).length, steps.filter((s) => s[0] === "401").length, `${label}: each said`);
		} finally {
			await c.fake.close();
		}
	}
});

test("a real end still counts (issue #737): after a restart's free re-login, two ends inside a minute end the chat; entries after a shutdown close that stop", { timeout: 10_000 }, async () => {
	for (const [label, steps, logins] of [
		// The restart's re-login is free; the first real end signs in again; the second, at once, is the end.
		["restart, then two real ends", [["cut", "1-0"], ["401", "restart"], ["end", "elsewhere"], ["end", "all"]], 3],
		// A shutdown, then the console streams again as before (an entry): the stop is over, so the next end is real.
		["a shutdown the console came back from", [["entry", "1-1", STREAM_SHUTDOWN], ["entry", "1-2", "revoked"], ["end", "all"]], 2],
	]) {
		const c = scriptedConsole(steps);
		const port = await c.fake.listen();
		try {
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async () => true, random: () => 1 });
			await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e instanceof ConsoleError && e.status === 401 && /again within 60 s of a fresh one/.test(e.message), label);
			assert.equal(c.fake.logins, logins, label);
		} finally {
			await c.fake.close();
		}
	}
});

test("a console that answers every stream 401 restart (a hostile one) gets one counted re-login, then the chat ends", { timeout: 10_000 }, async () => {
	// A re-login loop: every sign-in accepted, every stream 401 {ended: "restart"}. Before, the 401
	// never counted, so the chat signed in again without bound. A free re-login needs a stream that opened since the last.
	for (const ended of ["restart", undefined]) {
		const c = scriptedConsole(Array.from({ length: 50 }, () => ["401", ended]));
		const port = await c.fake.listen();
		try {
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async () => true, random: () => 1 });
			await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e instanceof ConsoleError && e.status === 401 && /again within 60 s of a fresh one/.test(e.message), String(ended));
			assert.deepEqual([c.fake.logins, c.opens], [2, 2], `${ended}: the sign-in, one re-login, and the end`);
		} finally {
			await c.fake.close();
		}
	}
	// One that opens each stream only to say it is stopping, then refuses the reconnect 401: each free re-login is paid
	// for by a stream that opened, and the streams that never delivered an entry spend the failure budget.
	const c = scriptedConsole(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? ["end", STREAM_SHUTDOWN] : ["401", "restart"])));
	const port = await c.fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async () => true, random: () => 1, backoff: { baseMs: 1, capMs: 1, maxFailures: 8 } });
		await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e instanceof ConsoleError && /kept closing the stream/.test(e.message));
		assert.ok(c.fake.logins <= 8, `bounded by the failure budget: ${c.fake.logins} sign-ins`);
	} finally {
		await c.fake.close();
	}
});

test("only a 401 is a restart: an end that says restart counts like any end, and a free re-login is spent until a stream opens again", { timeout: 10_000 }, async () => {
	for (const [label, steps, logins] of [
		// An end comes from a console that knows the session, whatever its data says: two at once end the chat.
		["an end saying restart", [["end", "restart"], ["end", "restart"], ["end", "restart"]], 2],
		// The shutdown's free re-login is used once: the next 401 with no restart word is counted, the one after it the end.
		["the shutdown is over once its re-login is made", [["end", STREAM_SHUTDOWN], ["401"], ["open"], ["401"], ["open"], ["401"]], 3],
		// One stream that opened buys one free re-login, not every restart 401 after it.
		["one free re-login per stream that opened", [["cut", "1-1"], ["401", "restart"], ["401", "restart"], ["401", "restart"]], 3],
	]) {
		const c = scriptedConsole(steps);
		const port = await c.fake.listen();
		try {
			const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, now: () => 1_000_000, sleep: async () => true, random: () => 1 });
			await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e instanceof ConsoleError && e.status === 401 && /again within 60 s of a fresh one/.test(e.message), label);
			assert.equal(c.fake.logins, logins, label);
		} finally {
			await c.fake.close();
		}
	}
});

test("a stream's re-login refused as busy (429) is waited out and tried again, never the end of the chat", { timeout: 10_000 }, async () => {
	let opens = 0;
	let loginTries = 0;
	const fake = fakeConsole({
		routes: {
			"/login": (req, res, body, { json }) => {
				loginTries += 1;
				// The first sign-in, then the re-login refused once by the limiter, then accepted.
				if (loginTries === 2) return json(429, { error: "too many sign-in attempts; wait a minute and try again" }, { "retry-after": "3" });
				return json(200, { ok: true, name: "rob", role: "operator" }, { "set-cookie": `pdc_session=sess${loginTries}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
			},
			"/api/transcript": (req, res) => {
				opens += 1;
				sse(res);
				res.write(opens === 1 ? 'event: end\ndata: {"ended":"idle"}\n\n' : 'event: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const states = [];
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async () => true, random: () => 1 });
		assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json", { onState: (st) => states.push(st) }), { done: "completed" });
		assert.equal(loginTries, 3, "signed in, refused as busy, signed in");
		assert.equal(opens, 2);
		assert.deepEqual(states.map((st) => Object.keys(st)[0]), ["relogin", "waiting"], "the re-login, then a wait for the busy console");
		assert.equal(fake.seen.filter((r) => r.path === "/api/transcript")[1].headers.cookie, "pdc_session=sess3", "the stream resumed on the new sign-in");
	} finally {
		await fake.close();
	}
});

test("a multi-line refusal from the console comes out as one line with no control characters", { timeout: 10_000 }, async () => {
	assert.equal(oneLine("first line\r\nsecond\u001b[31m  line\u0085"), "first line second [31m line");
	assert.equal(oneLine("x".repeat(1200)).length, 1003);
	const fake = fakeConsole({ routes: { "/api/transcript": (req, res, body, { json }) => json(403, { error: "this needs the operator role\nand nothing else\u001b]0;pwned\u0007" }) } });
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, sleep: async () => true });
		await assert.rejects(client.stream("/api/transcript?id=j1&format=json"), (e) => e.status === 403 && e.message === "this needs the operator role and nothing else ]0;pwned");
	} finally {
		await fake.close();
	}
});

test("a body that stops moving is cut: a JSON answer after timeoutMs, a stream after streamIdleMs (and resumed)", { timeout: 10_000 }, async () => {
	let opens = 0;
	const fake = fakeConsole({
		routes: {
			"/api/run": (req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.write('{"run":');
			},
			"/api/transcript": (req, res) => {
				opens += 1;
				sse(res);
				if (opens === 1) return res.write("id: 1-1\nevent: entry\ndata: {}\n\n");
				res.write('event: done\ndata: {"outcome":"completed"}\n\n');
				res.end();
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, timeoutMs: 150, streamIdleMs: 150, sleep: async () => true });
		const started = Date.now();
		await assert.rejects(client.run({ id: "j1" }), (e) => e instanceof ConsoleError && /stopped sending its answer to GET \/api\/run/.test(e.message));
		assert.ok(Date.now() - started < 5000);
		const lastIds = [];
		const end = await client.stream("/api/transcript?id=j1&format=json", { onEvent: (e) => lastIds.push(e.id) });
		assert.deepEqual(end, { done: "completed" });
		assert.equal(opens, 2, "the silent stream was cut and resumed");
		assert.equal(fake.seen.filter((r) => r.path === "/api/transcript")[1].headers["last-event-id"], "1-1");
	} finally {
		await fake.close();
	}
});

test("a stream that keeps sending pings is never cut for idleness, however long it runs", { timeout: 10_000 }, async () => {
	let opens = 0;
	const fake = fakeConsole({
		routes: {
			"/api/transcript": (req, res) => {
				opens += 1;
				sse(res);
				let n = 0;
				const timer = setInterval(() => {
					n += 1;
					if (n < 8) return res.write(": ping\n\n");
					clearInterval(timer);
					res.write('event: done\ndata: {"outcome":"completed"}\n\n');
					res.end();
				}, 60);
				res.on("close", () => clearInterval(timer));
			},
		},
	});
	const port = await fake.listen();
	try {
		const client = makeConsoleClient({ address: parseConsoleAddress(`127.0.0.1:${port}`), token: TOKEN, streamIdleMs: 150, sleep: async () => true });
		assert.deepEqual(await client.stream("/api/transcript?id=j1&format=json"), { done: "completed" });
		assert.equal(opens, 1, "every byte re-arms the idle timer, so a stream 480 ms long under a 150 ms limit is one connection");
	} finally {
		await fake.close();
	}
});

/** A TTY-shaped input for askYesNo: `type(text)` delivers it as one chunk. */
function ttyInput() {
	const input = new EventEmitter();
	input.isTTY = true;
	input.pause = () => {};
	input.resume = () => {};
	input.type = (text) => input.emit("data", Buffer.from(text));
	return input;
}

test("askYesNo is yes only for a whole y or yes; anything else, a pipe included, is no", async () => {
	const output = { write() {} };
	for (const [typed, want] of [["y\n", true], ["  YES \r", true], ["yes\n", true], ["yesterday\n", false], ["yep\n", false], ["y es\n", false], ["n\n", false], ["\n", false]]) {
		const input = ttyInput();
		const asked = askYesNo("go? ", { input, output });
		input.type(typed);
		assert.equal(await asked, want, JSON.stringify(typed));
	}
	const written = [];
	assert.equal(await askYesNo("go? ", { input: { isTTY: false }, output: { write: (t) => written.push(t) } }), false);
	assert.match(written.join(""), /no terminal to answer on/);
});
