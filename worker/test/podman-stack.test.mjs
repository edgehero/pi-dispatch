import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EGRESS_PROXY } from "../src/egress.mjs";
import { ALL_QUADLET_FILES, QUADLET_FILES, planStack, quadletDir, readStackKeys, stackComponents } from "../src/podman-stack.mjs";
import { runService } from "../src/service.mjs";

/**
 * The native podman venue's stack as Quadlet units (issue #430): the shipped templates, the planner, and
 * `pi-dispatch service` installing, rendering, reporting and removing them. No podman, no systemctl: every spawn is a
 * recording fake, and the fake fs serves writes from a Map while reads of the real templates fall through.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
const WORKER_SRC = join(REPO_ROOT, "worker", "src");
const DEPLOY_AT = "/srv/pi-deploy";
const HOME = "/home/tester";
const QDIR = "/home/tester/.config/containers/systemd";
const USER_UNIT = "/home/tester/.config/systemd/user/pi-dispatch-worker.service";
const ENV_PATH = `${DEPLOY_AT}/.env`;
const ALLOWLIST = `${DEPLOY_AT}/egress-allowlist.conf`;

const template = (name) => readFileSync(join(DEPLOY_DIR, name), "utf8");
const quadletNames = ALL_QUADLET_FILES.map((q) => q.file);

// ---------------------------------------------------------------------------------------------------
// The templates: what the worker and the installer rely on, read off the real shipped files
// ---------------------------------------------------------------------------------------------------

test("templates: every Quadlet file the installer names ships in deploy/", () => {
	for (const name of quadletNames) assert.ok(template(name).length > 0, `deploy/${name} ships`);
});

// A containers.conf `netns = "host"` puts a container started with no network option into the host namespace
// (measured), where PublishPort means nothing and Valkey would listen on every interface. Only an explicit Network= wins.
test("templates: every .container sets an explicit Network= naming a .network file that ships", () => {
	for (const name of quadletNames.filter((n) => n.endsWith(".container"))) {
		const nets = [...template(name).matchAll(/^Network=(.*)$/gm)].map((m) => m[1].trim());
		assert.equal(nets.length, 1, `${name} sets exactly one Network=`);
		assert.match(nets[0], /\.network$/, `${name} names a Quadlet network, never the runtime's default`);
		assert.ok(quadletNames.includes(nets[0]), `${nets[0]} ships beside ${name}`);
	}
});

test("templates: Valkey publishes on 127.0.0.1 only, and nothing else publishes anything", () => {
	for (const name of quadletNames) {
		for (const [, value] of template(name).matchAll(/^PublishPort=(.*)$/gm)) {
			assert.match(value, /^127\.0\.0\.1:/, `${name}: PublishPort must bind loopback only, got ${value}`);
		}
	}
	assert.match(template("pi-dispatch-valkey.container"), /^PublishPort=127\.0\.0\.1:6379:6379$/m, "the default VALKEY_URL's port");
	assert.doesNotMatch(template("pi-dispatch-egress-proxy.container"), /^PublishPort=/m, "the proxy publishes nothing, as in compose");
});

test("templates: every image is fully qualified (a unit cannot answer a short-name prompt)", () => {
	for (const name of quadletNames.filter((n) => n.endsWith(".container"))) {
		const [, image] = /^Image=(.*)$/m.exec(template(name)) ?? [];
		assert.match(image ?? "", /^docker\.io\//, `${name}: ${image}`);
	}
});

// This container IS the allowlist: a digest bumped in one file only gives the two venues two different policies.
test("templates: the proxy runs the compose file's digest, under the name the worker attaches, on the compose network's name", () => {
	const compose = template("docker-compose.yml");
	const digest = /^\s*image:\s*ubuntu\/squid@(sha256:[0-9a-f]{64})\s*$/m.exec(compose)?.[1];
	assert.ok(digest, "compose pins the proxy by digest");
	const proxy = template("pi-dispatch-egress-proxy.container");
	assert.match(proxy, new RegExp(`^Image=docker\\.io/ubuntu/squid@${digest}$`, "m"), "the Quadlet proxy runs the compose digest");
	assert.equal(proxy.split("sha256:").length - 1, 1, "one image, one digest");
	assert.match(proxy, new RegExp(`^ContainerName=${DEFAULT_EGRESS_PROXY}$`, "m"));
	const composeNet = /egress-out:\s*\n\s*name:\s*(\S+)/.exec(compose)?.[1];
	assert.equal(composeNet, "pi-dispatch-egress-out");
	assert.match(template("pi-dispatch-egress-out.network"), new RegExp(`^NetworkName=${composeNet}$`, "m"));
	// The SELinux label matches compose's choice: shared `z`, since a host running both mounts the same allowlist twice.
	assert.equal([...proxy.matchAll(/^Volume=.*:ro,z$/gm)].length, 2, "both config mounts carry :ro,z");
	assert.doesNotMatch(proxy, /,Z$/m, "never the private label");
	// dash has no /dev/tcp: the check must be the exec (JSON array) form running bash, as compose's CMD form does.
	assert.match(proxy, /^HealthCmd=\["bash", "-c", "exec 3<>\/dev\/tcp\/127\.0\.0\.1\/3128"\]$/m);
});

test("templates: generated units are started by the generator's own [Install], so each .container carries WantedBy=default.target", () => {
	for (const name of quadletNames.filter((n) => n.endsWith(".container"))) {
		assert.match(template(name), /^\[Install\]\nWantedBy=default\.target$/m, name);
	}
});

// ---------------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------------

const realReadFs = (files = {}) => {
	const store = new Map(Object.entries(files));
	return {
		store,
		existsSync: (p) => store.has(p),
		readFileSync: (p, enc) => (store.has(p) ? store.get(p) : readFileSync(p, enc)),
	};
};

test("stackComponents: Valkey only without local; the proxy only while armed and only under the default name", () => {
	const podmanOnly = { localUsed: false, podmanUsed: true };
	const mixed = { localUsed: true, podmanUsed: true };
	assert.deepEqual(stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: true }), { valkey: true, proxy: true, notes: [] });
	assert.equal(stackComponents({ venues: mixed, env: {}, includeValkey: true, armed: true }).valkey, false, "docker's Valkey owns the port when local is blessed");
	assert.equal(stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: false }).proxy, false);
	const renamed = stackComponents({ venues: podmanOnly, env: { PI_EGRESS_PROXY: "my-squid" }, includeValkey: true, armed: true });
	assert.equal(renamed.proxy, false, "never a Quadlet that would --replace the operator's own container");
	assert.match(renamed.notes[0], /PI_EGRESS_PROXY names my-squid/);
});

test("planStack: the proxy's two mounts become the package's conf and the deployment's allowlist; actions are writes, reload, start", () => {
	const fs = realReadFs();
	const plan = planStack({ components: { valkey: true, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs });
	assert.equal(plan.dir, QDIR);
	assert.deepEqual(plan.files.map((f) => f.path), [QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey, QUADLET_FILES.egressNetwork, QUADLET_FILES.proxy].map((q) => join(QDIR, q.file)));
	const proxy = plan.files.find((f) => f.path.endsWith(".container") && f.path.includes("proxy")).text;
	assert.match(proxy, new RegExp(`^Volume=${join(DEPLOY_DIR, "egress-proxy.conf")}:/etc/squid/squid.conf:ro,z$`, "m"));
	assert.match(proxy, new RegExp(`^Volume=${ALLOWLIST}:/etc/pi-dispatch/allowlist.conf:ro,z$`, "m"));
	assert.doesNotMatch(proxy, /^Volume=\/opt\/pi-dispatch/m, "no placeholder survives");
	assert.deepEqual(plan.start, ["pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service"]);
	assert.deepEqual(plan.actions.at(-1), { kind: "run", argv: ["systemctl", "--user", "start", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service"] });
	assert.ok(!plan.actions.some((a) => a.kind === "run" && a.argv.includes("enable")), "a generated unit is never enabled");
});

test("planStack: a deployment path a Quadlet Volume= cannot carry is refused, not escaped", () => {
	for (const bad of ["/srv/pi deploy", "/srv/pi:deploy", "/srv/pi%deploy", "/srv/pi${HOME}deploy", "/srv/pi$Xdeploy"]) {
		const plan = planStack({ components: { valkey: false, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: bad, home: HOME, fs: realReadFs() });
		assert.match(plan.error ?? "", /cannot carry/, bad);
	}
	// Valkey mounts only a named volume, so the deployment path does not matter to it.
	assert.equal(planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: "/srv/pi deploy", home: HOME, fs: realReadFs() }).error, undefined);
});

// ---------------------------------------------------------------------------------------------------
// `pi-dispatch service` on a podman deployment
// ---------------------------------------------------------------------------------------------------

function fakeSpawn(plan, calls) {
	return (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push([cmd, ...args]);
		const stream = () => ({
			handlers: {},
			on(ev, cb) {
				this.handlers[ev] = cb;
				return this;
			},
		});
		const handlers = {};
		const child = {
			stdout: stream(),
			stderr: stream(),
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") return handlers.error?.(new Error("ENOENT"));
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

const PODMAN_ENV = "PI_BACKENDS=podman\n";

function svc({ argv = ["install"], files = {}, plan = {}, listening = false, env = {}, platform = "linux", cwd = DEPLOY_AT } = {}) {
	const calls = [];
	const out = [];
	const err = [];
	const store = new Map(Object.entries(files));
	const writes = [];
	const deps = {
		env,
		platform,
		euid: 1234,
		execPath: "/fake/node",
		cwd,
		moduleDir: WORKER_SRC,
		resolveReceiver: () => "/fake/receiver/start.mjs",
		home: HOME,
		user: "tester",
		tmp: "/faketmp",
		// The test's own plan FIRST: the fake takes the first matching prefix, so a longer key a test adds must come
		// before the defaults' shorter one.
		spawn: fakeSpawn({ ...plan, ...Object.fromEntries(Object.entries({ "loginctl show-user": { code: 0, output: "Linger=yes\n" }, "podman container inspect": 125 }).filter(([k]) => !(k in plan))) }, calls),
		out: (s) => out.push(s),
		err: (s) => err.push(s),
		probeTcp: async () => listening,
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p, enc) => (store.has(p) ? store.get(p) : readFileSync(p, enc)),
			writeFileSync: (p, d) => {
				writes.push(p);
				store.set(p, d);
			},
			mkdirSync: () => {},
			unlinkSync: (p) => store.delete(p),
		},
	};
	return { run: () => runService(argv, deps), calls, store, writes, text: () => out.join(""), errText: () => err.join("") };
}

test("service install (user scope, podman in .env, egress armed): writes the Quadlets, starts them (never enables), and the worker Wants/After them", async () => {
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "api.anthropic.com\n" } });
	assert.equal(await h.run(), 0, h.errText());
	for (const q of ALL_QUADLET_FILES) assert.ok(h.store.has(join(QDIR, q.file)), `${q.file} written into ${QDIR}`);
	const LABEL = '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}';
	assert.deepEqual(h.calls, [
		["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-valkey"],
		["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-egress-proxy"],
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "start", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service"],
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", "--now", "pi-dispatch-worker.service"],
		["loginctl", "show-user", "tester", "-p", "Linger"],
	]);
	assert.ok(h.writes.indexOf(USER_UNIT) > h.writes.indexOf(join(QDIR, "pi-dispatch-egress-proxy.container")), "the stack before the worker");
	const unit = h.store.get(USER_UNIT);
	assert.match(unit, /^Wants=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service$/m);
	assert.match(unit, /^After=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service$/m);
	assert.match(h.text(), /linger is on for tester/);
	assert.doesNotMatch(h.text(), /⚠ linger is OFF/);
});

test("service install on podman: linger OFF is a warning naming the exact command, and the install still succeeds", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` }, plan: { "loginctl show-user": { code: 0, output: "Linger=no\n" } } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /⚠ linger is OFF for tester: measured, without it neither these Quadlet units nor a user-scope worker start at boot/);
	assert.match(h.text(), /sudo loginctl enable-linger tester/);
	assert.ok(!h.store.has(join(QDIR, QUADLET_FILES.proxy.file)), "PI_EGRESS=0: no proxy");
	assert.ok(h.store.has(join(QDIR, QUADLET_FILES.valkey.file)));
});

test("service install --system on podman is refused, writes nothing and spawns nothing (render too)", async () => {
	for (const argv of [["install", "--system"], ["render", "--system"]]) {
		const h = svc({ argv, files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" } });
		assert.equal(await h.run(), 1, argv.join(" "));
		assert.match(h.errText(), /OWN user manager, which a system unit cannot order itself after/);
		assert.match(h.errText(), /enable-linger tester/);
		assert.deepEqual(h.writes, [], `${argv.join(" ")}: nothing written`);
		assert.deepEqual(h.calls, [], `${argv.join(" ")}: nothing spawned`);
	}
});

test("service install reads PI_BACKENDS from the .env the unit loads, never from this shell", async () => {
	const shellOnly = svc({ env: { PI_BACKENDS: "podman" }, files: {} });
	assert.equal(await shellOnly.run(), 0);
	assert.ok(!shellOnly.writes.some((p) => p.startsWith(QDIR)), "a shell export says nothing about what the service runs");
	const docker = svc({ files: { [ENV_PATH]: "PI_BACKENDS=local\n" } });
	assert.equal(await docker.run(), 0);
	assert.ok(!docker.writes.some((p) => p.startsWith(QDIR)), "a docker deployment gets no Quadlet");
	assert.doesNotMatch(docker.store.get(USER_UNIT), /pi-dispatch-valkey/, "and its unit is the unchanged render");
});

test("service install on podman: an unparseable PI_BACKENDS or PI_EGRESS refuses before anything is written", async () => {
	for (const text of ["PI_BACKENDS=podmn\n", `${PODMAN_ENV}PI_EGRESS=yes\n`]) {
		const h = svc({ files: { [ENV_PATH]: text } });
		assert.equal(await h.run(), 1, text);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.calls, []);
	}
});

test("service install on podman: local in the list or a listener on 6379 means no Quadlet Valkey, and the worker Wants only what was installed", async () => {
	const mixed = svc({ files: { [ENV_PATH]: "PI_BACKENDS=local,podman\n", [ALLOWLIST]: "x\n" } });
	assert.equal(await mixed.run(), 0);
	assert.ok(!mixed.store.has(join(QDIR, QUADLET_FILES.valkey.file)), "docker's Valkey owns the port on a mixed host");
	assert.match(mixed.store.get(USER_UNIT), /^Wants=pi-dispatch-egress-proxy\.service$/m);
	const taken = svc({ listening: true, files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` } });
	assert.equal(await taken.run(), 0);
	assert.ok(!taken.writes.some((p) => p.startsWith(QDIR)));
	assert.match(taken.text(), /already listens on 127\.0\.0\.1:6379/);
	assert.doesNotMatch(taken.store.get(USER_UNIT), /^Wants=pi-dispatch/m);
	// A Valkey unit an earlier run installed is kept and ordered after, even though it is now the listener.
	const kept = svc({ listening: true, argv: ["install", "--force"], files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n`, [join(QDIR, QUADLET_FILES.valkey.file)]: template(QUADLET_FILES.valkey.file) } });
	assert.equal(await kept.run(), 0);
	assert.match(kept.store.get(USER_UNIT), /^Wants=pi-dispatch-valkey\.service$/m);
});

test("service install on podman: PI_EGRESS_PROXY naming another container installs no proxy unit and says why", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS_PROXY=my-squid\n`, [ALLOWLIST]: "x\n" } });
	assert.equal(await h.run(), 0);
	assert.ok(!h.store.has(join(QDIR, QUADLET_FILES.proxy.file)));
	assert.match(h.text(), /PI_EGRESS_PROXY names my-squid, your own proxy/);
});

test("service install on podman: a missing allowlist refuses before anything is written", async () => {
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /egress-allowlist\.conf does not exist/);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.calls, []);
});

test("service install on podman: a Quadlet file with other content is kept without --force and replaced with it", async () => {
	const edited = { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n`, [join(QDIR, QUADLET_FILES.valkey.file)]: "[Container]\nImage=mine\n" };
	const h = svc({ files: edited });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /other content than this version renders/);
	assert.deepEqual(h.writes, []);
	const forced = svc({ argv: ["install", "--force"], files: edited, listening: true });
	assert.equal(await forced.run(), 0);
	assert.equal(forced.store.get(join(QDIR, QUADLET_FILES.valkey.file)), template(QUADLET_FILES.valkey.file));
});

test("service install on podman: a stack that fails to start leaves the worker unit unwritten and exits 1", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` }, plan: { "systemctl --user start": 1 } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /systemctl --user start pi-dispatch-valkey\.service failed \(exit 1\), so the worker unit was NOT installed/);
	assert.ok(!h.store.has(USER_UNIT));
	assert.ok(!h.calls.some((c) => c.includes("enable")));
});

test("service render on podman prints the worker unit with its Wants= and every Quadlet file, spawning nothing", async () => {
	const h = svc({ argv: ["render"], files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /^Wants=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service$/m);
	for (const q of ALL_QUADLET_FILES) assert.ok(h.text().includes(`# → ${join(QDIR, q.file)} (Quadlet, podman venue)`), q.file);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.calls, []);
});

test("service uninstall stops (never disables) and removes the Quadlet units with the worker, keeping the volume", async () => {
	const files = { [USER_UNIT]: "unit" };
	for (const q of ALL_QUADLET_FILES) files[join(QDIR, q.file)] = "q";
	const h = svc({ argv: ["uninstall"], files });
	assert.equal(await h.run(), 0);
	for (const q of ALL_QUADLET_FILES) assert.ok(!h.store.has(join(QDIR, q.file)), `${q.file} removed`);
	assert.deepEqual(h.calls.slice(2), [
		["systemctl", "--user", "stop", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service"],
		["systemctl", "--user", "daemon-reload"],
	]);
	assert.match(h.text(), /volume and the networks are kept/);
	// With no worker unit (up installed the stack alone), uninstall still removes what exists.
	const alone = svc({ argv: ["uninstall"], files: { [join(QDIR, QUADLET_FILES.valkey.file)]: "q" } });
	assert.equal(await alone.run(), 0);
	assert.ok(!alone.store.has(join(QDIR, QUADLET_FILES.valkey.file)));
});

test("service status lists each installed Quadlet unit with its state, and nothing where there are none", async () => {
	const h = svc({ argv: ["status"], files: { [join(QDIR, QUADLET_FILES.valkey.file)]: "q" }, plan: { "systemctl --user is-active": { code: 0, output: "active\n" } } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), new RegExp(`quadlet: ${join(QDIR, QUADLET_FILES.valkey.file)} \\(pi-dispatch-valkey\\.service\\): active`));
	const none = svc({ argv: ["status"] });
	assert.equal(await none.run(), 0);
	assert.doesNotMatch(none.text(), /quadlet:/);
});

test("quadletDir is ~/.config/containers/systemd whatever this shell's XDG_CONFIG_HOME says", () => {
	assert.equal(quadletDir(HOME), QDIR);
});

// ---------------------------------------------------------------------------------------------------
// Review round 1 (issue #430): the defects and the gaps each mutation survived
// ---------------------------------------------------------------------------------------------------

const LABEL = '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}';
const NO_EGRESS = `${PODMAN_ENV}PI_EGRESS=0\n`;

test("D3: service install refuses a container of the unit's name the unit does not own, and --force replaces it saying so", async () => {
	const foreign = { "podman container inspect --format": { code: 0, output: "<no value>\n" } };
	const h = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan: foreign });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /pi-dispatch-valkey already exists under this account's Podman and is not managed by the Quadlet unit/);
	assert.match(h.errText(), /podman rm -f pi-dispatch-valkey/);
	assert.match(h.errText(), /pass --force/);
	assert.deepEqual(h.writes, [], "refused before anything is written");
	assert.ok(!h.calls.some((c) => c[0] === "systemctl"));
	const forced = svc({ argv: ["install", "--force"], files: { [ENV_PATH]: NO_EGRESS }, plan: foreign });
	assert.equal(await forced.run(), 0);
	assert.match(forced.text(), /⚠ --force: pi-dispatch-valkey is not managed by pi-dispatch-valkey\.service and will be REPLACED by it/);
	// A container the unit started carries the unit's label: that one is ours, and nothing is refused.
	const ours = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan: { "podman container inspect --format": { code: 0, output: "pi-dispatch-valkey.service\n" } } });
	assert.equal(await ours.run(), 0);
	assert.deepEqual(ours.calls[0], ["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-valkey"]);
});

test("D3: a hand-started proxy is foreign too, and --force warns that running jobs lose their per-job networks", async () => {
	const plan = { "podman container inspect --format {{index .Config.Labels \"PODMAN_SYSTEMD_UNIT\"}} pi-dispatch-egress-proxy": { code: 0, output: "\n" } };
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /pi-dispatch-egress-proxy already exists/);
	const forced = svc({ argv: ["install", "--force"], files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan });
	assert.equal(await forced.run(), 0);
	assert.match(forced.text(), /every job running right now loses the per-job network it had on that proxy/);
});

test("D5: --force over a changed .container RESTARTS that unit (start is a no-op on an active one), and warns for the proxy", async () => {
	const planned = planStack({ components: { valkey: true, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n", [join(QDIR, QUADLET_FILES.valkey.file)]: planned.files[1].text };
	for (const f of planned.files) files[f.path] = f.text;
	files[join(QDIR, QUADLET_FILES.proxy.file)] = "[Container]\nImage=old\n";
	const h = svc({ argv: ["install", "--force"], files, listening: true });
	assert.equal(await h.run(), 0, h.errText());
	assert.deepEqual(h.calls.filter((c) => c[0] === "systemctl").slice(0, 3), [
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "start", "pi-dispatch-valkey.service"],
		["systemctl", "--user", "restart", "pi-dispatch-egress-proxy.service"],
	]);
	assert.match(h.text(), /⚠ restarting pi-dispatch-egress-proxy\.service makes a NEW proxy container/);
	assert.match(h.text(), /^restarted pi-dispatch-egress-proxy\.service, whose Quadlet file this install replaced$/m);
	assert.match(h.text(), /^started pi-dispatch-valkey\.service /m);
	// A changed .network file alone restarts nothing: its unit only runs `network create --ignore`.
	const netOnly = planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs({ [join(QDIR, QUADLET_FILES.valkeyNetwork.file)]: "[Network]\n" }) });
	assert.deepEqual(netOnly.restart, []);
});

test("M19: every file unchanged still daemon-reloads before the start", () => {
	const first = planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const same = Object.fromEntries(first.files.map((f) => [f.path, f.text]));
	const again = planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs(same) });
	assert.deepEqual(again.actions, [
		{ kind: "run", argv: ["systemctl", "--user", "daemon-reload"] },
		{ kind: "run", argv: ["systemctl", "--user", "start", "pi-dispatch-valkey.service"] },
	]);
});

test("D6/M15: a stack key in any form the loaders disagree on refuses the install, never reads as 'no podman'", async () => {
	for (const text of [
		"PI_BACKENDS =podman\n", // systemd sets it, and it produces no record
		"export PI_BACKENDS=podman\n", // the shells set it, systemd ignores it
		"PI_BACKENDS=$X\n", // expanded by the shells only
		"FOO=a\\\nPI_BACKENDS=podman\n", // the line above continues into this one
		"PI_EGRESS = 0\nPI_BACKENDS=podman\n",
	]) {
		const h = svc({ files: { [ENV_PATH]: text } });
		assert.equal(await h.run(), 1, JSON.stringify(text));
		assert.match(h.errText(), /whether this deployment runs the podman venue is|so what the service reads for it is unknown/i, text);
		assert.deepEqual(h.writes, [], text);
		assert.deepEqual(h.calls, [], text);
	}
	// A file-level hazard refuses once a key is assigned at all, and is nobody's business when none is. The shells'
	// loader shows it (systemd 252 reads the lines after an open quote as lines, measured in env-file.mjs).
	assert.match(readStackKeys("PI_BACKENDS=podman\nFOO='open\n", { loader: "shell" }).error, /line 2 is one this command cannot read/);
	assert.deepEqual(readStackKeys("FOO='open\n", { loader: "shell" }).keys, {});
	// A comment mentioning a key is not a line of the file, and a plain assignment reads.
	assert.deepEqual(readStackKeys("# PI_BACKENDS=podman is how\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
	assert.deepEqual(readStackKeys("PI_EGRESS_PROXY=my-squid\n").keys, { PI_EGRESS_PROXY: "my-squid" });
});

test("M16: on macOS and Windows a .env listing podman installs the platform's unit and SAYS no podman stack was installed", async () => {
	const mac = svc({ platform: "darwin", files: { [ENV_PATH]: PODMAN_ENV }, plan: { launchctl: 0 } });
	assert.equal(await mac.run(), 0, mac.errText());
	assert.match(mac.text(), /PI_BACKENDS lists podman, and the podman venue runs only on Linux/);
	assert.ok(!mac.writes.some((p) => p.startsWith(QDIR)));
	const win = svc({ platform: "win32", files: { [ENV_PATH]: PODMAN_ENV }, plan: { "nssm status": 3, nssm: 0 } });
	assert.equal(await win.run(), 0, win.errText());
	assert.match(win.text(), /the podman venue runs only on Linux/);
	// And an unreadable line there refuses nothing: the answer could only ever change a note.
	const odd = svc({ platform: "darwin", files: { [ENV_PATH]: "PI_BACKENDS =podman\n" }, plan: { launchctl: 0 } });
	assert.equal(await odd.run(), 0);
});

test("M29: a deployment path the proxy's Volume= cannot carry refuses the install before anything runs", async () => {
	const at = "/srv/pi deploy";
	const h = svc({ cwd: at, files: { [`${at}/.env`]: PODMAN_ENV, [`${at}/egress-allowlist.conf`]: "x\n" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /cannot carry a colon, whitespace/);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.calls, []);
});

test("M33: service render prints the stack's notes, not only install", async () => {
	const h = svc({ argv: ["render"], files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS_PROXY=my-squid\n` } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /^# note: PI_EGRESS_PROXY names my-squid, your own proxy/m);
});
