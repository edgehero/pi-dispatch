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

// Issue #686 part 3: bind mode's lines, run where `openshell-bind` is blessed.
const ID = `sha256:${"c".repeat(64)}`;
const DOCKER_INFO = (options = []) => ({ code: 0, stdout: `${JSON.stringify({ ServerVersion: "28.0.4", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin", ...options] })}\n` });
function bindFake({ info = DOCKER_INFO(), probe = { code: 1, stderr: "Error: sandbox entered error phase while provisioning: ContainerCreateFailed: mount target '/sandbox' is reserved for the OpenShell workspace" }, id = { code: 0, stdout: `${ID}\n` }, over = {} } = {}) {
	const base = fake(over);
	const calls = [];
	const run = async (bin, args) => {
		calls.push([bin, ...args]);
		const rest = args[0] === "--gateway" ? args.slice(2) : args;
		if (rest.includes("{{.Id}}")) return { stderr: "", ...id };
		if (bin === "docker" && rest[0] === "info") return { stderr: "", ...info };
		if (bin === "openshell" && rest[0] === "sandbox" && rest[1] === "create") return { stdout: "", stderr: "", ...probe };
		if (bin === "openshell" && rest[0] === "sandbox" && rest[1] === "delete") return { code: 0, stdout: "", stderr: "" };
		return base.run(bin, args);
	};
	return { run, calls };
}
const bindOpts = (run, extra = {}) => ({ run, platform: "linux", readLsm: () => "landlock", modes: { copy: false, bind: true }, ids: { euid: 1001, egid: 1001 }, mkdtemp: () => "/tmp/probe-src", rmdir: () => {}, ...extra });

test("bind mode on a ready gateway: the settings line passes, upstream's warning is quoted, and sandboxLayout is not asked (#686 part 3)", async () => {
	const { run, calls } = bindFake();
	const checks = await openshellChecks({}, bindOpts(run));
	assert.ok(lines(checks).includes("ok openshell-bind: the gateway admits bind mounts (allow_driver_config, enable_bind_mounts, resource admission off)"));
	const warning = checks.find((c) => c.label.startsWith("openshell-bind: upstream warns"));
	assert.equal(warning.label, 'openshell-bind: upstream warns: "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy."');
	assert.equal(warning.warn, true);
	assert.match(warning.fix, /read-only binds/);
	assert.ok(!lines(checks).some((l) => /sandboxLayout/.test(l)), "bind mode reads the mounts layout");
	assert.ok(lines(checks).includes("ok openshell: the job image (pi-job:latest) is in docker's store"));
	assert.ok(lines(checks).includes("ok openshell-bind: jobs run as the image's own user (uid 1001)"));
	const probe = calls.find((c) => c[1] === "sandbox" && c[2] === "create");
	assert.equal(probe[probe.indexOf("--from") + 1], ID, "by image ID, never a name the gateway would pull");
	assert.equal(JSON.parse(probe[probe.indexOf("--driver-config-json") + 1]).docker.mounts[0].source, "/tmp/probe-src");
	// Measured: the admitting answer leaves the probe's sandbox in phase Error, so doctor deletes it by its name.
	const name = probe[probe.indexOf("--name") + 1];
	assert.ok(calls.some((c) => c[1] === "sandbox" && c[2] === "delete" && c[3] === name), "the probe's sandbox is deleted");
	assert.deepEqual(lines(checks).filter((l) => l.startsWith("FAIL")), []);
});

test("bind mode on a default gateway: one failing line naming the setting, with the gateway.toml in its fix (#686 part 3)", async () => {
	for (const [stderr, setting] of [
		["Error:   × caller driver config is disabled; a gateway administrator must enable\n  │ allow_driver_config", "allow_driver_config"],
		["Error: docker bind mounts require enable_bind_mounts = true in [openshell.drivers.docker]", "enable_bind_mounts"],
		["Error: host bind or image mount cannot be attached while resource admission is enabled: no trusted label resolver", "resource_admission"],
	]) {
		const checks = await openshellChecks({}, bindOpts(bindFake({ probe: { code: 1, stderr } }).run));
		const failed = checks.filter((c) => !c.ok);
		assert.equal(failed.length, 1, setting);
		assert.equal(failed[0].label, "openshell-bind: the gateway admits bind mounts");
		assert.match(failed[0].fix, new RegExp(`\\(${setting}\\)`));
		assert.ok(failed[0].fix.includes("[openshell]\nversion = 2\n\n[openshell.drivers.docker]\nallow_driver_config = true\nenable_bind_mounts = true\n\n[openshell.drivers.docker.resource_admission]\nenabled = false"), "the TOML to write");
		assert.match(failed[0].fix, /gateway\.toml/);
	}
	// A probe the gateway made after all is deleted, and admits.
	const made = bindFake({ probe: { code: 0, stdout: "{}" } });
	const checks = await openshellChecks({}, bindOpts(made.run));
	assert.ok(lines(checks).some((l) => l.startsWith("ok openshell-bind: the gateway admits")));
	assert.ok(made.calls.some((c) => c[1] === "sandbox" && c[2] === "delete" && /^pi-job-s[0-9a-f]{11}$/.test(c[3])));
	// Words nobody measured, or no image to probe with: a warning, never a pass.
	for (const opts of [{ probe: { code: 1, stderr: "Error: boom" } }, { id: { code: 1, stdout: "" } }]) {
		const c = await openshellChecks({}, bindOpts(bindFake(opts).run));
		assert.ok(c.some((x) => x.warn && /could not be (read|asked)/.test(x.label)), JSON.stringify(opts));
	}
	// The Podman driver: refused for bind mode, said with its fix.
	const podman = await openshellChecks({ PI_OPENSHELL_ENGINE: "podman" }, bindOpts(bindFake({ over: { "openshell gateway": { code: 0, stdout: JSON.stringify({ compute_drivers: [{ name: "podman" }] }) } } }).run));
	assert.ok(podman.some((c) => !c.ok && c.label === "openshell-bind: the gateway's engine is docker"));
	// Both modes blessed: copy mode's sandboxLayout line and bind mode's lines together.
	const both = await openshellChecks({}, { ...bindOpts(bindFake().run), modes: { copy: true, bind: true } });
	assert.ok(lines(both).some((l) => /declares sandboxLayout/.test(l)) && lines(both).some((l) => /openshell-bind: the gateway admits/.test(l)));
});

// The gateway.toml is restated by hand in the CI lane and in docs/backends.md: each copy is held to `gatewayTomlFor`, the
// one the doctor fix prints (CLAUDE.md: a hand-written table restating a source is pinned).
test("every hand-written gateway.toml is gatewayTomlFor's (#686 part 3)", async () => {
	const { gatewayTomlFor } = await import("../src/openshell-cli.mjs");
	const { readFileSync: read } = await import("node:fs");
	const workflow = read(new URL("../../.github/workflows/openshell-conformance.yml", import.meta.url), "utf8");
	const body = /<<'TOML'\n([\s\S]*?)\n\s*TOML\n/.exec(workflow)?.[1];
	assert.ok(body, "the lane writes a gateway.toml");
	const indent = /^ */.exec(body)[0].length;
	assert.equal(`${body.split("\n").map((l) => l.slice(indent)).join("\n")}\n`, gatewayTomlFor("docker"));
	assert.match(workflow, /openshell-bind-conformance\.mjs --default-config/);
	const doc = read(new URL("../../docs/backends.md", import.meta.url), "utf8");
	assert.ok(doc.includes(`\`\`\`toml\n${gatewayTomlFor("docker")}\`\`\``), "docs/backends.md shows the same TOML");
});

test("bind mode's job-user line (#686 part 3, review round 1): the engine's docker info decides, as the adapter does", async () => {
	const withCaps = (caps) => ({ "docker image": { code: 0, stdout: `${caps}\n` } });
	const worker = await openshellChecks({}, bindOpts(bindFake({ over: withCaps("anyUid") }).run, { ids: { euid: 1234, egid: 1235 } }));
	assert.ok(lines(worker).includes("ok openshell-bind: jobs run as uid:gid 1234:1235 (the policy's run_as_user) with HOME=/home/pi"));
	for (const [options, cause] of [[["name=rootless"], /rootless/], [["name=userns"], /userns-remap/]]) {
		const c = await openshellChecks({}, bindOpts(bindFake({ info: DOCKER_INFO(options), over: withCaps("anyUid") }).run, { ids: { euid: 1234, egid: 1235 } }));
		const failed = c.find((x) => !x.ok && x.label === "openshell-bind: a uid the job may run as exists");
		assert.ok(failed, JSON.stringify(lines(c)));
		assert.match(failed.fix, cause);
	}
	const noCap = await openshellChecks({}, bindOpts(bindFake({ over: withCaps("replicas") }).run, { ids: { euid: 1234, egid: 1235 } }));
	assert.match(noCap.find((x) => !x.ok).fix, /anyUid/);
	const silent = await openshellChecks({}, bindOpts(bindFake({ info: { code: 1, stdout: "" } }).run, { ids: { euid: 1234, egid: 1235 } }));
	assert.ok(silent.some((x) => x.warn && /who a job runs as could not be read/.test(x.label)));
	// The probe is asked with the adapter's 60 s bound.
	const timed = [];
	const base = bindFake();
	await openshellChecks({}, bindOpts(async (bin, args, opts) => (args.includes("create") && timed.push(opts), base.run(bin, args))));
	assert.deepEqual(timed, [{ timeoutMs: 60_000 }]);
});

test("the doctor's probe source sits under the jobs dir when it exists, else the tmp dir (#686 part 3, review round 2)", async () => {
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	const jobsDir = tempDir("pd-doctor-jobs-");
	const base = bindFake();
	let source = null;
	const run = async (bin, args, o) => {
		if (args.includes("create")) source = JSON.parse(args[args.indexOf("--driver-config-json") + 1]).docker.mounts[0].source;
		return base.run(bin, args, o);
	};
	const { mkdtemp: _m, rmdir: _r, ...opts } = bindOpts(run);
	await openshellChecks({}, { ...opts, jobsDir });
	assert.ok(source.startsWith(`${jobsDir}/bind-probe-`), source);
});

test("doctor's unit check: the installed user unit Wants= openshell-gateway.service and is not After= it; a missing Wants=, an After= cycle or a system unit is a ⚠ (#707)", async () => {
	const { openshellUnitOrderChecks } = await import("../src/doctor.mjs");
	const path = "/home/op/.config/systemd/user/pi-dispatch-worker.service";
	const unitFor = (deps) => `[Unit]\nAfter=network-online.target docker.service\n${deps}\n[Service]\nWorkingDirectory=/srv/d\nExecStart=/n /c worker\n`;
	const seams = (text, { platform = "linux", at = path } = {}) => ({ platform, home: "/home/op", fileExists: (p) => p === at, readUnit: () => text });
	const [wanted] = openshellUnitOrderChecks(seams(unitFor("Wants=openshell-gateway.service")), "/srv/d");
	assert.equal(wanted.ok, true);
	assert.equal(wanted.warn, undefined);
	const [older] = openshellUnitOrderChecks(seams(unitFor("")), "/srv/d");
	assert.equal(older.warn, true);
	assert.match(older.fix, /service install --force/);
	const [cycle] = openshellUnitOrderChecks(seams(unitFor("Wants=openshell-gateway.service\nAfter=openshell-gateway.service")), "/srv/d");
	assert.equal(cycle.warn, true);
	assert.match(cycle.label, /an ordering cycle/);
	const [system] = openshellUnitOrderChecks(seams(unitFor("x"), { at: "/etc/systemd/system/pi-dispatch-worker.service" }), "/srv/d");
	assert.equal(system.warn, true);
	assert.match(system.label, /system unit, which cannot pull in the gateway's user unit/);
	assert.deepEqual(openshellUnitOrderChecks(seams(unitFor("x")), "/elsewhere"), [], "no unit for this folder says nothing: the worker may run by hand");
	assert.deepEqual(openshellUnitOrderChecks(seams(unitFor("x"), { platform: "darwin" }), "/srv/d"), []);
});
