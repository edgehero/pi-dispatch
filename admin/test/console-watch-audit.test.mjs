import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { auditDriver, parseAuditQuery, readAuditView } from "../src/console/audit-view.mjs";
import { auditLog } from "../src/console/panels/audit.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const AT = Date.UTC(2026, 10, 2, 12);
const watcher = { name: "sam", role: "operator", session: "a".repeat(12) };
const driver = { name: "lee", role: "operator", session: "b".repeat(12) };

test("real watch audit retains both identities, renders the driver, and filters by either person", async () => {
  const logsDir = tempDir("pd-watch-audit-"), audit = makeConsoleAudit({ logsDir, now: () => AT });
  audit.append({ actor: watcher, driver, action: "write", kind: "sandbox-watch-start", target: "mini1/" + "c".repeat(64), outcome: "ok" });
  audit.append({ actor: watcher, driver, action: "write", kind: "sandbox-watch-end", target: "mini1/" + "c".repeat(64), outcome: "ok", reason: "driver-ended" });
  const read = (args) => readConsoleAudit({ logsDir, ...args, positions: true });
  const verify = () => verifyConsoleAudit({ logsDir, withLast: true });
  assert.equal(verify().ok, true);
  for (const raw of ["who=sam", "who=lee", "q=lee"]) {
    const query = parseAuditQuery(raw).query, data = await readAuditView({ read, verify, query });
    assert.equal(data.rows.length, 2, raw);
    const html = String(auditLog({ role: "operator", data: { audit: data }, query, now: AT }));
    assert.match(html, /sam/); assert.match(html, /driver: lee/); assert.match(html, /driver-ended/);
    assert.doesNotMatch(html, /aaaaaaaaaaaa|bbbbbbbbbbbb/);
  }
});

test("driver metadata has no meaning on an ordinary row or with malformed/extra fields", () => {
  const entry = { actor: watcher, driver, kind: "sandbox-watch-start" };
  assert.deepEqual(auditDriver(entry), driver);
  assert.equal(auditDriver({ ...entry, kind: "pause" }), null);
  for (const changed of [{ ...driver, token: "PRIVATE" }, { ...driver, role: "viewer" }, { ...driver, session: "PRIVATE" }, { ...driver, name: "<script>" }]) assert.equal(auditDriver({ ...entry, driver: changed }), null);
});
