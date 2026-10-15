/**
 * One audit chain for every write (issue #642, DES-OPERATOR-CONSOLE "one audit chain"): the writes the `/dispatch` TUI,
 * its commands and the pi extension's tools make land in the operator console's audit log
 * (`PI_LOGS_DIR/console-audit/`, INT-CONSOLE-AUDIT-LOG) beside the console's own, as actor role `panel`. Before this,
 * only allocation writes were audited outside the console, so the log said what a browser changed and nothing about
 * the same change made from a terminal.
 *
 * THE CONSOLE'S RULE, AUDIT THEN WRITE (`server.mjs`, `postPauseConfirm`): the `ok` row is appended BEFORE the write,
 * and a write whose row cannot be appended does not happen. Appending after was rejected there for a reason that holds
 * here too: a crash or a full disk between the write and the append leaves a change the log never saw, the one outcome
 * the log exists to rule out. The cost is the same: the `ok` row is written before the outcome is known, so a write
 * that is then refused or throws gets a compensating `failed` row with the same `ticket`, and a reader takes the LAST
 * row for a ticket as its outcome. If that second append also fails, the log keeps an `ok` row for a write that did not
 * land: the safe direction to be wrong in.
 *
 * Pi-free, like `write-plans.mjs`: the console can wrap its own calls with it, and the tests import it directly.
 */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { makeConsoleAudit } from "@edgehero/pi-dispatch/console-audit";

/** What a write refused for want of an audit row says: nothing changed, and where to look. */
export const AUDIT_REFUSAL = "the audit log could not be written, so nothing was changed; check PI_LOGS_DIR";

/**
 * The panel's actor: this account's login name, role `panel`, no session (a terminal has no console session). The
 * name is reduced to a plain charset and capped, so a strange passwd entry cannot carry text into the row (the writer
 * escapes controls anyway; this keeps the name readable as a name). An account with no passwd entry is `unknown`.
 */
export function panelActor(userInfoFn = userInfo) {
  let name = "";
  try {
    name = String(userInfoFn()?.username ?? "");
  } catch {
    name = "";
  }
  const scrubbed = name.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64);
  return { name: scrubbed === "" ? "unknown" : scrubbed, role: "panel", session: null };
}

/** A fresh correlation id for one write's rows: 12 hex, the console ticket digest's length. */
export function writeTicket(randomFn = randomBytes) {
  return randomFn(6).toString("hex");
}

/**
 * The default judge of a write's result: the refusal it carries, or null when it landed. The read-model funnels say
 * no with `{ invalid }`, the kill switch and the enqueue with `{ refused }`, the allocation writers with an
 * `outcome` other than applied or reverted; a result with `ok: false` and none of those is failed too.
 */
export function defaultFailure(result) {
  if (result === null || typeof result !== "object") return null;
  if (typeof result.invalid === "string" && result.invalid !== "") return result.invalid;
  if (typeof result.refused === "string" && result.refused !== "") return result.refused;
  if (result.ok === false) return "the write was refused";
  return null;
}

/**
 * Run `fn`, the write, between audit rows. `audit` is a console audit writer (`makeConsoleAudit`), `actor` the row's
 * actor (`panelActor()`), `kind` the action name (`[a-z0-9-]{1,40}`), `target` what it writes (a file path, a job id,
 * a queue), `beforeDigest`/`afterDigest` optional. `failure(result)` overrides `defaultFailure` for a funnel that says
 * no some other way, and `refusal(sentence)` shapes what is returned when the first append fails, so each caller keeps
 * reading the shape its funnel already returns (default `{ ok: false, invalid, refused }`, both keys the sentence).
 *
 *   1. Append `{ actor, action: "write", kind, target, outcome: "ok", digests, ticket }`. If it throws, `fn` is NEVER
 *      called and the refusal is returned (`AUDIT_REFUSAL`).
 *   2. Call `fn`. Sync stays sync: a promise from `fn` makes this return a promise, a plain value returns a plain value,
 *      so a synchronous funnel's caller needs no rewrite.
 *   3. When `fn` throws (or rejects), or `failure(result)` names a reason, append the compensating `{ outcome:
 *      "failed", reason }` row with the same ticket, then return the result or rethrow, unchanged. A compensating
 *      append that fails is reported to `log` and swallowed: the write's own outcome is what the caller must see.
 */
export function auditedWrite({ audit, actor, kind, target, beforeDigest = null, afterDigest = null, reserve = null, count = null, failure = defaultFailure, refusal = (s) => ({ ok: false, invalid: s, refused: s }), log = () => {}, ticket = writeTicket() }, fn) {
  const row = { actor, action: "write", kind, target: target === null || target === undefined ? null : String(target), beforeDigest, afterDigest, reserve, count, ticket };
  try {
    audit.append({ ...row, outcome: "ok" });
  } catch (e) {
    log(`panel: audit append failed (${e?.code ?? "error"}), so the ${kind} write was refused`);
    return refusal(AUDIT_REFUSAL);
  }
  const compensate = (reason) => {
    try {
      audit.append({ ...row, outcome: "failed", reason: String(reason) });
    } catch (e) {
      log(`panel: audit append failed (${e?.code ?? "error"}) after a ${kind} write did not land; the log's last row for ticket ${ticket} says ok and is wrong`);
    }
  };
  const judge = (result) => {
    const why = failure(result);
    if (why !== null && why !== undefined) compensate(why);
    return result;
  };
  const threw = (e) => {
    compensate(`the write threw (${typeof e?.code === "string" ? e.code : "error"})`);
    throw e;
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    threw(e);
  }
  if (result !== null && typeof result === "object" && typeof result.then === "function") return result.then(judge, threw);
  return judge(result);
}

// One writer per logs directory for this process: a session builds it once (`makeConsoleAudit` keeps no state between
// appends, it re-reads the head under its lock, so sharing one is only economy). Keyed by the directory because the
// tests move PI_LOGS_DIR between cases, and a writer built for the first would aim every later row at it.
const writers = new Map();

/** The audit writer for `logsDir`, built once per directory and process. */
export function panelAudit(logsDir) {
  const dir = String(logsDir);
  let w = writers.get(dir);
  if (w === undefined) {
    w = makeConsoleAudit({ logsDir: dir });
    writers.set(dir, w);
  }
  return w;
}

/**
 * `auditedWrite` bound to the panel: the actor is `panelActor()` and the writer `panelAudit(logsDir)`, so a call site
 * names only what it writes. `opts` is `auditedWrite`'s minus `audit` and `actor` (an `audit` in it wins, the tests'
 * seam).
 */
export function panelWrite(logsDir, opts, fn) {
  return auditedWrite({ ...opts, audit: opts.audit ?? panelAudit(logsDir), actor: opts.actor ?? panelActor() }, fn);
}
