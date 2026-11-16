import assert from "node:assert/strict";
import { test } from "node:test";
import { privateEndpointChecks, privateRunsOf, sharedServerChecks } from "../src/private-endpoints-doctor.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

// Issue #918, part 3: doctor's private endpoint lines, from plain facts.

const BENCH = { id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 };
const LAB = { id: "lab", host: "lab.internal", port: 8022, slots: null };
const triggers = (entries) => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: entries }), "/triggers.json");
const LABEL = { on: { type: "label", any: ["hil"] }, run: { kind: "github", flow: "test-on-device", privateEndpoints: ["bench-device"] } };
const CRON = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/app", flow: "f", task: "t", privateEndpoints: ["lab"] } };
const lines = (checks) => checks.map((c) => `${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}`);

test("privateRunsOf names each trigger that grants one, by doctor's label, and whether an event starts its jobs", () => {
	const runs = privateRunsOf(triggers([{ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "x" } }, LABEL, CRON]));
	assert.deepEqual(runs, [
		{ index: 1, label: "label trigger #1", ids: ["bench-device"], kind: "github", forge: "github", onType: "label", backend: null, eventDriven: true, ownQueue: false, served: true },
		{ index: 2, label: 'cron "nightly"', ids: ["lab"], kind: "local", forge: null, onType: "cron", backend: null, eventDriven: false, ownQueue: true, served: true },
	]);
	assert.deepEqual(privateRunsOf(null), []);
});

test("each endpoint names the triggers granted it, or warns that none does; a forge trigger's grant is said with its blast radius", () => {
	const runs = privateRunsOf(triggers([LABEL]));
	assert.deepEqual(lines(privateEndpointChecks({ endpoints: [LAB, BENCH], runs })), [
		"✓ Private endpoint bench-device (10.0.5.20:22, 1 job at a time) is granted to label trigger #0",
		"⚠ Private endpoint lab (lab.internal:8022) is declared, but no trigger names it, so no job reaches it",
		"⚠ label trigger #0 grants bench-device to jobs an event on github starts: their agent reads text anyone who can post there wrote, and can do on the device whatever its account there allows",
	]);
	// A cron trigger is the operator's own: no blast-radius line.
	assert.deepEqual(lines(privateEndpointChecks({ endpoints: [LAB], runs: privateRunsOf(triggers([CRON])) })), ["✓ Private endpoint lab (lab.internal:8022, no bound on jobs at a time) is granted to cron \"nightly\""]);
});

test("an id this host does not declare fails on a single host and warns on a fleet, as the processor refuses or hands on", () => {
	const runs = privateRunsOf(triggers([LABEL]));
	const single = privateEndpointChecks({ endpoints: [], runs }).find((c) => /does not declare/.test(c.label));
	assert.equal(single.ok, false);
	assert.ok(!single.warn);
	assert.match(single.label, /^label trigger #0 names private endpoint bench-device, which this host does not declare: its jobs are refused before they spend \(private-endpoint-unknown\)$/);
	const fleet = privateEndpointChecks({ endpoints: [], runs, fleet: true }).find((c) => /does not declare/.test(c.label));
	assert.equal(fleet.warn, true);
	assert.match(fleet.label, /its jobs on the shared queue wait for a host that declares it, and one routed to this host is refused/);
	assert.equal(privateEndpointChecks({ endpoints: [], runs }).some((c) => /grants/.test(c.label)), false, "no blast radius for an id this host cannot grant");
	// A cron job is queued on its own host's queue on a fleet too, and refused there: a failure, never "waits".
	const cron = privateEndpointChecks({ endpoints: [], runs: privateRunsOf(triggers([CRON])), fleet: true }).find((c) => /does not declare/.test(c.label));
	assert.deepEqual([cron.ok, cron.warn === true], [false, false]);
	assert.match(cron.label, /its jobs are refused before they spend/);
	// A trigger this host does not serve (a cron placed on another machine, a run.worker naming another host) is not judged here.
	const elsewhere = privateRunsOf(triggers([CRON]), { servedHere: () => false });
	assert.deepEqual(privateEndpointChecks({ endpoints: [], runs: elsewhere }).filter((c) => /does not declare|venue|grants/.test(c.label)), []);
});

test("a venue that cannot carry a grant fails the trigger that sends granted jobs there, by its own run.backend or the default", () => {
	const onShell = privateRunsOf(triggers([{ ...LABEL, run: { ...LABEL.run, backend: "openshell" } }]));
	assert.match(privateEndpointChecks({ endpoints: [BENCH], runs: onShell }).find((c) => /venue/.test(c.label)).label, /^label trigger #0 names private endpoints, but its jobs run on the openshell venue, which cannot carry a grant yet: they are refused before they spend \(private-endpoint-venue-unsupported\)$/);
	assert.ok(privateEndpointChecks({ endpoints: [BENCH], runs: privateRunsOf(triggers([LABEL])), defaultBackend: "openshell-bind" }).some((c) => /openshell-bind venue/.test(c.label)));
	assert.equal(privateEndpointChecks({ endpoints: [BENCH], runs: privateRunsOf(triggers([LABEL])), defaultBackend: "podman" }).some((c) => /venue/.test(c.label)), false);
});

test("the egress policy off is said: no proxy enforces a grant, so every job reaches every declared device", () => {
	const off = privateEndpointChecks({ endpoints: [BENCH, LAB], runs: [], egressArmed: false }).at(-1);
	assert.deepEqual([off.ok, off.warn], [false, true]);
	assert.equal(off.label, "The egress policy is off (PI_EGRESS=0), so no proxy enforces private endpoints: every job can reach bench-device, lab");
	assert.deepEqual(privateEndpointChecks({ endpoints: [], runs: [], egressArmed: false }), [], "nothing declared, nothing to say");
});

test("a model endpoint that resolves to a private endpoint's address on its port is one server, and is said", async () => {
	const lookup = async (host) => ({ "nas.lan": ["10.0.5.20"], "lab.internal": ["10.9.9.9"], "far.lan": ["10.0.5.21"] })[host] ?? [];
	const model = (id, host, port) => ({ id, host, port, slots: 1, keyless: false });
	const found = await sharedServerChecks({ endpoints: [BENCH, LAB], modelEndpoints: [model("nas", "nas.lan", 22), model("other", "nas.lan", 11434), model("far", "far.lan", 22)], lookup });
	assert.deepEqual(lines(found), ["⚠ Model endpoint nas (nas.lan:22) and private endpoint bench-device (10.0.5.20:22) are one server (10.0.5.20:22): every job reaches the device through the model endpoint's rule"]);
	// IPv6 literals on both sides, bracketed as declared.
	const v6 = await sharedServerChecks({ endpoints: [{ id: "v6", host: "[fd00::5]", port: 22 }], modelEndpoints: [model("m6", "[fd00::5]", 22)], lookup });
	assert.match(v6[0].label, /are one server \(\[fd00::5\]:22\)/);
	// A name that does not resolve is not judged, and a lookup that throws is none.
	assert.deepEqual(await sharedServerChecks({ endpoints: [LAB], modelEndpoints: [model("x", "unknown.lan", 8022)], lookup: async () => { throw new Error("ENOTFOUND"); } }), []);
	assert.deepEqual(await sharedServerChecks({ endpoints: [], modelEndpoints: [model("x", "a", 1)], lookup }), []);
});

test("the canary grants itself every declared private endpoint, probes each four ways, and removes the grant before its network (#918)", async () => {
	const { runEgressCanary, egressConnectScript, PRIVATE_PROBE_SLUGS } = await import("../src/doctor.mjs");
	const steps = [];
	const run = async (args) => (steps.push(args.join(" ")), { code: 0, stdout: "", stderr: "" });
	// The canary's own three read as a healthy policy; each private probe answers from `answers`.
	const canaryAnswer = { provider: { code: 0, output: "reached 401\n" }, unlisted: { code: 3, output: "blocked 403\n" }, plain: { code: 3, output: "blocked 403\n" } };
	const run918 = async (answers = {}, { attach = { ok: true, addresses: [] } } = {}) => {
		const probes = [];
		const grants = { attached: [], removed: [], attach: async (a) => (grants.attached.push(a), attach), remove: (r) => (grants.removed.push({ ...r, at: steps.length }), 1) };
		const probeRun = async (args) => {
			const name = args[args.indexOf("--name") + 1];
			probes.push({ name, script: args.at(-1) });
			const slug = PRIVATE_PROBE_SLUGS.find((s) => name.includes(`-${s}-`));
			if (slug) return answers[slug] ?? { ptunnel: { code: 0, output: "tunnel 200\n" }, pnext: { code: 3, output: "tunnel 403\n" }, pplain: { code: 3, output: "blocked 403 ERR_ACCESS_DENIED\n" }, prevoked: { code: 3, output: "tunnel 403\n" } }[slug];
			return Object.entries(canaryAnswer).find(([k]) => name.includes(`-${k}-`))?.[1] ?? { code: 0, output: "reached 401\n" };
		};
		const result = await runEgressCanary({ run, probeRun, proxy: "pi-dispatch-egress-proxy", image: "pi-job:x", pid: 7, gate: async () => null, privateEndpoints: [BENCH], grants });
		return { result, probes, grants, text: result.checks.map((c) => `${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}`).join("\n") };
	};
	const fine = await run918();
	assert.deepEqual(fine.grants.attached, [{ network: "pi-dispatch-egress-doctor-7", ids: ["bench-device"] }], "the canary's own network, every declared id");
	assert.match(fine.text, /✓ Private endpoint bench-device \(10\.0\.5\.20:22\): a job granted it reaches it through the proxy \(CONNECT: 200\)/);
	assert.match(fine.text, /✓ Private endpoint bench-device \(10\.0\.5\.20:22\): its rule is port-exact \(a granted CONNECT to 10\.0\.5\.20:23, a port nobody declared, got the proxy's 403\)/);
	assert.match(fine.text, /✓ Private endpoint bench-device \(10\.0\.5\.20:22\): admits no plain forward request/);
	assert.match(fine.text, /✓ Private endpoint bench-device \(10\.0\.5\.20:22\): with the grant removed the same CONNECT gets the proxy's 403, so only a job granted it reaches it/);
	const priv = fine.probes.filter((p) => PRIVATE_PROBE_SLUGS.some((s) => p.name.includes(`-${s}-`)));
	assert.deepEqual(priv.map((p) => p.name), ["ptunnel", "pnext", "pplain", "prevoked"].map((s) => `pi-dispatch-egress-probe-endpoint-${s}-bench-device-7`));
	assert.equal(priv[0].script, egressConnectScript("10.0.5.20", 22, { proxyUrl: "http://pi-dispatch-egress-proxy:3128" }));
	assert.equal(priv[1].script, egressConnectScript("10.0.5.20", 23, { proxyUrl: "http://pi-dispatch-egress-proxy:3128" }));
	// Revoked between the third and the fourth probe, and removed again before the network goes.
	assert.equal(fine.grants.removed.length, 2);
	const rmAt = steps.findIndex((s) => s.startsWith("network rm") || s.startsWith("network disconnect"));
	assert.ok(fine.grants.removed.at(-1).at <= rmAt, "the grant goes before the network");

	// The findings: refused with the grant, reached on the next port, a plain request through, reached without the grant.
	const bad = await run918({ ptunnel: { code: 3, output: "tunnel 403\n" }, pnext: { code: 3, output: "tunnel 503\n" }, pplain: { code: 0, output: "reached 200\n" }, prevoked: { code: 0, output: "tunnel 200\n" } });
	assert.match(bad.text, /✗ Private endpoint bench-device \(10\.0\.5\.20:22\): the proxy refused a granted CONNECT \(403\)/);
	assert.match(bad.text, /✗ Private endpoint bench-device \(10\.0\.5\.20:22\): its rule is NOT port-exact/);
	assert.match(bad.text, /✗ Private endpoint bench-device \(10\.0\.5\.20:22\): admits a plain forward request/);
	assert.match(bad.text, /✗ Private endpoint bench-device \(10\.0\.5\.20:22\): is reached WITHOUT a grant/);
	// Nothing listening: the grant holds, the device does not answer.
	assert.match((await run918({ ptunnel: { code: 3, output: "tunnel 503\n" } })).text, /⚠ Private endpoint bench-device \(10\.0\.5\.20:22\): the proxy let the granted CONNECT through, but nothing answered there \(503\)/);
	// A grant that does not read back: nothing private is probed, and that is said.
	const unread = await run918({}, { attach: { ok: false, why: "grant-unreadable" } });
	assert.match(unread.text, /⚠ Private endpoints: the canary network's grant could not be written and read back \(grant-unreadable\), so no private endpoint was probed/);
	assert.equal(unread.probes.some((p) => /-p(tunnel|next|plain|revoked)-/.test(p.name)), false);
	// The write before that failed read back may have landed: removed before the network all the same (#918 review).
	assert.equal(unread.grants.removed.length, 1);
});

test("the CONNECT script reads the proxy's status line: 200 exits 0, a refusal 3, a closed socket 5, sending the declared target", async () => {
	const { egressConnectScript } = await import("../src/doctor.mjs");
	const { createServer } = await import("node:net");
	const { spawn } = await import("node:child_process");
	for (const [status, exit] of [["200 Connection established", 0], ["403 Forbidden", 3], ["503 Service Unavailable", 3], [null, 5]]) {
		const seen = [];
		const server = createServer((socket) => {
			socket.once("data", (d) => {
				seen.push(String(d));
				if (status === null) socket.end();
				else socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		// Asynchronously, so this process's fake proxy can answer while the script waits on it.
		const child = await new Promise((resolve) => {
			const c = spawn(process.execPath, ["-e", egressConnectScript("[fd00::5]", 22, { proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 })]);
			let stdout = "";
			c.stdout.on("data", (d) => (stdout += d));
			c.on("close", (status) => resolve({ status, stdout }));
		});
		server.close();
		assert.equal(child.status, exit, `${status}: ${child.stdout}`);
		assert.match(child.stdout, status === null ? /^error closed/ : new RegExp(`^tunnel ${status.slice(0, 3)}$`, "m"));
		assert.equal(seen[0], "CONNECT [fd00::5]:22 HTTP/1.1\r\nHost: [fd00::5]:22\r\n\r\n");
	}
});
