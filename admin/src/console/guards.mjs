/**
 * The console's request guards (issue #640, REQ-CONSOLE-SECURITY clauses b, c and d). Each is a pure function that
 * returns a refusal sentence or null, so the dispatcher in `server.mjs` can apply them from the route table and a test
 * can drive each one without a socket.
 *
 * THE HOST CHECK IS BY HOSTNAME, NEVER BY PORT. `ssh -L 8080:127.0.0.1:4790` makes the browser send
 * `Host: localhost:8080`, so pinning the configured `host:port` would refuse every tunnel on another local port. DNS
 * rebinding is defeated by the NAME: a rebound page is still addressed as `evil.test`, and that name is not on the
 * list whatever port it carries.
 *
 * THE CONTAINER GATEWAY NAMES ARE REFUSED ALWAYS. On Docker Desktop `host.docker.internal` reaches the host's own
 * loopback listeners, so a job container is a client of a loopback-only console unless its Host is refused. Adding
 * one of these names to PI_CONSOLE_ALLOWED_HOSTS is refused at startup (`config.mjs`) rather than honoured here, so
 * no configuration can reopen that path. This stops a browser and any client that keeps the name it dialled; a program
 * in a job can send `Host: localhost` instead, so against a job the token is the barrier and the unix socket the cure.
 *
 * WRITES NEED `Sec-Fetch-Site: same-origin` EXACTLY. Browsers ignore ports when deciding "site", so a page served by
 * any other app on `localhost:3000` is `same-site` to the console and receives its `SameSite=Strict` cookie. Only
 * `same-origin` proves the request came from the console's own pages. Where the header is absent (an old engine, a
 * non-browser client), `Origin` must equal `http://<Host>`; it is checked in BOTH cases, so a missing `Origin` on a
 * write is a refusal even beside a `same-origin` claim.
 */
import { isJsonContentType } from "@edgehero/pi-dispatch/http-body";

/** The names a container uses to reach the host it runs on. Never a valid console Host, whatever is configured. */
export const GATEWAY_HOSTS = Object.freeze(["host.docker.internal", "host.containers.internal", "gateway.docker.internal"]);

/** The loopback names a browser on this host uses for the console. Extras come from PI_CONSOLE_ALLOWED_HOSTS. */
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const BRACKETED_RE = /^\[[0-9a-f:.]+\]$/;

/**
 * The hostname of a Host header value (or of an allowed-hosts entry), normalized for comparison: lowercased, one
 * trailing dot dropped (`localhost.` is `localhost` to a resolver), an IPv6 literal kept in its brackets. Any port is
 * dropped after checking it is digits. Returns null for anything that is not a plain name or literal, so a value with
 * a path, a userinfo or a stray character is refused rather than half-parsed.
 */
export function hostnameOf(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  let name;
  let rest;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    name = text.slice(0, close + 1);
    rest = text.slice(close + 1);
    if (!BRACKETED_RE.test(name)) return null;
  } else {
    const colon = text.indexOf(":");
    name = colon < 0 ? text : text.slice(0, colon);
    rest = colon < 0 ? "" : text.slice(colon);
    if (name.endsWith(".")) name = name.slice(0, -1);
    if (!NAME_RE.test(name)) return null;
  }
  if (rest !== "" && !/^:[0-9]{1,5}$/.test(rest)) return null;
  return name;
}

/** True for a container gateway name, after the same normalization the Host check uses. */
export function isGatewayHost(value) {
  const name = hostnameOf(value);
  return name !== null && GATEWAY_HOSTS.includes(name);
}

/**
 * Refuse a request whose Host hostname is not loopback or an allowed extra (any port). Returns a sentence or null.
 * The sentence names the hostname so the operator who added a tunnel name can see what to allow; it is scrubbed and
 * capped by whoever records it.
 */
export function hostRefusal(hostHeader, allowedHosts = []) {
  if (typeof hostHeader !== "string" || hostHeader.trim() === "") {
    return "the request has no Host header, so it cannot be told apart from a rebinding attack; send one";
  }
  const name = hostnameOf(hostHeader);
  if (name === null) return "the Host header is not a plain hostname or IP literal, so the request was refused";
  if (GATEWAY_HOSTS.includes(name)) {
    return `the Host ${name} is a container gateway name; the console never answers a container, whatever is configured`;
  }
  if (LOOPBACK_HOSTS.includes(name)) return null;
  for (const extra of allowedHosts) if (hostnameOf(extra) === name) return null;
  return `the Host ${name} is not 127.0.0.1, localhost or [::1], nor listed in PI_CONSOLE_ALLOWED_HOSTS; open the console by one of those names (any port)`;
}

/**
 * Refuse a write that did not come from the console's own origin. `headers` is node's lowercased header object.
 * `Sec-Fetch-Site`, when the browser sent it, must be exactly `same-origin`; `Origin` must then equal `http://<Host>`
 * in every case (the console speaks plain HTTP on loopback; TLS is the tunnel's job).
 */
export function originRefusal(headers) {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return `a write must come from the console's own page (Sec-Fetch-Site was ${String(site).slice(0, 20)}, and only same-origin is accepted)`;
  }
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") {
    return "a write must carry an Origin header naming the console, and this one carried none";
  }
  const host = headers.host;
  if (typeof host !== "string" || origin.toLowerCase() !== `http://${host.trim().toLowerCase()}`) {
    return "a write must come from the console's own origin, and its Origin header named another";
  }
  return null;
}

/**
 * Refuse a write whose body is not JSON. A cross-origin form can send `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/plain` without a CORS preflight; it cannot send `application/json` without one, and
 * this server never answers a preflight with an allow.
 */
export function contentTypeRefusal(headers) {
  if (isJsonContentType(headers["content-type"])) return null;
  return "a write must send Content-Type: application/json";
}

/** PI_CONSOLE_READ_ONLY=1 refuses every write route except signing in and out. */
export function readOnlyRefusal(config) {
  return config?.readOnly ? "the console is read-only (PI_CONSOLE_READ_ONLY=1), so no change can be made from it" : null;
}

/** A route that needs the operator role refuses a viewer. Ranks are fixed: none < viewer < operator. */
export function roleRefusal(session, need) {
  const rank = { none: 0, viewer: 1, operator: 2 };
  const have = session ? rank[session.role] ?? 0 : 0;
  if (have >= (rank[need] ?? 2)) return null;
  return `this needs the ${need} role, and the signed-in token ${session ? `has the ${session.role} role` : "is absent"}; ask an operator to make the change`;
}

/**
 * The login rate limit: ONE global token bucket, because every peer of a loopback console is the same address and a
 * per-address bucket would be one bucket anyway. `perMinute` refills, `burst` is the ceiling. It delays guessing, it
 * does not lock anyone out: a local attacker can still slow the operator's own sign-in, a residual named in
 * DES-OPERATOR-CONSOLE that unix-socket mode removes. Against 256-bit tokens the bucket bounds log noise more than it
 * bounds a guess.
 */
export function makeLoginLimiter({ now, perMinute = 5, burst = 10 }) {
  let tokens = burst;
  let last = now();
  const refill = () => {
    const at = now();
    if (at > last) tokens = Math.min(burst, tokens + ((at - last) * perMinute) / 60000);
    last = Math.max(last, at);
  };
  return {
    take() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
    retryAfterSec() {
      refill();
      return Math.max(1, Math.ceil(((1 - tokens) * 60) / perMinute));
    },
  };
}
