/**
 * The console on the local network, by name (issue #882, the owner's opt-in): with `PI_CONSOLE_LAN=1` the console keeps
 * its loopback listener and adds a SECOND one other devices on the network can reach, and announces `pi-dispatch.local`
 * for it over mDNS, so a phone or a second computer opens `http://pi-dispatch.local/` (macOS) or
 * `http://pi-dispatch.local:4790/` (Linux) with no IP address to know.
 *
 * WHAT IT COSTS, said where it applies (docs/console.md, SECURITY.md, the sign-in footer, doctor): the LAN listener is
 * plain HTTP, so a sign-in there crosses the network unencrypted and no browser is remembered on it (server.mjs
 * `rememberTransportOk`: a request that came in on this listener is never remembered, by the mark it puts on its
 * connections, `arrivedOverLan`); every device on the
 * network reaches the sign-in page; and the page's Copy buttons are hidden there (no secure context). A person signs in
 * on it with a code from `pi-dispatch-console link`, or by having someone at the host press Allow (approve-dialog.mjs,
 * whose window names the requesting address), or with a token. The loopback listener and its remembered browsers stay
 * exactly as they were.
 *
 * WHERE IT LISTENS. macOS lets an unprivileged process bind port 80 on the wildcard address but not on a specific one
 * (measured on macOS 27, 2026-11-14: 0.0.0.0:80 bound, 127.0.0.1:80 EACCES), so there the second listener tries
 * `0.0.0.0:80` first and the name needs no port. Everywhere else, and on macOS when 80 is taken, it binds the LAN address
 * itself on the console's own port (a specific address beside the loopback one: a wildcard bind would collide with it on
 * Linux). `PI_CONSOLE_LAN_PORT` names another port, bound on the LAN address. Port 80 on Linux needs privileges this
 * project never takes (`service.mjs`: user-level, never root), so Linux keeps a port.
 *
 * THE NAME. macOS: `dns-sd -P pi-dispatch _http._tcp local <port> pi-dispatch.local <address>`, which publishes the
 * name's address record and an HTTP service while the process runs. Linux: `avahi-publish -a -R pi-dispatch.local
 * <address>` where avahi is installed. Either runs as a child the console supervises (started again after it exits,
 * stopped with the console). With no tool, or a name another device already holds, the console says so and the LAN
 * listener still answers by address. REJECTED: an mDNS library in the console (a new dependency, and a responder of our
 * own beside the system's), and announcing the loopback address (every other device would connect to itself).
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

// env-internal PATH: searched for avahi-publish, as a shell would.
/** The name the console announces on the network, and answers to on its LAN listener. */
export const LAN_HOSTNAME = "pi-dispatch.local";
/** How long the supervisor waits before starting a name announcer that exited again. */
export const LAN_ANNOUNCE_RESTART_MS = 5_000;

/**
 * The address the LAN listener binds and the name points at: the first non-internal IPv4 address, preferring the usual
 * wired and wireless interfaces (`en0`, `eth0`, `wlan0`), or null where the host has none.
 */
export function lanAddressOf(interfaces = networkInterfaces()) {
  const preferred = ["en0", "en1", "eth0", "wlan0"];
  const names = [...preferred.filter((n) => interfaces[n]), ...Object.keys(interfaces).filter((n) => !preferred.includes(n)).sort()];
  for (const name of names) {
    for (const a of interfaces[name] ?? []) {
      const family = typeof a.family === "string" ? a.family : a.family === 4 ? "IPv4" : "IPv6";
      if (family === "IPv4" && !a.internal && typeof a.address === "string" && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return null;
}

/**
 * Where to try the LAN listener, in order: `[{ host, port }]`. On macOS with no port named, the wildcard on 80 first,
 * then the LAN address on the console's own port; elsewhere, or with a port named, the LAN address on that port.
 */
export function lanBindsFor({ platform = process.platform, address, port = null, loopbackPort }) {
  const own = { host: address, port: port ?? loopbackPort };
  if (platform === "darwin" && port === null) return [{ host: "0.0.0.0", port: 80 }, own];
  return [own];
}

/** The address a person types on another device, for the port the LAN listener bound. */
export function lanUrlOf(port) {
  return port === 80 ? `http://${LAN_HOSTNAME}/` : `http://${LAN_HOSTNAME}:${port}/`;
}

/** Whether an executable named `name` is on `envPath`. */
function onPath(name, envPath, access) {
  for (const dir of String(envPath ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      access(join(dir, name), fsConstants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

/**
 * The command that announces `pi-dispatch.local` for `address`, or `{ refusal }` where this host has no tool for it.
 */
export function announceCommandFor({ platform = process.platform, env = process.env, access = accessSync, address, port }) {
  if (platform === "darwin") {
    try {
      access("/usr/bin/dns-sd", fsConstants.X_OK);
    } catch {
      return { refusal: "dns-sd is missing, so the name is not announced" };
    }
    return { cmd: "/usr/bin/dns-sd", args: ["-P", "pi-dispatch", "_http._tcp", "local", String(port), LAN_HOSTNAME, address] };
  }
  if (platform === "linux") {
    const avahi = onPath("avahi-publish", env.PATH, access);
    if (!avahi) return { refusal: "avahi-publish is not installed (the avahi-utils package), so the name is not announced" };
    return { cmd: avahi, args: ["-a", "-R", LAN_HOSTNAME, address] };
  }
  return { refusal: "this platform has no tool the console uses to announce a name" };
}

/**
 * Run the announcer and keep it running: started again `restartMs` after it exits, until `stop()`. A line it writes
 * that says the name is taken is logged once, and so is the first time it exits on its own. `log(line)` hears what an
 * operator needs; nothing from the tool's output reaches it but the one fact. `onExit` ends the child when the console
 * process exits without reaching `stop()` (an uncaught error): a child is not ended with its parent on Unix, and an
 * orphaned announcer would keep pointing the name at a listener that is gone.
 */
export function superviseAnnouncer({ command, spawnFn = spawn, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, restartMs = LAN_ANNOUNCE_RESTART_MS, onExit = (fn) => process.once("exit", fn) }) {
  let child = null;
  let timer = null;
  let stopped = false;
  let saidConflict = false;
  let saidExit = false;
  onExit(() => {
    try { child?.kill("SIGTERM"); } catch {}
  });
  const start = () => {
    if (stopped) return;
    try {
      child = spawnFn(command.cmd, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      log(`console: ${command.cmd} could not be started, so ${LAN_HOSTNAME} is not announced; trying again in ${Math.round(restartMs / 1000)} s`);
      timer = setTimer(start, restartMs);
      return;
    }
    const watch = (d) => {
      if (!saidConflict && /conflict|collision|already/i.test(String(d))) {
        saidConflict = true;
        log(`console: another device on this network already uses ${LAN_HOSTNAME}; this console answers on the network by its address only`);
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.on("error", () => {});
    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      if (!saidExit) {
        saidExit = true;
        log(`console: ${command.cmd} stopped announcing ${LAN_HOSTNAME} (exit ${code ?? "by signal"}); starting it again every ${Math.round(restartMs / 1000)} s`);
      }
      timer = setTimer(start, restartMs);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      try { child?.kill("SIGTERM"); } catch {}
    },
  };
}
