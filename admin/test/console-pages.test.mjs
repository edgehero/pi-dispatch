import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { confirmSlotHtml, heldNoteHtml } from "../src/console/confirm-view.mjs";
import { SHELL_PANEL_IDS } from "../src/console/shell.mjs";
import { RUN_PLACES, RUN_RECORD_UNREAD } from "../src/read-model.mjs";
import { runUntoldText } from "../src/console/panels/run.mjs";
import { ESC, FIXTURES, ROLES, SHOTS, STATIC_SHOTS, assertClean, assertPanelsMatch, renderAll, skip } from "./helpers/console-pages-harness.mjs";

/**
 * The console's screens rendered over the canned deployment (issue #641), in `render-images.test.mjs`'s style: the
 * fixture (`launch/fixture-deployment.mjs`) is written and seeded through the project's own writers, the page data is
 * read through the REAL `createFleetReader`, `readConsoleAudit` and `assembleInsights`, and every screen is rendered for
 * both roles at the fixture's frozen instant. Each page must be byte-identical to its committed fixture in
 * `admin/test/fixtures/console/<page>.<role>.html` and to a second render, carry no control byte, no path of this
 * machine and no email address, and keep the role rule. A second variant seeds hostile values (a job id and targets
 * holding `<script>`, quotes and control bytes, a `javascript:` repository, a failure reason) and checks each is
 * escaped or refused, and that a viewer's page carries no failure reason.
 *
 *   UPDATE_CONSOLE_FIXTURES=1 node --test test/console-pages.test.mjs    rewrite the fixtures from this render
 *
 * (then read the diff: the fixtures ARE the pages, so a change there is a change an operator will see).
 *
 * Since issue #737 the seeding, the child render and the checks every page gets are in the shared harness,
 * `helpers/console-pages-harness.mjs`, so a later file can render and check its own group of screens the same way; its
 * header says how the render runs and which Valkey database it needs. Without `VALKEY_TEST_URL` the render tests are
 * skipped; the committed goldens are still held to every page rule (`assertClean`: the references, and since review D3
 * the structure, one `#main`, one `h1`, one sprite, unique ids, bare panels). Each render also draws the operator's
 * page of every screen on a read-only console, held to the same rules and to no golden (`assertReadOnlyPages`).
 */

test("the page rules bite: a duplicate id, a second main, h1 or sprite, a dressed panel, every reference attribute to another host in any spelling a browser reads, and a tag they cannot read fail", () => {
  // A page that holds every rule, with six references of its own; each case below breaks one, and only that one.
  const icons = `<a href="#main">a</a><a href="/runs">b</a><a href="/fleet">c</a><a href="#x">d</a><img src="/static/i.png" alt=""><a href="/parked">e</a>`;
  const good = (extra = "", { open = `<main id="main">`, close = "</main>", h1 = "<h1>T</h1>", sprite = `<svg class="sprite"></svg>`, panel = `<section id="p-a" data-panel>p</section>` } = {}) => `${sprite}${open}${h1}<p id="x">x</p>${panel}${icons}${extra}${close}`;
  assertClean("good", good());
  assertClean("an outbound link in the one shape", good(`<a class="link" href="https://github.com/acme/web/issues/1" rel="noreferrer noopener" target="_blank">i</a>`));
  // What the browser reads as the same thing passes too: html's own entities, a single-quoted or unquoted value, a
  // newline or a space a URL parser drops, and a quoted > inside a value.
  assertClean("spellings the browser reads alike", good(`<a href='/runs?a=1&amp;b=&quot;2&quot;'>q</a><img src=/static/u.png alt=""><a href=" /fleet ">f</a><a title="a>b" href="/x">t</a>`));
  const fails = {
    "an id twice": good(`<p id="x">again</p>`),
    "an id twice, the second in single quotes": good(`<p id='x'>again</p>`),
    "an id twice, the second unquoted": good(`<p id=x>again</p>`),
    // Each of these keeps the skip link's #main an element of the page, so the main rule alone is what fails.
    "no main element": good("", { open: `<div id="main">`, close: "</div>" }),
    "a main that is not #main": good(`<p id="main">m</p>`, { open: "<main>" }),
    "a second main element": good("<main>m</main>"),
    "a second main element, upper case": good("<MAIN>m</MAIN>"),
    "a second #main": good(`<div id="main"></div>`),
    "no h1": good("", { h1: "" }),
    "a second h1": good("<h1>U</h1>"),
    "a second h1, upper case": good("<H1>U</H1>"),
    "no sprite": good("", { sprite: "" }),
    "a second sprite": good(`<svg class="sprite"></svg>`),
    "a second sprite, among other classes": good(`<svg class="x sprite"></svg>`),
    "a panel with a class": good("", { panel: `<section id="p-a" class="card" data-panel>p</section>` }),
    "a panel with a role": good("", { panel: `<section id="p-a" data-panel role="region">p</section>` }),
    "a panel with a class in single quotes": good("", { panel: `<section id="p-a" class='card' data-panel>p</section>` }),
    // Review round 2: every attribute a browser fetches or follows, on any element, in any spelling it reads.
    "a srcset to another host": good(`<img src="/a.png" srcset="/a.png 1x, https://evil.example/b.png 2x" alt="">`),
    "a preload's imagesrcset to another host": good(`<link rel="preload" as="image" imagesrcset="/a.png 1x, https://evil.example/a.png 2x">`),
    "a ping to another host": good(`<a href="/runs" ping="/ok https://evil.example/t">p</a>`),
    "a poster from another host": good(`<video src="/v.mp4" poster="https://evil.example/p.png"></video>`),
    "an object's data from another host": good(`<object data="https://evil.example/x.svg"></object>`),
    "a data attribute to another host on another element": good(`<embed data="https://evil.example/x.svg">`),
    "an object's codebase on another host": good(`<object codebase="https://evil.example/" data="/x"></object>`),
    "a table's background from another host": good(`<table background="https://evil.example/t.png"><tr><td>x</td></tr></table>`),
    "a cell's background from another host": good(`<table><tr><td background="https://evil.example/t.png">x</td></tr></table>`),
    "an unquoted src to another host": good(`<img src=https://evil.example/a.png alt="">`),
    "a src after a slash": good(`<img/src="https://evil.example/a.png" alt="">`),
    "a src straight after a quoted value": good(`<img alt=""src="https://evil.example/a.png">`),
    "a src after a quoted >": good(`<img title="a>b" src="https://evil.example/a.png" alt="">`),
    "an upper-case SRC": good(`<IMG SRC="https://evil.example/a.png" alt="">`),
    "an entity-encoded second slash": good(`<img src="/&#x2F;evil.example/a.png" alt="">`),
    "a named-entity slash": good(`<img src="/&sol;evil.example/a.png" alt="">`),
    "a newline between the slashes": good(`<img src="/\n/evil.example/a.png" alt="">`),
    "a backslash for the second slash": good(`<img src="/\\evil.example/a.png" alt="">`),
    "a meta refresh": good(`<meta http-equiv="refresh" content="0;url=https://evil.example/">`),
    "an outbound link without its rel": good(`<a href="https://github.com/acme/web/issues/1" target="_blank">i</a>`),
    "a same-page query": good(`<a href="?x=1">q</a>`),
    "a reference to an element the page lacks": good(`<a href="#nowhere">n</a>`),
    // A tag the rules cannot read is a failure, never a tag they skip: here the second <img is inside the first tag.
    "a tag the parser cannot read": good(`<img alt="a"<img src="/static/i.png">`),
  };
  for (const [what, page] of Object.entries(fails)) assert.throws(() => assertClean(what, page), assert.AssertionError, what);
  // `data-*` attributes are not `data`: a panel's `data-panel` and a `data-query` name no URL.
  assertClean("data attributes", good(`<div data-query="https://not.a.reference/"></div>`));
});

test("the committed goldens hold every page rule (references, structure, no control byte), with or without a Valkey to render them", () => {
  // The render test below checks the same on a fresh render, which equals these bytes; this one runs where it is
  // skipped too, so a hand-edited golden or a merge that left one stale still answers to the rules.
  // Issue #737: the pages that are not screens (sign-in, errors) are goldens here too, from `STATIC_SHOTS`, which
  // `console-static-pages.test.mjs` draws and pins; the states no deployment reaches are under `panels/`, its own test's.
  const want = [...SHOTS.flatMap(([shot]) => ROLES.map((role) => `${shot}.${role}.html`)), ...STATIC_SHOTS.map((shot) => `${shot}.html`)].sort();
  assert.deepEqual(readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort(), want, "a golden per shot and role, one per static shot, and no other");
  for (const f of want) assertClean(`fixtures/console/${f}`, readFileSync(join(FIXTURES, f), "utf8"));
});

/**
 * The operator's page of every screen on a read-only console (serve's read-only mode): rendered, never a golden, and
 * held to every page rule the goldens are (references, unique ids, one main, h1 and sprite, bare panels), so a frame
 * that draws something only in that mode (the read-only chip, the read-only top bar) cannot carry what no golden shows.
 */
function assertReadOnlyPages(readOnly, operatorPages) {
  assert.deepEqual(Object.keys(readOnly), SHOTS.map(([shot]) => shot), "a read-only render per shot");
  for (const [shot, page] of Object.entries(readOnly)) {
    const key = `${shot}.operator on a read-only console`;
    assert.equal(page.status, 200, key);
    assert.match(page.html, /Read-only console/, `${key} is drawn read-only`);
    assert.notEqual(page.html, operatorPages[`${shot}.operator`].html, `${key} is not the writable page`);
    assertClean(key, page.html);
    assertPanelsMatch(key, page);
  }
}

test("the read-only pages answer to every page rule: a read-only render with a foreign src, or a panel that is not the page's, fails", () => {
  // Fabricated, so this runs where the render cannot: one read-only page per shot that holds every rule, and the
  // writable page each differs from.
  const page = (extra = "") => `<svg class="sprite"></svg><main id="main"><h1>T</h1><span class="chip">Read-only console</span><section id="p-a" data-panel>p</section><a href="#main">a</a><a href="/runs">b</a><a href="/fleet">c</a><a href="/parked">d</a><a href="/config">e</a><img src="/static/i.png" alt="">${extra}</main>`;
  const set = (first) => Object.fromEntries(SHOTS.map(([shot], i) => [shot, { status: 200, html: i === 0 ? first : page(), panels: [{ id: "p-a", html: "p" }] }]));
  const writable = Object.fromEntries(SHOTS.map(([shot]) => [`${shot}.operator`, { html: "<main>the writable page</main>" }]));
  assertReadOnlyPages(set(page()), writable);
  assert.throws(() => assertReadOnlyPages(set(page(`<img src="https://evil.example/x.png" alt="">`)), writable), /src="https:\/\/evil\.example\/x\.png" is neither this console's nor this page's/, "the reference rule");
  assert.throws(() => assertReadOnlyPages(set(page(`<p id="main">again</p>`)), writable), /every id once/, "the structure rule");
  const stray = set(page());
  stray[SHOTS[0][0]] = { ...stray[SHOTS[0][0]], panels: [{ id: "p-a", html: "another" }] };
  assert.throws(() => assertReadOnlyPages(stray, writable), /panel p-a is the page's section, byte for byte/, "the panel rule");
});

test("console pages: every screen, both roles, byte-identical to the fixtures and to a second render", { skip, timeout: 400_000 }, async () => {
  const { pages: first, readOnly } = await renderAll("plain");
  // First, so a golden that differs (a markup change not yet written back) cannot hide a read-only page that breaks a
  // rule.
  assertReadOnlyPages(readOnly, first);
  const update = process.env.UPDATE_CONSOLE_FIXTURES === "1";
  if (update) mkdirSync(FIXTURES, { recursive: true });
  for (const [shot] of SHOTS) {
    for (const role of ROLES) {
      const key = `${shot}.${role}`;
      const file = join(FIXTURES, `${key}.html`);
      if (update) writeFileSync(file, first[key].html);
      assert.ok(existsSync(file), `${file} exists (UPDATE_CONSOLE_FIXTURES=1 writes it)`);
      assert.ok(first[key].html === readFileSync(file, "utf8"), `fixtures/console/${key}.html is not what the console renders now: run with UPDATE_CONSOLE_FIXTURES=1, read the diff, and commit it`);
    }
  }
  const { pages: second, readOnly: readOnlyAgain } = await renderAll("plain");
  for (const [key, page] of Object.entries(first)) {
    assert.equal(second[key].html, page.html, `${key} is the same bytes on a second render`);
    assertClean(key, page.html);
  }
  for (const [shot, page] of Object.entries(readOnly)) assert.equal(readOnlyAgain[shot].html, page.html, `${shot} on a read-only console is the same bytes on a second render`);
  // Status: the audit log is the operator's (the viewer gets the refusal page), and the parked run's detail exists.
  for (const [shot, name] of SHOTS) {
    assert.equal(first[`${shot}.operator`].status, 200, `${shot} for the operator`);
    assert.equal(first[`${shot}.viewer`].status, ["audit", "trigger-add", "sandboxes"].includes(name) ? 403 : 200, `${shot} for a viewer`);
    if (!["audit", "trigger-add", "sandboxes"].includes(name)) assertPanelsMatch(`${shot}.viewer`, first[`${shot}.viewer`]);
    assertPanelsMatch(`${shot}.operator`, first[`${shot}.operator`]);
  }
  // The role rule: the failure reason is the operator's, in a details element, and in no viewer page.
  const failed = "clone failed: remote rejected the token (403)";
  for (const [key, page] of Object.entries(first)) if (key.endsWith(".viewer")) assert.ok(!page.html.includes(failed), `${key} carries no failure reason`);
  assert.match(first["fleet.operator"].html.replace(/>\s+</g, "><"), new RegExp(`<details><summary class="code">gh-5d10</summary><p class="code">${failed.replace(/[()]/g, "\\$&")}</p></details>`), "the operator's fleet page has the reason in a details element");
  assert.ok([...first["fleet.operator"].html.matchAll(/<tr(?:\s[^>]*)?>[^]*?<\/tr>/g)].every(([row]) => !row.includes(failed)), "and never in a table row (a row cannot cross a table boundary)");
  assert.doesNotMatch(first["audit.viewer"].html, /serve-started|login-failed/, "a viewer's audit page shows no row");
  // What the screens show, spot-checked against the fixture.
  const overview = first["overview.operator"].html;
  assert.match(overview, /<h1>Overview<\/h1>/);
  assert.match(overview, /<body data-page="overview" data-live="overview" data-query="">/);
  assert.match(overview, /<a href="\/" aria-current="page"><svg class="ic" aria-hidden="true"><use href="#i-home"><\/use><\/svg>Overview<\/a>/);
  assert.match(first["overview.viewer"].html, /<nav class="pillnav" aria-label="Console screens">/);
  assert.ok(!first["overview.viewer"].html.includes('href="/audit"'), "a viewer's nav has no audit link");
  assert.ok(overview.includes('<details class="more">') && overview.includes('href="/audit"'), "an operator's has, under More");
  // Issue #737: the overview in the Pulse markup, its title's headline a panel, and its jobs in line the worker's own
  // (the harness's WAITING_SEEDS, deferred through BullMQ and `makeDeferTo`), read by the real `readWaiting`: each kind
  // of wait counted, each row's sentence the worker's (`DEFER_WHYS`), and each row's one action.
  for (const key of ["overview.operator", "overview.viewer", "overview-host.operator", "overview-host.viewer"]) {
    assert.ok(!first[key].html.includes('class="legacy"'), `${key}: out of the legacy layer`);
    assert.match(first[key].html, /<span id="p-headline" data-panel>Needs you: 1 question and 2 to fix\. 4 jobs running\.<\/span>/, key);
    assert.match(first[key].html, /<p class="kpi"><b>5<\/b><span>jobs waiting to start<\/span><\/p>/, `${key}: five in line`);
    for (const [word, n] of [["Free slot", 1], ["Another run", 1], ["Time or check", 1], ["Retry backoff", 2]]) assert.ok(first[key].html.includes(`<span>${word}</span><span class="end"><b>${n}</b></span>`), `${key}: ${word} ${n}`);
  }
  assert.ok(overview.includes('<span class="code">gh-c9e1</span><span class="wl__t">build3 has no free job slot. <span class="code">gh-4a7e</span> still holds one of its slots</span><a class="btn btn--sm btn--ghost" href="/fleet/host?name=build3">Open build3</a>'), "the slot gh-4a7e still holds and its host detail link");
  assert.ok(overview.includes('<span class="code">gh-d4f0</span><span class="wl__t">Chained after gh-b3d7; starts when its folder is free</span><a class="btn btn--sm btn--ghost" href="/run?id=gh-b3d7">Chain</a>'), "the chained job");
  assert.ok(overview.includes('<span class="code">gh-71b2</span><span class="wl__t">Attempt 2 of 3 at <time datetime="2026-10-08T15:43:08.000Z">'), "the retry, its backoff from the worker's record");
  assert.ok(!first["overview.viewer"].html.includes('btn--ghost" href="/fleet">Open Fleet</a>') && !first["overview.viewer"].html.includes(">Edit</a>"), "a viewer is offered no action");
  assert.match(first["overview-host.operator"].html, /<h2>Runs by host<\/h2>/, "the other grouping, through the query");
  assert.match(first["overview-host.operator"].html, /<body data-page="overview" data-live="overview" data-query="rows=host&amp;zoom=24h">/);
  // Issue #737: the shell's Parked count, the same on every page, from the snapshot or the reader's own count.
  const parkedPill = /<a href="\/parked"(?: aria-current="page")?><svg class="ic" aria-hidden="true"><use href="#i-parked"><\/use><\/svg>Parked<span id="p-nav-parked" data-panel><span class="count tone-parked"><span aria-hidden="true">1<\/span><span class="sr">1 unanswered<\/span><\/span><\/span><\/a>/;
  for (const [key, page] of Object.entries(first)) assert.match(page.html, parkedPill, `${key}: the fixture's one parked run`);
  assert.match(first["parked.viewer"].html, /href="https:\/\/github\.com\/acme\/api\/issues\/131" rel="noreferrer noopener" target="_blank">acme\/api#131<\/a>/, "the parked run links to its issue");
  assert.match(first["parked.viewer"].html, /github, resumed 2 times/, "with the session store's chain count");
  assert.match(first["run.viewer"].html, /awaiting-input/);
  // Issue #643: the live transcript section, outside every panel. The fixture's run has ended and Valkey holds no
  // stream for it, so the operator reads why and nothing is opened; a viewer reads that transcripts are operators'.
  // #747: the browser-owned transcript is in the main grid and never inside a swapped panel.
  assert.match(first["run.operator"].html, /<div id="transcript" class="run-transcript"><div class="card">/);
  assert.match(first["run.operator"].html, /data-transcript data-job="gh-2f6a"/);
  assert.match(first["run.operator"].html, /<span>pi-dispatch<\/span> <span>sandbox<\/span> <span>gh-2f6a<\/span>/);
  assert.match(first["run.viewer"].html, /Transcripts are shown to operators only/);
  assert.doesNotMatch(first["run.viewer"].html, /data-transcript data-job/);
  // Issue #644: the active tables carry each job's progress as integers and a tool name, the remote host's job too; the
  // running job's detail shows its counters to everyone and its phase names, bar and note to the operator alone.
  // Since issue #737 the overview counts the running jobs in each host's slots, and the table with their progress is
  // Fleet's alone, for both roles.
  for (const key of ["fleet.viewer", "fleet.operator"]) {
    assert.match(first[key].html, /<th scope="col">Progress<\/th>/, key);
    assert.match(first[key].html, /turn 7, 12 steps \(1 failed\), bash running 40s, phase 2\/4/, `${key}: the phased run`);
    assert.match(first[key].html, /turn 31, 58 steps/, `${key}: the remote host's job`);
  }
  const liveRun = first["run-live.operator"].html;
  assert.equal(first["run-live.operator"].status, 200, "a running job without a record is a page, not a 404");
  assert.match(liveRun, /This run has no record yet/);
  assert.match(liveRun, /<li class="is-now" aria-current="step"><span class="bar" aria-hidden="true"><i class="on"><\/i><i class="on"><\/i><i class="on"><\/i>/);
  assert.match(liveRun, /three of ten tables migrated/);
  const liveViewer = first["run-live.viewer"].html;
  assert.match(liveViewer, /<dt>Turn<\/dt><dd>7 of 30<\/dd>/, "a viewer gets the counters");
  assert.match(liveViewer, /Phase 2 of 4: 3 of 10 done/, "and the phase's integers");
  assert.match(liveViewer, /Phase names and the run's note are shown to operators only\./);
  for (const text of ["migrate the schema", "three of ten tables migrated"]) {
    for (const [key, page] of Object.entries(first)) if (key !== "run-live.operator") assert.ok(!page.html.includes(text), `${key} carries no ${text}`);
  }
  assert.match(first["runs.viewer"].html, /<th scope="col">Job<\/th>/);
  assert.match(first["runs.viewer"].html, /<a class="btn btn--sm" href="\/runs\?before=\d+">Older<\/a>/, "the runs page pages by a cursor");
  assert.match(first["runs-filtered.viewer"].html, /value="web"/, "the filter form shows the query's values");
  assert.match(first["runs-filtered.viewer"].html, /<a class="btn btn--sm" href="\/runs\?project=web&amp;outcome=completed&amp;before=\d+">Older<\/a>/, "and paging keeps the filter");
  assert.match(first["insights.viewer"].html, /<ol id="insights-tips"[^>]*hidden>/, "the chart tooltips are listed");
  // Each view is assembled independently; the graph and flow estimate moved off Spend.
  assert.doesNotMatch(first["insights.viewer"].html, /id="graph-nodes"/);
  assert.match(first["insights-flows.viewer"].html, /id="graph-nodes"/);
  assert.doesNotMatch(first["insights-flows-list.viewer"].html, /id="graph-nodes"/);
  assert.match(first["insights-flows-selected.viewer"].html, /id="p-flows-selected"/);
  assert.match(first["insights.viewer"].html, /id="p-whatif"/);
  assert.match(first["insights-whatif.viewer"].html, /id="p-whatif-flow"/);
  assert.match(first["insights-whatif.viewer"].html, /acme\/model-1/);
  assert.doesNotMatch(first["insights-breakdown.viewer"].html, /Show full local paths/, "viewer has no paths toggle");
  assert.match(first["insights-breakdown.operator"].html, /Full paths/, "operator has paths opt-in");
  assert.doesNotMatch(first["config.operator"].html, /data-action="(?:priorities-set|envelope-set|allocation-revert)"/);
  assert.match(first["config.viewer"].html, /\.\.\.\/site/, "a local folder is shown by its basename");
  assert.match(first["config.viewer"].html, /<li class="mono">kimi-coding|linear/, "the configuration lists what the overlay holds");
  assert.match(first["audit.operator"].html, /Not an audit row: line 5 of 2026-10\.jsonl/, "a damaged audit line is a warning row");
});

test("console pages: hostile values are escaped or refused, and a viewer never sees a failure reason", { skip, timeout: 400_000 }, async () => {
  const { pages, readOnly } = await renderAll("hostile");
  for (const [key, page] of Object.entries(pages)) {
    if (key === "hostileRunQuery") continue;
    assertClean(key, page.html);
    assert.ok(!page.html.includes("<script>alert"), `${key} has no live script from a value`);
    assert.ok(!page.html.includes("<b onmouseover"), `${key} has no live element from an active job id`);
    if (key.endsWith(".viewer")) assert.ok(!page.html.includes("SECRET-FAILURE-TEXT"), `${key} carries no failure reason`);
  }
  assertReadOnlyPages(readOnly, pages);
  for (const [shot, page] of Object.entries(readOnly)) assert.ok(!page.html.includes("<script>alert") && !page.html.includes("<b onmouseover"), `${shot} on a read-only console has no live markup from a value`);
  // Issue #644: the hostile phase name and note are escaped and scrubbed on the operator's run page, and absent from
  // every other page (a viewer's run page, every list, every hub panel).
  const liveRun = pages["run-live.operator"].html;
  assert.match(liveRun, /<span class="name">&lt;script&gt;alert\(6\)&lt;\/script&gt; ?\[2J<\/span>/, "the hostile phase name is text");
  assert.match(liveRun, /PHASE-NOTE-TEXT &lt;img src=x onerror=alert\(7\)&gt;/, "the hostile note is text");
  for (const [key, page] of Object.entries(pages)) {
    if (key === "hostileRunQuery" || key === "run-live.operator") continue;
    assert.ok(!page.html.includes("PHASE-NOTE-TEXT") && !page.html.includes("alert(6)"), `${key} carries no phase name or note`);
  }
  // The hostile run is listed, escaped, and NOT linked: its id is outside the run-id charset, so /run would answer 400.
  const runs = pages["runs.viewer"].html;
  assert.match(runs, /<td class="id"><span class="code">gh-&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39; ?\[31m<\/span><\/td>/, "the hostile job id is plain text");
  assert.doesNotMatch(runs, /href="\/run\?id=gh-%3Cscript/, "with no dead link");
  const runLinks = [...runs.matchAll(/href="\/run\?id=([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
  assert.ok(runLinks.length > 5);
  const { parsePageQuery: parseQuery } = await import("../src/console/pages.mjs");
  for (const id of runLinks) assert.equal(parseQuery("run", new URLSearchParams({ id })).refusal, undefined, `every run link is one /run accepts: ${id}`);
  assert.match(runs, /<td class="tgt">javascript:alert\(3\)\/x#5<\/td>/, "a javascript: repository is shown as text, never linked");
  assert.match(pages["parked.viewer"].html, /acme\/web&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt; ?#7/, "a hostile parked target is text");
  assert.match(pages["fleet.viewer"].html, /gh-&lt;b onmouseover=alert\(5\)&gt;/, "a hostile active job id is text");
  // The operator sees the reason, escaped and scrubbed, in its details element only.
  const fleet = pages["fleet.operator"].html;
  assert.match(fleet.replace(/>\s+</g, "><"), /<details><summary class="code">gh-&lt;script&gt;[^<]*<\/summary><p class="code">SECRET-FAILURE-TEXT &lt;img src=x onerror=alert\(4\)&gt; ?\[0m<\/p><\/details>/);
  assert.ok(!/<td[^>]*>[^<]*SECRET-FAILURE-TEXT/.test(fleet), "never in a list cell");
  assert.ok(pages.hostileRunQuery.refusal, "the hostile run id is refused as a query before any read");
});

// ---------------------------------------------------------------------------------------------------------------------
// The query's bounds and the read discipline, on no deployment at all.
// ---------------------------------------------------------------------------------------------------------------------

test("parsePageQuery: each screen takes only its own parameters, bounded and charset-checked, and refuses without echoing", async () => {
  const { PAGES, QUERY_LIMITS, pageQueryString, parsePageQuery } = await import("../src/console/pages.mjs");
  const q = (name, qs) => parsePageQuery(name, new URLSearchParams(qs));
  assert.deepEqual(Object.keys(PAGES), ["overview", "runs", "sandboxes", "zero-touch", "run", "parked", "insights", "insights-budget-split", "insights-capacity", "insights-breakdown", "insights-flows", "fleet", "host", "venue", "trigger", "triggers", "trigger-check", "trigger-add", "config", "secrets", "connections", "project", "watch", "watch-board", "audit"]);
  assert.ok(Object.isFrozen(PAGES) && Object.values(PAGES).every(Object.isFrozen));
  assert.equal(PAGES.audit.auth, "operator");
  assert.ok(Object.values(PAGES).filter((p) => p.auth !== "operator").every((p) => p.auth === "viewer"));
  assert.match(q("nope", "").refusal, /no such page/);
  assert.match(q("__proto__", "").refusal, /no such page/);
  for (const name of ["parked", "fleet", "config", "secrets", "connections", "trigger-check"]) {
    assert.deepEqual(q(name, "").query, {});
    assert.match(q(name, "x=1").refusal, /takes no query parameters/);
  }
  // runs: the filter and a cursor.
  const runs = q("runs", "repo=acme/web&outcome=failed&before=1760000000000");
  assert.deepEqual(runs.query, { filter: { repo: "acme/web", outcome: "failed" }, before: 1760000000000 });
  assert.ok(Object.isFrozen(runs.query));
  assert.equal(pageQueryString("runs", runs.query), "repo=acme%2Fweb&outcome=failed&before=1760000000000");
  assert.deepEqual(q("runs", "").query, { filter: {}, before: null });
  // Issue #668: a priced model id with a leading @ or ~ is a runs filter, and paging keeps it.
  for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "~anthropic/claude-opus-latest"]) {
    const byModel = q("runs", `model=${encodeURIComponent(model)}`);
    assert.deepEqual(byModel.query, { filter: { model }, before: null }, model);
    assert.deepEqual(q("runs", pageQueryString("runs", byModel.query)).query, byModel.query, `${model} round-trips`);
  }
  const hostile = `<script>"${ESC}`;
  for (const [qs, re] of [
    [`repo=${encodeURIComponent(hostile)}`, /repo must be/],
    [`q=${"a".repeat(QUERY_LIMITS.valueLength + 1)}`, /longer than 256/],
    ["before=12a", /before must be a whole number/],
    ["before=-5", /before must be a whole number/],
    [`before=${"9".repeat(17)}`, /before must be a whole number/],
    ["before=99999999999999999", /before must be a whole number/],
    ["repo=a&repo=b", /repo is given more than once/],
    ["before=1&before=2", /before is given more than once/],
    [`${encodeURIComponent(hostile)}=1`, /takes only repo, kind/],
    [Array.from({ length: QUERY_LIMITS.params + 1 }, (_, i) => `repo=${i}`).join("&"), /at most 16 parameters/],
  ]) {
    const r = q("runs", qs);
    assert.match(r.refusal ?? "", re, qs.slice(0, 60));
    assert.ok(!r.refusal.includes("<script") && !r.refusal.includes(ESC), "a refusal never echoes the value");
  }
  // overview (issue #737): the timeline's grouping, window and project, each a closed value, each null when not given
  // (the timeline's default), and written back only when given.
  const ov = (over) => ({ rows: null, zoom: null, project: null, ...over });
  assert.deepEqual(q("overview", "").query, ov({}));
  assert.equal(pageQueryString("overview", q("overview", "").query), "", "the default overview carries no query");
  assert.ok(Object.isFrozen(q("overview", "").query));
  for (const rows of ["project", "host"]) assert.deepEqual(q("overview", `rows=${rows}`).query, ov({ rows }));
  for (const zoom of ["1h", "3h", "24h"]) assert.deepEqual(q("overview", `zoom=${zoom}`).query, ov({ zoom }));
  const grouped = q("overview", "rows=host&zoom=24h&project=web");
  assert.deepEqual(grouped.query, ov({ rows: "host", zoom: "24h", project: "web" }));
  assert.equal(pageQueryString("overview", grouped.query), "rows=host&zoom=24h&project=web");
  assert.deepEqual(q("overview", pageQueryString("overview", grouped.query)).query, grouped.query, "the string round-trips");
  assert.deepEqual(q("overview", "rows=&zoom=").query, ov({}), "an empty value is the default");
  for (const [qs, re] of [
    [`rows=${encodeURIComponent(hostile)}`, /^rows must be one of project, host$/],
    ["rows=Host", /^rows must be one of project, host$/],
    ["rows=queue", /^rows must be one of project, host$/],
    [`zoom=${encodeURIComponent(hostile)}`, /^zoom must be one of 1h, 3h, 24h$/],
    ["zoom=2h", /^zoom must be one of 1h, 3h, 24h$/],
    ["zoom=24H", /^zoom must be one of 1h, 3h, 24h$/],
    // A name every object answers to is no zoom: the windows are the table's own keys, never what it inherits.
    ...["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"].map((z) => [`zoom=${z}`, /^zoom must be one of 1h, 3h, 24h$/]),
    [`project=${encodeURIComponent(hostile)}`, /^project must be a project id/],
    ["project=Web", /^project must be a project id/],
    [`project=${"a".repeat(33)}`, /^project must be a project id/],
    ["project=-web", /^project must be a project id/],
    ["rows=host&rows=project", /rows is given more than once/],
    ["x=1", /the overview page takes only rows, zoom, project/],
  ]) {
    const r = q("overview", qs);
    assert.match(r.refusal ?? "", re, qs);
    assert.ok(!r.refusal.includes("<script") && !r.refusal.includes(ESC), `${qs}: a refusal never echoes the value`);
  }
  // run: an id in the read model's charset, required.
  assert.deepEqual(q("run", "id=repeat:nightly-tidy:1760000000000").query, { id: "repeat:nightly-tidy:1760000000000" });
  assert.match(q("run", "").refusal, /needs \?id=/);
  assert.match(q("run", "id=").refusal, /needs \?id=/);
  assert.match(q("run", `id=${encodeURIComponent(hostile)}`).refusal, /id must be a run id/);
  assert.match(q("run", "id=a%20b").refusal, /id must be a run id/);
  assert.match(q("run", `id=${"a".repeat(201)}`).refusal, /id must be a run id/);
  assert.match(q("run", "id=gh-1&x=2").refusal, /takes only id/);
  // insights: a closed range vocabulary, 30d by default (the static export's default, kept when the insights moved to
  // the console); the what-if pair, together or not at all; and paths=full.
  const none = { whatif: null, flow: null, paths: null, project: null, runs: null };
  assert.deepEqual(q("insights", "").query, { range: "30d", ...none });
  for (const r of ["7d", "30d", "mtd"]) assert.deepEqual(q("insights", `range=${r}`).query, { range: r, ...none });
  for (const r of ["90d", "7D", "mtd ", "<x>"]) assert.match(q("insights", `range=${encodeURIComponent(r)}`).refusal, /range must be one of 7d, 30d, mtd/);
  const asked = q("insights", "range=7d&whatif=openrouter%2Fanthropic%2Fclaude-x&flow=fix-it&paths=full");
  assert.deepEqual(asked.query, { range: "7d", whatif: "openrouter/anthropic/claude-x", flow: "fix-it", paths: "full", project: null, runs: null });
  assert.equal(pageQueryString("insights", asked.query), "range=7d&whatif=openrouter%2Fanthropic%2Fclaude-x&flow=fix-it&paths=full");
  assert.deepEqual(q("insights", pageQueryString("insights", asked.query)).query, asked.query, "the string round-trips");
  for (const [qs, re] of [

    ["flow=tidy", /flow must be given with whatif/],
    ["whatif=noslash&flow=tidy", /whatif must be a provider\/model id/],
    ["whatif=%2Fx&flow=tidy", /whatif must be a provider\/model id/],
    ["whatif=a%2F&flow=tidy", /whatif must be a provider\/model id/],
    [`whatif=a%2F${encodeURIComponent(hostile)}&flow=tidy`, /whatif must be a provider\/model id/],
    [`whatif=a%2F${"m".repeat(129)}&flow=tidy`, /whatif must be a provider\/model id/],
    ["whatif=a%2Fb&flow=Tidy", /flow must be a flow name/],
    [`whatif=a%2Fb&flow=${encodeURIComponent(hostile)}`, /flow must be a flow name/],
    ["paths=absolute", /paths must be full/],
    ["paths=full&paths=full", /paths is given more than once/],
    ["fullPaths=1", /takes only range, project, whatif, flow, runs, paths/],
  ]) {
    const r = q("insights", qs);
    assert.match(r.refusal ?? "", re, qs);
    assert.ok(!r.refusal.includes("<script") && !r.refusal.includes(ESC), "a refusal never echoes the value");
  }
  // audit: readConsoleAudit's cursor exactly, `YYYY-MM:<line>`, kept as the string the reader takes. Since issue #737 the
  // audit page's own parser (audit-view.mjs `parseAuditQuery`) judges it, with the filters and `seq` beside it: six keys,
  // each null when not given (its own test holds the filters' rules).
  const auditQ = (over) => ({ before: null, who: null, action: null, outcome: null, q: null, seq: null, ...over });
  assert.deepEqual(q("audit", "").query, auditQ({}));
  assert.deepEqual(q("audit", "before=2026-10:12").query, auditQ({ before: "2026-10:12" }));
  assert.deepEqual(q("audit", "before=2026-10%3A1").query, auditQ({ before: "2026-10:1" }), "the link's encoded colon");
  assert.deepEqual(q("audit", `before=2026-10:${"9".repeat(15)}`).query, auditQ({ before: `2026-10:${"9".repeat(15)}` }));
  assert.equal(pageQueryString("audit", { before: "2026-10:12" }), "before=2026-10%3A12");
  assert.deepEqual(q("audit", pageQueryString("audit", { before: "2026-10:12" })).query, auditQ({ before: "2026-10:12" }), "the string round-trips");
  const filtered = q("audit", "who=ops&action=write&outcome=ok&q=pause");
  assert.deepEqual(filtered.query, auditQ({ who: "ops", action: "write", outcome: "ok", q: "pause" }));
  assert.equal(pageQueryString("audit", filtered.query), "who=ops&action=write&outcome=ok&q=pause", "in the parser's order, the empty ones left out");
  assert.deepEqual(q("audit", "seq=41").query, auditQ({ seq: 41 }), "a row number, as a number");
  assert.match(q("audit", "seq=41&before=2026-10:12").refusal, /seq and before do not go together/);
  assert.match(q("audit", `outcome=${encodeURIComponent(hostile)}`).refusal, /^outcome must be one of ok, refused, failed$/, "named, never echoed");
  for (const b of ["12", "12.5", "2026-10:0", "2026-10:012", "2026-1:5", "2026-10:-1", "2026-10:1e3", "2026-10:12 ", " 2026-10:12", "2026-10:1:2", "2026-10", `2026-10:${"9".repeat(16)}`, "abc"]) {
    assert.match(q("audit", `before=${encodeURIComponent(b)}`).refusal, /before must be an audit position \(YYYY-MM:line/, b);
  }
  // A plain object and a string are read like URLSearchParams; a non-string value refuses.
  assert.deepEqual(parsePageQuery("run", { id: "gh-1" }).query, { id: "gh-1" });
  assert.deepEqual(parsePageQuery("run", "id=gh-1").query, { id: "gh-1" });
  assert.match(parsePageQuery("run", { id: ["gh-1"] }).refusal, /not readable/);
});

test("loadPageData reads only what a screen shows, the snapshot at most once, and keeps no env but the forge hosts", async () => {
  const { loadPageData, parsePageQuery, PAGES } = await import("../src/console/pages.mjs");
  for (const name of Object.keys(PAGES)) {
    // `waiting` counts the snapshots asked for the waiting jobs too (issue #737), which the overview alone draws.
    const calls = { zeroTouch: 0, snapshot: 0, waiting: 0, runsPage: 0, runById: 0, transcriptMeta: 0, insights: 0, audit: 0, subscriptions: 0, parkedCount: 0 };
    const deps = {
      fleet: {
        snapshot: async (opts) => {
          calls.snapshot++;
          if (opts?.waiting === true) calls.waiting++;
          return { parked: [] };
        },
        runsPage: async () => (calls.runsPage++, { runs: [], next: null, mirror: "off" }),
        runById: async () => (calls.runById++, { record: { jobId: "gh-1", startedAt: "2026-10-08T00:00:00Z" }, source: "local" }),
        transcriptMeta: async () => (calls.transcriptMeta++, { exists: true, ended: false, outcome: null, length: 3, firstId: "1-0", lastId: "3-0" }),
        parkedCount: async () => (calls.parkedCount++, 2),
      },
      zeroTouch: async () => (calls.zeroTouch++, null),
      insights: async () => (calls.insights++, {}),
      audit: async () => (calls.audit++, { rows: [], next: null }),
      subscriptions: () => (calls.subscriptions++, { subscriptions: [] }),
      env: { GITLAB_URL: "https://gl.example", GITHUB_TOKEN: "ghp_secret", VALKEY_URL: "redis://x" },
      now: () => 1234,
    };
    const query = parsePageQuery(name, name === "project" ? "id=billing" : name === "run" ? "id=gh-1" : name === "host" ? "name=build3" : name === "venue" ? "name=local" : name === "trigger" ? "index=0" : "").query;
    const data = await loadPageData(name, query, deps);
    assert.equal(data.now, 1234, `${name}: the clock is read once, into the data`);
    assert.deepEqual(data.env, { GITLAB_URL: "https://gl.example" }, `${name}: only forge host variables are kept`);
    assert.ok(calls.snapshot <= 1, `${name}: snapshot at most once`);
    // Issue #737: a screen that reads no snapshot reads the navigation's Parked count, once; one that does takes it from
    // the snapshot, so no screen reads both.
    const expected = name.startsWith("insights") ? ["insights", "parkedCount"] : { sandboxes: ["parkedCount"], "zero-touch": ["zeroTouch", "parkedCount"], overview: ["snapshot", "waiting"], runs: ["runsPage", "subscriptions", "parkedCount"], run: ["runById", "runsPage", "subscriptions", "transcriptMeta", "parkedCount"], parked: ["snapshot"], insights: ["insights", "parkedCount"], fleet: ["snapshot", "waiting"], host: ["snapshot", "waiting", "runsPage"], venue: ["snapshot"], trigger: ["snapshot", "waiting"], triggers: ["snapshot", "waiting"], "trigger-check": ["parkedCount"], "trigger-add": ["snapshot"], config: ["snapshot"], secrets: ["snapshot"], connections: ["snapshot"], project: ["snapshot", "waiting"], watch: ["parkedCount"], "watch-board": ["parkedCount"], audit: ["audit", "parkedCount"] }[name];
    assert.deepEqual(Object.keys(calls).filter((k) => calls[k] > 0).sort(), [...expected].sort(), `${name} reads ${expected.join(", ")}`);
    assert.ok(calls.parkedCount <= 1, `${name}: the count at most once`);
    assert.equal(data.parkedCount, expected.includes("parkedCount") ? 2 : undefined, `${name}: the count is in the data where it was read`);
    if (name === "run") assert.deepEqual(data.transcript, { exists: true, ended: false, outcome: null, length: 3, lastId: "3-0" }, "the stream's safe metadata and cursor only, never a byte of text");
  }
  // A read that throws is a stated absence, never a thrown page.
  const broken = { fleet: { snapshot: async () => { throw new Error("down"); }, runsPage: async () => { throw new Error("down"); }, runById: async () => { throw new Error("down"); }, transcriptMeta: async () => { throw new Error("down"); } }, insights: async () => { throw new Error("down"); }, audit: async () => { throw new Error("down"); }, now: 1 };
  assert.equal((await loadPageData("overview", {}, broken)).snapshot, null);
  assert.equal((await loadPageData("runs", { filter: {}, before: null }, broken)).runsPage, null);
  assert.deepEqual((await loadPageData("run", { id: "x" }, broken)).run, { unreadable: RUN_RECORD_UNREAD }, "a record read that throws is unread, never a run that is not there");
  assert.deepEqual((await loadPageData("run", { id: "x" }, broken)).transcript, { unreachable: true, exists: false }, "a transcript read that throws is a stated absence");
  assert.match((await loadPageData("insights", { range: "7d" }, broken)).insightsError, /could not be assembled/);
  // The audit page's read is a view either way (audit-view.mjs `readAuditView`): a reader that throws is a view with the
  // reader's sentence in `unreadable` and no rows, which the log's panel says, never a thrown page or a null to guess at.
  const unreadAudit = (await loadPageData("audit", { before: null }, broken)).audit;
  assert.deepEqual([unreadAudit.unreadable, unreadAudit.rows, unreadAudit.next], ["the audit log could not be read", [], null]);
  assert.equal(unreadAudit.chain.state, "unreadable", "and the chain, with no verifier wired, is not claimed checked");
  // The Parked count: a reader without it, one that throws and one that answers something that is not a count are all
  // "unknown", never 0.
  assert.equal((await loadPageData("audit", { before: null }, broken)).parkedCount, null, "no parkedCount on the reader");
  for (const answer of [() => { throw new Error("down"); }, async () => { throw new Error("down"); }, async () => -1, async () => 1.5, async () => "3", async () => null]) {
    const fleet = { ...broken.fleet, parkedCount: answer };
    assert.equal((await loadPageData("insights", { range: "7d" }, { ...broken, fleet })).parkedCount, null, String(answer));
  }
});

test("the overview's query draws, never reads: every overview query has one data query, and loadPageData reads the same for each", async () => {
  // Issue #737: the live hub reads a screen once per tick for each distinct DATA key (`live.mjs` `dataQueryOf`, wired in
  // `cli.mjs` to this module's), so the timeline's groupings, windows and projects must share one read: three open
  // groupings would otherwise read the snapshot three times a tick.
  const { dataQueryOf, loadPageData, pageQueryString, parsePageQuery } = await import("../src/console/pages.mjs");
  const queries = ["", "rows=host", "zoom=1h", "zoom=24h", "project=web", "rows=host&zoom=24h&project=billing", "rows=project&zoom=3h"].map((qs) => parsePageQuery("overview", qs).query);
  const snap = { parked: [], hostBudgets: [{ name: "mini1" }] };
  const reads = [];
  const deps = { fleet: { snapshot: async () => (reads.push("snapshot"), snap) }, now: () => 1234, env: {}, deployment: { folder: "acme-prod" } };
  const first = await loadPageData("overview", dataQueryOf("overview", queries[0]), deps);
  assert.equal(first.deployment.folder, "acme-prod", "the deployment's folder is in the data");
  for (const q of queries) {
    assert.deepEqual(dataQueryOf("overview", q), {}, JSON.stringify(q));
    assert.equal(pageQueryString("overview", dataQueryOf("overview", q)), "", `${JSON.stringify(q)}: one data key`);
    assert.deepEqual(await loadPageData("overview", q, deps), first, `${JSON.stringify(q)}: the same data, whatever the query`);
  }
  assert.deepEqual(reads, Array(queries.length + 1).fill("snapshot"), "each load reads the snapshot once, and nothing else");
  // Every other screen reads what its query names: its data query is its query, the same object.
  for (const [name, qs] of [["runs", "project=web"], ["run", "id=gh-1"], ["insights", "range=7d"], ["audit", "who=ops"], ["fleet", ""]]) {
    const q = parsePageQuery(name, qs).query;
    assert.equal(dataQueryOf(name, q), q, name);
  }
  // A caller that passes no deployment gets null, never a folder of this machine.
  assert.equal((await loadPageData("overview", {}, { ...deps, deployment: undefined })).deployment, null);
});

test("the run page says the transcript could not be read when transcriptMeta is unreachable, never that it has not started", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const session = { name: "ops", role: "operator" };
  const fleetWith = (meta) => ({ runById: async () => ({ missing: true }), runsPage: async () => ({ runs: [], next: null, mirror: "off" }), transcriptMeta: async () => meta });
  for (const meta of [{ unreachable: "timed out reaching the transcript" }, { unreachable: "the transcript could not be read (ECONNREFUSED)" }]) {
    const data = await loadPageData("run", { id: "gh-1" }, { fleet: fleetWith(meta), subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(data.transcript, { unreachable: true, exists: false }, `${meta.unreachable}: a stated failure`);
    const html = String((await renderPage("run", { query: { id: "gh-1" }, session, data, readOnly: false })).html);
    assert.match(html, /The live transcript could not be read; the next update tries again/, meta.unreachable);
    assert.doesNotMatch(html, /not started yet/, "an unreachable Valkey is not an absent stream");
    assert.match(html, /data-transcript data-job="gh-1"/, "the static box waits for the page stream to attach after a good load");
    assert.ok(!html.includes(meta.unreachable), "the reader's reason itself is not shown");
  }
  // The same page with the stream merely absent says why, and watches.
  const absent = await loadPageData("run", { id: "gh-1" }, { fleet: fleetWith({ exists: false, ended: false, outcome: null, length: 0, firstId: null, lastId: null }), subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.match(String((await renderPage("run", { query: { id: "gh-1" }, session, data: absent, readOnly: false })).html), /Waiting for the run/);
});

test("the run page reads progress by the run (progressOfRun), handing it the record, and pairs a continued attempt with its own record (issue #662)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const session = { name: "ops", role: "operator" };
  const record = { jobId: "gh-1", outcome: "failed", reason: "recovery-enqueued", startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:03:00.000Z", progress: { turns: 4, steps: 6 } };
  const key = { v: 1, turn: 1, steps: 0, failed: 0, interrupted: 0, running: [], recent: [], phase: null, phases: [], note: null, prior: null, startedAt: 2, updatedAt: 3, ended: false, outcome: null };
  const calls = [];
  const fleet = {
    runById: async () => ({ record }),
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    progress: async (id) => (calls.push(["progress", id]), key),
    progressOfRun: async (id, rec) => (calls.push(["progressOfRun", id, rec?.reason ?? null]), { progress: key, continues: true, continuesAs: "gh-1.r1" }),
  };
  const data = await loadPageData("run", { id: "gh-1" }, { fleet, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.deepEqual(calls, [["progressOfRun", "gh-1", "recovery-enqueued"]], "one read, by the run, after the record");
  assert.deepEqual(data.progressContinues, { as: "gh-1.r1" });
  const html = String((await renderPage("run", { query: { id: "gh-1" }, session, data, readOnly: false })).html);
  assert.match(html, /This run continues as <a class="mono" href="\/run\?id=gh-1\.r1">gh-1\.r1<\/a>/);
  assert.match(html, /<dt>Turns<\/dt><dd>4<\/dd>/);
  // A run that does not continue: no marker, the key as read, the pairing as before.
  calls.length = 0;
  const plain = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => ({ progress: key, continues: false, continuesAs: null }) }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.equal(Object.hasOwn(plain, "progressContinues"), false);
  assert.equal(plain.progress, key);
  // A fleet without progressOfRun reads by the page's id, as before; one that throws is unreachable.
  const { progressOfRun: _drop, ...older } = fleet;
  assert.equal((await loadPageData("run", { id: "gh-1" }, { fleet: older, subscriptions: () => ({ subscriptions: [] }), now: () => 1 })).progress, key);
  const down = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => { throw new Error("down"); } }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.deepEqual(down.progress, { unreachable: true });
  // Review: a continued attempt whose read threw still shows its own record and says it continues, not the failure.
  assert.deepEqual(down.progressContinues, { as: null });
  const downHtml = String((await renderPage("run", { query: { id: "gh-1" }, session, data: down, readOnly: false })).html);
  assert.match(downHtml, /This run continues as a recovery job\./);
  assert.match(downHtml, /<dt>Turns<\/dt><dd>4<\/dd>/);
  assert.doesNotMatch(downHtml, /progress could not be read/);
  // An answer with no progress at all reads as unreachable, never as a snapshot or an absence.
  for (const answer of [null, {}, { continues: false }]) {
    const odd = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => answer }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(odd.progress, { unreachable: true }, JSON.stringify(answer));
  }
  // A hostile recovery job id from the reader is dropped here, before any panel sees it.
  for (const as of ['gh-1.r1"><script>', "", 7]) {
    const hostile = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => ({ progress: key, continues: true, continuesAs: as }) }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(hostile.progressContinues, { as: null }, JSON.stringify(as));
  }
});

test("the audit page's Older rows link carries readConsoleAudit's own cursor, which parsePageQuery takes back to the next page", async () => {
  const { AUDIT_PER_PAGE, loadPageData, parsePageQuery, renderPage } = await import("../src/console/pages.mjs");
  const { makeConsoleAudit, readConsoleAudit } = await import("../../worker/src/console-audit.mjs");
  const logsDir = tempDir("console-audit-pager-");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const total = AUDIT_PER_PAGE + 2;
  for (let i = 0; i < total; i++) makeConsoleAudit({ logsDir, now: () => NOW + i, alive: () => true }).append({ actor: { name: "ops", role: "operator", session: null }, action: "login", target: `row-${i}`, outcome: "ok" });
  // As serve wires it (`cli.mjs` `pageDeps.audit`): the page asks for each row's place, which the view needs.
  const deps = { audit: ({ limit, before, positions }) => readConsoleAudit({ logsDir, limit, before, positions }), now: () => NOW };
  const session = { name: "ops", role: "operator" };
  const first = parsePageQuery("audit", "").query;
  const page1 = await renderPage("audit", { query: first, session, data: await loadPageData("audit", first, deps), readOnly: false });
  // The Older link is the kit's pager (issue #737): a small button that is a link while an older page exists.
  const href = /<a class="btn btn--sm" href="\/audit\?([^"]+)">Older<\/a><\/span>/.exec(String(page1.html))?.[1];
  assert.ok(href, "the first page links to older rows");
  const parsed = parsePageQuery("audit", href.replaceAll("&amp;", "&"));
  assert.equal(parsed.refusal, undefined, String(parsed.refusal));
  const data2 = await loadPageData("audit", parsed.query, deps);
  assert.equal(data2.audit.unreadable, null, String(data2.audit.unreadable));
  // A view's rows are `{ entry, pos, state }`: the row as stored, its place in the files, and what the chain says of it.
  assert.deepEqual(data2.audit.rows.map((r) => r.entry.target), ["row-1", "row-0"], "the next page is the two oldest rows");
  assert.deepEqual(data2.audit.rows.map((r) => r.pos), ["2026-10:2", "2026-10:1"], "each at its place");
  // The last page has no older one: its Older is drawn disabled, never a link to an empty page.
  const page2 = String((await renderPage("audit", { query: parsed.query, session, data: data2, readOnly: false })).html);
  assert.doesNotMatch(page2, /href="\/audit\?[^"]*">Older</);
});

test("a run id in no history, no queue, no transcript and no progress is the run-not-found page, with the runs search holding the id", async () => {
  const { renderPage } = await import("../src/console/pages.mjs");
  // Every source's own explicit none: the record read on both sides, the whole queue lookup, the stream, the key.
  const none = { run: { missing: true }, chat: { found: false }, transcript: { exists: false, ended: false, outcome: null, length: 0 }, progress: { absent: true } };
  const ctx = (data, id = "gh-nope") => ({ query: { id }, session: { name: "a", role: "operator" }, data: { now: 0, env: {}, ...none, ...data }, readOnly: false });
  const page = await renderPage("run", ctx({}));
  assert.equal(page.status, 404);
  const html = String(page.html);
  assert.match(html, /<body data-page="error">/);
  assert.match(html, /No run with this id/);
  assert.match(html, /<form [^>]*action="\/runs"[^>]*>[^]*<input id="q" type="search" name="q" value="gh-nope"/, "the search holds the id, the person's own query");
  assert.match(html, /<a href="\/runs" aria-current="page">/, "Runs is the current screen");
  // A source that said anything but its none keeps the run page, which says what could not be read: a read that failed,
  // a record that could not be read, a queue lookup that could not be made or was not over every queue, a transcript or
  // progress read that did not answer, and a source with no reader at all.
  const kept = [
    { readFailed: true },
    { run: { unreadable: "the fleet's run mirror could not be read" } },
    { run: { record: { jobId: "gh-nope" } } },
    { chat: { unreachable: true } },
    { chat: null },
    { chat: { found: null } },
    { chat: { found: true, jobState: "waiting" } },
    { transcript: { exists: true } },
    { transcript: { unreachable: true, exists: false } },
    { transcript: undefined },
    { progress: { unreachable: true } },
    { progress: { invalid: "has a note that is not one" } },
    { progress: undefined },
    { progress: null },
  ];
  for (const data of kept) {
    const other = await renderPage("run", ctx(data));
    assert.ok(String(other.html).includes('<body data-page="run"'), JSON.stringify(data));
    assert.ok(!String(other.html).includes("No run with this id"), JSON.stringify(data));
  }
});

test("the run-not-found page is not answered while the live transcript and the progress could not be read: the run page keeps them, 503", async () => {
  const { renderPage } = await import("../src/console/pages.mjs");
  const data = { run: { missing: true }, chat: { found: false }, transcript: { unreachable: true, exists: false }, progress: { unreachable: true }, subscriptions: [] };
  const got = await renderPage("run", { query: { id: "gh-9" }, session: { name: "ops", role: "operator" }, data, readOnly: false, theme: null });
  assert.equal(got.status, 503);
  assert.ok(String(got.html).includes('<body data-page="run"'));
  assert.ok(!String(got.html).includes("No run with this id"), "a page that claims nothing was found while two reads failed");
});

test("a run with no record and no queued job but a progress snapshot is a running job's page, never the run-not-found page", async () => {
  const { renderPage } = await import("../src/console/pages.mjs");
  const progress = { v: 1, turn: 1, steps: 0, failed: 0, interrupted: 0, running: [], recent: [], phase: null, phases: [], note: null, prior: null, startedAt: 2, updatedAt: 3, ended: false, outcome: null };
  const ctx = { query: { id: "gh-live" }, session: { name: "a", role: "operator" }, data: { now: 0, env: {}, run: { missing: true }, chat: { found: false }, transcript: { exists: false }, progress }, readOnly: false };
  const page = await renderPage("run", ctx);
  assert.equal(page.status, 200);
  assert.ok(String(page.html).includes('<body data-page="run"'), "the run page");
  assert.ok(!String(page.html).includes("No run with this id"));
});

test("loadPageData hands the run-not-found rule each source's own answer: a stream answer that is not one, or a record read that throws, is unread", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const session = { name: "ops", role: "operator" };
  const base = {
    runById: async () => ({ missing: true }),
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    jobStatus: async () => ({ found: false, state: null, continuesAs: null, queuedAs: null }),
    transcriptMeta: async () => ({ exists: false, ended: false, outcome: null, length: 0, firstId: null, lastId: null }),
    progress: async () => ({ absent: true }),
    progressOfRun: async () => ({ progress: { absent: true }, continues: false, continuesAs: null }),
  };
  const page = async (fleet) => String((await renderPage("run", { query: { id: "gh-1" }, session, data: await loadPageData("run", { id: "gh-1" }, { fleet, now: () => 1 }), readOnly: false })).html);
  assert.match(await page(base), /No run with this id/, "every source read and said none");
  for (const [what, over] of [
    ["a transcript answer that is no answer", { transcriptMeta: async () => null }],
    ["a transcript answer with no exists", { transcriptMeta: async () => ({ length: 0 }) }],
    ["an invalid transcript answer", { transcriptMeta: async () => ({ invalid: "a run id is letters" }) }],
    ["a record read that throws", { runById: async () => { throw new Error("down"); } }],
    ["a mirror that could not be read", { runById: async () => ({ unreadable: "the fleet's run mirror could not be read" }) }],
    ["a queue lookup that was not whole", { jobStatus: async () => ({ found: null, state: null, continuesAs: null, queuedAs: null }) }],
    ["a progress key that could not be read", { progressOfRun: async () => ({ progress: { unreachable: "timed out" }, continues: false, continuesAs: null }) }],
  ]) {
    assert.doesNotMatch(await page({ ...base, ...over }), /No run with this id/, what);
  }
});

test("one status rule for the run page: 404 only for the run-not-found page, 503 for a page kept because a place could not be read, 200 for every run a place shows, a queued job's included (#737)", async () => {
  const { renderPage } = await import("../src/console/pages.mjs");
  const none = { run: { missing: true }, chat: { found: false, activeJobId: null, queuedJobId: null }, transcript: { exists: false, ended: false, outcome: null, length: 0 }, progress: { absent: true } };
  const snapshot = { v: 1, turn: 1, steps: 0, failed: 0, interrupted: 0, running: [], recent: [], phase: null, phases: [], note: null, prior: null, startedAt: 2, updatedAt: 3, ended: false, outcome: null };
  const statusOf = async (data) => {
    const got = await renderPage("run", { query: { id: "gh-9" }, session: { name: "ops", role: "operator" }, data: { now: 0, env: {}, ...none, ...data }, readOnly: false });
    const html = String(got.html);
    return [got.status, html.includes('<body data-page="error">') ? "not found" : html.includes('<body data-page="run"') ? "run" : "other"];
  };
  assert.deepEqual(await statusOf({}), [404, "not found"], "every place read, each saying none");
  for (const data of [
    { readFailed: true },
    { run: { unreadable: "the fleet's run mirror could not be read" } },
    { chat: { unreachable: true } },
    { chat: null },
    { chat: { found: null } },
    { transcript: { unreachable: true, exists: false } },
    { transcript: undefined },
    { progress: { unreachable: true } },
    { progress: { invalid: "has a note that is not one" } },
    { progress: null },
  ]) {
    assert.deepEqual(await statusOf(data), [503, "run"], JSON.stringify(data));
  }
  for (const data of [
    { run: { record: { jobId: "gh-9", outcome: "completed" }, source: "local" } },
    { chat: { found: true, jobState: "waiting", activeJobId: null, queuedJobId: null } },
    { chat: { found: false, jobState: null, activeJobId: "gh-9.r1", queuedJobId: null } },
    { chat: { found: false, jobState: null, activeJobId: null, queuedJobId: "gh-9.r1" } },
    { transcript: { exists: true, ended: false, outcome: null, length: 2 } },
    { progress: snapshot },
    // A place that shows the run is a run, whatever another could not read.
    { chat: { found: true, jobState: "waiting", activeJobId: null, queuedJobId: null }, transcript: { unreachable: true, exists: false } },
  ]) {
    assert.deepEqual(await statusOf(data), [200, "run"], JSON.stringify(data));
  }
});

test("a base run whose job the queue no longer holds while its recovery runs or waits is the run page, as /api/run says: the lookup's whole answer, never its found alone (#737)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const { runDocument } = await import("../src/console/run-api.mjs");
  const { readJobStatus } = await import("../src/read-model.mjs");
  for (const state of ["active", "waiting"]) {
    // The base job "gh-base" is gone; its recovery "gh-base.r1" is in the queue (readJobStatus's own walk).
    const recovery = { id: "gh-base.r1", data: { recoveryOf: "gh-base" }, getState: async () => state };
    const status = await readJobStatus({ queues: [{ name: "pi-jobs", getJob: async (id) => (id === "gh-base.r1" ? recovery : null) }], jobId: "gh-base", whole: true });
    assert.equal(status.found, false, `${state}: no queue holds the base job itself`);
    const fleet = {
      runById: async () => ({ missing: true }),
      jobStatus: async () => status,
      transcriptMeta: async () => ({ exists: false, ended: false, outcome: null, length: 0 }),
      progressOfRun: async () => ({ progress: { absent: true }, continues: false, continuesAs: null }),
      progress: async () => ({ absent: true }),
      inbox: async () => ({ found: false }),
      runsPage: async () => ({ runs: [], next: null }),
    };
    const api = await runDocument(fleet, "gh-base");
    assert.equal(api.status, undefined, `${state}: /api/run answers the run (${api.error})`);
    const data = await loadPageData("run", { id: "gh-base" }, { fleet, now: 0, env: {} }, { role: "operator", readOnly: false });
    const page = await renderPage("run", { query: { id: "gh-base" }, session: { name: "a", role: "operator" }, data, readOnly: false });
    assert.equal(page.status, 200, state);
    assert.ok(String(page.html).includes('<body data-page="run"'), `${state}: the run page`);
    assert.ok(!String(page.html).includes("No run with this id"), state);
  }
});

test("a run page kept because a place could not be read says which, for both roles: not every queue, the live transcript, the progress (#737)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const base = {
    runById: async () => ({ missing: true }),
    jobStatus: async () => ({ found: false, state: null, continuesAs: null, queuedAs: null }),
    transcriptMeta: async () => ({ exists: false }),
    progress: async () => ({ absent: true }),
    runsPage: async () => ({ runs: [], next: null, mirror: "ok" }),
  };
  const banner = (html) => (String(html).match(/<section id="p-outcome"[\s\S]*?<\/section>/)?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#39;/g, "'");
  for (const [what, over, unread] of [
    ["a queue lookup over a set that was not whole", { jobStatus: async () => ({ found: null, state: null, continuesAs: null, queuedAs: null }) }, [RUN_PLACES.queues]],
    ["a queue that could not be read", { jobStatus: async () => ({ unreachable: true }) }, [RUN_PLACES.queues]],
    ["a stream that did not answer", { transcriptMeta: async () => ({ unreachable: "timed out", exists: false, length: 0 }) }, [RUN_PLACES.transcript]],
    ["a stream answer that says both", { transcriptMeta: async () => ({ unreachable: true, exists: false }) }, [RUN_PLACES.transcript]],
    ["a progress key that could not be read", { progress: async () => ({ unreachable: "timed out" }) }, [RUN_PLACES.progress]],
    ["two at once", { jobStatus: async () => ({ found: null, state: null, continuesAs: null, queuedAs: null }), transcriptMeta: async () => { throw new Error("down"); } }, [RUN_PLACES.queues, RUN_PLACES.transcript]],
  ]) {
    for (const role of ["operator", "viewer"]) {
      const session = { name: "u", role };
      const data = await loadPageData("run", { id: "gh-none" }, { fleet: { ...base, ...over } }, session);
      const got = await renderPage("run", { query: { id: "gh-none" }, session, data, readOnly: false, theme: null });
      assert.equal(got.status, 503, `${what}, ${role}`);
      assert.ok(!String(got.html).includes("No run with this id"), `${what}, ${role}: not the run-not-found page`);
      assert.ok(banner(got.html).includes(runUntoldText(unread)), `${what}, ${role}: ${banner(got.html)}`);
    }
  }
  assert.equal(runUntoldText([RUN_PLACES.queues, RUN_PLACES.transcript]), "No record of this run is in this host's history or the fleet's run mirror, but this page could not read every queue and the live transcript, so it cannot say whether the run exists. Reload to try again.");
});

test("the run page's children carry a reason only when it is a token", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const FREE = "GET /repos/acme/secret failed \u202e";
  const parent = { jobId: "gh-p", kind: "github", target: "acme/web#1", outcome: "completed", reason: null, startedAt: "2026-10-14T11:00:00.000Z", endedAt: "2026-10-14T11:05:00.000Z" };
  const kids = [
    { jobId: "gh-c1", parentJobId: "gh-p", outcome: "failed", reason: FREE, startedAt: "2026-10-14T11:06:00.000Z", endedAt: "2026-10-14T11:07:00.000Z" },
    { jobId: "gh-c2", parentJobId: "gh-p", outcome: "failed", reason: "container-lost", startedAt: "2026-10-14T11:08:00.000Z", endedAt: "2026-10-14T11:09:00.000Z" },
  ];
  const fleet = {
    runById: async () => ({ record: parent, source: "local" }),
    runsPage: async () => ({ runs: kids, next: null, mirror: "ok" }),
    jobStatus: async () => ({ found: false, state: null, continuesAs: null, queuedAs: null }),
  };
  const data = await loadPageData("run", { id: "gh-p" }, { fleet }, { role: "operator" });
  assert.deepEqual(data.children.map((c) => c.reason), [null, "container-lost"]);
  const html = String((await renderPage("run", { query: { id: "gh-p" }, session: { name: "ops", role: "operator" }, data, readOnly: false, theme: null })).html);
  assert.ok(!html.includes("/repos/acme/secret"), "no child's free text on the page");
});

test("the Parked page reads its planner checks only for a load a form can be drawn from: an operator's, or one that does not say, on a console that takes changes (#737)", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const row = (jobId) => ({ target: "acme/web#1", kind: "github", jobId, parkedAt: 1, ageMs: 0, answered: false, chainCount: 1, project: null, pendingScan: { jobId: null } });
  const asked = [];
  // A fresh reader per load, so the checks' per-run cache never hides a read.
  const fleetOf = () => ({ snapshot: async () => ({ parked: [row("gh-1"), row("gh-2")] }), parkedAnswerCheck: async (id) => (asked.push(id), { ok: true }) });
  for (const [who, read] of [
    [{ role: "operator" }, true],
    [{ role: "operator", readOnly: false }, true],
    [{}, true],
    [undefined, true],
    [{ readOnly: false }, true],
    [{ role: "viewer" }, false],
    [{ role: "viewer", readOnly: false }, false],
    [{ role: "operator", readOnly: true }, false],
    [{ readOnly: true }, false],
  ]) {
    asked.length = 0;
    const data = await loadPageData("parked", {}, { fleet: fleetOf(), now: () => 1 }, who);
    assert.deepEqual(asked, read ? ["gh-1", "gh-2"] : [], JSON.stringify(who));
    assert.equal(Object.hasOwn(data, "parkedChecks"), read, JSON.stringify(who));
  }
});

test("renderPage answers 503 for a run no place shows while the other places were not read, and the stream's panels are the page's sections", async () => {
  const { pagePanels, renderPage } = await import("../src/console/pages.mjs");
  const ctx = { query: { id: "gh-404" }, session: { name: "a", role: "viewer" }, data: { now: 0, env: {}, run: { missing: true } }, readOnly: true };
  const page = await renderPage("run", ctx);
  assert.equal(page.status, 503);
  const html = String(page.html);
  assert.ok(html.includes(runUntoldText([RUN_PLACES.queues, RUN_PLACES.transcript, RUN_PLACES.progress]).replace(/'/g, "&#39;")), "the banner names what it did not read");
  assert.match(html, /Read-only console<\/span>/);
  assert.match(html, /<body data-page="run" data-live="run" data-query="id=gh-404">/, "the run detail is live (issue #644: its progress panel moves)");
  for (const { id, html: inner } of await pagePanels("run", ctx)) {
    const tag = SHELL_PANEL_IDS.includes(id) ? "span" : "section";
    assert.ok(html.includes(`<${tag} id="${id}" data-panel>${inner}</${tag}>`), id);
  }
});
