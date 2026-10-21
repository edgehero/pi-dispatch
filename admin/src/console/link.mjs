/**
 * Where a console page is, for the surfaces that point at the console instead of drawing the page themselves (the
 * insights move to the console): `/dispatch insights`, `/dispatch insights whatif` and the dashboard's `i` key print
 * the spend screen's address. The address is the deployment's `PI_CONSOLE_LISTEN`, parsed by the console's own
 * `parseListen`, else the console's default (`DEFAULT_LISTEN`), so the URL printed is the one `pi-dispatch-console
 * serve` would bind. Nothing HERE checks that a console is running; the worker's `console-probe.mjs` does, for
 * `/dispatch console` and doctor alike (issue #708). It once was "a network call from the panel for a line of text", and declined for that. The reversal's reason:
 * the panel printed an address that did not answer, with nothing to say so, which is the silent failure this project
 * refuses. The probe stays bounded to this host's loopback or the socket (`consoleProbeTarget`).
 */
import { isIPv4 } from "node:net";

import { DEFAULT_LISTEN } from "./config.mjs";
import { listenUrl, parseListen } from "./listen.mjs";

/** True for the any-address binds, `0.0.0.0` and `::` in any spelling (`[::]`, `0:0:0:0:0:0:0:0`, `::0`). */
export function isUnspecified(host) {
  if (isIPv4(host)) return host === "0.0.0.0";
  try {
    return new URL(`http://[${host}]/`).hostname === "[::]";
  } catch {
    return false;
  }
}

/**
 * `text` as one POSIX shell word: as it is when it holds only characters no shell treats specially, else in single
 * quotes with each embedded quote closed, escaped and reopened. The socket path is printed into an `ssh -L` line an
 * operator pastes, and a path holding a space, a `;` or a `$(...)` would otherwise split the line or run the rest.
 */
export function shellWord(text) {
  return /^[A-Za-z0-9_./+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The console page `path` (no leading `/`, a query allowed) for the deployment env `env`: `{ url, defaulted }` for a
 * TCP listener (`anyHost` set when it binds every address: the URL then names `<this host>`, since `http://0.0.0.0`
 * is no address a browser elsewhere can open), `{ socket, path }` for a unix socket (reach it through a tunnel),
 * `{ ephemeral: true }` for port 0 (the OS picks the port at bind, so only the running console knows it), or
 * `{ refusal }` for a `PI_CONSOLE_LISTEN` the console would refuse or this line cannot print.
 */
export function consolePageUrl(env, path, { platform = process.platform } = {}) {
  const declared = String(env?.PI_CONSOLE_LISTEN ?? "").trim();
  const listen = parseListen(declared || DEFAULT_LISTEN, { bindPublic: env?.PI_CONSOLE_BIND_PUBLIC === "1", platform });
  if (listen.refusal) return { refusal: listen.refusal };
  if (listen.kind === "unix") {
    // Control bytes are refused rather than quoted: inside quotes they still reach the terminal the line is shown in.
    if (/[\u0000-\u001f\u007f]/.test(listen.path)) return { refusal: "PI_CONSOLE_LISTEN unix socket path holds a control character; choose a plain path" };
    return { socket: listen.path, path };
  }
  if (listen.port === 0) return { ephemeral: true };
  if (isUnspecified(listen.host)) return { url: `http://<this host>:${listen.port}/${path}`, defaulted: declared === "", anyHost: true };
  return { url: `${listenUrl(listen)}${path}`, defaulted: declared === "" };
}

/**
 * How to start a console that is not running: ONE constant, so a new way to run it (a service) is added in one place and
 * every surface that says it (this hint and `/dispatch console`'s "not running" line) says the same.
 */
export const CONSOLE_START_ADVICE = "start it with pi-dispatch-console serve, or keep it running with pi-dispatch service install --console (docs/console.md)";

/** How to start the console, said wherever its address is printed. */
export const CONSOLE_START_HINT = `if the console is not running, ${CONSOLE_START_ADVICE}`;

/**
 * The lines a panel surface prints for console page `path`: the URL (or the tunnel to take, or why the address is
 * unusable) and how to start the console.
 */
export function consolePageLines(env, path, opts) {
  const at = consolePageUrl(env, path, opts);
  if (at.refusal) return [`the console's address is not usable: ${at.refusal}`, `fix PI_CONSOLE_LISTEN in the deployment's .env, start the console with pi-dispatch-console serve, and open /${path}`];
  if (at.socket) return [`the console listens on the unix socket ${at.socket}: ssh -L 4790:${shellWord(at.socket)} <this host>, then open http://localhost:4790/${path}`, CONSOLE_START_HINT];
  if (at.ephemeral) return [`the console listens on a port the OS picks (PI_CONSOLE_LISTEN port 0), so its address is not known here: pi-dispatch-console serve prints it; open /${path} there`, CONSOLE_START_HINT];
  if (at.anyHost) return [at.url, `the console binds every address of this host, so open it by this host's name or address; ${CONSOLE_START_HINT}`];
  return [at.url, at.defaulted ? `PI_CONSOLE_LISTEN is not set, so that is the console's default address; ${CONSOLE_START_HINT}` : CONSOLE_START_HINT];
}
