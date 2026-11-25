import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { tempDir } from "./helpers/temp-dir.mjs";
import { artifactLimitsOf, collectArtifacts } from "../src/artifacts.mjs";
import { artifactsManifestOf } from "../src/artifacts-record.mjs";
import {
	ARTIFACTS_CHUNK_BYTES, ARTIFACTS_HOST_CONCURRENCY, ARTIFACTS_READ_MS, ARTIFACTS_REPLY_MAX, ARTIFACTS_REPLY_PREFIX, ARTIFACTS_REQUEST_MAX,
	ARTIFACTS_REQUEST_PREFIX, openHostArtifactTransfer, readHostArtifactsManifest, serveArtifacts,
} from "../src/artifacts-channel.mjs";

// Issue #942, INT-ARTIFACTS-CHANNEL: a console reads a run's kept files from the host that kept them, over pub/sub on the
// deployment's Valkey. The unit tests run on a fake pub/sub (history-reader.test.mjs's) and a store the REAL collector
// wrote; the last test makes one round trip through a real Valkey.

const NOW = Date.parse("2026-11-20T09:00:00Z");
const CHUNK = ARTIFACTS_CHUNK_BYTES;
const BIG = randomBytes(2 * CHUNK + 1234);
const EXACT = randomBytes(CHUNK);
const TEXT = Buffer.from("e2e: 14 passed\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nonce = (n) => n.toString(16).padStart(32, "0");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A store the real collector made for `jobId`, with a file over two chunks, one exactly a chunk, a text and an empty one. */
function storeFor(jobId = "gh-1") {
	const job = tempDir("pi-artifacts-channel-job-");
	writeFileSync(join(job, "big.bin"), BIG);
	writeFileSync(join(job, "exact.bin"), EXACT);
	writeFileSync(join(job, "note.txt"), TEXT);
	writeFileSync(join(job, "empty.txt"), "");
	const storeDir = tempDir("pi-artifacts-channel-store-");
	const kept = collectArtifacts({ dir: job, storeDir, jobId, limits: artifactLimitsOf({ maxFiles: 20, maxFileMb: 10, maxRunMb: 25 }), now: () => NOW });
	assert.equal(kept.kept, 4);
	const runDir = join(storeDir, jobId.replace(/[^A-Za-z0-9._-]/g, "_"));
	const manifest = artifactsManifestOf(readFileSync(join(runDir, "manifest.json"), "utf8"));
	return { storeDir, runDir, manifest, entry: (name) => manifest.files.find((f) => f.name === name) };
}

/** A pub/sub that delivers in process, as Valkey would: a message reaches every client subscribed to its channel. */
function bus() {
	const clients = new Set();
	const published = [];
	const make = () => {
		const c = new EventEmitter();
		c.channels = new Set();
		clients.add(c);
		c.duplicate = make;
		c.subscribe = async (channel) => { c.channels.add(channel); };
		c.publish = async (channel, body) => {
			published.push({ channel, body });
			for (const peer of clients) if (peer.channels.has(channel)) peer.emit("message", channel, body);
		};
		c.disconnect = () => clients.delete(c);
		return c;
	};
	return { redis: make(), clients, published };
}

/** Publish `body` to `host`'s channel and the first reply on `id`'s, or null when none comes within `wait` ms. */
async function ask(redis, host, body, id = nonce(1), wait = 2000) {
	const sub = redis.duplicate();
	const got = [];
	sub.on("message", (channel, text) => { if (channel === ARTIFACTS_REPLY_PREFIX + id) got.push(JSON.parse(text)); });
	await sub.subscribe(ARTIFACTS_REPLY_PREFIX + id);
	try {
		await redis.publish(ARTIFACTS_REQUEST_PREFIX + host, typeof body === "string" ? body : JSON.stringify(body));
		for (let waited = 0; got.length === 0 && waited < wait; waited += 2) await tick(2);
		return got[0] ?? null;
	} finally {
		sub.disconnect();
	}
}

/** The promises API, recording every path it is asked for, and holding `lstat` until `gate` resolves when given one. */
function recordingFs(gate = null) {
	const seen = [];
	return {
		seen,
		fs: {
			async lstat(path) { seen.push(path); if (gate) await gate; return fsp.lstat(path); },
			async open(path, flags) { seen.push(path); return fsp.open(path, flags); },
		},
	};
}

const chunkReq = (store, name, offset, extra = {}) => ({ id: nonce(1), run: "gh-1", op: "chunk", name, sha256: store.entry(name)?.sha256 ?? "f".repeat(64), offset, ...extra });

test("the channel's bounds are pinned by their numbers", () => {
	assert.deepEqual(
		[ARTIFACTS_REQUEST_PREFIX, ARTIFACTS_REPLY_PREFIX, ARTIFACTS_REQUEST_MAX, ARTIFACTS_CHUNK_BYTES, ARTIFACTS_REPLY_MAX, ARTIFACTS_HOST_CONCURRENCY, ARTIFACTS_READ_MS],
		["artifacts:request:", "artifacts:reply:", 1024, 196608, 263168, 4, 5000],
	);
});

test("a manifest and a file over two chunks round trip byte for byte, a chunk per message, and every client is closed", async () => {
	const store = storeFor();
	const { redis, clients, published } = bus();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir });
	try {
		const read = await readHostArtifactsManifest({ redis, host: "worker-a", jobId: "gh-1" });
		assert.deepEqual(read, { manifest: store.manifest });
		const big = store.entry("big.bin");
		const transfer = await openHostArtifactTransfer({ redis, host: "worker-a", jobId: "gh-1" });
		const parts = [];
		for (const offset of [0, CHUNK, 2 * CHUNK]) {
			const got = await transfer.chunk({ name: "big.bin", sha256: big.sha256, offset });
			assert.equal(got.offset, offset);
			assert.equal(got.last, offset === 2 * CHUNK, "last exactly when offset plus length is the size");
			assert.equal(got.data.length, offset === 2 * CHUNK ? 1234 : CHUNK);
			parts.push(got.data);
		}
		const whole = Buffer.concat(parts);
		assert.equal(whole.length, big.size);
		assert.equal(sha(whole), big.sha256);
		assert.ok(whole.equals(BIG));
		const exact = await transfer.chunk({ name: "exact.bin", sha256: store.entry("exact.bin").sha256, offset: 0 });
		assert.equal(exact.last, true, "a file of exactly one chunk ends at its first");
		assert.ok(exact.data.equals(EXACT));
		const empty = await transfer.chunk({ name: "empty.txt", sha256: store.entry("empty.txt").sha256, offset: 0 });
		assert.deepEqual({ ...empty, data: empty.data.length }, { offset: 0, data: 0, last: true }, "an empty file is one empty last chunk");
		const replies = published.filter((p) => p.channel.startsWith(ARTIFACTS_REPLY_PREFIX));
		assert.ok(replies.length >= 6 && replies.every((p) => Buffer.byteLength(p.body) <= ARTIFACTS_REPLY_MAX), "no reply is over the bound a reader takes");
		const ids = new Set(published.filter((p) => p.channel === ARTIFACTS_REQUEST_PREFIX + "worker-a").map((p) => JSON.parse(p.body).id));
		assert.equal(ids.size, 2, "one nonce for the manifest read, one for the whole transfer");
		assert.equal(clients.size, 3, "the caller's, the host's and the transfer's one subscription");
		transfer.close();
		assert.equal(clients.size, 2);
	} finally {
		await service.close();
		redis.disconnect();
	}
	assert.equal(clients.size, 0);
});

test("an offset must be a whole chunk below the size, or 0 for an empty file, and the reader refuses one before asking", async () => {
	const store = storeFor();
	const { redis, published } = bus();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir });
	try {
		for (const offset of [1, CHUNK - 1, 3 * CHUNK, -CHUNK, 1.5, "0", null]) {
			assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "big.bin", offset)), { error: "invalid-request" }, `big.bin at ${offset}`);
		}
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "exact.bin", CHUNK)), { error: "invalid-request" }, "at the size");
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "empty.txt", CHUNK)), { error: "invalid-request" }, "an empty file has only 0");
		assert.equal((await ask(redis, "worker-a", chunkReq(store, "big.bin", 2 * CHUNK))).last, true);
		const transfer = await openHostArtifactTransfer({ redis, host: "worker-a", jobId: "gh-1" });
		const before = published.length;
		for (const offset of [1, -CHUNK, 0.5, "0"]) {
			assert.deepEqual(await transfer.chunk({ name: "big.bin", sha256: store.entry("big.bin").sha256, offset }), { error: "invalid-request" });
		}
		assert.deepEqual(await transfer.chunk({ name: "../x", sha256: "a".repeat(64), offset: 0 }), { error: "invalid-request" });
		assert.equal(published.length, before, "nothing the host would refuse is sent");
		transfer.close();
	} finally {
		await service.close();
	}
});

test("a name the manifest does not list is missing and opens nothing by that name; a name outside the charset is refused unread", async () => {
	const store = storeFor();
	const { redis } = bus();
	const rec = recordingFs();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir, fs: rec.fs });
	try {
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "other.txt", 0)), { missing: true });
		assert.deepEqual(rec.seen, [store.runDir, join(store.runDir, "manifest.json")], "the run's folder and manifest, nothing built from the name");
		rec.seen.length = 0;
		assert.equal((await ask(redis, "worker-a", chunkReq(store, "note.txt", 0))).data, TEXT.toString("base64"));
		assert.deepEqual(rec.seen, [store.runDir, join(store.runDir, "manifest.json"), join(store.runDir, "files"), join(store.runDir, "files", "note.txt")]);
		rec.seen.length = 0;
		for (const name of ["../x", "a/b", "x".repeat(65), ".hidden", "../gh-1/manifest.json"]) {
			assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, name, 0, { sha256: "a".repeat(64) })), { error: "invalid-request" }, name);
		}
		assert.deepEqual(rec.seen, [], "a refused name reaches no file system call");
	} finally {
		await service.close();
	}
});

test("a request is held to its shape: its size, its keys, its op, its run, its digest and its nonce", async () => {
	const store = storeFor();
	const { redis } = bus();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir });
	try {
		const manifestReq = { id: nonce(1), run: "gh-1", op: "manifest" };
		assert.deepEqual(await ask(redis, "worker-a", manifestReq), { manifest: store.manifest }, "the control");
		const padded = JSON.stringify(manifestReq) + " ".repeat(ARTIFACTS_REQUEST_MAX);
		assert.deepEqual(JSON.parse(padded), manifestReq, "still the same request, only longer");
		assert.equal(await ask(redis, "worker-a", padded, nonce(1), 50), null, "a body over 1024 bytes is not read");
		const refused = [
			{ ...manifestReq, path: "/etc" },
			{ ...manifestReq, op: "list" },
			{ id: nonce(1), op: "manifest" },
			{ ...manifestReq, run: "a/b" },
			{ ...manifestReq, run: ".." },
			{ ...manifestReq, run: "" },
			{ ...manifestReq, run: "x".repeat(201) },
			{ ...manifestReq, run: 7 },
			{ ...manifestReq, name: "note.txt" },
			chunkReq(store, "note.txt", 0, { extra: 1 }),
			chunkReq(store, "note.txt", 0, { sha256: "A".repeat(64) }),
			chunkReq(store, "note.txt", 0, { sha256: "a".repeat(63) }),
			{ id: nonce(1), run: "gh-1", op: "chunk", name: "note.txt", offset: 0 },
		];
		for (const body of refused) assert.deepEqual(await ask(redis, "worker-a", body), { error: "invalid-request" }, JSON.stringify(body));
		for (const [body, id] of [[{ ...manifestReq, id: "XYZ" }, "XYZ"], [{ ...manifestReq, id: "ABCDEF".padEnd(32, "0") }, "ABCDEF".padEnd(32, "0")], [{ ...manifestReq, id: nonce(1) + "0" }, nonce(1) + "0"], ["not json", nonce(1)], [JSON.stringify([manifestReq]), nonce(1)], ["null", nonce(1)]]) {
			assert.equal(await ask(redis, "worker-a", body, id, 50), null, `no reply without a valid nonce: ${String(JSON.stringify(body)).slice(0, 40)}`);
		}
	} finally {
		await service.close();
	}
});

test("a link as the run's folder, as files/, as the manifest or as the file is refused", async () => {
	const { redis } = bus();
	// The run's folder: a link to a real one, in a store of its own.
	const real = storeFor();
	const linked = tempDir("pi-artifacts-channel-linked-");
	symlinkSync(real.runDir, join(linked, "gh-1"));
	for (const [storeDir, expected] of [[real.storeDir, { manifest: real.manifest }], [linked, { error: "artifacts-unreadable" }]]) {
		const service = await serveArtifacts({ redis, host: "worker-a", storeDir });
		try {
			assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1", op: "manifest" }), expected);
			if (storeDir === linked) assert.deepEqual(await ask(redis, "worker-a", chunkReq(real, "note.txt", 0)), { error: "artifacts-unreadable" });
		} finally {
			await service.close();
		}
	}
	// files/ as a link.
	const files = storeFor();
	const service = await serveArtifacts({ redis, host: "worker-b", storeDir: files.storeDir });
	try {
		assert.equal((await ask(redis, "worker-b", chunkReq(files, "note.txt", 0))).data, TEXT.toString("base64"), "the control");
		renameSync(join(files.runDir, "files"), join(files.storeDir, "elsewhere"));
		symlinkSync(join(files.storeDir, "elsewhere"), join(files.runDir, "files"));
		assert.deepEqual(await ask(redis, "worker-b", chunkReq(files, "note.txt", 0)), { error: "artifacts-unreadable" });
		// The file as a link (files/ a plain folder again): a link is no longer the plain file that was kept.
		rmSync(join(files.runDir, "files"));
		mkdirSync(join(files.runDir, "files"));
		symlinkSync(join(files.storeDir, "elsewhere", "note.txt"), join(files.runDir, "files", "note.txt"));
		assert.deepEqual(await ask(redis, "worker-b", chunkReq(files, "note.txt", 0)), { changed: true });
		// The manifest as a link.
		renameSync(join(files.runDir, "manifest.json"), join(files.storeDir, "manifest-elsewhere.json"));
		symlinkSync(join(files.storeDir, "manifest-elsewhere.json"), join(files.runDir, "manifest.json"));
		assert.deepEqual(await ask(redis, "worker-b", { id: nonce(1), run: "gh-1", op: "manifest" }), { error: "artifacts-unreadable" });
	} finally {
		await service.close();
	}
});

test("a file whose digest, size or kind changed is changed; another job's manifest is unreadable; what is gone is missing", async () => {
	const store = storeFor();
	const { redis } = bus();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir });
	try {
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "note.txt", 0, { sha256: "f".repeat(64) })), { changed: true }, "the reader's digest is not the manifest's");
		appendFileSync(join(store.runDir, "files", "note.txt"), "x");
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "note.txt", 0)), { changed: true }, "the size is not the manifest's");
		rmSync(join(store.runDir, "files", "note.txt"));
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "note.txt", 0)), { missing: true }, "the file is gone");
		mkdirSync(join(store.runDir, "files", "note.txt"));
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "note.txt", 0)), { changed: true }, "no longer a plain file");
		// A FIFO of the empty file's size 0: refused by its kind alone, and opened without waiting for a writer.
		rmSync(join(store.runDir, "files", "empty.txt"));
		execFileSync("mkfifo", [join(store.runDir, "files", "empty.txt")]);
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "empty.txt", 0)), { changed: true }, "a FIFO is no plain file");
		rmSync(join(store.runDir, "files"), { recursive: true });
		assert.deepEqual(await ask(redis, "worker-a", chunkReq(store, "big.bin", 0)), { missing: true }, "files/ is gone");
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-2", op: "manifest" }), { missing: true }, "no folder for the run");
		writeFileSync(join(store.runDir, "manifest.json"), "{");
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1", op: "manifest" }), { error: "artifacts-unreadable" });
		writeFileSync(join(store.runDir, "manifest.json"), JSON.stringify(store.manifest) + " ".repeat(256 * 1024));
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1", op: "manifest" }), { error: "artifacts-unreadable" }, "over the manifest's bound");
		rmSync(join(store.runDir, "manifest.json"));
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1", op: "manifest" }), { missing: true }, "no manifest for the run");
	} finally {
		await service.close();
	}
	// `gh-1:r2` keeps its files in `gh-1_r2`, the folder `gh-1_r2` would name: the manifest says whose they are.
	const shared = storeFor("gh-1:r2");
	const other = await serveArtifacts({ redis, host: "worker-a", storeDir: shared.storeDir });
	try {
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1:r2", op: "manifest" }), { manifest: shared.manifest });
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1_r2", op: "manifest" }), { error: "artifacts-unreadable" });
		assert.deepEqual(await ask(redis, "worker-a", { ...chunkReq(shared, "note.txt", 0), run: "gh-1_r2" }), { error: "artifacts-unreadable" });
	} finally {
		await other.close();
	}
});

test("four requests are served at once, the fifth is host-busy, and one after them is served again", async () => {
	const store = storeFor();
	const { redis } = bus();
	let open;
	const gate = new Promise((resolve) => { open = resolve; });
	const rec = recordingFs(gate);
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir, fs: rec.fs });
	try {
		const asked = [1, 2, 3, 4, 5].map((n) => ask(redis, "worker-a", { id: nonce(n), run: "gh-1", op: "manifest" }, nonce(n)));
		await tick(20);
		open();
		const answers = await Promise.all(asked);
		assert.deepEqual(answers.map((a) => a.error ?? "manifest"), ["manifest", "manifest", "manifest", "manifest", "host-busy"]);
		assert.deepEqual(await ask(redis, "worker-a", { id: nonce(6), run: "gh-1", op: "manifest" }, nonce(6)), { manifest: store.manifest });
	} finally {
		await service.close();
	}
});

test("close() ends the subscription: a request after it gets no reply", async () => {
	const store = storeFor();
	const { redis, clients } = bus();
	const service = await serveArtifacts({ redis, host: "worker-a", storeDir: store.storeDir });
	assert.equal(clients.size, 2);
	await service.close();
	assert.equal(clients.size, 1);
	assert.equal(await ask(redis, "worker-a", { id: nonce(1), run: "gh-1", op: "manifest" }, nonce(1), 50), null);
	assert.deepEqual(await readHostArtifactsManifest({ redis, host: "worker-a", jobId: "gh-1", timeoutMs: 30 }), { error: "host-unavailable" });
	assert.equal(clients.size, 1, "the reader closed its own subscription");
});

test("serveArtifacts refuses a bad host or store, and a subscription that fails or does not finish", async () => {
	const { redis, clients } = bus();
	await assert.rejects(serveArtifacts({ redis, host: "-lead", storeDir: "/x" }), TypeError);
	await assert.rejects(serveArtifacts({ redis, host: "worker-a", storeDir: "" }), TypeError);
	const failing = { duplicate() { const c = redis.duplicate(); c.subscribe = async () => { throw new Error("refused"); }; return c; } };
	await assert.rejects(serveArtifacts({ redis: failing, host: "worker-a", storeDir: "/x" }), /refused/);
	const hanging = { duplicate() { const c = redis.duplicate(); c.subscribe = () => new Promise(() => {}); return c; } };
	await assert.rejects(serveArtifacts({ redis: hanging, host: "worker-a", storeDir: "/x", timeoutMs: 20 }), /timed out/);
	assert.equal(clients.size, 1, "a failed subscription is disconnected");
});

/** A host that answers each request on `host` with the bodies `script(request)` gives, in order. */
function fakeHost(redis, host, script) {
	const sub = redis.duplicate();
	const requests = [];
	sub.on("message", (channel, body) => {
		const request = JSON.parse(body);
		requests.push(request);
		for (const reply of script(request)) void redis.publish(ARTIFACTS_REPLY_PREFIX + request.id, typeof reply === "string" ? reply : JSON.stringify(reply));
	});
	sub.subscribe(ARTIFACTS_REQUEST_PREFIX + host);
	return { requests, close: () => sub.disconnect() };
}

test("the transfer takes only a reply for its offset, within the bound, in strict base64 of at most a chunk", async () => {
	const { redis, clients } = bus();
	const good = { offset: CHUNK, data: Buffer.from("ABC").toString("base64"), last: true };
	const bad = {
		"another offset": { ...good, offset: 0 },
		"over the bound": JSON.stringify(good) + " ".repeat(ARTIFACTS_REPLY_MAX),
		"loose base64": { ...good, data: "QUJD\n" },
		"unpadded base64": { ...good, data: "QQ" },
		"url-safe base64": { ...good, data: "-_-_" },
		"over a chunk": { ...good, data: Buffer.alloc(CHUNK + 1).toString("base64") },
		"last not a boolean": { ...good, last: "yes" },
		"a key too many": { ...good, more: 1 },
		"no JSON": "{",
		"an unknown error": { error: "disk-on-fire" },
	};
	let pending = null;
	const host = fakeHost(redis, "fake", () => pending);
	const transfer = await openHostArtifactTransfer({ redis, host: "fake", jobId: "gh-1" });
	const ask1 = () => transfer.chunk({ name: "big.bin", sha256: "a".repeat(64), offset: CHUNK, timeoutMs: 30 });
	try {
		for (const [why, reply] of Object.entries(bad)) {
			pending = [reply];
			assert.deepEqual(await ask1(), { error: "host-unavailable" }, `${why}: ignored, so the wait times out`);
			pending = [reply, good];
			const got = await ask1();
			assert.equal(got.offset, CHUNK, why);
			assert.equal(got.data.toString(), "ABC", why);
			assert.equal(got.last, true, why);
		}
		pending = [{ ...good, data: "" }];
		assert.equal((await ask1()).data.length, 0, "an empty chunk is strict base64 too");
		for (const reply of [{ missing: true }, { changed: true }, { error: "host-busy" }, { error: "artifacts-unreadable" }, { error: "invalid-request" }]) {
			pending = [reply];
			assert.deepEqual(await ask1(), reply);
		}
		assert.ok(host.requests.length > 0 && host.requests.every((r) => r.id === host.requests[0].id), "one nonce, one subscription, for the transfer");
		assert.equal(clients.size, 3);
	} finally {
		transfer.close();
		host.close();
	}
	assert.equal(clients.size, 1);
});

test("the transfer sends one request at a time, and close() ends a wait and every later one", async () => {
	const { redis } = bus();
	const answered = [];
	const sub = redis.duplicate();
	const seen = [];
	sub.on("message", (channel, body) => {
		const r = JSON.parse(body);
		seen.push({ offset: r.offset, answeredBefore: answered.length });
		// Answer the first a little later, so a second request sent at once would arrive before it.
		setTimeout(() => { answered.push(r.offset); void redis.publish(ARTIFACTS_REPLY_PREFIX + r.id, JSON.stringify({ offset: r.offset, data: "", last: false })); }, r.offset === 0 ? 20 : 0);
	});
	await sub.subscribe(ARTIFACTS_REQUEST_PREFIX + "fake");
	const transfer = await openHostArtifactTransfer({ redis, host: "fake", jobId: "gh-1" });
	const [a, b] = await Promise.all([0, CHUNK].map((offset) => transfer.chunk({ name: "big.bin", sha256: "a".repeat(64), offset })));
	assert.deepEqual([a.offset, b.offset], [0, CHUNK]);
	assert.deepEqual(seen, [{ offset: 0, answeredBefore: 0 }, { offset: CHUNK, answeredBefore: 1 }], "the second went only once the first was answered");
	sub.disconnect();
	const waiting = transfer.chunk({ name: "big.bin", sha256: "a".repeat(64), offset: 0, timeoutMs: 60_000 });
	await tick(5);
	transfer.close();
	assert.deepEqual(await waiting, { error: "host-unavailable" });
	assert.deepEqual(await transfer.chunk({ name: "big.bin", sha256: "a".repeat(64), offset: 0 }), { error: "host-unavailable" });
	transfer.close();
	redis.disconnect();
});

test("the manifest reader rebuilds what it is sent and refuses another job's or a malformed one", async () => {
	const { redis, clients, published } = bus();
	const store = storeFor();
	let replies = [];
	const host = fakeHost(redis, "fake", () => replies);
	const read = (extra = {}) => readHostArtifactsManifest({ redis, host: "fake", jobId: "gh-1", timeoutMs: 30, ...extra });
	try {
		replies = [{ manifest: { ...store.manifest, files: store.manifest.files.map((f) => ({ ...f, path: "/srv/x" })), extra: 1 } }];
		assert.deepEqual(await read(), { manifest: store.manifest }, "rebuilt: no field the version 1 shape does not name");
		replies = [{ manifest: { ...store.manifest, jobId: "gh-other" } }];
		assert.deepEqual(await read(), { error: "artifacts-unreadable" }, "another job's");
		replies = [{ manifest: { ...store.manifest, files: [{ ...store.manifest.files[0], name: "../x" }] } }];
		assert.deepEqual(await read(), { error: "artifacts-unreadable" }, "a name outside the charset");
		replies = [{ manifest: null }];
		assert.deepEqual(await read(), { error: "artifacts-unreadable" });
		for (const reply of [{ missing: true }, { error: "host-busy" }, { error: "invalid-request" }, { error: "artifacts-unreadable" }]) {
			replies = [reply];
			assert.deepEqual(await read(), reply);
		}
		for (const reply of [{ error: "disk-on-fire" }, { missing: "yes" }, { manifest: store.manifest, more: 1 }, "{", JSON.stringify({ missing: true }) + " ".repeat(ARTIFACTS_REPLY_MAX)]) {
			replies = [reply];
			assert.deepEqual(await read(), { error: "host-unavailable" }, `ignored: ${String(JSON.stringify(reply)).slice(0, 40)}`);
		}
		const before = published.length;
		assert.deepEqual(await read({ jobId: "a/b" }), { error: "invalid-request" }, "a run id no host would take is not sent");
		assert.deepEqual(await read({ jobId: ".." }), { error: "invalid-request" });
		assert.equal(published.length, before);
		assert.deepEqual(await read({ host: "-lead" }), { error: "host-unavailable" });
		assert.deepEqual(await readHostArtifactsManifest({ redis: null, host: "fake", jobId: "gh-1" }), { error: "host-unavailable" });
		const failing = { duplicate() { const c = redis.duplicate(); c.subscribe = async () => { throw new Error("refused"); }; return c; }, publish: redis.publish };
		assert.deepEqual(await readHostArtifactsManifest({ redis: failing, host: "fake", jobId: "gh-1" }), { error: "host-unavailable" });
		const refusing = { duplicate() { const c = redis.duplicate(); c.subscribe = async () => { throw new Error("refused"); }; return c; } };
		assert.deepEqual(await openHostArtifactTransfer({ redis: refusing, host: "fake", jobId: "gh-1" }), { error: "host-unavailable" });
		const stuck = { duplicate() { const c = redis.duplicate(); c.subscribe = () => new Promise(() => {}); return c; } };
		assert.deepEqual(await openHostArtifactTransfer({ redis: stuck, host: "fake", jobId: "gh-1", timeoutMs: 20 }), { error: "host-unavailable" });
		assert.deepEqual(await openHostArtifactTransfer({ redis, host: "a b", jobId: "gh-1" }), { error: "host-unavailable" });
		assert.equal(clients.size, 2, "every reader closed its subscription, the refused ones included");
	} finally {
		host.close();
	}
});

// --- against a real Valkey ------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("artifacts-channel's live round trip REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the live round trip needs a real Valkey";

test("live: a manifest and a file over two chunks cross a real Valkey's pub/sub, and no key is written", { skip: live }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(valkeyUrl);
	redis.on("error", () => {});
	// A channel name of this test's own: pub/sub is not per database, so the name is what keeps it apart.
	const host = `artifacts-live-${randomBytes(6).toString("hex")}`;
	const store = storeFor();
	let service = null;
	try {
		service = await serveArtifacts({ redis, host, storeDir: store.storeDir });
		assert.deepEqual(await readHostArtifactsManifest({ redis, host, jobId: "gh-1" }), { manifest: store.manifest });
		const big = store.entry("big.bin");
		const transfer = await openHostArtifactTransfer({ redis, host, jobId: "gh-1" });
		const parts = [];
		try {
			for (let offset = 0, last = false; !last; offset += CHUNK) {
				const got = await transfer.chunk({ name: "big.bin", sha256: big.sha256, offset });
				assert.equal(got.offset, offset);
				parts.push(got.data);
				last = got.last;
			}
		} finally {
			transfer.close();
		}
		assert.equal(parts.length, 3);
		assert.equal(sha(Buffer.concat(parts)), big.sha256);
		assert.deepEqual(await readHostArtifactsManifest({ redis, host, jobId: "gh-none" }), { missing: true });
		assert.deepEqual(await redis.keys("artifacts:*"), [], "pub/sub only: no key under the channels' names");
		await service.close();
		service = null;
		assert.deepEqual(await readHostArtifactsManifest({ redis, host, jobId: "gh-1", timeoutMs: 200 }), { error: "host-unavailable" }, "a host that stopped serving does not answer");
	} finally {
		await service?.close();
		await redis.quit().catch(() => redis.disconnect());
	}
});
