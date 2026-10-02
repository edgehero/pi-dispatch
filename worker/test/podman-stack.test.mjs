import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EGRESS_PROXY } from "../src/egress.mjs";
import { ALL_QUADLET_FILES, DETACH_GATE_READ_MAX_BUFFER, DETACH_GATE_READ_TIMEOUT_MS, NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, detachBlockedSentence, makeDetachGate, runtimeFromFacts, QUADLET_FILES, managerEnvRefusal, unquoteShowEnvironment, planStack, podmanNeedsNetnsKeeper, quadletDir, readStackKeys, stackComponents, STACK_KEYS, decideValkey, describeRollBack, judgeValkeyListeners, listenerUids, pinnedValkeyUrl, reachedAddress, readSubuidRanges, readValkeyKeys, resolveWorkerValkey, rollBackWrites, subordinateUids, unplainCause, valkeyTarget, journalWrite, valkeyPasswordRestartWarning } from "../src/podman-stack.mjs";
import { SYSTEMD_259_ENV_BYTES, SYSTEMD_259_ENV_FILES } from "./helpers/systemd-env-259.mjs";
import { systemdEnvFile } from "./helpers/systemd-env-parse.mjs";
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
// Issue #468: the password the harnesses generate, and where the Quadlet Valkey reads it.
const TEST_PASSWORD = "0123456789abcdef".repeat(4);
const VALKEY_ENV = "/home/tester/.config/pi-dispatch/valkey.env";
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
	assert.equal([...proxy.matchAll(/^Volume=.*:ro,z$/gm)].length, 3, "every config mount carries :ro,z");
	// The same three destinations as the compose service's mounts (issue #503: squid will not start without the include,
	// so every way of starting the proxy mounts it).
	const composeProxy = compose.slice(compose.indexOf("  egress-proxy:"), compose.indexOf("\nnetworks:"));
	const composeTargets = [...composeProxy.matchAll(/^\s+- \S+:(\/etc\/\S+):ro,z$/gm)].map((m) => m[1]);
	assert.deepEqual([...proxy.matchAll(/^Volume=[^:]+:([^:]+):ro,z$/gm)].map((m) => m[1]), composeTargets);
	assert.ok(composeTargets.includes("/etc/pi-dispatch/model-endpoints.conf"));
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
	assert.deepEqual(stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: true }), { valkey: true, proxy: true, keeper: true, notes: [], valkeyPort: 6379, valkeyPassword: null });
	// Issue #468: the password rides with the Valkey, and never without it.
	assert.equal(stackComponents({ venues: podmanOnly, env: {}, includeValkey: true, armed: false, valkeyPassword: TEST_PASSWORD }).valkeyPassword, TEST_PASSWORD);
	assert.equal(stackComponents({ venues: mixed, env: {}, includeValkey: true, armed: false, valkeyPassword: TEST_PASSWORD }).valkeyPassword, null);
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
	// Issue #468: the Valkey's 0600 password file sits right before its unit, which reads it at start.
	assert.deepEqual(plan.files.map((f) => f.path), [
		join(QDIR, QUADLET_FILES.valkeyNetwork.file),
		VALKEY_ENV,
		...[QUADLET_FILES.valkey, QUADLET_FILES.egressNetwork].map((q) => join(QDIR, q.file)),
		CONF_COPY,
		join(QDIR, QUADLET_FILES.proxy.file),
	]);
	// E1 (measured): `z` cannot relabel a root-owned package file, so the unit never mounts the package's own copy.
	assert.equal(plan.files.find((f) => f.path === CONF_COPY).text, template("egress-proxy.conf"), "a byte-for-byte copy of the shipped rules");
	const proxy = plan.files.find((f) => f.path.endsWith(".container") && f.path.includes("proxy")).text;
	assert.match(proxy, new RegExp(`^Volume=${CONF_COPY}:/etc/squid/squid.conf:ro,z$`, "m"));
	assert.doesNotMatch(proxy, new RegExp(DEPLOY_DIR), "the package directory is never mounted");
	assert.match(proxy, new RegExp(`^Volume=${ALLOWLIST}:/etc/pi-dispatch/allowlist.conf:ro,z$`, "m"));
	// Issue #503: the deployment folder's own include, mounted directly as the allowlist is (never a copy: the render
	// writes that file in place, and the reload reads the mounted inode).
	assert.match(proxy, new RegExp(`^Volume=${ALLOWLIST.replace("egress-allowlist.conf", "model-endpoints.conf")}:/etc/pi-dispatch/model-endpoints.conf:ro,z$`, "m"));
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
// Issue #464: the host files `decideValkey` reads, as this harness's host has them. A LISTEN row on 127.0.0.1:6379
// (0x18EB) owned by `uid`, the column layout measured on Fedora 44 and Ubuntu 24.04; `null` for no row.
const TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const tcpListen = (uid, port = 6379, addr = "0100007F") => `${TCP_HEAD}   3: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1589654 1 00000000cd751f2b 100 0 0 10 0\n`;
const hostFiles = (listenerUid) => ({
	"/proc/net/tcp": listenerUid === null ? TCP_HEAD : tcpListen(listenerUid),
	"/proc/net/tcp6": TCP_HEAD,
	// This account's subordinate uids (a `--network host` container of it listens as one of them), and another's.
	"/etc/subuid": "op2:1235000000:65536\ntester:1234000000:65536\n",
	"/etc/passwd": "root:x:0:0:root:/root:/bin/bash\nvalkey:x:975:975::/var/lib/valkey:/sbin/nologin\ntester:x:1234:1234::/home/tester:/bin/bash\nop2:x:1235:1235::/home/op2:/bin/bash\n",
});
// How this harness's host resolves a name, as the worker's client would (every address, `localhost` ::1 first as on
// Fedora 44); anything else does not resolve.
const DNS = { localhost: [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }], "queue.lan": [{ address: "10.0.0.5", family: 4 }] };
const fakeLookup = (dns = DNS) => async (host) => {
	if (!dns[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
	return dns[host];
};

function svc({ argv = ["install"], files = {}, plan = {}, listening = false, listenerUid = 1234, host = null, env = { XDG_RUNTIME_DIR: "/run/user/1234" }, platform = "linux", cwd = DEPLOY_AT, realpath = (p) => p, extra = {}, includeFile = true } = {}) {
	// Issue #503: `init` writes the model endpoints' include beside the allowlist, so a folder holding the one holds the
	// other unless a test says otherwise.
	if (includeFile && `${cwd}/egress-allowlist.conf` in files && !(`${cwd}/model-endpoints.conf` in files)) files = { ...files, [`${cwd}/model-endpoints.conf`]: "# generated\n" };
	const hostRead = host ?? hostFiles(listening ? listenerUid : null);
	const failWrites = new Map();
	const failUnlinks = new Map();
	const probed = [];
	const calls = [];
	const out = [];
	const err = [];
	const store = new Map(Object.entries(files));
	const writes = [];
	// Issue #468: file modes as the fake fs keeps them (the Valkey password file is written 0600, .env narrowed).
	const modes = new Map();
	const deps = {
		env,
		platform,
		euid: 1234,
		newPassword: () => TEST_PASSWORD,
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
		probeTcp: async (hostName, port) => {
			probed.push(`${hostName}:${port}`);
			return typeof listening === "function" ? listening(hostName, port) : listening;
		},
		lookup: fakeLookup(),
		interfaces: () => ({}),
		// Never this host's getsubids: /etc/subuid from the fake files.
		runSync: () => null,
		realpath,
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p, enc) => {
				// A stored Error is a file that exists and cannot be read (R21).
				if (store.get(p) instanceof Error) throw store.get(p);
				if (!store.has(p) && Object.hasOwn(hostRead, p)) {
					if (hostRead[p] instanceof Error) throw hostRead[p];
					return hostRead[p];
				}
				return store.has(p) ? store.get(p) : readFileSync(p, enc);
			},
			writeFileSync: (p, d, opts) => {
				writes.push(p);
				// A stored Error for a path is one this account cannot write (issue #464's injected write failure).
				if (failWrites.has(p)) throw failWrites.get(p);
				if (!store.has(p)) modes.set(p, opts?.mode ?? 0o644);
				store.set(p, d);
			},
			mkdirSync: () => {},
			unlinkSync: (p) => {
				if (failUnlinks.has(p)) throw failUnlinks.get(p);
				store.delete(p);
			},
			chmodSync: (p, m) => {
				modes.set(p, m);
			},
			statSync: (p) => {
				if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				return { mode: 0o100000 | (modes.get(p) ?? 0o644), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
			},
			renameSync: (from, to) => {
				writes.push(to);
				store.set(to, store.get(from));
				modes.set(to, modes.get(from));
				store.delete(from);
				modes.delete(from);
			},
		},
		...extra,
	};
	return { run: () => runService(argv, deps), calls, store, writes, modes, text: () => out.join(""), errText: () => err.join(""), failWrites, failUnlinks, probed };
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
	assert.match(taken.text(), /already listens on 127\.0\.0\.1:6379, held by this account, so no Valkey is added for it/);
	assert.doesNotMatch(taken.store.get(USER_UNIT), /^Wants=pi-dispatch/m);
	// A Valkey unit an earlier run installed is kept and ordered after, even though it is now the listener.
	const kept = svc({ listening: true, argv: ["install", "--force"], files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n`, [join(QDIR, QUADLET_FILES.valkey.file)]: template(QUADLET_FILES.valkey.file) } });
	assert.equal(await kept.run(), 0);
	assert.match(kept.store.get(USER_UNIT), /^Wants=pi-dispatch-valkey\.service$/m);
});

// Issue #464 (the comment on it, and gate round 1): a Valkey VALKEY_URL reaches is this deployment's only when it is
// this account's, on every address the worker's client would dial.
test("valkeyTarget reads VALKEY_URL as the worker's client dials it: the host without brackets, the port, or not a redis URL", () => {
	assert.deepEqual(valkeyTarget(undefined), { host: "127.0.0.1", port: 6379 }, "unset is the worker's own default");
	assert.deepEqual(valkeyTarget(""), { host: "127.0.0.1", port: 6379 });
	assert.deepEqual(valkeyTarget("redis://127.0.0.1:6380"), { host: "127.0.0.1", port: 6380 });
	assert.deepEqual(valkeyTarget("redis://LocalHost"), { host: "localhost", port: 6379 });
	assert.deepEqual(valkeyTarget("redis://:pw@[::1]:6390/0"), { host: "::1", port: 6390 });
	assert.deepEqual(valkeyTarget("rediss://127.0.0.1:6381"), { host: "127.0.0.1", port: 6381 });
	assert.deepEqual(valkeyTarget("redis://valkey.lan:6379"), { host: "valkey.lan", port: 6379 });
	assert.match(valkeyTarget("http://127.0.0.1:6379").error, /scheme is http:/);
	assert.match(valkeyTarget("not a url").error, /not a URL/);
});

test("listenerUids reads the LISTEN rows that answer an address, IPv4 and IPv6, off /proc/net/tcp and tcp6, as measured", () => {
	const fs = (tcp, tcp6 = TCP_HEAD) => ({ readFileSync: (p) => ({ "/proc/net/tcp": tcp, "/proc/net/tcp6": tcp6 })[p] ?? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })() });
	// The measured row (Fedora 44, a rootless container's pasta socket on 127.0.0.1:6392, uid 1240).
	const measured = `${TCP_HEAD}   3: 0100007F:18F8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1240        0 1589654 1 00000000cd751f2b 100 0 0 10 0\n`;
	assert.deepEqual(listenerUids("127.0.0.1", 6392, fs(measured)), { uids: [1240] });
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(tcpListen(1500, 6379, "00000000"))), { uids: [1500] }, "0.0.0.0 answers 127.0.0.1 too");
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(TCP_HEAD, tcpListen(1501, 6379, "00000000000000000000000000000000"))), { uids: [1501] }, ":: on tcp6 too");
	// The row a dual-stack socket bound to ::ffff:127.0.0.1 shows (gate round 1, M2).
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(TCP_HEAD, tcpListen(1506, 6379, "0000000000000000FFFF00000100007F"))), { uids: [1506] }, "::ffff:127.0.0.1 answers 127.0.0.1");
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(TCP_HEAD, tcpListen(1502, 6379, "00000000000000000000000001000000"))), { uids: [] }, "::1 does not answer 127.0.0.1");
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(tcpListen(1503, 6379, "0200A8C0"))), { uids: [] }, "another address does not");
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(tcpListen(1504, 6380))), { uids: [] }, "another port does not");
	assert.deepEqual(listenerUids("127.0.0.1", 6379, fs(tcpListen(1505).replace(" 0A ", " 01 "))), { uids: [] }, "an established connection is not a listener");
	// IPv6 (gate round 1, D1): ::1 is answered by a ::1 or a :: socket, never by an IPv4 one.
	const v6 = fs(tcpListen(1507, 6379), `${TCP_HEAD}   1: 00000000000000000000000001000000:18EB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1467        0 1 1 0 100 0 0 10 0\n   2: 00000000000000000000000000000000:18EB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1468        0 1 1 0 100 0 0 10 0\n`);
	assert.deepEqual(listenerUids("::1", 6379, v6).uids.sort(), [1467, 1468]);
	assert.deepEqual(listenerUids("0:0:0:0:0:0:0:1", 6379, v6).uids.sort(), [1467, 1468], "any spelling of ::1");
	assert.deepEqual(listenerUids("::ffff:127.0.0.1", 6379, v6).uids.sort(), [1468, 1507], "an IPv4-mapped address is the IPv4 one");
	assert.deepEqual(listenerUids("192.168.5.15", 6379, fs(tcpListen(1508, 6379, "0F05A8C0"))), { uids: [1508] }, "an interface address, byte order as the kernel prints it");
	assert.match(listenerUids("127.0.0.1", 6379, { readFileSync: () => { throw new Error("EACCES"); } }).error, /neither \/proc\/net\/tcp nor \/proc\/net\/tcp6/);
	assert.match(listenerUids("localhost", 6379, fs(TCP_HEAD)).error, /not an IP address/);
});

test("subordinateUids reads this account's ranges from /etc/subuid, by name or by uid, and no one else's", () => {
	const at = (text) => ({ readFileSync: () => text });
	assert.deepEqual(subordinateUids(at("op2:1235000000:65536\ntester:1234000000:65536\n1234:5000000:10\n"), { user: "tester", euid: 1234 }), [
		{ lo: 1234000000, hi: 1234065535 },
		{ lo: 5000000, hi: 5000009 },
	]);
	assert.deepEqual(subordinateUids(at("op2:1235000000:65536\n"), { user: "tester", euid: 1234 }), []);
	assert.deepEqual(subordinateUids({ readFileSync: () => { throw new Error("ENOENT"); } }, { user: "tester", euid: 1234 }), []);
});

const VENUES = { localUsed: false, podmanUsed: true };
const NAMES = { 0: "root", 501: "rob", 975: "valkey", 1234: "tester", 1235: "op2", 70000: "ldapuser" };
// A host whose 127.0.0.1:<port> is held by `uid` (null: nothing), with the harness's subuid and passwd files.
const decideAt = (uid, extra = {}) => decideValkey({ venues: VENUES, url: undefined, installed: false, probeTcp: async () => uid !== null, lookup: fakeLookup(), euid: 1234, user: "tester", fs: { readFileSync: (p) => hostFiles(uid)[p] }, ownerName: (u) => NAMES[u] ?? null, envPath: "/d/.env", ...extra });

test("decideValkey takes only this account's listener, its own uid or a subordinate uid of it, and refuses every other owner by name (#464)", async () => {
	const mine = await decideAt(1234);
	assert.deepEqual([mine.include, mine.refusal, mine.error], [false, null, undefined]);
	assert.equal(mine.notes[0], "something already listens on 127.0.0.1:6379, held by this account, so no Valkey is added for it: that listener is taken to be your Valkey, as `up` does");
	// `podman run --network host` publishes from a subordinate uid of the account (measured: 1467000998 for uid 1467).
	assert.match((await decideAt(1234000998)).notes[0], /held by this account's containers \(a subordinate uid of it, from \/etc\/subuid\)/);
	const other = await decideAt(1235);
	assert.equal(other.include, false);
	assert.equal(
		other.refusal.text,
		"127.0.0.1:6379 is held by op2 (uid 1235), not by this account (uid 1234) or its containers (subordinate uids read from /etc/subuid): taking it as this deployment's Valkey would put this account's jobs in a queue another account can read and drain. Give this account a Valkey of its own on another port, VALKEY_URL=redis://127.0.0.1:<port> in /d/.env (`service install` and `up` then publish the Quadlet Valkey there); or, if that Valkey is shared on purpose, say so with PI_VALKEY_SHARED=1 in /d/.env",
	);
	// Gate round 1: no login.defs range. Root (docker-proxy, a rootful container of any sudoer), a system service, an
	// LDAP account above UID_MAX, Lima's 501 below UID_MIN and another account's subordinate uid are all someone else.
	assert.match((await decideAt(0)).refusal.text, /^127\.0\.0\.1:6379 is held by root \(uid 0: docker-proxy, or a rootful container any account with sudo can start\), not by this account/);
	for (const [uid, who] of [[975, "valkey \\(uid 975\\)"], [70000, "ldapuser \\(uid 70000\\)"], [501, "rob \\(uid 501\\)"], [1235000998, "a container of op2 \\(its subordinate uid 1235000998\\)"], [1600, "uid 1600"]]) {
		const d = await decideAt(uid);
		assert.equal(d.include, false, String(uid));
		assert.match(d.refusal.text, new RegExp(`^127\\.0\\.0\\.1:6379 is held by ${who}, not by this account`), String(uid));
	}
	const nobody = await decideAt(null, { probeTcp: async () => true });
	assert.match(nobody.refusal.text, /^something answers 127\.0\.0\.1:6379, and which account holds it could not be told \(no listening socket for it is in \/proc\/net\/tcp or \/proc\/net\/tcp6\), so it is not taken to be this account's Valkey\. Give this account a Valkey of its own/);
	const free = await decideAt(1235, { probeTcp: async () => false });
	assert.deepEqual([free.include, free.refusal], [true, null], "nothing listening: ours is added");
	assert.deepEqual((await decideAt(1234, { installed: true })).include, true, "an installed Quadlet Valkey of this account is kept");
	assert.deepEqual((await decideAt(1235, { venues: { localUsed: true, podmanUsed: true } })).include, false, "docker's Valkey where local is blessed");
});

test("decideValkey: PI_VALKEY_SHARED=1 is the one way to take a Valkey another uid holds, and says whose it is (#464)", async () => {
	for (const uid of [0, 975, 1235]) {
		const d = await decideAt(uid, { shared: true });
		assert.deepEqual([d.include, d.refusal], [false, null], String(uid));
		assert.match(d.notes[0], new RegExp(`^something already listens on 127\\.0\\.0\\.1:6379, held by ${uid === 0 ? "root \\(uid 0" : `${NAMES[uid]} \\(uid ${uid}\\)`}.*, shared on purpose as PI_VALKEY_SHARED=1 in /d/\\.env says`));
	}
	// With our Quadlet Valkey installed too, the shared one is the queue: a Quadlet republished on its port would not bind.
	const overInstalled = await decideAt(1235, { shared: true, installed: true });
	assert.deepEqual([overInstalled.include, overInstalled.refusal], [false, null]);
	assert.match(overInstalled.notes[0], /held by op2 \(uid 1235\), shared on purpose/);
	const nobody = await decideAt(null, { probeTcp: async () => true, shared: true });
	assert.match(nobody.notes[0], /held by an owner \/proc does not name, shared on purpose/);
});

test("decideValkey judges every address VALKEY_URL's host resolves to: another account on ::1 is refused for a localhost URL (#464, gate round 1 D1)", async () => {
	// The measured bypass: A published on [::1]:16510 only, B's VALKEY_URL=redis://localhost:16510, and B's worker reached
	// A's Valkey because only 127.0.0.1 was looked at. The kernel's view: ::1 answers (A's socket), 127.0.0.1 does not.
	const probed = [];
	const files = { ...hostFiles(null), "/proc/net/tcp6": `${TCP_HEAD}   1: 00000000000000000000000001000000:407E 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1235        0 1 1 0 100 0 0 10 0\n` };
	const base = { url: "redis://localhost:16510", fs: { readFileSync: (p) => files[p] }, probeTcp: async (h, p) => (probed.push(`${h}:${p}`), h === "::1") };
	const d = await decideAt(null, base);
	assert.deepEqual(probed, ["::1:16510", "127.0.0.1:16510"], "both addresses the client may dial are probed");
	assert.equal(d.include, false);
	assert.match(d.refusal.text, /^\[::1\]:16510 is held by op2 \(uid 1235\), not by this account \(uid 1234\)/);
	assert.ok((await decideAt(null, { ...base, installed: true })).refusal, "refused even over an installed Quadlet Valkey: the client may reach ::1 first");
	// The same listener, reached through a quoted [::1] URL.
	assert.match((await decideAt(null, { ...base, url: "redis://[::1]:16510" })).refusal.text, /^\[::1\]:16510 is held by op2/);
	// Nothing on ::1, this account's Valkey on 127.0.0.1: taken.
	const own = await decideAt(1234, { url: "redis://localhost:6379", probeTcp: async (h) => h === "127.0.0.1" });
	assert.deepEqual([own.include, own.refusal], [false, null]);
	// Nothing anywhere: the Quadlet Valkey, which localhost reaches on 127.0.0.1; an [::1] URL would not reach it.
	assert.deepEqual((await decideAt(null, { url: "redis://localhost:6379", probeTcp: async () => false })).include, true);
	assert.match((await decideAt(null, { url: "redis://[::]:6380", probeTcp: async () => false })).error, /VALKEY_URL's host is ::, which reaches ::1, not 127\.0\.0\.1/);
	assert.match((await decideAt(null, { url: "redis://v6.lan:6380", lookup: fakeLookup({ "v6.lan": [{ address: "::1", family: 6 }] }), probeTcp: async () => false })).error, /VALKEY_URL's host resolves to ::1 here, not 127\.0\.0\.1/);
	const v6only = await decideAt(null, { url: "redis://[::1]:6380", probeTcp: async () => false });
	assert.equal(v6only.include, false);
	assert.equal(v6only.error, "/d/.env: VALKEY_URL's host is ::1, not 127.0.0.1, and the Quadlet Valkey is published on 127.0.0.1 only, so the worker would not reach it. Write VALKEY_URL=redis://127.0.0.1:6380", "gate round 2: no \"is ::1 here\", and no localhost advice, which reaches ::1 first on Fedora");
});

test("judgeValkeyListeners: a name that resolves to this host's own interface address is judged, one that resolves elsewhere is another host, and one that does not resolve cannot be judged (#464)", async () => {
	const lan = `${TCP_HEAD}   3: 00000000:18EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1235        0 1 1 0 100 0 0 10 0\n`;
	const common = { probeTcp: async () => true, euid: 1234, user: "tester", fs: { readFileSync: (p) => ({ ...hostFiles(null), "/proc/net/tcp": lan })[p] }, ownerName: (u) => NAMES[u] ?? null };
	const here = await judgeValkeyListeners({ ...common, url: "redis://myhost:6379", lookup: fakeLookup({ myhost: [{ address: "192.168.5.15", family: 4 }] }), interfaces: () => ({ eth0: [{ address: "192.168.5.15", family: "IPv4" }] }) });
	assert.match(here.refusal.text, /^192\.168\.5\.15:6379 is held by op2 \(uid 1235\)/, "a 0.0.0.0 listener answers this host's own address too");
	const there = await judgeValkeyListeners({ ...common, url: "redis://queue.lan:6379", lookup: fakeLookup({ "queue.lan": [{ address: "10.0.0.5", family: 4 }] }), interfaces: () => ({ eth0: [{ address: "192.168.5.15", family: "IPv4" }] }) });
	assert.deepEqual(there, { remote: "queue.lan" });
	// Gate round 3, item 4: a name that does not resolve is not known to be another host; it is judged when it resolves.
	assert.deepEqual(await judgeValkeyListeners({ ...common, url: "redis://gone.lan:6379", lookup: fakeLookup({}) }), { unresolved: "gone.lan", why: "ENOTFOUND" });
	assert.deepEqual(await judgeValkeyListeners({ ...common, url: "redis://none.lan:6379", lookup: async () => [] }), { unresolved: "none.lan", why: "no address" });
	const gone = await decideAt(1235, { url: "redis://gone.lan:6379", lookup: fakeLookup({}) });
	assert.equal(gone.include, false);
	assert.match(gone.error, /^VALKEY_URL's host gone\.lan did not resolve here \(ENOTFOUND\), so whose Valkey it reaches cannot be judged\. Retry when it resolves, or write the address/);
	const remote = await decideAt(1235, { url: "redis://queue.lan:6379", lookup: fakeLookup({ "queue.lan": [{ address: "10.0.0.5", family: 4 }] }) });
	assert.deepEqual([remote.include, remote.refusal], [false, null]);
	assert.equal(remote.notes[0], "VALKEY_URL names queue.lan, not this host, so no Valkey is added here");
});

test("service install on podman: a Valkey that is not this account's is refused before anything is written, --force does not take it, and PI_VALKEY_SHARED=1 does (#464)", async () => {
	const files = { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` };
	const refusal = /127\.0\.0\.1:6379 is held by op2 \(uid 1235\), not by this account \(uid 1234\) or its containers \(subordinate uids read from \/etc\/subuid\): taking it as this deployment's Valkey would put this account's jobs in a queue another account can read and drain\. Give this account a Valkey of its own on another port, VALKEY_URL=redis:\/\/127\.0\.0\.1:<port> in \/srv\/pi-deploy\/\.env \(`service install` and `up` then publish the Quadlet Valkey there\); or, if that Valkey is shared on purpose, say so with PI_VALKEY_SHARED=1 in \/srv\/pi-deploy\/\.env/;
	for (const argv of [["install"], ["install", "--force"]]) {
		const h = svc({ argv, listening: true, listenerUid: 1235, files });
		assert.equal(await h.run(), 1, argv.join(" "));
		assert.match(h.errText(), refusal);
		assert.deepEqual(h.writes, [], `${argv.join(" ")}: nothing written`);
		assert.ok(!h.calls.some((c) => c[0] === "systemctl" && c[2] !== "show-environment"));
	}
	const unknown = svc({ listening: true, host: { ...hostFiles(null), "/proc/net/tcp": new Error("EACCES"), "/proc/net/tcp6": new Error("EACCES") }, files });
	assert.equal(await unknown.run(), 1);
	assert.match(unknown.errText(), /which account holds it could not be told \(neither \/proc\/net\/tcp nor \/proc\/net\/tcp6 could be read\)/);
	// A system service's Valkey (a distribution package) and root's (docker-proxy) are refused too, until opted in.
	for (const uid of [975, 0]) {
		const refused = svc({ listening: true, listenerUid: uid, files });
		assert.equal(await refused.run(), 1, String(uid));
		const shared = svc({ listening: true, listenerUid: uid, files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nPI_VALKEY_SHARED=1\n` } });
		assert.equal(await shared.run(), 0, shared.errText());
		assert.match(shared.text(), /held by .*, shared on purpose as PI_VALKEY_SHARED=1 in \/srv\/pi-deploy\/\.env says, so no Valkey is added for it/);
		assert.ok(!shared.store.has(join(QDIR, QUADLET_FILES.valkey.file)));
	}
	const off = svc({ listening: true, listenerUid: 975, files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nPI_VALKEY_SHARED=yes\n` } });
	assert.equal(await off.run(), 1, "only 1 opts in");
	const render = svc({ argv: ["render"], listening: true, listenerUid: 1235, files });
	assert.equal(await render.run(), 0);
	assert.match(render.text(), /# note: install refuses this: 127\.0\.0\.1:6379 is held by op2/);
});

test("service install on podman: VALKEY_URL's loopback port is where the Quadlet Valkey is published and what is probed; another host adds none (#464)", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://127.0.0.1:6380\n` } });
	assert.equal(await h.run(), 0, h.errText());
	assert.deepEqual(h.probed, ["127.0.0.1:6380"]);
	const unit = h.store.get(join(QDIR, QUADLET_FILES.valkey.file));
	assert.match(unit, /^PublishPort=127\.0\.0\.1:6380:6379$/m);
	assert.doesNotMatch(unit, /127\.0\.0\.1:6379:6379/);
	const plain = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` } });
	assert.equal(await plain.run(), 0);
	assert.equal(plain.store.get(join(QDIR, QUADLET_FILES.valkey.file)), template(QUADLET_FILES.valkey.file), "the default port renders the template unchanged");
	const local = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://localhost:6381\n` } });
	assert.equal(await local.run(), 0, local.errText());
	assert.deepEqual(local.probed, ["::1:6381", "127.0.0.1:6381"], "localhost: every address the client may dial");
	assert.match(local.store.get(join(QDIR, QUADLET_FILES.valkey.file)), /^PublishPort=127\.0\.0\.1:6381:6379$/m);
	const remote = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://queue.lan:6379\n` } });
	assert.equal(await remote.run(), 0);
	assert.deepEqual(remote.probed, [], "a remote queue is not probed here");
	assert.ok(!remote.store.has(join(QDIR, QUADLET_FILES.valkey.file)));
	assert.match(remote.text(), /VALKEY_URL names queue\.lan, not this host, so no Valkey is added here/);
	const dollar = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://127.0.0.1:$PORT\n` } });
	assert.equal(await dollar.run(), 1);
	assert.match(dollar.errText(), /line 3 assigns VALKEY_URL in a form this command cannot read the way the service's loader will \(a \$, which the loaders expand differently/);
	assert.deepEqual(dollar.writes, []);
});

test("service install on podman: an [::1] VALKEY_URL is refused for its brackets unquoted, read when quoted, and judged on ::1 (#464)", async () => {
	const bare = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://[::1]:16510\n` } });
	assert.equal(await bare.run(), 1);
	assert.match(bare.errText(), /assigns VALKEY_URL in a form this command cannot read the way the service's loader will \(an unquoted \[ or \]: the macOS wrapper sources the file with sh, which may read it as a filename pattern\. Quote the value, for example VALKEY_URL="redis:\/\/\[::1\]:6379"/);
	assert.doesNotMatch(bare.errText(), /spaces or a backslash/, "the true cause, not a list of others");
	const tcp6 = `${TCP_HEAD}   1: 00000000000000000000000001000000:407E 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1235        0 1 1 0 100 0 0 10 0\n`;
	const quoted = svc({ listening: (h) => h === "::1", host: { ...hostFiles(null), "/proc/net/tcp6": tcp6 }, files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL="redis://[::1]:16510"\n` } });
	assert.equal(await quoted.run(), 1);
	assert.deepEqual(quoted.probed, ["::1:16510"]);
	assert.match(quoted.errText(), /\[::1\]:16510 is held by op2 \(uid 1235\)/);
	assert.deepEqual(quoted.writes, []);
});

test("readValkeyKeys reads VALKEY_URL and PI_VALKEY_SHARED as the loader does, and names what makes a line unreadable (#464)", () => {
	assert.deepEqual(readValkeyKeys("VALKEY_URL=redis://127.0.0.1:6380\nPI_VALKEY_SHARED=1\n"), { keys: { VALKEY_URL: "redis://127.0.0.1:6380", PI_VALKEY_SHARED: "1" } });
	assert.deepEqual(readValkeyKeys('VALKEY_URL="redis://[::1]:6379"\n'), { keys: { VALKEY_URL: "redis://[::1]:6379" } });
	assert.deepEqual(readValkeyKeys("# VALKEY_URL=redis://x\n"), { keys: {} });
	assert.match(readValkeyKeys("VALKEY_URL=redis://[::1]:6379\n", { path: "/d/.env" }).error, /^\/d\/\.env line 1 assigns VALKEY_URL .*\(an unquoted \[ or \]/);
	assert.match(unplainCause("redis://a b"), /a space in the value/);
	assert.match(unplainCause("redis://a\\b"), /a backslash/);
	assert.match(unplainCause('"redis://$X"'), /a \$/);
	assert.equal(unplainCause("redis://a;b"), "a character (`;`) outside A-Z, a-z, 0-9 and _@+=:,./- in an unquoted value. Quote the whole value");
});

test("unplainCause names the character that is refused, and not an = the reader now takes (#477)", () => {
	// The gate's case: `?x=y` blamed a character set without `=`, as if the `=` were the problem.
	assert.match(unplainCause("redis://127.0.0.1:6379/0?x=y"), /^a character \(`\?`\) outside A-Z, a-z, 0-9 and _@\+=:,\.\/- /);
	assert.match(unplainCause("a#b"), /\(`#`\)/);
	assert.match(unplainCause("x=y?z"), /^a character \(`\?`\) /, "an interior = is not the character refused");
	assert.match(unplainCause("caf\u00e9"), /\(U\+00E9\)/);
	// A control or invisible character is refused quoted too (gate round 2), so the advice is to remove it, not to quote.
	for (const v of ["a\u200bb", "'a\u200bb'", '"a\u200bb"']) assert.equal(unplainCause(v), "a control or invisible character (U+200B), which doctor does not show back, quoted or not. Remove it", JSON.stringify(v));
	assert.match(unplainCause("x\u001by"), /^a control or invisible character \(U\+001B\).* Remove it$/);
	// The two `=` shapes the reader still refuses have their own cause.
	assert.equal(unplainCause("=ls"), "an = at the start of an unquoted value, which zsh expands as a command name. Quote the whole value");
	assert.equal(unplainCause("a:=b"), "a := in an unquoted value, which zsh expands as a command name. Quote the whole value");
	// And through the reader, end to end: an interior = reads, a leading one is refused with its cause.
	assert.deepEqual(readValkeyKeys("VALKEY_URL=redis://h:6379/0\nPI_VALKEY_SHARED=a=b\n"), { keys: { VALKEY_URL: "redis://h:6379/0", PI_VALKEY_SHARED: "a=b" } });
	assert.match(readValkeyKeys("PI_VALKEY_SHARED==1\n", { path: "/d/.env" }).error, /line 1 assigns PI_VALKEY_SHARED .*\(an = at the start of an unquoted value/);
	assert.match(readValkeyKeys("VALKEY_URL=redis://h:6379/0?x=y\n", { path: "/d/.env" }).error, /\(a character \(`\?`\) outside/);
});

// Gate round 2: the owner rule moved to where the connection is made, with the address pinned.
const row4 = (addr, port, uid) => `   3: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const row6 = (addr, port, uid) => `   1: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const judgeOn = (files, extra = {}) =>
	judgeValkeyListeners({ url: "redis://127.0.0.1:16483", probeTcp: async () => true, lookup: fakeLookup(), fs: { readFileSync: (p) => ({ "/proc/net/tcp": TCP_HEAD, "/proc/net/tcp6": TCP_HEAD, "/etc/subuid": "op2:1235000000:65536\ntester:1234000000:65536\n", ...files })[p] }, euid: 1234, user: "tester", ownerName: (u) => NAMES[u] ?? null, envPath: "/d/.env", ...extra });

test("reachedAddress: an unspecified address is this host's loopback of its family, an IPv4-mapped one its IPv4 form (#464, gate round 2)", () => {
	assert.equal(reachedAddress("0.0.0.0"), "127.0.0.1");
	assert.equal(reachedAddress("0.1.2.3"), "127.0.0.1", "0.0.0.0/8");
	assert.equal(reachedAddress("::"), "::1");
	assert.equal(reachedAddress("::ffff:0.0.0.0"), "127.0.0.1");
	assert.equal(reachedAddress("::ffff:127.0.0.1"), "127.0.0.1");
	assert.equal(reachedAddress("127.0.0.2"), "127.0.0.2");
	assert.equal(reachedAddress("::1"), "::1");
});

test("judgeValkeyListeners: 0.0.0.0, :: and 127.0.0.0/8 URLs are this host's and judged at the address a connect reaches (#464, gate round 2 defect 1)", async () => {
	// Measured on Fedora 44: redis://0.0.0.0:16483 was "not this host", unjudged, and the client reached another
	// account's 127.0.0.1:16483.
	const theirs = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` };
	for (const url of ["redis://0.0.0.0:16483", "redis://0.1.2.3:16483", "redis://[::ffff:0.0.0.0]:16483"]) {
		const v = await judgeOn(theirs, { url });
		assert.match(v.refusal?.text ?? "", /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\)/, url);
	}
	const v6 = await judgeOn({ "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1235)}` }, { url: "redis://[::]:16483" });
	assert.match(v6.refusal.text, /^\[::1\]:16483 is held by op2/);
	// 127.0.0.0/8 is loopback: 127.0.0.2 is judged here, never "another host" (gate round 2, test gap).
	const other127 = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0200007F", 16483, 1235)}` }, { url: "redis://127.0.0.2:16483" });
	assert.match(other127.refusal.text, /^127\.0\.0\.2:16483 is held by op2/);
	const mine = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1234)}` }, { url: "redis://0.0.0.0:16483" });
	assert.deepEqual([mine.chosen, mine.refusal], ["127.0.0.1", null], "pinned to what 0.0.0.0 reaches");
});

test("judgeValkeyListeners chooses this account's listener first and pins it; another account's on another address of the name is reported, never dialled (#464, gate round 2 defect 2)", async () => {
	// The localhost squat after install (measured on Fedora 44): this account's Quadlet Valkey on 127.0.0.1, another
	// account later publishing [::1] on the same port; localhost resolves ::1 first.
	const files = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1234)}`, "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1235)}` };
	const v = await judgeOn(files, { url: "redis://localhost:16483" });
	assert.equal(v.chosen, "127.0.0.1");
	assert.equal(v.refusal, null);
	assert.deepEqual(v.elsewhere, ["[::1]:16483 (held by op2 (uid 1235))"]);
	assert.deepEqual(v.answered.map((a) => [a.address, a.own]), [["::1", false], ["127.0.0.1", true]], "in the order the client tries them");
	const d = await decideValkey({ venues: VENUES, url: "redis://localhost:16483", installed: true, probeTcp: async () => true, lookup: fakeLookup(), euid: 1234, user: "tester", fs: { readFileSync: (p) => ({ ...hostFiles(null), ...files })[p] }, ownerName: (u) => NAMES[u] ?? null, envPath: "/d/.env" });
	assert.equal(d.include, true, "our installed Quadlet Valkey is kept");
	assert.match(d.notes.join("\n"), /another account also listens on an address VALKEY_URL's host resolves to: \[::1\]:16483 \(held by op2 \(uid 1235\)\)\. The worker connects only to the address judged this account's/);
	// With nothing of this account's answering, the refusal names ONLY the addresses a foreign uid holds (gate round 2).
	const mixed = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}`, "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1236)}` }, { url: "redis://localhost:16483" });
	assert.match(mixed.refusal.text, /^\[::1\]:16483 and 127\.0\.0\.1:16483 are held by uid 1236 and op2 \(uid 1235\), not by/, "two addresses are held (gate round 3)");
	// An address no socket row explains beside one another account holds: only the foreign-held one is said to be held.
	const unknownAndForeign = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { url: "redis://localhost:16483" });
	assert.match(unknownAndForeign.refusal.text, /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\), not by/, "::1 answered with no row: not named as op2's");
	const oneForeign = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { url: "redis://localhost:16483", probeTcp: async (h) => h === "127.0.0.1" });
	assert.match(oneForeign.refusal.text, /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\), not by/, "::1 did not answer, so it is not named");
});

test("judgeValkeyListeners bounds the name lookup: a resolver that does not answer is a name that cannot be judged yet, never another host (#464, gate rounds 2 and 3)", async () => {
	const v = await judgeOn({}, { url: "redis://slow.lan:6379", lookup: () => new Promise(() => {}), lookupTimeoutMs: 20 });
	assert.deepEqual(v, { unresolved: "slow.lan", why: "ETIMEOUT" });
});

test("readSubuidRanges: getsubids(1) where it answers (SSSD ranges included), else /etc/subuid, and says which (#464, gate round 2)", async () => {
	const fs = { readFileSync: () => "tester:1234000000:65536\n" };
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: (cmd, args) => (cmd === "getsubids" && args[0] === "tester" ? "0: tester 5000000 100\n1: tester 7000000 10\n" : null) }), { ranges: [{ lo: 5000000, hi: 5000099 }, { lo: 7000000, hi: 7000009 }], source: "getsubids" });
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: () => null }), { ranges: [{ lo: 1234000000, hi: 1234065535 }], source: "/etc/subuid" });
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: () => "garbage\n" }).source, "/etc/subuid", "an answer with no range is not an answer");
	// The source is what the refusal says, and an SSSD range makes a --network host container's uid this account's.
	const v = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 5000042)}` }, { subuids: { ranges: [{ lo: 5000000, hi: 5000099 }], source: "getsubids" } });
	assert.deepEqual([v.chosen, v.heldBy], ["127.0.0.1", "this account's containers (a subordinate uid of it, from getsubids)"]);
	const refused = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { subuids: { ranges: [], source: "getsubids" } });
	assert.match(refused.refusal.text, /or its containers \(subordinate uids read from getsubids\)/);
});

test("pinnedValkeyUrl puts the judged literal in place of the host and keeps the name for TLS (#464, gate round 2)", () => {
	assert.deepEqual(pinnedValkeyUrl("redis://localhost:16483", "127.0.0.1"), { url: "redis://127.0.0.1:16483", servername: null });
	assert.deepEqual(pinnedValkeyUrl("redis://:pw@localhost:16483/2", "::1"), { url: "redis://:pw@[::1]:16483/2", servername: null });
	assert.deepEqual(pinnedValkeyUrl("rediss://valkey.lan:6380", "192.168.5.15"), { url: "rediss://192.168.5.15:6380", servername: "valkey.lan" });
	assert.deepEqual(pinnedValkeyUrl("rediss://127.0.0.1:6380", "127.0.0.1"), { url: "rediss://127.0.0.1:6380", servername: null }, "a literal has no name to check");
});

test("resolveWorkerValkey: the worker's boot judgement, pinned, refused as a configError, and PI_VALKEY_SHARED from .env only (#464, gate round 2)", async () => {
	const refuse = (m) => Object.assign(new Error(m), { piDispatchConfig: true });
	const files = (uid) => ({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, uid)}`, "/proc/net/tcp6": TCP_HEAD, "/etc/subuid": "" });
	const at = (uid, extra = {}) =>
		resolveWorkerValkey({ url: "redis://localhost:16483", venues: VENUES, platform: "linux", env: {}, envText: "", envPath: "/d/.env", probeTcp: async (h) => h === "127.0.0.1", lookup: fakeLookup(), fs: { readFileSync: (p) => files(uid)[p] }, euid: 1234, user: "tester", ownerName: (u) => NAMES[u] ?? null, interfaces: () => ({}), subuids: { ranges: [], source: "/etc/subuid" }, configError: refuse, waitMs: 0, sleep: async () => {}, ...extra });
	const mine = await at(1234);
	assert.deepEqual([mine.url, mine.servername, mine.pinned], ["redis://127.0.0.1:16483", null, { address: "127.0.0.1", port: 16483, heldBy: "this account" }]);
	await assert.rejects(at(1235), (err) => err.piDispatchConfig === true && /^the Valkey VALKEY_URL reaches is refused: 127\.0\.0\.1:16483 is held by op2 \(uid 1235\)/.test(err.message));
	// Shared on purpose: from .env, and only from .env.
	const shared = await at(1235, { envText: "PI_VALKEY_SHARED=1\n" });
	assert.equal(shared.url, "redis://127.0.0.1:16483");
	await assert.rejects(at(1235, { env: { PI_VALKEY_SHARED: "1" } }), (err) => err.piDispatchConfig === true, "an environment opt-in is not the file's");
	const noted = await at(1234, { env: { PI_VALKEY_SHARED: "1" } });
	assert.match(noted.notes[0], /^PI_VALKEY_SHARED is set in the worker's environment and not in \/d\/\.env: ignored/);
	// Gate round 3's simpler rule: another account's listener is refused on EVERY venue, docker's included; root's
	// (docker-proxy) only where the podman venue is the deployment's without local, which rootRefused carries on.
	const docker = { venues: { localUsed: true, podmanUsed: true } };
	await assert.rejects(at(1235, docker), (err) => err.piDispatchConfig === true && /held by op2 \(uid 1235\)/.test(err.message), "another account's Valkey on the local venue");
	const proxy = await at(0, docker);
	assert.deepEqual([proxy.url, proxy.rootRefused, proxy.pinned?.heldBy], ["redis://127.0.0.1:16483", false, "root"], "docker-proxy on the local venue");
	await assert.rejects(at(0), (err) => err.piDispatchConfig === true && /held by root/.test(err.message), "root on the podman venue");
	assert.equal(mine.rootRefused, true);
	// Not judged off Linux (no /proc), nor another host.
	for (const extra of [{ platform: "darwin" }, { url: "redis://queue.lan:6379", lookup: fakeLookup({ "queue.lan": [{ address: "10.0.0.5", family: 4 }] }) }]) {
		const same = await at(1235, extra);
		assert.equal(same.pinned, null, JSON.stringify(extra));
		assert.equal(same.url, extra.url ?? "redis://localhost:16483");
	}
	// Gate round 3, item 5: the .env's bytes go through the hardened reader; a hazard is named and the worker does not start.
	await assert.rejects(at(1234, { envText: Buffer.from("PI_VALKEY_SHARED=1\rVALKEY_URL=redis://x\n") }), (err) => err.piDispatchConfig === true && /^\/d\/\.env line 1 .*carriage return.*The worker reads PI_VALKEY_SHARED and VALKEY_URL from it, so it does not start$/s.test(err.message));
	await assert.rejects(at(1234, { envText: Buffer.from([0x50, 0x3d, 0xff, 0x0a]) }), (err) => err.piDispatchConfig === true && /UTF-8/.test(err.message));
	// A name that does not resolve: waited for, then a plain error (exit 1, restarted), never dialled unjudged.
	let dnsClock = 0;
	await assert.rejects(at(1234, { url: "redis://gone.lan:16483", waitMs: 1000, now: () => dnsClock, sleep: async (ms) => { dnsClock += ms; } }), (err) => !err.piDispatchConfig && /^VALKEY_URL's host gone\.lan did not resolve here \(ENOTFOUND\), so whose Valkey it reaches cannot be judged; the service manager retries/.test(err.message));
	// Nothing answering: waited for, then a plain error (exit 1, restarted), since no owner can be judged yet.
	let clock = 0;
	await assert.rejects(at(1234, { probeTcp: async () => false, waitMs: 2000, now: () => clock, sleep: async (ms) => { clock += ms; } }), (err) => !err.piDispatchConfig && /^nothing answers VALKEY_URL \(\[::1\]:16483, 127\.0\.0\.1:16483\)/.test(err.message));
	let answersAt = 1000;
	clock = 0;
	const late = await at(1234, { probeTcp: async (h) => h === "127.0.0.1" && clock >= answersAt, waitMs: 5000, now: () => clock, sleep: async (ms) => { clock += ms; } });
	assert.equal(late.url, "redis://127.0.0.1:16483", "a Valkey still starting is waited for");
	await assert.rejects(at(1234, { url: "http://x" }), (err) => err.piDispatchConfig === true);
});

// Gate round 3, item 5: `up` read the .env's VALKEY_URL and PI_VALKEY_SHARED from decoded text, past what systemd refuses.
test("deploymentValkeyEnv reads the .env as bytes through the hardened reader, and stops on what systemd refuses (#464, gate round 3)", async () => {
	const { deploymentValkeyEnv } = await import("../src/deployment-venue.mjs");
	const fsOf = (bytes) => ({ existsSync: () => true, readFileSync: (_p, enc) => (enc ? bytes.toString(enc) : bytes) });
	const bad = Buffer.concat([Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\nPI_VALKEY_SHARED="), Buffer.from([0xff]), Buffer.from("1\n")]);
	const refused = deploymentValkeyEnv({ env: {}, fs: fsOf(bad), envPath: "/d/.env", platform: "linux" });
	assert.match(String(refused.error), /^\/d\/\.env line 2 has .*UTF-8.*\. up judges the Valkey the service will use, so it stops here$/s);
	const ok = deploymentValkeyEnv({ env: {}, fs: fsOf(Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\n")), envPath: "/d/.env", platform: "linux" });
	assert.equal(ok.env.VALKEY_URL, "redis://127.0.0.1:6380");
});

test("service install on podman: a PI_VALKEY_SHARED in this shell is ignored and named; only the .env's opts in (#464, gate round 2)", async () => {
	const files = { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` };
	const h = svc({ listening: true, listenerUid: 1235, files, env: { XDG_RUNTIME_DIR: "/run/user/1234", PI_VALKEY_SHARED: "1" }, argv: ["render"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /# note: install refuses this: 127\.0\.0\.1:6379 is held by op2/);
	const install = svc({ listening: true, listenerUid: 1235, files, env: { XDG_RUNTIME_DIR: "/run/user/1234", PI_VALKEY_SHARED: "1" } });
	assert.equal(await install.run(), 1);
	const ok = svc({ listening: true, listenerUid: 1234, files, env: { XDG_RUNTIME_DIR: "/run/user/1234", PI_VALKEY_SHARED: "1" } });
	assert.equal(await ok.run(), 0);
	assert.match(ok.text(), /note: PI_VALKEY_SHARED is "1" in this shell: ignored, since only \/srv\/pi-deploy\/\.env may say a Valkey is shared on purpose/);
});

// Issue #464: a failed install leaves no half of itself behind, or says exactly which files remain.
test("service install on podman: a write that fails puts back every file this run wrote, before any command runs (#464)", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` } });
	h.failWrites.set(USER_UNIT, Object.assign(new Error("EACCES: permission denied, open '/home/tester/.config/systemd/user/pi-dispatch-worker.service'"), { code: "EACCES" }));
	assert.equal(await h.run(), 1);
	const valkey = join(QDIR, QUADLET_FILES.valkey.file);
	const network = join(QDIR, QUADLET_FILES.valkeyNetwork.file);
	// Issue #468: the password this install generated into .env and the Valkey's password file are this run's too, and
	// put back with the rest (.env to the bytes it had, the password file removed).
	assert.equal(h.errText(), `error: write ${USER_UNIT} failed (EACCES: permission denied, open '${USER_UNIT}'), so nothing was installed: rolled back what this run wrote (removed ${valkey}, ${VALKEY_ENV}, ${network}; put back the earlier ${ENV_PATH}); no file of this run remains. Fix it, then re-run this install\n`, "the refused unit write changed nothing, so only the stack's files and .env are named");
	for (const p of [valkey, network, VALKEY_ENV, USER_UNIT]) assert.ok(!h.store.has(p), `${p} is gone`);
	assert.equal(h.store.get(ENV_PATH), `${PODMAN_ENV}PI_EGRESS=0\n`, ".env has no password line left from the failed run");
	assert.deepEqual(h.calls.filter((c) => c[0] === "systemctl" && c[2] !== "show-environment"), [], "nothing was started or reloaded");
});

test("service install --force on podman: a failed write puts back the files it replaced, byte for byte, and names what it could not put back (#464)", async () => {
	const valkey = join(QDIR, QUADLET_FILES.valkey.file);
	const network = join(QDIR, QUADLET_FILES.valkeyNetwork.file);
	const files = { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n`, [valkey]: "# an operator's edit\n", [USER_UNIT]: "old unit\n" };
	const h = svc({ argv: ["install", "--force"], files });
	h.failWrites.set(USER_UNIT, new Error("EROFS: read-only file system"));
	h.failUnlinks.set(network, new Error("EBUSY: resource busy"));
	assert.equal(await h.run(), 1);
	assert.equal(h.store.get(valkey), "# an operator's edit\n", "the replaced file has its old bytes back");
	assert.equal(h.store.get(USER_UNIT), "old unit\n");
	assert.ok(h.store.has(network), "the one that could not be removed is still there");
	assert.match(h.errText(), new RegExp(`\\(removed ${VALKEY_ENV.replaceAll(".", "\\.")}; put back the earlier ${valkey.replaceAll(".", "\\.")}, ${ENV_PATH.replaceAll(".", "\\.")}\\); these could NOT be put back and remain as this run wrote them: ${network.replaceAll(".", "\\.")} \\(EBUSY: resource busy\\)\\. Fix it`), "the refused write changed nothing, so it is not reported as left");
	// Issue #468: an installed Valkey getting a new password asks which clients run (read-only), and nothing else ran.
	assert.deepEqual(h.calls.filter((c) => c[0] === "systemctl" && c[2] !== "show-environment" && c[2] !== "is-active"), []);
});

test("service install on podman: a stack command that fails puts back only the worker unit and names the stack files that remain (#464)", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` }, plan: { "systemctl --user start": 1 } });
	assert.equal(await h.run(), 1);
	const valkey = join(QDIR, QUADLET_FILES.valkey.file);
	const network = join(QDIR, QUADLET_FILES.valkeyNetwork.file);
	assert.ok(!h.store.has(USER_UNIT), "the worker unit is not left behind");
	assert.ok(h.store.has(valkey) && h.store.has(network), "the stack's files stay: its units run from them");
	// Issue #468: .env keeps the password this run generated, and the password file stays with the unit that reads it.
	assert.match(h.errText(), new RegExp(`The stack files this run wrote remain, since its units run from them: ${ENV_PATH.replaceAll(".", "\\.")}, ${network.replaceAll(".", "\\.")}, ${VALKEY_ENV.replaceAll(".", "\\.")}, ${valkey.replaceAll(".", "\\.")}\\.`));
	assert.equal(h.calls.filter((c) => c.join(" ") === "systemctl --user daemon-reload").length, 2, "one reload before the start, one after the unit was put back");
	// Gate round 1: the rollback here is of the worker unit only, so it never claims that no file of this run remains.
	assert.doesNotMatch(h.errText(), /no file of this run remains/);
	assert.match(h.errText(), new RegExp(`\\(rolled back what this run wrote \\(removed ${USER_UNIT.replaceAll(".", "\\.")}\\)\\)\\. The stack files`));
	assert.match(h.errText(), /`pi-dispatch service uninstall` removes them if you will not retry/);
});

// Gate round 1 (case 5): a failed install or `up` whose daemon-reload never ran leaves Quadlet files whose units the
// manager never loaded, and `systemctl --user stop` of those exits 5 ("not loaded"), which made uninstall refuse to
// remove the very files that run left.
test("service uninstall removes Quadlet files whose units were never loaded, and still refuses while one runs (#464)", async () => {
	const files = {};
	for (const q of [QUADLET_FILES.valkey, QUADLET_FILES.valkeyNetwork]) files[join(QDIR, q.file)] = "q";
	const notLoaded = { code: 0, output: "LoadState=not-found\nActiveState=inactive\n" };
	const h = svc({ argv: ["uninstall"], files, plan: { "systemctl --user stop": 5, "systemctl --user show": notLoaded } });
	assert.equal(await h.run(), 0, h.errText());
	for (const f of Object.keys(files)) assert.ok(!h.store.has(f), `${f} removed`);
	assert.match(h.text(), /note: systemctl --user stop exited 5, and none of pi-dispatch-valkey\.service, pi-dispatch-valkey-network\.service is running \(not loaded, or already stopped\), so their files are removed/);
	assert.match(h.text(), /removed the podman venue's Quadlet units/);
	assert.deepEqual(h.calls.filter((c) => c[2] === "show").map((c) => c.slice(3)), [["--property=LoadState,ActiveState", "pi-dispatch-valkey.service"], ["--property=LoadState,ActiveState", "pi-dispatch-valkey-network.service"]]);
	// Loaded and failed is stopped as far as it goes too.
	const failed = svc({ argv: ["uninstall"], files, plan: { "systemctl --user stop": 1, "systemctl --user show": { code: 0, output: "LoadState=loaded\nActiveState=failed\n" } } });
	assert.equal(await failed.run(), 0, failed.errText());
	// One still active, or one the manager would not answer about: nothing removed, as before.
	for (const show of [{ code: 0, output: "LoadState=loaded\nActiveState=active\n" }, { code: 1, output: "" }]) {
		const running = svc({ argv: ["uninstall"], files, plan: { "systemctl --user stop": 5, "systemctl --user show": show } });
		assert.equal(await running.run(), 1);
		assert.match(running.errText(), /systemctl --user stop .* failed \(exit 5\), so nothing was removed/);
		for (const f of Object.keys(files)) assert.ok(running.store.has(f), `${f} kept`);
	}
});

test("service install without podman: a unit write that fails is said, not thrown, and leaves nothing (#464)", async () => {
	const h = svc({ files: {} });
	h.failWrites.set(USER_UNIT, new Error("EACCES: permission denied"));
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /^error: write \/home\/tester\/\.config\/systemd\/user\/pi-dispatch-worker\.service failed \(EACCES: permission denied\), so nothing was installed: this run had written nothing; no file of this run remains/);
	assert.deepEqual(h.calls.filter((c) => c[0] === "systemctl" && c[2] !== "show-environment"), []);
	assert.ok(!h.store.has(USER_UNIT));
});

test("service install: an enable that fails after every write names the files this run wrote, which remain (#464)", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` }, plan: { "systemctl --user enable": 1 } });
	assert.equal(await h.run(), 1);
	const valkey = join(QDIR, QUADLET_FILES.valkey.file);
	const network = join(QDIR, QUADLET_FILES.valkeyNetwork.file);
	assert.ok(h.errText().endsWith(`(files this run wrote, which remain: ${ENV_PATH}, ${network}, ${VALKEY_ENV}, ${valkey}, ${USER_UNIT})\n`), h.errText());
});

test("rollBackWrites: the FIRST record of a path is what is put back, and describeRollBack says what remains", () => {
	const store = new Map([["/a", "old-a"]]);
	const fs = { writeFileSync: (p, d) => store.set(p, d), unlinkSync: (p) => { if (!store.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } };
	const journal = [{ path: "/a", existed: true, previous: "old-a" }, { path: "/b", existed: false, previous: null }, { path: "/a", existed: true, previous: "run-a" }];
	store.set("/a", "run-a2");
	store.set("/b", "run-b");
	const rolled = rollBackWrites(fs, journal);
	assert.deepEqual([store.get("/a"), store.has("/b")], ["old-a", false]);
	assert.deepEqual(rolled, { restored: ["/a"], removed: ["/b"], left: [] });
	assert.deepEqual(rollBackWrites(fs, [{ path: "/gone", existed: false, previous: null }]), { restored: [], removed: ["/gone"], left: [] }, "an absent new file counts as removed");
	assert.equal(describeRollBack({ restored: [], removed: [], left: [] }), "this run had written nothing; no file of this run remains");
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
	// Issue #468: a deployment that already has its password, and a password file that already holds it, so only the
	// proxy's file differs.
	const planned = planStack({ components: { valkey: true, proxy: true, keeper: true, valkeyPassword: TEST_PASSWORD }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const files = { [ENV_PATH]: `${PODMAN_ENV}VALKEY_PASSWORD=${TEST_PASSWORD}\n`, [ALLOWLIST]: "x\n" };
	for (const f of planned.files) files[f.path] = f.text;
	files[join(QDIR, QUADLET_FILES.proxy.file)] = "[Container]\nImage=old\n";
	const h = svc({ argv: ["install", "--force"], files, listening: true });
	h.modes.set(VALKEY_ENV, 0o600);
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
		join(QDIR, QUADLET_FILES.valkeyNetwork.file),
		VALKEY_ENV,
		...[QUADLET_FILES.valkey, QUADLET_FILES.egressNetwork].map((q) => join(QDIR, q.file)),
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

test("#447: the venue reader never reads a venue key differently from systemd 259 or bash, over every measured file", () => {
	// THE ORACLE: each row is what a unit's EnvironmentFile= set, measured (and, for gate round 1's rows, what bash
	// sourced). The reader either refuses or agrees; before #447 it read `podman` where systemd set nothing in 28 rows and
	// nothing where systemd set `podman` in two, and gate round 1's adversary found seven more files it read wrongly.
	const rows = [...SYSTEMD_259_ENV_FILES, ...SYSTEMD_259_ENV_BYTES.map(([n, hex, ...rest]) => [n, Buffer.from(hex, "hex"), ...rest])];
	for (const [name, content, systemd, hazard, bash] of rows) {
		const read = readStackKeys(content);
		if (hazard !== null) {
			assert.ok(read.error, `${name}: refused`);
			assert.match(read.error, new RegExp(`^\\.env line ${hazard[0]} has `), `${name}: names the line`);
		} else if (systemd === null) {
			assert.ok(read.error, `${name}: systemd refused to load it, so the reader refuses`);
		} else if (!read.error) {
			// Refusing is always allowed; vouching for the wrong value never is.
			assert.deepEqual(read.keys, systemd, `${name}: the reader says what systemd set`);
		}
		if (bash) {
			const sh = readStackKeys(content, { loader: "shell" });
			if (!sh.error) assert.deepEqual(sh.keys, bash, `${name}: the shell reading says what bash set`);
		}
	}
	// The adversary's lies, each refused now.
	for (const name of ["g1-a01-u2028-dq", "g1-a02-midcr-dq", "g1-a03-u2029-sq-backends", "g1-a04-u2028-proxy", "g1-a32-export-u2028", "g1-a05-nul-comment", "g1-a06-nul-value", "g1-a07-badutf8-value", "g1-a08-badutf8-key"]) {
		const row = rows.find((r) => r[0] === name);
		assert.ok(readStackKeys(row[1]).error, `${name}: refused`);
	}
	for (const name of ["g1-a23-shell-twoassign", "g1-a24-shell-dollarsq"]) assert.ok(readStackKeys(rows.find((r) => r[0] === name)[1], { loader: "shell" }).error, `${name}: the shell reading refuses`);
	// And it still READS the must-pass rows, rather than passing the oracle by refusing everything.
	for (const [name, text, systemd] of rows.filter((r) => r[0].startsWith("p-") || ["g1-b01-badutf8-comment", "g1-b02-badutf8-noeq", "g1-b06-fffd-valid", "g1-b09-badutf8-semicolon-comment"].includes(r[0]))) {
		assert.deepEqual(readStackKeys(text).keys, systemd, name);
	}
});

test("#447 gate round 1: a port of systemd's parser, pinned to every measured row, finds no file the reader reads wrongly", () => {
	// THE PORT IS AN ORACLE ONLY BECAUSE OF THIS FIRST LOOP: it must give what systemd 259 set on every measured row.
	const venue = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => STACK_KEYS.includes(k)).sort());
	for (const [name, text, systemd] of SYSTEMD_259_ENV_FILES) assert.deepEqual(venue(systemdEnvFile(text).env), systemd, `the port agrees with systemd on ${name}`);
	// Then seeded random files from the tokens every shape is made of. The reader refuses or agrees; it never vouches for
	// a value the port does not set. Seeded so a failure is a file anyone can reproduce, not a flake.
	let seed = 447;
	const rnd = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const TOKENS = ["PI_BACKENDS=", "PI_EGRESS=", "PI_EGRESS_PROXY=", "K=", "FOO-BAR=", "export K=", "export PI_BACKENDS=", "# ", "; ", '"', "'", "\\", "\n", "\n", "\n", "\r\n", "\r", " ", "\t", "podman", "0", "x", "=", "\u2028", "$'", "#", "\\\n"];
	let read = 0;
	for (let i = 0; i < 20000; i++) {
		let text = "";
		for (let k = 2 + Math.floor(rnd() * 14); k > 0; k--) text += TOKENS[Math.floor(rnd() * TOKENS.length)];
		const r = readStackKeys(text);
		if (r.error) continue;
		read++;
		assert.deepEqual(r.keys, venue(systemdEnvFile(text).env), `the reader vouched for what systemd does not set: ${JSON.stringify(text)}`);
	}
	assert.ok(read > 10000, `the reader still reads most of them (${read} of 20000), rather than passing by refusing`);
	// The file this found: a `#` line that is the tail of a continuation, where a lone CR starts a real line. The first
	// hazard is the continuation, and the comment spelling still counts because the file has a lone CR.
	assert.match(readStackKeys("export K= #0#  \\\n# export PI_BACKENDS=PI_EGRESS=\rPI_EGRESS_PROXY= K=FOO-BAR=").error, /^\.env line 1 has a trailing backslash/);
});

test("#447 gate round 1: `.env.example` spells the venue keys in comments, which alone never refuses a file", () => {
	// `init` copies it, so gating on any spelling refused every docker deployment with an unrelated odd line in it.
	// Measured on systemd 259 with the shipped file plus each tail: neither sets a venue key.
	const example = readFileSync(join(DEPLOY_DIR, "..", ".env.example"), "utf8");
	assert.match(example, /^# PI_BACKENDS=$/m, "the premise: the shipped example spells the key in a comment");
	assert.deepEqual(readStackKeys(`${example}FOO-BAR="x\nOTHER=1\n"\n`), { keys: {} }, "a non-identifier key's value, and no key spelled outside comments");
	assert.deepEqual(readStackKeys(`${example}X=a Y=0\nunset Z\n`, { loader: "shell" }), { keys: {} }, "the shells' hazards, the same");
	// A lone CR ELSEWHERE does not make the comments count (gate round 2; measured: the shipped example plus `X=1<CR>Y=2`
	// sets no venue key). Only text after a lone CR on a comment's own line can be read as a key.
	assert.deepEqual(readStackKeys(`${example}X=1\rY=2\n`), { keys: {} });
	assert.match(readStackKeys(`${example}# note\rPI_BACKENDS=podman\n`).error, /has a carriage return/);
	// And a caller about to WRITE a key refuses on any hazard (the setup wizard).
	assert.match(readStackKeys(`${example}FOO-BAR="x\nOTHER=1\n"\n`, { assumeSpelled: true }).error, /not a variable name/);
	assert.match(readStackKeys("X=1\nunset Y\n", { loader: "shell", assumeSpelled: true }).error, /a venue key is about to be written into it/);
	assert.deepEqual(readStackKeys("X=1\n", { assumeSpelled: true }), { keys: {} }, "a clean file is still read");
});

test("#447 gate round 1: service install refuses a .env systemd will not load before writing anything, podman or docker", async () => {
	const nul = Buffer.concat([Buffer.from("PI_EGRESS=0\n# a"), Buffer.from([0]), Buffer.from(`b\n${PODMAN_ENV}`)]);
	const docker = Buffer.concat([Buffer.from("K=caf"), Buffer.from([0xe9]), Buffer.from("\n")]);
	for (const [bytes, what] of [[nul, /line 2 has a NUL byte/], [docker, /line 1 has bytes in a key or value that are not valid UTF-8/]]) {
		const h = svc({ files: { [ENV_PATH]: bytes } });
		assert.equal(await h.run(), 1);
		assert.match(h.errText(), what);
		assert.deepEqual(h.writes, [], "no unit and no Quadlet file written");
		assert.ok(!h.calls.some((c) => c[0] === "systemctl"), "and nothing enabled");
	}
});

test("#447 gate round 2: a venue value longer than systemd passes on is refused, naming the key and the line", () => {
	// Measured on systemd 259: a value of 131068 bytes and up fails the exec ("Argument list too long") and one of 2 MB
	// is dropped at load (key unset); 131000 still passes. The bound here is 4096, far from both and from any real value.
	const at = (n) => readStackKeys(`PI_EGRESS=0\nPI_EGRESS_PROXY=${"h".repeat(n)}\n`);
	assert.deepEqual(at(4096).keys, { PI_EGRESS: "0", PI_EGRESS_PROXY: "h".repeat(4096) });
	assert.match(at(4097).error, /^\.env line 2 assigns PI_EGRESS_PROXY a value of 4097 bytes, and a venue value longer than 4096 bytes is refused by pi-dispatch \(a venue key never needs that much; systemd itself passes up to about 128 KiB\)\. Shorten it to at most 4096 bytes$/);
	assert.match(readStackKeys(`PI_BACKENDS=${"podman,".repeat(700)}podman\n`).error, /line 1 assigns PI_BACKENDS a value of 4906 bytes/);
	assert.match(readStackKeys(`PI_BACKENDS='${"é".repeat(2049)}'\n`).error, /a value of 4098 bytes/, "bytes, not characters");
});

test("#447 gate round 2: the comment gate, per line: a lone CR elsewhere does not make comments count, a continuation does", () => {
	assert.deepEqual(readStackKeys("# PI_BACKENDS=podman\nX=1\rY=2\n"), { keys: {} }, "the CR is on another line");
	assert.match(readStackKeys("# note\rPI_BACKENDS=podman\n").error, /has a carriage return/, "text after a lone CR on the comment's own line is a line");
	// To a shell a `#` line reached by a continuation is joined text (b52, measured: bash sets PI_EGRESS=0).
	assert.ok(readStackKeys("X=a\\\n#;PI_EGRESS=0\n", { loader: "shell" }).error);
	// The cmd wrapper has no shell hazards, even for a caller about to write.
	assert.deepEqual(readStackKeys("X=1\nunset Y\n", { loader: "cmd", assumeSpelled: true }), { keys: {} });
	assert.deepEqual(readStackKeys('X=a"b\n', { loader: "cmd", assumeSpelled: true }), { keys: {} }, "nor the shell branch at all: this line is a cmd hazard, and not what the writer asks about");
});

test("#447 gate round 3: a file too large for systemd to start the service with is refused, naming the key or the total", () => {
	assert.match(readStackKeys(`PI_EGRESS=0\nX=${"h".repeat(200000)}\n`).error, /^\.env line 2 has more environment than the service can safely be started with: one KEY=value longer than 131071 bytes fails with "Argument list too long", and a total over 2031616 bytes .* \(X=\.\.\. is 200002 bytes\): shorten that value/);
	const many = Array.from({ length: 24 }, (_, i) => `K${i}=${"h".repeat(100000)}`).join("\n");
	assert.match(readStackKeys(`PI_EGRESS=0\n${many}\n`).error, /\(the file's assignments reach \d+ bytes by this line\)/);
	assert.deepEqual(readStackKeys(`PI_EGRESS=0\nX=${"h".repeat(131060)}\n`).keys, { PI_EGRESS: "0" }, "c02, measured to run");
	// c16, measured: a 4091-byte proxy value in two-byte characters, under the project's 4096-byte cap, which systemd passed.
	const c16 = `http://a/${"\u00e9".repeat(2041)}`;
	assert.equal(Buffer.byteLength(c16), 4091);
	assert.deepEqual(readStackKeys(`PI_EGRESS_PROXY='${c16}'\n`).keys, { PI_EGRESS_PROXY: c16 }, "single-quoted, as the measured file has it");
});

test("#447: each shape is refused with its line, what systemd does with it, and what to change", () => {
	const cases = [
		['K="a" "b\nPI_BACKENDS=podman\n"\n', 1, /a second quote right after a value's closing quote.*: remove the second quote, or close it on the same line$/],
		['NOTE="a\nb" "c\nPI_BACKENDS=podman\n"\n', 2, /a second quote right after/],
		['FOO-BAR="x\nPI_BACKENDS=podman\n"\n', 1, /under a key that is not a variable name.*: rename the key to a valid variable name, close the quote on the same line, or delete the line$/],
		["X=1\rPI_BACKENDS=podman\n", 1, /a carriage return \(CR\) that is not part of a CRLF line ending, which systemd reads as a line break.*: remove the CR, or save the file with LF \(or CRLF\) line endings$/],
		['NOTE="a\nb"\\\nPI_BACKENDS=podman\n', 2, /a trailing backslash that systemd reads as joining the next line.*: remove the trailing backslash, or move the value onto one line$/],
	];
	for (const [text, line, what] of cases) {
		const err = readStackKeys(text, { path: "/srv/pi/.env" }).error;
		assert.ok(err, JSON.stringify(text));
		assert.ok(err.startsWith(`/srv/pi/.env line ${line} has `), err);
		assert.match(err, what);
		assert.match(err, /which venue keys \(PI_BACKENDS, PI_EGRESS, PI_EGRESS_PROXY\) it sets is unknown/);
	}
	// The whole file: the hazard can sit BELOW the key, and a key after a lone CR is one no line scan finds.
	assert.match(readStackKeys('PI_BACKENDS=podman\nFOO-BAR="x\nPI_EGRESS=0\n"\n').error, /^\.env line 2 has /);
	assert.match(readStackKeys("X=1\rPI_EGRESS_PROXY=my-squid\n").error, /^\.env line 1 has a carriage return/);
});

test("#447: a file that never names a venue key outside a comment is not refused over a systemd hazard, and other loaders are unaffected", () => {
	// Sound, not lenient: systemd builds a key only from contiguous text on one line, and a `#` or `;` line is a comment
	// to it unless a lone CR splits it, so a file that spells no key outside comments assigns none under either reading
	// (gate round 1 corrected "never spells one anywhere", which refused every file `init` makes from .env.example). A
	// docker deployment with an odd line elsewhere keeps working.
	assert.deepEqual(readStackKeys('FOO-BAR="x\nOTHER=1\n"\n'), { keys: {} });
	assert.deepEqual(readStackKeys("X=1\rOTHER=2\n"), { keys: {} });
	// The shells split on LF and carry every quote, and the cmd wrapper reads one line at a time: this is systemd's.
	assert.deepEqual(readStackKeys("X=1\rPI_BACKENDS=podman\n", { loader: "shell" }), { keys: {} });
	assert.deepEqual(readStackKeys("PI_BACKENDS=podman\nX=1\rY=2\n", { loader: "cmd" }).keys, { PI_BACKENDS: "podman" });
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

test("makeDetachGate: a RUNNING detach on a rootless Podman 4.x waits for a keeper that holds NOW, and nothing else is read (#452, gate round 3)", async () => {
	// A runner that answers the runtime read and the keeper read from a table, recording every argv and its options.
	const runner = ({ info = { code: 0, stdout: "" }, keeper = { code: 125, stdout: "" } } = {}) => {
		const calls = [];
		const run = async (args, opts) => {
			calls.push({ line: args.join(" "), opts });
			if (args[0] === "info") return typeof info === "function" ? info() : info;
			if (args[0] === "inspect") return keeper;
			return { code: 99, stdout: "" };
		};
		return { run, calls };
	};
	const holding = { code: 0, stdout: `running|bridge|${NETNS_KEEPER},\n` };
	const absent = { code: 125, stdout: "" };
	// The runtime shapes, as measured on 4.9.3 and 5.8.1 (round 446): podman's own JSON, Podman's shape through
	// podman-docker, and Docker's shape with Podman's licence from the real docker CLI on Podman's API socket.
	const podman = (version, rootless = true) => ({ code: 0, stdout: JSON.stringify({ host: { security: { rootless } }, version: { Version: version } }) });
	const compat = (version, rootless = true) => ({ code: 0, stdout: JSON.stringify({ ServerVersion: version, ProductLicense: "Apache-2.0", OperatingSystem: "ubuntu", SecurityOptions: ["name=seccomp,profile=default", ...(rootless ? ["name=rootless"] : [])] }) });
	const engine = (ServerVersion) => ({ code: 0, stdout: JSON.stringify({ ServerVersion, OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin"] }) });
	// Nothing running to detach: not one read.
	const idle = runner({ info: podman("4.9.3") });
	assert.equal(await makeDetachGate(idle.run, { bin: "podman" })({ running: false }), null);
	assert.deepEqual(idle.calls, []);
	// Rootless 4.x on every route: only a keeper holding now allows it, read with the no-clock format and the readers' bound.
	for (const [bin, info] of [["podman", podman("4.9.3")], ["docker", podman("4.9.3")], ["docker", compat("4.9.3")]]) {
		const blocked = runner({ info });
		assert.equal(await makeDetachGate(blocked.run, { bin })(), "keeper-not-holding", `${bin} ${info.stdout}`);
		assert.deepEqual(blocked.calls.map((c) => c.line), [bin === "podman" ? "info --format json" : "info --format={{json .}}", `inspect ${NETNS_KEEPER_NOW_FORMAT} ${NETNS_KEEPER}`]);
		assert.deepEqual(blocked.calls[0].opts, { timeoutMs: DETACH_GATE_READ_TIMEOUT_MS, maxBuffer: DETACH_GATE_READ_MAX_BUFFER });
		assert.equal(await makeDetachGate(runner({ info, keeper: holding }).run, { bin })(), null, "a keeper holding NOW is enough, with no age rule");
	}
	assert.ok(!NETNS_KEEPER_NOW_FORMAT.includes("StartedAt"));
	assert.deepEqual([DETACH_GATE_READ_TIMEOUT_MS, DETACH_GATE_READ_MAX_BUFFER], [15_000, 1024 * 1024]);
	// Docker Engine, rootful Podman and 5.x: no keeper read. Pinned (M4, gate round 3): a Docker Engine whose version is
	// not a number ("dev", as a source build reports) and carries no Podman licence is NOT Podman, whatever its version
	// says, and neither is a Docker Engine with no version at all.
	for (const [bin, info] of [
		["docker", engine("27.4.0")],
		["docker", engine("dev")],
		["docker", engine("27.4.0 (a build with spaces, so no display version: null)")],
		// A ROOTLESS Docker Engine reporting "dev" (or no readable version), with no Podman licence: Docker, not Podman, so
		// no keeper, even though its version would read as "needs one" and its rootless flag cannot let it through.
		["docker", { code: 0, stdout: JSON.stringify({ ServerVersion: "dev", OperatingSystem: "Ubuntu", SecurityOptions: ["name=rootless"] }) }],
		["docker", { code: 0, stdout: JSON.stringify({ ServerVersion: "27.4.0 custom", OperatingSystem: "Ubuntu", SecurityOptions: ["name=rootless"] }) }],
		["docker", { code: 0, stdout: JSON.stringify({ ServerVersion: "dev", OperatingSystem: "Docker Desktop" }) }],
		["docker", compat("4.9.3", false)],
		["docker", compat("5.8.1")],
		["podman", podman("4.9.3", false)],
		["podman", podman("5.8.1")],
	]) {
		const r = runner({ info });
		assert.equal(await makeDetachGate(r.run, { bin })(), null, `${bin} ${info.stdout}`);
		assert.deepEqual(r.calls.map((c) => c.line.split(" ")[0]), ["info"], `no keeper read: ${info.stdout}`);
	}
	// A runtime the read cannot identify: allowed only by a keeper that holds, else its own token; a throw is the same.
	for (const info of [{ code: 125, stdout: "" }, { code: 0, stdout: "not json" }, { code: null, stdout: "" }]) {
		assert.equal(await makeDetachGate(runner({ info }).run)(), "runtime-unreadable", JSON.stringify(info));
		assert.equal(await makeDetachGate(runner({ info, keeper: holding }).run)(), null);
	}
	const throwing = async () => {
		throw new Error("spawn failed");
	};
	assert.equal(await makeDetachGate(throwing)(), "runtime-unreadable");
});

test("makeDetachGate reads ONCE per pass, an unanswered read included, and takes a runtime a caller already read (#452, gate round 3)", async () => {
	// L207/G1 (gate round 3, measured): the round-2 guard re-read the runtime for every leftover network, so a `docker info`
	// that hangs cost one bound per network (three leftovers, 90 s at boot). One gate is one pass.
	let reads = 0;
	const hang = async (args) => {
		if (args[0] === "info") {
			reads += 1;
			return { code: null, stdout: "" };
		}
		return { code: 125, stdout: "" };
	};
	const gate = makeDetachGate(hang);
	for (let i = 0; i < 3; i++) assert.equal(await gate({ running: true }), "runtime-unreadable");
	assert.equal(reads, 1, "the unanswered read is remembered for the pass");
	// Concurrent askers share the one read too.
	let concurrent = 0;
	const slow = makeDetachGate(async (args) => (args[0] === "info" ? (concurrent++, { code: 0, stdout: JSON.stringify({ ServerVersion: "27.4.0", OperatingSystem: "x" }) }) : { code: 125, stdout: "" }));
	await Promise.all([slow(), slow(), slow()]);
	assert.equal(concurrent, 1);
	// A runtime handed in is used instead of a read of its own (doctor's one `docker info` per run).
	const asked = [];
	const handed = makeDetachGate(async (args) => (asked.push(args[0]), { code: 125, stdout: "" }), { readRuntime: async () => ({ podman: true, rootless: true, version: "4.9.3" }) });
	assert.equal(await handed(), "keeper-not-holding");
	assert.deepEqual(asked, ["inspect"], "only the keeper is read");
	assert.equal(await makeDetachGate(async () => ({ code: 125, stdout: "" }), { readRuntime: async () => null })(), "runtime-unreadable");
	assert.deepEqual(runtimeFromFacts({ answered: true, facts: { podman: true, rootless: true, serverVersion: "4.9.3" } }), { podman: true, rootless: true, version: "4.9.3" });
	assert.equal(runtimeFromFacts({ answered: false, reason: "timeout" }), null);
	// The clause each token becomes names the CLI.
	assert.match(detachBlockedSentence("keeper-not-holding", "docker"), /rootless Podman 4\.x this shell's docker CLI reaches/);
	assert.match(detachBlockedSentence("runtime-unreadable", "podman"), /this shell's podman CLI could not say which container runtime/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Issue #468: the Quadlet Valkey's password
// ---------------------------------------------------------------------------------------------------------------------

test("planStack (#468): the Valkey's password file is planned 0600 before its unit, and a change or a wide mode restarts Valkey and only then its running clients", () => {
	const components = { valkey: true, proxy: false, keeper: false, valkeyPassword: TEST_PASSWORD };
	const fresh = planStack({ components, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() });
	const secret = fresh.files.find((f) => f.kind === "secret");
	assert.deepEqual([secret.path, secret.mode, secret.state, secret.restarts, secret.unit], [VALKEY_ENV, 0o600, "new", "pi-dispatch-valkey.service", null]);
	assert.match(secret.text, new RegExp(`^VALKEY_PASSWORD=${TEST_PASSWORD}$`, "m"));
	assert.ok(fresh.files.indexOf(secret) < fresh.files.findIndex((f) => f.path.endsWith("pi-dispatch-valkey.container")), "written before the unit that reads it");
	assert.equal(planStack({ components: { ...components, valkey: false }, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: realReadFs() }).files.some((f) => f.kind === "secret"), false, "no Valkey, no password file");
	assert.equal(fresh.clientsRestarted.length, 0);
	// An installed Valkey (its unit and password file on disk) whose password file now changes: Valkey restarts with it,
	// then the running clients the caller named, which read VALKEY_PASSWORD only at start.
	const unit = fresh.files.find((f) => f.path.endsWith("pi-dispatch-valkey.container"));
	const net = fresh.files.find((f) => f.path.endsWith("pi-dispatch-valkey.network"));
	const installed = (secretText, mode = 0o600) => {
		const fs = realReadFs({ [unit.path]: unit.text, [net.path]: net.text, [VALKEY_ENV]: secretText });
		fs.statSync = (p) => ({ mode: 0o100000 | (p === VALKEY_ENV ? mode : 0o644) });
		return fs;
	};
	const clients = ["pi-dispatch-worker.service", "pi-dispatch-receiver.service"];
	const upgrade = planStack({ components, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: installed("VALKEY_PASSWORD=\n"), restartAfterValkey: clients });
	assert.deepEqual(upgrade.restart, ["pi-dispatch-valkey.service"]);
	assert.deepEqual(upgrade.actions.slice(-2).map((a) => a.argv), [["systemctl", "--user", "restart", "pi-dispatch-valkey.service"], ["systemctl", "--user", "try-restart", ...clients]], "the clients after Valkey, never before");
	assert.match(valkeyPasswordRestartWarning(upgrade), /^pi-dispatch-valkey\.service restarts with the password in \/home\/tester\/\.config\/pi-dispatch\/valkey\.env \(the queue in its volume is kept\), and pi-dispatch-worker\.service and pi-dispatch-receiver\.service restart after it to send that password\. A job running right now is interrupted: pause first/);
	assert.ok(!valkeyPasswordRestartWarning(upgrade).includes(TEST_PASSWORD));
	// The same password, the file 0600: nothing moves, no client is touched, nothing is said.
	const same = planStack({ components, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: installed(secret.text), restartAfterValkey: clients });
	assert.deepEqual([same.restart, same.clientsRestarted, valkeyPasswordRestartWarning(same)], [[], [], null]);
	assert.ok(!same.actions.some((a) => a.kind === "write"));
	// The same text in a file another account can read is rewritten (and narrowed): a password file must not stay wide.
	const wide = planStack({ components, templatesDir: DEPLOY_DIR, deployDir: DEPLOY_AT, home: HOME, fs: installed(secret.text, 0o644) });
	assert.equal(wide.files.find((f) => f.kind === "secret").state, "changed");
});

test("journalWrite (#468): a file with a mode is narrowed BEFORE the new text goes in, and created with it", () => {
	const ops = [];
	const store = new Map([["/x/valkey.env", "VALKEY_PASSWORD=\n"]]);
	const fs = { existsSync: (p) => store.has(p), readFileSync: (p) => store.get(p), writeFileSync: (p, d, o) => (ops.push(["write", p, o?.mode]), store.set(p, d)), chmodSync: (p, m) => ops.push(["chmod", p, m]) };
	const journal = [];
	journalWrite(fs, journal, "/x/valkey.env", `VALKEY_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
	assert.deepEqual(ops, [["chmod", "/x/valkey.env", 0o600], ["write", "/x/valkey.env", 0o600], ["chmod", "/x/valkey.env", 0o600]]);
	assert.deepEqual(journal, [{ path: "/x/valkey.env", existed: true, previous: "VALKEY_PASSWORD=\n" }]);
	ops.length = 0;
	journalWrite(fs, null, "/x/new.env", "V=1\n", { mode: 0o600 });
	assert.deepEqual(ops, [["write", "/x/new.env", 0o600], ["chmod", "/x/new.env", 0o600]]);
	ops.length = 0;
	journalWrite(fs, null, "/x/unit", "u\n");
	assert.deepEqual(ops, [["write", "/x/unit", undefined]], "a file without a mode is written as before");
});

test("service install on podman (#468): a deployment without a password gets one in .env (0600) and in the Valkey's 0600 file, never printed; render names the file only", async () => {
	const h = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n` } });
	assert.equal(await h.run(), 0, h.errText());
	assert.equal(h.store.get(ENV_PATH), `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_PASSWORD=${TEST_PASSWORD}\n`);
	assert.equal(h.modes.get(ENV_PATH), 0o600, ".env narrowed to this account");
	assert.match(h.store.get(VALKEY_ENV), new RegExp(`^VALKEY_PASSWORD=${TEST_PASSWORD}$`, "m"));
	assert.equal(h.modes.get(VALKEY_ENV), 0o600);
	assert.ok(h.writes.indexOf(VALKEY_ENV) < h.writes.indexOf(join(QDIR, QUADLET_FILES.valkey.file)), "the password file before the unit that reads it");
	assert.match(h.text(), /^generated VALKEY_PASSWORD into \/srv\/pi-deploy\/\.env \(32 random bytes, hex; the value is not shown; the file is now readable by this account only\)$/m);
	assert.ok(!h.text().includes(TEST_PASSWORD) && !h.errText().includes(TEST_PASSWORD), "the value is never printed");
	// A second install finds it and keeps it: never generated over a value.
	const again = svc({ argv: ["install", "--force"], files: { [ENV_PATH]: h.store.get(ENV_PATH), [VALKEY_ENV]: h.store.get(VALKEY_ENV), [join(QDIR, QUADLET_FILES.valkey.file)]: h.store.get(join(QDIR, QUADLET_FILES.valkey.file)), [join(QDIR, QUADLET_FILES.valkeyNetwork.file)]: h.store.get(join(QDIR, QUADLET_FILES.valkeyNetwork.file)) }, listening: true, extra: { newPassword: () => "f".repeat(64) } });
	again.modes.set(VALKEY_ENV, 0o600);
	assert.equal(await again.run(), 0, again.errText());
	assert.match(again.store.get(ENV_PATH), new RegExp(`^VALKEY_PASSWORD=${TEST_PASSWORD}$`, "m"));
	assert.doesNotMatch(again.text(), /generated VALKEY_PASSWORD/);
	assert.ok(!again.calls.some((c) => c.join(" ").includes("restart")), "nothing about the password changed, so nothing restarts");
	// render: the file is named, its value never shown, and nothing is written.
	const r = svc({ argv: ["render"], files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_PASSWORD=${TEST_PASSWORD}\n` } });
	assert.equal(await r.run(), 0, r.errText());
	assert.match(r.text(), /# → \/home\/tester\/\.config\/pi-dispatch\/valkey\.env \(mode 0600: VALKEY_PASSWORD for the Quadlet Valkey, from \.env or generated into it at install; the value is not shown\)/);
	assert.ok(!r.text().includes(TEST_PASSWORD), "render never prints the password");
	assert.deepEqual(r.writes, []);
	assert.match(r.text(), /^EnvironmentFile=%h\/\.config\/pi-dispatch\/valkey\.env$/m, "the unit itself is printed as before");
});

test("service install on podman (#468): the upgrade of a Valkey that ran without a password restarts it with one, then the running worker and receiver", async () => {
	// The pre-#468 install: its unit and network on disk (the old unit text), no password file, no VALKEY_PASSWORD.
	const files = { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\n`, [join(QDIR, QUADLET_FILES.valkey.file)]: "[Container]\nExec=valkey-server --appendonly yes\n", [join(QDIR, QUADLET_FILES.valkeyNetwork.file)]: template(QUADLET_FILES.valkeyNetwork.file), [USER_UNIT]: "old\n" };
	const h = svc({ argv: ["install", "--force"], files, listening: true, plan: { "systemctl --user is-active pi-dispatch-worker.service": { code: 0, output: "active\n" }, "systemctl --user is-active pi-dispatch-receiver.service": { code: 3, output: "inactive\n" } } });
	assert.equal(await h.run(), 0, h.errText());
	const sys = h.calls.filter((c) => c[0] === "systemctl" && !["show-environment", "is-active"].includes(c[2])).map((c) => c.slice(2).join(" "));
	assert.deepEqual(sys.slice(0, 3), ["daemon-reload", "restart pi-dispatch-valkey.service", "try-restart pi-dispatch-worker.service"], "Valkey with its password first, then the one running client");
	assert.match(h.text(), /⚠ pi-dispatch-valkey\.service restarts with the password in \/home\/tester\/\.config\/pi-dispatch\/valkey\.env \(the queue in its volume is kept\), and pi-dispatch-worker\.service restarts after it/);
	assert.match(h.text(), /^restarted pi-dispatch-valkey\.service, because this install replaced \/home\/tester\/\.config\/pi-dispatch\/valkey\.env and \/home\/tester\/\.config\/containers\/systemd\/pi-dispatch-valkey\.container$/m);
	assert.match(h.store.get(ENV_PATH), new RegExp(`^VALKEY_PASSWORD=${TEST_PASSWORD}$`, "m"));
});

test("service install on podman (#468): a shared or operator-owned Valkey gets no password generated, and a password Valkey could not take is refused before anything is written", async () => {
	// Shared on purpose: another account's Valkey, its password that account's to give.
	const shared = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nPI_VALKEY_SHARED=1\n` }, listening: true, listenerUid: 1235 });
	assert.equal(await shared.run(), 0, shared.errText());
	assert.doesNotMatch(shared.store.get(ENV_PATH), /VALKEY_PASSWORD/);
	assert.ok(!shared.store.has(VALKEY_ENV));
	// A remote VALKEY_URL: the operator's own, left as it is.
	const remote = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_URL=redis://queue.lan:6379\n` } });
	assert.equal(await remote.run(), 0, remote.errText());
	assert.doesNotMatch(remote.store.get(ENV_PATH), /VALKEY_PASSWORD/);
	// A value the start script cannot hand to Valkey (a space, a quote): refused, named, nothing written.
	const bad = svc({ files: { [ENV_PATH]: `${PODMAN_ENV}PI_EGRESS=0\nVALKEY_PASSWORD='not ok here'\n` } });
	assert.equal(await bad.run(), 1);
	assert.match(bad.errText(), /VALKEY_PASSWORD in \/srv\/pi-deploy\/\.env cannot be handed to Valkey: it has a character other than A-Z, a-z, 0-9, - and _/);
	assert.ok(!bad.errText().includes("not ok here"));
	assert.deepEqual(bad.writes, []);
});

test("service uninstall (#468): the Valkey's password file goes with its unit; the password stays in .env for a re-install", async () => {
	const files = { [ENV_PATH]: `VALKEY_PASSWORD=${TEST_PASSWORD}\n`, [VALKEY_ENV]: `VALKEY_PASSWORD=${TEST_PASSWORD}\n` };
	for (const q of [QUADLET_FILES.valkey, QUADLET_FILES.valkeyNetwork]) files[join(QDIR, q.file)] = "q";
	const h = svc({ argv: ["uninstall"], files });
	assert.equal(await h.run(), 0, h.errText());
	assert.ok(!h.store.has(VALKEY_ENV));
	assert.equal(h.store.get(ENV_PATH), `VALKEY_PASSWORD=${TEST_PASSWORD}\n`);
});

test("service install on podman refuses a folder without model-endpoints.conf, since the proxy's rules include it (#503)", async () => {
	const h = svc({ files: { [ENV_PATH]: PODMAN_ENV, [ALLOWLIST]: "x\n" }, includeFile: false });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /model-endpoints\.conf does not exist: the proxy's rules include it, and squid will not start without it/);
	assert.ok(!h.calls.some((c) => c[0] === "systemctl" && c.includes("start")), "nothing started");
	assert.equal(h.writes.length, 0, "nothing written");
});
