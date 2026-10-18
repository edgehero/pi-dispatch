import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childEnv, copySnapshot, ensurePrivateDir, FORK_SOURCE_MAX_BYTES, forkModelOf, hostDefaultsOf, PI_VERSION_FILE, piVersionOf, planFork, resolvePiBinary, runFork, SESSION_FILE, sessionModelOf, VENUE_FILE, VENUE_PENDING } from "../src/chat-fork.mjs";
import { sessionKeyOfRecord } from "../src/session-key.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #647: the terminal chat's host-local fork, against a real session-store layout on disk and a fake pi binary
// (a shell script that records its argv and working directory). The canonical transcript must come out byte- and
// mtime-identical, and every refusal is a sentence before anything is copied.

const RECORD = Object.freeze({ kind: "github", target: "o/r#7", jobId: "j1", triggerType: "label", endedAt: "2026-10-01T10:00:00.000Z" });
const KEY = sessionKeyOfRecord(RECORD);
const TRANSCRIPT = `${JSON.stringify({ type: "session", timestamp: "2026-10-01T09:00:00.000Z" })}\n${JSON.stringify({ type: "message", text: "secret-ish content" })}\n`;
const ENDED_MS = Date.parse(RECORD.endedAt);

/** A session store holding `KEY` with a transcript, a pi-version stamp and a venue stamp, plus a home and a fake pi. */
function world({ stamp = "1.2.0", venue = "local", piVersion = "1.2.0", transcript = TRANSCRIPT } = {}) {
	const root = tempDir("chat-fork-");
	const sessions = join(root, "sessions");
	const dir = join(sessions, KEY);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, SESSION_FILE);
	writeFileSync(file, transcript);
	// The transcript was promoted when its run ended, as the store's rename leaves it.
	utimesSync(file, new Date(ENDED_MS), new Date(ENDED_MS));
	if (stamp !== null) writeFileSync(join(dir, PI_VERSION_FILE), `${stamp}\n`);
	if (venue !== null) writeFileSync(join(dir, VENUE_FILE), `${venue}\n`);
	const home = join(root, "home");
	mkdirSync(home);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "pi.log");
	const pi = join(bin, "pi");
	// The fake pi records its cwd and argv, what it was handed to fork (bytes and mode), and every PI_CONSOLE_* variable
	// it can see, for `--version` and for the fork alike.
	writeFileSync(pi, `#!/bin/sh\nif [ "$1" = "--version" ]; then env | grep '^PI_CONSOLE_' > "${root}/version-env.log"; echo "${piVersion}"; exit 0; fi\npwd > "${log}"\nfor a in "$@"; do echo "$a" >> "${log}"; done\ncat "$2" > "${root}/handed.jsonl"\nls -l "$2" | cut -c1-10 > "${root}/handed.mode"\nls -ld "$(dirname "$2")" | cut -c1-10 > "${root}/handed.dirmode"\nenv | grep -E '^(PI_CONSOLE_|KEEP_ME)' > "${root}/fork-env.log"\nexit 3\n`);
	chmodSync(pi, 0o755);
	const work = join(root, "work");
	mkdirSync(work);
	return { root, sessions, dir, file, home, bin, pi, log, work, env: { PI_SESSIONS_DIR: sessions } };
}

const plan = (w, extra = {}) => planFork({ record: RECORD, env: w.env, pi: { path: w.pi }, piVersion: "1.2.0", ...extra });

test("the session store's names are the ones session-store.mjs writes", () => {
	const store = readFileSync(new URL("../src/session-store.mjs", import.meta.url), "utf8");
	assert.match(store, new RegExp(`export const SESSION_FILE_NAME = "${SESSION_FILE}";`));
	assert.match(store, new RegExp(`const PI_VERSION_FILE = "${PI_VERSION_FILE}";`));
	assert.match(store, new RegExp(`const VENUE_FILE = "${VENUE_FILE}";`));
	assert.match(store, new RegExp(`const VENUE_PENDING = "\\${VENUE_PENDING.slice(0, -1)}\\)";`));
});

test("a fork is refused, in order, for no session, a pull request, an underivable key and an unset PI_SESSIONS_DIR", () => {
	const w = world();
	assert.match(plan(w, { record: { ...RECORD, kind: "cli" } }).refusal, /no session to fork: only a forge issue's runs and a cron trigger's runs/);
	assert.match(plan(w, { record: { ...RECORD, triggerType: "pull_request" } }).refusal, /pull or merge request/);
	assert.match(plan(w, { record: { ...RECORD, kind: "gitlab", target: "o/r!4" } }).refusal, /pull or merge request/);
	assert.match(plan(w, { record: { ...RECORD, target: "o/r" } }).refusal, /names no issue number or cron trigger id/);
	assert.match(plan(w, { record: { kind: "local", jobId: "local:abc" } }).refusal, /names no issue number or cron trigger id/);
	assert.match(plan(w, { env: {} }).refusal, /PI_SESSIONS_DIR is not set/);
	assert.match(planFork({ key: "nothex", env: w.env, pi: { path: w.pi } }).refusal, /32 lowercase hex/);
});

test("the key's folder and transcript must exist, be plain, and be within the cap", () => {
	const w = world();
	assert.match(planFork({ key: "0".repeat(32), env: w.env, pi: { path: w.pi }, piVersion: "1.2.0" }).refusal, /there is no session 0{32}/);
	// A folder planted as a link to another key's is not followed.
	const other = "1".repeat(32);
	symlinkSync(w.dir, join(w.sessions, other));
	assert.match(planFork({ key: other, env: w.env, pi: { path: w.pi }, piVersion: "1.2.0" }).refusal, /not a plain directory/);
	const linked = world();
	const elsewhere = join(linked.root, "elsewhere.jsonl");
	writeFileSync(elsewhere, TRANSCRIPT);
	unlinkSync(linked.file);
	symlinkSync(elsewhere, linked.file);
	assert.match(plan(linked).refusal, /is a symbolic link/);
	const empty = world();
	writeFileSync(empty.file, "");
	assert.match(plan(empty).refusal, /is empty/);
	const big = world();
	truncateSync(big.file, FORK_SOURCE_MAX_BYTES + 1);
	assert.match(plan(big).refusal, /over the 67108864-byte limit/);
	const dirAsFile = world();
	unlinkSync(dirAsFile.file);
	mkdirSync(dirAsFile.file);
	assert.match(plan(dirAsFile).refusal, /not a regular file/);
	rmSync(dirAsFile.file, { recursive: true });
	assert.match(plan(dirAsFile).refusal, /has no transcript/);
});

test("a pending venue, a missing pi, and pi-version stamps: older noted, newer or unreadable refused without --force", () => {
	assert.match(plan(world({ venue: VENUE_PENDING })).refusal, /a promotion is replacing/);
	assert.match(plan(world(), { pi: { refusal: "no pi to run: install pi" } }).refusal, /no pi to run/);
	assert.match(plan(world({ stamp: null })).refusal, /no readable pi-version stamp.*--force/);
	assert.match(plan(world({ stamp: "1.2" })).refusal, /no readable pi-version stamp/);
	assert.match(plan(world(), { piVersion: null }).refusal, /could not be read \(pi --version\)/);
	assert.match(plan(world({ stamp: "1.3.0" })).refusal, /written by pi 1\.3\.0, newer than your pi 1\.2\.0/);
	assert.deepEqual(plan(world({ stamp: "1.3.0" }), { force: true }).plan.notes, ["written by pi 1.3.0, newer than your pi 1.2.0 (--force)"]);
	assert.deepEqual(plan(world({ stamp: null }), { force: true }).plan.notes, ["its pi-version stamp is unreadable (--force)"]);
	assert.deepEqual(plan(world({ stamp: "1.1.9" })).plan.notes, ["written by pi 1.1.9; your pi 1.2.0 is newer, and pi reads older sessions"]);
	assert.deepEqual(plan(world()).plan.notes, []);
});

test("a newer run sharing the session is warned about, from the console's flag or a promotion after this run ended", () => {
	const w = world();
	assert.deepEqual(plan(w).plan.warnings, []);
	assert.match(plan(w, { newerRunOnTarget: "j2" }).plan.warnings[0], /a newer run on o\/r#7 \(j2\) shares this session/);
	assert.deepEqual(plan(w, { newerRunOnTarget: `j2${"\u001b"}[2J` }).plan.warnings, [], "a value that is not a job id is not a newer run");
	utimesSync(w.file, new Date(ENDED_MS + 3_600_000), new Date(ENDED_MS + 3_600_000));
	assert.equal(plan(w).plan.warnings.length, 1);
});

test("the fork copies to a 0600 snapshot outside the store, leaves the canonical file byte- and mtime-identical, and runs pi --fork --no-tools in the operator's folder", async () => {
	const w = world();
	const before = { bytes: readFileSync(w.file), mtime: statSync(w.file).mtimeMs };
	const p = plan(w).plan;
	const out = [];
	const asked = [];
	const spawned = [];
	const spawn = (cmd, args, opts) => {
		spawned.push({ cmd, args, opts });
		return nodeSpawn(cmd, args, { ...opts, stdio: "ignore" });
	};
	const agentDir = join(w.root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-x" }));
	mkdirSync(join(w.work, ".pi"), { recursive: true });
	writeFileSync(join(w.work, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "attacker", defaultModel: "attacker-model" }));
	const code = await runFork({ canAsk: true, plan: p, out: (l) => out.push(l), ask: async (q) => (asked.push(q), true), agentDir, cwd: w.work, home: w.home, now: () => 1234, spawn, proc: new EventEmitter() });
	assert.equal(code, 3, "pi's own exit code");
	assert.deepEqual(readFileSync(w.file), before.bytes);
	assert.equal(statSync(w.file).mtimeMs, before.mtime);
	const snapshot = join(w.home, ".pi-dispatch", "chat", KEY, "source-1234.jsonl");
	assert.deepEqual(readFileSync(join(w.root, "handed.jsonl")), before.bytes, "pi was handed the copy, byte for byte");
	assert.equal(readFileSync(join(w.root, "handed.mode"), "utf8").trim(), "-rw-------");
	assert.ok(!existsSync(snapshot), "the copy is removed once pi exits (pi keeps its own fork)");
	for (const d of [join(w.home, ".pi-dispatch"), join(w.home, ".pi-dispatch", "chat")]) assert.equal(lstatSync(d).mode & 0o777, 0o700, d);
	assert.equal(readFileSync(join(w.root, "handed.dirmode"), "utf8").trim(), "drwx------", "the key's folder was 0700 while pi ran");
	assert.ok(!existsSync(join(w.home, ".pi-dispatch", "chat", KEY)), "and is removed with the copy once empty");
	assert.ok(!snapshot.startsWith(w.sessions));
	assert.equal(spawned[0].opts.stdio, "inherit");
	assert.equal(spawned[0].opts.cwd, w.work);
	const [cwd, ...argv] = readFileSync(w.log, "utf8").trim().split("\n");
	assert.equal(statSync(cwd).ino, statSync(w.work).ino);
	assert.deepEqual(argv, ["--fork", snapshot, "--provider", "anthropic", "--model", "claude-x", "--no-tools"]);
	assert.match(asked[0], /to anthropic \(model claude-x, your pi's default, passed to pi as --provider and --model\)/);
	assert.match(out.join("\n"), new RegExp(`${TRANSCRIPT.length} bytes`));
	assert.match(out.join("\n"), /UNREDACTED/);
	assert.match(out.join("\n"), /NOT the job's workspace, with its tools off/);
	assert.ok(!out.join("\n").includes("secret-ish content"), "the transcript's text is never printed");
});

test("--tools drops --no-tools; a no removes the copy and runs nothing; a chat folder inside the store is refused", async () => {
	const w = world();
	const spawnIgnore = (cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: "ignore" });
	await runFork({ canAsk: true, plan: plan(w).plan, out: () => {}, ask: async () => true, cwd: w.work, home: w.home, tools: true, now: () => 1, spawn: spawnIgnore, proc: new EventEmitter() });
	assert.deepEqual(readFileSync(w.log, "utf8").trim().split("\n").slice(1), ["--fork", join(w.home, ".pi-dispatch", "chat", KEY, "source-1.jsonl")]);
	const n = world();
	let ran = 0;
	const out = [];
	const code = await runFork({ canAsk: true, plan: plan(n).plan, out: (l) => out.push(l), ask: async () => false, cwd: n.work, home: n.home, now: () => 2, spawn: () => (ran += 1), proc: new EventEmitter() });
	assert.equal(code, 0);
	assert.equal(ran, 0);
	assert.ok(!existsSync(join(n.home, ".pi-dispatch", "chat", KEY)), "the declined copy is gone, and its emptied folder with it");
	assert.match(out.at(-1), /not forked; the copy was removed/);
	const inside = world();
	const p = planFork({ record: RECORD, env: { PI_SESSIONS_DIR: inside.home }, pi: { path: inside.pi }, piVersion: "1.2.0" });
	assert.ok(p.refusal, "the store here has no such key");
	const nested = { ...plan(inside).plan, sessionsDir: inside.home };
	const lines = [];
	assert.equal(await runFork({ canAsk: true, plan: nested, out: (l) => lines.push(l), ask: async () => true, cwd: inside.work, home: inside.home, spawn: () => assert.fail("never run"), proc: new EventEmitter() }), 1);
	assert.match(lines[0], /inside PI_SESSIONS_DIR/);
});

test("the copy refuses a transcript swapped since the check and never follows or overwrites a planted snapshot path", () => {
	const w = world();
	const p = plan(w).plan;
	const dest = join(w.root, "snap.jsonl");
	assert.throws(() => copySnapshot({ plan: { ...p, ino: p.ino + 1 }, dest }), /changed between the check and the copy/);
	assert.ok(!existsSync(dest));
	const target = join(w.root, "victim");
	writeFileSync(target, "keep");
	symlinkSync(target, dest);
	assert.throws(() => copySnapshot({ plan: p, dest }), (e) => e.code === "EEXIST");
	assert.equal(readFileSync(target, "utf8"), "keep");
});

test("the pi binary: --pi, else PATH, else the installed package, else an install hint; its version from --version", () => {
	const w = world();
	assert.deepEqual(resolvePiBinary({ flag: w.pi, env: {} }), { path: w.pi, from: "--pi" });
	const plainFile = join(w.root, "not-exec");
	writeFileSync(plainFile, "");
	assert.match(resolvePiBinary({ flag: plainFile, env: {} }).refusal, /is not an executable file/);
	assert.deepEqual(resolvePiBinary({ env: { PATH: `relative:${w.bin}` }, resolvePackage: () => null }), { path: w.pi, from: "PATH" });
	assert.deepEqual(resolvePiBinary({ env: { PATH: "" }, resolvePackage: () => w.pi }), { path: w.pi, from: "the installed @earendil-works/pi-coding-agent" });
	assert.match(resolvePiBinary({ env: { PATH: "" }, resolvePackage: () => null }).refusal, /no pi to run: install pi \(npm install -g @earendil-works\/pi-coding-agent\) or pass --pi/);
	assert.equal(piVersionOf(w.pi), "1.2.0");
	assert.equal(piVersionOf(world({ piVersion: "garbage" }).pi), null);
	assert.equal(piVersionOf(join(w.root, "missing")), null);
});

test("the host defaults come from the agent dir's settings.json alone: a cwd .pi/settings.json cannot choose the provider; a value that is not a plain id is not read", () => {
	const w = world();
	const agent = join(w.root, "agent");
	mkdirSync(join(w.work, ".pi"), { recursive: true });
	mkdirSync(agent);
	assert.deepEqual(hostDefaultsOf({ agentDir: agent, cwd: w.work }), { provider: null, model: null });
	writeFileSync(join(w.work, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "attacker", defaultModel: "attacker-model" }));
	assert.deepEqual(hostDefaultsOf({ agentDir: agent, cwd: w.work }), { provider: null, model: null }, "the folder's settings name nothing on their own");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-x" }));
	assert.deepEqual(hostDefaultsOf({ agentDir: agent, cwd: w.work }), { provider: "openai", model: "gpt-x" }, "nor override the operator's");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "evil\u001b[2J", defaultModel: "gpt-x" }));
	assert.equal(hostDefaultsOf({ agentDir: agent, cwd: w.work }).provider, null, "a provider name that is not a plain id is not shown");
});

test("the session's model is the last model_change or assistant message, whichever is later, as pi restores it", () => {
	const w = world();
	const file = join(w.root, "s.jsonl");
	const line = (o) => `${JSON.stringify(o)}\n`;
	writeFileSync(file, line({ type: "session" }) + line({ type: "model_change", provider: "openai", modelId: "gpt-x" }) + line({ type: "message", message: { role: "user" } }));
	assert.deepEqual(sessionModelOf(file), { provider: "openai", modelId: "gpt-x" });
	writeFileSync(file, line({ type: "model_change", provider: "openai", modelId: "gpt-x" }) + line({ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-y" } }) + "not json\n");
	assert.deepEqual(sessionModelOf(file), { provider: "anthropic", modelId: "claude-y" });
	writeFileSync(file, line({ type: "model_change", provider: "evil\u001b", modelId: "x" }));
	assert.equal(sessionModelOf(file), null);
	assert.equal(sessionModelOf(join(w.root, "missing")), null);
});

test("the consent names what pi will use: both defaults are passed to pi, else the run's model is named with its fallback", () => {
	assert.deepEqual(forkModelOf({ defaults: { provider: "anthropic", model: "claude-x" }, session: { provider: "openai", modelId: "gpt-x" } }).args, ["--provider", "anthropic", "--model", "claude-x"]);
	const restored = forkModelOf({ defaults: { provider: "anthropic", model: null }, session: { provider: "openai", modelId: "gpt-x" } });
	assert.deepEqual(restored.args, []);
	assert.equal(restored.phrase, "openai (the run's own model, openai/gpt-x) if your pi knows that model and has a key for openai, and otherwise your pi's default provider, anthropic");
	assert.match(forkModelOf({ defaults: {}, session: { provider: "openai", modelId: "gpt-x" } }).phrase, /otherwise whichever provider your pi falls back to$/);
	assert.equal(forkModelOf({ defaults: { provider: "anthropic" } }).phrase, "anthropic (your pi's default provider)");
	assert.match(forkModelOf({}).phrase, /no defaultProvider/);
});

test("a fork whose session names the run's model, run against a fake pi: the prompt says the conditional truth and pi gets no --model", async () => {
	const t = `${JSON.stringify({ type: "session" })}\n${JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-x" })}\n`;
	const w = world({ transcript: t });
	const asked = [];
	const spawnIgnore = (cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: "ignore" });
	await runFork({ canAsk: true, plan: plan(w).plan, out: () => {}, ask: async (q) => (asked.push(q), true), agentDir: join(w.root, "no-agent"), cwd: w.work, home: w.home, now: () => 5, spawn: spawnIgnore, proc: new EventEmitter() });
	assert.match(asked[0], /to openai \(the run's own model, openai\/gpt-x\) if your pi knows that model and has a key for openai/);
	assert.deepEqual(readFileSync(w.log, "utf8").trim().split("\n").slice(1), ["--fork", join(w.home, ".pi-dispatch", "chat", KEY, "source-5.jsonl"), "--no-tools"]);
});

test("no PI_CONSOLE_* variable reaches pi, for the fork or for --version; everything else does", async () => {
	assert.deepEqual(childEnv({ PI_CONSOLE_TOKEN: "t", PI_CONSOLE_URL: "u", PI_CONSOLE_ANYTHING: "a", PATH: "/bin", PI_SESSIONS_DIR: "/s" }), { PATH: "/bin", PI_SESSIONS_DIR: "/s" });
	const w = world();
	const env = { ...process.env, PI_CONSOLE_TOKEN: "pdc_secret", PI_CONSOLE_URL: "127.0.0.1:1", KEEP_ME: "yes" };
	assert.equal(piVersionOf(w.pi, { env }), "1.2.0");
	assert.equal(readFileSync(join(w.root, "version-env.log"), "utf8"), "");
	const spawnIgnore = (cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: "ignore" });
	await runFork({ canAsk: true, plan: plan(w).plan, out: () => {}, ask: async () => true, cwd: w.work, home: w.home, now: () => 6, spawn: spawnIgnore, env, proc: new EventEmitter() });
	assert.equal(readFileSync(join(w.root, "fork-env.log"), "utf8"), "KEEP_ME=yes\n");
});

test("Ctrl+C, SIGTERM or SIGHUP at the y/N removes the copy and exits; while pi runs they are pi's, and the copy goes when it exits", async () => {
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
		const w = world();
		const proc = new EventEmitter();
		const exits = [];
		let answer;
		// The real exit ends the process; this fake answers the question instead, so the run settles and the test
		// awaits its code rather than leaving a runFork pending when the file ends.
		proc.exit = (c) => {
			exits.push(c);
			answer(false);
		};
		const out = [];
		let asked;
		const waiting = new Promise((resolve) => {
			asked = resolve;
		});
		const running = runFork({ canAsk: true, plan: plan(w).plan, out: (l) => out.push(l), ask: () => (asked(), new Promise((r) => (answer = r))), cwd: w.work, home: w.home, now: () => 7, spawn: () => assert.fail("never run"), proc });
		await waiting;
		const snapshot = join(w.home, ".pi-dispatch", "chat", KEY, "source-7.jsonl");
		assert.ok(existsSync(snapshot));
		proc.emit(signal);
		assert.ok(!existsSync(snapshot), `${signal}: the copy is removed`);
		assert.ok(!existsSync(join(w.home, ".pi-dispatch", "chat", KEY)), `${signal}: and its emptied folder`);
		assert.deepEqual(exits, [code]);
		assert.match(out.at(-1), /not forked; the copy was removed/);
		assert.equal(await running, code);
	}
	const w = world();
	const proc = new EventEmitter();
	const child = new EventEmitter();
	const kills = [];
	child.kill = (s) => kills.push(s);
	const running = runFork({ canAsk: true, plan: plan(w).plan, out: () => {}, ask: async () => true, cwd: w.work, home: w.home, now: () => 8, spawn: () => child, proc });
	await new Promise((resolve) => setImmediate(resolve));
	const snapshot = join(w.home, ".pi-dispatch", "chat", KEY, "source-8.jsonl");
	assert.ok(existsSync(snapshot), "the copy is there while pi runs");
	proc.emit("SIGINT");
	proc.emit("SIGTERM");
	proc.emit("SIGHUP");
	assert.deepEqual(kills, ["SIGTERM", "SIGHUP"], "SIGINT is left to pi (the terminal sent it there too); the others are passed on");
	child.emit("exit", null, "SIGTERM");
	assert.equal(await running, 143, "a SIGTERM passed on to pi ends the command as a SIGTERM would");
	assert.ok(!existsSync(snapshot));
	assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => proc.listenerCount(s)), [0, 0, 0], "no handler outlives the fork");
});

test("no terminal for the y/N: refused before anything is opened, so the unredacted copy is never written", async () => {
	const w = world();
	const opened = [];
	const fs = { ...nodeFs, openSync: (...a) => (opened.push(a[0]), nodeFs.openSync(...a)), mkdirSync: (...a) => (opened.push(a[0]), nodeFs.mkdirSync(...a)) };
	const out = [];
	const code = await runFork({ plan: plan(w).plan, out: (l) => out.push(l), ask: async () => assert.fail("never asked"), cwd: w.work, home: w.home, fs, spawn: () => assert.fail("never run"), proc: new EventEmitter() });
	assert.equal(code, 1);
	assert.deepEqual(opened, [], "no folder made, no file opened");
	assert.ok(!existsSync(join(w.home, ".pi-dispatch")));
	assert.match(out.join("\n"), /no terminal to ask the y\/N on \(stdin is not a TTY\), so nothing was copied or forked/);
	const tty = new EventEmitter();
	tty.stdin = { isTTY: true };
	assert.equal(await runFork({ plan: plan(w).plan, out: () => {}, ask: async () => false, cwd: w.work, home: w.home, now: () => 9, spawn: () => assert.fail("never run"), proc: tty }), 0, "a TTY stdin is a terminal by default");
});

test("a signal that lands during the copy reaches a handler that removes the partial copy and its folder", async () => {
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
		const w = world();
		const proc = new EventEmitter();
		const exits = [];
		const STOP = new Error("exited");
		proc.exit = (c) => {
			exits.push(c);
			throw STOP;
		};
		let writes = 0;
		const dest = join(w.home, ".pi-dispatch", "chat", KEY, "source-10.jsonl");
		const fs = {
			...nodeFs,
			writeSync: (...a) => {
				const n = nodeFs.writeSync(...a);
				writes += 1;
				if (writes === 1) {
					assert.ok(existsSync(dest), "the partial copy exists when the signal lands");
					proc.emit(signal);
				}
				return n;
			},
		};
		await runFork({ canAsk: true, plan: plan(w).plan, out: () => {}, ask: async () => assert.fail("never asked"), cwd: w.work, home: w.home, now: () => 10, fs, spawn: () => assert.fail("never run"), proc });
		assert.deepEqual(exits, [code], `${signal}: a handler was listening during the copy`);
		assert.ok(!existsSync(dest), `${signal}: the partial copy is removed`);
		assert.ok(!existsSync(join(w.home, ".pi-dispatch", "chat", KEY)), `${signal}: and its emptied folder`);
		assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => proc.listenerCount(s)), [0, 0, 0]);
	}
});

test("the private folders: another user's is refused, one of ours with group or other bits is made 0700", async () => {
	const w = world();
	const mine = process.getuid();
	const lines = [];
	assert.equal(await runFork({ canAsk: true, plan: plan(w).plan, out: (l) => lines.push(l), ask: async () => true, cwd: w.work, home: w.home, uid: mine + 1, spawn: () => assert.fail("never run"), proc: new EventEmitter() }), 1);
	assert.match(lines[0], /\.pi-dispatch is owned by uid \d+, not by you \(uid \d+\), so nothing is written there/);
	const open = join(w.root, "open");
	mkdirSync(open, { mode: 0o777 });
	chmodSync(open, 0o777);
	ensurePrivateDir(nodeFs, open, { uid: mine });
	assert.equal(lstatSync(open).mode & 0o777, 0o700);
	assert.throws(() => ensurePrivateDir(nodeFs, open, { uid: mine + 1 }), /not by you/);
});

test("the console's finishedAt is read as the run's end (endedAt is this host's record's name)", () => {
	const w = world();
	const consoleRun = { kind: "github", target: "o/r#7", jobId: "j1", triggerType: "label", finishedAt: RECORD.endedAt };
	assert.deepEqual(planFork({ record: consoleRun, env: w.env, pi: { path: w.pi }, piVersion: "1.2.0" }).plan.warnings, []);
	utimesSync(w.file, new Date(ENDED_MS + 3_600_000), new Date(ENDED_MS + 3_600_000));
	assert.equal(planFork({ record: consoleRun, env: w.env, pi: { path: w.pi }, piVersion: "1.2.0" }).plan.warnings.length, 1);
});

test("a host whose proc.exit returns (the panel): a signal at the y/N returns its exit code, says it once, never asks on; registerCleanup removes the copy first", async () => {
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
		const w = world();
		const proc = new EventEmitter();
		let answer;
		const exits = [];
		proc.exit = (c) => {
			exits.push(c);
			answer(false); // the panel's seam aborts its own question
		};
		const out = [];
		let asked;
		const waiting = new Promise((resolve) => {
			asked = resolve;
		});
		const running = runFork({ canAsk: true, plan: plan(w).plan, out: (l) => out.push(l), ask: () => (asked(), new Promise((r) => (answer = r))), cwd: w.work, home: w.home, now: () => 11, spawn: () => assert.fail("never run"), proc });
		await waiting;
		proc.emit(signal);
		proc.emit(signal); // a second signal before the question has unwound: still one line, one exit
		assert.equal(await running, code, `${signal}: its exit code, not a declined 0`);
		assert.deepEqual(exits, [code]);
		assert.equal(out.filter((l) => /not forked; the copy was removed/.test(l)).length, 1, `${signal}: said once`);
		assert.ok(!existsSync(join(w.home, ".pi-dispatch", "chat", KEY)));
		assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => proc.listenerCount(s)), [0, 0, 0]);
	}
	const w = world();
	const cleanups = [];
	const snapshot = join(w.home, ".pi-dispatch", "chat", KEY, "source-12.jsonl");
	let seenBeforeCopy = null;
	const code = await runFork({
		canAsk: true,
		plan: plan(w).plan,
		out: () => {},
		ask: async () => {
			assert.ok(existsSync(snapshot), "the copy is there while asked");
			cleanups[0](); // the host's own exit path ran first
			assert.ok(!existsSync(snapshot), "registerCleanup's function removes the copy synchronously");
			assert.ok(!existsSync(join(w.home, ".pi-dispatch", "chat", KEY)), "and its emptied folder");
			return false;
		},
		cwd: w.work,
		home: w.home,
		now: () => 12,
		spawn: () => assert.fail("never run"),
		proc: new EventEmitter(),
		registerCleanup: (fn) => {
			seenBeforeCopy = existsSync(snapshot);
			cleanups.push(fn);
		},
	});
	assert.equal(code, 0);
	assert.equal(cleanups.length, 1, "registered once");
	assert.equal(seenBeforeCopy, false, "before anything was copied");
	assert.doesNotThrow(() => cleanups[0](), "idempotent");
});
