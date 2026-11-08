import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { MAX_LINKS, enterReader, runOpenCommand } from "../src/console/open-command.mjs";
import { codePending } from "../src/console/login-codes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { browserInstallArgs } from "../src/setup-wizard.ts";
import { selfInstallArgs } from "../../worker/src/console-install.mjs";

// `pi-dispatch-console open` (issue #849). The bolt below it holds the worker's hand-written install line to the wizard's.

function world({ local = true, isTTY = true, script = [], usedAfter = null } = {}) {
  let t = 1_000_000;
  let codes = 0;
  const said = [], printed = [], opened = [];
  const live = new Set();
  const queue = [...script];
  let closed = false;
  // A scripted press answers at once; with nothing scripted the wait simply never ends, which is a person who does not press anything.
  const enter = { next: () => new Promise((done) => {
    if (closed) return done(false);
    if (queue.length === 0) return;
    if (queue.shift() === "close") { closed = true; return done(false); }
    done(true);
  }) };
  const o = {
    local, isTTY, enter: isTTY ? enter : null, plainUrl: "http://127.0.0.1:4790/", tunnelLine: "ssh -L 4790:127.0.0.1:4790 <this host>",
    say: (s) => said.push(s), print: (s) => printed.push(s), now: () => t, sleep: async () => { t += 500; await new Promise((d) => setImmediate(d)); },
    mint: () => { codes += 1; const code = `code${codes}`; live.add(code); return { url: `http://127.0.0.1:4790/login/code#${code}`, code }; },
    pending: (code) => { if (usedAfter !== null && t >= 1_000_000 + usedAfter) live.delete(code); return live.has(code); },
    openLink: (url) => { opened.push(url); return {}; }, openPlain: (url) => opened.push(url),
  };
  return { o, said, printed, opened, minted: () => codes, live };
}

test("local: the browser gets the code, nothing is printed, and a used code ends it", async () => {
  const w = world({ usedAfter: 2000 });
  assert.equal(await runOpenCommand(w.o), 0);
  assert.equal(w.opened.length, 1);
  assert.deepEqual(w.printed, [], "no code in the terminal");
  assert.match(w.said.at(-1), /your browser took the link/);
  assert.equal(w.minted(), 1);
});

test("local: Enter is the way in when no browser came up, and it prints a fresh link rather than the one handed over", async () => {
  const w = world({ script: ["enter"], usedAfter: 2000 });
  w.o.pending = ((p) => (code) => (code === "code1" ? true : p(code)))(w.o.pending);
  assert.equal(await runOpenCommand(w.o), 0);
  assert.equal(w.minted(), 2);
  assert.deepEqual(w.printed, ["http://127.0.0.1:4790/login/code#code2"]);
  assert.equal(w.opened.length, 1, "the fresh one is printed, not opened again");
});

test("a failed handover says why and still offers the link", async () => {
  const w = world({ usedAfter: 1000 });
  w.o.openLink = () => ({ refusal: "the page could not be written" });
  await runOpenCommand(w.o);
  assert.ok(w.said.includes("the page could not be written"));
  assert.ok(w.said.some((s) => /press Enter for a link/.test(s)));
});

test("over SSH nothing is minted until the tunnel is up", async () => {
  const w = world({ local: false, script: ["enter"], usedAfter: 1000 });
  let mintedAtPrompt = null;
  const say = w.o.say;
  w.o.say = (s) => { if (/press Enter when/.test(s)) mintedAtPrompt = w.minted(); say(s); };
  assert.equal(await runOpenCommand(w.o), 0);
  assert.equal(mintedAtPrompt, 0);
  assert.equal(w.minted(), 1);
  assert.ok(w.said.some((s) => s.includes("ssh -L 4790:127.0.0.1:4790")));
  assert.deepEqual(w.opened, [], "no browser on the server");
  assert.deepEqual(w.printed, ["http://127.0.0.1:4790/login/code#code1"]);
});

test("over SSH a closed terminal before Enter mints nothing", async () => {
  const w = world({ local: false, script: ["close"] });
  assert.equal(await runOpenCommand(w.o), 0);
  assert.equal(w.minted(), 0);
});

test("an expired link waits for Enter, then makes a fresh one", async () => {
  const w = world();
  let press;
  w.o.enter = { next: () => new Promise((done) => { press = done; }) };
  // The world's clock moves with each poll, so the code's minute runs out by itself.
  const running = runOpenCommand(w.o);
  while (!w.said.some((s) => /has expired/.test(s))) await new Promise((d) => setImmediate(d));
  assert.equal(w.minted(), 1, "no code until asked");
  press(true);
  while (w.minted() < 2) await new Promise((d) => setImmediate(d));
  w.live.clear();
  assert.equal(await running, 0);
  assert.deepEqual(w.printed, ["http://127.0.0.1:4790/login/code#code2"]);
});

test("no terminal: local opens and stops; remote refuses and names link", async () => {
  const local = world({ isTTY: false });
  assert.equal(await runOpenCommand(local.o), 0);
  assert.equal(local.opened.length, 1);
  const remote = world({ local: false, isTTY: false });
  assert.equal(await runOpenCommand(remote.o), 2);
  assert.equal(remote.minted(), 0);
  assert.ok(remote.said.some((s) => s.includes("pi-dispatch-console link")));
});

test("Windows opens the page and mints nothing", async () => {
  const w = world();
  w.o.windows = true;
  assert.equal(await runOpenCommand(w.o), 0);
  assert.equal(w.minted(), 0);
  assert.deepEqual(w.opened, ["http://127.0.0.1:4790/"]);
  assert.match(w.said[0], /paste a token/);
});

test("a failure the minter already said ends the command with its exit code", async () => {
  const w = world();
  w.o.mint = () => ({ exit: 1 });
  assert.equal(await runOpenCommand(w.o), 1);
  assert.deepEqual([w.opened, w.printed], [[], []]);
});

test("a held-down Enter stops at the bound, so it cannot leave unbounded live codes", async () => {
  const w = world({ script: Array(MAX_LINKS + 5).fill("enter") });
  assert.equal(await runOpenCommand(w.o), 2);
  assert.equal(w.minted(), MAX_LINKS);
});

test("the snap hint is said only where a snap can be", async () => {
  const linux = world({ usedAfter: 1000 });
  linux.o.snapHint = true;
  await runOpenCommand(linux.o);
  assert.ok(linux.said.some((s) => /snap or Flatpak/.test(s)));
  const mac = world({ usedAfter: 1000 });
  await runOpenCommand(mac.o);
  assert.equal(mac.said.some((s) => /snap or Flatpak/.test(s)), false);
});

test("no terminal and a failed handover is a failure, with no code left for nobody", async () => {
  const w = world({ isTTY: false });
  w.o.openLink = () => ({ refusal: "no" });
  assert.equal(await runOpenCommand(w.o), 2);
});

test("it never says the sign-in worked, only what it can know", async () => {
  const w = world({ usedAfter: 1000 });
  await runOpenCommand(w.o);
  assert.equal(w.said.some((s) => /signed in/.test(s)), false, w.said.join(" | "));
});

test("Ctrl-D at the tunnel prompt says nothing was made", async () => {
  const w = world({ local: false, script: ["close"] });
  await runOpenCommand(w.o);
  assert.ok(w.said.includes("no link was made"));
});

test("Enter pressed before this attached does not count: it would mint before the tunnel exists", async () => {
  let t = 1000;
  const input = new PassThrough();
  const reader = await enterReader(input, { now: () => t, settleMs: 200 });
  input.write("\n");
  await new Promise((d) => setImmediate(d));
  let answered = false;
  const next = reader.next().then((more) => { answered = more; });
  await new Promise((d) => setImmediate(d));
  assert.equal(answered, false, "the early press was dropped");
  t += 500;
  input.write("\n");
  await next;
  assert.equal(answered, true);
  reader.close();
});

test("the window starts on the next turn: a slow start must not use it up before the buffered lines are read", async () => {
  let t = 1000;
  const input = new PassThrough();
  const reader = await enterReader(input, { now: () => t, settleMs: 200 });
  t += 900;
  input.write("\n");
  let answered = false;
  reader.next().then((more) => { answered = more; });
  await new Promise((d) => setImmediate(d));
  await new Promise((d) => setImmediate(d));
  assert.equal(answered, false);
  reader.close();
});

test("a code is pending until its file is gone, and a vanished drop proves nothing", () => {
  const root = tempDir("console-open-");
  const dir = join(root, "drop");
  const code = "k".repeat(43);
  assert.equal(codePending({ dir, code }), true, "no folder: nothing says a browser took it");
  mkdirSync(dir);
  assert.equal(codePending({ dir, code }), false, "folder there, file gone");
  writeFileSync(join(dir, `${createHash("sha256").update(code).digest("hex")}.json`), "{}");
  assert.equal(codePending({ dir, code }), true);
  assert.equal(codePending({ dir, code: "short" }), false);
});

test("the worker's self-install line and the wizard's are the same packages and flags", () => {
  const worker = selfInstallArgs({ version: "VERSION", piVersion: "PI" }).map((a) => a.replace("VERSION", "V").replace("@PI", "@P"));
  const wizardVersion = JSON.parse(readFileSync(new URL("../../worker/package.json", import.meta.url), "utf8")).version;
  const pi = JSON.parse(readFileSync(new URL("../../worker/package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-ai"];
  const wizard = browserInstallArgs().map((a) => a.replace(`@${wizardVersion}`, "@V").replace(`@${pi}`, "@P"));
  assert.deepEqual([...worker].sort(), [...wizard].sort());
});

test("the deployment package.json's name is the wizard's", () => {
  const name = /name: "([^"]+)", private: true/.exec(readFileSync(new URL("../src/setup-wizard.ts", import.meta.url), "utf8"))?.[1];
  assert.equal(name, /DEPLOYMENT_PACKAGE_NAME = "([^"]+)"/.exec(readFileSync(new URL("../../worker/src/console-install.mjs", import.meta.url), "utf8"))?.[1]);
});

test("docs/console.md's one command names the release in worker/package.json", () => {
  const version = JSON.parse(readFileSync(new URL("../../worker/package.json", import.meta.url), "utf8")).version;
  assert.ok(readFileSync(new URL("../../docs/console.md", import.meta.url), "utf8").includes(`npx --yes --ignore-scripts @edgehero/pi-dispatch@${version} up --console`));
});
