/**
 * The console's error pages (issue #737, the ErrorPage card): what a browser's own navigation is shown in place of a
 * refusal's JSON, in the Pulse markup, through the kit and the shell's `frameHtml`. `server.mjs` `sendFailure` decides
 * WHEN (a GET or HEAD outside `/api/` and `/static/` that accepts `text/html`); this module decides WHAT, from a closed
 * kind and fixed sentences, so no page can say more than its kind allows.
 *
 * WHAT A PAGE NEVER CARRIES.
 *   - The path it was asked for: a 404 names no path, so a crafted link cannot make the console's own page display a
 *     message of the link maker's choosing.
 *   - A value from the request, with two exceptions. A 421 names the Host it refused, which the person needs to see to
 *     understand the refusal. It is the hostname `guards.mjs` `hostnameOf` normalized (or none, for a Host that is not a
 *     plain name), escaped by `html` and cut to `HOST_SHOWN_MAX` characters. And the run-id 404 (`no-run`, PR 4 of issue
 *     #737) offers the runs search with the asked id in its field, the ErrorPage card's "search pill already filled
 *     with that id": the id is the person's own query there, never a sentence of the page, and it is written only when
 *     the runs page's own `q` rule accepts it (`run-filter.mjs`, at most 200 characters of an id's or a target's
 *     letters, so every id the run page takes), so the search it fills is one the runs page answers; any other id
 *     leaves the field empty. It is escaped by `html` as every value is, and appears nowhere else on the page: not in
 *     a title, a heading or a sentence.
 *   - On a 421, any navigation or session data: every link would hit the same refused name, and the request came by a
 *     name the console does not answer to, so who is signed in is none of its business. The tunnel command uses the
 *     address and port this connection reached (`req.socket.localAddress` and `localPort`, which the requester already
 *     knows) and nothing else of how the console listens; a unix socket's path is never printed.
 *   - On a 500 or a 503, navigation: neither can vouch for the session behind the request (a 503 could not read the
 *     tokens file at all).
 *   - The server's own sentence, except for a 400, where it is the refusal: the page parser's, which names a parameter
 *     and its rule and never echoes a value (`pages.mjs` `parsePageQuery`). Every other kind says its catalog sentence.
 *
 * Each page is ONE panel (`p-error`, or `p-error-421` for the host refusal, whose card is laid out apart), drawn
 * whole by the server; the script only reveals the theme button and wires the copy box, as on every page.
 */
import { isIP, isIPv4 } from "node:net";
import { parseRunFilter } from "../run-filter.mjs";
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";
// A cycle by design, as the shell's own: `pages.mjs` draws the 403 belt with `forbiddenContent`, and this module reads
// the page table and the shell's frame. Nothing here touches either while it loads, only when a page is drawn.
import { PAGES } from "./pages.mjs";
import { frameHtml } from "./shell.mjs";

/**
 * The kinds of error page, one per refusal the server answers with a page. `no-run` is the run page's own 404 (PR 4 of
 * issue #737): `pages.mjs` `renderPage` answers it for a run id that no record, no queue and no live stream knows.
 */
export const ERROR_KINDS = Object.freeze(["no-page", "bad-query", "operators-only", "host", "unavailable", "failed", "method", "no-run"]);

/** Each kind's status when the caller gives none: the status the server answers it with. */
const KIND_STATUS = Object.freeze({ "no-page": 404, "bad-query": 400, "operators-only": 403, host: 421, unavailable: 503, failed: 500, method: 405, "no-run": 404 });

/** The kinds whose page keeps the console's navigation (when a session is known); the rest draw the sign-in bar. */
const NAV_KINDS = new Set(["no-page", "bad-query", "operators-only", "method", "no-run"]);

/** The most characters of a refused Host a 421 page shows; a longer one is cut, with an ellipsis. */
export const HOST_SHOWN_MAX = 64;

/** The local port a unix socket's tunnel is told to use: the console's default port, as `serve` prints it. */
const SOCKET_TUNNEL_PORT = 4790;

/**
 * A frozen catalog entry: the page's title and the line under it, its card's heading and sentence, and the tile's
 * status and icon.
 */
const entry = (title, sub, heading, sentence, status, icon) => Object.freeze({ title, sub, heading, sentence, status, icon });

/**
 * What each kind says, fixed. `title` is the page's title bar and `sub` the line under it (the ErrorPage card's title
 * bar: "Page not found", then what the console could not do), `heading` the card's, `sentence` what happened and
 * how to get back, a command in it in backticks for the code face (`kit.mjs` `withCode`); `status` (a `STATUS_KINDS`
 * member) and `icon` (a sprite name) draw the card's tile. The bad-query sentence is a lead-in the page completes with
 * the refusal. The host sentence cannot say "127.0.0.1 only", since PI_CONSOLE_ALLOWED_HOSTS may add
 * names, and it must not list them.
 *
 * The operators-only heading names the audit log because the audit log is the one page whose `auth` is "operator"
 * (`pages.mjs` `PAGES`; `console-server.test.mjs` pins that relation): the first page with that auth that is not the
 * audit log makes this heading wrong, and must word it for whichever page refused.
 *
 * The no-run sentence says where the console looked (what `renderPage` read before it answered 404: the run history,
 * the fleet's run mirror and the queue) and why a run may still exist.
 */
export const ERROR_SENTENCES = Object.freeze({
  "no-page": entry("Page not found", "The console could not find what this address points to.", "No page at this address", "This console has no page at this address. Go to one of its screens instead.", "idle", "search"),
  "bad-query": entry("Address not understood", "The console could not read what this address asks for.", "This page could not use its address", "The page refused its address, so it read nothing", "attention", "attention"),
  "operators-only": entry("Operators only", "This page is not for a viewer's sign-in.", "The audit log is for operators", "This page is for operators only. A viewer's sign-in opens every other screen; ask an operator for what you need from it.", "idle", "shield"),
  host: entry("Not this console's name", "The request came by a name this console does not answer to.", "This console did not answer to that name", "This console answers only to the names it was started with (127.0.0.1, localhost and [::1] unless more were added).", "attention", "shield"),
  unavailable: entry("Console unavailable", "The console cannot check who is signed in right now.", "The console's tokens file cannot be used right now", "No page can be shown until it can be read again, and nobody was signed out. An operator should run `pi-dispatch doctor` on the host; then reload this page.", "failed", "config"),
  failed: entry("Something went wrong", "The console could not draw this page.", "The console failed on this request", "Its log has the reason. Reload to try again.", "failed", "failed"),
  method: entry("Not a page", "The browser opened an address that only takes the console's own requests.", "This address is not a page", "It takes requests from the console's own buttons, which send them themselves. Go to one of its screens instead.", "idle", "info"),
  "no-run": entry("Run not found", "The console could not find a run with this id.", "No run with this id", "No run with that id is in this host's history, the fleet's run mirror or the queue. It may be another host's run with the fleet's run mirror off, or one the history no longer keeps.", "idle", "search"),
});

/** The kit's tone of a catalog status (`ui.STATUS`), or a throw: the catalog is code, so an unknown status is a bug. */
function toneOf(status) {
  if (!Object.hasOwn(ui.STATUS, status)) throw new RangeError(`error-pages: unknown status ${JSON.stringify(status)}`);
  return ui.STATUS[status].tone;
}

/** The card's large tile: the catalog's icon, large, on its status's tint (the ErrorPage card's 64 px tile). */
function bigTile({ status, icon }) {
  return html`<span class="tile tone-${toneOf(status)} er-tile">${ui.icon(icon, { size: "lg" })}</span>`;
}

/** A "Go to <screen>" button for page `name`, with the screen's own icon and path (no query: a screen as it opens). */
function goTo(name, primary) {
  const p = PAGES[name];
  return ui.btn({ kind: primary ? "primary" : null, icon: p.icon, label: `Go to ${p.nav}`, href: p.path });
}

/** The ordinary error card: the tile, the status code, the heading, the sentence, then the way back. */
function errorCard({ status, said, sentence = ui.withCode(said.sentence), actions = null, extra = null }) {
  return html`<section id="p-error" data-panel><div class="card er-card">${bigTile(said)}<p class="er-code">${String(status)}</p><h2 class="er-h">${said.heading}</h2><p class="er-s">${sentence}</p>${extra}${actions === null ? null : html`<div class="er-act">${actions}</div>`}</div></section>`;
}

/**
 * The screen a 400 sends the person back to: the page that refused its query, as it opens with none, except the run
 * detail, which needs its query to be a page at all (`/run` alone is a 400 of its own), so Runs, the screen it counts
 * as in the navigation. Null for a name that is not a page.
 */
function backTo(page) {
  if (typeof page !== "string" || !Object.hasOwn(PAGES, page)) return null;
  return page === "run" ? "runs" : page;
}

/**
 * A refusal's leading parameter name, or the two of a pair ("seq and before do not go together"): one lower-case word
 * that is the sentence's subject, followed by the verb the page parser's refusals use ("must", "is", "go", "do"). The
 * parser's other refusals open with "the" or "a" ("the query is not readable", "a query carries at most 16
 * parameters"), which this never matches; `console-static-pages.test.mjs` drives the real parser's refusals through it.
 */
const LEADING_NAMES = /^([a-z][a-z0-9_]*)(?: and ([a-z][a-z0-9_]*))?(?= (?:must|is|go|do) )/;

/**
 * A refusal sentence as the end of the lead-in: kept as written, one full stop, its leading parameter name in the code
 * face (the name is what the person types in the address, as the voice sets ids and keys).
 */
function refusalTail(sentence) {
  const trimmed = String(sentence).trim();
  const text = trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
  const m = LEADING_NAMES.exec(text);
  if (m === null) return text;
  const name = (n) => html`<span class="code">${n}</span>`;
  return html`${name(m[1])}${m[2] === undefined ? null : html` and ${name(m[2])}`}${text.slice(m[0].length)}`;
}

/** The refused Host as a 421 page shows it: the normalized name, cut to `HOST_SHOWN_MAX`; null when there was none. */
function hostShown(host) {
  if (typeof host !== "string" || host === "") return null;
  const chars = Array.from(host);
  return chars.length > HOST_SHOWN_MAX ? `${chars.slice(0, HOST_SHOWN_MAX).join("")}\u2026` : host;
}

/** The connection's local port when it is one (a TCP listener's), else null (a unix socket has none). */
function portOf(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * The address a tunnel forwards to: the one this connection reached (`serve`'s own hint names its bound host the same
 * way), an IPv6 address in brackets, an IPv4 one a dual-stack socket reports as `::ffff:a.b.c.d` as itself; `localhost`
 * when none is known. Never a fixed 127.0.0.1: a console bound to [::1], to another loopback address or to a LAN
 * address does not answer there.
 */
function tunnelHost(address) {
  if (typeof address !== "string") return "localhost";
  const mapped = /^::ffff:(.+)$/i.exec(address);
  if (mapped !== null && isIPv4(mapped[1])) return mapped[1];
  const kind = isIP(address);
  return kind === 4 ? address : kind === 6 ? `[${address}]` : "localhost";
}

/**
 * The 421 card (the ErrorPage card's second panel): the tile, then the code, the heading, the host sentence, the name the
 * browser asked for, and the tunnel to open instead. For a TCP listener the command forwards the connection's own port
 * to the address the connection reached (`tunnelHost`); for a unix socket it names a placeholder for the socket (its
 * path is not shown) and the default port.
 */
function hostCard({ status, host, port, address }) {
  const said = ERROR_SENTENCES.host;
  const shown = hostShown(host);
  const local = portOf(port);
  const tunnelPort = local ?? SOCKET_TUNNEL_PORT;
  const argv = local === null ? ["ssh", "-L", `${SOCKET_TUNNEL_PORT}:<console socket>`, "<this host>"] : ["ssh", "-L", `${local}:${tunnelHost(address)}:${local}`, "<this host>"];
  const asked = shown === null ? html`a Host that is not a plain name` : html`<span class="code">${shown}</span>`;
  return html`<section id="p-error-421" data-panel><div class="card er-421">${ui.tile(said.status, { icon: said.icon })}<div class="er-421__t"><p class="er-code">${String(status)}</p><h2>${said.heading}</h2><p class="muted">${ui.withCode(said.sentence)}</p><p class="muted">Your browser asked for ${asked}, so the request was refused. From another machine, open an SSH tunnel and use http://localhost:${String(tunnelPort)}/ instead:</p>${ui.cmd(argv)}</div></div></section>`;
}

/**
 * The operators-only card, alone: what a viewer is shown for the audit log, both by the server's role refusal (inside
 * `errorPage`) and by `pages.mjs` `renderPage`'s 403 belt (inside the signed-in shell), so the two say the same.
 */
export function forbiddenContent() {
  return errorCard({ status: KIND_STATUS["operators-only"], said: ERROR_SENTENCES["operators-only"], actions: goTo("overview", true) });
}

/**
 * The run id a no-run page puts in its search field: the asked id when the runs page's `q` rule takes it as it is
 * (`parseRunFilter`, the rule the search it fills is read by), else null, an empty field. Never cut or cleaned into
 * something the rule takes: a value that does not pass is not shown at all.
 */
function searchedId(runId) {
  if (typeof runId !== "string" || runId === "") return null;
  return parseRunFilter({ q: runId }).filter?.q === runId ? runId : null;
}

/**
 * The no-run card's search (the ErrorPage card's search pill): a GET form to the runs page holding its search field,
 * `#q` as on the runs page, filled with the asked id where `searchedId` shows it. A plain form, so it works without the
 * script; Enter in the field submits it.
 */
function runSearch(runId) {
  return html`<form class="er-search" method="get" action="${PAGES.runs.path}" role="search">${ui.searchPill({ id: ui.SEARCH_ID, name: "q", value: searchedId(runId) })}</form>`;
}

/** The card for `kind` (every kind but host), with its way back. */
function cardOf(kind, { status, sentence, page, runId }) {
  const said = ERROR_SENTENCES[kind];
  switch (kind) {
    case "no-page":
      return errorCard({ status, said, actions: html`${goTo("runs", true)}${goTo("overview", false)}` });
    case "no-run":
      return errorCard({ status, said, extra: runSearch(runId), actions: html`${goTo("runs", true)}${goTo("overview", false)}` });
    case "bad-query": {
      const back = backTo(page);
      const told = typeof sentence === "string" && sentence.trim() !== "" ? html`${said.sentence}: ${refusalTail(sentence)}` : html`${said.sentence}.`;
      const actions = back === null || back === "overview" ? goTo("overview", true) : html`${goTo(back, true)}${goTo("overview", false)}`;
      return errorCard({ status, said, sentence: told, actions });
    }
    case "operators-only":
      return forbiddenContent();
    case "method":
      return errorCard({ status, said, actions: goTo("overview", true) });
    case "unavailable":
      return errorCard({ status, said, extra: ui.cmd(["pi-dispatch", "doctor"]) });
    default:
      return errorCard({ status, said });
  }
}

/**
 * The whole error page for a refusal: `{ status, html }`. `kind` is one of `ERROR_KINDS` (anything else throws: the
 * server names kinds in code). `status` is what the server answers (its kind's when not a 4xx or 5xx number);
 * `session` (`{name, role}`) and `readOnly` draw the signed-in bar for a kind that keeps the navigation; `theme` is the
 * request's theme choice. `sentence` and `page` are the 400's refusal and the page that refused it; `host`, `port` and
 * `address` the 421's refused name and the connection's local port and address; `runId` the no-run page's asked id,
 * shown only as its search field's value (see the header). Every value goes through `html`. A no-run page's navigation
 * marks Runs current, as the run page's does: it stands where the run's page would.
 */
export function errorPage({ status, kind, theme = null, session = null, readOnly = false, sentence = null, host = null, port = null, address = null, page = null, runId = null }) {
  if (typeof kind !== "string" || !ERROR_KINDS.includes(kind)) throw new RangeError(`error-pages: unknown kind ${JSON.stringify(kind)} (one of ${ERROR_KINDS.join(", ")})`);
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : KIND_STATUS[kind];
  const said = ERROR_SENTENCES[kind];
  const nav = NAV_KINDS.has(kind) && session !== null && typeof session === "object";
  const inner = kind === "host" ? hostCard({ status: code, host, port, address }) : cardOf(kind, { status: code, sentence, page, runId });
  return {
    status: code,
    html: frameHtml({ name: "error", title: said.title, sub: said.sub, theme, session: nav ? session : null, readOnly: nav ? Boolean(readOnly) : false, nav, here: kind === "no-run" ? "runs" : null }, inner),
  };
}
