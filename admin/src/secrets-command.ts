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
 * PI_SECRET_RESOLVER_ROOTS at resolution time, on the realpath, because this file's default location is
 * the OS temp directory. A check that lived only here would be cosmetic on a multi-user host.
 */

import { readSettingsView, writeSettings } from "./read-model.mjs";

const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/** The declared table, rendered for a human on their own host: names and paths, never a reference. */
function renderProfiles(profiles: Record<string, string>): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) return "No resolver profiles are declared in the settings overlay.";
  return ["Resolver profiles (settings overlay):", ...names.map((n) => `  ${n} -> ${profiles[n]}`)].join("\n");
}

// `fs` is injected for the repo's usual reason: these tests must never touch a real settings file, and a
// dialog flow that writes on the way to being asserted is a test that lies about what it proved.
export async function runSecretsCommand(paths: any, ctx: any, notify: any, tokens: string[], deps: any = {}): Promise<void> {
  const ui = ctx?.ui;
  const fsSeam = deps.fs ? { fs: deps.fs } : {};
  const view = readSettingsView({ settingsFile: paths.settingsFile, ...fsSeam });
  // Fail-soft on read, like every other display path: an operator whose overlay is broken still needs to
  // be told what is wrong rather than handed nothing.
  if (view.invalid) {
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
    if (!PROFILE_NAME.test(name)) {
      notify?.("a profile name may use letters, digits, dot, dash and underscore only — PI_SECRET_PROFILES is a comma-separated list of name:path pairs", "error");
      return;
    }
    const pathAnswer = await ui.input("resolver — ABSOLUTE path to the script that reads one reference", "/opt/pi/resolve.sh");
    const path = (pathAnswer ?? "").trim();
    if (path === "") return;
    // Absolute for `resolveEnvSetup`'s reason, restated because an operator meets it here rather than
    // there: a service manager's working directory is not a login shell's, so a relative path is a
    // different file on every host.
    if (!(path.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\)/.test(path))) {
      notify?.("the resolver needs an ABSOLUTE path: a service manager's working directory is not your shell's", "error");
      return;
    }
    // The pointer wizard's discipline: show the EXACT bytes to be written, not a summary of them. This
    // file redirects what the worker executes, so the operator approves the thing itself.
    const replacing = profiles[name] ? `\n\nThis REPLACES the current ${name} -> ${profiles[name]}` : "";
    const ok = await ui.confirm(
      "Declare a secret resolver",
      `${paths.settingsFile} gets:\n${JSON.stringify({ secretProfiles: { ...profiles, [name]: path } }, null, 2)}${replacing}\n\nThe worker EXECUTES this script, as the account it runs as, once per reference. It must also sit inside PI_SECRET_RESOLVER_ROOTS or the worker will refuse it.`,
    );
    if (!ok) {
      notify?.("not declared", "info");
      return;
    }
    const res = writeSettings({ settingsFile: paths.settingsFile, mutate: (o: any) => ({ ...o, secretProfiles: { ...profiles, [name]: path } }), ...fsSeam });
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`declared ${name} -> ${path}. A trigger reaches it with "secretsProfile": "${name}" beside its "secrets" map, which is an edit to triggers.json.`, "info");
    return;
  }

  if (action === "remove") {
    const name = (tokens[1] ?? "").trim();
    if (!name || !(name in profiles)) {
      notify?.(`no such profile. ${renderProfiles(profiles)}`, "warning");
      return;
    }
    const ok = await ui.confirm("Remove a secret resolver", `${name} -> ${profiles[name]}\n\nEvery trigger naming it refuses PRE-SPEND after this, rather than running without its secrets.`);
    if (!ok) {
      notify?.("not removed", "info");
      return;
    }
    const next = { ...profiles };
    delete next[name];
    const res = writeSettings({ settingsFile: paths.settingsFile, mutate: (o: any) => ({ ...o, secretProfiles: next }), ...fsSeam });
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`removed ${name}`, "info");
    return;
  }

  notify?.("usage: /dispatch secrets <list|add|remove <name>>", "warning");
}
