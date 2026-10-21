import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_ENV_KEYS, consoleChecks, consoleListenOf, consoleServiceChecks } from "../src/doctor.mjs";
import { runService } from "../src/service.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { addToken } from "../src/console-tokens.mjs";
import { makeConsoleAudit } from "../src/console-audit.mjs";
import { serviceEnvFileOf, serviceEnvLoader } from "../src/service-env.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Doctor's console lines (issue #640). Nothing for a deployment that never set the console up; otherwise the tokens
// file, its operators, where it lies against the folders a job can see, the listen address and the audit chain.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const posix = process.platform !== "win32";
let seed = 0;
const random = (n) => Buffer.alloc(n, ++seed);

/** A deployment folder with a logs dir of its own, so no line reads the developer's real logs. */
function deployment() {
	const cwd = tempDir("pd-doctor-console-");
	const logs = join(cwd, "logs");
	return { cwd, logs, env: { PI_LOGS_DIR: logs }, tokens: join(cwd, "console-tokens.json") };
}
function withToken(d, role = "operator", name = "alice") {
	const r = addToken({ path: d.tokens, name, role, now: () => T0, random });
	assert.ok(r.token, r.invalid);
}
const labels = (checks) => checks.map((c) => `${c.ok ? "ok" : c.warn ? "warn" : "fail"} ${c.label}`);

test("no tokens file and no PI_CONSOLE_* key: no console line at all", () => {
	const d = deployment();
	assert.deepEqual(consoleChecks(d.env, { cwd: d.cwd }), []);
	// An empty value is unset, as the console reads it.
	assert.deepEqual(consoleChecks({ ...d.env, PI_CONSOLE_LISTEN: "" }, { cwd: d.cwd }), []);
});

test("a set-up console with one operator: the tokens file and the default listen address, both ok", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	withToken(d, "viewer", "bob");
	const checks = consoleChecks(d.env, { cwd: d.cwd });
	assert.deepEqual(labels(checks), [
		`ok console: tokens file ${JSON.stringify(d.tokens)} is owner-only and outside every job folder (1 operator, 1 viewer)`,
		"ok console: listens on 127.0.0.1:4790 (the default)",
	]);
});

test("a key set but no tokens file: fail, with the token add command as the fix", () => {
	const d = deployment();
	const checks = consoleChecks({ ...d.env, PI_CONSOLE_READ_ONLY: "1" }, { cwd: d.cwd });
	const c = checks[0];
	assert.equal(c.ok, false);
	assert.equal(c.warn, undefined);
	assert.match(c.label, /^console: the tokens file .* cannot be used, so `pi-dispatch-console serve` refuses to start$/);
	assert.match(c.fix, /does not exist.*pi-dispatch-console token add --name <name> --role operator/);
});

test("PI_CONSOLE_TOKENS_FILE is resolved against the deployment folder", () => {
	const d = deployment();
	const checks = consoleChecks({ ...d.env, PI_CONSOLE_TOKENS_FILE: "conf/tokens.json" }, { cwd: d.cwd });
	assert.ok(checks[0].label.includes(JSON.stringify(join(d.cwd, "conf/tokens.json"))), checks[0].label);
});

test("a group- or world-readable tokens file fails with chmod 600 as the fix", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	chmodSync(d.tokens, 0o644);
	const [c] = consoleChecks(d.env, { cwd: d.cwd });
	assert.equal(c.ok, false);
	assert.match(c.fix, /chmod 600/);
});

test("a tokens file with no operator fails: nobody could make a change", { skip: !posix }, () => {
	const d = deployment();
	withToken(d, "viewer", "bob");
	const [c] = consoleChecks(d.env, { cwd: d.cwd });
	assert.equal(c.ok, false);
	assert.match(c.label, /holds no operator token, so nobody can make a change from the console/);
	assert.equal(c.fix, "run `pi-dispatch-console token add --name <you> --role operator`");
});

test("a tokens file inside a local trigger's run.folder fails, naming why a job could reach it", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	const checks = consoleChecks(d.env, { cwd: d.cwd, folders: [d.cwd] });
	const c = checks.find((x) => /lies inside/.test(x.label));
	assert.ok(c, labels(checks).join("\n"));
	assert.equal(c.ok, false);
	assert.match(c.label, /lies inside a local trigger's run\.folder \(.*\), which a job container can see: a job there could read the token hashes or add a token of its own/);
	assert.match(c.fix, /point PI_CONSOLE_TOKENS_FILE at its new path/);
	// The folder above counts as well, and so do the overlay and an absolute run root; a sibling does not.
	assert.ok(consoleChecks(d.env, { cwd: d.cwd, folders: [join(d.cwd, "..")] }).some((x) => /lies inside/.test(x.label)));
	assert.ok(consoleChecks({ ...d.env, PI_GLOBAL_PI_DIR: d.cwd }, { cwd: d.cwd }).some((x) => /lies inside PI_GLOBAL_PI_DIR/.test(x.label)));
	assert.ok(consoleChecks({ ...d.env, PI_DISPATCH_RUN_ROOTS: d.cwd }, { cwd: d.cwd }).some((x) => /lies inside a PI_DISPATCH_RUN_ROOTS root/.test(x.label)));
	const sibling = tempDir("pd-doctor-console-sib-");
	assert.ok(!consoleChecks(d.env, { cwd: d.cwd, folders: [sibling] }).some((x) => /lies inside/.test(x.label)));
});

test("a tokens file inside a trigger's run.skillsDir fails, and so does one with a second hard link", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	const skills = consoleChecks(d.env, { cwd: d.cwd, skillsDirs: [d.cwd] }).find((x) => /lies inside/.test(x.label));
	assert.ok(skills);
	assert.equal(skills.ok, false);
	assert.match(skills.label, /lies inside a trigger's run\.skillsDir \(/);
	// Another name of the same file could sit in a job folder where no path check looks.
	linkSync(d.tokens, join(d.cwd, "other-name.json"));
	const linked = consoleChecks(d.env, { cwd: d.cwd }).find((x) => /hard links/.test(x.label));
	assert.ok(linked, labels(consoleChecks(d.env, { cwd: d.cwd })).join("\n"));
	assert.equal(linked.ok, false);
	assert.match(linked.label, /has 2 hard links: another name of the file could sit inside a folder a job can see/);
	assert.match(linked.fix, /find \/ -samefile/);
});

test("PI_CONSOLE_BIND_PUBLIC=1 warns; a non-loopback listen without it, or an unparseable one, fails", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	const pub = consoleChecks({ ...d.env, PI_CONSOLE_LISTEN: "0.0.0.0:4790", PI_CONSOLE_BIND_PUBLIC: "1" }, { cwd: d.cwd });
	assert.deepEqual(labels(pub).slice(1), [
		"ok console: listens on 0.0.0.0:4790",
		"warn console: PI_CONSOLE_BIND_PUBLIC=1 lets the console listen on a non-loopback address, where tokens and session cookies cross the network in plain HTTP",
	]);
	const closed = consoleChecks({ ...d.env, PI_CONSOLE_LISTEN: "192.168.1.5:4790" }, { cwd: d.cwd });
	assert.equal(labels(closed)[1], 'fail console: PI_CONSOLE_LISTEN "192.168.1.5:4790" is not a loopback address, so `pi-dispatch-console serve` refuses to start');
	const bad = consoleChecks({ ...d.env, PI_CONSOLE_LISTEN: "localhost:4790" }, { cwd: d.cwd });
	assert.match(labels(bad)[1], /^fail console: PI_CONSOLE_LISTEN "localhost:4790" cannot be used, so `pi-dispatch-console serve` refuses to start: localhost is not an IP literal/);
	assert.equal(labels(consoleChecks({ ...d.env, PI_CONSOLE_LISTEN: "[::1]:4790" }, { cwd: d.cwd }))[1], "ok console: listens on [::1]:4790");
});

test("consoleListenOf reads PI_CONSOLE_LISTEN as the console's own parseListen does", async () => {
	// The worker cannot import the admin, so doctor keeps its own reading; this compares the two verdicts input by input.
	const listenPath = new URL("../../admin/src/console/listen.mjs", import.meta.url);
	const samples = ["127.0.0.1:4790", "127.9.9.9:1", "[::1]:4790", "[::1]", "::1:4790", "0.0.0.0:4790", "10.0.0.1:80", "[fe80::1]:80", "localhost:4790", "127.0.0.1", "127.0.0.1:65536", "127.0.0.1:0", "127.0.0.1:-1", "unix:/tmp/pd.sock", "unix:relative.sock", `unix:/${"a".repeat(102)}`, `unix:/${"a".repeat(106)}`, "[::ffff:127.0.0.1]:80", " 127.0.0.1:4790 "];
	for (const platform of ["darwin", "linux"]) {
		for (const v of samples) {
			const ours = consoleListenOf(v, platform);
			const verdict = ours.refusal ? "refused" : ours.loopback ? "loopback" : "public";
			if (existsSync(listenPath)) {
				const { parseListen } = await import(listenPath.href);
				const theirs = parseListen(v, { bindPublic: false, platform }).refusal ? (parseListen(v, { bindPublic: true, platform }).refusal ? "refused" : "public") : "loopback";
				assert.equal(verdict, theirs, `${platform} ${JSON.stringify(v)}`);
			}
		}
	}
	assert.equal(consoleListenOf(undefined).shown, "127.0.0.1:4790 (the default)");
});

test("consoleListenOf and the console's own settings read agree, unset, empty and whitespace-only values included", async () => {
	// parseListen alone never sees an unset value: the console's settings read (`consoleConfig`) trims PI_CONSOLE_LISTEN
	// and puts the default in for an empty result, so whitespace-only is the default there. Doctor must say the same,
	// or it reports a default the console refuses (or the reverse). Compared at that level, not at parseListen's.
	const configPath = new URL("../../admin/src/console/config.mjs", import.meta.url);
	const samples = [undefined, "", "   ", "\t", " \t ", "127.0.0.1:4790", " [::1]:4790 ", "0.0.0.0:4790", "localhost:4790", "unix:/tmp/pd.sock", "unix:relative.sock"];
	for (const v of ["   ", "\t", " \t "]) assert.equal(consoleListenOf(v).shown, "127.0.0.1:4790 (the default)", JSON.stringify(v));
	if (!existsSync(configPath)) return;
	const { consoleConfig } = await import(configPath.href);
	for (const platform of ["darwin", "linux"]) {
		for (const v of samples) {
			const ours = consoleListenOf(v, platform);
			const verdict = ours.refusal ? "refused" : ours.loopback ? "loopback" : "public";
			const env = v === undefined ? {} : { PI_CONSOLE_LISTEN: v };
			const read = (extra) => consoleConfig({ env: { ...env, ...extra }, dir: "/srv/pd", platform });
			const theirs = read({}).refusal ? (read({ PI_CONSOLE_BIND_PUBLIC: "1" }).refusal ? "refused" : "public") : "loopback";
			assert.equal(verdict, theirs, `${platform} ${JSON.stringify(v)}`);
		}
	}
});

test("the audit chain: nothing while empty, ok when intact, a warning naming the broken link", { skip: !posix }, () => {
	const d = deployment();
	withToken(d);
	assert.ok(!consoleChecks(d.env, { cwd: d.cwd }).some((c) => /audit/.test(c.label)), "no row yet, no line");
	const audit = makeConsoleAudit({ logsDir: d.logs, now: () => T0 });
	for (const target of ["a", "b", "c"]) audit.append({ actor: { name: "alice", role: "operator", session: "s" }, action: "write", target, outcome: "ok" });
	assert.equal(labels(consoleChecks(d.env, { cwd: d.cwd })).at(-1), "ok console: audit log chain intact (3 rows)");
	const file = join(d.logs, "console-audit", "2026-10.jsonl");
	writeFileSync(file, readFileSync(file, "utf8").replace('"target":"b"', '"target":"B"'));
	const last = consoleChecks(d.env, { cwd: d.cwd }).at(-1);
	assert.equal(last.ok, false);
	assert.equal(last.warn, true, "a broken chain warns: the console still runs, and the operator decides");
	assert.match(last.label, /^console: the audit log chain is broken at 2026-10\.jsonl line 3: prev does not match the row before it/);
	assert.match(last.fix, /pi-dispatch-console audit verify/);
});

test("collectChecks: no console line for a deployment without one, and the console keys read from the deployment .env", { skip: !posix }, async () => {
	const d = deployment();
	const spawn = () => {
		const handlers = {};
		const stream = () => ({ on() { return this; } });
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => handlers.close?.(1));
		return child;
	};
	const seams = (extra = {}) => ({ out: () => {}, cwd: d.cwd, home: d.cwd, spawn, probeValkey: async () => false, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8"), ...extra });
	const none = await collectChecks({ ...d.env, PI_PROVIDER: "anthropic" }, seams());
	assert.deepEqual(none.filter((c) => c.label.startsWith("console:")), []);

	mkdirSync(d.logs, { recursive: true });
	const envText = "PI_CONSOLE_LISTEN=0.0.0.0:4790\n";
	writeFileSync(join(d.cwd, ".env"), envText);
	const file = serviceEnvFileOf(Buffer.from(envText), join(d.cwd, ".env"), serviceEnvLoader(process.platform));
	const some = await collectChecks({ ...d.env, PI_PROVIDER: "anthropic" }, seams({ serviceEnvFile: file }));
	const lines = labels(some.filter((c) => c.label.startsWith("console:")));
	assert.equal(lines.length, 2, lines.join("\n"));
	assert.match(lines[0], /^fail console: the tokens file .* cannot be used/);
	assert.equal(lines[1], 'fail console: PI_CONSOLE_LISTEN "0.0.0.0:4790" is not a loopback address, so `pi-dispatch-console serve` refuses to start');
	// This shell's value wins over the file's, as the console itself reads it.
	const shell = await collectChecks({ ...d.env, PI_PROVIDER: "anthropic", PI_CONSOLE_LISTEN: "[::1]:4790" }, seams({ serviceEnvFile: file }));
	assert.ok(shell.some((c) => c.label === "console: listens on [::1]:4790"));
});

test("collectChecks: the console lines judge the tokens file against the triggers file's local run.folder and run.skillsDir", { skip: !posix }, async () => {
	const d = deployment();
	withToken(d);
	const spawn = () => {
		const handlers = {};
		const stream = () => ({ on() { return this; } });
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => handlers.close?.(1));
		return child;
	};
	const seams = { out: () => {}, cwd: d.cwd, home: d.cwd, spawn, probeValkey: async () => false, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") };
	// The triggers file lives elsewhere, so only what it NAMES can put the deployment folder in a job's view.
	const conf = tempDir("pd-doctor-console-conf-");
	const elsewhere = tempDir("pd-doctor-console-elsewhere-");
	const triggers = (run) => {
		const path = join(conf, `triggers-${Object.keys(run).join("-")}.json`);
		writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", flow: "review", task: "t", ...run } }] }));
		return path;
	};
	const insideLine = async (run) => {
		const checks = await collectChecks({ ...d.env, PI_PROVIDER: "anthropic", PI_TRIGGERS_FILE: triggers(run) }, seams);
		return checks.find((c) => c.label.startsWith("console:") && /lies inside/.test(c.label));
	};
	const folder = await insideLine({ folder: d.cwd });
	assert.ok(folder, "a local trigger's run.folder holding the tokens file is reported");
	assert.equal(folder.ok, false);
	assert.match(folder.label, /lies inside a local trigger's run\.folder/);
	const skills = await insideLine({ folder: elsewhere, skillsDir: d.cwd });
	assert.ok(skills, "a trigger's run.skillsDir holding the tokens file is reported");
	assert.match(skills.label, /lies inside a trigger's run\.skillsDir/);
	assert.equal(await insideLine({ folder: elsewhere }), undefined, "a folder elsewhere is fine");
});

test("CONSOLE_ENV_KEYS is the contract's PI_CONSOLE_* set", () => {
	assert.deepEqual([...CONSOLE_ENV_KEYS].sort(), ["PI_CONSOLE_ALLOWED_HOSTS", "PI_CONSOLE_BIND_PUBLIC", "PI_CONSOLE_IDLE_MINUTES", "PI_CONSOLE_LISTEN", "PI_CONSOLE_MAX_HOURS", "PI_CONSOLE_MAX_STREAMS", "PI_CONSOLE_READ_ONLY", "PI_CONSOLE_TOKENS_FILE"]);
});

// Issue #708: whether a service unit keeps this deployment's console running, and whether the console answers.

/** The console unit `service render --console` writes for `cwd`, on `platform`: the real render, so doctor reads what install writes. */
async function renderedConsoleUnit(platform, cwd) {
	const out = [];
	const code = await runService(["render", "--console"], { platform, cwd, home: "/home/t", execPath: "/n/bin/node", resolveConsole: () => "/pkg/dist/console.mjs", out: (s) => out.push(s), err: () => {}, env: {}, findBin: () => null });
	assert.equal(code, 0);
	return out.join("");
}

const RUNNING = async () => ({ state: "running", target: "127.0.0.1:4790" });
const DOWN = async () => ({ state: "not-running", target: "127.0.0.1:4790", reason: "nothing listens there" });

test("consoleServiceChecks: a unit for this deployment and the console answering is ok; installed but not answering fails", async () => {
	for (const [platform, path] of [["linux", "/home/t/.config/systemd/user/pi-dispatch-console.service"], ["darwin", "/home/t/Library/LaunchAgents/com.pi-dispatch.console.plist"]]) {
		const cwd = "/srv/deploy";
		const text = await renderedConsoleUnit(platform, cwd);
		const seams = { platform, cwd, home: "/home/t", fileExists: (p) => p === path, readUnit: (p) => (p === path ? text : assert.fail(`read ${p}`)) };
		assert.deepEqual(labels(await consoleServiceChecks({}, { ...seams, consoleProbe: RUNNING })), [`ok console: the service ${JSON.stringify(path)} keeps it running, and it answers on 127.0.0.1:4790`], platform);
		const down = await consoleServiceChecks({}, { ...seams, consoleProbe: DOWN });
		assert.deepEqual(labels(down), [`fail console: the service ${JSON.stringify(path)} is installed for this deployment, but nothing answers on 127.0.0.1:4790 (nothing listens there)`], platform);
		assert.match(down[0].fix, /pi-dispatch service status --console/);
		assert.match(down[0].fix, /console-audit\/\.console\.lock can name a pid another process has since taken.*remove the lock/, "the stale-lock case after a crash");
		assert.match(down[0].fix, platform === "linux" ? /journalctl --user -u pi-dispatch-console/ : /\/srv\/deploy\/logs\/console\.err\.log/);
		// A unit of ANOTHER deployment's folder is not this one's.
		const elsewhere = await consoleServiceChecks({}, { ...seams, cwd: "/srv/other", consoleProbe: DOWN });
		assert.equal(elsewhere[0].warn, true, `${platform}: no unit for this folder, so a warning`);
	}
});

test("consoleServiceChecks: no unit warns while nothing runs, and is ok (started by hand) while the console answers", async () => {
	const seams = { platform: "linux", cwd: "/srv/deploy", home: "/home/t", fileExists: () => false };
	const none = await consoleServiceChecks({}, { ...seams, consoleProbe: DOWN });
	assert.deepEqual(labels(none), ["warn console: not running on 127.0.0.1:4790 (nothing listens there), and no service unit keeps it running"]);
	assert.match(none[0].fix, /pi-dispatch service install --console/);
	assert.match(none[0].fix, /pi-dispatch-console serve/);
	assert.deepEqual(labels(await consoleServiceChecks({}, { ...seams, consoleProbe: RUNNING })), ["ok console: answers on 127.0.0.1:4790, started by hand (no service unit for this deployment, so it stops with the terminal that runs it)"]);
});

test("consoleServiceChecks: the probe is asked with the resolved env, an unknown answer is said, and an unusable listen asks nothing", async () => {
	const seams = { platform: "linux", cwd: "/srv/deploy", home: "/home/t", fileExists: () => false };
	const asked = [];
	const probe = async (env) => (asked.push(env.PI_CONSOLE_LISTEN), { state: "unknown", reason: "PI_CONSOLE_LISTEN asks for port 0" });
	assert.deepEqual(labels(await consoleServiceChecks({ PI_CONSOLE_LISTEN: "127.0.0.1:0" }, { ...seams, consoleProbe: probe })), ["ok console: no service unit keeps it running; whether it answers is not checked (PI_CONSOLE_LISTEN asks for port 0)"]);
	assert.deepEqual(asked, ["127.0.0.1:0"]);
	for (const listen of ["localhost:4790", "0.0.0.0:4790"]) {
		assert.deepEqual(await consoleServiceChecks({ PI_CONSOLE_LISTEN: listen }, { ...seams, consoleProbe: () => assert.fail("probed") }), [], `${listen}: consoleChecks already fails it`);
	}
	const threw = await consoleServiceChecks({}, { ...seams, consoleProbe: async () => { throw new Error("boom"); } });
	assert.match(threw[0].label, /whether it answers is not checked \(the probe failed \(boom\)\)/);
});

test("consoleServiceChecks on win32: the nssm service by name", async () => {
	const spawnFor = (code) => () => {
		const handlers = {};
		const stream = () => ({ on() { return this; } });
		queueMicrotask(() => handlers.close?.(code));
		return { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
	};
	const seams = { platform: "win32", cwd: "C:\\deploy", home: "C:\\Users\\t" };
	assert.match((await consoleServiceChecks({}, { ...seams, spawn: spawnFor(0), consoleProbe: DOWN }))[0].label, /^console: the service "pi-dispatch-console" is installed/);
	assert.equal((await consoleServiceChecks({}, { ...seams, spawn: spawnFor(3), consoleProbe: DOWN }))[0].warn, true);
});

test("collectChecks: the console's service line follows its other lines, and a deployment without a console is never probed", { skip: !posix }, async () => {
	const d = deployment();
	const spawn = () => {
		const handlers = {};
		const stream = () => ({ on() { return this; } });
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => handlers.close?.(1));
		return child;
	};
	let probes = 0;
	const seams = (consoleProbe) => ({ out: () => {}, cwd: d.cwd, home: d.cwd, spawn, probeValkey: async () => false, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8"), consoleProbe: async (env) => (probes++, consoleProbe(env)) });
	const none = await collectChecks({ ...d.env, PI_PROVIDER: "anthropic" }, seams(RUNNING));
	assert.deepEqual(none.filter((c) => c.label.startsWith("console:")), []);
	assert.equal(probes, 0);
	withToken(d);
	const lines = labels((await collectChecks({ ...d.env, PI_PROVIDER: "anthropic" }, seams(DOWN))).filter((c) => c.label.startsWith("console:")));
	assert.equal(lines.at(-1), "warn console: not running on 127.0.0.1:4790 (nothing listens there), and no service unit keeps it running");
	assert.equal(probes, 1);
});
