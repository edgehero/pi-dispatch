import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConfirmTickets } from "../src/console/confirm.mjs";

// The console's diff-bound confirm tickets (issue #640), on an injected clock.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}
function counter(start = 1) {
  let n = start;
  return (size) => Buffer.alloc(size, n++);
}
function preview(over = {}) {
  return {
    sessionId: "s1",
    action: "pause-windows",
    target: "pause-windows.json",
    payload: { windows: [] },
    expect: [{ path: "/p.json", text: "{}" }],
    beforeDigest: "b".repeat(64),
    afterDigest: "a".repeat(64),
    ...over,
  };
}

test("issue returns only a random ticket and when it expires, and redeem gives back exactly what was stored", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter() });
  const issued = t.issue(preview());
  const { ticket } = issued;
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  // Issue #737: the expiry the preview bar counts down to, on the store's own clock; nothing else of the change.
  assert.deepEqual(issued, { ticket, expiresAt: T0 + 300000 });
  const { entry } = t.redeem({ sessionId: "s1", ticket, action: "pause-windows" });
  assert.deepEqual(entry, { ...preview(), reserve: null, targets: null, count: null, meta: null, issuedAt: T0, expiresAt: T0 + 300000 });
  // The banner's meta (issue #737) rides the ticket like the payload: the browser never sends it back.
  const meta = { title: "Replace the pause windows", undo: "Put the previous pause windows back", inverse: { action: "pause-windows", body: { windows: [] } }, danger: false };
  const withMeta = t.issue(preview({ meta }));
  assert.deepEqual(t.redeem({ sessionId: "s1", ticket: withMeta.ticket, action: "pause-windows" }).entry.meta, meta);
  assert.equal(makeConfirmTickets({ now, ttlMs: 1000 }).issue(preview()).expiresAt, T0 + 1000, "the expiry follows ttlMs");
  const paid = t.issue(preview({ reserve: { micros: 5 } }));
  assert.deepEqual(t.redeem({ sessionId: "s1", ticket: paid.ticket, action: "pause-windows" }).entry.reserve, { micros: 5 });
  // Issue #642: a bulk action's job list rides the ticket too, so the confirm acts on exactly the previewed jobs.
  const bulk = t.issue(preview({ targets: [{ jobId: "j1", attemptsMade: 1, finishedOn: 5 }] }));
  assert.deepEqual(t.redeem({ sessionId: "s1", ticket: bulk.ticket, action: "pause-windows" }).entry.targets, [{ jobId: "j1", attemptsMade: 1, finishedOn: 5 }]);
  // A resume's waiting-job count rides it too, for the audit row.
  const resume = t.issue(preview({ count: 3 }));
  assert.equal(t.redeem({ sessionId: "s1", ticket: resume.ticket, action: "pause-windows" }).entry.count, 3);
  assert.match(makeConfirmTickets().issue(preview()).ticket, /^[A-Za-z0-9_-]{43}$/);
});

test("a ticket is single use: the second redeem is refused", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.ok(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).entry);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used, has expired, or was never issued/);
});

test("an unknown or non-string ticket is refused", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  t.issue(preview());
  assert.match(t.redeem({ sessionId: "s1", ticket: "nope", action: "pause-windows" }).refusal, /never issued/);
  assert.match(t.redeem({ sessionId: "s1", ticket: undefined, action: "pause-windows" }).refusal, /never issued/);
  assert.match(t.redeem({ sessionId: "s1", ticket: { toString: () => "x" }, action: "pause-windows" }).refusal, /never issued/);
  assert.equal(t.size(), 1, "a refused unknown ticket touches no other");
});

test("a ticket expires after ttlMs, and is gone after the refused attempt", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter(), ttlMs: 1000 });
  const a = t.issue(preview());
  const b = t.issue(preview());
  now.advance(999);
  assert.ok(t.redeem({ sessionId: "s1", ticket: a.ticket, action: "pause-windows" }).entry);
  now.advance(1);
  assert.match(t.redeem({ sessionId: "s1", ticket: b.ticket, action: "pause-windows" }).refusal, /has expired/);
  assert.equal(t.size(), 0);
});

test("another session's ticket is refused, and the attempt burns it for its owner too", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.match(t.redeem({ sessionId: "s2", ticket, action: "pause-windows" }).refusal, /belongs to another sign-in/);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used/);
});

test("a ticket for another action is refused and burned, so it cannot be probed", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "scoped-limits" }).refusal, /issued for another action/);
  assert.match(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).refusal, /already used/);
});

test("past max live tickets the oldest is dropped, and expired ones go first", () => {
  const now = clock();
  const t = makeConfirmTickets({ now, random: counter(), max: 3, ttlMs: 1000 });
  const issued = [0, 1, 2, 3].map(() => t.issue(preview()).ticket);
  assert.equal(t.size(), 3);
  assert.match(t.redeem({ sessionId: "s1", ticket: issued[0], action: "pause-windows" }).refusal, /never issued/);
  assert.ok(t.redeem({ sessionId: "s1", ticket: issued[1], action: "pause-windows" }).entry);
  assert.ok(t.redeem({ sessionId: "s1", ticket: issued[3], action: "pause-windows" }).entry);

  now.advance(1000);
  const fresh = [0, 1, 2].map(() => t.issue(preview()).ticket);
  assert.equal(t.size(), 3, "the expired one was swept rather than a live one dropped");
  for (const ticket of fresh) assert.ok(t.redeem({ sessionId: "s1", ticket, action: "pause-windows" }).entry);
});

test("refusals never quote the ticket", () => {
  const t = makeConfirmTickets({ now: clock(), random: counter() });
  const { ticket } = t.issue(preview());
  const r = t.redeem({ sessionId: "s2", ticket, action: "pause-windows" });
  assert.ok(!r.refusal.includes(ticket));
});

// ---- the confirm slot's markup (issue #737, confirm-view.mjs) ------------------------------------------------------

test("every state the slot can show is drawn from CONFIRM_CLASSES and the kit's classes alone, and every listed class is drawn", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  const long = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  const states = [
    v.confirmSlotHtml(),
    v.confirmSlotHtml({ open: true, inner: v.unchangedBarHtml({ summary: ["no change: the file already says this"] }) }),
    v.previewBarHtml({ title: "Retry", lines: ["a"], reserve: "It holds 1 job slot.", diff: v.textHtml("x"), undo: "u", confirmLabel: "Retry for up to $2.00", paid: true, expiresAt: 300000, now: 0 }),
    v.previewBarHtml({ title: "Pause", danger: true, undo: "Resume the fleet" }),
    v.previewBarHtml({ title: "Set", diff: v.diffHtmlOf("{\"a\":1}", "{\"a\":2}", { file: "/x/settings.json" }) }),
    v.diffHtmlOf(long, long.replace(/line (\d+)/g, "other $1")),
    v.diffHtmlOf(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 30 }, (_, i) => (i === 15 ? "changed" : `l${i}`)).join("\n")),
    ...Object.keys(v.REFUSAL_STATES).map((state) => v.refusalHtml({ where: "confirm", sentence: "s", status: 409, state })),
    v.bulkResultsHtml({ kind: "failed-retry-all", results: [{ jobId: "a", ok: true }, { jobId: "b", ok: false, reason: "r" }], count: 2, done: 1, auditSeq: 1 }),
    v.doneBannerHtml({ summary: "s", by: "b", auditSeq: 3, undo: "u", inverse: { action: "fleet-resume", body: {} } }),
    v.heldNoteHtml(),
  ].map(String);
  // The kit's classes, and `undo`, the Undo form's hook (a hook, not a style, so not in the styled list).
  const KIT = /^(?:btn(?:--[a-z-]+)?|banner(?:--sm|__t|__s|__act)?|tile|ic(?:--sm)?|tone-[a-z]+|chip|link|code|undo)$/;
  const drawn = new Set(states.flatMap((h) => [...h.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/))).filter((c) => !KIT.test(c)));
  assert.deepEqual([...drawn].sort(), [...v.CONFIRM_CLASSES].sort());
  for (const h of states) assert.doesNotMatch(h, /[\u0000-\u0008\u000b-\u001f\u007f]|\sstyle=|\son[a-z]+=|<script/i, "no control byte, inline style, handler or script");
});

test("refusalHtml derives its state from where and the status, adds the clause only when the sentence lacks it, and refuses a state it does not know", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  const title = (h) => /<p class="banner__t">([^<]*)<\/p>/.exec(String(h))[1].replace(/&#39;/g, "'");
  assert.equal(title(v.refusalHtml({ where: "confirm", status: 409, sentence: "this confirmation has expired. Preview the change again and confirm the new preview" })), "This confirmation cannot be used");
  assert.equal(title(v.refusalHtml({ where: "confirm", status: 409, sentence: "the file changed after this change was built from it" })), "The change did not go through");
  assert.equal(title(v.refusalHtml({ where: "confirm", status: 503, sentence: "x" })), "The deployment's Valkey could not be reached");
  assert.equal(title(v.refusalHtml({ where: "confirm", status: 500, sentence: "the audit log could not be written, so nothing was changed" })), "The audit log could not be written");
  assert.equal(title(v.refusalHtml({ where: "confirm", status: 500, sentence: "the x change could not be made" })), "The change could not be made");
  assert.equal(title(v.refusalHtml({ where: "preview", status: 400, sentence: "x" })), "The change was refused");
  assert.equal(title(v.refusalHtml({ where: "preview", status: 503, sentence: "x" })), "The deployment's Valkey could not be reached");
  assert.equal(title(v.refusalHtml({ where: "preview", status: 500, sentence: "x" })), "The preview failed");
  const body = (h) => /<p class="banner__s">([^]*?)<\/p>/.exec(String(h))[1];
  assert.equal(body(v.refusalHtml({ where: "preview", status: 400, sentence: "flow must be non-empty" })), "Flow must be non-empty. Nothing was changed.");
  for (const said of ["shorten it. Nothing was sent", "nothing was written", "no failed job matches; nothing to do", "nothing was applied. Preview again"]) {
    assert.ok(!body(v.refusalHtml({ where: "preview", status: 400, sentence: said })).includes("Nothing was changed."), said);
  }
  assert.throws(() => v.refusalHtml({ where: "preview", status: 400, sentence: "x", state: "nope" }), RangeError);
  assert.throws(() => v.previewBarHtml({ title: "x", paid: true, danger: true }), RangeError, "paid or destructive, never both");
  assert.deepEqual([0, 999, 1000, 59999, 60000, 300000, -5, Number.NaN].map(v.countdownText), ["0:00", "0:00", "0:01", "0:59", "1:00", "5:00", "0:00", "0:00"]);
});

// Issue #737: the one refusal state that never says "Nothing was changed".
test("a partial refusal says some of it may have been done and offers Look again, never nothing was changed; the others still add it", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  const body = (h) => /<p class="banner__s">([^]*?)<\/p>/.exec(String(h))[1];
  const part = String(v.refusalHtml({ where: "confirm", status: 409, sentence: "the kill switch did not reach every queue", state: "partial" }));
  assert.equal(body(part), `The kill switch did not reach every queue. ${v.PARTIAL_NOTE}`);
  assert.equal(v.PARTIAL_NOTE, "Some of it may have been done, so this page may be out of date.");
  assert.ok(!/nothing was changed/i.test(part) && part.includes('<p class="banner__t">The change did not finish</p>') && part.includes('<button class="btn btn--sm" type="button" data-reload>Look again</button>'), part);
  assert.match(part, /^<div class="banner banner--sm tone-attention" role="status">/);
  // Even a sentence of its own that ends "nothing was done" gets the note, never the clause.
  assert.ok(!body(v.refusalHtml({ where: "confirm", status: 500, sentence: "x", state: "partial" })).includes("Nothing"));
  // Every other state still adds it where the sentence lacks it: they all come before anything was written.
  for (const state of Object.keys(v.REFUSAL_STATES).filter((s) => s !== "partial")) {
    assert.ok(body(v.refusalHtml({ where: "confirm", status: 409, sentence: "x", state })).endsWith(" Nothing was changed."), state);
    assert.ok(!v.REFUSAL_STATES[state].mayHaveChanged, state);
  }
  assert.equal(v.REFUSAL_STATES.partial.mayHaveChanged, true);
  // A caller's own markup of its sentence is drawn in place of the text, with the clause decided on the text.
  const { html } = await import("../src/console/html.mjs");
  const named = String(v.refusalHtml({ where: "preview", status: 400, sentence: "x takes a only; b is not one of them, so nothing was changed", sentenceHtml: html`<span class="code">x</span> takes a only; b is not one of them, so nothing was changed.` }));
  assert.equal(body(named), '<span class="code">x</span> takes a only; b is not one of them, so nothing was changed.');
});

// Issue #737: the Undo line is one run after its icon; the no-change bar says why in a sentence.
test("the bar's Undo line: one inline run, the act alone in bold, or a muted No undo; the no-change sentence capitalised with its full stop", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  const { html } = await import("../src/console/html.mjs");
  const line = (h) => /<p class="confirm__undo">([^]*?)<\/p>/.exec(String(h))[1];
  const icon = '<svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"></use></svg>';
  assert.equal(line(v.previewBarHtml({ title: "Pause", danger: true, undo: "Resume the fleet" })), `${icon}<span>Undo: <b>Resume the fleet</b></span>`);
  assert.equal(line(v.previewBarHtml({ title: "Cancel", danger: true, undo: "A cancelled run stays cancelled.", undoable: false })), `${icon}<span>No undo: A cancelled run stays cancelled.</span>`);
  assert.ok(!String(v.previewBarHtml({ title: "x" })).includes("confirm__undo"), "no Undo, no line");
  // A line may carry markup (a change's values in bold); a string is escaped as ever.
  const bar = String(v.previewBarHtml({ title: "Set", lines: [html`maxTurns: <b>30</b> to <b>40</b>`, "<i>"] }));
  assert.ok(bar.includes("<li>maxTurns: <b>30</b> to <b>40</b></li><li>&lt;i&gt;</li>"), bar);
  const note = (h) => /<p class="confirm__note">([^]*?)<\/p>/.exec(String(h))[1];
  assert.equal(note(v.unchangedBarHtml({ summary: ["the file already says this"] })), "The file already says this.");
  assert.equal(note(v.unchangedBarHtml({ summary: ["pi-jobs is already paused"] })), "Pi-jobs is already paused.");
  assert.equal(note(v.unchangedBarHtml({ summary: ["x"], sentenceHtml: html`The file already says this: <span class="code">maxTurns</span> is 40.` })), 'The file already says this: <span class="code">maxTurns</span> is 40.');
});

// Issue #737: what the slot says while a write's 401 is asked about: the script embeds it, so it is held word for word.
test("the signed-out slot sentence says nothing was changed and that the console is being asked", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  assert.equal(v.CONFIRM_SIGNED_OUT, "This session ended before the change was sent, so nothing was changed. The console is asked where it went.");
});

// Issue #737: the banner after a write and the bulk results bar.
test("the done banner: attention while fewer jobs landed than it listed, a muted No undo without an inverse, and its rows counted from the first, never a range", async () => {
  const v = await import("../src/console/confirm-view.mjs");
  const body = (h) => /<p class="banner__s">([^]*?)<\/p>/.exec(String(h))[1];
  const { UNDO_SENTENCES } = await import("../src/console/actions.mjs");
  const base = { summary: "Retried 3 failed jobs", by: "alice", auditSeq: 41, auditLast: 45, count: 3, done: 3, undo: UNDO_SENTENCES.retried, inverse: null };
  const all = String(v.doneBannerHtml(base));
  assert.match(all, /^<div class="banner tone-ok" role="status">/);
  // A retry's Undo: the job it retried keeps its attempts, so it is no job `cancel-queued` takes (issue #737).
  assert.equal(body(all), 'Changed by alice. <a class="link" href="/audit?seq=41#seq-41">3 audit rows, from row 41</a>. No undo: A retried job keeps the attempts it made, so the console does not remove it from its queue; once it runs, Cancel stops it.');
  assert.ok(!all.includes("41 to 45") && !all.includes("<b>Undo"), "never a range another writer's row can sit inside");
  assert.match(String(v.doneBannerHtml({ ...base, summary: "Retried failed jobs: 2 of 3 done", done: 2 })), /^<div class="banner tone-attention" role="status">/);
  const one = String(v.doneBannerHtml({ ...base, count: 1, done: 1, auditLast: 41, undo: "Resume the fleet", inverse: { action: "fleet-resume", body: {} } }));
  // The Undo is the banner's last sentence: it ends with a full stop, as the CardsAndBanners card's does, and one that
  // already has one keeps exactly one.
  assert.equal(body(one), 'Changed by alice. <a class="link" href="/audit?seq=41#seq-41">Audit row 41</a>. <b>Undo:</b> Resume the fleet.');
  assert.match(one, /^<div class="banner tone-ok"/);
  assert.ok(body(v.doneBannerHtml({ ...base, undo: "Put it back.", inverse: { action: "fleet-resume", body: {} } })).endsWith("<b>Undo:</b> Put it back."), "never two");
  assert.ok(body(v.doneBannerHtml({ ...base, undo: "Do it by hand" })).endsWith(" No undo: Do it by hand."), "No undo's sentence too");
  // A re-run's Undo, decided at the confirm: a form for the queued job's cancel, by its id and queue, which previews it.
  const rerun = String(v.doneBannerHtml({ summary: "Queued a re-run of cron:t0:1", by: "alice", auditSeq: 44, count: 1, done: 1, undo: "Cancel cron:t0:2 before it starts", inverse: { action: "cancel-queued", body: { jobId: "cron:t0:2", queue: "pi-jobs@build3" } } }));
  assert.equal(body(rerun), 'Changed by alice. <a class="link" href="/audit?seq=44#seq-44">Audit row 44</a>. <b>Undo:</b> Cancel cron:t0:2 before it starts.');
  assert.ok(rerun.includes('<form data-action="cancel-queued" class="undo" autocomplete="off"><input type="hidden" name="jobId" value="cron:t0:2"><input type="hidden" name="queue" value="pi-jobs@build3"><button class="btn btn--sm btn--ghost" type="submit">Undo</button></form>'), rerun);
  const results = (count, done) => String(v.bulkResultsHtml({ kind: "failed-retry-all", results: Array.from({ length: count }, (_, i) => ({ jobId: `j${i}`, ok: i < done })), count, done, auditSeq: 5 }));
  assert.ok(results(3, 3).includes('>3 audit rows, from row 5</a>.</p>') && results(1, 1).includes(">Audit row 5</a>.</p>"), results(1, 1));
  assert.ok(!results(1, 1).includes("5 to 5"));
});
