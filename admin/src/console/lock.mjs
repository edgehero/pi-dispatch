/**
 * One console per deployment (issue #640). Two console processes would each append to the audit log from their own
 * idea of the chain head, and the second row written with a stale `prev` breaks the hash chain for good: verify would
 * then report tampering that never happened. So `serve` takes `<logsDir>/console-audit/.console.lock` first.
 *
 * Created `wx` with the pid in it: EEXIST is the lock held. A lock whose pid is no longer alive is taken over (a
 * crashed console must not need a hand-removal before the next start); one whose pid is alive is a refusal naming it.
 * The liveness probe is `process.kill(pid, 0)`: EPERM means a process of another account has that pid, which is still
 * alive, so it counts as held. A pid recycled by an unrelated process reads as held too, and the refusal says how to
 * clear it; that is the safe direction to be wrong in.
 *
 * Released on close: removed only when it still holds OUR pid, so a release after a takeover never deletes the lock
 * another console now holds.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";

/** The lock's path for a logs directory. */
export function consoleLockPath(logsDir) {
  return join(logsDir, "console-audit", ".console.lock");
}

function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Take the lock. Returns `{path, release()}` or `{refusal}`. `alive(pid)` is the liveness seam.
 */
export function acquireConsoleLock({ logsDir, fs = nodeFs, pid = process.pid, alive = defaultAlive }) {
  const path = consoleLockPath(logsDir);
  const dir = join(logsDir, "console-audit");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { refusal: `the console audit directory ${dir} cannot be created (${e?.code ?? "error"}); check PI_LOGS_DIR` };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(path, "utf8").trim() === String(pid)) fs.unlinkSync(path);
          } catch {
            // already gone: nothing to release
          }
        },
      };
    } catch (e) {
      if (e?.code !== "EEXIST") return { refusal: `the console lock ${path} cannot be created (${e?.code ?? "error"}); check PI_LOGS_DIR` };
    }
    let held = null;
    try {
      held = Number.parseInt(fs.readFileSync(path, "utf8").trim(), 10);
    } catch {
      // unreadable or vanished between the create and the read: treat as stale and retry once
    }
    if (Number.isInteger(held) && held > 0 && alive(held)) {
      return { refusal: `another console (pid ${held}) is already serving this deployment; stop it first. If no console runs, that pid belongs to something else: remove ${path}` };
    }
    try {
      fs.unlinkSync(path);
    } catch (e) {
      if (e?.code !== "ENOENT") return { refusal: `the stale console lock ${path} cannot be removed (${e?.code ?? "error"}); remove it by hand` };
    }
  }
  return { refusal: `the console lock ${path} keeps reappearing; another console is starting at the same time. Retry once it is up or gone` };
}
