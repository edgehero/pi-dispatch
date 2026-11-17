import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearStaleGrants, grantOnAttach, grantText, grantsDirOf, inSubnet, proxyAddressesOn, readBackArgs, readBackInput, readBackPassed, removeGrantsOf, sweepGrants, writeGrant } from "../src/endpoint-grants.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const tmp = () => tempDir("pi-grants-");
// The measured shape (OrbStack, Docker Engine 29.8.2, 2026-11-16): the proxy on two job networks, one with IPv6.
const NETWORKS = JSON.stringify({
	"pi-job-a-net": { IPAddress: "192.168.148.2", IPPrefixLen: 24, GlobalIPv6Address: "", GlobalIPv6PrefixLen: 0 },
	"pi-job-v6-net": { IPAddress: "192.168.107.2", IPPrefixLen: 24, GlobalIPv6Address: "fd07:b51a:cc66:d000:0::2", GlobalIPv6PrefixLen: 64 },
});

test("grantsDirOf: the Docker CLI's grants are egress-grants/local, rootless Podman's egress-grants/podman", () => {
	assert.equal(grantsDirOf("/dep", "docker"), join("/dep", "egress-grants", "local"));
	assert.equal(grantsDirOf("/dep", "podman"), join("/dep", "egress-grants", "podman"));
});

test("proxyAddressesOn reads the proxy's IPv4 and IPv6 address on one network, IPv6 in squid's compressed spelling", () => {
	assert.deepEqual(proxyAddressesOn(NETWORKS, "pi-job-a-net"), [{ address: "192.168.148.2", prefix: 24 }]);
	assert.deepEqual(proxyAddressesOn(NETWORKS, "pi-job-v6-net"), [{ address: "192.168.107.2", prefix: 24 }, { address: "fd07:b51a:cc66:d000::2", prefix: 64 }]);
	assert.deepEqual(proxyAddressesOn(NETWORKS, "pi-job-gone-net"), []);
	assert.deepEqual(proxyAddressesOn("not json", "pi-job-a-net"), []);
});

test("inSubnet compares the network part only, within one family", () => {
	assert.equal(inSubnet("192.168.148.7", "192.168.148.2", 24), true);
	assert.equal(inSubnet("192.168.149.2", "192.168.148.2", 24), false);
	assert.equal(inSubnet("fd07:b51a:cc66:d000::9", "fd07:b51a:cc66:d000::2", 64), true);
	assert.equal(inSubnet("fd07:b51a:cc66:d001::2", "fd07:b51a:cc66:d000::2", 64), false);
	assert.equal(inSubnet("192.168.148.2", "fd07::2", 64), false, "never across families");
	assert.equal(inSubnet(".192.168.148.2.tmp-1", "192.168.148.2", 24), false, "a temp file is not an address");
});

test("clearStaleGrants deletes every grant in the new network's subnets and nothing else; a missing folder holds none", () => {
	const dir = tmp();
	for (const name of ["192.168.148.2", "192.168.148.9", "192.168.155.2", "fd07:b51a:cc66:d000::2"]) writeFileSync(join(dir, name), "network old\nbench-device\n");
	const removed = clearStaleGrants({ dir, on: proxyAddressesOn(NETWORKS, "pi-job-a-net") });
	assert.deepEqual(removed.sort(), ["192.168.148.2", "192.168.148.9"]);
	assert.deepEqual(readdirSync(dir).sort(), ["192.168.155.2", "fd07:b51a:cc66:d000::2"]);
	assert.deepEqual(clearStaleGrants({ dir: join(dir, "absent"), on: [{ address: "10.0.0.2", prefix: 24 }] }), []);
	// Any other failure throws: the caller refuses to start a job on a network that may carry another job's grant.
	assert.throws(() => clearStaleGrants({ dir, on: [{ address: "192.168.155.2", prefix: 24 }], fs: { readdirSync: () => ["192.168.155.2"], unlinkSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } } }), /EACCES/);
});

test("writeGrant writes one grant per address by rename, mode 0644 under any umask, every line ended", { skip: process.platform === "win32" }, () => {
	const dir = tmp();
	const umask = process.umask(0o077);
	try {
		writeGrant({ dir, network: "pi-job-v6-net", addresses: proxyAddressesOn(NETWORKS, "pi-job-v6-net"), ids: ["bench-device", "lab"] });
	} finally {
		process.umask(umask);
	}
	assert.deepEqual(readdirSync(dir).sort(), ["192.168.107.2", "fd07:b51a:cc66:d000::2"], "no temp file left");
	for (const name of readdirSync(dir)) {
		assert.equal(readFileSync(join(dir, name), "utf8"), "network pi-job-v6-net\nbench-device\nlab\n");
		assert.equal(statSync(join(dir, name)).mode & 0o777, 0o644, "squid's own user reads it");
	}
	assert.equal(grantText("n", ["a"]), "network n\na\n");
});

test("removeGrantsOf removes the grants naming one network, by their own first line; sweepGrants keeps only live networks' grants", () => {
	const dir = tmp();
	writeFileSync(join(dir, "10.1.0.2"), grantText("pi-job-a-net", ["bench-device"]));
	writeFileSync(join(dir, "10.2.0.2"), grantText("pi-job-b-net", ["bench-device"]));
	writeFileSync(join(dir, "10.3.0.2"), grantText("pi-job-c-net", ["lab"]));
	writeFileSync(join(dir, ".10.4.0.2.tmp-77"), "network pi-job-d-net\n");
	writeFileSync(join(dir, "10.5.0.2"), "not a grant\n");
	assert.equal(removeGrantsOf({ dir, network: "pi-job-a-net" }), 1);
	assert.deepEqual(readdirSync(dir).sort(), [".10.4.0.2.tmp-77", "10.2.0.2", "10.3.0.2", "10.5.0.2"]);
	assert.equal(removeGrantsOf({ dir: join(dir, "absent"), network: "x" }), 0);
	const swept = sweepGrants({ dir, live: new Set(["pi-job-b-net", "bridge"]) });
	assert.deepEqual(swept.sort(), [".10.4.0.2.tmp-77", "10.3.0.2", "10.5.0.2"]);
	assert.deepEqual(readdirSync(dir), ["10.2.0.2"]);
	// A folder or a grant that cannot be read is said, never read as nothing to do.
	const eacces = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
	assert.throws(() => sweepGrants({ dir, live: new Set(), fs: { readdirSync: eacces } }), /EACCES/, "the boot says it");
	assert.deepEqual(sweepGrants({ dir: join(dir, "absent"), live: new Set() }), [], "no folder holds no grant");
	assert.throws(() => removeGrantsOf({ dir, network: "pi-job-b-net", fs: { readdirSync: () => ["10.2.0.2"], readFileSync: eacces } }), /EACCES/, "a grant that may be this network's and cannot be read");
	// One unreadable entry does not stop the rest: this network's own grant is still removed, and the failure said after.
	const unlinked = [];
	const mixed = { readdirSync: () => ["stray", "10.2.0.2"], readFileSync: (p) => { if (p.endsWith("stray")) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" }); return grantText("pi-job-b-net", ["x"]); }, unlinkSync: (p) => unlinked.push(p) };
	assert.throws(() => removeGrantsOf({ dir, network: "pi-job-b-net", fs: mixed }), /EISDIR/);
	assert.deepEqual(unlinked, [join(dir, "10.2.0.2")]);
	assert.equal(removeGrantsOf({ dir, network: "pi-job-b-net", fs: { readdirSync: () => ["10.2.0.2"], readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } } }), 0, "gone since the listing");
});

test("the read back asks the helper, as squid's own user, one line per address and id, and passes only on OK for every one", () => {
	assert.deepEqual(readBackArgs("pi-dispatch-egress-proxy"), ["exec", "-i", "--user", "proxy", "pi-dispatch-egress-proxy", "/etc/pi-dispatch/private/endpoint-grant"]);
	assert.equal(readBackInput([{ address: "10.0.0.2" }, { address: "fd00::2" }], ["a", "b"]), "10.0.0.2 a\n10.0.0.2 b\nfd00::2 a\nfd00::2 b\n");
	assert.equal(readBackPassed("OK\nOK\n", 2), true);
	assert.equal(readBackPassed("OK\nERR\n", 2), false);
	assert.equal(readBackPassed("OK\n", 2), false);
	assert.equal(readBackPassed("", 0), true);
});

test("grantOnAttach: clears this subnet's stale grants, writes the job's, reads it back; asks the runtime nothing when there is nothing to do", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "192.168.148.2"), grantText("pi-job-gone-net", ["bench-device"]));
	const calls = [];
	const run = async (_spawn, bin, args, input) => {
		calls.push([bin, ...args, input]);
		if (args[0] === "inspect") return { code: 0, stdout: NETWORKS };
		return { code: 0, stdout: input.split("\n").filter(Boolean).map(() => "OK").join("\n") + "\n" };
	};
	const ok = await grantOnAttach({ bin: "docker", proxy: "pi-dispatch-egress-proxy", network: "pi-job-a-net", dir, ids: ["bench-device"], run });
	assert.deepEqual(ok, { ok: true, addresses: [{ address: "192.168.148.2", prefix: 24 }] });
	assert.equal(readFileSync(join(dir, "192.168.148.2"), "utf8"), grantText("pi-job-a-net", ["bench-device"]), "the gone network's grant replaced by this job's");
	assert.deepEqual(calls.map((c) => c[1]), ["inspect", "exec"]);
	assert.equal(calls[1].at(-1), "192.168.148.2 bench-device\n");
	// A job with no grant and an empty folder: no question at all.
	const empty = tmp();
	calls.length = 0;
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir: empty, ids: [], run }), { ok: true, addresses: [] });
	assert.deepEqual(calls, []);
	// A job with no grant on a folder that holds one: the subnet is still cleared, and nothing is written.
	writeFileSync(join(empty, "192.168.148.5"), grantText("pi-job-gone-net", ["lab"]));
	assert.equal((await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir: empty, ids: [], run })).ok, true);
	assert.deepEqual(readdirSync(empty), []);
	// No folder at all: a deployment from before #918.
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "n", dir: join(empty, "absent"), ids: [], run }), { ok: true, addresses: [] });
});

test("grantOnAttach fails closed, naming why without a path or an id: no address, a read back that is not OK, a write that fails", async () => {
	const dir = tmp();
	const answer = (inspect, exec) => async (_s, _b, args) => (args[0] === "inspect" ? inspect : exec);
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir, ids: ["x"], run: answer({ code: 1, stdout: "" }) }), { ok: false, why: "proxy-address-unread" });
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir, ids: ["x"], run: answer({ code: 0, stdout: NETWORKS }, { code: 0, stdout: "ERR\n" }) }), { ok: false, why: "grant-unreadable" });
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir, ids: ["x"], run: answer({ code: 0, stdout: NETWORKS }, { code: 126, stdout: "" }) }), { ok: false, why: "grant-unreadable" });
	const noWrite = { readdirSync: () => [], unlinkSync: () => {}, writeFileSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }, rmSync: () => {} };
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "pi-job-a-net", dir, ids: ["x"], fs: noWrite, run: answer({ code: 0, stdout: NETWORKS }) }), { ok: false, why: "grant-unwritable" });
	mkdirSync(join(dir, "sub"));
	assert.deepEqual(await grantOnAttach({ bin: "docker", proxy: "p", network: "n", dir, ids: [], fs: { readdirSync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } }, run: answer() }), { ok: false, why: "grant-folder-unreadable" });
});
