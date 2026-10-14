/**
 * The console's sessions (issue #640): an in-memory store, so a restart signs everyone out. That is deliberate, not a
 * gap: a session file would be one more secret on disk to judge, and a console restart is rare and cheap to recover
 * from (sign in again).
 *
 * A session is created at login with a NEW random id (never one the browser offered, so a planted cookie cannot be
 * promoted to a signed-in one) and remembers the token it was signed in with: its hash, its role and the file's
 * `generation` at that moment. Every request re-judges it against the tokens file as the console has it now, so:
 *   - revoking or rotating the token (its hash leaves the file) ends the session on its next request;
 *   - changing the token's role (a hand edit) ends it, rather than letting a viewer's session carry operator rights or
 *     the reverse;
 *   - `sessions end-all` (a bumped `generation`) ends every session at once.
 * A session that fails any check is DELETED, not just refused, so it cannot come back if the file is edited back.
 *
 * The comparisons against `file.tokens` here are of a hash the SERVER holds, not of anything a browser sent, so they
 * need no constant-time compare; the token lookup at login does (`findToken` in the worker's console-tokens module).
 * The session id lookup is a Map hit on a 256-bit random key, which no timing can walk.
 */
import { createHash, randomBytes } from "node:crypto";

/** The cookie's name. Not `__Host-`: that prefix needs `Secure`, which the lab has not yet shown to hold on http loopback. */
export const COOKIE_NAME = "pdc_session";

/** A session id: 32 random bytes as base64url, always exactly 43 characters. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The store. `idleMs` (no request for this long ends a session), `maxMs` (no session outlives this, however busy),
 * `maxStreams` (the live event streams one TOKEN may hold, for #641: every session signed in with the same token name
 * shares the one budget, so signing in eight times does not buy eight times the streams). `now` and `random` are the
 * seams.
 */
export function makeSessionStore({ now = () => Date.now(), random = randomBytes, idleMs = 60 * 60000, maxMs = 12 * 3600000, maxStreams = 4 } = {}) {
  const sessions = new Map();
  // Open stream slots: per session id `{name, count}`, and per token name the sum. A session that ends keeps its entry
  // until its streams close and give their slots back (the hub ends them within a tick), so the token's count is never
  // forgotten while those streams still run.
  const streams = new Map();
  const byName = new Map();

  function expired(session, t) {
    return t - session.lastSeen > idleMs || t - session.createdAt > maxMs;
  }

  function drop(id) {
    sessions.delete(id);
  }

  /** The stored session `id` names when every check passes against `file` now, else null. Changes nothing. */
  function judge(id, file) {
    if (typeof id !== "string") return null;
    const session = sessions.get(id);
    if (!session) return null;
    const tokens = Array.isArray(file?.tokens) ? file.tokens : [];
    const valid =
      !expired(session, now()) &&
      file?.generation === session.generation &&
      tokens.some((entry) => entry?.sha256 === session.tokenHash && entry?.role === session.role);
    return valid ? session : null;
  }

  /** Forget every session past its idle or absolute limit, so an abandoned browser does not hold memory forever. */
  function sweep() {
    const t = now();
    for (const [id, session] of sessions) if (expired(session, t)) drop(id);
  }

  return {
    /** A new session for a token that just signed in: `{id}`. */
    create({ name, role, tokenHash, generation }) {
      sweep();
      const id = random(32).toString("base64url");
      const t = now();
      sessions.set(id, { id, name, role, tokenHash, generation, createdAt: t, lastSeen: t });
      return { id };
    },

    /**
     * The live session `id` names, judged against the tokens `file` as it is now, or null (and the session is gone):
     * unknown, idle past `idleMs`, older than `maxMs`, a different `generation`, or no entry in the file with its hash
     * AND its role. A live one has its `lastSeen` moved to now; a copy is returned.
     */
    get(id, file) {
      const session = judge(id, file);
      if (!session) {
        if (typeof id === "string") drop(id);
        return null;
      }
      session.lastSeen = now();
      return { ...session };
    },

    /**
     * `get`'s every check without its two side effects (issue #641): `lastSeen` is NOT moved and a failing session is
     * NOT deleted. The live hub re-judges each open event stream with this every tick, so an open tab cannot keep an
     * idle session alive (only a request does), and a stream that dies leaves the session for the next request to end
     * the ordinary way. A copy or null.
     */
    peek(id, file) {
      const session = judge(id, file);
      return session ? { ...session } : null;
    },

    /** End a session (logout). */
    destroy(id) {
      drop(id);
    },

    /** How many sessions are held, after forgetting the expired ones. */
    size() {
      sweep();
      return sessions.size;
    },

    /**
     * Take one event-stream slot for the session's token: true when the token (every session signed in with its name)
     * holds fewer than `maxStreams`, false at the cap or for no session.
     */
    streamAcquire(id) {
      const session = sessions.get(id);
      if (!session) return false;
      const name = String(session.name);
      const held = byName.get(name) ?? 0;
      if (held >= maxStreams) return false;
      byName.set(name, held + 1);
      const own = streams.get(id) ?? { name, count: 0 };
      own.count += 1;
      streams.set(id, own);
      return true;
    },

    /** Give a slot back, to the session and its token. Never below zero; it works for a session already ended too. */
    streamRelease(id) {
      const own = streams.get(id);
      if (!own) return;
      own.count -= 1;
      if (own.count <= 0) streams.delete(id);
      const held = (byName.get(own.name) ?? 0) - 1;
      if (held <= 0) byName.delete(own.name);
      else byName.set(own.name, held);
    },
  };
}

/**
 * The Set-Cookie value that hands a browser its session. `HttpOnly` (no page script reads it), `SameSite=Strict` (no
 * other site's page makes the browser send it), `Path=/`. No `Secure` yet: the console serves plain http on loopback,
 * and whether every browser keeps a Secure cookie there is the lab's question. The id is checked, so nothing that
 * could split the header ever reaches it.
 */
export function sessionCookie(id, { maxAgeSec } = {}) {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) throw new Error("a session id is 43 base64url characters");
  const age = Number.isSafeInteger(maxAgeSec) && maxAgeSec > 0 ? `; Max-Age=${maxAgeSec}` : "";
  return `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/${age}`;
}

/** The Set-Cookie value that makes the browser forget its session cookie (logout, a refused session). */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * The session id in a request's Cookie header, or null. Only a cookie named exactly `pdc_session` counts (a
 * `xpdc_session` or `pdc_session2` does not), every other cookie is ignored, and a value that is not a well-formed id
 * is null rather than a lookup. TWO `pdc_session` cookies are null too: a sibling path or a cookie planted by another
 * loopback service can add one, and picking either would let that one decide which session the request runs as.
 */
export function readSessionCookie(cookieHeader) {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (typeof header !== "string" || header === "") return null;
  let found = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found !== null && SESSION_ID_RE.test(found) ? found : null;
}

/** A session's name in an audit row: the first 12 hex of its id's SHA-256, so the row never carries the id itself. */
export function sessionDigest(id) {
  return createHash("sha256").update(String(id), "utf8").digest("hex").slice(0, 12);
}
