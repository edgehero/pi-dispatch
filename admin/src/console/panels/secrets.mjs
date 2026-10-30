/** SecretsScreen panels (#751), with source facts kept separate from browser-only resolver inputs. */
import { PROFILE_SOURCE_TEXT, PROFILE_ROOTS_TEXT, profileHostsText, bundleDeclaredText, bundleEndpointsText } from "../../read-model.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { canAct, runLink, timeHtml } from "./common.mjs";
import { actForm, field } from "./config-ui.mjs";

const viewOf = (ctx) => ctx.data?.secrets ?? null;
const cell = (body) => html`<span class="secret-cell">${body}</span>`;
const code = (v) => html`<span class="code">${v}</span>`;
const state = (text, failed = false, ok = false) => html`<span class="secret-state ${failed ? "tone-failed" : ok ? "tone-ok" : "tone-idle"}">${ui.icon(failed ? "failed" : ok ? "done" : "info", { size: "sm" })}<span>${text}</span></span>`;
const unread = () => html`<p class="muted">The deployment could not be read. Reload to try again; secret declarations and their state are unknown.</p>`;
const triggerLinks = (list, more = 0) => list.length ? html`${list.map((i, n) => html`${n ? ", " : ""}<a class="link" href="${`/config/trigger?index=${i}`}">${i + 1}</a>`)}${more ? ` and ${more} more` : null}` : "none";
const remove = (kind, name, ctx, label = "Remove") => canAct(ctx) ? actForm(`secret-${kind}-remove`, { hidden: [["name", name]], label: html`${label}<span class="sr"> ${kind === "profile" ? "profile" : "bundle resolver"} ${name}</span>`, danger: true }) : null;

export function secretsHeadline(ctx) {
  const v = viewOf(ctx);
  const categories = [
    ["malformed-", "declaration that does not parse", "declarations that do not parse"],
    ["ambiguous-profile-", "profile declared twice", "profiles declared twice"],
    ["ambiguous-bundle-", "bundle resolver declared twice", "bundle resolvers declared twice"],
    ["empty-roots", "empty resolver roots list", "empty resolver roots lists"],
    ["outside-profile-", "profile outside the resolver roots", "profiles outside the resolver roots"],
    ["outside-bundle-", "bundle resolver outside the roots", "bundle resolvers outside the roots"],
    ["missing-profile-", "undeclared profile", "undeclared profiles"],
    ["missing-bundle-", "bundle without a declared resolver", "bundles without a declared resolver"],
    ["unserved-", "profile no live host serves", "profiles no live host serves"],
  ];
  const summary = categories.map(([prefix, one, many]) => { const count = (v?.problems ?? []).filter((p) => p.key.startsWith(prefix)).length; return count ? `${count} ${count === 1 ? one : many}` : null; }).filter(Boolean).join(", ");
  return html`Names and states only. ${!v?.available ? "Declarations and their state could not be read." : v.problems.length ? `${v.problems.length} ${v.problems.length === 1 ? "problem" : "problems"}: ${summary}.` : "No problem found in the facts this console can read."}`;
}

export function secretsProblems(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.banner({ status: "attention", title: "Secret declarations are unknown", body: unread(), block: true });
  const p = v.problems[0];
  if (!p) return html``;
  return ui.banner({ status: "failed", title: p.title, body: `${p.sentence} ${p.fix}`, actions: p.action ? remove(p.action.action === "secret-profile-remove" ? "profile" : "bundle", p.action.name, ctx, "Remove from the overlay") : null });
}

export function secretsProfiles(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.card({ title: "Secret profiles", body: unread() });
  const rows = v.profiles.map((p) => ({ mark: p.refused ? "failed" : null, cells: [
    { html: code(p.name), id: true },
    { html: cell(html`${state(PROFILE_SOURCE_TEXT[p.source] ?? "Source unknown", p.source === "ambiguous")}${p.refused && !["ambiguous", "undeclared"].includes(p.source) && !["outside", "empty"].includes(p.roots) ? html`<small>Every secrets job is refused while a declaration does not parse or a name is declared twice.</small>` : null}`), wide: true },
    { html: state(p.roots === null ? p.source === "undeclared" ? "no declared resolver in view" : "not bounded (an env resolver)" : PROFILE_ROOTS_TEXT[p.roots] ?? "Roots judgement unknown", ["outside", "empty"].includes(p.roots), p.roots === "inside"), wide: true },
    triggerLinks(p.triggers, p.triggersMore),
    cell(html`${p.projects.map((id, n) => html`${n ? ", " : ""}<a class="link" href="${`/config/project?id=${encodeURIComponent(id)}`}">${id}</a>`)}${p.projectsMore ? ` and ${p.projectsMore} more` : null}${p.anyRepo ? html`<small>any (a webhook trigger)</small>` : p.projects.length ? null : "none in view"}`),
    { html: cell(html`${p.last ? html`${state(p.last.outcome === "refused" ? `refused (${p.last.reason ?? "reason unknown"}${p.last.bundled ? "; profile or bundle" : ""})` : p.last.outcome === "resolved" ? "resolved" : "not reached, the run ended before a container", p.last.outcome === "refused", p.last.outcome === "resolved")}<small>${runLink(p.last.jobId, { pulse: true })} · ${timeHtml(Date.parse(p.last.at ?? ""))}</small>` : html`<span class="muted">no run in view</span>`}${p.refused ? p.cron.map((c) => html`<small class="secret-refusal">Trigger ${c.index + 1}${c.id ? ` (${c.id})` : ""}: ${c.at === null ? "next fire unknown" : html`next ${timeHtml(c.at)}`}; its run will be refused.</small>`) : null}`), wide: true },
    { html: cell(profileHostsText(p, v.profileState).replace(/^served by: /, "")), wide: true },
    { html: p.inOverlay ? remove("profile", p.name, ctx) : html`<span class="faint">${p.source === "env" ? "in the .env" : p.source === "undeclared" ? "no declaration in view" : "source unknown"}</span>`, act: true },
  ] }));
  const table = ui.tbl({ caption: "Secret profiles", heads: ["Profile", "Source", "Resolver roots", "Triggers", "Projects", "Last resolve", "Served by", { label: "Actions", l: null }], rows, stack: true, empty: "No secret profiles are declared or named by the triggers in view." });
  return ui.card({ title: "Secret profiles", sub: `${rows.length} in view · names only`, end: "Resolver paths and references stay in their source files", flush: true, body: html`${!v.settingsKnown ? html`<p class="secret-note">The settings overlay could not be read; its profile declarations are unknown.</p>` : null}${v.profileState.envSeen === false ? html`<p class="secret-note">PI_SECRET_PROFILES is not visible here; the worker's environment declarations are unknown.</p>` : null}${!v.triggersKnown ? html`<p class="secret-note">The triggers file could not be read; profile usage is unknown.</p>` : null}${table}` });
}

export function secretsBundles(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.card({ title: "Secret bundles", body: unread() });
  const resolvers = v.bundleResolvers.length ? html`<ul class="secret-resolvers">${v.bundleResolvers.map((r) => html`<li>${code(r.name)} <span class="muted">(${r.format ?? "format unknown"}, ${r.source === "env" ? "PI_SECRET_BUNDLES" : r.source === "ambiguous" ? "both sources, ambiguous" : "settings overlay"})</span>${r.roots ? html`<small>${PROFILE_ROOTS_TEXT[r.roots]}</small>` : null}${r.inOverlay ? remove("bundle", r.name, ctx) : html`<span class="faint">in the .env</span>`}</li>`)}</ul>` : html`<p class="secret-note">No bundle resolver is declared in the sources this console can read.</p>`;
  const rows = v.bundles.map((b) => ({ mark: b.refused ? "failed" : b.projectKnown === false ? "attention" : null, cells: [
    { html: code(b.id), id: true },
    cell(html`${b.project ? html`<a class="link" href="${`/config/project?id=${encodeURIComponent(b.project)}`}">${b.project}</a>` : "project unknown"}${b.projectKnown === false ? html`<small>not in projects.json</small>` : b.projectKnown === null ? html`<small>projects.json could not be read</small>` : null}`),
    { html: cell(html`${code(b.profile ?? "unknown")}${state(b.roots === "unresolved" ? "declared in the settings overlay; its real path cannot be resolved on this host, so only the worker can judge the roots" : b.roots === "unseen" ? "declared in the settings overlay; the roots are not visible here" : bundleDeclaredText(b), b.refused, !b.refused && (b.declared === "env" || b.declared === "overlay" && b.roots === "inside"))}`), wide: true },
    b.forkReviews ? "yes" : "no",
    { html: bundleEndpointsText(b) || "none", wide: true },
    triggerLinks(b.optedOut),
    { html: cell(b.last ? html`<span class="secret-names">${b.last.variables.length ? b.last.variables.map(code) : "no variables"}</span><small>${runLink(b.last.jobId, { pulse: true })} · ${timeHtml(Date.parse(b.last.at ?? ""))}</small>` : html`<span class="muted">no run in view</span>`), wide: true },
  ] }));
  return ui.card({ title: "Secret bundles", sub: `${rows.length} bound in the triggers file`, end: "Variable names only, from the newest run", flush: true, body: html`<p class="secret-note">Bundle resolvers, from both declaration sources:</p>${resolvers}${!v.triggersKnown ? html`<p class="secret-note">The triggers file could not be read; bundle bindings are unknown.</p>` : ui.tbl({ caption: "Secret bundles", heads: ["Bundle", "Project", "Resolver", "Fork reviews", "Endpoints", "Opted out", "Last received"], rows, stack: true, empty: "The triggers file binds no project secret bundle." })}<p class="secret-note">Binding a bundle to a project stays an edit of secretBundles in the triggers file.</p>` });
}

export function secretsAdd(ctx) {
  if (!canAct(ctx)) return html``;
  const v = viewOf(ctx);
  const hint = v?.roots.seen ? `${v.roots.count} ${v.roots.count === 1 ? "root" : "roots"} on this host${v.roots.empty ? "; set and empty, so overlay resolvers are refused" : ""}` : "roots are not visible on this host; only the worker can judge them";
  return ui.card({ title: "Declare a resolver", sub: "writes the settings overlay", body: actForm("secret-profile-add", { structured: "resolver", label: "Preview the profile", fields: html`${field("kind", "What to declare", { options: [{ value: "profile", label: "Profile" }, { value: "bundle", label: "Bundle resolver" }], value: "profile" })}${field("name", "Name", { required: true, max: 64 })}${field("path", "Resolver (absolute path)", { required: true, max: 4096, hint: `Must sit inside PI_SECRET_RESOLVER_ROOTS (${hint}).` })}<div data-resolver-format hidden>${field("format", "Output format", { options: ["dotenv", "json"] })}</div><p class="field__hint" data-resolver-frequency>The worker runs this script as the account it runs as, once per reference before the container starts. Only declare a resolver you trust.</p>` }) });
}

export const SECRET_HELP = Object.freeze([
  ["A trigger's profile", "run.secrets names at most 16 variables. Each reference is resolved before the container starts, through run.secretsProfile or default, once per reference."],
  ["A project's bundle", "secretBundles in the triggers file binds a project to a bundle resolver. It prints dotenv or json once per job start: at most 64 variables, 256 KiB of output and 64 KiB per value. A trigger's explicit run.secrets win on a clash; the run record names the variables received and shadowed."],
  ["When a run goes without its bundle", "A hand run, a chained run, an opted-out trigger (run.secretBundle: false), a pull request from a fork without forkReviews, or a pull request whose head could not be verified. The run's page says which."],
  ["The resolver behind both", "An executable at an absolute path, declared in PI_SECRET_PROFILES or PI_SECRET_BUNDLES in the .env, or secretProfiles or secretBundles in the settings overlay. It runs on the host as the worker's account. An overlay resolver must be inside PI_SECRET_RESOLVER_ROOTS. A name declared in both sources refuses every secrets or bundled job. The resolver's own credential never enters the job."],
  ["Where the variables sit", "On local and podman, the job can read every value. On OpenShell venues, a variable with an endpoint is a placeholder that the gateway swaps for its value only in a request to that host. A forge job also receives its forge token, each job its provider's credential when required, and whatever PI_FORWARD_ENV forwards. Connections names their sources."],
  ["Never shown here", "A reference, a secret value, or a resolver's or root's full path. Resolver previews show only each path's last folder. Names and states only."],
]);
export function secretsHelp() {
  return ui.card({ title: "What a run gets", body: html`<dl class="secret-help">${SECRET_HELP.map(([title, text]) => html`<div><dt>${title}</dt><dd>${text}</dd></div>`)}</dl><p><a class="link" href="/config/connections">Open Connections</a> for forge credentials, provider keys and network egress.</p>` });
}
