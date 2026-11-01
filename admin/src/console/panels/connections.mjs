/** The ConnectionsScreen card, from page-specific, already projected deployment facts (#751). */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { table } from "./config-ui.mjs";
import { ageText, timeHtml } from "./common.mjs";
import { docsHref } from "../../words.mjs";

const data = (view) => view.data?.connections ?? null;
const operator = (view) => view.role === "operator" && !view.readOnly;
const triggerLink = (i) => html`<a href="${`/config/trigger?index=${i}`}">trigger ${i + 1}</a>`;
const triggers = (rows) => rows.length ? html`${rows.map((i, n) => html`${n ? ", " : null}${triggerLink(i)}`)}` : "no trigger";
const unknown = (view) => view.role === "agent" ? html`<p>${state("not published in this agent view", "idle", "info")}</p>` : html`<p>${state("connection facts unavailable", "attention", "info")} Reload to try again.</p>`;
const card = (view, title, body, sub = null) => ui.card({ title, sub, body: data(view) ? body(data(view)) : unknown(view) });
const hostLink = (name) => html`<a href="${`/fleet/host?name=${encodeURIComponent(name)}`}">${name}</a>`;
const state = (word, tone = "idle", glyph = tone === "ok" ? "done" : tone === "failed" ? "failed" : tone === "attention" ? "attention" : "minus") => html`<span class="cn-state tone-${tone}">${ui.icon(glyph, { size: "sm" })}<span>${word}</span></span>`;
const cell = (first, second = null) => html`<span class="cn-cell"><span>${first}</span>${second === null ? null : html`<small>${second}</small>`}</span>`;
const docs = (path, label) => ui.outLink({ href: docsHref(path), label });
const detailTable = (label, heads, rows, empty) => ui.tbl({ label, heads, rows, empty, stack: true });

function polling(poll) {
  if (!poll) return state("not offered");
  if (poll.state === "off") return state("off");
  if (poll.state !== "on") return state("unknown", "attention", "info");
  return cell(html`${state("on", "ok")} · ${poll.seconds} s`, html`${poll.source === "app-installation" ? "App installation repositories" : "POLL_REPOS"}${poll.repos.length ? html` · ${poll.repos.join(", ")}` : null}`);
}

function forgeRow(f) {
  if (f.enabled === false) return { cells: [html`<b>${f.name}</b>`, state("not configured"), { html: html`<span class="muted">No activation setting${f.name === "github" ? " or active GitHub trigger" : ""} names it.</span>`, wide: true }, { html: html`<span class="muted">path <span class="code">${f.path}</span> answers 404</span>`, wide: true }, { html: null, hidePhone: true }, { html: null, hidePhone: true }] };
  const auth = f.auth.split("; ");
  const enabled = f.enabled === null ? state("configuration unknown", "attention", "info") : state(html`armed by ${f.triggers.length ? html`${f.triggers.length === 1 ? "trigger" : "triggers"} ${f.triggers.map((index, n) => html`${n ? ", " : null}<a href="${`/config/trigger?index=${index}`}" aria-label="${`Trigger ${index + 1}`}">${index + 1}</a>`)}` : "settings"}`, "ok");
  const secret = f.secret.set === null ? state("unknown", "attention", "info") : f.secret.set ? state("set", "ok") : state("not set", "attention", "failed");
  return { cells: [html`<b>${f.name}</b>`, cell(enabled, f.triggers.length || !f.activationKeys.length ? null : html`<span class="code">${f.activationKeys.join(", ")}</span>`), { html: cell(auth[0], auth.length > 1 ? auth.slice(1).join("; ") : null), wide: true }, { html: cell(html`${f.verification}, <span class="code">${f.secret.key}</span> ${secret}`, html`path <span class="code">${f.path}</span> · duplicates by <span class="code">${f.deliveryId.replace(/ GUID$/, "")}</span>`), wide: true }, { html: polling(f.polling), wide: true }, { html: f.access, wide: true }] };
}

function proxyState(host) {
  if (host.unreadable) return state("unavailable", "attention", "info");
  if (!host.proxy) return state("not published");
  if (host.proxy.level === "ok") return state("running", "ok");
  if (host.proxy.level === "fail") return state("missing", "failed");
  return state("check warning", "attention");
}

function slotPicture(used, slots) {
  if (!Number.isInteger(used) || !Number.isInteger(slots) || slots > 8) return null;
  const count = Math.min(slots, 8);
  return html`<svg class="cn-slots" viewBox="${`0 0 ${count * 12} 12`}" width="${count * 12}" height="12" aria-hidden="true">${Array.from({ length: count }, (_, i) => html`<circle class="${i < used ? "cn-slot-used" : "cn-slot-free"}" cx="${i * 12 + 6}" cy="6" r="4"/>`)}</svg>`;
}

function endpointSlots(endpoint) {
  let fleet;
  if (endpoint.counting === "fleet" && Number.isInteger(endpoint.used) && endpoint.used >= 0) {
    fleet = html`<span>Fleet leases: ${slotPicture(endpoint.used, endpoint.slots)} ${endpoint.used}${Number.isInteger(endpoint.slots) ? html` of ${endpoint.slots}` : " in use"}${endpoint.used > endpoint.slots && Number.isInteger(endpoint.slots) ? " (leases exceed the current declaration)" : ""}</span>`;
  } else if (endpoint.counting === "fleet") fleet = html`<span>Fleet leases: ${state("unknown", "attention", "info")}${Number.isInteger(endpoint.slots) ? html` · ${endpoint.slots} declared here` : null}</span>`;
  else {
    const why = endpoint.counting === "per-machine" ? "per-machine endpoint, no fleet bound" : endpoint.counting === "worker-name-absent" ? "PI_WORKER_NAME not declared in .env, no fleet bound" : endpoint.counting === "host-only" ? "no fleet bound" : "fleet counting unavailable";
    fleet = html`<span>Fleet leases: ${state(["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? "not counted" : "unknown", ["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? "idle" : "attention", ["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? "minus" : "info")} · ${Number.isInteger(endpoint.slots) ? `${endpoint.slots} declared · ` : ""}${why}</span>`;
  }
  return { html: html`<div class="cn-cell">${fleet}${Number.isInteger(endpoint.declaredSlots) ? html`<small>Declared here: ${endpoint.declaredSlots} slots.</small>` : null}${(endpoint.hostCounts ?? []).length ? html`<ul class="cn-endpoint-hosts" aria-label="${`${endpoint.id} host slot counts`}">${endpoint.hostCounts.map((h) => html`<li data-host="${h.name}">${hostLink(h.name)}: ${slotPicture(h.used, h.slots)} <b>${h.used} of ${h.slots}</b>${h.used > h.slots ? " (capacity lowered while slots are held)" : null}<small>${h.fleet ? "shared fleet bound" : "host only, no fleet bound"}${h.ageMs === null ? " · beat age unknown" : html` · beat ${ageText(h.ageMs)} ago`}</small></li>`)}</ul>` : html`<small>Host occupancy not reported.</small>`}</div>`, wide: true };
}

export function connectionsDescription() {
  return "Where jobs come from, what they may reach, and who hears about failures. Names and hosts only.";
}

export function connectionsProblems(view) {
  const v = data(view);
  if (!v && view.role === "agent") return ui.banner({ status: "idle", icon: "info", title: "Limited Connections view", body: "This agent view publishes typed subscription facts. Other deployment details are not published in this view." });
  if (!v) return ui.banner({ status: "attention", title: "Connection facts unavailable", body: "The console could not read this page's sources. Reload to try again." });
  const hit = v.problems[0];
  return html`${hit ? ui.banner({ status: "refused", title: hit.title, body: html`${hit.text} ${hit.fix}`, actions: hit.host || hit.run ? html`${hit.host ? ui.btn({ href: `/fleet/host?name=${encodeURIComponent(hit.host)}`, label: `Open ${hit.host}` }) : null}${hit.run ? ui.btn({ href: `/run?id=${encodeURIComponent(hit.run)}`, label: `Open ${hit.run}` }) : null}` : null }) : null}${v.environmentUnknown ? ui.banner({ status: "attention", title: "Deployment metadata could not be read completely", body: "Some settings are unknown. Check the deployment's .env and its permissions; no values from an unreadable declaration are shown." }) : null}${v.snapshotUnreadable ? ui.banner({ status: "attention", title: "Fleet facts unavailable", body: "The console could not read the host registry, doctor records or trigger facts. File sections remain readable." }) : null}`;
}

export function connectionsForges(view) {
  return card(view, "Forges", (v) => html`<p class="muted">Receiver port: ${v.receiver.unknown ? "unknown" : v.receiver.port}; its location is not published.</p>${detailTable("Forge connections", ["Forge", "State", "Auth", "Webhook", "Polling", "Who may fire"], v.forges.map(forgeRow), "No forge facts available.")}<p class="cn-note">${ui.icon("info", { size: "sm" })}<span>Delivery health is not published. Check the forge's delivery history for 401/404 refusals; the receiver log can help with 503 or enqueue failures.</span></p>`, "where jobs come from");
}

export function connectionsEgress(view) {
  return card(view, "Egress", (v) => html`${ui.facts([["Posture", v.egress.on === null ? state(v.egress.problem ?? "unknown", "attention", "info") : v.egress.on ? state("on: local and podman jobs reach out only through the host proxy", "ok") : state("off: jobs reach what their host reaches (PI_EGRESS=0)")]], { cols: 1 })}<p class="cn-doc">${docs("docs/egress.md", "Egress rules and OpenShell policy")}</p><h3>Allowlist <span class="code">egress-allowlist.conf</span></h3>${v.egress.allowlist === null ? html`<p>${state("allowlist unavailable", "attention", "info")}</p>` : v.egress.allowlist.length ? html`<p class="cn-hosts">${v.egress.allowlist.map((h) => html`<span class="code">${h}</span>`)}${v.egress.more ? html`<span class="muted">and ${v.egress.more} more</span>` : null}</p>` : html`<p class="muted">No host is listed.</p>`}${detailTable("Egress per host", ["Host", "Proxy", "Checked"], v.egress.hosts.map((h) => [hostLink(h.name), proxyState(h), { html: html`${h.at === null ? state("not published") : timeHtml(h.at)}${h.ageMs === null ? null : html`<br>${ageText(h.ageMs)} ago`}${h.stale ? html`<br>${state("stale", "attention")}` : null}`, wide: true }]), "No host doctor results are available.")}<p class="cn-note">${ui.icon("info", { size: "sm" })}<span>No proxy check can mean egress off, OpenShell-only or an older doctor; a check is evidence from that time.</span></p>`, "what jobs may reach");
}

export function connectionsEndpoints(view) {
  return card(view, "Model endpoints", (v) => html`<p class="muted"><span class="code">model-endpoints.json</span>; fleet leases first, then each host's own slots and last beat.</p>${v.endpoints === null ? html`<p>${state("endpoints unavailable", "attention", "info")} Correct model-endpoints.json, then render the deployment's egress rules.</p>` : html`<div class="cn-endpoint-scroll" tabindex="0" role="region" aria-label="Model endpoint slots and host occupancy">${detailTable("Model endpoint slots", ["Endpoint", "Host and port", "Key", "Slots in use"], v.endpoints.map((ep) => [{ html: ep.id, id: true }, { html: ep.host === null ? html`<span class="muted">not declared here</span>` : html`<span class="code">${ep.host}:<span class="cn-endpoint-port">${ep.port}</span></span>`, wide: true }, ep.keyless === null ? "not declared here" : ep.keyless ? "keyless" : "provider key required", endpointSlots(ep)]), "No model endpoint is declared.")}</div>`}${(v.endpoints ?? []).filter((ep) => ep.conflict || ep.mixedScope).map((ep) => ui.banner({ status: "attention", title: `${ep.id}: ${ep.conflict ? "hosts declare different slot bounds" : "hosts declare different counting scopes"}`, body: ep.conflict ? "One server, one id: hosts sharing an endpoint id must declare the same slots. Correct model-endpoints.json on those hosts." : "This id has both a shared fleet bound and host-only declarations. Check that each host uses this id for the intended server.", sm: true }))}${v.endpointStatus?.state !== "reported" ? html`<p>${state("Host occupancy unknown", "attention", "info")} The host publications could not be read.</p>` : null}${(v.endpointStatus?.hosts ?? []).filter((h) => h.state !== "reported").map((h) => html`<p>${hostLink(h.name)}: ${state(h.state === "unsupported" ? "newer occupancy format" : h.state === "unreadable" ? "host occupancy unreadable" : "host occupancy not reported", h.state === "not-reported" ? "idle" : "attention", "info")}.</p>`)}${v.endpointStatus?.partial || v.endpointsMore ? html`<p class="muted">Host occupancy is partial.${v.endpointStatus?.more ? html` ${v.endpointStatus.partial ? "At least " : ""}${v.endpointStatus.more} other hosts are not listed.` : null}${v.endpointsMore ? html` ${v.endpointStatus?.partial ? "At least " : ""}${v.endpointsMore} other endpoints are not listed.` : null}${(v.endpointStatus?.hosts ?? []).filter((h) => h.endpointsMore > 0).map((h) => html` ${hostLink(h.name)} publishes ${h.endpointsMore} other endpoints.`)}</p>` : null}${v.egress.hosts.filter((h) => h.endpoints).map((h) => ui.banner({ status: "attention", title: `${h.name} reads its own copy of the endpoints file, and it does not load`, body: html`${h.endpoints.label} ${h.endpoints.fix ? html`Fix: ${h.endpoints.fix}` : null} ${h.ageMs === null ? null : html`Checked ${ageText(h.ageMs)} ago.`}`, actions: ui.btn({ href: `/fleet/host?name=${encodeURIComponent(h.name)}`, label: `Open ${h.name}` }), sm: true }))}<p class="cn-note"><a class="link" href="#p-provider-keys">Manage provider API keys</a> separately from endpoint declarations.</p>`);
}

export function connectionsNotify(view) {
  return card(view, "Notifications", (v) => html`<ul class="cn-icon-list"><li>${ui.icon("comment")}<span><b>Forge comments:</b> on${v.notify.triggers.length ? html`; ${triggers(v.notify.triggers)} also ${v.notify.triggers.length === 1 ? "keeps" : "keep"} a status comment up to date` : "; paid failures and requests for input"}.</span></li><li>${ui.icon("bell")}<span><b>Failure hook:</b> ${v.notify.unknown ? state("configuration unknown", "attention", "info") : v.notify.hook ? html`<span class="code">PI_ON_FAILURE</span> → <span class="code">${v.notify.hook}</span>, once per paid failure.` : state("not set in the .env")} </span></li></ul><p class="cn-note">${ui.icon("info", { size: "sm" })}<span>The hook's runs are in the worker's log; hook history is not published. ${docs("docs/notifications.md", "Hook rules")}</span></p>`);
}

export function connectionsMcp(view) {
  return card(view, "MCP servers", (v) => {
    const refs = [...new Set((v.mcp?.servers ?? []).flatMap((s) => s.refs ?? []))];
    return html`${v.mcp === null || v.mcp.unreadable ? html`<p>${state("overlay MCP file unavailable", "attention", "info")}</p>` : !(v.mcp.servers ?? []).length && !(v.mcp.refused ?? []).length ? html`<p class="muted">No overlay MCP server is declared.</p>` : null}<ul class="rows cn-mcp">${(v.mcp?.servers ?? []).map((s) => ui.rowPill({ icon: "plug", items: [html`<b class="code">${s.name}</b>`, html`<span>${s.transport} · <span class="code">${s.where}</span></span>`], end: html`<span class="muted">${s.exposure}</span>${s.enabled ? state("on", "ok") : state("off")}` }))}${(v.mcp?.refused ?? []).map((name) => ui.rowPill({ icon: "failed", status: "failed", items: [html`<b class="code">${name}:</b>`, html`<span class="tinted">refused, ${(v.mcp?.problems ?? []).find((p) => p.name === name)?.problem ?? "the server declaration is not admitted by the worker"}.</span>`] }))}${ui.rowPill({ icon: "git", items: [html`<b class="code">forge</b>`, "GitHub or GitLab, as the job token; merge and approval tools withheld. Version in the job image."] })}</ul><p class="cn-note"><span>${refs.length ? html`References <span class="code">${refs.join(", ")}</span>. ` : null}Rewritten by <span class="code">pi-dispatch import-pi</span>; no form here.</span></p>`;
  });
}

export function connectionsEnvironment(view) {
  return card(view, "Deployment environment", (v) => {
    const important = new Set(["PI_MAX_COST_USD", "PI_CONCURRENCY", "PI_BACKENDS", "PI_WORKER_NAME", "VALKEY_URL"]);
    const first = v.environment.filter((e) => important.has(e.key) || e.disagrees || !/^(?:not set|unknown)/.test(e.value));
    const rest = v.environment.filter((e) => !first.includes(e));
    const rows = (entries) => entries.map((e) => html`<tr><th scope="row" class="code">${e.key}</th><td>${e.value}${e.disagrees ? html`<br>${state("this shell and the .env differ; the service reads the .env", "attention")}` : null}</td></tr>`);
    return html`${table("Deployment environment keys", ["Key", "Declaration"], rows(first), "No deployment metadata is available.")}${rest.length ? html`<details class="cn-env-rest"><summary>${rest.length} other keys, not set or unknown</summary>${table("Other deployment environment keys", ["Key", "Declaration"], rows(rest), "")}</details>` : null}<p class="muted">Read from the deployment's .env. Use the Provider API keys card for its confirmed key changes; edit other declarations on the host and restart the service. Each worker may also receive settings from its service environment.</p>`;
  });
}

export function connectionsPackages(view) {
  return card(view, "Staged pi packages", (v) => html`${v.packages === null || v.packages.unreadable ? html`<p>${state("staged-package manifest unavailable", "attention", "info")}</p>` : html`${v.packages.stagedAt ? html`<p class="muted">Staged ${v.packages.stagedAt}.</p>` : null}${(v.packages.packages ?? []).length ? html`<ul class="cn-list">${v.packages.packages.map((p) => html`<li class="code">${p}</li>`)}</ul>` : html`<p class="muted">No pi package is staged.</p>`}`}<p class="muted">They load into every job except triggers that set <span class="code">"packages": false</span> (${v.packageOptOuts ?? "unknown count"}). The manifest records when, not who.</p>${operator(view) ? ui.cmd(["pi-dispatch", "import-pi", "--with-packages"]) : html`<p class="muted">An operator can import and stage the pi packages on the host.</p>`}`);
}
