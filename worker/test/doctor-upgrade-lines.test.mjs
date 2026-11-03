import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_VERSION } from "../src/egress-conf-copy.mjs";
import { fleetVersionChecks } from "../src/doctor.mjs";
import { serviceEnvFileOf } from "../src/service-env.mjs";
import { NAMED_CHECK_IDS, assignCheckIds } from "../src/doctor-results.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #761: two of doctor's lines for an upgrade. `fleet.versions` compares the pi-dispatch versions the live workers
// report, and this doctor's own against this host's worker row; `state.older` says each store an older release
// left in a shape this build no longer writes (older-state.mjs, through its seam here).

const row = (name, version) => ({ name, ...(version === undefined ? {} : { version }) });

test("fleetVersionChecks: nothing on a single host whose worker reports this doctor's version, or none", () => {
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [] }), []);
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: null, peers: [] }), [], "no worker running here");
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: row("mini1", ""), selfName: "mini1", peers: [] }), [], "a worker that could not read its own version");
	assert.deepEqual(fleetVersionChecks({ installed: null, self: row("mini1", "4.3.1"), selfName: "mini1", peers: [] }), [], "a doctor that could not read its own");
});

test("fleetVersionChecks: this doctor against this host's worker row, as two facts and never 'not restarted'", () => {
	const [line] = fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "4.3.1"), selfName: "mini1", peers: [] });
	assert.deepEqual(line, {
		id: "fleet.versions",
		ok: false,
		warn: true,
		label: "pi-dispatch versions differ: this doctor 5.0.0, this host's worker row reports 4.3.1",
		fix: "finish the upgrade in one window (docs/upgrading.md): the same version on every host; on each host `pi-dispatch pause`, wait until `pi-dispatch status` shows no active job, restart the worker, then `pi-dispatch resume`. If this doctor is not the install the service runs (npx, another checkout), run that install's doctor instead",
	});
	assert.doesNotMatch(line.label, /restart/);
	// The row, not "the running worker": a worker killed without deleting its row leaves it for up to HOST_TTL_MS (90 s).
	assert.doesNotMatch(line.label, /running/);
	// `service restart --drain` pauses and watches the shared queue only: a job on a host queue (PI_WORKER_NAME) is not
	// waited for, and that queue stays paused. The fix names the steps that cover both.
	assert.doesNotMatch(line.fix, /--drain/);
	assert.ok(NAMED_CHECK_IDS.includes("fleet.versions"));
});

test("fleetVersionChecks: peers that agree are one ok line; peers that differ are a warning grouped by version", () => {
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [row("mini2", "5.0.0"), row("mini3", "5.0.0")] }), [{ id: "fleet.versions", ok: true, label: "Fleet versions: the 3 workers with a live row report 5.0.0" }]);
	// No worker row here: the peers alone, named as the workers with a live row, not as the fleet.
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: null, peers: [row("mini2", "4.3.1"), row("mini3", "4.3.1")] }), [{ id: "fleet.versions", ok: true, label: "Fleet versions: the 2 workers with a live row report 4.3.1" }]);
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: null, peers: [row("mini2", "4.3.1")] }), [{ id: "fleet.versions", ok: true, label: "Fleet versions: the 1 worker with a live row reports 4.3.1" }]);
	const [mixed] = fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [row("zeta", "4.3.1"), row("alpha", "5.0.0"), row("beta", "4.3.1")] });
	assert.equal(mixed.warn, true);
	assert.equal(mixed.label, "pi-dispatch versions differ: the live workers report 2 versions: 4.3.1 (beta, zeta), 5.0.0 (alpha, mini1)");
	assert.doesNotMatch(mixed.fix, /npx/, "the doctor's own version agrees with this host's worker");
	// Both facts at once, in one line.
	const [both] = fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "4.3.1"), selfName: "mini1", peers: [row("mini2", "5.0.0")] });
	assert.equal(both.label, "pi-dispatch versions differ: the live workers report 2 versions: 4.3.1 (mini1), 5.0.0 (mini2); this doctor 5.0.0, this host's worker row reports 4.3.1");
	assert.match(both.fix, /npx/);
	assert.deepEqual(assignCheckIds([both]), ["fleet.versions"]);
});

test("fleetVersionChecks: an unreadable or hostile version is 'unknown', its own group, and never printed", () => {
	const hostile = ["", "5.0.0\u001b[2J", "x".repeat(33), "5.0.0 beta", 5, null, "../../etc"];
	for (const v of hostile) {
		const [line] = fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [row("mini2", v)] });
		// One readable version and one doctor could not read: they may be the same, so the headline does not say "differ".
		assert.equal(line.label, "pi-dispatch versions cannot all be read: the live workers report 2 versions: 5.0.0 (mini1), unknown (mini2)", JSON.stringify(v));
		assert.equal(line.warn, true);
		assert.match(line.fix, /^finish the upgrade in one window \(docs\/upgrading\.md\)/);
	}
	// "differ" where doctor read two versions that differ, an unknown beside them or not, or this doctor's own against this
	// host's row.
	assert.match(fleetVersionChecks({ installed: "5.0.0", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [row("mini2", ""), row("mini3", "4.3.1")] })[0].label, /^pi-dispatch versions differ: the live workers report 3 versions: 4\.3\.1 \(mini3\), 5\.0\.0 \(mini1\), unknown \(mini2\)$/);
	assert.match(fleetVersionChecks({ installed: "5.0.1", self: row("mini1", "5.0.0"), selfName: "mini1", peers: [row("mini2", "")] })[0].label, /^pi-dispatch versions differ: the live workers report 2 versions: 5\.0\.0 \(mini1\), unknown \(mini2\); this doctor 5\.0\.1, this host's worker row reports 5\.0\.0$/);
	// No worker row here, one peer readable and one not: still not "differ".
	assert.match(fleetVersionChecks({ installed: "5.0.0", self: null, peers: [row("mini2", "4.3.1"), row("mini3")] })[0].label, /^pi-dispatch versions cannot all be read: /);
	// Every peer unknown and no worker here: there is nothing to compare, and nothing is claimed.
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0", self: null, peers: [row("mini2"), row("mini3", "")] }), []);
	// A name is printed without its control characters.
	const [named] = fleetVersionChecks({ installed: "5.0.0", self: null, peers: [row("mini2\u0007", "4.3.1"), row("mini3", "5.0.0")] });
	assert.doesNotMatch(named.label, /[\u0000-\u001f]/);
	// The charset: npm's version characters, at most 32.
	assert.deepEqual(fleetVersionChecks({ installed: "5.0.0-rc.1+b.7", self: row("a", "5.0.0-rc.1+b.7"), selfName: "a", peers: [row("b", "5.0.0-rc.1+b.7")] })[0].ok, true);
});

// ---- through the real collection ----

function planSpawn(plan, seen = []) {
	return (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		seen.push(line);
		const outcome = plan[Object.keys(plan).find((k) => line.startsWith(k))];
		const stream = () => ({ handlers: {}, on(ev, cb) { this.handlers[ev] = cb; return this; } });
		const handlers = {};
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => {
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

// `plan` may be a function of the deployment folder (a container labelled with it), and `files` are written into it first.
// `symlinked` makes the folder doctor runs in a symlink to it, so its real path differs from the path given.
function collect({ hosts = [], plan = { "docker info": 0, "docker image": 0 }, seams = {}, seen = [], env: extraEnv = {}, files = {}, symlinked = false } = {}) {
	const real = tempDir("pi-761-upgrade-lines-");
	const home = tempDir("pi-761-upgrade-lines-home-");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(real, path, ".."), { recursive: true });
		writeFileSync(join(real, path), text);
	}
	const dir = symlinked ? join(tempDir("pi-761-upgrade-lines-link-"), "deploy") : real;
	if (symlinked) symlinkSync(real, dir);
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SETTINGS_FILE: join(dir, "settings.json"), VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_LOGS_DIR: join(dir, "logs"), ...extraEnv };
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return collectChecks(env, { cwd: dir, home, out: () => {}, spawn: planSpawn(typeof plan === "function" ? plan(dir) : plan, seen), probeValkey: async () => true, readHosts: async () => ({ hosts: hosts.map((h) => ({ tz, ...h })) }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (path) => readFileSync(path), nodeVersion: "22.19.0", ...seams }).then((checks) => ({ checks, dir, home }));
}

test("through the collection: this host's row and its peers' are compared, with this doctor's own package version", async () => {
	const { checks } = await collect({ hosts: [row("mini1", "0.0.1-old"), row("mini2", PACKAGE_VERSION)] });
	const line = checks.find((c) => c.id === "fleet.versions");
	assert.equal(line.label, `pi-dispatch versions differ: the live workers report 2 versions: ${["0.0.1-old (mini1)", `${PACKAGE_VERSION} (mini2)`].sort().join(", ")}; this doctor ${PACKAGE_VERSION}, this host's worker row reports 0.0.1-old`);
	// After the fleet's own lines.
	assert.ok(checks.findIndex((c) => typeof c.label === "string" && c.label.startsWith("Fleet: 2 workers")) < checks.indexOf(line));
	// A single host running this doctor's version, and a fleet whose rows publish none, say nothing new.
	assert.equal((await collect({ hosts: [row("mini1", PACKAGE_VERSION)] })).checks.some((c) => c.id === "fleet.versions"), false);
	assert.equal((await collect({ hosts: [row("mini2")] })).checks.some((c) => c.id === "fleet.versions"), false);
	assert.equal((await collect({ hosts: [row("mini1", PACKAGE_VERSION), row("mini2", PACKAGE_VERSION)] })).checks.find((c) => c.id === "fleet.versions").ok, true);
});

test("through the collection: each older-state finding is one state.older warning, after the state lines, printable", async () => {
	let asked = null;
	const olderStateFindings = async (args) => {
		asked = args;
		return [
			{ store: "valkey-compose", label: "deploy/docker-compose.yml names valkey/valkey:8\u001b[2J", fix: "copy the package's compose file" },
			{ store: "valkey-container", label: "the running pi-dispatch-valkey container runs valkey/valkey:8", fix: "pause, then docker rm -f pi-dispatch-valkey && pi-dispatch up" },
			{ store: "broken" },
			null,
		];
	};
	const { checks, dir, home } = await collect({ seams: { olderStateFindings } });
	assert.equal(asked.cwd, dir);
	assert.equal(asked.home, home);
	writeFileSync(join(dir, "probe.txt"), "text");
	assert.equal(asked.readFile(join(dir, "probe.txt")), "text", "readFile reads a file as text");
	assert.throws(() => asked.readFile(join(dir, "absent.txt")), /ENOENT/, "and throws for one that is not there");
	const older = checks.filter((c) => c.id === "state.older");
	assert.deepEqual(older, [
		{ id: "state.older", ok: false, warn: true, label: "deploy/docker-compose.yml names valkey/valkey:8 [2J", fix: "copy the package's compose file" },
		{ id: "state.older", ok: false, warn: true, label: "the running pi-dispatch-valkey container runs valkey/valkey:8", fix: "pause, then docker rm -f pi-dispatch-valkey && pi-dispatch up" },
	]);
	assert.deepEqual(assignCheckIds(older), ["state.older", "state.older-2"], "a repeat is published with a tail");
	// The state section's own line about where the durable stores are (here under the OS temp dir, a test's folder).
	const durable = checks.findIndex((c) => typeof c.label === "string" && (c.label.startsWith("Durable state: run history") || c.label.includes("point into the OS temp dir")));
	assert.ok(durable >= 0 && durable < checks.indexOf(older[0]), `${durable} < ${checks.indexOf(older[0])}`);
	assert.ok(NAMED_CHECK_IDS.includes("state.older"));
	// A module that throws, or answers something else, is no finding.
	for (const broken of [async () => { throw new Error("boom"); }, async () => "nope", () => null]) {
		assert.equal((await collect({ seams: { olderStateFindings: broken } })).checks.some((c) => c.id === "state.older"), false);
	}
});

// One `docker container inspect pi-dispatch-valkey` answer: up's label naming `label`, or none, publishing `port` on
// 127.0.0.1 or nothing, created from `image`.
const valkeyRecord = ({ label, port, image = "valkey/valkey:8" } = {}) => ({
	code: 0,
	output: JSON.stringify([{ Name: "/pi-dispatch-valkey", Config: { Labels: label ? { "com.pi-dispatch.deployment": label } : {}, Image: image }, HostConfig: { PortBindings: port ? { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } : {} } }]),
});
const LOCAL_VALKEY = { VALKEY_URL: "redis://127.0.0.1:6380" };

test("the Valkey container is asked of Docker only where a job runs on it, the daemon answered and VALKEY_URL names this host", async () => {
	const reader = async (plan, env = LOCAL_VALKEY) => {
		let args;
		const seen = [];
		await collect({ plan, seen, env, seams: { olderStateFindings: async (a) => ((args = a), []) } });
		return { args, seen };
	};
	const unlabelled = { "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ port: 6380 }) };
	const { args, seen } = await reader(unlabelled);
	assert.equal(seen.some((l) => l.startsWith("docker container inspect")), false, "nothing is spawned until the module asks");
	// The verdict `up` reads: an unlabelled pi-dispatch-valkey publishing VALKEY_URL's port is this deployment's.
	assert.deepEqual(await args.valkeyContainer(), { ours: true, owner: "unlabelled, publishing 127.0.0.1:6380", image: "valkey/valkey:8" });
	assert.deepEqual(seen.filter((l) => l.startsWith("docker container inspect")), ["docker container inspect pi-dispatch-valkey"], "`up`'s container, by up's own inspect");
	assert.equal(args.handedOver, false);
	// No such container, or a record that is not JSON: never ours.
	for (const answer of [1, { code: 0, output: "  \n" }]) assert.notEqual((await (await reader({ ...unlabelled, "docker container inspect": answer })).args.valkeyContainer())?.ours, true);
	// A daemon that did not answer `docker info`, or a VALKEY_URL naming another host or an IPv6 literal (where `up`
	// adds no Valkey): no reader at all, so the module skips the container.
	for (const [plan, env] of [[{ ...unlabelled, "docker info": 1 }, LOCAL_VALKEY], [unlabelled, { VALKEY_URL: "redis://valkey.internal:6380" }], [unlabelled, { VALKEY_URL: "redis://[::1]:6380" }], [unlabelled, {}]]) {
		const off = await reader(plan, env);
		assert.equal(off.args.valkeyContainer, null, JSON.stringify(env));
		assert.equal(off.seen.some((l) => l.startsWith("docker container inspect")), false);
	}
});

// Doctor judges the container by VALKEY_URL's port only where it read VALKEY_URL as the service reads it. Where the `.env`
// line cannot be read, the default stands in; where this shell and `.env` disagree, the port is the shell's. `up`
// refuses both, so a fix ending in `pi-dispatch up` would start no Valkey: docker is not asked.
test("the Valkey container is not asked of Docker when the service's VALKEY_URL line cannot be read and the default stands in", async () => {
	let args;
	const seen = [];
	const plan = { "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ port: 6379 }) };
	const serviceEnvFile = serviceEnvFileOf(Buffer.from("VALKEY_URL=redis://[::1]:16510\n"), "/srv/deploy/.env", "systemd");
	const { checks } = await collect({ plan, seen, env: { VALKEY_URL: undefined }, seams: { serviceEnvFile, olderStateFindings: async (a) => ((args = a), []) } });
	assert.ok(checks.some((c) => /assigns VALKEY_URL in a form this command cannot read/.test(c.label ?? "")), "the line is named");
	assert.equal(args.valkeyContainer, null, "no reader for the default's port");
	assert.equal(seen.some((l) => l.startsWith("docker container inspect")), false);
});

test("the Valkey container is not asked of Docker when this shell and the service's .env set VALKEY_URL differently", async () => {
	const ask = async (file) => {
		let args;
		const serviceEnvFile = serviceEnvFileOf(Buffer.from(file), "/srv/deploy/.env", "systemd");
		await collect({ plan: { "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ port: 6380 }) }, env: LOCAL_VALKEY, seams: { serviceEnvFile, olderStateFindings: async (a) => ((args = a), []) } });
		return args.valkeyContainer;
	};
	assert.equal(await ask("VALKEY_URL=redis://127.0.0.1:6381\n"), null, "the shell's 6380 against the file's 6381");
	// The same value in both is read, and asked about.
	assert.equal(typeof (await ask("VALKEY_URL=redis://127.0.0.1:6380\n")), "function");
});

// The three below are files `up`'s reader (`readValkeyKeys`, under `deploymentValkeyEnv`) refuses on Linux, while doctor
// still has a VALKEY_URL on this host to judge: the default, or this shell's. Each asks docker nothing.
async function containerAskedFor(bytes, env) {
	let args;
	const seen = [];
	const serviceEnvFile = serviceEnvFileOf(bytes, "/srv/deploy/.env", "systemd");
	await collect({ plan: { "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ port: 6380 }) }, seen, env, seams: { serviceEnvFile, olderStateFindings: async (a) => ((args = a), []) } });
	assert.ok(args.valkeyContainer === null || typeof args.valkeyContainer === "function", "a reader, or none");
	const asked = typeof args.valkeyContainer === "function";
	if (asked) await args.valkeyContainer();
	assert.equal(seen.some((l) => l.startsWith("docker container inspect")), asked);
	return asked;
}

test("the Valkey container is not asked of Docker when the service's .env holds a byte systemd refuses to load, anywhere in it", async () => {
	const agreeing = "VALKEY_URL=redis://127.0.0.1:6380\n";
	const loadsNone = [
		["a NUL in another key's value", Buffer.from(`${agreeing}PI_X=a\u0000b\n`)],
		["a NUL in a file that sets no VALKEY_URL", Buffer.from("PI_X=a\u0000b\n")],
		// Decoding turns the byte into U+FFFD, so only a reader of the bytes sees it.
		["invalid UTF-8 in another key's value", Buffer.concat([Buffer.from(`${agreeing}PI_X=a`), Buffer.from([0xff]), Buffer.from("b\n")])],
	];
	for (const [what, bytes] of loadsNone) {
		for (const env of [{ VALKEY_URL: undefined }, LOCAL_VALKEY]) assert.equal(await containerAskedFor(bytes, env), false, `${what}, shell ${env.VALKEY_URL ?? "unset"}`);
	}
	// The same file without the byte is read, and asked about.
	assert.equal(await containerAskedFor(Buffer.from(`${agreeing}PI_X=ab\n`), LOCAL_VALKEY), true);
});

test("the Valkey container is not asked of Docker when this shell sets VALKEY_URL and the .env's VALKEY_URL line cannot be read", async () => {
	assert.equal(await containerAskedFor(Buffer.from("VALKEY_URL=redis://[::1]:16510\n"), LOCAL_VALKEY), false);
	assert.equal(await containerAskedFor(Buffer.from('VALKEY_URL="redis://127.0.0.1:$PORT"\n'), LOCAL_VALKEY), false);
});

test("the Valkey container is not asked of Docker when this shell sets VALKEY_URL and a line of the .env, which spells it, reads differently under systemd", async () => {
	// A lone CR, which systemd reads as a line break: the file's VALKEY_URL agrees with the shell's, and `up` still refuses.
	assert.equal(await containerAskedFor(Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\nA=a\rB=b\n"), LOCAL_VALKEY), false);
	assert.equal(await containerAskedFor(Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\nA=a\nB=b\n"), LOCAL_VALKEY), true);
});

// Through the real older-state.mjs: the container finding is up's rule, so it names only a container this deployment's
// `up` started and still runs itself. Its fix stops and removes the container.
test("state.older names the pi-dispatch-valkey container only where this deployment's up runs it: never another's, never compose's", async () => {
	const older = async (plan, files = {}) => (await collect({ plan, files, env: LOCAL_VALKEY, seams: { olderStateFindings: undefined } })).checks.filter((c) => c.id === "state.older");
	const inspecting = (record) => (dir) => ({ "docker info": 0, "docker image": 0, "docker container inspect": typeof record === "function" ? record(dir) : record });
	// This deployment's, by up's label naming this folder or, unlabelled, by VALKEY_URL's port: the finding.
	for (const record of [(dir) => valkeyRecord({ label: dir }), valkeyRecord({ port: 6380 })]) {
		const found = await older(inspecting(record));
		assert.equal(found.length, 1);
		assert.match(found[0].label, /^the pi-dispatch-valkey container runs valkey\/valkey:8, the floating tag an older `pi-dispatch up` started it with/);
		assert.match(found[0].fix, /^`docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey && pi-dispatch up`/);
	}
	// Another deployment's (its label), or one nothing ties to this folder (unlabelled, publishing no port, or another one,
	// as `docker run --network none` leaves it): no finding, so no command that would stop and remove it.
	for (const record of [valkeyRecord({ label: "/srv/other" }), valkeyRecord({}), valkeyRecord({ port: 6379 })]) assert.deepEqual(await older(inspecting(record)), [], record.output);
	// This deployment's, in a folder handed to compose: compose runs the Valkey, so the container is not up's to name.
	assert.deepEqual(await older(inspecting((dir) => valkeyRecord({ label: dir })), { "deploy/docker-compose.valkey.yml": "services: {}\n" }), []);
	// This release's image: nothing.
	assert.deepEqual(await older(inspecting((dir) => valkeyRecord({ label: dir, image: "valkey/valkey:8.1" }))), []);
});

// `up` labels its container with the folder's REAL path (a symlinked or macOS temp folder differs from the path given),
// and doctor's reader judges the label against both, as `up` does.
test("state.older names a container up labelled with the deployment folder's real path, the folder given through a symlink", async () => {
	for (const symlinked of [false, true]) {
		const { checks, dir } = await collect({ symlinked, env: LOCAL_VALKEY, seams: { olderStateFindings: undefined }, plan: (cwd) => ({ "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ label: realpathSync(cwd) }) }) });
		if (symlinked) assert.notEqual(realpathSync(dir), dir, "the folder given is not its real path");
		const found = checks.filter((c) => c.id === "state.older");
		assert.equal(found.length, 1, `symlinked: ${symlinked}`);
		assert.match(found[0].label, /^the pi-dispatch-valkey container runs valkey\/valkey:8,/);
	}
});

// The deployment beside an older compose copy whose Valkey is up's container: both lines fire, and the compose line's fix
// only changes the image line, since recreating compose's valkey would start a second, empty Valkey.
test("state.older beside up's container: the compose file's fix changes its line and recreates nothing", async () => {
	const compose = { "deploy/docker-compose.yml": "services:\n  valkey:\n    image: valkey/valkey:8\n" };
	const { checks } = await collect({ files: compose, env: LOCAL_VALKEY, seams: { olderStateFindings: undefined }, plan: (cwd) => ({ "docker info": 0, "docker image": 0, "docker container inspect": valkeyRecord({ label: cwd }) }) });
	const found = checks.filter((c) => c.id === "state.older");
	assert.equal(found.length, 2);
	assert.match(found[0].fix, /^change that line to `image: valkey\/valkey:8\.1` \(the installed package's deploy\/docker-compose\.yml has it\) and nothing more: /);
	assert.doesNotMatch(found[0].fix, /up -d valkey/);
	assert.match(found[1].fix, /^`docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey && pi-dispatch up`/);
});

test("the default older-state read never throws, and an empty deployment folder holds nothing older", async () => {
	const { checks } = await collect({ seams: { olderStateFindings: undefined } });
	assert.equal(checks.some((c) => c.id === "state.older"), false);
});
