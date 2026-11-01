import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planSetupEgress, applySetupEgress } from "../src/setup-egress.mjs";
import { EGRESS_PROXY_IMAGE } from "../src/egress-proxy-state.mjs";
import { EGRESS_RUN_ARGS } from "../src/up.mjs";
import { readPackagedProxyConf } from "../src/egress-conf-copy.mjs";

function fixture() {
	const dir = fs.realpathSync(tempDir("setup-egress-"));
	fs.mkdirSync(join(dir, "deploy"));
	fs.writeFileSync(join(dir, ".env"), "PI_BACKENDS=local\n", { mode: 0o600 });
	fs.writeFileSync(join(dir, "deploy", "egress-proxy.conf"), readPackagedProxyConf());
	fs.writeFileSync(join(dir, "egress-allowlist.conf"), "api.anthropic.com\n");
	fs.writeFileSync(join(dir, "model-endpoints.conf"), "# no endpoints\n");
	const calls = [];
	let state = null;
	const shape = (status = "exited", changes = {}) => ({ status, health: "none", image: EGRESS_PROXY_IMAGE, entrypoint: ["entrypoint.sh"], cmd: ["-f", "/etc/squid/squid.conf", "-NYC"], mounts: [
		{ Type: "bind", Source: join(dir, "deploy/egress-proxy.conf"), Destination: "/etc/squid/squid.conf" },
		{ Type: "bind", Source: join(dir, "egress-allowlist.conf"), Destination: "/etc/pi-dispatch/allowlist.conf" },
		{ Type: "bind", Source: join(dir, "model-endpoints.conf"), Destination: "/etc/pi-dispatch/model-endpoints.conf" },
	], networks: { "pi-dispatch-egress-out": {} }, ...changes });
	const ctx = { dir, fs, uid: process.getuid(), platform: "linux", env: {}, resolveEndpoint: async () => ({ local: true }), async run(bin, args) {
		calls.push([bin, ...args]);
		if (args[0] === "info") return { code: 0, stdout: "daemon-id", stderr: "" };
		if (args[0] === "inspect") return state ? { code: 0, stdout: JSON.stringify(state), stderr: "" } : { code: 1, stdout: "", stderr: "No such object: pi-dispatch-egress-proxy" };
		if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network: pi-dispatch-egress-out" };
		if (args[0] === "run" || args[0] === "start") state = shape("running");
		return { code: 0, stdout: "", stderr: "" };
	} };
	return { ctx, calls, shape, setState: (value) => { state = value; } };
}

test("missing Docker proxy plan is read-only; apply uses the same shipped argv and confirms actual running state", async () => {
	const { ctx, calls } = fixture();
	const plan = await planSetupEgress(ctx);
	assert.equal(plan.refusal, undefined);
	assert.equal(calls.some((argv) => ["run", "start", "create"].includes(argv[1]) || argv[1] === "network" && argv[2] === "create"), false);
	const result = await applySetupEgress(plan, ctx);
	assert.equal(result.state, "applied");
	assert.ok(calls.some((argv) => JSON.stringify(argv) === JSON.stringify(["docker", ...EGRESS_RUN_ARGS])));
	assert.equal(calls.some((argv) => ["rm", "restart", "unpause"].includes(argv[1])), false);
});

test("a stopped current proxy is started, while a running proxy is unchanged", async () => {
	for (const status of ["exited", "running"]) {
		const { ctx, calls, shape, setState } = fixture();
		setState(shape(status));
		const plan = await planSetupEgress(ctx);
		assert.equal(plan.refusal, undefined);
		assert.equal((await applySetupEgress(plan, ctx)).state, status === "running" ? "unchanged" : "applied");
		assert.equal(calls.some((argv) => argv[1] === "start"), status === "exited");
	}
});

test("remote, foreign, paused, attached, old-rules and OpenShell proxy operations refuse without mutation", async () => {
	for (const bad of ["remote", "foreign", "paused", "attached", "old-rules", "openshell", "custom", "off"]) {
		const { ctx, calls, shape, setState } = fixture();
		if (bad === "remote") ctx.resolveEndpoint = async () => ({ local: false });
		if (bad === "foreign") setState(shape("exited", { image: "another/image:old" }));
		if (bad === "paused") setState(shape("paused"));
		if (bad === "attached") setState(shape("exited", { networks: { "pi-job-active": {} } }));
		if (bad === "old-rules") fs.writeFileSync(join(ctx.dir, "deploy/egress-proxy.conf"), "old rules");
		if (bad === "openshell") fs.writeFileSync(join(ctx.dir, ".env"), "PI_BACKENDS=openshell\n", { mode: 0o600 });
		if (bad === "custom") fs.writeFileSync(join(ctx.dir, ".env"), "PI_EGRESS_PROXY=someone-elses-proxy\n", { mode: 0o600 });
		if (bad === "off") fs.writeFileSync(join(ctx.dir, ".env"), "PI_EGRESS=0\n", { mode: 0o600 });
		assert.equal(typeof (await planSetupEgress(ctx)).refusal, "string", bad);
		assert.equal(calls.some((argv) => ["run", "start", "restart", "rm"].includes(argv[1]) || argv[1] === "network" && argv[2] === "create"), false, bad);
	}
});

test("runtime context disagreement cannot start a proxy on a different daemon than its worker", async () => {
	const { ctx, calls } = fixture();
	fs.appendFileSync(join(ctx.dir, ".env"), "DOCKER_HOST=tcp://other-host:2376\n");
	ctx.env.DOCKER_HOST = "unix:///var/run/docker.sock";
	assert.equal((await planSetupEgress(ctx)).refusal, "unsafe-deployment");
	assert.deepEqual(calls, []);
});

test("native Podman first install reuses Quadlet files/start order and never replaces a container", async () => {
	const { ctx, calls } = fixture();
	const home = join(ctx.dir, "home"); fs.mkdirSync(home);
	if (ctx.uid === 0) {
		ctx.uid = 1000;
		ctx.fs = { ...fs, lstatSync(path) { const st = fs.lstatSync(path); Object.defineProperty(st, "uid", { value: 1000 }); return st; } };
	}
	fs.writeFileSync(join(ctx.dir, ".env"), "PI_BACKENDS=podman\n", { mode: 0o600 });
	ctx.serviceDeps = { home, user: "operator" };
	ctx.env.XDG_RUNTIME_DIR = `/run/user/${ctx.uid}`;
	ctx.readPodmanInfo = async () => ({ answered: true, info: { rootless: true, serviceIsRemote: false } });
	let running = false;
	ctx.run = async (bin, args) => {
		calls.push([bin, ...args]);
		if (bin === "systemctl") { if (args.includes("start")) running = true; return { code: 0, stdout: "", stderr: "" }; }
		if (args[0] === "container") return { code: 125, stdout: "", stderr: "no such container" };
		if (args[0] === "inspect") return running ? { code: 0, stdout: JSON.stringify({ status: "running" }), stderr: "" } : { code: 125, stdout: "", stderr: "no such container" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const plan = await planSetupEgress(ctx);
	assert.equal(plan.refusal, undefined);
	assert.equal(fs.existsSync(join(home, ".config", "containers", "systemd")), false);
	assert.equal((await applySetupEgress(plan, ctx)).state, "applied");
	assert.equal(fs.existsSync(join(home, ".config", "containers", "systemd", "pi-dispatch-egress-proxy.container")), true);
	assert.ok(calls.some((args) => args[0] === "systemctl" && args.includes("daemon-reload")));
	assert.ok(calls.some((args) => args[0] === "systemctl" && args.includes("start")));
	assert.equal(calls.some((args) => args.includes("restart") || args.includes("rm")), false);
});
