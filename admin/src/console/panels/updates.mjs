/** The UpdatesScreen card, from the facts `updates-view.mjs` read (issue #796, `REQ-OPERATOR-CONSOLE-SCREENS` (g8)). A viewer sees versions and results; every button is an operator's. */
import { CANNOT_ADOPT_REASONS } from "@edgehero/pi-dispatch/updates";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { actForm } from "./config-ui.mjs";
import { ageText, timeHtml } from "./common.mjs";

const data = (view) => view.data?.updates ?? null;
const operator = (view) => view.role === "operator" && !view.readOnly;
const nowOf = (view) => (Number.isFinite(view.data?.now) ? view.data.now : Date.now());
/** The bump pull request, whichever version it is on. A search, because the page holds no pull request number and a stale one would open the wrong bump. */
export const BUMP_PULL_REQUESTS = "https://github.com/edgehero/pi-dispatch/pulls?q=is%3Apr+head%3Achore%2Fpi-bump";
const packageHref = (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`;

const line = (tone, glyph, body) => html`<span class="cn-state tone-${tone}">${ui.icon(glyph, { size: "sm" })}<span>${body}</span></span>`;
const what = (name, kind) => html`<span class="up-what"><b class="code">${name}</b><span>${kind}</span></span>`;
const versions = (from, to) => (to ? html`<span class="up-ver">${from}${ui.icon("chev-r", { size: "sm" })}${to}</span>` : html`<span class="up-ver">${from}</span>`);
const runLink = (jobId) => (jobId ? html`<a class="link code" href="${`/run?id=${encodeURIComponent(jobId)}`}">${jobId}</a>` : "its run");
const lineCell = (body) => ({ html: html`<div class="up-line">${body}</div>`, wide: true });
const actCell = (body) => ({ html: body === null ? null : html`<div class="up-act">${body}</div>`, wide: true });
const money = (usd) => (Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null);

/** Why a host cannot adopt, for a person who can do something about it. One sentence for each closed word; a test holds this to the word list. */
export const CANNOT_ADOPT_WORDS = Object.freeze({
	"no-overlay": "this host has no overlay",
	"overlay-read-only": "its overlay is read-only here",
	"packages-file-unusable": "its pi-packages.json cannot be read or written",
	adapter: "this is a reviewed subscription adapter, whose identity depends on its exact tree",
	"not-staged-here": "this package is not staged there",
	"version-not-found": "the registry has no such version",
	"stage-refused": "the version failed staging's checks there",
});
if (Object.keys(CANNOT_ADOPT_WORDS).sort().join() !== [...CANNOT_ADOPT_REASONS].sort().join()) throw new Error("a cannot-adopt reason has no sentence");

/** One line each for the states that say the same on every row. */
const notKnownLine = (state, view) => {
	const at = data(view)?.at;
	if (state === "not-looking") return line("idle", "minus", html`Not looking. Set <span class="code">PI_UPDATES_LOOK=1</span> on a worker host to look daily.`);
	if (state === "stale") return line("attention", "attention", html`The last look is ${Number.isFinite(at) ? ageText(nowOf(view) - at) : "too"} old, so what is newest may have moved.`);
	return line("attention", "attention", "Unknown: the look could not read this.");
};

function canaryForm(row, view) {
	const triggers = data(view).triggers;
	if (triggers.length === 0) return html`<p class="muted">No cron trigger that loads staged packages can run a canary here.</p>`;
	const hidden = [["name", row.name], ["version", row.newest]];
	const choose = triggers.length === 1
		? null
		: html`<label class="field">Run as<select class="select" name="index" data-type="int">${triggers.map((t) => html`<option value="${String(t.index)}">trigger ${t.index + 1}${t.id ? ` (${t.id})` : ""}</option>`)}</select></label>`;
	return actForm("package-canary", { hidden: triggers.length === 1 ? [...hidden, ["index", triggers[0].index, "int"]] : hidden, fields: choose, label: "Run a canary" });
}

function standingsList(row) {
	const shown = row.standings.filter((s) => !["adopted", "undone", "no-change"].includes(s.state));
	if (shown.length === 0) return null;
	const word = (s) => (s.state === "cannot-adopt" ? `cannot: ${CANNOT_ADOPT_WORDS[s.reason] ?? "no reason was recorded"}` : s.state === "overdue" ? "overdue: it has not answered in a day, and adopts when it returns" : "pending");
	return html`<ul class="up-hosts">${shown.map((s) => html`<li><span class="code">${s.host}</span>: ${word(s)}</li>`)}</ul>`;
}

function packageCells(row, view) {
	const may = operator(view);
	const done = row.standings.filter((s) => ["adopted", "undone", "no-change"].includes(s.state)).length;
	const canary = row.canary;
	const facts = row.facts?.excerpt ? html`<details class="up-excerpt"><summary>What changed, from its changelog</summary>${row.facts.excerpt}</details>` : null;
	const adopt = may && !row.adapter && row.newest ? actForm("package-adopt", { hidden: [["name", row.name], ["version", row.newest]], label: "Adopt" }) : null;
	const undoToo = (action) => (may && row.desired?.op === "adopt" ? html`${action}${undoForm(row)}` : action);
	const again = may && !row.adapter && row.newest ? canaryForm(row, view) : null;
	const openVersion = row.newest ? ui.outLink({ href: packageHref(row.name, row.newest), label: "This version" }) : null;
	switch (row.state) {
		case "current": return [versions(row.version), line("ok", "done", "The newest version."), null];
		case "newer": return [versions(row.version, row.newest), row.adapter ? html`<span class="muted">A reviewed subscription adapter. It moves with a pi-dispatch release.</span>` : html`<span class="muted">Not tried yet. A canary runs one paid job with it, for that job only. ${openVersion}</span>`, undoToo(again)];
		case "canary-completed": return [versions(row.version, row.newest), html`<p>${line("ok", "done", html`Canary completed, read the run: ${runLink(canary.jobId)}${money(canary.costUsd) ? `, ${money(canary.costUsd)}` : ""}.`)}</p>${facts}`, undoToo(adopt)];
		case "canary-failed": return [versions(row.version, row.newest), html`<p>${line("failed", "failed", canary.why === "did-not-load" ? html`Canary failed: the candidate did not load. ${runLink(canary.jobId)}` : html`Canary failed: the run did not complete. ${runLink(canary.jobId)}`)}</p>`, undoToo(again)];
		case "adopting": return [versions(row.desired.from ?? row.version, row.desired.version), html`<p>${line("attention", "attention", `Adopting ${row.desired.version}: ${done} of ${row.standings.length} hosts so far.`)}</p>${standingsList(row)}`, may ? undoForm(row) : null];
		case "adopted": return [versions(row.desired.version), html`<p>${line("ok", "done", `Adopted by ${row.desired.by} on every host.`)}</p>${row.differs ? html`<p class="muted">The adopted tree is not the tree the canary ran: a package's dependencies float, so they can differ. Read the run again if this matters.</p>` : null}`, may ? undoForm(row) : null];
		case "partial": return [versions(row.desired.from ?? row.version, row.desired.version), html`<p>${line("attention", "attention", `${row.desired.op === "undo" ? "Undoing" : "Adopting"} ${row.desired.version}: ${done} of ${row.standings.length} hosts.`)}</p>${standingsList(row)}`, may && row.desired.op === "adopt" ? undoForm(row) : null];
		case "undoing": return [versions(row.desired.version), html`<p>${line("attention", "attention", `Going back to ${row.desired.version}: ${done} of ${row.standings.length} hosts so far.`)}</p>${standingsList(row)}`, null];
		default: return [versions(row.version, row.newest), notKnownLine(row.state, view), null];
	}
}

function undoForm(row) {
	return actForm("package-undo", { hidden: [["name", row.name]], label: "Undo" });
}

const PI_CELLS = Object.freeze({
	current: () => line("ok", "done", "The newest version."),
	"checks-passing": (pi) => line("ok", "done", `pi-dispatch's checks pass on ${pi.newest}. It arrives in a pi-dispatch release.`),
	"checks-failing": (pi) => line("failed", "failed", `Checks fail. Jobs stay on ${pi.pinned} until pi-dispatch's bump is green and released.`),
	"checks-pending": () => line("attention", "attention", "pi-dispatch's checks are still running on it."),
	"checks-unknown": () => line("attention", "attention", "Whether pi-dispatch's checks hold is unknown."),
});
/** Every pi state has a sentence: the three shared ones come from `notKnownLine`. */
export const PI_STATES_DRAWN = Object.freeze([...Object.keys(PI_CELLS), "not-looking", "stale", "unknown"]);

function piCells(pi, view) {
	const open = pi.state.startsWith("checks-") ? ui.outLink({ href: BUMP_PULL_REQUESTS, label: "Open the bump pull request", btn: ["sm"] }) : null;
	return { cells: [what("pi", "in every job, pinned by pi-dispatch"), versions(pi.pinned ?? "unknown", pi.state === "current" ? null : pi.newest), lineCell(PI_CELLS[pi.state]?.(pi) ?? notKnownLine(pi.state, view)), actCell(open)] };
}

export function updatesDescription() {
	return "pi and the extensions jobs run, prepared for you. Nothing changes until you adopt it.";
}

const unreadable = () => html`<p>${line("attention", "attention", "These facts could not be read.")}</p>`;

export function updatesProblems(view) {
	const v = data(view);
	if (!v) return ui.banner({ status: "attention", title: "Update facts unavailable", body: "The console could not read this page's sources. Reload to try again." });
	const shown = [];
	if (v.state === "unknown") shown.push(ui.banner({ status: "attention", title: "The look could not be read", body: "Valkey did not answer, so what is newest is unknown here. Reload to try again." }));
	if (v.desiredUnreadable && v.state !== "unknown") shown.push(ui.banner({ status: "attention", title: "What people asked for could not be read", body: "Valkey did not answer that read, so an Adopt in progress may not show here. Reload to try again." }));
	if (v.pi.state === "checks-failing") shown.push(ui.banner({ status: "attention", title: `pi ${v.pi.newest} is out, and pi-dispatch's checks on it fail`, body: `Jobs stay on pi ${v.pi.pinned}. The bump pull request lists what broke; it ships in a pi-dispatch release once it is green.`, actions: ui.outLink({ href: BUMP_PULL_REQUESTS, label: "Open the bump pull request", btn: [] }) }));
	const stuck = v.packages.filter((p) => p.state === "partial" || p.standings.some((s) => s.state === "overdue"));
	for (const p of stuck) shown.push(ui.banner({ status: "attention", title: `${p.name} is not the same on every host`, body: "Each host's state is on its row below. A job on a host that has not adopted keeps the version it had." }));
	return html`${shown}`;
}

export function updatesJobs(view) {
	const v = data(view);
	if (!v) return ui.card({ title: "What jobs run", body: unreadable() });
	const rows = [piCells(v.pi, view)];
	for (const row of v.packages) {
		const [version, sentence, action] = packageCells(row, view);
		rows.push({ cells: [what(row.name, row.from === "host" ? "extension, staged from a pi setup" : "extension, staged"), version, lineCell(sentence), actCell(action)] });
	}
	const body = ui.tbl({ label: "What jobs run, and what is available", heads: ["What", "Version", "Checks", { label: "" }], rows, stack: true });
	const foot = html`<p class="up-foot">${ui.icon("info", { size: "sm" })}<span>${v.state === "not-looking" ? "Not looking yet." : "Checked daily once enabled."} Nothing here changes a job until someone adopts it.</span></p>`;
	return ui.card({ title: "What jobs run", sub: "pi and its extensions", body: html`${v.stagedUnreadable ? html`<p>${line("attention", "attention", "The stage manifest could not be read, so the extensions are not listed.")}</p>` : null}${body}${foot}` });
}

const HOST_CELLS = Object.freeze({
	same: () => line("ok", "done", "The version pi-dispatch is tested with."),
	newer: (h) => line("attention", "attention", `Newer than pi-dispatch is tested with (${h.tested}).`),
	older: (h) => line("attention", "attention", `Older than pi-dispatch is tested with (${h.tested}).`),
	absent: () => html`<span class="muted">No pi on this host; jobs bring their own.</span>`,
	unknown: () => line("attention", "attention", "This host's pi could not be read."),
});
export const HOST_STATES_DRAWN = Object.freeze(Object.keys(HOST_CELLS));

function hostSentence(h, view) {
	const notes = [];
	if (h.needles === "drift") notes.push("pi-dispatch's reading of this pi's files no longer holds, so its host files may not import from it.");
	if (h.extension === "drift") notes.push("This pi may not load the /dispatch extension.");
	if (h.stale) notes.push(`Its last look is ${ageText(nowOf(view) - h.at)} old.`);
	return html`<p>${HOST_CELLS[h.state]?.(h) ?? HOST_CELLS.unknown(h)}</p>${notes.map((n) => html`<p class="muted">${n}</p>`)}`;
}

export function updatesHosts(view) {
	const v = data(view);
	if (!v) return ui.card({ title: "pi on each host", body: unreadable() });
	const rows = v.hosts.map((h) => ({ cells: [what(h.name, "worker host"), h.version ? versions(h.version) : html`<span class="muted">none</span>`, lineCell(hostSentence(h, view))] }));
	const body = ui.tbl({ label: "pi on each host", heads: ["Host", "pi", { label: "" }], rows, stack: true, empty: v.state === "not-looking" ? "No host has looked yet, so nothing is known about the pi on each host." : "No host's look could be read." });
	return ui.card({ title: "pi on each host", sub: "where /dispatch and the host files run", body: html`${body}${v.moreHosts > 0 ? html`<p class="note">And ${String(v.moreHosts)} more hosts, past what this page reads.</p>` : null}<p class="up-foot">${ui.icon("info", { size: "sm" })}<span>Your own pi is yours to update, for example with <span class="code">pi update --all</span>. pi-dispatch reads its version and whether its host files still hold.</span></p>` });
}

export function updatesHow(view) {
	const v = data(view);
	if (!v) return ui.card({ title: "How it keeps up", body: unreadable() });
	const looks = v.state === "not-looking" ? "off, until PI_UPDATES_LOOK=1 is set" : v.state === "unknown" ? "unknown" : v.state === "stale" ? `late: last ${ageText(nowOf(view) - v.at)} ago` : "daily";
	const first = v.triggers[0];
	const runs = first ? `trigger ${first.index + 1}${first.id ? `, ${first.id}` : ""}${first.capUsd !== null ? `, up to its $${first.capUsd.toFixed(2)} cap` : ", up to its cap"}${v.triggers.length > 1 ? `, or ${v.triggers.length - 1} more` : ""}` : "no cron trigger can";
	return ui.card({ title: "How it keeps up", body: ui.facts([["Looks for updates", looks], ["Last look", Number.isFinite(v.at) ? timeHtml(v.at) : "never"], ["A canary runs as", runs], ["Adopting", "always a person, with a preview and Undo"]], { cols: 1 }) });
}

const RECENT_WORDS = Object.freeze({ "package-adopt": "adopted", "package-undo": "undone" });

export function updatesRecent(view) {
	const v = data(view);
	if (!v) return ui.card({ title: "Recently adopted", body: unreadable() });
	const rows = v.recent.map((r) => ui.rowPill({ icon: "done", items: [html`<span class="up-recent"><b class="code">${r.name}</b> ${r.version}, ${RECENT_WORDS[r.kind]}<small>${r.by ?? "unknown"}${r.at ? `, ${r.at.slice(0, 10)}` : ""}</small></span>`] }));
	return ui.card({ title: "Recently adopted", body: rows.length ? html`<ul class="rows">${rows}</ul>` : html`<p class="note">Nothing adopted yet, in the audit log's window.</p>` });
}
