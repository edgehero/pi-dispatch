/**
 * The console's view of remembered devices (issue #849): the store in `worker/src/console-devices.mjs`, the rules for judging a record against the tokens
 * file, and the one piece of memory this needs, a deny-list.
 *
 * THE DENY-LIST exists for a device that has to end while the store cannot be written: a sign-out with a full disk, say. The browser really is signed out, since
 * its cookie is cleared, but a copy of the secret would still work until the record is ended, so this process refuses it and retries the write at the next
 * chance. It dies with the process, which is the named residual: after a restart nothing retries, so a copy of the secret works again until someone signs
 * that browser out again or runs `pi-dispatch-console device revoke`. The log line names the device's id for that.
 *
 * NO `await` ANYWHERE ON THE RESTORE PATH. `resolveDevice` in `server.mjs` reads a record, judges it, and finds or makes the one session for that device, all
 * synchronously, and that is what makes several tabs arriving together after a restart share one session without a lock.
 */
import { consoleDevicesDir, devicesDirProblem, deviceCookieName, deviceIdOf, endDevice, hashDeviceSecret, listDevices, readDevice, reapDevices, rememberDevice, touchDevice } from "@edgehero/pi-dispatch/console-devices";

/** How soon after presenting a credential a sign-in may become a remembered device. A stolen ordinary cookie must not be able to turn itself permanent later. */
export const REMEMBER_FRESH_MS = 10 * 60000;

/** Which word the sign-in page uses for why a device ended. */
export const ENDED_OF_DEVICE_REASON = Object.freeze({ "signed-out": "elsewhere", removed: "device", revoked: "revoked", role: "role", all: "all", replaced: "device" });

/** Why this record no longer signs in against the tokens `file`, as a device end reason, or null when it still does. In the session store's own order. */
export function bindingFailure(record, file) {
  if (file.generation !== record.generation) return "all";
  const withHash = file.tokens.filter((entry) => entry?.sha256 === record.tokenHash);
  if (withHash.some((entry) => entry?.role === record.role)) return null;
  return withHash.length > 0 ? "role" : "revoked";
}

export function makeDeviceTrust({ tokensPath, fs, uid = process.geteuid?.(), now = Date.now, random, log = () => {}, platform = process.platform, denyMax = 1024 }) {
  const dir = consoleDevicesDir(tokensPath);
  const denied = new Map();
  const shared = { dir, fs, uid, now, ...(random ? { random } : {}) };

  /** Try again to end what could not be ended, whenever a write has just worked. */
  function retryDenied() {
    for (const [hash, reason] of [...denied]) {
      const done = endDevice({ ...shared, hash, reason });
      if (done.ok || done.absent) denied.delete(hash);
    }
  }

  const trust = {
    cookieName: deviceCookieName(tokensPath),
    dir,

    /** Can a device be remembered at all here? A sentence when not, for the page to show; Windows is the case that matters. */
    unavailable() {
      const problem = devicesDirProblem(dir, { fs, uid, platform, create: false });
      return problem && !problem.absent ? problem.problem : platform === "win32" ? "remembering a device does not work on a Windows host" : null;
    },

    /** Which of `unavailable`'s two cases holds, for a page that words them differently: `store` (doctor's to fix), `windows`, or null. */
    unavailableKind() {
      const problem = devicesDirProblem(dir, { fs, uid, platform, create: false });
      return problem && !problem.absent ? "store" : platform === "win32" ? "windows" : null;
    },

    hashOf: (secret) => hashDeviceSecret(secret),

    /**
     * A record, absent or unjudged, as the store says, with a denied device reading as ended. A folder that does not exist is no devices here, not
     * unjudged: the cookie's name is built from the tokens file's path, so a repointed tokens file presents another cookie and never meets this, and
     * removing the folder is doctor's own way to sign every browser out.
     */
    read(hash) {
      if (denied.has(hash)) return { denied: true };
      if (devicesDirProblem(dir, { fs, uid, platform })?.absent) return { absent: true };
      return readDevice({ dir, hash, fs, uid });
    },

    /** The session store's question about a live device-backed session: null while it holds, a sign-in-page word when it ended, or `{unjudged: true}`. */
    verdictOf(hash) {
      if (denied.has(hash)) return "device";
      const read = trust.read(hash);
      if (read.unjudged) return { unjudged: true };
      if (read.absent) return "device";
      if (read.record.ended) return ENDED_OF_DEVICE_REASON[read.record.ended.reason] ?? "device";
      return null;
    },

    remember(args) {
      const made = rememberDevice({ ...shared, ...args });
      if (made.hash) retryDenied();
      return made;
    },

    /**
     * End durably, or hold in memory and say so: `{ok}` or `{unerased: true, problem, held}`, `held` false only when the in-memory list is full (`denyMax`), so
     * no caller says "refused until this console stops" of a device it does not refuse. A device already gone needs nothing.
     */
    end(hash, reason) {
      const done = endDevice({ ...shared, hash, reason });
      if (done.ok || done.absent) {
        denied.delete(hash);
        retryDenied();
        return { ok: true };
      }
      // Only records this process has reason to believe real reach here: a readable one, or an unreadable one whose session it holds. Capped all the same.
      const held = denied.has(hash) || denied.size < denyMax;
      if (held) denied.set(hash, reason);
      log(`console: remembered device ${deviceIdOf(hash)} could not be ended (${done.problem}); ${held ? "it is refused until this process stops" : "this process holds too many such refusals to refuse it as well"}; once pi-dispatch doctor passes, run pi-dispatch-console device revoke --id ${deviceIdOf(hash)}`);
      return { unerased: true, problem: done.problem, held };
    },

    /** Move last-use on, at most daily: true when it moved, which is also when the cookie is re-set. */
    touch(hash, mtimeMs) {
      return touchDevice({ dir, hash, mtimeMs, fs, now });
    },

    list: () => listDevices({ dir, fs, uid }),
    reap: () => reapDevices({ dir, fs, uid, now }),
  };
  return trust;
}
