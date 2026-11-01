/** The console's fixed, bounded transport to the local setup child (#774). No provider SDK enters this graph. */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETUP_LIMITS, SETUP_VERSION, validSetupRequest, validSetupResult } from "@edgehero/pi-dispatch/setup-contract";
import { resolveSetupWorkerEntry } from "@edgehero/pi-dispatch/setup-host-entry";

/** Resolve from the deployment first; a globally installed console may share its durable worker's module tree. */
export function setupWorkerEntry(deployment, { resolveFrom = () => join(deployment, "node_modules", "@edgehero", "pi-dispatch", "src", "entry.mjs"), resolveOwn = (specifier) => fileURLToPath(import.meta.resolve(specifier)), check = resolveSetupWorkerEntry } = {}) {
  for (const lookup of [resolveFrom, resolveOwn]) {
    try {
      const entry = join(dirname(lookup("@edgehero/pi-dispatch/entry")), "cli.mjs");
      const checked = check({ entry });
      if (!checked.refusal) return checked;
    } catch { /* the next installed tree may contain the worker */ }
  }
  return { refusal: "unsafe-entry" };
}

/** Private identity also detects a replaced entry between previews without publishing source hashes. */
export function checkedSetupEntry(entry, { check = resolveSetupWorkerEntry, readFile = readFileSync } = {}) {
  const trusted = check({ entry });
  if (trusted.refusal || trusted.entry !== entry) return null;
  try {
    const hash = createHash("sha256").update(readFile(entry)).update(readFile(join(dirname(entry), "..", "package.json"))).digest("hex");
    return { ...trusted, identity: hash };
  } catch { return null; }
}

/** argv/cwd/env come only from host wiring; request input never selects any of them. */
export function makeSetupBroker({ cliPath, deployment, env = process.env, execPath = process.execPath, spawn = nodeSpawn, random = randomBytes, setTimer = setTimeout, clearTimer = clearTimeout, checkEntry = checkedSetupEntry } = {}) {
  const children = new Set();
  let closed = false;
  const initialEntry = cliPath ? checkEntry(cliPath) : null;
  async function request(phase, operation, input = {}, { expected, signal } = {}) {
    const id = random(16).toString("hex");
    const wire = { version: SETUP_VERSION, id, phase, operation, ...(expected ? { expected } : {}), ...(Object.keys(input).length ? { input } : {}) };
    const result = (state, reason) => ({ version: SETUP_VERSION, id, operation, state, reason });
    if (closed || signal?.aborted) return result("refused", "unavailable");
    if (!cliPath || !deployment || !validSetupRequest(wire)) return result("refused", "invalid-request");
    const currentEntry = checkEntry(cliPath);
    if (!initialEntry || !currentEntry || JSON.stringify(initialEntry) !== JSON.stringify(currentEntry)) return result("refused", "unsafe-entry");
    const payload = JSON.stringify(wire);
    if (Buffer.byteLength(payload) > SETUP_LIMITS.inputBytes) return result("refused", "invalid-request");
    return new Promise((done) => {
      let child, timer, killTimer, settled = false, dispatched = false, terminated = false;
      let bytes = 0;
      const chunks = [];
      const uncertain = () => phase === "apply" && dispatched ? "unknown" : "refused";
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer); clearTimer(killTimer);
        signal?.removeEventListener("abort", abort);
        if (child) children.delete(child);
        chunks.length = 0;
        done(value);
      };
      const terminate = (reason) => {
        if (terminated || settled) return;
        terminated = true;
        clearTimer(timer);
        try { child?.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimer(() => {
          try { child?.kill("SIGKILL"); } catch { /* already gone */ }
          finish(result(uncertain(), reason));
        }, SETUP_LIMITS.killGraceMs);
        killTimer?.unref?.();
        // A normal close during the grace still reports why the request was interrupted.
        child?.once("close", () => finish(result(uncertain(), reason)));
      };
      const abort = () => terminate("unavailable");
      try {
        child = spawn(execPath, [cliPath, "setup-host"], { cwd: resolve(deployment), env: { ...env }, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: false });
        children.add(child);
        child.once("error", () => finish(result(uncertain(), "process-failed")));
        child.stdout.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > SETUP_LIMITS.outputBytes) { terminate("process-failed"); return; }
          chunks.push(Buffer.from(chunk));
        });
        // Even discarded stderr is bounded. It never reaches a response, error or log.
        child.stderr.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > SETUP_LIMITS.outputBytes) terminate("process-failed"); });
        child.stdin.on("error", () => terminate("process-failed"));
        child.once("close", (code) => {
          if (terminated) return;
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(result(uncertain(), "process-failed")); return; }
          if (!validSetupResult(value) || value.id !== id || value.operation !== operation || !(code === 0 || code === 2 && value.state === "refused")) finish(result(uncertain(), "process-failed"));
          else finish(value);
        });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimer(() => terminate("process-timeout"), operation === "setup-doctor" ? SETUP_LIMITS.doctorMs : SETUP_LIMITS.serviceMs);
        timer?.unref?.();
        if (signal?.aborted) { abort(); return; }
        dispatched = true;
        child.stdin.end(payload);
      } catch { finish(result(uncertain(), "process-failed")); }
    });
  }
  return {
    preview: (action, input, opts) => request("plan", action, input, opts),
    apply: (action, { expected, input = {} }, opts = {}) => request("apply", action, input, { ...opts, expected }),
    status: (action, opts) => request("status", action, {}, opts),
    close() {
      closed = true;
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        const timer = setTimer(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, SETUP_LIMITS.killGraceMs);
        timer?.unref?.();
      }
    },
  };
}
