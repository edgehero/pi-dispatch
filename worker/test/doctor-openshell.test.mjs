import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_FLOORS, openshellChecks } from "../src/doctor-openshell.mjs";
import { OPENSHELL_TESTED_VERSION } from "../src/openshell-cli.mjs";

/**
 * Issue #683: `pi-dispatch doctor --openshell`, driven against a fake CLI. Every answer is the shape the issue #683 lab
 * measured on OpenShell 0.1.4 (the wrapped "no global policy" sentence included).
 */

const NO_GLOBAL = "Error:   × code: 'Some requested entity was not found', message: \"no global policy\n  │ revision found\"\n";

function fake(over = {}) {
	const calls = [];
	const answers = {
		"openshell --version": { code: 0, stdout: `openshell ${OPENSHELL_TESTED_VERSION}\n` },
		"openshell status": { code: 0, stdout: JSON.stringify({ status: "connected", server: "https://127.0.0.1:17670", version: OPENSHELL_TESTED_VERSION }) },
		"openshell gateway": { code: 0, stdout: JSON.stringify({ compute_drivers: [{ name: "docker" }] }) },
		"openshell policy": { code: 1, stdout: "", stderr: NO_GLOBAL },
		"docker version": { code: 0, stdout: "28.0.4\n" },
		"podman version": { code: 0, stdout: "5.4.0\n" },
		"docker image": { code: 0, stdout: "replicas,exitAuth,sandboxLayout\n" },
		"podman image": { code: 0, stdout: "replicas,exitAuth,sandboxLayout\n" },
		...over,
	};
	const run = async (bin, args) => {
		calls.push([bin, ...args]);
		const rest = args[0] === "--gateway" ? args.slice(2) : args;
		const a = answers[`${bin} ${rest[0]}`];
		return { stderr: "", ...(a ?? { code: 127, stdout: "" }) };
	};
	return { run, calls };
}

const lines = (checks) => checks.map((c) => `${c.ok ? (c.warn ? "warn" : "ok") : "FAIL"} ${c.label}`);

test("a ready host: every line passes (blessable since #684, so no note says otherwise)", async () => {
	const { run } = fake();
	const checks = await openshellChecks({}, { run, platform: "linux", readLsm: () => "lockdown,capability,landlock,yama" });
	assert.deepEqual(lines(checks).filter((l) => !l.startsWith("ok")), []);
	assert.equal(checks.length, 8, "the CLI, the locality, the gateway version, the driver, the global policy, the engine, Landlock, the image");
});

test("each fault is its own failing line with a fix", async () => {
	const cases = [
		[{ "openshell --version": { code: 0, stdout: "openshell 0.1.5\n" } }, /CLI 0\.1\.5 is the tested release/],
		[{ "openshell status": { code: 0, stdout: JSON.stringify({ status: "connected", server: "https://10.0.0.5:17670", version: OPENSHELL_TESTED_VERSION }) } }, /the gateway is on this host$/],
		[{ "openshell gateway": { code: 0, stdout: JSON.stringify({ compute_drivers: [{ name: "kubernetes" }] }) } }, /compute driver is docker/],
		[{ "openshell policy": { code: 0, stdout: "{}" } }, /no gateway-wide policy is in force/],
		[{ "openshell policy": { code: 1, stdout: "", stderr: "connection refused" } }, /could be read/],
		[{ "docker version": { code: 0, stdout: "27.4.0\n" } }, /docker is 28 or later/],
		[{ "docker image": { code: 0, stdout: "replicas,exitAuth\n" } }, /declares sandboxLayout/],
		[{ "docker image": { code: 1, stdout: "" } }, /is in docker's store/],
	];
	for (const [over, label] of cases) {
		const checks = await openshellChecks({}, { run: fake(over).run, platform: "linux", readLsm: () => "landlock" });
		const failed = checks.filter((c) => !c.ok);
		assert.equal(failed.length, 1, `${label}: ${JSON.stringify(lines(checks))}`);
		assert.match(failed[0].label, label);
		assert.ok(typeof failed[0].fix === "string" && failed[0].fix.length > 0, "names the fix");
	}
	const noLandlock = await openshellChecks({}, { run: fake().run, platform: "linux", readLsm: () => "lockdown,yama" });
	assert.deepEqual(noLandlock.filter((c) => !c.ok).map((c) => c.label), ["openshell: this kernel offers Landlock"]);
});

test("a missing CLI or a gateway that does not answer stops the section there, with the fix", async () => {
	const missing = await openshellChecks({}, { run: fake({ "openshell --version": { code: null, stdout: "" } }).run });
	assert.deepEqual(lines(missing), ["FAIL openshell: the CLI is installed"]);
	// `status` exits 0 even when the gateway is down (measured): its own field decides.
	const down = await openshellChecks({}, { run: fake({ "openshell status": { code: 0, stdout: JSON.stringify({ status: "error" }) } }).run });
	assert.equal(lines(down).at(-1), "FAIL openshell: the gateway answers");
});

test("off Linux the Landlock line is said, never passed; an unreadable driver list is a warning; Podman has its own floor", async () => {
	const mac = await openshellChecks({}, { run: fake().run, platform: "darwin" });
	assert.ok(mac.some((c) => c.warn && /Landlock cannot be read/.test(c.label) && /LinuxKit/.test(c.fix)));
	const noAdmin = await openshellChecks({}, { run: fake({ "openshell gateway": { code: 1, stdout: "" } }).run, platform: "linux", readLsm: () => "landlock" });
	assert.ok(noAdmin.some((c) => c.ok && c.warn && /compute driver could not be read/.test(c.label)));
	assert.deepEqual(ENGINE_FLOORS, { docker: [28, 0], podman: [5, 0] });
	const { run, calls } = fake({ "openshell gateway": { code: 0, stdout: JSON.stringify({ compute_drivers: [{ name: "podman" }] }) }, "podman version": { code: 0, stdout: "4.9.3\n" } });
	const podman = await openshellChecks({ PI_OPENSHELL_ENGINE: "podman", PI_OPENSHELL_GATEWAY: "lab" }, { run, platform: "linux", readLsm: () => "landlock" });
	assert.deepEqual(podman.filter((c) => !c.ok).map((c) => c.label), ["openshell: podman is 5 or later"]);
	assert.ok(calls.filter((c) => c[0] === "openshell").every((c) => c[1] === "--gateway" && c[2] === "lab"), "every CLI call names the gateway");
	assert.ok(calls.some((c) => c[0] === "podman" && c[1] === "image"), "the image is read on the gateway's engine");
});

test("a setting the venue cannot use is refused by name before anything is asked", async () => {
	const { run, calls } = fake();
	assert.match((await openshellChecks({ PI_OPENSHELL_ENGINE: "vm" }, { run })).at(-1).fix, /docker or podman/);
	assert.match((await openshellChecks({ PI_OPENSHELL_GATEWAY: "--evil" }, { run })).at(-1).label, /registered gateway/);
	assert.equal(calls.length, 0);
});

test("the OpenShell pin is one exact release, the one the worker was measured on, and the CI lane installs it by checksum", async () => {
	const { readFileSync } = await import("node:fs");
	const pin = JSON.parse(readFileSync(new URL("../../.github/openshell.json", import.meta.url), "utf8"));
	assert.match(pin.version, /^\d+\.\d+\.\d+$/, "exact, never a range or latest (CONST-PI-VERSION-PINNED's reason)");
	assert.equal(pin.version, OPENSHELL_TESTED_VERSION);
	assert.equal(pin.deb.amd64.file, `openshell_${pin.version}-1_amd64.deb`);
	assert.match(pin.deb.amd64.sha256, /^[0-9a-f]{64}$/);
	const workflow = readFileSync(new URL("../../.github/workflows/openshell-conformance.yml", import.meta.url), "utf8");
	assert.match(workflow, /sha256sum -c/);
	assert.match(workflow, /jq -r \.version \.github\/openshell\.json/);
	assert.match(workflow, /name: the openshell venue holds its declarations/);
	assert.match(workflow, /^  pull_request:$/m, "unfiltered, as the required lanes' are");
});
