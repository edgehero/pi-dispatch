import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { VALKEY_CONTEXT_KEYS } from "@edgehero/pi-dispatch/connection";
import { restartKeysOf, restartProblemKeysOf, restartReadingOf, restartValuesOf } from "../src/console/cli.mjs";
import { CONSOLE_ENV_KEYS } from "../src/console/config.mjs";
import { RESTART_CHECK_EVERY_MS, RESTART_CLEARED, RESTART_FIX_FIRST_TITLE, RESTART_RECHECK_MS, RESTART_TITLE, envProblemOf, makeRestartWatch, restartBody, restartLogLine, restartNoticeOf, restartReasons } from "../src/console/restart-notice.mjs";
import { PANEL_SERVICE_KEYS } from "../src/read-model.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #845: a running console could not pick up a changed VALKEY_URL, other `.env` values, or a database Valkey refused,
// and never said so. It now says so on every page and in its log, by setting name and never by value. These tests pin
// the watch (`restart-notice.mjs`) on fakes and an injected clock, and the console's own reading of its deployment
// (`cli.mjs`) on a real `.env` in a temp folder.

const SECRET = "redis://:s3cret-never-shown@127.0.0.1:6379/2";
const reading = (values, problem = null) => ({ values, problem });
const sentences = (reasons) => reasons.map((r) => r.sentence).join(" ");

test("restartReasons: a changed setting by name, never its value; one only the shell set is not a change; none for an unchanged reading (#845)", () => {
  const start = reading({ VALKEY_URL: '["redis://127.0.0.1:6379/1"]', PI_LOGS_DIR: '["/srv/logs"]', PI_SESSIONS_DIR: '[null]' });
  assert.deepEqual(restartReasons({ start, now: start }), []);
  const now = reading({ VALKEY_URL: JSON.stringify([SECRET]), PI_LOGS_DIR: '["/srv/logs"]', PI_SESSIONS_DIR: '["/srv/sessions"]' });
  const reasons = restartReasons({ start, now });
  assert.deepEqual(reasons.map((r) => [r.kind, r.keys]), [["settings", ["PI_SESSIONS_DIR", "VALKEY_URL"]]]);
  // The kill switch reads VALKEY_URL from the .env at each use, so the sentence says so for that key (and for no other).
  assert.equal(reasons[0].sentence, "`PI_SESSIONS_DIR` and `VALKEY_URL` have changed in the deployment's .env since this console started, and the console keeps the values it started with until it is restarted. Pause the fleet and Resume the fleet already use the `VALKEY_URL` the .env names now; the pages read the one the console started with.");
  assert.equal(restartReasons({ start, now: reading({ ...start.values, PI_LOGS_DIR: '["/srv/other"]' }) })[0].sentence, "`PI_LOGS_DIR` has changed in the deployment's .env since this console started, and the console keeps the value it started with until it is restarted.");
  // A key the reading no longer has at all is a change too (a line removed), and so is one it gained.
  assert.deepEqual(restartReasons({ start, now: reading({ VALKEY_URL: start.values.VALKEY_URL }) })[0].keys, ["PI_LOGS_DIR", "PI_SESSIONS_DIR"]);
  // Past six names, the rest are counted.
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, `"${i}"`]));
  assert.match(restartReasons({ start: reading({}), now: reading(many) })[0].sentence, /^`K0`, `K1`, `K2`, `K3`, `K4`, `K5` and 3 more have changed/);
  for (const r of [reasons, restartReasons({ start: reading({ VALKEY_URL: JSON.stringify([SECRET]) }), now: reading({}) })]) {
    assert.ok(!sentences(r).includes("s3cret") && !sentences(r).includes("127.0.0.1"), "names only");
  }
});

test("restartReasons: a .env that cannot be read now asks for a fix first, and what it alone keeps unread is not also called changed (#845)", () => {
  const start = reading({ VALKEY_URL: '["a"]', PI_LOGS_DIR: '["b"]' });
  // A line the service's loader reads differently, new since start, that keeps VALKEY_URL from being read.
  const hazard = { kind: "hazard", line: 3, keys: ["VALKEY_URL"] };
  const now = reading({ VALKEY_URL: "[null]", PI_LOGS_DIR: '["b"]' }, hazard);
  const reasons = restartReasons({ start, now });
  assert.deepEqual(reasons.map((r) => r.kind), ["env"], "VALKEY_URL is the hazard's, not a change");
  assert.equal(reasons[0].sentence, "The deployment's .env cannot be read now: line 3 is one the service's loader reads differently, so `VALKEY_URL` cannot be read from it. Fix it before restarting the console, since one started now would run without what it cannot read.");
  assert.equal(restartNoticeOf(reasons).title, RESTART_FIX_FIRST_TITLE, "alone, it asks for the fix, not the restart");
  // The same problem the console started with is no reason: a restart reads the same.
  assert.deepEqual(restartReasons({ start: reading(now.values, hazard), now }), []);
  // A key it does not cover is still a change, and the title is then the restart's.
  const both = restartReasons({ start, now: reading({ VALKEY_URL: "[null]", PI_LOGS_DIR: '["c"]' }, hazard) });
  assert.deepEqual(both.map((r) => [r.kind, r.keys ?? null]), [["settings", ["PI_LOGS_DIR"]], ["env", null]]);
  assert.equal(restartNoticeOf(both).title, RESTART_TITLE);
  // A file it cannot read at all, or one another account can change, covers every key.
  for (const [problem, words] of [[{ kind: "unreadable", code: "EACCES", keys: null }, "it could not be read (EACCES)"], [{ kind: "unreadable", code: null, keys: null }, "it could not be read"], [{ kind: "absent", keys: null }, "there is no file there any more"], [{ kind: "untrusted", keys: null }, "another account can change it, so the console takes nothing from it"], [{ kind: "unread", line: 7, keys: ["PI_LOGS_DIR"] }, "line 7 assigns `PI_LOGS_DIR` in a form the service's loader may read differently"]]) {
    const got = restartReasons({ start, now: reading({}, problem) });
    const want = problem.keys === null ? ["env"] : ["settings", "env"];
    assert.deepEqual(got.map((r) => r.kind), want, problem.kind);
    assert.ok(got.at(-1).sentence.startsWith(`The deployment's .env cannot be read now: ${words}. Fix it before restarting`), problem.kind);
  }
  // Told apart by kind and keys, never by line: the bad line the console started with, moved by an edit above it, is
  // no reason; one that now hides another key is.
  assert.deepEqual(restartReasons({ start: reading(now.values, hazard), now: reading(now.values, { ...hazard, line: 9 }) }), []);
  assert.deepEqual(restartReasons({ start: reading(now.values, hazard), now: reading(now.values, { ...hazard, keys: ["PI_LOGS_DIR", "VALKEY_URL"] }) }).map((r) => r.kind), ["env"]);
  // A .env that was there at start and is gone now: put it back first, since a console started now would run on the
  // defaults; none at start and none now is the console's own setup, and no reason.
  const gone = restartReasons({ start, now: reading({}, { kind: "absent", keys: null }) });
  assert.deepEqual(gone.map((r) => r.kind), ["env"], "no setting is called changed: they are all gone with the file");
  assert.equal(restartNoticeOf(gone).title, RESTART_FIX_FIRST_TITLE);
  assert.deepEqual(restartReasons({ start: reading({}, { kind: "absent", keys: null }), now: reading({}, { kind: "absent", keys: null }) }), []);
});

test("restartReasons: a database a held client was refused, once per number, without an address; the title is the restart's (#845)", () => {
  const same = reading({ VALKEY_URL: '["x"]' });
  const reasons = restartReasons({ start: same, now: same, refused: [{ db: 16 }, { db: 16 }, null, { db: null }] });
  assert.deepEqual(reasons.map((r) => [r.kind, r.db]), [["database", 16]], "both held clients refused the same one: said once, and an unnumbered one only alone");
  assert.equal(reasons[0].sentence, "Valkey refused database 16, the one `VALKEY_URL` named when this console started, and the console does not try a refused database again. Name one that Valkey has, or raise `databases` in its configuration, then restart the console.");
  assert.equal(restartReasons({ start: same, now: same, refused: [{ db: null }] })[0].sentence.slice(0, 74), "Valkey refused the database `VALKEY_URL` named when this console started, ");
  assert.equal(restartNoticeOf(reasons).title, RESTART_TITLE);
  assert.equal(restartNoticeOf([]), null);
  assert.equal(restartLogLine(restartNoticeOf(reasons)), "pi-dispatch-console: restart needed: Valkey refused database 16, the one VALKEY_URL named when this console started, and the console does not try a refused database again. Name one that Valkey has, or raise databases in its configuration, then restart the console.");
  assert.equal(restartLogLine(null), `pi-dispatch-console: ${RESTART_CLEARED}`);
  assert.equal(String(restartBody(restartNoticeOf(reasons))), "Valkey refused database 16, the one <span class=\"code\">VALKEY_URL</span> named when this console started, and the console does not try a refused database again. Name one that Valkey has, or raise <span class=\"code\">databases</span> in its configuration, then restart the console.");
});

test("envProblemOf over the service's own reader: a new bad line, a file gone, an unreadable file by its code alone, and a line only this shell's value covers (#845)", () => {
  const dir = tempDir("restart-env-");
  const read = (text, env = {}) => {
    writeFileSync(join(dir, ".env"), text);
    return envProblemOf(deploymentServiceEnv({ env, dir, keys: ["VALKEY_URL", "PI_LOGS_DIR"], platform: "linux", fs: nodeFs, uid: process.geteuid?.() }));
  };
  assert.equal(read("VALKEY_URL=redis://127.0.0.1:6379\nPI_LOGS_DIR=/srv/logs\n"), null);
  assert.deepEqual(read("VALKEY_URL=redis://127.0.0.1:6379\rPI_LOGS_DIR=/srv/logs\n"), { kind: "hazard", line: 1, keys: ["PI_LOGS_DIR", "VALKEY_URL"] }, "a lone CR, which systemd splits differently");
  assert.deepEqual(read("VALKEY_URL=redis://127.0.0.1:6379\nPI_LOGS_DIR=/srv/$USER\n"), { kind: "unread", line: 2, keys: ["PI_LOGS_DIR"] });
  assert.equal(read("VALKEY_URL=redis://127.0.0.1:6379\nPI_LOGS_DIR=/srv/$USER\n", { PI_LOGS_DIR: "/shell" }), null, "the shell's value is used either way");
  nodeFs.rmSync(join(dir, ".env"));
  assert.deepEqual(envProblemOf(deploymentServiceEnv({ env: {}, dir, keys: ["VALKEY_URL"], platform: "linux", fs: nodeFs, uid: process.geteuid?.() })), { kind: "absent", keys: null }, "a file that is not there");
  // Only a system error's code reaches the banner: a message (which the reader hands back where there is no code) can
  // carry a path, and none of it is shown.
  assert.deepEqual(envProblemOf({ unreadable: "EACCES" }), { kind: "unreadable", code: "EACCES", keys: null });
  assert.deepEqual(envProblemOf({ unreadable: "EACCES: permission denied, open '/srv/.env'" }), { kind: "unreadable", code: null, keys: null }, "no part of a message, so no part of a path");
  assert.deepEqual(envProblemOf({ unreadable: "not a regular file" }), { kind: "unreadable", code: null, keys: null });
  assert.deepEqual(envProblemOf({ unreadable: "ENOENT" }), { kind: "absent", keys: null }, "gone between the reader's two looks");
  assert.deepEqual(envProblemOf({ untrusted: "is in a folder another account can change: /srv" }), { kind: "untrusted", keys: null });
  assert.equal(envProblemOf(null), null);
});

test("makeRestartWatch: a page reads again past the recheck on the injected clock, the timer is unref'd, and the log says each change once, the way back included (#845)", () => {
  let t = 1_000;
  let values = { VALKEY_URL: '["a"]' };
  let refused = [];
  let reads = 0;
  const lines = [];
  const timer = { unref() { this.unrefd = true; }, unrefd: false };
  let tick = null;
  let cleared = null;
  const timers = { setInterval: (fn, ms) => ((tick = fn), (timer.ms = ms), timer), clearInterval: (h) => (cleared = h) };
  const watch = makeRestartWatch({ start: reading({ VALKEY_URL: '["a"]' }), readNow: () => (reads++, reading(values)), refused: () => refused, now: () => t, timers, log: (l) => lines.push(l) });
  assert.equal(timer.ms, RESTART_CHECK_EVERY_MS);
  assert.equal(timer.unrefd, true, "it never holds the process");
  assert.equal(watch.current(), null);
  assert.equal(reads, 1);
  values = { VALKEY_URL: JSON.stringify([SECRET]) };
  t += RESTART_RECHECK_MS - 1;
  assert.equal(watch.current(), null, "inside the recheck window: the held answer");
  assert.equal(reads, 1);
  t += 1;
  assert.deepEqual(watch.current().reasons.map((r) => r.keys), [["VALKEY_URL"]], "past it: read again");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^pi-dispatch-console: restart needed: VALKEY_URL has changed in the deployment's \.env/);
  assert.ok(!lines[0].includes("s3cret") && !lines[0].includes("127.0.0.1"));
  // The timer's check, with no page: the same reasons say nothing more; a refused database is a new set, said once.
  tick();
  assert.equal(lines.length, 1, "the same reasons, not said again");
  refused = [{ db: 16 }];
  tick();
  tick();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /VALKEY_URL has changed.*Valkey refused database 16/);
  // Back to none (the file put back, and a refusal is never dropped, so a fresh client for this case).
  refused = [];
  values = { VALKEY_URL: '["a"]' };
  tick();
  assert.equal(lines.at(-1), `pi-dispatch-console: ${RESTART_CLEARED}`);
  assert.equal(lines.length, 3);
  tick();
  assert.equal(lines.length, 3, "none, said once");
  // A clock gone backwards is a read, never a held answer from the future.
  t -= 10 * RESTART_RECHECK_MS;
  const before = reads;
  watch.current();
  assert.equal(reads, before + 1);
  watch.close();
  assert.equal(cleared, timer);
});

test("makeRestartWatch: a reading that throws is said as a .env that cannot be read, never as nothing changed; a throwing sink or refusal costs nothing else (#845)", () => {
  const lines = [];
  let tick = null;
  const watch = makeRestartWatch({ start: reading({ VALKEY_URL: '["a"]' }), readNow: () => { throw Object.assign(new Error("boom"), { code: "EIO" }); }, refused: () => { throw new Error("no client"); }, now: () => 0, timers: { setInterval: (fn) => ((tick = fn), {}), clearInterval() {} }, log: (l) => lines.push(l) });
  const notice = watch.current();
  assert.equal(notice.title, RESTART_FIX_FIRST_TITLE);
  assert.match(notice.reasons[0].sentence, /cannot be read now: it could not be read \(EIO\)/);
  assert.equal(lines.length, 1);
  const loud = makeRestartWatch({ start: reading({}), readNow: () => reading({ A: '"x"' }), now: () => 0, timers: { setInterval: (fn) => ((tick = fn), {}), clearInterval() {} }, log: () => { throw new Error("sink"); } });
  assert.doesNotThrow(() => tick(), "the timer's check never throws out of its callback");
  loud.close();
  assert.equal(makeRestartWatch({ start: reading({}), readNow: () => reading({}), everyMs: 0, timers: { setInterval: () => assert.fail("no timer"), clearInterval: () => assert.fail("none to clear") } }).close(), undefined, "everyMs 0: no timer");
});

test("the console's reading: the keys it read at start, a .env edit named, a key this shell sets left alone, a new bad line asked to be fixed first (#845)", () => {
  const dir = tempDir("restart-reading-");
  const m = { readModel: { PANEL_SERVICE_KEYS, panelEnv: ({ env }) => ({ env: { ...env } }), resolvePaths: () => ({}) }, connection: { VALKEY_CONTEXT_KEYS } };
  const keys = restartKeysOf(m);
  for (const key of [...CONSOLE_ENV_KEYS, ...PANEL_SERVICE_KEYS, "PI_SESSIONS_DIR", "PI_ALLOWED_MODELS"]) assert.ok(keys.includes(key), key);
  assert.ok(!keys.includes("VALKEY_PASSWORD"), "the password is read again at each connect, so it needs no restart");
  // Its line is judged all the same, with the rest of the Valkey context's.
  const problemKeys = restartProblemKeysOf(m);
  for (const key of [...keys, ...VALKEY_CONTEXT_KEYS]) assert.ok(problemKeys.includes(key), key);
  assert.ok(problemKeys.includes("VALKEY_PASSWORD"));
  const env = { PI_CONSOLE_LISTEN: "127.0.0.1:0" };
  const at = (text) => {
    writeFileSync(join(dir, ".env"), text);
    return restartReadingOf({ m, env, dir, fs: nodeFs, platform: "linux", uid: process.geteuid?.() });
  };
  const start = at("VALKEY_URL=redis://127.0.0.1:6379/1\nPI_CONSOLE_LISTEN=127.0.0.1:4790\n");
  assert.deepEqual(Object.keys(start.values).sort(), keys);
  assert.equal(start.problem, null);
  assert.deepEqual(restartReasons({ start, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\nPI_CONSOLE_LISTEN=127.0.0.1:4790\n") }), []);
  assert.deepEqual(restartReasons({ start, now: at("VALKEY_URL=redis://127.0.0.1:6379/2\nPI_CONSOLE_LISTEN=127.0.0.1:4790\n") }).map((r) => r.keys), [["VALKEY_URL"]]);
  assert.deepEqual(restartReasons({ start, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\nPI_CONSOLE_LISTEN=127.0.0.1:9999\n") }), [], "this shell's PI_CONSOLE_LISTEN is the console's either way");
  const broken = restartReasons({ start, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\rPI_CONSOLE_LISTEN=1\n") });
  assert.deepEqual(broken.map((r) => r.kind), ["env"], "a new bad line: fix it first, and the key it hides is not called changed");
  // A console that started with that bad line, once it is fixed: the keys it now reads are what changed.
  const brokenStart = at("VALKEY_URL=redis://127.0.0.1:6379/1\rPI_CONSOLE_LISTEN=1\n");
  assert.deepEqual(restartReasons({ start: brokenStart, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\n") }).map((r) => r.keys), [["VALKEY_URL"]]);
  // What the start compared is what serve ran on: the same function over the start's two environments.
  assert.deepEqual(restartValuesOf(m, { VALKEY_URL: "x" }, { VALKEY_URL: "x" }, dir).VALKEY_URL, '["x","x"]');
  // A VALKEY_PASSWORD line the service's loader reads differently, written after start: the clients keep the password
  // they had, a restart would start with none, so it is said (measured live with `pw$abc` before this was judged).
  const fine = at("VALKEY_URL=redis://127.0.0.1:6379/1\nVALKEY_PASSWORD=pw-abc\n");
  const badPassword = restartReasons({ start: fine, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\nVALKEY_PASSWORD=pw$abc\n") });
  assert.deepEqual(badPassword.map((r) => [r.kind, r.problem?.keys]), [["env", ["VALKEY_PASSWORD"]]]);
  assert.match(badPassword[0].sentence, /line 2 assigns `VALKEY_PASSWORD` in a form the service's loader may read differently/);
  assert.deepEqual(restartReasons({ start: fine, now: at("VALKEY_URL=redis://127.0.0.1:6379/1\nVALKEY_PASSWORD=pw-rotated\n") }), [], "a password changed on a good line needs no restart");
  // A path named two ways that name one file is no change; another file is.
  const hosts = at("PI_SANDBOX_HOSTS_FILE=hosts.json\nPI_LOGS_DIR=logs\n");
  assert.deepEqual(restartReasons({ start: hosts, now: at("PI_SANDBOX_HOSTS_FILE=./hosts.json\nPI_LOGS_DIR=./logs/\n") }), []);
  assert.deepEqual(restartReasons({ start: hosts, now: at("PI_SANDBOX_HOSTS_FILE=other.json\nPI_LOGS_DIR=logs\n") }).map((r) => r.keys), [["PI_SANDBOX_HOSTS_FILE"]]);
  // The bad line the console started with, moved down by a comment added above it: the same problem, no reason.
  const moved = at("VALKEY_URL=redis://127.0.0.1:6379/1\nPI_LOGS_DIR=/srv/$USER\n");
  assert.equal(moved.problem.line, 2);
  const after = at("# a comment\nVALKEY_URL=redis://127.0.0.1:6379/1\nPI_LOGS_DIR=/srv/$USER\n");
  assert.equal(after.problem.line, 3);
  assert.deepEqual(restartReasons({ start: moved, now: after }), []);
  // The file moved away: put it back first, not restart, and no setting is called changed.
  const there = at("VALKEY_URL=redis://127.0.0.1:6379/1\n");
  nodeFs.rmSync(join(dir, ".env"));
  const away = restartReadingOf({ m, env, dir, fs: nodeFs, platform: "linux", uid: process.geteuid?.() });
  assert.deepEqual(away.problem, { kind: "absent", keys: null });
  const told = restartReasons({ start: there, now: away });
  assert.deepEqual(told.map((r) => r.kind), ["env"]);
  assert.equal(restartNoticeOf(told).title, RESTART_FIX_FIRST_TITLE);
});
