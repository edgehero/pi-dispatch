import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EGRESS_PROXY } from "../src/egress.mjs";
import { ALL_QUADLET_FILES, NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, makeNetnsDetachGuard, QUADLET_FILES, managerEnvRefusal, unquoteShowEnvironment, planStack, podmanNeedsNetnsKeeper, quadletDir, readStackKeys, stackComponents } from "../src/podman-stack.mjs";
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

// Issue #458: the rootless network keeper must not widen anything, so its unit is read as the generator reads it, and
// every key is on a list: a key added to it (a PublishPort, a Volume, an AddCapability, a PodmanArgs flag) fails here
// until someone decides it belongs. Each allowed key's VALUE is pinned too, not only its presence.
const unitSections = (text) => {
	const sections = {};
	let current = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[(\w[\w-]*)\]$/.exec(line);
		if (header) {
			current = header[1];
			sections[current] ??= [];
			continue;
		}
		const eq = line.indexOf("=");
		assert.ok(current && eq > 0, `a key=value line inside a section: ${line}`);
		sections[current].push([line.slice(0, eq), line.slice(eq + 1)]);
	}
	return sections;
};

test("templates (#458): the keeper container widens nothing, key by key, and its PodmanArgs add only what is named", () => {
	const unit = unitSections(template(QUADLET_FILES.keeper.file));
	const proxyImage = /^Image=(.*)$/m.exec(template(QUADLET_FILES.proxy.file))?.[1];
	assert.deepEqual(unit.Container, [
		// The proxy's own image and digest: nothing new to pull or to keep in step.
		["Image", proxyImage],
		["ContainerName", NETNS_KEEPER],
		["Network", QUADLET_FILES.keeperNetwork.file],
		["ReadOnly", "true"],
		["DropCapability", "all"],
		["NoNewPrivileges", "true"],
		["User", "65534"],
		["Group", "65534"],
		["RunInit", "true"],
		["PodmanArgs", "--entrypoint=sleep --image-volume=ignore"],
		["Exec", "infinity"],
	]);
	assert.deepEqual(unit.Service, [
		["TimeoutStartSec", "900"],
		// The keeper's own network, made again before each start with the .network unit's own flags.
		["ExecStartPre", `/usr/bin/podman network create --ignore --disable-dns --internal ${NETNS_KEEPER}`],
		["Restart", "always"],
		["RestartSec", "1s"],
		["SuccessExitStatus", "143"],
	]);
	assert.deepEqual(unit.Install, [["WantedBy", "default.target"]]);
	assert.deepEqual(Object.keys(unit), ["Unit", "Container", "Service", "Install"]);
	assert.deepEqual(unit.Unit.map(([k]) => k), ["Description", "StartLimitIntervalSec"]);
	assert.deepEqual(unit.Unit[1], ["StartLimitIntervalSec", "0"], "no start-limit lockout for a keeper that restarts always");
});

test("templates (#458): the keeper's network has no route out and no DNS, and nothing else sets it up", () => {
	const unit = unitSections(template(QUADLET_FILES.keeperNetwork.file));
	assert.deepEqual(unit, { Network: [["NetworkName", NETNS_KEEPER], ["Internal", "true"], ["DisableDNS", "true"]] });
	// The container's ExecStartPre makes this network again before each start, so it must carry exactly what Quadlet
	// renders from these two keys (4.9.3: `podman network create --ignore --disable-dns --internal <name>`, measured).
	const pre = unitSections(template(QUADLET_FILES.keeper.file)).Service.find(([k]) => k === "ExecStartPre")?.[1];
	assert.equal(pre, `/usr/bin/podman network create --ignore --disable-dns --internal ${unit.Network[0][1]}`);
});

// A sweep that removed the keeper, or its network under it, would bring the defect back with nothing said (and a
// `network rm -f` of its network leaves its unit failed until restarted, measured). The prefixes are READ from the
// source, every exported `*PREFIX = "pi-..."`, so a sweep added later is covered without anyone remembering this test.
// Substring, not prefix: `--filter name=X` matches anywhere in a name, on podman and docker alike.
test("templates (#458): the keeper's container and network names are outside every prefix a pi-dispatch sweep removes", () => {
	const prefixes = [];
	for (const file of readdirSync(WORKER_SRC).filter((f) => f.endsWith(".mjs"))) {
		for (const m of readFileSync(join(WORKER_SRC, file), "utf8").matchAll(/^export const \w*PREFIX = "(pi-[^"]*)";$/gm)) prefixes.push(m[1]);
	}
	for (const known of ["pi-job-", "pi-sandbox-", "pi-dispatch-live-", "pi-dispatch-egress-doctor-", "pi-dispatch-egress-probe-"]) assert.ok(prefixes.includes(known), `${known} is read from the source`);
	const netName = /^NetworkName=(.*)$/m.exec(template(QUADLET_FILES.keeperNetwork.file))?.[1];
	for (const name of [NETNS_KEEPER, netName]) {
		for (const prefix of prefixes) assert.ok(!name.includes(prefix), `${name} would be matched by a sweep of ${prefix}`);
	}
	// And the prefixes the pinned test fixtures use for the other stack parts, so a rename cannot collide either.
	assert.equal(new Set([NETNS_KEEPER, DEFAULT_EGRESS_PROXY, "pi-dispatch-valkey", "pi-dispatch-egress-out"]).size, 4);
});

test("podmanNeedsNetnsKeeper (#458): every 4.x and an unread version, never 5.x", () => {
	for (const v of ["4.9.3", "4.9.5", "4.0.0", "3.4.4", "", null, undefined, "unknown", " 4.9.3 "]) assert.equal(podmanNeedsNetnsKeeper(v), true, String(v));
	for (const v of ["5.0.0", "5.8.1", "6.0.0-dev", "10.1.0"]) assert.equal(podmanNeedsNetnsKeeper(v), false, v);
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

test("stackComponents: Valkey only without local; the proxy only while armed and only under the default name; the keeper whenever armed", () => {
	const podmanOnly = { localUsed: false, podmanUsed: true };
	const mixed = { localUsed: true, podmanUsed: true };
	assert.deepEqual(stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: true }), { valkey: true, proxy: true, keeper: true, notes: [] });
	assert.equal(stackComponents({ venues: mixed, env: {}, includeValkey: true, armed: true }).valkey, false, "docker's Valkey owns the port when local is blessed");
	assert.equal(stackComponents({ venues: mixed, env: {}, includeValkey: true, armed: true }).keeper, true, "podman jobs on a mixed host disconnect the proxy too");
	const off = stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: false });
	assert.equal(off.proxy, false);
	assert.equal(off.keeper, false, "with egress off no proxy is ever disconnected, so there is nothing to keep");
	const renamed = stackComponents({ venues: podmanOnly, env: { PI_EGRESS_PROXY: "my-squid" }, includeValkey: true, armed: true });
	assert.equal(renamed.proxy, false, "never a Quadlet that would --replace the operator's own container");
	assert.equal(renamed.keeper, true, "(#458) the worker disconnects the operator's own proxy from every job network just the same");
	assert.match(renamed.notes[0], /PI_EGRESS_PROXY names my-squid/);
});

const CONF_COPY = "/home/tester/.config/pi-dispatch/egress-proxy.conf";

test("planStack: the proxy mounts an ACCOUNT-OWNED copy of the rules and the deployment's allowlist; actions are writes, reload, start", () => {
	const fs = realReadFs();
	const plan = planStack({ components: { valkey: true, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs });
	assert.equal(plan.dir, QDIR);
	assert.deepEqual(plan.files.map((f) => f.path), [
		...[QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey, QUADLET_FILES.egressNetwork].map((q) => join(QDIR, q.file)),
		CONF_COPY,
		join(QDIR, QUADLET_FILES.proxy.file),
	]);
	// E1 (measured): `z` cannot relabel a root-owned package file, so the unit never mounts the package's own copy.
	assert.equal(plan.files.find((f) => f.path === CONF_COPY).text, template("egress-proxy.conf"), "a byte-for-byte copy of the shipped rules");
	const proxy = plan.files.find((f) => f.path.endsWith(".container") && f.path.includes("proxy")).text;
	assert.match(proxy, new RegExp(`^Volume=${CONF_COPY}:/etc/squid/squid.conf:ro,z$`, "m"));
	assert.doesNotMatch(proxy, new RegExp(DEPLOY_DIR), "the package directory is never mounted");
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
			const { code, output, stderr } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			if (stderr) child.stderr.handlers.data?.(stderr);
			handlers.close?.(code);
		});
		return child;
	};
}

const PODMAN_ENV = "PI_BACKENDS=podman\n";

// A real login's environment by default: a user manager to talk to (round 2, E8).
function svc({ argv = ["install"], files = {}, plan = {}, listening = false, env = { XDG_RUNTIME_DIR: "/run/user/1234" }, platform = "linux", cwd = DEPLOY_AT, realpath = (p) => p } = {}) {
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
		spawn: fakeSpawn({ ...plan, ...Object.fromEntries(Object.entries({ "loginctl show-user": { code: 0, output: "Linger=yes\n" }, "podman container inspect": { code: 125, stderr: "Error: no such container\n" }, "podman inspect --format={{.State.Status}}|": { code: 0, output: "running|bridge|pi-dispatch-netns-keeper,|1000000\n" } }).filter(([k]) => !(k in plan))) }, calls),
		out: (s) => out.push(s),
		err: (s) => err.push(s),
		probeTcp: async () => listening,
		realpath,
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p, enc) => {
				// A stored Error is a file that exists and cannot be read (R21).
				if (store.get(p) instanceof Error) throw store.get(p);
				return store.has(p) ? store.get(p) : readFileSync(p, enc);
			},
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
		// PR #463 round 3: the manager's own environment, read before anything is written.
		["systemctl", "--user", "show-environment"],
		["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-valkey"],
		["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-egress-proxy"],
		["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-netns-keeper"],
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "start", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service", "pi-dispatch-netns-keeper.service"],
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", "--now", "pi-dispatch-worker.service"],
		["loginctl", "show-user", "tester", "-p", "Linger"],
	]);
	assert.ok(h.writes.indexOf(USER_UNIT) > h.writes.indexOf(join(QDIR, "pi-dispatch-egress-proxy.container")), "the stack before the worker");
	const unit = h.store.get(USER_UNIT);
	assert.match(unit, /^Wants=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service$/m);
	assert.match(unit, /^After=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service$/m);
	assert.match(h.text(), /linger is on for tester/);
	assert.doesNotMatch(h.text(), /⚠ linger is OFF/);
});

test("service install on podman: linger OFF is a warning naming the exact command, and the install still succeeds", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` }, plan: { "loginctl show-user": { code: 0, output: "Linger=no\n" } } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /⚠ linger is OFF for tester: measured, without it neither these Quadlet units nor a user-scope worker start at boot/);
	assert.match(h.text(), /sudo loginctl enable-linger tester/);
	assert.ok(!h.store.has(join(QDIR, QUADLET_FILES.proxy.file)), "PI_EGRESS=0: no proxy");
	assert.ok(!h.store.has(join(QDIR, QUADLET_FILES.keeper.file)), "PI_EGRESS=0: no keeper (#458)");
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
	assert.match(mixed.store.get(USER_UNIT), /^Wants=pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service$/m);
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
	// Issue #458: the keeper still is, since the worker disconnects my-squid from every job network just the same.
	assert.equal(h.store.get(join(QDIR, QUADLET_FILES.keeper.file)), template(QUADLET_FILES.keeper.file));
	assert.match(h.store.get(USER_UNIT), /^Wants=pi-dispatch-valkey\.service pi-dispatch-netns-keeper\.service$/m);
});

test("service install on podman: a missing allowlist refuses before anything is written", async () => {
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /egress-allowlist\.conf does not exist/);
	assert.deepEqual(h.writes, []);
	assert.ok(!h.calls.some((c) => (c[0] === "systemctl" && c[2] !== "show-environment")), "only the read-only container queries ran");
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
	assert.match(h.text(), /^Wants=pi-dispatch-valkey\.service pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service$/m);
	for (const q of ALL_QUADLET_FILES) assert.ok(h.text().includes(`# → ${join(QDIR, q.file)} (Quadlet, podman venue)`), q.file);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.calls, []);
});

test("service uninstall stops (never disables) and removes the Quadlet units with the worker, keeping the volume", async () => {
	const files = { [USER_UNIT]: "unit" };
	for (const q of ALL_QUADLET_FILES) files[join(QDIR, q.file)] = "q";
	files[CONF_COPY] = "conf";
	const h = svc({ argv: ["uninstall"], files });
	assert.equal(await h.run(), 0);
	for (const q of ALL_QUADLET_FILES) assert.ok(!h.store.has(join(QDIR, q.file)), `${q.file} removed`);
	assert.ok(!h.store.has(CONF_COPY), "the account-owned copy of the rules goes with its unit");
	assert.deepEqual(h.calls.slice(2), [
		// D2 (round 3, measured): the network units too, or a reinstall after `podman network rm` finds its network unit
		// still "active (exited)" and the container fails with "network not found".
		// Issue #458: the keeper stopped with the proxy and its network with theirs.
		["systemctl", "--user", "stop", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service", "pi-dispatch-netns-keeper.service", "pi-dispatch-valkey-network.service", "pi-dispatch-egress-out-network.service", "pi-dispatch-netns-keeper-network.service"],
		["systemctl", "--user", "daemon-reload"],
		// E10 (measured): squid ignores SIGTERM, its stop ends 137 and `failed`; the failed state is cleared.
		["systemctl", "--user", "reset-failed", "pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service", "pi-dispatch-netns-keeper.service", "pi-dispatch-valkey-network.service", "pi-dispatch-egress-out-network.service", "pi-dispatch-netns-keeper-network.service"],
	]);
	assert.match(h.text(), /volume and the networks are kept/);
	// With no worker unit (up installed the stack alone), uninstall still removes what exists.
	const alone = svc({ argv: ["uninstall"], files: { [join(QDIR, QUADLET_FILES.valkey.file)]: "q" } });
	assert.equal(await alone.run(), 0);
	assert.ok(!alone.store.has(join(QDIR, QUADLET_FILES.valkey.file)));
	assert.match(alone.text(), /the pi-dispatch-valkey-data volume and the networks are kept/);
	// No Valkey unit installed: no volume is claimed kept (issue #452 gate round 2).
	const noValkey = svc({ argv: ["uninstall"], files: { [join(QDIR, QUADLET_FILES.proxy.file)]: "q", [join(QDIR, QUADLET_FILES.keeper.file)]: "q" } });
	assert.equal(await noValkey.run(), 0);
	assert.doesNotMatch(noValkey.text(), /valkey-data/);
	assert.match(noValkey.text(), /; the networks are kept, remove them with podman if you mean to/);
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
	assert.ok(!h.calls.some((c) => (c[0] === "systemctl" && c[2] !== "show-environment")));
	const forced = svc({ argv: ["install", "--force"], files: { [ENV_PATH]: NO_EGRESS }, plan: foreign });
	assert.equal(await forced.run(), 0);
	assert.match(forced.text(), /⚠ --force: pi-dispatch-valkey is not managed by pi-dispatch-valkey\.service and will be REPLACED by it\n/);
	assert.doesNotMatch(forced.text(), /per-job network/, "the proxy's cost is never said of Valkey (R18)");
	// A container the unit started carries the unit's label: that one is ours, and nothing is refused.
	const ours = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan: { "podman container inspect --format": { code: 0, output: "pi-dispatch-valkey.service\n" } } });
	assert.equal(await ours.run(), 0);
	assert.deepEqual(ours.calls[1], ["podman", "container", "inspect", "--format", LABEL, "pi-dispatch-valkey"]);
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
	const planned = planStack({ components: { valkey: true, proxy: true, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n", [join(QDIR, QUADLET_FILES.valkey.file)]: planned.files[1].text };
	for (const f of planned.files) files[f.path] = f.text;
	files[join(QDIR, QUADLET_FILES.proxy.file)] = "[Container]\nImage=old\n";
	const h = svc({ argv: ["install", "--force"], files, listening: true });
	assert.equal(await h.run(), 0, h.errText());
	assert.deepEqual(h.calls.filter((c) => (c[0] === "systemctl" && c[2] !== "show-environment")).slice(0, 3), [
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "start", "pi-dispatch-valkey.service", "pi-dispatch-netns-keeper.service"],
		["systemctl", "--user", "restart", "pi-dispatch-egress-proxy.service"],
	]);
	assert.match(h.text(), /⚠ restarting pi-dispatch-egress-proxy\.service makes a NEW proxy container/);
	assert.match(h.text(), /^restarted pi-dispatch-egress-proxy\.service, because this install replaced \/home\/tester\/\.config\/containers\/systemd\/pi-dispatch-egress-proxy\.container$/m);
	assert.match(h.text(), /^started pi-dispatch-valkey\.service pi-dispatch-netns-keeper\.service \(Quadlet units/m, "the started line lists ONLY what was started (R28)");
	// A changed .network file alone restarts nothing: its unit only runs `network create --ignore`.
	const netOnly = planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs({ [join(QDIR, QUADLET_FILES.valkeyNetwork.file)]: "[Network]\n" }) });
	assert.deepEqual(netOnly.restart, []);
});

test("planStack (#458): the keeper's two files follow the proxy's, the rules copy stays right before the proxy, and the keeper is started", () => {
	const all = planStack({ components: { valkey: true, proxy: true, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	assert.deepEqual(all.files.map((f) => f.path), [
		...[QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey, QUADLET_FILES.egressNetwork].map((q) => join(QDIR, q.file)),
		CONF_COPY,
		...[QUADLET_FILES.proxy, QUADLET_FILES.keeperNetwork, QUADLET_FILES.keeper].map((q) => join(QDIR, q.file)),
	]);
	assert.equal(all.files.find((f) => f.path.endsWith(QUADLET_FILES.keeper.file)).text, template(QUADLET_FILES.keeper.file), "copied verbatim");
	assert.deepEqual(all.start, ["pi-dispatch-valkey.service", "pi-dispatch-egress-proxy.service", "pi-dispatch-netns-keeper.service"]);
	// The keeper alone (an operator's own proxy, or ours already running under up): no rules copy, one unit started.
	const alone = planStack({ components: { valkey: false, proxy: false, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	assert.deepEqual(alone.files.map((f) => f.path), [QUADLET_FILES.keeperNetwork, QUADLET_FILES.keeper].map((q) => join(QDIR, q.file)));
	assert.deepEqual(alone.actions.at(-1), { kind: "run", argv: ["systemctl", "--user", "start", "pi-dispatch-netns-keeper.service"] });
	// A changed keeper file restarts the keeper only, and never warns about the proxy (a keeper restart costs no job anything).
	const changed = planStack({ components: { valkey: false, proxy: true, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs({ [join(QDIR, QUADLET_FILES.keeper.file)]: "[Container]\nImage=old\n" }) });
	assert.deepEqual(changed.restart, ["pi-dispatch-netns-keeper.service"]);
});

test("D3 (#458): a container named like the keeper that its unit does not own is refused like the proxy's", async () => {
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: { "podman container inspect --format {{index .Config.Labels \"PODMAN_SYSTEMD_UNIT\"}} pi-dispatch-netns-keeper": { code: 0, output: "<no value>\n" } } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /pi-dispatch-netns-keeper already exists under this account's Podman and is not managed by the Quadlet unit/);
	assert.deepEqual(h.writes, []);
});

// PR #463 round 2: a keeper (re)started under a proxy that stays up is what the worker and doctor read as possible
// damage (the order rule), so a plan that moves the keeper beside an unchanged proxy restarts the proxy with it.
test("planStack (#458): a keeper started or restarted beside an unchanged proxy restarts the proxy; a first install starts both", () => {
	const all = { valkey: false, proxy: true, keeper: true };
	const plan = (files = {}, restartUnits = []) => planStack({ components: all, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs(files), restartUnits });
	const first = plan();
	assert.deepEqual(first.restart, [], "both new: a first install starts them together");
	const same = Object.fromEntries(first.files.map((f) => [f.path, f.text]));
	const upgrade = plan(Object.fromEntries(Object.entries(same).filter(([p]) => !p.includes("netns-keeper"))));
	assert.deepEqual(upgrade.restart, ["pi-dispatch-egress-proxy.service"], "an upgrade: the keeper is new, the proxy has been up all along");
	assert.deepEqual(upgrade.actions.slice(-2), [
		{ kind: "run", argv: ["systemctl", "--user", "start", "pi-dispatch-netns-keeper.service"] },
		{ kind: "run", argv: ["systemctl", "--user", "restart", "pi-dispatch-egress-proxy.service"] },
	], "the keeper first, then the proxy");
	const asked = plan(same, ["pi-dispatch-netns-keeper.service"]);
	assert.deepEqual(asked.restart, ["pi-dispatch-netns-keeper.service", "pi-dispatch-egress-proxy.service"]);
	const unchanged = plan(same);
	assert.deepEqual(unchanged.restart, [], "nothing moved, nothing restarted");
	const ownProxy = planStack({ components: { valkey: false, proxy: false, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	assert.deepEqual(ownProxy.restart, [], "an operator's own proxy is not ours to restart");
});

// PR #463 round 3 (measured on Podman 4.9.3): a user manager whose environment names ANOTHER account's
// XDG_RUNTIME_DIR or XDG_CONFIG_HOME (a runner image's /etc/environment, read through environment.d) makes every unit
// fail ("XDG_RUNTIME_DIR directory ... is not owned by the current user") or not exist at all. Refused before a write.
test("managerEnvRefusal (#458): another account's XDG_RUNTIME_DIR or XDG_CONFIG_HOME in the manager refuses; its own or none passes", () => {
	const who = { home: HOME, euid: 1234, user: "tester" };
	const read = (text, code = 0) => managerEnvRefusal({ code, stdout: text }, who);
	assert.equal(read("HOME=/home/tester\nXDG_RUNTIME_DIR=/run/user/1234\nXDG_CONFIG_HOME=/home/tester/.config\n"), null);
	assert.equal(read("HOME=/home/tester\n"), null, "unset is the manager's own default");
	assert.equal(read("XDG_RUNTIME_DIR=/run/user/1234/\nXDG_CONFIG_HOME=/home/tester/.config/\n"), null, "a trailing slash is the same directory");
	assert.equal(read("XDG_RUNTIME_DIR=/run/user/1001\n", 1), null, "a manager that did not answer is left to the commands that follow");
	const runtime = read("XDG_RUNTIME_DIR=/run/user/1001\n");
	assert.match(runtime, /^tester's user manager runs with XDG_RUNTIME_DIR=\/run\/user\/1001, not \/run\/user\/1234: every podman command in a unit would fail \("XDG_RUNTIME_DIR directory \.\.\. is not owned by the current user", measured\)\. That environment is what every unit it starts inherits, so nothing is installed\./);
	assert.match(runtime, /~\/\.config\/environment\.d\/ \(for example a file zz-pi-dispatch\.conf with XDG_RUNTIME_DIR=\/run\/user\/1234 and XDG_CONFIG_HOME=\/home\/tester\/\.config\), restart the manager \(sudo systemctl restart user@1234\.service/);
	const config = read("XDG_CONFIG_HOME=/home/runner/.config\n");
	assert.match(config, /XDG_CONFIG_HOME=\/home\/runner\/\.config, not \/home\/tester\/\.config: the Quadlet generator would look for the units there, not in \/home\/tester\/\.config\/containers\/systemd/);
	assert.match(read("XDG_RUNTIME_DIR=/run/user/1001\nXDG_CONFIG_HOME=/home/runner/.config\n"), /XDG_RUNTIME_DIR=\/run\/user\/1001[^]*; and XDG_CONFIG_HOME=\/home\/runner\/\.config/);
});

test("service install and up (#458): a manager environment naming another account's directories installs nothing, said with the rest", async () => {
	const leak = { "systemctl --user show-environment": { code: 0, output: "HOME=/home/tester\nXDG_RUNTIME_DIR=/run/user/1001\n" } };
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: leak });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /tester's user manager runs with XDG_RUNTIME_DIR=\/run\/user\/1001, not \/run\/user\/1234/);
	assert.deepEqual(h.writes, [], "refused before anything is written");
	assert.ok(!h.calls.some((c) => c[0] === "systemctl" && c[2] !== "show-environment"), "nothing started");
	// --force does not apply: it is not a thing --force could accept.
	const forced = svc({ argv: ["install", "--force"], files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: leak });
	assert.equal(await forced.run(), 1);
	assert.deepEqual(forced.writes, []);
	// Without a user manager to ask, the bus refusal is the one said, and the environment is never asked.
	const noBus = svc({ env: {}, files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: leak });
	assert.equal(await noBus.run(), 1);
	assert.ok(!noBus.calls.some((c) => c.join(" ") === "systemctl --user show-environment"));
});

// PR #463 round 3: service install with the operator's own proxy starts the keeper beside a proxy it does not own.
test("service install (#458): a keeper started beside the operator's own proxy names that proxy's restart; a re-run with nothing moved says nothing", async () => {
	const env = `${PODMAN_ENV}PI_EGRESS_PROXY=my-squid\n`;
	const h = svc({ files: { [ENV_PATH]: env, [ALLOWLIST]: "x\n" } });
	assert.equal(await h.run(), 0, h.errText());
	assert.match(h.text(), /⚠ pi-dispatch-netns-keeper was started while the egress proxy \(my-squid\) is not part of this install: if it is running, restart the egress proxy once no job is running: podman restart my-squid \(or its own unit\)/);
	const files = Object.fromEntries([...h.store.entries()]);
	const again = svc({ argv: ["install", "--force"], files });
	assert.equal(await again.run(), 0, again.errText());
	assert.doesNotMatch(again.text(), /is not part of this install/, "a keeper file unchanged and not restarted moved nothing");
	// Our own proxy in the plan: restarted with the keeper (planStack), never a hint.
	const ours = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" } });
	assert.equal(await ours.run(), 0);
	assert.doesNotMatch(ours.text(), /is not part of this install/);
});

// PR #463 round 3: systemd prints a value needing quotes as $'...' (measured on systemd 255: `$'/home/a b/.config'`,
// `$'it\\'s'`), and a symlinked home is the same directory under another spelling.
test("managerEnvRefusal (#458): a quoted value is unquoted before it is compared, and a symlinked home compares by realpath", () => {
	assert.equal(unquoteShowEnvironment("$'/home/a b/.config'"), "/home/a b/.config");
	assert.equal(unquoteShowEnvironment("$'it\\'s'"), "it's");
	assert.equal(unquoteShowEnvironment("/plain"), "/plain");
	const spaced = { home: "/home/a b", euid: 1234, user: "a b" };
	assert.equal(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=$'/home/a b/.config'\nXDG_RUNTIME_DIR=/run/user/1234\n" }, spaced), null, "its own, quoted");
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=$'/home/other b/.config'\n" }, spaced), /XDG_CONFIG_HOME=\/home\/other b\/\.config, not \/home\/a b\/\.config/, "another's, unquoted in the message");
	const links = { "/home/me": "/data/home/me", "/home/me/.config": "/data/home/me/.config" };
	const realpath = (p) => links[p] ?? p;
	assert.equal(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=/data/home/me/.config\n" }, { home: "/home/me", euid: 1, user: "me", realpath }), null, "the same directory through a symlinked home");
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=/data/home/you/.config\n" }, { home: "/home/me", euid: 1, user: "me", realpath }), /not \/home\/me\/\.config/);
	const throwing = () => {
		throw new Error("ENOENT");
	};
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_RUNTIME_DIR=/run/user/9\n" }, { home: "/home/me", euid: 1, user: "me", realpath: throwing }), /XDG_RUNTIME_DIR=\/run\/user\/9/, "an unresolvable path is compared as written");
});

// PR #463 final review: a Quadlet keeper already installed and unchanged but not holding (stopped, say) is read as `up`
// reads it, and RESTARTED; our proxy is restarted after it, and an operator's own proxy is named for a restart.
test("service install (#458): a stopped keeper with its files unchanged is restarted, with our proxy after it or the operator's named", async () => {
	const planned = planStack({ components: { valkey: false, proxy: true, keeper: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n", [USER_UNIT]: "old unit" };
	for (const f of planned.files) files[f.path] = f.text;
	const stopped = { "podman inspect --format={{.State.Status}}|": { code: 0, output: "exited|bridge|pi-dispatch-netns-keeper,|1000000\n" } };
	const h = svc({ argv: ["install", "--force"], files, plan: stopped, listening: true });
	assert.equal(await h.run(), 0, h.errText());
	assert.ok(h.calls.some((c) => c.join(" ") === `podman inspect ${NETNS_KEEPER_FORMAT} pi-dispatch-netns-keeper`), "read as up reads it");
	assert.deepEqual(h.calls.filter((c) => c[0] === "systemctl" && ["start", "restart"].includes(c[2])).map((c) => c.join(" ")), ["systemctl --user restart pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service"], "the keeper, then our proxy after it");
	assert.match(h.text(), /⚠ restarting pi-dispatch-egress-proxy\.service makes a NEW proxy container/, "the proxy's restart is warned, as always");
	// The operator's own proxy: nothing of theirs is restarted, and they are told to, by name.
	const ownFiles = { ...files, [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS_PROXY=my-squid\n` };
	for (const p of Object.keys(ownFiles)) if (p.includes("egress-proxy.container") || p.includes("egress-out.network") || p.endsWith("egress-proxy.conf")) delete ownFiles[p];
	const own = svc({ argv: ["install", "--force"], files: ownFiles, plan: stopped, listening: true });
	assert.equal(await own.run(), 0, own.errText());
	assert.ok(own.calls.some((c) => c.join(" ") === "systemctl --user restart pi-dispatch-netns-keeper.service"));
	assert.match(own.text(), /⚠ pi-dispatch-netns-keeper was restarted while the egress proxy \(my-squid\) is not part of this install: if it is running, restart the egress proxy once no job is running: podman restart my-squid/);
	// A keeper that holds: a plain start, no restart, no hint.
	const held = svc({ argv: ["install", "--force"], files, listening: true });
	assert.equal(await held.run(), 0, held.errText());
	assert.ok(!held.calls.some((c) => c[0] === "systemctl" && c[2] === "restart"));
	// Render reads nothing of the host.
	const render = svc({ argv: ["render"], files, plan: stopped });
	assert.equal(await render.run(), 0);
	assert.deepEqual(render.calls, []);
});

// PR #463 final review: the symlinked-home tolerance, through the command, so dropping the realpath seam from either
// caller is caught: a manager XDG_CONFIG_HOME that is a symlink to this home's .config is the same directory.
test("service install and up (#458): a manager XDG_CONFIG_HOME that resolves to this home's .config is not refused", async () => {
	const links = { "/srv/link/.config": "/home/tester/.config", "/home/tester/.config": "/home/tester/.config" };
	const realpath = (p) => links[p] ?? p;
	const env = { "systemctl --user show-environment": { code: 0, output: "XDG_CONFIG_HOME=/srv/link/.config\nXDG_RUNTIME_DIR=/run/user/1234\n" } };
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: env, realpath });
	assert.equal(await h.run(), 0, h.errText());
	const unresolved = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, plan: env });
	assert.equal(await unresolved.run(), 1, "without the symlink it is another directory");
	assert.match(unresolved.errText(), /XDG_CONFIG_HOME=\/srv\/link\/\.config, not \/home\/tester\/\.config/);
});

// PR #463 final review: systemd 255 prints a control character in show-environment as a 3-digit octal escape (measured:
// `$'/home/a\\033b/.config'`), cescape_char's own choice over hex.
test("unquoteShowEnvironment (#458): octal and hex escapes decode, as systemd's cescape_char writes them", () => {
	assert.equal(unquoteShowEnvironment("$'/home/a\\033b/.config'"), "/home/a\x1bb/.config");
	assert.equal(unquoteShowEnvironment("$'a\\tb\\x41'"), "a\tbA");
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
	// A file-level hazard refuses once a key is assigned at all, and is nobody's business when none is. Shown here with
	// the shells' loader; the systemd case, a value that OPENS with a quote, is its own test below (round 2, E4, which
	// corrected the claim this comment used to make that systemd never continues a quote).
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

// ---------------------------------------------------------------------------------------------------
// Review round 2 (issue #430): the measured defects and the surviving mutants
// ---------------------------------------------------------------------------------------------------

const WARN = "time=\"2026-09-27T10:00:00Z\" level=warning msg=\"The cgroupv2 manager is set to systemd but there is no systemd user session available\"\n";

test("E2: podman's stderr warnings never make our own container read as foreign", async () => {
	const plan = { "podman container inspect --format": { code: 0, output: "pi-dispatch-valkey.service\n", stderr: WARN } };
	const h = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan });
	assert.equal(await h.run(), 0, h.errText());
	assert.doesNotMatch(h.text(), /REPLACED/);
});

test("R1: a label naming a DIFFERENT unit is foreign, not ours", async () => {
	const h = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan: { "podman container inspect --format": { code: 0, output: "my-valkey.service\n" } } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /pi-dispatch-valkey already exists/);
});

test("E3: an inspect that fails for any reason but 'no such container' refuses, --force or not", async () => {
	for (const argv of [["install"], ["install", "--force"]]) {
		const h = svc({ argv, files: { [ENV_PATH]: NO_EGRESS }, plan: { "podman container inspect": { code: 125, stderr: "Error: database is locked\n" } } });
		assert.equal(await h.run(), 1, argv.join(" "));
		assert.match(h.errText(), /whether pi-dispatch-valkey already exists could not be read \(podman container inspect exited 125 without saying the container does not exist\)/);
		assert.deepEqual(h.writes, []);
		assert.ok(!h.calls.some((c) => (c[0] === "systemctl" && c[2] !== "show-environment")));
	}
	// "no such object" is podman's other spelling of absent.
	const absent = svc({ files: { [ENV_PATH]: NO_EGRESS }, plan: { "podman container inspect": { code: 125, stderr: "Error: no such object: \"pi-dispatch-valkey\"\n" } } });
	assert.equal(await absent.run(), 0, absent.errText());
});

test("E4/D1: only a key line INSIDE a still-open quoted value is in doubt; a multi-line value that closes is ordinary", () => {
	// A key swallowed by a value that opens with a quote and continues (systemd's env_file_6): refused, both lines named.
	assert.match(readStackKeys("NOTE='see\nPI_BACKENDS=podman\n'\n").error, /line 2 \(PI_BACKENDS\) lies inside the quoted value that opens on line 1 and closes on line 3/);
	// Never closed: every key after it is in doubt.
	assert.match(readStackKeys("NOTE='see\nPI_BACKENDS=podman\n").error, /opens on line 1 and never closes/);
	// An escaped `"` does not close a double-quoted value (the E4c mutant: `rest.includes('"')`).
	assert.match(readStackKeys('K="a\\"\nPI_BACKENDS=podman\n').error, /line 2 \(PI_BACKENDS\) lies inside/);
	assert.match(readStackKeys('K="a\\"\nPI_BACKENDS=podman\n').error, /GITHUB_APP_PRIVATE_KEY_PATH/);
	// D1 (measured on systemd 259): the documented multi-line GitHub App key, with the venue key before AND after it.
	const pem = 'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc=\n-----END RSA PRIVATE KEY-----"\n';
	assert.deepEqual(readStackKeys(`PI_BACKENDS=podman\nPI_EGRESS=1\n${pem}GITHUB_APP_PRIVATE_KEY_PATH=\n`).keys, { PI_BACKENDS: "podman", PI_EGRESS: "1" });
	assert.deepEqual(readStackKeys(`${pem}PI_BACKENDS=podman\n`).keys, { PI_BACKENDS: "podman" });
	// A quote opened MID-value does not continue, and a closed one is ordinary.
	assert.deepEqual(readStackKeys("NOTE=a'b\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
	assert.deepEqual(readStackKeys("NOTE='a b'\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
});

test("nits/R7/R32: `;` comments, a key inside another key's value, and a leading blank read as systemd reads them", () => {
	assert.deepEqual(readStackKeys("; PI_BACKENDS=local\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
	assert.deepEqual(readStackKeys("PI_ENV_SETUP=/opt/PI_BACKENDS.sh\n").keys, {}, "a key name inside another value touches nothing");
	assert.deepEqual(readStackKeys("NOTE=see PI_BACKENDS\n").keys, {});
	assert.deepEqual(readStackKeys("  PI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" }, "leading blanks are allowed, as systemd allows them");
});

test("E8: service install with no user manager reachable refuses before writing anything, naming the remedy", async () => {
	const h = svc({ env: {}, files: { [ENV_PATH]: NO_EGRESS } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set, as under `sudo -iu tester`/);
	assert.match(h.errText(), /machinectl shell tester@/);
	assert.match(h.errText(), /XDG_RUNTIME_DIR=\/run\/user\/1234/);
	assert.deepEqual(h.writes, []);
	assert.ok(!h.calls.some((c) => (c[0] === "systemctl" && c[2] !== "show-environment")));
});

test("E9: every refusal reason is shown together, so --force is consent to the whole list", async () => {
	const files = { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n", [USER_UNIT]: "old unit", [join(QDIR, QUADLET_FILES.valkey.file)]: "[Container]\nImage=mine\n" };
	const plan = { "podman container inspect --format {{index .Config.Labels \"PODMAN_SYSTEMD_UNIT\"}} pi-dispatch-egress-proxy": { code: 0, output: "\n" } };
	const h = svc({ files, plan });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /nothing installed, for these reasons:/);
	assert.match(h.errText(), /pi-dispatch-worker\.service already exists/);
	assert.match(h.errText(), /pi-dispatch-valkey\.container already exists with other content/);
	assert.match(h.errText(), /pi-dispatch-egress-proxy already exists under this account's Podman/);
	assert.match(h.errText(), /--force accepts every item above at once/);
	assert.deepEqual(h.writes, []);
});

test("E1: a changed copy of the rules restarts the proxy, which squid reads only at start", async () => {
	const planned = planStack({ components: { valkey: false, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = Object.fromEntries(planned.files.map((f) => [f.path, f.text]));
	files[CONF_COPY] = "old rules\n";
	const again = planStack({ components: { valkey: false, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs(files) });
	assert.deepEqual(again.restart, ["pi-dispatch-egress-proxy.service"]);
	assert.deepEqual(again.actions.filter((a) => a.kind === "write"), [{ kind: "write", path: CONF_COPY }]);
});

test("R29: restarting only Valkey never prints the proxy's restart warning", async () => {
	const planned = planStack({ components: { valkey: true, proxy: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: NO_EGRESS, ...Object.fromEntries(planned.files.map((f) => [f.path, f.text])) };
	files[join(QDIR, QUADLET_FILES.valkey.file)] = "[Container]\nImage=old\n";
	const h = svc({ argv: ["install", "--force"], files, listening: true });
	assert.equal(await h.run(), 0, h.errText());
	assert.match(h.text(), /^restarted pi-dispatch-valkey\.service/m);
	assert.doesNotMatch(h.text(), /NEW proxy container/);
});

test("nit: a podman render tells the truth about the runtime and the Valkey ordering", async () => {
	const h = svc({ argv: ["render"], files: { [ENV_PATH]: NO_EGRESS } });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /^Description=pi-dispatch worker \(drains the job queue on the host; launches job containers via rootless podman\)$/m);
	assert.match(h.text(), /^# Valkey is the podman venue's Quadlet unit in this same user manager/m);
	assert.doesNotMatch(h.text(), /not ordered here since it may be remote/);
	const mixed = svc({ argv: ["render"], files: { [ENV_PATH]: "PI_BACKENDS=local,podman\nPI_EGRESS=0\n" } });
	assert.equal(await mixed.run(), 0);
	assert.match(mixed.text(), /via docker and rootless podman\)$/m);
	assert.match(mixed.text(), /not ordered here since it may be remote/, "no Quadlet Valkey on a mixed host, so the template's words stand");
});

test("R21/R22/R23: off Linux the .env is read with that platform's loader and never refuses", async () => {
	// R22: the macOS wrapper SOURCES the file, so `export` is an ordinary assignment there.
	const exported = svc({ platform: "darwin", files: { [ENV_PATH]: "export PI_BACKENDS=podman\n" }, plan: { launchctl: 0 } });
	assert.equal(await exported.run(), 0);
	assert.match(exported.text(), /the podman venue runs only on Linux/);
	// R21: a .env that cannot be read refuses nothing there either, while on Linux it refuses.
	const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	const unreadable = svc({ platform: "darwin", files: { [ENV_PATH]: eacces }, plan: { launchctl: 0 } });
	assert.equal(await unreadable.run(), 0);
	const linuxUnreadable = svc({ files: { [ENV_PATH]: eacces } });
	assert.equal(await linuxUnreadable.run(), 1);
	assert.match(linuxUnreadable.errText(), /cannot read .*\.env to learn whether this deployment runs the podman venue/);
	// R23: an unparseable list refuses nothing there.
	const typo = svc({ platform: "darwin", files: { [ENV_PATH]: "PI_BACKENDS=podmn\n" }, plan: { launchctl: 0 } });
	assert.equal(await typo.run(), 0);
	assert.doesNotMatch(typo.text(), /podman venue runs only on Linux/);
});

// ---------------------------------------------------------------------------------------------------
// Review round 3 (issue #430)
// ---------------------------------------------------------------------------------------------------

test("D3: uninstall with no user manager refuses before touching anything, and a failed stop removes nothing", async () => {
	const files = { [USER_UNIT]: "unit" };
	for (const q of ALL_QUADLET_FILES) files[join(QDIR, q.file)] = "q";
	const nobus = svc({ argv: ["uninstall"], env: {}, files });
	assert.equal(await nobus.run(), 1);
	assert.match(nobus.errText(), /neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set/);
	assert.deepEqual(nobus.calls, []);
	assert.ok(nobus.store.has(USER_UNIT));
	assert.doesNotMatch(nobus.text(), /uninstalled|removed/);
	// The worker's disable failing: nothing removed, no success claimed.
	const disableFails = svc({ argv: ["uninstall"], files, plan: { "systemctl --user disable": 1 } });
	assert.equal(await disableFails.run(), 1);
	assert.match(disableFails.errText(), /disable --now pi-dispatch-worker\.service failed \(exit 1\), so nothing was removed/);
	assert.ok(disableFails.store.has(USER_UNIT));
	assert.doesNotMatch(disableFails.text(), /uninstalled/);
	// The stack's stop failing: its files stay, and the exit says so.
	const stopFails = svc({ argv: ["uninstall"], files, plan: { "systemctl --user stop": 1 } });
	assert.equal(await stopFails.run(), 1);
	assert.match(stopFails.errText(), /systemctl --user stop .* failed \(exit 1\), so nothing was removed/);
	for (const q of ALL_QUADLET_FILES) assert.ok(stopFails.store.has(join(QDIR, q.file)), q.file);
	assert.doesNotMatch(stopFails.text(), /removed the podman venue/);
});

test("E8c: a DBUS_SESSION_BUS_ADDRESS alone is a reachable user manager", async () => {
	const h = svc({ env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus" }, files: { [ENV_PATH]: NO_EGRESS } });
	assert.equal(await h.run(), 0, h.errText());
});

test("nit: the refusal's closing line counts the blocking reasons it names", async () => {
	const files = { [ENV_PATH]: PODMAN_ENV, [USER_UNIT]: "old unit" };
	const oneBlocking = svc({ files });
	assert.equal(await oneBlocking.run(), 1);
	assert.match(oneBlocking.errText(), /The first item must be fixed by hand; --force accepts the rest\./);
	const twoBlocking = svc({ env: {}, files });
	assert.equal(await twoBlocking.run(), 1);
	assert.match(twoBlocking.errText(), /The first 2 items must be fixed by hand; --force accepts the rest\./);
	const forcedTwo = svc({ env: {}, argv: ["install", "--force"], files });
	assert.equal(await forcedTwo.run(), 1);
	assert.match(forcedTwo.errText(), /Each must be fixed by hand; --force does not apply\./);
});

test("nit: a restart for the rules copy alone names that file, and render names the copy without printing it", async () => {
	const planned = planStack({ components: { valkey: false, proxy: true }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n", ...Object.fromEntries(planned.files.map((f) => [f.path, f.text])) };
	files[CONF_COPY] = "old rules\n";
	const h = svc({ argv: ["install", "--force"], files, listening: true });
	assert.equal(await h.run(), 0, h.errText());
	assert.match(h.text(), new RegExp(`^restarted pi-dispatch-egress-proxy\\.service, because this install replaced ${CONF_COPY}$`, "m"));
	const render = svc({ argv: ["render"], files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" } });
	assert.equal(await render.run(), 0);
	assert.match(render.text(), new RegExp(`# → ${CONF_COPY} \\(the egress proxy's rules: install copies the package's egress-proxy\\.conf here, unchanged\\)`));
	assert.doesNotMatch(render.text(), /http_access/, "the squid configuration itself is not printed");
});

test("makeNetnsDetachGuard: a RUNNING detach waits for a keeper that holds NOW on rootless Podman 4.x, and nothing else is read (#452 with #458, gate round 2)", async () => {
	const guard = (runtime, keeper, calls = []) =>
		makeNetnsDetachGuard({
			run: async (args) => (calls.push(args.join(" ")), keeper),
			readRuntime: async () => (calls.push("runtime"), runtime),
		});
	const holding = { code: 0, stdout: `running|bridge|${NETNS_KEEPER},\n` };
	const absent = { code: 125, stdout: "" };
	const podman49 = { known: true, podman: true, rootless: true, version: "4.9.3" };
	// Nothing running to detach: not one read (a stopped proxy is not in the namespace).
	const idle = [];
	assert.equal(await guard(podman49, absent, idle)({ running: false }), null);
	assert.deepEqual(idle, []);
	// Rootless 4.x: only a keeper holding now allows it, read with the no-clock format.
	const seen = [];
	assert.equal(await guard(podman49, holding, seen)({ running: true }), null);
	assert.deepEqual(seen, ["runtime", `inspect ${NETNS_KEEPER_NOW_FORMAT} ${NETNS_KEEPER}`]);
	assert.ok(!NETNS_KEEPER_NOW_FORMAT.includes("StartedAt"), "no age rule for a detach");
	assert.equal(await guard(podman49, absent)({ running: true }), "keeper-not-holding");
	assert.equal(await guard({ ...podman49, version: null })({ running: true }).catch(() => "x"), "keeper-not-holding", "an unreported version is 4.x");
	for (const stdout of [`exited|bridge|${NETNS_KEEPER},`, `running|none|none,`, `running|bridge|other,`]) {
		assert.equal(await guard(podman49, { code: 0, stdout })({ running: true }), "keeper-not-holding", stdout);
	}
	// Docker Engine, rootful Podman and 5.x: no keeper read.
	for (const runtime of [{ known: true, podman: false, rootless: false, version: "27.4.0" }, { ...podman49, rootless: false }, { ...podman49, version: "5.8.1" }]) {
		const calls = [];
		assert.equal(await guard(runtime, absent, calls)({ running: true }), null, JSON.stringify(runtime));
		assert.deepEqual(calls, ["runtime"]);
	}
	// A runtime that could not be read: allowed only by a keeper that holds, else its own token; a throw is the same.
	assert.equal(await guard({ known: false }, holding)({ running: true }), null);
	assert.equal(await guard({ known: false }, absent)({ running: true }), "runtime-unreadable");
	const throwing = makeNetnsDetachGuard({ run: async () => { throw new Error("spawn failed"); }, readRuntime: async () => { throw new Error("spawn failed"); } });
	assert.equal(await throwing({ running: true }), "runtime-unreadable");
	// `running` defaults to true: a caller that does not say is judged as the dangerous case.
	assert.equal(await guard(podman49, absent)(), "keeper-not-holding");
});
