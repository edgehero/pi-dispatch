import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_REFUSALS, parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { ACTIONS } from "../src/console/actions.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { OVERVIEW_UNREAD_TEXT } from "../src/console/panels/overview.mjs";
import {
  PARKED_ANSWERING, PARKED_ANSWER_HINT, PARKED_CHECKS_MAX, PARKED_CHECK_SKIPPED, PARKED_CHECK_UNREAD, PARKED_ELSEWHERE_TITLE,
  PARKED_EMPTY, PARKED_HOW, PARKED_QUESTION_WHERE, parkedCheckRows, parkedQuestions, parkedUnreadText,
} from "../src/console/panels/parked.mjs";

/**
 * The Parked page's panel (issue #737, the ParkedPhone card; REQ-CONSOLE-SECURITY clause l): a card per parked run that
 * nobody has answered, for both roles, with no question text anywhere; the answer form only for an operator on a
 * console that takes changes, only where the shared verdict says reply AND the planner's own check said ok; the
 * planner's refusal in an attention banner instead; and the rows whose check the page reads. Every view is canned at a
 * fixed instant: nothing here reads a Valkey or the wall clock.
 */

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60_000;

/** A parked row as the fleet reader's snapshot carries one (`readParkedRuns` plus `pendingScan` and `project`). */
const row = (jobId, over = {}) => ({ target: `acme/web#${jobId.length}`, kind: "github", jobId, parkedAt: T0 - 26 * MIN, ageMs: 26 * MIN, answered: false, chainCount: 2, project: "web", pendingScan: { jobId: null }, ...over });

function view(role, data, { readOnly = false } = {}) {
  return { page: "parked", role, readOnly, query: {}, env: {}, now: T0, pages: PAGES, data: { now: T0, ...data } };
}
const draw = (role, snapshot, extra = {}, opts = {}) => String(parkedQuestions(view(role, { snapshot, ...extra }, opts)));
const cards = (out) => out.match(/<article class="[^"]*\bqcard[ "][^]*?<\/article>/g) ?? [];
const forms = (out) => out.match(/<form class="act[^"]*" data-action="parked-answer"[^]*?<\/form>/g) ?? [];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const OK = { ok: true };

test("the sentences, word for word: where the question is read, the banner's title, how answers work, the empty state", () => {
  assert.equal(PARKED_QUESTION_WHERE, "The question is the run's last message: read it on its issue or pull request, or on its run page while its live transcript is kept (24 hours after the run).");
  assert.equal(PARKED_ELSEWHERE_TITLE, "This question cannot be answered here");
  assert.equal(PARKED_HOW, "A parked run asked a question and ended; a reply on its issue or merge request resumes it, and an operator can answer it on the Parked page of a console that takes changes.");
  assert.equal(PARKED_EMPTY, "Nothing is parked.");
  assert.equal(PARKED_ANSWER_HINT, "Nothing is sent until you confirm. The answer resumes the run as a reply on its issue would, and is posted there as a comment.");
  assert.equal(PARKED_ANSWERING, "Being answered by the run queued or running on its target now:");
  assert.equal(PARKED_CHECK_UNREAD, "Whether this question can be answered here could not be read; the next refresh checks again.");
  assert.equal(PARKED_CHECK_SKIPPED, "Whether an answer can be built here was not checked on this page; its run page checks, and takes the answer there.");
  assert.equal(parkedUnreadText("the runs could not be read"), "The parked runs could not be read (the runs could not be read); this is not an empty inbox.");
  assert.equal(PARKED_CHECKS_MAX, 20);
  for (const s of [PARKED_QUESTION_WHERE, PARKED_ELSEWHERE_TITLE, PARKED_HOW, PARKED_EMPTY, PARKED_ANSWER_HINT, PARKED_ANSWERING, PARKED_CHECK_UNREAD, PARKED_CHECK_SKIPPED]) assert.doesNotMatch(s, /[\u2013\u2014]/);
});

test("a card per parked run for both roles: who asked, its project, its target linked to the issue, the wait, the forge and the resume count, and where the question is", () => {
  const snap = { parked: [row("gh-2f6a", { target: "acme/api#131", chainCount: 2 }), row("gh-7b21", { target: "acme/web#415", chainCount: 0, project: null, ageMs: 3 * 3_600_000 })] };
  for (const role of ["operator", "viewer"]) {
    const out = draw(role, snap, { parkedChecks: { "gh-2f6a": OK, "gh-7b21": OK } });
    const [a, b] = cards(out);
    assert.equal(cards(out).length, 2, role);
    assert.match(a, /href="\/run\?id=gh-2f6a"/, `${role}: the job links its run page`);
    assert.ok(a.includes("gh-2f6a") && a.includes("26m"), `${role}: who asked and how long it waited`);
    assert.match(a, /<span class="ptag">web<\/span>/, `${role}: the record's project`);
    assert.match(a, /<a class="link code" href="https:\/\/github\.com\/acme\/api\/issues\/131" rel="noreferrer noopener" target="_blank">acme\/api#131<\/a>/, `${role}: the target, out of the console`);
    assert.ok(a.includes("github, resumed 2 times"), `${role}: the forge and the session store's count`);
    assert.ok(b.includes("github, not resumed yet") && b.includes("3h 0m"), role);
    assert.ok(!b.includes('class="ptag"'), `${role}: no project, no tag`);
    for (const c of [a, b]) assert.ok(c.includes(esc(PARKED_QUESTION_WHERE)), `${role}: where the question is read, on every card`);
    assert.match(out, /^<nav class="tabs" aria-label="Parked"><a href="\/parked" aria-current="page">Questions<span class="count">2<\/span><\/a><\/nav><div class="cols"><div class="stack">/, `${role}: the Questions tab, its count, then the two columns`);
    assert.ok(out.endsWith(`<div class="stack"><div class="card"><div class="card__head"><h2>How answers work</h2></div><p class="muted">${esc(PARKED_HOW)}</p></div></div></div>`), `${role}: how answers work, in the side column`);
    assert.doesNotMatch(out, /Approvals/, "approvals are issue #649's");
  }
  // A count the session store cannot give is left out, never 0; one resume reads once.
  const unknown = cards(draw("viewer", { parked: [row("gh-1", { chainCount: null }), row("gh-2", { chainCount: 1 })] }));
  assert.ok(unknown[0].includes("github") && !unknown[0].includes("resumed"), unknown[0]);
  assert.ok(unknown[1].includes("github, resumed once"));
});

test("no question text on the page, for either role: a row's stray text fields are never drawn, and the run's transcript is never read", () => {
  const SECRET = "QUESTION-CANARY-8f3a should the export limit apply per key?";
  const p = { ...row("gh-2f6a"), question: SECRET, text: SECRET, message: SECRET, body: SECRET, transcript: [{ text: SECRET }] };
  for (const role of ["operator", "viewer"]) {
    for (const checks of [{ "gh-2f6a": OK }, { "gh-2f6a": { refusal: "no" } }, {}]) {
      const out = draw(role, { parked: [p] }, { parkedChecks: checks, transcript: { entries: [{ text: SECRET }] } });
      assert.ok(!out.includes("QUESTION-CANARY"), `${role} ${JSON.stringify(checks)}: no question text`);
      assert.equal(cards(out).length, 1);
    }
  }
});

test("the answer form: only for an operator on a console that takes changes, only where the verdict says reply and the planner's check said ok", () => {
  const snap = { parked: [row("gh-1"), row("gh-2"), row("gh-3"), row("gh-4"), row("gh-5")] };
  const checks = { "gh-1": OK, "gh-2": { refusal: "gh-2 parked on a pull request, whose reply must carry the trigger phrase (the receiver's rule: its key needs the head branch); answer on the forge" }, "gh-3": { unreachable: true }, "gh-4": null };
  const op = draw("operator", snap, { parkedChecks: checks });
  const [c1, c2, c3, c4, c5] = cards(op);
  assert.equal(forms(op).length, 1, "one form: the check that said ok");
  assert.equal(forms(c1).length, 1);
  assert.ok(c1.includes('name="jobId" value="gh-1"'));
  // A refusal: the attention banner with the planner's sentence whole (with its full stop; it opens with the job id,
  // which keeps its case), no form.
  assert.equal(forms(c2).length, 0);
  assert.ok(c2.includes(`<div class="banner tone-attention" role="status">`) && c2.includes(`<p class="banner__t">${PARKED_ELSEWHERE_TITLE}</p>`), c2);
  assert.ok(c2.includes(`<p class="banner__s">${esc(`${checks["gh-2"].refusal}.`)}</p>`), c2);
  assert.equal(c2.match(/answer on the forge/g)?.length, 1, "the banner adds no forge sentence of its own");
  // An unread check, a null one (no reader) and none at all: said, no form.
  assert.ok(c3.includes(PARKED_CHECK_UNREAD) && forms(c3).length === 0);
  for (const c of [c4, c5]) assert.ok(c.includes(PARKED_CHECK_SKIPPED) && forms(c).length === 0, c);
  // A viewer and a read-only console: the same cards, no form, no banner, no check sentence.
  for (const out of [draw("viewer", snap, { parkedChecks: checks }), draw("operator", snap, { parkedChecks: checks }, { readOnly: true })]) {
    assert.equal(cards(out).length, 5);
    assert.ok(!out.includes("data-action") && !out.includes("<textarea") && !out.includes("<form"), "no control");
    assert.ok(!out.includes(PARKED_ELSEWHERE_TITLE) && !out.includes(PARKED_CHECK_UNREAD) && !out.includes(PARKED_CHECK_SKIPPED));
  }
  // A check keyed by a prototype's name is no check.
  const proto = draw("operator", { parked: [row("__proto__")] }, { parkedChecks: {} });
  assert.ok(proto.includes(PARKED_CHECK_SKIPPED) && forms(proto).length === 0);
});

test("the refusal banner capitalises a sentence that opens with a word, ends it with one full stop, and trims it", () => {
  const banner = (refusal) => /<p class="banner__s">([^<]*)<\/p>/.exec(draw("operator", { parked: [row("gh-1")] }, { parkedChecks: { "gh-1": { refusal } } }))?.[1] ?? null;
  assert.equal(banner("the job's data has expired, so no answer can be built here"), esc("The job's data has expired, so no answer can be built here."));
  assert.equal(banner("No comment trigger routes a reply."), "No comment trigger routes a reply.");
  assert.equal(banner("  answer on the forge instead  "), "Answer on the forge instead.");
});

test("every verdict over the pending-answer scan, the Chat panel's own (parkedVerdictOf): being answered links that run, an unknown says why, and neither draws a form", () => {
  const scans = [
    [{ jobId: "gh-77" }, "answering"],
    [{ jobId: null }, "reply"],
    [{ unknown: true, tooMany: false }, "unknown"],
    [{ unknown: true, tooMany: true }, "tooMany"],
    [{ unreachable: true }, "unknown"],
    [null, "unknown"],
  ];
  for (const [scan, kind] of scans) {
    const out = draw("operator", { parked: [row("gh-1", { pendingScan: scan })] }, { parkedChecks: { "gh-1": OK } });
    const v = parkedVerdictOf(scan);
    const said = JSON.stringify(scan);
    assert.equal(forms(out).length, kind === "reply" ? 1 : 0, `${said}: a form only for a reply`);
    if (kind === "answering") assert.ok(out.includes(`<p class="muted">${PARKED_ANSWERING} <a class="link code" href="/run?id=gh-77">gh-77</a>.</p>`), out);
    if (kind === "unknown" || kind === "tooMany") assert.ok(out.includes(`<p class="muted">${esc(v.says)}</p>`), `${said}: the shared verdict's sentence`);
    if (kind === "tooMany") assert.equal(v.says, CHAT_REFUSALS.parkedTooMany);
    // The facts are a viewer's too: being answered and not known are what the old table's column said to both roles.
    const viewer = draw("viewer", { parked: [row("gh-1", { pendingScan: scan })] }, { parkedChecks: { "gh-1": OK } });
    if (kind === "answering") assert.ok(viewer.includes(PARKED_ANSWERING) && viewer.includes('href="/run?id=gh-77"'));
    if (kind !== "answering" && kind !== "reply") assert.ok(viewer.includes(esc(v.says)));
    assert.ok(!viewer.includes("<form"));
  }
});

test("the form's fields are the parked-answer action's own, as the script and the planner read them; one solid button per card, the answer kind", () => {
  const snap = { parked: [row("gh-1"), row("gh-2")] };
  const out = draw("operator", snap, { parkedChecks: { "gh-1": OK, "gh-2": OK } });
  const fields = ACTIONS.find((a) => a.name === "parked-answer").fields;
  assert.deepEqual([...fields], ["jobId", "text"]);
  const ids = [];
  for (const [i, form] of forms(out).entries()) {
    const names = [...form.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names.sort(), [...fields].sort(), "every named control is a field the action takes, and each field is sent");
    assert.match(form, new RegExp(`<input type="hidden" name="jobId" value="gh-${i + 1}">`));
    const area = /<textarea[^>]*>/.exec(form)?.[0] ?? "";
    assert.ok(/\sname="text"/.test(area) && /\srequired/.test(area) && /\smaxlength="8192"/.test(area), area);
    const id = /\sid="([^"]+)"/.exec(area)?.[1];
    assert.ok(form.includes(`for="${id}"`), "the textarea is labelled");
    ids.push(id);
    assert.match(form, /<button class="btn btn--answer" type="submit">/, "the answer's own button kind");
    assert.ok(form.includes(PARKED_ANSWER_HINT));
    assert.match(form, /href="\/run\?id=gh-\d"/, "and its run page");
  }
  assert.equal(new Set(ids).size, 2, "one id per answer box");
  for (const card of cards(out)) {
    assert.equal(card.match(/btn--(?:answer|primary)\b/g)?.length ?? 0, 1, "one solid button per card");
    assert.doesNotMatch(card, /btn--(?:paid|danger|primary)\b/);
  }
});

test("hostile values are text: a target, a job id and a project from a record are escaped, and an id outside the run-id charset gets no link and no form", () => {
  const evil = "acme/web\"><script>alert(2)</script>#7";
  const out = draw("operator", { parked: [row("gh-<x>", { target: evil, project: "<b>p</b>", kind: "<i>k</i>" })] }, { parkedChecks: { "gh-<x>": OK } });
  assert.ok(!out.includes("<script>") && !out.includes("<b>p</b>") && !out.includes("<i>k</i>"), out);
  assert.ok(out.includes(esc(evil)), "the target as text");
  assert.ok(!out.includes('class="ptag"'), "a project the projects file could not spell is no tag");
  assert.ok(out.includes("gh-&lt;x&gt;") && !out.includes("/run?id=gh-"), "the id as text, unlinked");
  assert.equal(forms(out).length, 0, "no form for an id the action refuses");
  // A forge kind with no link from this deployment's env: the target in the code face.
  const gitlab = draw("viewer", { parked: [row("gh-1", { kind: "gitlab", target: "g/p#3" })] });
  assert.ok(gitlab.includes('<span class="code">g/p#3</span>'), gitlab);
});

test("the list's states: unread is never empty and has no count, no snapshot says so, and nothing parked is said", () => {
  for (const role of ["operator", "viewer"]) {
    const lost = draw(role, { parked: [], parkedUnreachable: "the runs could not be read" });
    assert.ok(lost.includes(esc(parkedUnreadText("the runs could not be read"))) && lost.includes("this is not an empty inbox"), lost);
    assert.ok(!lost.includes(PARKED_EMPTY) && !lost.includes('class="count"'), `${role}: no count of a list not read`);
    const none = String(parkedQuestions(view(role, { snapshot: null })));
    assert.ok(none.includes(esc(OVERVIEW_UNREAD_TEXT)) && !none.includes(PARKED_EMPTY) && !none.includes('class="count"'), none);
    const empty = draw(role, { parked: [] });
    assert.ok(empty.includes(PARKED_EMPTY) && empty.includes('<span class="count">0</span>'), empty);
    assert.equal(cards(empty).length, 0);
  }
});

test("the rows whose planner check the page reads: the reply rows with a run id, in the snapshot's order, at most PARKED_CHECKS_MAX", () => {
  const replies = Array.from({ length: PARKED_CHECKS_MAX + 5 }, (_, i) => row(`gh-r${i}`));
  const others = [row("gh-a", { pendingScan: { jobId: "gh-77" } }), row("gh-u", { pendingScan: { unknown: true } }), row("gh <x>"), row("gh-n", { jobId: null })];
  const snap = { parked: [others[0], replies[0], others[1], others[2], ...replies.slice(1), others[3]] };
  const picked = parkedCheckRows(snap);
  assert.deepEqual(picked.map((p) => p.jobId), replies.slice(0, PARKED_CHECKS_MAX).map((p) => p.jobId));
  assert.deepEqual(parkedCheckRows(null), []);
  assert.deepEqual(parkedCheckRows({ parked: "x" }), []);
  // The page then draws a form for each row it checked ok, and leaves the rest to their run pages.
  const checks = Object.fromEntries(picked.map((p) => [p.jobId, OK]));
  const out = draw("operator", snap, { parkedChecks: checks });
  assert.equal(forms(out).length, PARKED_CHECKS_MAX);
  assert.equal(out.split(PARKED_CHECK_SKIPPED).length - 1, 5, "the reply rows past the bound");
});
