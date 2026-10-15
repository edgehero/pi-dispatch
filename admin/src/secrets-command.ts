/**
 * `/dispatch secrets` -- declare and remove secret-resolver profiles (REQ-TRIGGER-SECRETS, issue #225).
 *
 * OPERATOR-TYPED ONLY, and structurally so. Declaring a profile means naming an absolute host path the
 * WORKER EXECUTES, which is the plainest case of "a capability the model would GAIN" that index.ts's own
 * rule describes. It reaches the operator through `registerCommand`, which pi exposes with no parameter
 * schema and dispatches only from its own user-input path, so there is no tool to withhold: there is
 * nothing for the model to call.
 *
 * WHAT THIS WRITES, and what it deliberately does not. It writes the `secretProfiles` key of the settings
 * overlay, which is the shared, durable truth between this console and the worker. It never writes
 * `triggers.json`: which VARIABLES a trigger binds stays an operator edit to the reviewed file, following
 * run.image and run.resume. So the panel makes a manager easy to ADD, and binding one to a job stays a
 * diff someone can read.
 *
 * The worker does not trust any of it. Every overlay-declared path is re-checked against
 * PI_SECRET_RESOLVER_ROOTS at resolution time, on the realpath, because PI_SETTINGS_FILE can put this
 * file anywhere (its default was the OS temp directory until issue #290). A check that lived only here
 * would be cosmetic.
 */

import { blankSettingsFile, readSettingsView, writeSettings } from "./read-model.mjs";
import { gateDialogs } from "./dialog-gate.mjs";
// The name and path rules and the confirm's exact bytes (issue #642): pi-free, so the operator console declares a
// profile under the same rules and shows the same words.
import { planSecretProfileAdd, planSecretProfileRemove, renderProfiles, secretProfileNameRefusal, secretResolverPathRefusal } from "./write-plans.mjs";
// The write lands in the console's audit chain as the panel (issue #642), appended before it.
import { panelWrite } from "./audited-write.mjs";
import { logsDirPath } from "@edgehero/pi-dispatch/config";

// `fs` is injected for the repo's usual reason: these tests must never touch a real settings file, and a
// dialog flow that writes on the way to being asserted is a test that lies about what it proved.
// `deps.logsDir` is where the write is audited (index.ts passes the deployment's), else the paths' own, else PI_LOGS_DIR as
// the worker resolves it; `deps.audit` replaces the audit writer (the tests' seam).
export async function runSecretsCommand(paths: any, rawCtx: any, notify: any, tokens: string[], deps: any = {}): Promise<void> {
  // An EXPORTED door with its own `ctx` (issue #404): reached through the command handler in production and
  // driven directly by tests, so it gates for itself rather than trusting its caller.
  const ctx = gateDialogs(rawCtx);
  const ui = ctx?.ui;
  const fsSeam = deps.fs ? { fs: deps.fs } : {};
  const auditDir = deps.logsDir ?? paths.logsDir ?? logsDirPath(process.env);
  const auditSeam = deps.audit ? { audit: deps.audit } : {};
  const view = readSettingsView({ settingsFile: paths.settingsFile, ...fsSeam });
  // Fail-soft on read, like every other display path: an operator whose overlay is broken still needs to
  // be told what is wrong rather than handed nothing. A BLANK file (whitespace or a byte-order mark only, issue #540)
  // holds no key, so it reads as a missing one, the rule `writeSettings` applies to the write itself.
  if (view.invalid && !blankSettingsFile(paths.settingsFile, deps.fs)) {
    notify?.(`settings overlay is unreadable (${view.invalid}) — fix it before declaring a profile`, "error");
    return;
  }
  const profiles: Record<string, string> = { ...(view.overlay?.secretProfiles ?? {}) };
  const action = tokens[0] ?? "list";

  if (action === "list") {
    notify?.(renderProfiles(profiles), "info");
    return;
  }

  // The capability gate the wizard uses, and for its reason: this is dialogs end to end, so a build
  // without the primitives degrades to one notice instead of half-running.
  if (typeof ui?.input !== "function" || typeof ui?.confirm !== "function") {
    notify?.("declaring a profile needs dialogs (newer pi) — no input/confirm available", "warning");
    return;
  }

  if (action === "add") {
    const nameAnswer = await ui.input("profile name — what a trigger's run.secretsProfile will say (e.g. prod)", "default");
    const name = (nameAnswer ?? "").trim();
    if (name === "") return;
    const badName = secretProfileNameRefusal(name);
    if (badName !== null) {
      notify?.(badName, "error");
      return;
    }
    const pathAnswer = await ui.input("resolver — ABSOLUTE path to the script that reads one reference", "/opt/pi/resolve.sh");
    const path = (pathAnswer ?? "").trim();
    if (path === "") return;
    // Absolute for `resolveEnvSetup`'s reason (`secretResolverPathRefusal`): a service manager's working directory is
    // not a login shell's, so a relative path is a different file on every host.
    const badPath = secretResolverPathRefusal(path);
    if (badPath !== null) {
      notify?.(badPath, "error");
      return;
    }
    // The pointer wizard's discipline: show the EXACT bytes to be written, not a summary of them. This
    // file redirects what the worker executes, so the operator approves the thing itself.
    const planned: any = planSecretProfileAdd({ name, path, profiles, settingsFile: paths.settingsFile });
    if (planned.refusal) {
      notify?.(planned.refusal, "error");
      return;
    }
    const ok = await ui.confirm(planned.plan.title, planned.plan.message);
    if (!ok) {
      notify?.("not declared", "info");
      return;
    }
    const res: any = panelWrite(auditDir, { ...auditSeam, kind: "secret-profile-add", target: paths.settingsFile }, () => writeSettings({ settingsFile: paths.settingsFile, mutate: planned.plan.mutate, ...fsSeam }));
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`declared ${name} -> ${path}. A trigger reaches it with "secretsProfile": "${name}" beside its "secrets" map, which is an edit to triggers.json.`, "info");
    return;
  }

  if (action === "remove") {
    const name = (tokens[1] ?? "").trim();
    const planned: any = planSecretProfileRemove({ name, profiles, settingsFile: paths.settingsFile });
    if (planned.refusal) {
      notify?.(planned.refusal, "warning");
      return;
    }
    const ok = await ui.confirm(planned.plan.title, planned.plan.message);
    if (!ok) {
      notify?.("not removed", "info");
      return;
    }
    const res: any = panelWrite(auditDir, { ...auditSeam, kind: "secret-profile-remove", target: paths.settingsFile }, () => writeSettings({ settingsFile: paths.settingsFile, mutate: planned.plan.mutate, ...fsSeam }));
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`removed ${name}`, "info");
    return;
  }

  notify?.("usage: /dispatch secrets <list|add|remove <name>>", "warning");
}
