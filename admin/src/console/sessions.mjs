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
 * `maxStreams` (the live event streams one session may hold, for #641). `now` and `random` are the seams.
 */
export function makeSessionStore({ now = () => Date.now(), random = randomBytes, idleMs = 60 * 60000, maxMs = 12 * 3600000, maxStreams = 4 } = {}) {
  const sessions = new Map();
  const streams = new Map();

  function expired(session, t) {
    return t - session.lastSeen > idleMs || t - session.createdAt > maxMs;
  }

  function drop(id) {
    sessions.delete(id);
    streams.delete(id);
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
      if (typeof id !== "string") return null;
      const session = sessions.get(id);
      if (!session) return null;
      const t = now();
      const tokens = Array.isArray(file?.tokens) ? file.tokens : [];
      const valid =
        !expired(session, t) &&
        file?.generation === session.generation &&
        tokens.some((entry) => entry?.sha256 === session.tokenHash && entry?.role === session.role);
      if (!valid) {
        drop(id);
        return null;
      }
      session.lastSeen = t;
      return { ...session };
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

    /** Take one of the session's event-stream slots: true when it was free, false at `maxStreams` or for no session. */
    streamAcquire(id) {
      if (!sessions.has(id)) return false;
      const held = streams.get(id) ?? 0;
      if (held >= maxStreams) return false;
      streams.set(id, held + 1);
      return true;
    },

    /** Give a slot back. Never below zero, and a no-op for a session already gone. */
    streamRelease(id) {
      const held = streams.get(id) ?? 0;
      if (held <= 1) streams.delete(id);
      else streams.set(id, held - 1);
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
