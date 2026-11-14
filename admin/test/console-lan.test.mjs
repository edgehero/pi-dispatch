import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LAN_HOSTNAME, announceCommandFor, lanAddressOf, lanBindsFor, lanUrlOf, superviseAnnouncer } from "../src/console/lan.mjs";
import { arrivedOverLan } from "../src/console/server.mjs";
import { consoleConfig } from "../src/console/config.mjs";
import { APPROVE_LABEL, CODE_HINT, LAN_WORDS, LISTEN_FOOTERS, signInContent } from "../src/console/signin.mjs";
import { LAN_SIGN_IN_NOTICES, SIGN_IN_NOTICES } from "../src/console/session-ends.mjs";

/**
 * Issue #882, the owner's opt-in: the console on the local network as pi-dispatch.local. No real listener or mDNS
 * announcer runs here: the address, the bind order, the command and its supervisor are each tested through seams.
 */

test("the LAN address: the first real IPv4 address, the usual interfaces first, never loopback, link-local or IPv6", () => {
  assert.equal(lanAddressOf({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }], en0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.68.62", internal: false }] }), "192.168.68.62");
  assert.equal(lanAddressOf({ bridge100: [{ family: "IPv4", address: "10.0.0.1", internal: false }], eth0: [{ family: 4, address: "192.168.1.5", internal: false }] }), "192.168.1.5", "eth0 before a bridge, and node's numeric family read too");
  assert.equal(lanAddressOf({ en0: [{ family: "IPv4", address: "169.254.3.4", internal: false }] }), null, "a self-assigned address is no network");
  assert.equal(lanAddressOf({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }] }), null);
});

test("where the LAN listener binds: on macOS the wildcard on 80 first (unprivileged there, measured), then the LAN address on the console's port; elsewhere, or with a port named, the LAN address", () => {
  assert.deepEqual(lanBindsFor({ platform: "darwin", address: "192.168.68.62", loopbackPort: 4790 }), [{ host: "0.0.0.0", port: 80 }, { host: "192.168.68.62", port: 4790 }]);
  assert.deepEqual(lanBindsFor({ platform: "linux", address: "192.168.1.5", loopbackPort: 4790 }), [{ host: "192.168.1.5", port: 4790 }], "Linux never binds 80: that takes privileges this project never takes");
  assert.deepEqual(lanBindsFor({ platform: "darwin", address: "192.168.68.62", port: 8080, loopbackPort: 4790 }), [{ host: "192.168.68.62", port: 8080 }]);
  assert.equal(lanUrlOf(80), `http://${LAN_HOSTNAME}/`);
  assert.equal(lanUrlOf(4790), `http://${LAN_HOSTNAME}:4790/`);
});

test("the name's announcer: dns-sd on macOS, avahi-publish on Linux where installed, and a sentence where there is none", () => {
  const ok = () => {};
  const none = () => { throw new Error("ENOENT"); };
  assert.deepEqual(announceCommandFor({ platform: "darwin", access: ok, address: "192.168.68.62", port: 80 }), { cmd: "/usr/bin/dns-sd", args: ["-P", "pi-dispatch", "_http._tcp", "local", "80", LAN_HOSTNAME, "192.168.68.62"] });
  assert.match(announceCommandFor({ platform: "darwin", access: none, address: "x", port: 80 }).refusal, /dns-sd is missing/);
  const avahi = (p) => { if (!p.endsWith("/avahi-publish")) throw new Error("ENOENT"); };
  assert.deepEqual(announceCommandFor({ platform: "linux", env: { PATH: "/usr/bin" }, access: avahi, address: "192.168.1.5", port: 4790 }), { cmd: "/usr/bin/avahi-publish", args: ["-a", "-R", LAN_HOSTNAME, "192.168.1.5"] });
  assert.match(announceCommandFor({ platform: "linux", env: { PATH: "/usr/bin" }, access: none, address: "x", port: 1 }).refusal, /avahi-utils/);
  assert.ok(announceCommandFor({ platform: "win32", address: "x", port: 1 }).refusal);
});

test("the announcer is kept running: started again after it exits, a taken name said once, and stopped with the console", () => {
  const children = [];
  const timers = [];
  const logs = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const exits = [];
  const sup = superviseAnnouncer({ command: { cmd: "/usr/bin/dns-sd", args: [] }, spawnFn, log: (l) => logs.push(l), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, onExit: (fn) => exits.push(fn) });
  assert.equal(children.length, 1);
  children[0].stdout.emit("data", "Name conflict, please rename");
  children[0].stderr.emit("data", "collision again");
  assert.equal(logs.filter((l) => /already uses pi-dispatch.local/.test(l)).length, 1, "said once");
  children[0].emit("close", 1);
  assert.equal(timers.length, 1, "started again after a while");
  timers[0]();
  assert.equal(children.length, 2);
  children[1].emit("close", 1);
  timers[1]();
  assert.equal(logs.filter((l) => /stopped announcing pi-dispatch\.local \(exit 1\)/.test(l)).length, 1, "its own exit is said once, not every 5 s");
  // The console exiting without stop() (an uncaught error) still ends the child it holds.
  assert.equal(exits.length, 1);
  exits[0]();
  assert.equal(children[2].killed, true);
  sup.stop();
  children[2].emit("close", null);
  assert.equal(timers.length, 2, "nothing starts once stopped");
});

test("only the LAN listener's own mark says a request came over the network: never an address, never a header", () => {
  // A public bind behind a TLS proxy on another machine arrives on a non-loopback address and is NOT the LAN listener: its
  // browsers are remembered over HTTPS as before. console-remembered.test.mjs runs the real listener on loopback.
  assert.equal(arrivedOverLan({ socket: { localAddress: "192.168.68.62" }, headers: {} }), false);
  assert.equal(arrivedOverLan({ socket: { localAddress: "127.0.0.1", lan: true }, headers: { "x-lan": "1" } }), false, "no property a request could name");
  assert.equal(arrivedOverLan({}), false);
});

test("PI_CONSOLE_LAN and PI_CONSOLE_LAN_PORT: off by default, 1 turns it on, a port is a whole number, anything else refuses", () => {
  const base = { dir: "/d", platform: "darwin" };
  assert.deepEqual(consoleConfig({ ...base, env: {} }).lan, { on: false, port: null });
  assert.deepEqual(consoleConfig({ ...base, env: { PI_CONSOLE_LAN: "1" } }).lan, { on: true, port: null });
  assert.deepEqual(consoleConfig({ ...base, env: { PI_CONSOLE_LAN: "1", PI_CONSOLE_LAN_PORT: "8080" } }).lan, { on: true, port: 8080 });
  assert.match(consoleConfig({ ...base, env: { PI_CONSOLE_LAN: "yes" } }).refusal, /PI_CONSOLE_LAN must be 1 or unset/);
  assert.match(consoleConfig({ ...base, env: { PI_CONSOLE_LAN_PORT: "0" } }).refusal, /PI_CONSOLE_LAN_PORT must be a whole number from 1 to 65535/);
  // The loopback listener is unchanged: the LAN one is added beside it, never in its place.
  assert.equal(consoleConfig({ ...base, env: { PI_CONSOLE_LAN: "1" } }).listen.host, "127.0.0.1");
});

test("the sign-in page reached over the network says so: plain HTTP, and not remembered there", () => {
  assert.match(LISTEN_FOOTERS.lan, /local network, in plain HTTP\. This browser is not remembered here/);
  assert.ok(String(signInContent({ listen: "lan" })).includes(LISTEN_FOOTERS.lan));
});

test("over the network the page names the host where it would say this computer, and promises no remembered browser", () => {
  const page = String(signInContent({ listen: "lan", approve: true }));
  assert.ok(page.includes(LAN_WORDS.approveLabel) && !page.includes(APPROVE_LABEL), "the button asks the host");
  assert.ok(!/this computer/i.test(page), "no sentence calls the phone the host");
  assert.ok(!page.includes("stays signed in"), "nothing promises a remembered browser");
  assert.ok(!page.includes("signin__remember"), "no Remember box is drawn there (the server passes remember: false)");
  for (const [kind, n] of Object.entries(LAN_SIGN_IN_NOTICES)) {
    assert.ok(Object.hasOwn(SIGN_IN_NOTICES, kind), `${kind} is a sign-in notice kind`);
    assert.equal(n.status, SIGN_IN_NOTICES[kind].status);
    assert.equal(n.icon, SIGN_IN_NOTICES[kind].icon);
    assert.ok(page.includes(n.title.replace("'", "&#39;")), kind);
  }
  // The same page on this host keeps its own words.
  const here = String(signInContent({ listen: "localhost", approve: true }));
  assert.ok(here.includes(APPROVE_LABEL) && here.includes(CODE_HINT.split("`")[0]) && !here.includes(LAN_WORDS.approveLabel));
});
