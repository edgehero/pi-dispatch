import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConnection } from "../src/connection.mjs";

// Issue #464, gate round 1 (measured on Fedora 44): WHATWG URL keeps an IPv6 literal's brackets in `hostname`, and the
// queue client then looked up the name "[::1]", which never resolves, so a `redis://[::1]:port` VALKEY_URL never
// connected. The host handed to BullMQ and ioredis is the address inside them.
test("parseConnection hands the client an IPv6 literal without its brackets, and every other host as written", () => {
	assert.equal(parseConnection("redis://[::1]:16510").host, "::1");
	assert.equal(parseConnection("redis://:pw@[fe80::1]:6379/2").host, "fe80::1");
	assert.equal(parseConnection("redis://[::1]:16510").port, 16510);
	assert.equal(parseConnection("redis://127.0.0.1:6379").host, "127.0.0.1");
	assert.equal(parseConnection("redis://localhost").host, "localhost");
	assert.equal(parseConnection("redis://valkey.lan:6380/3").db, 3);
});

// Gate round 2: the worker connects to a pinned literal address; a `rediss:` URL keeps its name for the certificate
// check, and `rediss:` gets TLS at all (host and port alone dropped it, so BullMQ spoke plaintext).
test("parseConnection gives rediss: TLS, with the original name as servername when the address is pinned", () => {
	assert.deepEqual(parseConnection("rediss://192.168.5.15:6380", { servername: "valkey.lan" }).tls, { servername: "valkey.lan" });
	assert.deepEqual(parseConnection("rediss://valkey.lan:6380").tls, {});
	assert.equal(parseConnection("redis://127.0.0.1:6379", { servername: "x" }).tls, undefined, "plain redis: stays plaintext");
});
