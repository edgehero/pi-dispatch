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
 *
 * WHY A SESSION ENDED (issues #737 and #711). A session that ends leaves a TOMBSTONE, its id and the reason, so the
 * request that next presents its cookie can be sent to `/login?ended=<reason>` and the sign-in page can say why
 * (`session-ends.mjs`). The reasons are judged in one order, so a session that fails two checks always reads the same:
 * idle, then max (a session idle past its limit at its twelfth hour was ended by the idle limit first), then all (the
 * file's `generation` moved: `sessions end-all`), then role (an entry with its hash, none with its role), then revoked
 * (no entry with its hash). A tombstone is written only where a session that WAS live ends: a failing `get`, `sweep`,
 * and `destroy`. `peek` and `verdict` write nothing, so the hub can ask every tick without ending anything itself.
 *
 *   - Keyed by the 256-bit id alone, and each reason describes that session's own token, so a tombstone tells a
 *     browser nothing about any other token or session.
 *   - Bounded (`TOMBSTONE_MAX`, oldest first out). Once one has been forgotten, an unknown id can no longer be told
 *     from a forgotten one, which is why `restart` needs `evicted === 0`.
 *   - `restart` is a possibility, never a claim: an id of the right shape that this process never knew, while it has
 *     been up for less than a session's longest life. A planted cookie looks the same, so the sentence says "may".
 *   - An UNUSABLE tokens file (no `tokens` array) judges nothing: `get` answers null and deletes nothing, writes no
 *     tombstone, so a chmod mistake signs nobody out; the server answers 503 before it would ask (`server.mjs`).
 *
 * THE FLASH is the one change a session's next page reports in its banner (`setFlash` after a write, `takeFlash` when
 * the page is drawn). It is kept apart from the session, so `get`'s copies stay the shape every caller relies on, and
 * dropped with the session.
 */
import { createHash, randomBytes } from "node:crypto";

/** The cookie's name. Not `__Host-`: that prefix needs `Secure`, which the lab has not yet shown to hold on http loopback. */
export const COOKIE_NAME = "pdc_session";

/** A session id: 32 random bytes as base64url, always exactly 43 characters. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The tombstones a store keeps. Each is a 43-character id and a short word, so 1024 is under 100 KiB; past it the
 * oldest goes first, and `restart` is never said again by this process (see the header).
 */
export const TOMBSTONE_MAX = 1024;

/**
 * The largest flash a session holds, as JSON bytes. A change summary is a few hundred bytes; an inverse body can be a
 * whole list (pause windows), and a flash past this is refused rather than held (the writer drops the inverse first).
 */
export const FLASH_MAX_BYTES = 16384;

/** The reasons `destroy` takes: a sign-out or a sign-in over the cookie (`elsewhere`), or null for none (an audit failure). */
const DESTROY_REASONS = Object.freeze(["elsewhere", null]);

/**
 * The store. `idleMs` (no request for this long ends a session), `maxMs` (no session outlives this, however busy),
 * `maxStreams` (the live event streams one TOKEN may hold, for #641: every session signed in with the same token name
 * shares the one budget, so signing in eight times does not buy eight times the streams), `tombstoneMax` (tests only:
 * how many ended ids are remembered). `now` and `random` are the seams.
 */
export function makeSessionStore({ now = () => Date.now(), random = randomBytes, idleMs = 60 * 60000, maxMs = 12 * 3600000, maxStreams = 4, tombstoneMax = TOMBSTONE_MAX } = {}) {
  const sessions = new Map();
  // Open stream slots: per session id `{name, count}`, and per token name the sum. A session that ends keeps its entry
  // until its streams close and give their slots back (the hub ends them within a tick), so the token's count is never
  // forgotten while those streams still run.
  const streams = new Map();
  const byName = new Map();
  // Ended ids and their reason, in insertion order (a Map iterates oldest first, which makes it the FIFO).
  const tombstones = new Map();
  const flashes = new Map();
  // When this store, so this process, began: `restart` is possible only while a session from before could still live.
  const bornAt = now();
  let evicted = 0;

  /** The time limit a session is past at `t`, idle first, or null. */
  function timeReason(session, t) {
    if (t - session.lastSeen > idleMs) return "idle";
    if (t - session.createdAt > maxMs) return "max";
    return null;
  }

  /** A file that can judge a session: one with a `tokens` array. Anything else is unjudged and ends nothing. */
  function usable(file) {
    return Array.isArray(file?.tokens);
  }

  /** Why `session` fails against the usable `file` at `t`, in the header's order, or null when it passes. */
  function reasonOf(session, file, t) {
    const timed = timeReason(session, t);
    if (timed !== null) return timed;
    if (file.generation !== session.generation) return "all";
    const withHash = file.tokens.filter((entry) => entry?.sha256 === session.tokenHash);
    if (withHash.some((entry) => entry?.role === session.role)) return null;
    return withHash.length > 0 ? "role" : "revoked";
  }

  /** Remember that `id` ended for `reason` (null: no reason to give). Newest last; past the cap the oldest goes. */
  function tombstone(id, reason) {
    tombstones.delete(id);
    tombstones.set(id, reason);
    while (tombstones.size > tombstoneMax) {
      tombstones.delete(tombstones.keys().next().value);
      evicted += 1;
    }
  }

  /** End a session that was live: its tombstone first, then it and its flash are gone. */
  function end(id, reason) {
    tombstone(id, reason);
    sessions.delete(id);
    flashes.delete(id);
  }

  /** The stored session `id` names when every check passes against `file` now, else null. Changes nothing. */
  function judge(id, file) {
    if (typeof id !== "string" || !usable(file)) return null;
    const session = sessions.get(id);
    if (!session) return null;
    return reasonOf(session, file, now()) === null ? session : null;
  }

  /** Forget every session past its idle or absolute limit, so an abandoned browser does not hold memory forever. */
  function sweep() {
    const t = now();
    for (const [id, session] of sessions) {
      const reason = timeReason(session, t);
      if (reason !== null) end(id, reason);
    }
  }

  /** Why a session id no longer signs in (see `endedOf` below). */
  function endedOf(id) {
    if (typeof id !== "string" || sessions.has(id)) return null;
    if (tombstones.has(id)) return tombstones.get(id);
    return SESSION_ID_RE.test(id) && now() - bornAt < maxMs && evicted === 0 ? "restart" : null;
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
     * The live session `id` names, judged against the tokens `file` as it is now, or null: unknown, idle past
     * `idleMs`, older than `maxMs`, a different `generation`, or no entry in the file with its hash AND its role. A
     * live one has its `lastSeen` moved to now; a copy is returned. A live one that fails is ended (its tombstone
     * says which check, then it is deleted), so editing the file back cannot revive it. An unknown id changes nothing,
     * and neither does an unusable file: null, with the session kept (see the header).
     */
    get(id, file) {
      if (typeof id !== "string" || !usable(file)) return null;
      const session = sessions.get(id);
      if (!session) return null;
      const t = now();
      const reason = reasonOf(session, file, t);
      if (reason !== null) {
        end(id, reason);
        return null;
      }
      session.lastSeen = t;
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

    /**
     * What `get` would conclude, with no side effect at all (the hub's reason for ending a stream, issue #737):
     * `{session}` (a copy) for a live session that passes, `{ended: <reason>}` for a live one that fails, `{ended:
     * endedOf(id)}` for an id the store does not hold, and `{unjudged: true}` for an unusable file, which ends nothing.
     */
    verdict(id, file) {
      if (!usable(file)) return { unjudged: true };
      const session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session) return { ended: endedOf(id) };
      const reason = reasonOf(session, file, now());
      return reason === null ? { session: { ...session } } : { ended: reason };
    },

    /**
     * Why session `id` no longer signs in: null while the store holds it (a live session has not ended, whatever a
     * file says; `verdict` judges that); its tombstone's reason (null for the explicit no-reason entry); else, for an
     * id of a session's shape that this process does not know, `restart` while that is possible (up for less than
     * `maxMs`, no tombstone ever forgotten); else null.
     */
    endedOf,

    /**
     * End a session on purpose: `reason` is `elsewhere` (signed out, or signed in again over its cookie) or null (a
     * session that never reached its browser, as on an audit failure); anything else is a programming error and throws.
     * A tombstone is written only for an id the store holds, so a planted or unknown id leaves none: one already past a
     * time limit keeps that limit as its reason (it had ended before this asked), any other gets `reason`.
     *
     * Returns who it ended, `{name, role}` (a copy), or null for an id it did not hold. Judged by no tokens file: a
     * sign-out ends the session the browser holds whatever the file says (issue #737, `server.mjs` `postLogout`), and
     * names it in the audit row from what the store kept.
     */
    destroy(id, reason = null) {
      if (!DESTROY_REASONS.includes(reason)) throw new RangeError(`sessions.destroy: a reason is elsewhere or null, not ${JSON.stringify(reason)}`);
      const session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session) return null;
      end(id, timeReason(session, now()) ?? reason);
      return { name: session.name, role: session.role };
    },

    /**
     * Hold `change` (a JSON value) for the live session `id`'s next page: stored as its own JSON copy, so nothing the
     * caller keeps can change it afterwards. Refused (ignored, false) for an id the store does not hold, for a value
     * JSON cannot write, and for one past `FLASH_MAX_BYTES`. True when held; a newer flash replaces an older one.
     */
    setFlash(id, change) {
      if (typeof id !== "string" || !sessions.has(id)) return false;
      let text;
      try {
        text = JSON.stringify(change);
      } catch {
        return false;
      }
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > FLASH_MAX_BYTES) return false;
      flashes.set(id, JSON.parse(text));
      return true;
    },

    /** The flash held for `id`, which is then gone (a page shows a change once), or null. */
    takeFlash(id) {
      if (typeof id !== "string" || !flashes.has(id)) return null;
      const change = flashes.get(id);
      flashes.delete(id);
      return change;
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

/** Every `pdc_session` value in a Cookie header, in its order, as sent (well formed or not). */
function sessionCookieValues(cookieHeader) {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (typeof header !== "string" || header === "") return [];
  const found = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    found.push(part.slice(eq + 1).trim());
  }
  return found;
}

/**
 * The session id in a request's Cookie header, or null. Only a cookie named exactly `pdc_session` counts (a
 * `xpdc_session` or `pdc_session2` does not), every other cookie is ignored, and a value that is not a well-formed id
 * is null rather than a lookup. TWO `pdc_session` cookies are null too: a sibling path or a cookie planted by another
 * loopback service can add one, and picking either would let that one decide which session the request runs as.
 */
export function readSessionCookie(cookieHeader) {
  const found = sessionCookieValues(cookieHeader);
  return found.length === 1 && SESSION_ID_RE.test(found[0]) ? found[0] : null;
}

/**
 * EVERY well-formed session id the header carries, each once, in its order: what a sign-out ends (issue #737). Picking
 * one is what `readSessionCookie` refuses to do for a request that runs AS a session, and it is
 * right there; a sign-out runs as nobody, and refusing it the same way let a cookie planted beside the real one (another
 * loopback port's page can set `pdc_session` with `Path=/logout`, which the browser then sends first) turn the sign-out
 * into a no-op answered 200, the page saying "signed out" over a session still live. Ending every one the store holds
 * cannot be steered that way: a planted id ends nothing it does not name.
 */
export function readSessionCookies(cookieHeader) {
  return [...new Set(sessionCookieValues(cookieHeader).filter((v) => SESSION_ID_RE.test(v)))];
}

/** A session's name in an audit row: the first 12 hex of its id's SHA-256, so the row never carries the id itself. */
export function sessionDigest(id) {
  return createHash("sha256").update(String(id), "utf8").digest("hex").slice(0, 12);
}
