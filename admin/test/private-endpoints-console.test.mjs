import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTriggerForDisplay, PRIVATE_ENDPOINT_BASIS_TEXT, privateEndpointsText, recordPrivateEndpoints } from "../src/read-model.mjs";
import { triggerListOf } from "../src/trigger-list.mjs";
import { runFieldsLines } from "../src/console/actions.mjs";

// Issue #918, part 4: what the console shows of private endpoints. Ids only, never a host or a port.

const NOW = Date.parse("2026-11-16T12:00:00Z");

test("normalizeTriggerForDisplay carries run.privateEndpoints by id on every kind but a watch rule, and no key when none is named", () => {
	for (const entry of [
		{ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "f" } },
		{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "f", task: "t" } },
	]) {
		assert.deepEqual(normalizeTriggerForDisplay({ ...entry, run: { ...entry.run, privateEndpoints: ["bench-device", "lab"] } }).privateEndpoints, ["bench-device", "lab"], entry.on.type);
		assert.equal("privateEndpoints" in normalizeTriggerForDisplay(entry), false, entry.on.type);
		for (const bad of [[], "bench-device", [1], null]) assert.equal("privateEndpoints" in normalizeTriggerForDisplay({ ...entry, run: { ...entry.run, privateEndpoints: bad } }), false, JSON.stringify(bad));
	}
});

test("the trigger list carries the ids and shows a reaches chip, after MCP's", () => {
	const rule = { index: 0, type: "label", forge: "github", flow: "fix", any: ["pi"], mcp: ["docs"], privateEndpoints: ["bench-device"] };
	const got = triggerListOf({ snapshot: { triggers: { triggers: [rule], count: 1 }, schedulers: [], pauseWindows: { windows: [] } }, records: [], coverage: { complete: true }, now: NOW });
	const chips = got.rows[0].chips.filter((c) => c.kind === "reaches").map((c) => c.text);
	assert.ok(chips.includes("private: bench-device"), JSON.stringify(chips));
	assert.ok(chips.indexOf("MCP: docs") < chips.indexOf("private: bench-device"));
	const none = triggerListOf({ snapshot: { triggers: { triggers: [{ ...rule, privateEndpoints: undefined }], count: 1 }, schedulers: [], pauseWindows: { windows: [] } }, records: [], coverage: { complete: true }, now: NOW });
	assert.equal(none.rows[0].chips.some((c) => /^private:/.test(c.text)), false);
});

test("a run preview names the devices its job may reach, and says nothing when there are none", () => {
	assert.match(runFieldsLines({ flow: "fix", privateEndpoints: ["bench-device", "lab"] }, "It runs")[0], /; private endpoints bench-device, lab/);
	for (const privateEndpoints of [undefined, [], null]) assert.doesNotMatch(runFieldsLines({ flow: "fix", privateEndpoints }, "It runs")[0], /private endpoints/);
});

test("a run record's grant is rebuilt before a page shows it, and says what enforced it", async () => {
	assert.deepEqual(recordPrivateEndpoints({ privateEndpoints: { ids: ["lab", "bench-device"], basis: "proxy" } }), { ids: ["bench-device", "lab"], basis: "proxy" });
	for (const bad of [{}, { privateEndpoints: null }, { privateEndpoints: { ids: ["<b>x</b>"], basis: "proxy" } }, { privateEndpoints: { ids: ["a"], basis: "firewall" } }]) assert.equal(recordPrivateEndpoints(bad), null, JSON.stringify(bad));
	assert.equal(privateEndpointsText({ ids: ["bench-device"], basis: "proxy" }), "bench-device: the egress proxy held the grant for this run's network");
	assert.match(privateEndpointsText({ ids: ["bench-device"], basis: "unenforced" }), /nothing enforced it: the egress policy was off \(PI_EGRESS=0\)/);
	const { PRIVATE_ENDPOINT_BASES } = await import("@edgehero/pi-dispatch/run-history");
	assert.deepEqual(Object.keys(PRIVATE_ENDPOINT_BASIS_TEXT).sort(), [...PRIVATE_ENDPOINT_BASES].sort(), "one sentence per basis the worker records, held to the worker's own list");
});

test("Connections lists this folder's devices with the triggers granted each, an id it lacks as not declared here, and unread as unread", async () => {
	const { privateEndpointsView, connectionsProblems } = await import("../src/connections-view.mjs");
	const triggers = [{ index: 2, privateEndpoints: ["bench-device"] }, { index: 3, privateEndpoints: ["lab-ssh", "bench-device"] }, { index: 4 }];
	const view = privateEndpointsView([{ id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 }, { id: "nas", host: "nas.lan", port: 8022, slots: null }], triggers);
	assert.deepEqual(view, { unread: false, more: 0, rows: [
		{ id: "bench-device", host: "10.0.5.20", port: 22, slots: 1, triggers: [2, 3] },
		{ id: "nas", host: "nas.lan", port: 8022, slots: null, triggers: [] },
		{ id: "lab-ssh", host: null, port: null, slots: null, triggers: [3] },
	] });
	assert.deepEqual(privateEndpointsView(null, triggers).unread, true, "a file that does not load is unknown, never none");
	assert.deepEqual(privateEndpointsView([], []), { unread: false, more: 0, rows: [] });
	// A host whose own copy does not load is a problem, from its doctor, beside the model endpoints' one.
	const problems = connectionsProblems([{ name: "mini2", proxy: null, forge: [], endpoints: null, privateFile: { label: "endpoint 1: port 443 is refused", fix: "Use another port." } }]);
	assert.deepEqual(problems.map((p) => [p.kind, p.title]), [["endpoints", "mini2 reads its own private-endpoints file, and it does not load"]]);
});

test("Connections reads the file the worker reads: the named one, relative to the deployment, an empty setting as unavailable, and unknown metadata as unavailable (#918)", async () => {
	const { readConnections } = await import("../src/connections-view.mjs");
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	const dir = tempDir("pd-918-conn-");
	mkdirSync(join(dir, "conf"));
	writeFileSync(join(dir, "private-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "default-one", host: "10.0.0.9", port: 22 }] }));
	writeFileSync(join(dir, "conf", "devices.json"), JSON.stringify({ version: 1, endpoints: [{ id: "named-one", host: "10.0.0.8", port: 22, slots: 2 }] }));
	const at = async (environment) => (await readConnections({ deploymentDir: dir, snapshot: null, publications: false, reads: { environment } })).privateEndpoints;
	assert.deepEqual((await at(() => ({ env: {} }))).rows.map((r) => r.id), ["default-one"], "unset: the default file");
	assert.deepEqual((await at(() => ({ env: { PI_PRIVATE_ENDPOINTS_FILE: "conf/devices.json" } }))).rows.map((r) => r.id), ["named-one"], "named, relative to the deployment folder");
	assert.equal((await at(() => ({ env: { PI_PRIVATE_ENDPOINTS_FILE: "" } }))).unread, true, "empty: the worker refuses to start, so never the default file");
	assert.equal((await at(() => ({ env: { PI_PRIVATE_ENDPOINTS_FILE: "missing.json" } }))).unread, true, "a named file that is not there");
	for (const meta of [{ unreadable: true }, { untrusted: true }, { env: {}, unread: [{ key: "PI_PRIVATE_ENDPOINTS_FILE" }] }]) assert.equal((await at(() => meta)).unread, true, JSON.stringify(meta));
	// The queue's port is refused as the worker refuses it, from the deployment's VALKEY_URL.
	writeFileSync(join(dir, "private-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "on-queue", host: "10.0.0.9", port: 6380 }] }));
	assert.equal((await at(() => ({ env: { VALKEY_URL: "redis://127.0.0.1:6380" } }))).unread, true);
});
