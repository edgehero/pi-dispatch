/**
 * The trigger page's What its jobs get (issue #800, the TriggerEnvironment card): pills per host, then a row per kind, its control
 * from the triggers file and under it what the last run had. The words are `trigger-gets-view.mjs`'s; nothing here decides what a
 * file, a publication or a record means.
 *
 * ONE FORM, AND THE SCRIPT'S ONE HANDLER. `form[data-action]` with `data-structured="trigger-gets"`, read by `script.mjs` `bodyOf`,
 * which sends only what differs from what this page drew and `null` where a key goes away. Its controls start in a `disabled`
 * fieldset, as every action form's do, and its bar starts `hidden`, so a browser with no script reads the same values and has no
 * control that does nothing. The `data-gets-*` words on a control are the server's, so the browser only repeats them. Its fields hold no
 * `data-field-error` and it has no `data-form-error`, so a refusal goes in the slot's bar alone. REJECTED: the shared field match, which
 * reads the words of a refusal, and put another row's under this form's Flow because it said `run.flow`.
 *
 * THE DIGEST IS DRAWN ONCE. `pageDigest` is written when the page draws the form, from the read that drew its values. The trigger
 * page is not live (`PAGES.trigger.live`): no stream redraws this panel. REJECTED: reading it fresh at a redraw, which would refresh
 * the proof of what a person saw under a person who has seen nothing new, and the stale check would pass over the edit it exists to
 * catch. It covers the entry's prompt and secret references, so it reaches only an operator's form on a console that takes changes.
 */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { forgeBaseLinkOf } from "../../read-model.mjs";
import { TRIGGER_GETS_WORDS as W, triggerGetsOf } from "../../trigger-gets-view.mjs";
import { triggerSandboxHosts } from "../trigger-sandbox.mjs";
import { listed } from "../../words.mjs";
import { canAct, shownPath } from "./common.mjs";
import { fixButton, stateLine, wordsHtml } from "./loaded-parts.mjs";

const detail = (v) => v.data?.triggerDetail ?? {};
const fileTrigger = (v) => v.data?.triggerGets?.trigger ?? detail(v).trigger ?? null;

/**
 * Whether this view draws the card, so the rest of the page can say where those rows are. Not for an agent: its copy of the data has none of it, by
 * rule. Not over a file the snapshot could not read, or a newer one: "What starts it" says why, and a row read past that would claim what it cannot.
 */
export function triggerGetsDrawn(v) {
  return v.role !== "agent" && fileTrigger(v) !== null && !v.data?.snapshot?.triggers?.invalid;
}

/** The card's words for this view, from what the page read. */
function getsOf(v) {
  if (!triggerGetsDrawn(v)) return null;
  const trigger = fileTrigger(v);
  const snapshot = v.data?.snapshot ?? {};
  const budgets = Array.isArray(snapshot.hostBudgets) && snapshot.hostBudgets.length > 0;
  return { trigger, gets: triggerGetsOf({
    trigger,
    records: detail(v).history ?? [],
    historyUnread: !Array.isArray(detail(v).history),
    hostLoads: v.data?.hostLoads ?? null,
    // A host that does not bless the venue refuses the job before it spends, so it is no host these jobs run on.
    liveHosts: budgets ? triggerSandboxHosts(trigger, snapshot).filter((host) => host.blessed !== false).map((host) => host.name) : null,
    defaults: v.data?.triggerEditor?.defaults ?? {},
    editor: v.data?.triggerEditor ?? null,
    modelChoices: v.data?.modelChoices ?? [],
    overlayServers: snapshot.overlayMcp?.servers ?? [],
    fileRefused: (v.data?.triggerGets?.fileRefused ?? snapshot.triggers?.doesNotLoad) === true,
  }) };
}

const note = (parts, { icon = "info", tone = null } = {}) => html`<p class="${tone === null ? "te-note" : `te-note tone-${tone}`}">${ui.icon(icon, { size: "sm" })}<span>${wordsHtml(parts)}</span></p>`;
const sub = (text) => html`<p class="te-sub">${text}</p>`;

/** One row: what it is, then its body, then what the last run had, then any problem that run's line names. */
function sec(icon, title, hint, body, last, problem = null, action = null) {
  return html`<div class="te-sec"><p class="te-sec__k">${ui.icon(icon, { size: "sm" })}<span>${title}<small>${hint}</small></span></p><div class="te-sec__v">${body}<p class="te-last">${ui.icon("chain", { size: "sm" })}${wordsHtml(last)}</p>${problem === null ? null : html`<p class="te-last">${stateLine(problem.tone, problem.icon, html`${problem.bold ? html`<b>${problem.bold}</b> ` : null}${problem.rest}`)} ${action}</p>`}</div></div>`;
}

/** What only a person's form draws: `control` when the form is drawn, else the same fact as text. */
const readLine = (text) => html`<p class="te-read">${text}</p>`;

function textField({ id, name, label, value, hint = null, placeholder = null, list = null, word, input = "text", amount = false }) {
  return html`<div class="field"><label for="${id}">${label}</label><input id="${id}" class="input" name="${name}" type="${input}" value="${value}" maxlength="256" autocomplete="off" spellcheck="false"${placeholder === null ? null : html` placeholder="${placeholder}"`}${list === null ? null : html` list="${list}"`}${amount ? html` data-gets-amount` : null} data-gets-word="${word}">${hint === null ? null : html`<p class="field__hint">${hint}</p>`}</div>`;
}

const datalist = (id, options) => html`<datalist id="${id}">${options.map((option) => (typeof option === "string" ? html`<option value="${option}"></option>` : html`<option value="${option.value}" label="${option.label}"></option>`))}</datalist>`;

/** A chip of a list key. `inverse`: on means NOT in the file's list, as `run.excludeTools` is a list of what is removed. */
function chip(key, entry, { inverse = false } = {}) {
  return html`<label class="te-chip"><input type="checkbox"${entry.on ? html` checked` : null} data-gets-list="${key}" data-gets-value="${entry.name ?? entry.value}"${inverse ? html` data-gets-inverse` : null} data-gets-on="${entry.onWord}" data-gets-off="${entry.offWord}"><span>${entry.label ?? entry.name ?? entry.value}</span></label>`;
}
const roChip = (label, on = true) => html`<span class="${on ? "te-chip te-chip--ro" : "te-chip te-chip--ro te-chip--off"}">${label}</span>`;
const chips = (body) => html`<div class="te-chips">${body}</div>`;

/** An item of the Extensions or MCP row: a switch when `control` is given, else a locked row. */
function item({ name, subText, tag = null, control = null, lacks = false, mark = false }) {
  const inner = html`<span><b>${name}</b><small>${subText}</small></span><span class="te-tag">${mark ? html`<span class="te-pend" hidden>changed</span>` : null}${tag === null || tag === "" ? null : lacks ? html`<span class="te-tag--att">${ui.icon("attention", { size: "sm" })}<span>${tag}</span></span>` : tag}</span>`;
  return control === null ? html`<div class="te-item te-item--ro">${inner}</div>` : html`<label class="te-item" data-gets-item>${control}${inner}</label>`;
}

function modelBody(gets, form) {
  const m = gets.model;
  if (!form) return readLine(m.read);
  const deployed = (word, value) => (value ? `Blank uses the deployment’s, ${value}.` : `Blank uses the deployment’s ${word}.`);
  const add = (key, id, label, word) => html`<div class="field"><label for="${id}">${label}</label><input id="${id}" class="input" list="te-model-refs" maxlength="512" autocomplete="off" spellcheck="false" placeholder="provider/model, separated by spaces" data-gets-add="${key}" data-gets-word="${word}"></div>`;
  const listed = (key, entries, what) => entries.map((ref) => chip(key, { value: ref, on: true, onWord: `${ref} back on ${what}`, offWord: `${ref} off ${what}` }));
  return html`<div class="te-grid">
${textField({ id: "te-provider", name: "provider", label: "Provider", value: m.provider, hint: deployed("provider", m.deployment.provider), list: "te-providers", word: "provider changed" })}
${textField({ id: "te-model", name: "model", label: "Model", value: m.model, hint: deployed("model", m.deployment.model), list: "te-models", word: "model changed" })}
${textField({ id: "te-cap", name: "maxCostUsd", label: "Job cap, in dollars", value: m.cap, hint: m.capHint, word: "job cap changed", amount: true })}
</div>${datalist("te-providers", m.providers)}${datalist("te-models", m.models)}${datalist("te-model-refs", m.refs)}
<div>${sub("Allowed models")}${m.allowed.length > 0 ? chips(listed("models", m.allowed, "the allowed list")) : html`<p class="te-note">${m.allowedNone}</p>`}${add("models", "te-models-add", m.allowed.length > 0 ? "Add a model" : "Limit to a list", "allowed models changed")}</div>
<div>${sub("If it is rate limited")}${m.fallbacks.length > 0 ? chips(listed("fallbackModels", m.fallbacks, "the fallbacks")) : html`<p class="te-note">No fallback.</p>`}${add("fallbackModels", "te-fallbacks-add", "Add a fallback", "fallbacks changed")}</div>`;
}

function flowBody(gets, form) {
  const f = gets.flow;
  const skills = html`<p class="te-note">${ui.icon("info", { size: "sm" })}<span>Skills folder (<span class="code">run.skillsDir</span>): ${f.skillsDir === null ? "none" : html`<span class="code">${shownPath(f.skillsDir)}</span>`}, a folder on each host, set in the file.</span></p>`;
  const doctor = f.doctor === null ? null : html`<p class="te-note">${ui.icon("doctor", { size: "sm" })}<span><b>Doctor’s answer:</b> ${f.doctor}${f.forge ? " A forge’s repository is not on a host, so for that tier read the last run." : ""}</span></p>`;
  const lacking = f.lacking === null ? null : note([f.lacking], { icon: "attention", tone: "attention" });
  if (f.command !== null) return html`${readLine(html`<span class="code">${f.command}</span>, ${W.command}`)}${skills}`;
  const control = form
    ? html`${textField({ id: "te-flow", name: "flow", label: "Flow", value: f.flow, list: "te-flows", word: "flow changed", hint: "Pick a skill a job can find, or name one the repository holds." })}${datalist("te-flows", f.choices.map((entry) => ({ value: entry.name, label: entry.from })))}`
    : readLine(f.flow === "" ? "No flow named." : html`<span class="code">${f.flow}</span>`);
  return html`${control}${doctor}${lacking}${skills}`;
}

function extensionsBody(gets, form) {
  const e = gets.extensions;
  const packagesLine = !e.packagesOn ? W.packagesOff : form ? W.packagesOn : e.anyLeftOut ? W.packagesLoadLess : W.packagesLoad;
  const toggle = form ? html`<input type="checkbox"${e.packagesOn ? html` checked` : null} data-gets-flag="packages" data-gets-on="staged packages on" data-gets-off="staged packages off">` : null;
  return html`<div class="te-items">
${item({ name: form ? "Staged packages" : e.packagesOn ? "Staged packages: on" : "Staged packages: off", subText: packagesLine, control: toggle, mark: form })}
${e.items.map((entry) => {
    // A moot row the file names keeps its box, disabled: what it says stays in the list an edit of the rest sends (`getsLists`).
    const box = !form || (entry.moot && entry.on) ? null : html`<input type="checkbox"${entry.on ? html` checked` : null}${entry.moot ? html` disabled` : null} data-gets-list="excludeExtensions" data-gets-value="${entry.value}" data-gets-inverse data-gets-on="${entry.backOn}" data-gets-off="${entry.value} left out">`;
    return item({ name: form ? entry.name : `${entry.name}: ${entry.on && !entry.moot ? "on" : "off"}`, subText: entry.sub, control: box, mark: form && !entry.moot });
  })}
${item({ name: "The repository’s own", subText: W.repositoryExtensions })}
</div>${e.none ? html`<p class="te-note">${e.noneWord}</p>` : null}${e.more > 0 ? html`<p class="te-note">And ${e.more} more past what the hosts publish.</p>` : null}
${form && !e.packagesOn && e.items.some((entry) => entry.moot) ? html`<p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.extensionsMoot}</span></p>` : null}
<p class="te-note">${ui.icon("info", { size: "sm" })}<span>${form ? html`${W.extensionSwitch} ` : null}${W.newExtension} <a class="link" href="/config/updates">Open Updates</a></span></p>`;
}

function mcpBody(gets, form) {
  const m = gets.mcp;
  const box = (entry) => (form ? html`<input type="checkbox"${entry.on ? html` checked` : null} data-gets-list="mcp" data-gets-value="${entry.name}" data-gets-on="${entry.name} on" data-gets-off="${entry.name} off">` : null);
  if (m.none) return html`<p class="te-note">${m.noneWord}</p>`;
  const onWord = (entry) => (form ? entry.name : `${entry.name}: ${entry.on ? "on" : "off"}`);
  return html`<div class="te-items">${m.items.map((entry) => item({ name: onWord(entry), subText: entry.sub, tag: entry.tag, lacks: entry.lacks, control: box(entry), mark: form }))}</div><p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.serverRefused} <a class="link" href="/config/connections">Open Connections</a></span></p>`;
}

function toolsBody(gets, form) {
  const t = gets.tools;
  const tool = (entry) => (form ? chip("excludeTools", { ...entry, onWord: `${entry.label} on`, offWord: `${entry.label} off` }, { inverse: true }) : roChip(entry.label, entry.on));
  const extensionTool = (entry) => (form && entry.switched !== false ? chip("excludeExtensionTools", { ...entry, onWord: `${entry.label} on`, offWord: `${entry.label} off` }, { inverse: true }) : roChip(entry.label, entry.on));
  const fromExtensions = t.fromExtensions.map((group) => html`<div>${sub(`From ${group.heading}`)}${chips(group.chips.map(extensionTool))}</div>`);
  return html`<div>${sub("pi’s own")}${chips(t.own.map(tool))}</div>
<p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.toolsOn}</span></p>
${fromExtensions}${fromExtensions.length > 0 || t.otherTools.length > 0 ? html`<p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.extensionToolChip}</span></p>` : null}
${t.serverChips.length > 0 ? html`<div>${sub(`From ${t.servers.join(", ")}`)}${chips(t.serverChips.map(tool))}</div><p class="te-note tone-attention">${ui.icon("attention", { size: "sm" })}<span>${W.lastWay}</span></p>` : form ? html`<p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.serverToolsLater}</span></p>` : null}
${t.other.length > 0 || t.otherTools.length > 0 ? html`<div>${sub("Also in the file")}${chips([...t.other.map(tool), ...t.otherTools.map(extensionTool)])}</div>` : null}
${t.jobTool ? html`<div>${sub("The job’s own")}${chips(roChip("report_progress"))}</div><p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.jobTool}</span></p>` : null}`;
}

function imageBody(gets) {
  const s = gets.secrets;
  const secrets = `${s.count > 0 ? `${s.count} named on this trigger` : "none named on this trigger"}${s.profile !== null ? `; profile ${s.profile}` : ""}`;
  return html`<p class="te-read">${wordsHtml(gets.image.words)}</p><p class="te-read">Secrets: ${secrets}${s.optedOut ? "; it opts out of its project’s bundle" : "; a job also gets its project’s bundle, if it has one"}. <a class="link" href="/config/secrets">Open Secrets</a></p><p class="te-note">${ui.icon("info", { size: "sm" })}<span>${W.elsewhere}</span></p>`;
}

/**
 * A watch rule's job loads nothing a host's publication lists and reaches no server, so the card reads less: its model, its flow, one sentence for the rest, its image. REJECTED: the usual rows with a
 * branch in each, which said a switch's words of a rule with no switch ("Staged packages: on", a package "on"), and a row per host-published name no such job can load. One that only files an issue has no job at all.
 */
function watchRows(gets, trigger, fix) {
  if (trigger.mode === "issue") return note([W.watchIssue]);
  const removes = trigger.excludeTools ?? [];
  const can = html`<p class="te-read">${W.watchLoads}</p>${removes.length > 0 ? html`<p class="te-read">The file removes ${listed(removes)}.</p>` : null}`;
  return html`${sec("bolt", "Model", "what its jobs call", modelBody(gets, false), gets.last.Model)}${sec("skill", "Flow and skills", "what it is told to do", flowBody(gets, false), gets.last.Skills, gets.problems.Skills ?? null, fix(gets.problems.Skills))}${sec("flows", "What it can use", "whichever host runs it", can, gets.last.Tools)}${sec("box", "Image and secrets", "set elsewhere", imageBody(gets), gets.last.pi)}`;
}

/**
 * The card. `form` is drawn for an operator on a console that takes changes, on a row the page read whole. A watch rule's `run` takes
 * only some of these fields, so it gets `watchRows` with no form; a row the file did not give back gets no digest, so no form either.
 */
export function triggerGets(v) {
  const got = getsOf(v);
  if (got === null) return null;
  const { trigger, gets } = got;
  const digest = v.data?.triggerGets?.pageDigest;
  const form = canAct(v) && typeof digest === "string" && trigger.type !== "watch";
  const repositoryHref = gets.record === null ? null : forgeBaseLinkOf(gets.record, v.env);
  const fix = (problem) => (problem && v.role === "operator" ? problem.fixes.filter((one) => one.kind !== "trigger").map((one) => fixButton(one, { repositoryHref })) : null);
  const watch = trigger.type === "watch";
  const hosts = watch ? (trigger.mode === "issue" ? null : note(gets.quote, { icon: "chain" })) : html`<div class="te-hosts" role="list" aria-label="Where its jobs run">${gets.pills.map((pill) => html`<span role="listitem" class="${pill.tone === "ok" ? "te-host te-host--ok" : pill.tone === "attention" ? "te-host te-host--att" : "te-host"}">${ui.icon(pill.icon, { size: "sm" })}<b>${pill.name}</b> ${pill.word}</span>`)}</div>${note(gets.hostsNote, { icon: "doctor" })}${note(gets.quote, { icon: "chain" })}`;
  const rows = watch ? watchRows(gets, trigger, fix) : html`${sec("bolt", "Model", "what its jobs call", modelBody(gets, form), gets.last.Model)}${sec("skill", "Flow and skills", "what it is told to do", flowBody(gets, form), gets.last.Skills, gets.problems.Skills ?? null, fix(gets.problems.Skills))}${sec("layers", "Extensions", "code its jobs load", extensionsBody(gets, form), gets.last.Extensions, gets.problems.Extensions ?? null, fix(gets.problems.Extensions))}${sec("plug", "MCP servers", "outside systems it reaches", mcpBody(gets, form), gets.last.MCP, gets.problems.MCP ?? null, fix(gets.problems.MCP))}${sec("flows", "Tools", "what the agent may use", toolsBody(gets, form), gets.last.Tools)}${sec("box", "Image and secrets", "set elsewhere", imageBody(gets), gets.last.pi)}`;
  const say = !canAct(v) && v.role === "operator" ? note([W.readOnly]) : watch ? note([W.watch]) : canAct(v) && !form ? note([W.unreadRow], { icon: "attention", tone: "attention" }) : null;
  // The page's banner promises a link to the refusal that sent a person here, for the actions that keep one. This one does not.
  const unlinked = form && v.query?.becauseRun ? note([W.notLinked], { icon: "attention", tone: "attention" }) : null;
  const body = form
    ? html`<form class="act te-form" data-action="trigger-environment-edit" data-structured="trigger-gets" autocomplete="off"><fieldset data-config-controls disabled><input type="hidden" name="index" value="${String(trigger.index)}" data-type="int"><input type="hidden" name="pageDigest" value="${digest}">${rows}<div class="te-bar" role="status" data-gets-bar hidden><span class="te-bar__t"><b data-gets-count data-one="${W.barOne}" data-many="${W.barMany}"></b> <span data-gets-words></span><small>${W.reloadDrops}</small></span><span class="te-bar__a">${ui.btn({ type: "submit", label: "Preview the change", kind: "primary" })}<button class="btn" type="reset">Discard</button></span></div></fieldset><noscript><p class="muted">${W.noScript}</p></noscript></form>`
    : rows;
  return ui.card({ title: W.title, ...(watch || gets.fileRefused ? {} : { sub: `as a job of trigger ${trigger.index + 1} would start, from each host’s last doctor run` }), body: html`${hosts}${say}${unlinked}${body}` });
}

/** How a change applies, for whoever reads the card. */
export function triggerGetsHow(v) {
  if (getsOf(v) === null) return null;
  const line = (icon, bold, rest) => html`<li>${ui.icon(icon)}<span><b>${bold}</b> ${rest}</span></li>`;
  const noTool = line("shield", "A person, at the console.", W.noTool);
  const watch = fileTrigger(v).type === "watch";
  if (!canAct(v) || watch) return ui.card({ title: W.how, body: html`<ul class="te-list">${line("eye", "Read only here.", watch ? W.watch : v.role === "operator" ? W.readOnly : W.viewer)}${noTool}</ul>` });
  return ui.card({ title: W.how, body: html`<ul class="te-list">${line("edit", "Change it in place.", "A switch for the staged packages, each extension and each MCP server, a chip for each tool, a picker for the model and the flow.")}${line("skill", "The flow picker is not the whole list.", W.flowPicker)}${line("eye", "Nothing is written", "until you preview the change and confirm it.")}${noTool}${line("rerun", "Undo", "puts back the keys the change touched, as they were. Where this page could not write them, the preview says so.")}</ul>` });
}
