/** SandboxesScreen: private operator facts and confirmed control requests, never a browser shell (#771). */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { sandboxLinks } from "../sandbox-links.mjs";
import { timeHtml, ageText } from "./common.mjs";

export const SANDBOX_WORDS = Object.freeze({
  unavailable: "Sandbox information could not be read. Reload to try again; an unread host is not an empty host.",
  empty: "No kept workspace was published. A worker publishes its retained workspaces while it is running.",
  noShells: "No live sandbox shell was registered. A shell whose terminal stopped answering disappears when its short lease expires. An expired registration is not proof the container stopped; inspect its host if the terminal ended unexpectedly.",
  browser: "A terminal in this browser needs a decision in #754. This console opens no shell and starts no container.",
  noScript: "Preparing, pinning, ending a shell and saving terminal targets require JavaScript for Preview and Confirm. Commands remain selectable and the settings form works without JavaScript.",
});
const report = (v) => v.data?.sandboxes;
const allowed = (v) => v.role === "operator";
const acts = (v) => allowed(v) && !v.readOnly;
const rows = (v) => (report(v)?.hosts ?? []).flatMap((h) => (h.rows ?? []).map((r) => ({ ...r, host: h.name, hostStale: h.stale, retentionHours: h.retentionHours })));
const card = (title, body, sub = null, end = null) => ui.card({ title, sub, body, end });
const stamp = (ms) => Number.isFinite(ms) ? timeHtml(ms) : "not published";
const rowId = (r) => r.id ?? r.jobId;
const canOpen = (r) => !String(rowId(r)).startsWith("sha256:") && r.canOpen !== false && ["local", "podman"].includes(r.v ?? r.backend);
const selected = (v) => report(v)?.selected ?? {};
const facts = (plan) => ui.facts([
  ["Image", plan.image ?? "not published"],
  ["Size", plan.size ? `${plan.size.memMiB} MiB, ${plan.size.cpuCenti / 100} CPU` : "not published"],
  ["Network", plan.egress?.armed ? "The host's job allowlist through its egress proxy" : "Open bridge, egress policy off"],
  ["Credentials", "None in the shell"],
]);
const links = (v, r, verb = "open", compact = false) => sandboxLinks({ id: rowId(r), host: r.host, verb, compact, config: v.data?.sandboxHosts });
const retention = (r, now) => html`${r.pin ? "Pinned" : "Kept"}${Number.isFinite(r.until) ? html` until ${stamp(r.until)}${r.until <= now ? " (past its window; pin before opening)" : html`, ${ageText(r.until - now)} left`}` : ": deadline not published"}`;
const pinForm = (v, r) => acts(v) && canOpen(r) ? ui.actForm({ action: "sandbox-pin", hidden: [["host", r.host], ["id", rowId(r)]], label: "Preview pin", icon: "clock" }) : null;
function state(v) {
  const s = report(v)?.request;
  if (!s) return null;
  const success = s.state === "ready";
  return ui.banner({ status: success ? "ok" : ["refused", "failed"].includes(s.state) ? "attention" : "running", title: success ? `Sandbox ${s.result?.id ?? s.id} is ready` : `Sandbox request ${s.state}`, body: html`<span class="code">${s.id}</span> on ${s.host ?? "its host"}. ${s.message ?? s.reason ?? (success ? "No container has started. Open it from your terminal." : "Reload to read the worker's result.")}`, actions: success && s.result ? links(v, { ...s.result, id: s.result.id, host: s.result.host ?? s.host }, "open", true) : ui.btn({ href: `/runs/sandboxes?${new URLSearchParams({ request: s.id, host: s.host ?? selected(v).host ?? "" })}`, label: "Refresh request" }) });
}

export function sandboxFromRun(v) {
  if (!allowed(v)) return null;
  const all = rows(v);
  const id = v.query?.id;
  const picked = all.find((r) => rowId(r) === id && (!v.query?.host || r.host === v.query.host));
  const pickerHost = v.query?.host ?? selected(v).host ?? all[0]?.host ?? "";
  const picker = html`<form method="get" action="/runs/sandboxes" data-live-hold class="sx-picker">${ui.field({ label: "Workspace host", id: "sb-workspace-host", control: ui.select({ id: "sb-workspace-host", name: "host", value: pickerHost, options: [{ value: "", label: "Choose a host" }, ...(report(v)?.hosts ?? []).map((h) => ({ value: h.name, label: h.name }))] }) })}${ui.field({ label: "Kept workspace", id: "sb-workspace", control: ui.select({ id: "sb-workspace", name: "id", value: id ?? "", options: [{ value: "", label: "Choose a workspace" }, ...all.filter((r) => !pickerHost || r.host === pickerHost).map((r) => ({ value: rowId(r), label: `${rowId(r)} on ${r.host}${r.prepared ? " (prepared)" : ""}` }))] }) })}${ui.btn({ type: "submit", label: "Show workspace" })}</form>`;
  if (!report(v)) return card("From a run", html`<p role="status">${SANDBOX_WORDS.unavailable}</p>`);
  if (!picked) return card("From a run", html`${state(v)}${v.data?.sandboxHostsProblem ? html`<p role="status">${v.data.sandboxHostsProblem}</p>` : null}${picker}<p class="card__sub">${all.length ? "Choose a kept workspace, or open Sandboxes from a run page." : SANDBOX_WORDS.empty}</p>`, "the image, workspace and isolation the run kept");
  const workspace = picked.kind === "local" ? "Its original host folder" : ["github", "gitlab", "forgejo", "azure"].includes(picked.kind) ? "Its retained clone" : "The workspace recorded in its kept manifest";
  const what = ui.facts([["Image", picked.image ?? "As recorded in its kept manifest"], ["/workspace", workspace], ["/job", "Read only, with the retained job inputs"], ["Processes", "None until you start them"], ["Credentials", "None, on purpose"], ["Network", "The host's current job egress policy"]], { cols: 3 });
  return card("From a run", html`${state(v)}${v.data?.sandboxHostsProblem ? html`<p role="status">${v.data.sandboxHostsProblem}</p>` : null}${picker}<div class="sx-run">${ui.tile("ok", { icon: "box" })}<div><p class="sx-run__t"><span class="code">${rowId(picked)}</span>${picked.project ? ui.ptag(picked.project) : null}${picked.prepared ? ui.chip("Without a run") : null}</p><p class="sx-run__s">${picked.host} ${ui.vtag(picked.v ?? picked.backend)}. ${retention(picked, v.now)}</p></div></div><h3 class="sx-h3">What opens</h3>${what}<h3 class="sx-h3">How it opens</h3>${canOpen(picked) ? html`<div class="sx-ch sx-ch--on"><div class="sx-ch__h">${ui.icon("terminal", { size: "sm" })}<b>In your terminal</b><span class="sx-rec sandbox-opener">recommended</span></div><p class="sx-ch__s">Your terminal opens with the command typed in and waits for Enter. The link holds no secret. On a phone, copy the command.</p>${links(v, picked)}</div><div class="sx-foot"><p>${ui.icon("info", { size: "sm" })}<span>The shell uses a job's isolation and network. A published host port is refused while egress is on. Pinning uses this host's configured pin window.</span></p>${pinForm(v, picked)}</div>` : html`<p>This venue has no sandbox shell. Its workspace cannot be reopened here.</p>`}`, "the same image, workspace and isolation as the run");
}

export function sandboxNew(v) {
  if (!allowed(v)) return null;
  const s = selected(v), data = report(v), options = data?.options ?? [];
  const repositories = [...new Set(options.map((o) => o.repo).filter(Boolean))];
  const triggers = options;
  const hostOptions = (data?.hosts ?? []).filter((h) => !h.unreadable && !h.stale && h.settings && (!data?.eligibleHosts || data.eligibleHosts.includes(h.name))).map((h) => ({ value: h.name, label: `${h.name}, ${h.settings.defaultBackend ?? "venue not published"}` }));
  const fields = [
    ui.field({ label: "Repository", id: "sb-repo", control: ui.input({ id: "sb-repo", name: "repo", value: s.repo ?? "", placeholder: "owner/repository", required: true, autocomplete: "off", spellcheck: false }) }),
    ui.field({ label: "As the jobs of", id: "sb-trigger", control: ui.select({ id: "sb-trigger", name: "index", value: s.index === undefined ? "" : String(s.index), options: [{ value: "", label: "Choose a trigger" }, ...triggers.map((o) => ({ value: String(o.index), label: o.label }))] }), hint: "Its image, size and egress are shown below, rather than chosen here." }),
    ui.field({ label: "Start from", id: "sb-ref", control: ui.input({ id: "sb-ref", name: "ref", value: s.ref ?? "HEAD", code: true, required: true, autocomplete: "off", spellcheck: false }), hint: "HEAD means the default branch. Enter a branch, tag, full commit SHA, or pr:42 for a pull request." }),
    ui.field({ label: "Host", id: "sb-host", control: ui.select({ id: "sb-host", name: "host", value: s.host ?? "", options: [{ value: "", label: "Choose a host" }, ...hostOptions] }), hint: "The worker checks the trigger and its own policy again before cloning." }),
    ui.field({ label: "Keep it", id: "sb-pin", control: ui.select({ id: "sb-pin", name: "pin", value: s.pin ? "1" : "0", options: [{ value: "0", label: "Host's retention window" }, { value: "1", label: "Host's pin window" }] }) }),
  ];
  const plan = data?.plan;
  const form = html`<form method="get" action="/runs/sandboxes" data-live-hold><div class="sx-form">${fields}</div><div class="sx-form-end">${ui.btn({ type: "submit", label: "Review settings" })}</div></form>`;
  const preparation = plan ? html`<h3 class="sx-h3">Given by the trigger, not chosen here</h3>${facts(plan)}<p class="sx-p">${plan.pin ? `Pinned for ${plan.pinDays} days` : `Kept for ${plan.retentionHours} hours`}, on ${plan.host}. The worker clones on that host with a credential for this repository, then drops it. No container starts, no model runs, no dollars are spent and no run slot is taken.</p>${acts(v) ? ui.actForm({ action: "sandbox-prepare", hidden: [["repo", s.repo], ["index", s.index, "int"], ["ref", s.ref], ["host", s.host], ["pin", Boolean(s.pin), "json"]], label: "Preview preparation", kind: ["primary"], icon: "plus" }) : html`<p class="card__sub">This console is read-only. Prepare from the host's terminal.</p>`}${ui.cmd(["pi-dispatch", "sandbox", "--new", s.repo, "--ref", s.ref, "--as", String(s.index), ...(s.pin ? ["--pin"] : [])])}<p class="card__sub">The CLI’s --as takes a zero-based file index: trigger row ${s.index + 1} is index ${s.index}.</p>` : html`<p class="sx-p" role="status">${data?.refusal ?? "Choose a repository, its trigger, a ref and a host, then review their settings."}</p>`;
  return card("Without a run", html`${form}${preparation}<noscript><p class="card__sub">${SANDBOX_WORDS.noScript}</p></noscript>`, "a fresh clone with a trigger's image and a job's isolation");
}

export function sandboxOpen(v) {
  if (!allowed(v)) return null;
  const data = report(v), sessions = data?.sessions ?? [];
  const incomplete = !data || data.sessionsUnavailable || data.sessionsMore > 0 || data.sessionsUnreadable > 0;
  const notices = (data?.notices ?? []).map((n) => html`<p class="sx-p" role="status">${ui.icon("attention", { size: "sm" })} ${n.host}, ${n.id}: ${{ "network-kept": "The sandbox network was kept because cleanup could not be confirmed. Inspect this host’s runtime and network before removing either.", "network-cleanup-failed": "Sandbox network cleanup failed. Inspect this host’s runtime and egress network before retrying cleanup.", "runtime-unreadable": "The runtime could not be read. An expired shell registration does not prove the container stopped. Inspect this host before reopening or cleaning it." }[n.reason] ?? "Sandbox cleanup needs inspection on this host."} <a class="link" href="${`/fleet/host?${new URLSearchParams({ name: n.host })}`}">Inspect host</a>.</p>`);
  return card("Open now", html`${notices}${data?.noticesUnavailable ? html`<p role="status">Some sandbox cleanup notices could not be read. Inspect the host if a terminal ended unexpectedly.</p>` : null}${data?.sessionsMore > 0 || data?.sessionsUnreadable > 0 ? html`<p role="status">The registered shell list is incomplete: at least ${data.sessionsMore ?? 0} more and ${data.sessionsUnreadable ?? 0} unreadable registrations.</p>` : null}${data?.sessionsUnavailable ? html`<p role="status">Open shells could not be read. Reload to try again.</p>` : sessions.length ? html`<ul class="sx-opens">${sessions.map((s) => html`<li class="sx-open"><span class="dot tone-running"></span><div class="sx-open__b"><p class="sx-open__t"><span class="code">${s.id}</span>${ui.vtag(s.venue)}</p><p class="sx-open__s">${s.host}, opened by ${s.by ?? "the terminal operator"}. Open since ${stamp(s.since)}.</p><div class="sx-open__a">${links(v, s, "attach", true)}${acts(v) ? ui.actForm({ action: "sandbox-end", hidden: [["host", s.host], ["id", s.id], ["nonce", s.nonce], ["containerId", s.containerId]], label: "Preview End", kind: ["sm", "danger"], icon: "cancel" }) : null}</div></div></li>`)}</ul>` : html`<p>${data?.sessionsMore > 0 || data?.sessionsUnreadable > 0 ? "No readable shell is in this bounded view. The incomplete registrations above prevent an exact empty count." : SANDBOX_WORDS.noShells}</p>`}<p class="sx-small">${ui.icon("info", { size: "sm" })}<span>One shell per workspace at a time. End asks the terminal that opened it to close the shell and keeps the workspace. What you type is not recorded.</span></p>`, null, ui.badge(incomplete ? "attention" : "running", `${sessions.length} ${incomplete ? "shown" : "open"}`));
}

export function sandboxKept(v) {
  if (!allowed(v)) return null;
  const data = report(v), all = rows(v);
  return card("Kept workspaces", html`${data?.more > 0 ? html`<p role="status">At least ${data.more} more hosts have inventory beyond this bounded view. Inspect the fleet before treating this list as complete.</p>` : null}${!data ? html`<p role="status">${SANDBOX_WORDS.unavailable}</p>` : html`${(data.hosts ?? []).filter((h) => h.stale || h.unreadable).map((h) => html`<p class="sx-p" role="status">${h.name}: ${h.unreadable ? "publication unreadable" : "publication stale; inspect this host before opening"}. Its list is incomplete.</p>`)}${all.length ? html`<ul class="sx-kepts">${all.map((r) => html`<li class="sx-kept${canOpen(r) ? "" : " sx-kept--no"}"><p class="sx-kept__t"><a class="code" href="${`/runs/sandboxes?${new URLSearchParams({ id: rowId(r), host: r.host })}`}">${rowId(r)}</a>${r.project ? ui.ptag(r.project) : null}${r.prepared ? ui.chip("Without a run") : null}</p><p class="sx-kept__s">${r.host} ${ui.vtag(r.v ?? r.backend)}. ${retention(r, v.now)}${!canOpen(r) ? ". This venue has no sandbox shell." : null}</p>${canOpen(r) ? html`<div class="sx-kept__actions">${links(v, r, "open", true)}${pinForm(v, r)}</div>` : null}</li>`)}</ul>` : html`<p>${SANDBOX_WORDS.empty}</p>`}${(data.hosts ?? []).filter((h) => h.more > 0).map((h) => html`<p class="sx-p">${h.name} has at least ${h.more} more retained workspaces. Inspect its full list with pi-dispatch sandbox --list.</p>`)}`}`, "what each host still keeps");
}

export function sandboxBrowser(v) {
  if (!allowed(v)) return null;
  return card("In this browser", html`<p class="sx-p">${SANDBOX_WORDS.browser}</p>${ui.outLink({ href: "https://github.com/edgehero/pi-dispatch/issues/754", label: "Read the browser terminal proposal" })}`, "proposed", ui.chip("Needs a decision", { status: "attention", icon: "attention" }));
}
export const SANDBOX_PANELS = Object.freeze([["p-sb-run", sandboxFromRun], ["p-sb-new", sandboxNew], ["p-sb-open", sandboxOpen], ["p-sb-kept", sandboxKept], ["p-sb-browser", sandboxBrowser]]);
