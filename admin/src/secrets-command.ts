/**
 * `/dispatch secrets` -- declare and remove secret-resolver profiles (REQ-TRIGGER-SECRETS, issue #225).
 *
 * OPERATOR-TYPED ONLY, and structurally so. Declaring a profile means naming an absolute host path the
 * WORKER EXECUTES, which is the plainest case of "a capability the model would GAIN" that index.ts's own
 * rule describes. It reaches the operator through `registerCommand`, which pi exposes with no parameter
 * schema and dispatches only from its own user-input path, so there is no tool to withhold: there is
 * nothing for the model to call. This command is not the only door, and does not claim to be (issue #712): the
 * operator console's audited `secret-profile-add` and `secret-bundle-add` forms declare the same things through the
 * same plans (write-plans.mjs), a person approving a preview. What no surface offers is a TOOL that does.
 *
 * WHAT THIS WRITES, and what it deliberately does not. It writes the `secretProfiles` key of the settings
 * overlay, which is the shared, durable truth between this console and the worker. It never writes
 * `triggers.json`: which VARIABLES a trigger binds stays an operator edit to the reviewed file, following
 * run.image and run.resume. So the panel makes a manager easy to ADD, and binding one to a job stays a
 * diff someone can read.
 *
 * BUNDLE RESOLVERS (issue #704, `--bundle`) are the same capability one step wider: a script that prints a project's
 * WHOLE environment, written to the overlay's `secretBundles` (`{ name: { path, format } }`, runtime-settings.mjs's
 * shape) by the same operator-typed door, never by a tool. `list` shows both kinds and the bundles triggers.json binds,
 * with whether this deployment declares each one's profile; it never resolves a bundle (`doctor --secrets` does).
 *
 * The worker does not trust any of it. Every overlay-declared path is re-checked against
 * PI_SECRET_RESOLVER_ROOTS at resolution time, on the realpath, because PI_SETTINGS_FILE can put this
 * file anywhere (its default was the OS temp directory until issue #290). A check that lived only here
 * would be cosmetic.
 */

import { blankSettingsFile, envBundleProfiles, envSecretProfiles, listRuns, overlayBundleProfiles, readProjects, readSettingsView, readTriggers, renderBundleProfiles, renderSecretBundles, renderSecretProfilesView, secretBundlesView, secretProfilesView, writeSettings } from "./read-model.mjs";
import { gateDialogs } from "./dialog-gate.mjs";
// The name and path rules and the confirm's exact bytes (issue #642): pi-free, so the operator console declares a
// profile under the same rules and shows the same words.
import { planSecretBundleAdd, planSecretBundleRemove, planSecretProfileAdd, planSecretProfileRemove, renderProfiles, secretBundleFormatRefusal, secretBundleNameRefusal, secretProfileNameRefusal, secretResolverPathRefusal } from "./write-plans.mjs";
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
  const bundles: Record<string, any> = overlayBundleProfiles(view);
  // `--bundle` anywhere selects the bundle resolvers; the rest of the words keep their places.
  const bundle = tokens.includes("--bundle");
  const words = tokens.filter((t) => t !== "--bundle");
  const action = words[0] ?? "list";
  const USAGE_LINE = "usage: /dispatch secrets <list|add [--bundle]|remove [--bundle] <name>>";
  // Any other flag (`--bundles`, `-b`, `--Bundle`) is refused with the usage line rather than read as a word: a near
  // miss of `--bundle` falling through to the profile `add` would declare the wrong kind of resolver (review L6).
  if (words.some((w) => w.startsWith("-"))) {
    notify?.(`unknown flag ${words.find((w) => w.startsWith("-"))}. ${USAGE_LINE}`, "warning");
    return;
  }
  // The bundles triggers.json binds (issue #704), read the display way: never a reference, never resolved.
  const triggersPath = typeof paths.triggersPath === "string" ? paths.triggersPath : null;
  const triggersView: any = triggersPath !== null ? readTriggers({ triggersPath, ...fsSeam }) : { missing: true };
  const env = deps.env ?? process.env;

  if (action === "list") {
    // A deployment with no bundle resolver and no bundle reads exactly as it did before the feature.
    const projects = typeof paths.projectsFile === "string" ? readProjects({ projectsPath: paths.projectsFile, ...fsSeam }) : null;
    const bound = renderSecretBundles(secretBundlesView({ triggers: triggersView, settings: view, env, projects }), { names: false });
    // Issue #712: the env-declared profiles beside the overlay's, as the worker merges them.
    // Issue #712: each profile's use (source, roots, triggers, projects, the last resolve off this host's newest run
    // records), under the tables that carry its path. The registry is not read here, and the view says so.
    // The deployment's logs dir only (index.ts passes it): the PI_LOGS_DIR fallback the audit takes is not read for display.
    const runsDir = deps.logsDir ?? paths.logsDir ?? null;
    const runs = typeof runsDir === "string" && runsDir !== "" ? listRuns({ logsDir: runsDir, limit: 50, ...fsSeam }) : [];
    const used = renderSecretProfilesView(secretProfilesView({ triggers: triggersView, settings: view, env, projects, runs: Array.isArray(runs) ? runs : [], hosts: null, ...fsSeam }));
    const parts = [renderProfiles(profiles, envSecretProfiles(env.PI_SECRET_PROFILES)), ...(used !== "" ? [used] : []), ...(Object.keys(bundles).length > 0 ? [renderBundleProfiles(bundles)] : []), ...(bound !== "" ? [bound] : [])];
    notify?.(parts.join("\n\n"), "info");
    return;
  }

  // The capability gate the wizard uses, and for its reason: this is dialogs end to end, so a build
  // without the primitives degrades to one notice instead of half-running.
  if (typeof ui?.input !== "function" || typeof ui?.confirm !== "function") {
    notify?.("declaring a profile needs dialogs (newer pi) — no input/confirm available", "warning");
    return;
  }

  if (action === "add" && bundle) {
    const nameAnswer = await ui.input("bundle profile name — what a triggers.json bundle's \"profile\" will say (e.g. op-shop)", "default");
    const name = (nameAnswer ?? "").trim();
    if (name === "") return;
    const badName = secretBundleNameRefusal(name);
    if (badName !== null) {
      notify?.(badName, "error");
      return;
    }
    const pathAnswer = await ui.input("resolver — ABSOLUTE path to the script that prints a whole environment for one reference", "/opt/pi/bundle.sh");
    const path = (pathAnswer ?? "").trim();
    if (path === "") return;
    const badPath = secretResolverPathRefusal(path);
    if (badPath !== null) {
      notify?.(badPath, "error");
      return;
    }
    const formatAnswer = await ui.input("format — what the script prints: dotenv (NAME=value lines) or json (one object of strings)", "dotenv");
    const format = (formatAnswer ?? "").trim();
    if (format === "") return;
    const badFormat = secretBundleFormatRefusal(format);
    if (badFormat !== null) {
      notify?.(badFormat, "error");
      return;
    }
    // The exact bytes again, and a name PI_SECRET_BUNDLES already holds refused (`planSecretBundleAdd` says why).
    const planned: any = planSecretBundleAdd({ name, path, format, bundles, envBundles: envBundleProfiles(env.PI_SECRET_BUNDLES).profiles, env, settingsFile: paths.settingsFile, ...fsSeam });
    if (planned.refusal) {
      notify?.(planned.refusal, "error");
      return;
    }
    const ok = await ui.confirm(planned.plan.title, planned.plan.message);
    if (!ok) {
      notify?.("not declared", "info");
      return;
    }
    const res: any = panelWrite(auditDir, { ...auditSeam, kind: "secret-bundle-add", target: paths.settingsFile }, () => writeSettings({ settingsFile: paths.settingsFile, mutate: planned.plan.mutate, ...fsSeam }));
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`declared bundle resolver ${name} -> ${path} (${format}). A project reaches it with a "secretBundles" entry naming "profile": "${name}" in triggers.json, which is an edit to that file.`, "info");
    return;
  }

  if (action === "remove" && bundle) {
    const name = (words[1] ?? "").trim();
    // A file that names no bundle (or does not exist) strands nothing; one that cannot be read cannot say (null).
    const readable = !triggersView?.invalid && triggersView !== null;
    const boundIds = !readable ? null : Array.isArray(triggersView?.secretBundles) ? triggersView.secretBundles.filter((b: any) => b.profile === name).map((b: any) => b.id) : [];
    const planned: any = planSecretBundleRemove({ name, bundles, bound: boundIds, envBundles: envBundleProfiles(env.PI_SECRET_BUNDLES).profiles, settingsFile: paths.settingsFile });
    if (planned.refusal) {
      notify?.(planned.refusal, "warning");
      return;
    }
    const ok = await ui.confirm(planned.plan.title, planned.plan.message);
    if (!ok) {
      notify?.("not removed", "info");
      return;
    }
    const res: any = panelWrite(auditDir, { ...auditSeam, kind: "secret-bundle-remove", target: paths.settingsFile }, () => writeSettings({ settingsFile: paths.settingsFile, mutate: planned.plan.mutate, ...fsSeam }));
    if (res.invalid) {
      notify?.(`rejected: ${res.invalid}`, "error");
      return;
    }
    notify?.(`removed bundle resolver ${name}`, "info");
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
    // Issue #712: a name PI_SECRET_PROFILES already holds, and a resolver outside PI_SECRET_RESOLVER_ROOTS, are refused
    // here, before the confirm (`planSecretProfileAdd` says why).
    const planned: any = planSecretProfileAdd({ name, path, profiles, envProfiles: envSecretProfiles(env.PI_SECRET_PROFILES).profiles, env, settingsFile: paths.settingsFile, ...fsSeam });
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
    const name = (words[1] ?? "").trim();
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

  notify?.(USAGE_LINE, "warning");
}
