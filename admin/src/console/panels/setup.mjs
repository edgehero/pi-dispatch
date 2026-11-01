/** #774: the full first-run page. Shared panels hold roles and published facts, never a private result or credential. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { actForm, field } from "./config-ui.mjs";
import { ageText } from "./common.mjs";
import { setupState, SETUP_STATES, SETUP_PROGRESS_STATES, SETUP_PROGRESS_STAGES, SETUP_REASON_TEXT } from "../../setup-view.mjs";
import { firstRunCommandHint } from "../../doctor-view.mjs";
import { TRIGGER_RECIPES } from "../../trigger-recipes.mjs";
import { setupProviderKeys } from "./provider-keys.mjs";

export const SETUP_DESCRIPTION = "Finish supported steps here. The terminal way remains available for every step.";
export const SETUP_GITHUB_NOTICE = "GitHub App creation and forge credentials stay in the terminal. Choose a webhook URL, or --no-webhook when using the poller.";
export const SETUP_PROVIDER_NOTICE = "A configured API key or managed subscription is judged by doctor. An ordinary pi OAuth login is not unattended service authentication.";
export const SETUP_START_NOTICE = "Starting a worker admits queued jobs and future matching events. Its preview names current manual jobs, armed schedules and reserve estimates. Stop or restart can interrupt work; it cannot undo spending.";
export const SETUP_BOOTSTRAP_COMMAND = Object.freeze(["pi-dispatch", "up", "--console"]);

const parts = sentence => (sentence ?? []).map(part => typeof part === "string" ? part : part?.code ? html`<span class="code">${part.code}</span>` : part?.b ? html`<b>${part.b}</b>` : Number.isFinite(part?.age) ? ageText(part.age) : "");
const stateOf = view => setupState(view.data?.snapshot ?? null, { role: view.role, deployment: view.data?.deployment, facts: view.data?.setup, now: view.now ?? 0 });
const allowed = (view, state, action) => view.role === "operator" && !view.readOnly && state.facts.actions.includes(action);
function action(view, state, name, label) {
  return allowed(view, state, name) ? actForm(name, { label }) : null;
}
function terminal(view, step) {
  if (view.role !== "operator") return null;
  const commands = [...(step.commands ?? [])];
  if (step.id === "provider" && commands.length === 0) commands.push(["pi-dispatch", "doctor"]);
  if (step.id === "trigger") commands.push(["/dispatch"]);
  if (!commands.length) return null;
  return html`<details class="su-term"><summary>${ui.icon("terminal", { size: "sm" })}In a terminal instead</summary>${step.id === "trigger" ? html`<p class="su-small">In the operator panel, press a to add a trigger through the dialogs.</p>` : null}${commands.map(argv => html`${ui.cmd(argv)}${firstRunCommandHint(argv) ? html`<p class="su-small">${parts(firstRunCommandHint(argv))}</p>` : null}`)}</details>`;
}
function recipes(view) {
  if (view.role !== "operator" || view.readOnly) return html`<p class="su-small">An operator can add a first trigger in the trigger editor.</p>`;
  return html`<div class="su-rec">${Object.entries(TRIGGER_RECIPES).map(([id, recipe]) => html`<a class="su-r" href="${`/config/trigger-add?recipe=${id}`}">${ui.tile("idle", { icon: recipe.icon, sm: true })}<b>${recipe.title}</b><span>${recipe.description}</span></a>`)}</div><p class="su-small"><a class="link" href="/config/trigger-add">Start from scratch</a> in the trigger editor. Preview the exact added lines before saving.</p>`;
}
function serviceActions(view, state, service) {
  return html`<div class="su-act">${["install", "start", "stop", "restart"].map(verb => action(view, state, `setup-${service}-${verb}`, verb === "install" ? `Preview installing and starting the ${service}` : `Preview ${verb === "start" ? "starting" : verb === "stop" ? "stopping" : "restarting"} the ${service}`))}</div>`;
}
function stepBody(view, state, step) {
  if (step.id === "worker") return html`<p class="su-small">${SETUP_START_NOTICE}</p>${step.state === "starting" ? action(view, state, "setup-worker-stop", "Preview stopping the worker") : serviceActions(view, state, "worker")}`;
  if (step.id === "egress") return html`<p class="su-small">${state.facts.allowlistCount === null ? "The allowlist count is not published." : `${state.facts.allowlistCount} hosts in this deployment's allowlist.`} OpenShell uses gateway policy. Unsafe or shared proxy changes require the terminal.</p><div class="su-act">${action(view, state, "setup-egress-start", "Preview starting the egress proxy")}<a class="btn btn--ghost" href="/config/connections#p-egress">Review the allowlist</a></div>`;
  if (step.id === "provider") return html`<p class="su-small">${SETUP_PROVIDER_NOTICE}</p>${setupProviderKeys(view)}<a class="link" href="/config/connections#p-subscription-auth">Review subscription authentication</a>`;
  if (step.id === "trigger") return recipes(view);
  if (step.id === "forge") return html`<p class="su-small">${SETUP_GITHUB_NOTICE}</p><a class="link" href="/config/connections">Review Connections</a>${view.role === "operator" ? html`<details class="su-term"><summary>Receiver service</summary>${serviceActions(view, state, "receiver")}${ui.cmd(["pi-dispatch", "service", "install", "--receiver"])}</details>` : null}`;
  return null;
}
function stepHtml(view, state, step, index) {
  const word = SETUP_STATES[step.state];
  const progress = step.progress;
  return html`<li class="su-step">${ui.tile(word.status, { icon: step.state === "starting" ? "running" : step.state === "ready" ? "done" : step.id === "forge" ? "git" : step.id === "provider" ? "key" : "attention" })}<div class="su-step__b"><p class="su-step__t"><span class="su-n">${index + 1}</span>${step.title}${ui.chip(word.word, { status: word.status })}</p><p class="su-step__s">${parts(step.sentence)}</p>${progress ? html`<p class="su-small" role="status">${SETUP_PROGRESS_STATES[progress.state][1]}${progress.stage ? `: ${SETUP_PROGRESS_STAGES[progress.stage]}` : null}${progress.reason ? ` ${SETUP_REASON_TEXT[progress.reason]}` : null}</p>` : null}${stepBody(view, state, step)}${terminal(view, step)}</div></li>`;
}
export function setupMain(view) {
  const state = stateOf(view), starting = state.steps.filter(step => step.state === "starting").length;
  const width = (100 - 0.8 * (state.total - 1)) / state.total;
  const bar = html`<svg class="su-bar" height="10" role="img" aria-label="${state.steps.map(step => `${step.title}: ${SETUP_STATES[step.state].word}`).join(", ")}">${state.steps.map((step, i) => html`<rect class="${`su-seg tone-${SETUP_STATES[step.state].status}${["to-do", "optional"].includes(step.state) ? " su-seg--todo" : ""}`}" x="${(i * (width + 0.8)).toFixed(2)}%" y="0" width="${width.toFixed(2)}%" height="10" rx="5"/>`)}</svg>`;
  const otherProgress = state.facts.progress.filter(item => item.step === "doctor" || state.steps.some(step => step.id === item.step && step.state === "ready"));
  const operationNotes = otherProgress.length ? html`<ol class="su-prog2" aria-label="Setup operation results" aria-live="polite">${otherProgress.map(item => html`<li>${ui.icon(item.state === "starting" ? "hourglass" : item.state === "applied" ? "done" : "attention", { size: "sm" })}<span>${item.step === "doctor" ? "Doctor" : "Host operation"}: ${SETUP_PROGRESS_STATES[item.state][1]}. ${item.stage ? SETUP_PROGRESS_STAGES[item.stage] : null}${item.reason ? ` ${SETUP_REASON_TEXT[item.reason]}` : null}</span></li>`)}</ol>` : null;
  const from = state.doctor ? `from doctor on ${state.doctor.host}, ${ageText(state.doctor.ageMs)} ago` : "waiting for a published doctor result";
  return ui.card({ title: "Getting ready", sub: from, body: html`<div class="su-prog"><p><b class="su-big">${state.ready}</b> of ${state.total} ready${starting ? ` · ${starting} starting` : null}</p>${bar}<p class="muted">This page updates from published facts. Starting a process alone never makes a step Ready.</p></div>${view.role === "operator" && !view.readOnly && !state.facts.enabled ? ui.banner({ status: "attention", title: "Use the terminal on the deployment host", body: state.facts.reason, sm: true }) : null}${view.readOnly ? html`<p class="su-small">This console is read-only. Use the terminal alternatives to change the deployment.</p>` : null}<ol class="su-steps">${state.steps.map((step, index) => step.state === "ready" ? null : stepHtml(view, state, step, index))}</ol>${operationNotes}<div class="su-act">${action(view, state, "setup-doctor", "Preview running doctor")}</div>` });
}
export function setupReady(view) {
  const state = stateOf(view);
  return ui.card({ title: "Ready", sub: `${state.ready} of ${state.total}`, body: html`<ul class="su-done">${state.steps.filter(step => step.state === "ready").map(step => html`<li>${ui.tile("ok", { icon: "done", sm: true })}<b>${step.title}</b><span>${parts(step.sentence)}</span>${step.id === "worker" && view.role === "operator" && !view.readOnly && state.facts.actions.some(name => name.startsWith("setup-worker-")) ? html`<details class="su-term"><summary>Manage this service</summary>${serviceActions(view, state, step.id)}</details>` : null}</li>`)}</ul>${allowed(view, state, "setup-viewer-add") ? html`<details class="su-term"><summary class="btn">${ui.icon("plus", { size: "sm" })}Add a viewer</summary><p class="su-small">A one-use link, good for 60 seconds, grants a viewer session. The other person needs a route or their own tunnel to this console.</p><div data-setup-private="viewer">${actForm("setup-viewer-add", { label: "Preview adding a viewer", fields: field("name", "Viewer name", { required: true, max: 32 }) })}</div></details>` : null}` });
}
export function setupStart(view) {
  return ui.card({ title: "The one command", body: html`<p class="muted su-p">Use the durable installation from the Quickstart, then bootstrap the console on the deployment host.</p>${view.role === "operator" ? html`${ui.cmd(SETUP_BOOTSTRAP_COMMAND)}<p class="muted su-p su-p2">Or from pi, which opens this page for you:</p>${ui.cmd(["/dispatch", "setup"])}` : html`<p class="muted su-p">An operator runs the host bootstrap. You can watch its progress here.</p>`}<p class="su-small"><a class="link" href="/config/connections#p-provider-keys">Manage provider API keys</a>, also after setup is ready.</p><p class="su-small"><a class="link" href="/">Open the Overview</a></p>` });
}
export const SETUP_PANELS = Object.freeze([["p-setup", setupMain], ["p-setup-ready", setupReady], ["p-setup-start", setupStart]]);
