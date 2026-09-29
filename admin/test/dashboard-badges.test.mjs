import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { frame, makeStyler, stripAnsi, visibleLen } from "../src/style.mjs";

/**
 * Issue #482: the LIST trigger row's three missing badges, the RUN_DETAIL post-mortem that was clipped at
 * the drill-in's inner width, and `fitLine`'s overflow branch, which printed any over-wide line in the
 * default colour. Loaded through pi's own jiti, like `dashboard.test.mjs`, and against canned snapshots.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const AT = Date.UTC(2026, 6, 21, 12, 0, 0);

// A theme that says WHICH colour it applied, so a test can tell amber from accent from dim. The shared
// SGR_THEME of the main file paints everything one colour, which cannot see a badge in the wrong hue.
const COL = { accent: 33, warning: 208, dim: 240, muted: 245, success: 34, error: 196, text: 252, border: 238 };
const THEME = { fg: (c, t) => `\x1b[38;5;${COL[c] ?? 15}m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
const painted = (colour, text) => `\x1b[38;5;${COL[colour]}m${text}\x1b[39m`;

const BASE = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  stagedPackages: { stagedAt: null, packages: [] },
};

async function renderList(triggers, width, theme) {
  const snap = { ...BASE, triggers: { triggers } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, ...(theme ? { theme } : {}),
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
  });
  await flush();
  const lines = comp.render(width);
  await comp.dispose();
  return lines;
}

// The display record `normalizeTriggerForDisplay` builds, with the three fields under test set.
const BADGED = {
  type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false,
  skillsDir: "/home/op/skills/review-kit/", instructions: true, secrets: 2, secretsProfile: "prod",
};

test("a trigger with skillsDir, instructions and secrets shows all three badges on the LIST row (#482)", async () => {
  const lines = await renderList([BADGED], 100);
  const row = lines.map((l) => stripAnsi(l)).find((l) => l.includes("bug"));
  // The same texts as render.mjs's triggerLine: the BASENAME of the skills dir, the count and profile name.
  assert.match(row, /bug → github fix \[skills review-kit\] \[instructions\] \[secrets 2 via prod\]/);
  // No profile, no "via".
  const noProfile = (await renderList([{ ...BADGED, secretsProfile: null }], 100)).map((l) => stripAnsi(l)).join("\n");
  assert.match(noProfile, /\[secrets 2\]/);
  assert.doesNotMatch(noProfile, /\[secrets 2 via/);
});

test("the new badges take the file's colours: [secrets] amber, [skills] and [instructions] accent (#482)", async () => {
  const raw = (await renderList([BADGED], 100, THEME)).find((l) => stripAnsi(l).includes("bug"));
  assert.ok(raw.includes(painted("warning", "[secrets 2 via prod]")), "secrets is the risk badge: what the job can REACH");
  assert.ok(raw.includes(painted("accent", "[skills review-kit]")), "operator-authored skills override a default, not a risk");
  assert.ok(raw.includes(painted("accent", "[instructions]")), "operator standing text overrides a default, not a risk");
});

test("a row WITHOUT those fields renders byte-identically to before the badges existed (#482)", async () => {
  // Goldens rendered from the tree before this change (origin/main at e6d0b4e), with the read model's own
  // none-sentinels set on the three fields rather than left out, so both spellings of "absent" are covered.
  const none = { skillsDir: null, instructions: false, secrets: 0, secretsProfile: null };
  const lines = await renderList([
    { type: "label", any: ["bug"], all: [], none: [], flow: "fix", packages: true, forge: "github", image: "img:1", resume: true, replicas: 3, ...none },
    { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/r/repo", flow: "sweep", packages: false, ...none },
  ], 100, THEME);
  const rows = lines.filter((l) => /fix|sweep/.test(stripAnsi(l)));
  assert.deepEqual(rows, [
    "\u001b[38;5;238m│\u001b[39m \u001b[38;5;33m›\u001b[39m \u001b[38;5;15mlabel        \u001b[39m \u001b[38;5;34mbug\u001b[39m \u001b[38;5;240m→\u001b[39m \u001b[38;5;33mgithub\u001b[39m \u001b[1m\u001b[38;5;252mfix\u001b[39m\u001b[22m \u001b[38;5;208m[packages]\u001b[39m \u001b[38;5;33m[img:1]\u001b[39m \u001b[38;5;208m[resume]\u001b[39m \u001b[38;5;208m[x3]\u001b[39m                                \u001b[38;5;238m│\u001b[39m",
    "\u001b[38;5;238m│\u001b[39m   \u001b[38;5;33mcron         \u001b[39m \u001b[38;5;252mnightly  0 3 * * *\u001b[39m \u001b[38;5;240m→\u001b[39m \u001b[38;5;34mlocal\u001b[39m \u001b[38;5;245mrepo\u001b[39m\u001b[38;5;240m/\u001b[39m\u001b[1m\u001b[38;5;252msweep\u001b[39m\u001b[22m                                            \u001b[38;5;238m│\u001b[39m",
  ]);
});

test("a row too wide for the frame keeps every badge and clips the selector and badge text instead (#482)", async () => {
  const wide = { ...BADGED, any: ["needs-triage", "backend", "priority-high", "customer-reported", "regression"], packages: true, resume: true, replicas: 2 };
  for (const theme of [undefined, THEME]) {
    const lines = await renderList([wide], 120, theme);
    for (const l of lines) assert.equal(visibleLen(l), 120, `the frame holds: ${JSON.stringify(stripAnsi(l))}`);
    const row = stripAnsi(lines.find((l) => stripAnsi(l).includes("→ github fix")));
    assert.match(row, /…/, "the selector gave way, and says so");
    // The skills basename is free text inside its badge, so it gives way after the selector does.
    // Badge text is cut to its ellipsis before the selector's own floor, and the selector gets room back
    // first, so on a row this crowded the profile reads "…" while every badge stays.
    assert.match(row, /\[packages\] \[skills [^\]]+\] \[instructions\] \[resume\] \[x2\] \[secrets 2 via [^\]]+\] │$/, "every badge survives, the last one included");
  }
});

/** Open RUN_DETAIL on the one run, at `width`. */
async function renderRunDetail(width, theme, record = {}) {
  const run = { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", reason: null, turns: 4, endedAt: "2026-07-21T00:00:00.000Z", ...record };
  const snap = { ...BASE, runs: [run] };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, ...(theme ? { theme } : {}),
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
  });
  await flush();
  comp.handleInput("\x1b[B");
  comp.handleInput("\r");
  await flush();
  const lines = comp.render(width);
  await comp.dispose();
  return lines;
}

const POST_MORTEM = "container torn down at job end · stored PII-free fields + optional raw-log overlay only";

test("the post-mortem longer than the inner width renders in full, inside the frame, every line dimmed (#482)", async () => {
  const lines = await renderRunDetail(80, THEME);
  const at = lines.findIndex((l) => stripAnsi(l).includes("POST-MORTEM"));
  assert.ok(at > 0, "the post-mortem divider is there");
  // Everything between the divider and the footer rule is the sentence.
  const body = [];
  for (let i = at + 1; i < lines.length && !/├/.test(stripAnsi(lines[i])); i++) body.push(lines[i]);
  assert.ok(body.length >= 2, "an 86-column sentence at an inner width of 66 takes more than one line");
  // The drill-in is centred in the wider overlay, so a line is its left margin plus the 70-column frame.
  const inFrame = (l) => stripAnsi(l).trim();
  const words = (l) => inFrame(l).slice(1, -1).trim();
  const text = body.map(words).join(" ");
  assert.equal(text, POST_MORTEM, "no word lost, none clipped");
  for (const l of body) {
    assert.equal(visibleLen(inFrame(l)), 70, `within the drill-in's frame: ${JSON.stringify(stripAnsi(l))}`);
    assert.match(inFrame(l), /^│ .* │$/, "between the two borders");
    assert.ok(l.includes(painted("dim", words(l))), `every line is dimmed on its own: ${JSON.stringify(l)}`);
    assert.doesNotMatch(l, /…/, "wrapped, not clipped");
  }
});

test("fitLine's overflow keeps the line's colour, and under no theme is byte-identical to the plain clip (#482)", async () => {
  // A reason long enough to overflow the header: the outcome's green and the reason's dim must both survive.
  const reason = "the forge refused the push because the branch protection requires a signed commit on every ref";
  const lines = await renderRunDetail(80, THEME, { outcome: "failed", reason });
  const head = lines.find((l) => stripAnsi(l).includes("the forge refused"));
  assert.equal(visibleLen(stripAnsi(head).trim()), 70, "the clipped line still fits its frame");
  assert.match(stripAnsi(head).trim(), /^│ .* │$/);
  assert.match(stripAnsi(head), /…/, "it was clipped");
  assert.ok(head.includes(`\x1b[38;5;${COL.error}m`), "the outcome keeps its colour on a clipped line");
  assert.ok(head.includes(`\x1b[38;5;${COL.dim}m · the forge refused`), "the reason keeps its dim");
  assert.ok(head.includes("…\x1b[0m"), "the cut run is closed, so its colour cannot bleed into the border");

  // The helper itself: with no escape in the input it IS `cell`, for every width and a wide character.
  const s = makeStyler(null);
  for (const text of ["plain words that overflow", "中文字符串很长很长", "ab"]) {
    for (let w = 0; w <= 12; w++) {
      const cut = s.clipStyled(text, w);
      if (visibleLen(text) > w) assert.equal(cut + " ".repeat(w - visibleLen(cut)), s.cell(text, w), `${text} at ${w}`);
      else assert.equal(cut, text);
    }
  }
  // And coloured: never wider than asked, at any width.
  const t = makeStyler(THEME);
  const line = t.fg("success", "✔ completed") + t.fg("dim", " · 中文 reason text");
  for (let w = 0; w <= 30; w++) assert.ok(visibleLen(t.clipStyled(line, w)) <= w, `coloured cut at ${w}`);
  // The shape where counting run by run is NARROWER than counting the whole line: a colour code between a
  // base and the U+FE0F that makes it an emoji. `visibleLen` takes the wider answer, so must the cut.
  const split = ("x" + t.fg("warning", "\u263a") + "\ufe0f").repeat(6);
  for (let w = 0; w <= 20; w++) assert.ok(visibleLen(t.clipStyled(split, w)) <= w, `split selector cut at ${w}`);
});

test("the frame's own overflow belt keeps colour too: the same rule, not only the dashboard's site (#482)", () => {
  // `padVisible` clipped an over-wide body line through `cell` exactly as `fitLine` did, so a line that
  // reached the frame unfitted lost its colour there. Same helper now, same promise.
  const t = makeStyler(THEME);
  const [, body] = frame(t, { title: "x", width: 20, lines: [t.fg("warning", "an amber line far wider than this frame")] });
  assert.equal(visibleLen(body), 20);
  assert.ok(body.includes(`\x1b[38;5;${COL.warning}man amber line`), "the amber survives the frame's clip");
  assert.match(stripAnsi(body), /…/);
});

// --- TRIGGER_DETAIL: the full skills path, the instructions text, the secrets row (issue #482) ---

const { readTriggers, readTriggersWithInstructions } = await import("../src/read-model.mjs");

test("the panel's trigger read carries the instructions TEXT beside the view, never inside a record (#482)", () => {
  const text = "Always run the full test suite.\nNever touch the vendored directory.";
  const file = JSON.stringify({
    triggers: [
      "not an entry", // unusable, so the raw index of every usable one below is its FILE position
      { on: { type: "label", any: ["bug"] }, run: { flow: "fix", instructions: text } },
      { on: { type: "comment", phrase: "/go" }, run: { flow: "go" } },
    ],
  });
  let reads = 0;
  const fs = { readFileSync: () => { reads++; return file; } };
  const { view, instructions } = readTriggersWithInstructions({ triggersPath: "/t.json", fs });
  assert.equal(reads, 1, "one read: the text and the view describe the same file");
  assert.deepEqual(view, readTriggers({ triggersPath: "/t.json", fs }), "the view is exactly readTriggers'");
  assert.deepEqual(instructions, { 1: text }, "keyed by the raw file index, only where there is text");
  // The view is what the model-callable dispatch_triggers returns; the words must not ride it.
  assert.doesNotMatch(JSON.stringify(view), /full test suite/);
  assert.equal(view.triggers[0].instructions, true);
  // The degrade shapes pass through with an empty map.
  const missing = readTriggersWithInstructions({ triggersPath: "/x", fs: { readFileSync: () => { throw new Error("ENOENT"); } } });
  assert.deepEqual(missing, { view: { missing: true }, instructions: {} });
});

async function openDetail(trigger, triggerInstructions, theme) {
  const snap = { ...BASE, triggers: { triggers: [{ ...trigger, index: 0 }] }, triggerInstructions };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, ...(theme ? { theme } : {}),
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
  });
  await flush();
  comp.handleInput("\r");
  await flush();
  const lines = comp.render(80);
  await comp.dispose();
  return lines;
}

/** The value column of every `kv` row from `label` on, through its blank-label continuation rows. */
function kvValues(lines, label) {
  const rows = lines.map((l) => stripAnsi(l).trim().slice(1, -1));
  const at = rows.findIndex((r) => r.startsWith(` ${label.padEnd(12)} `));
  assert.ok(at >= 0, `a ${label} row`);
  const out = [rows[at].slice(14).trimEnd()];
  for (let i = at + 1; i < rows.length && rows[i].startsWith(" ".repeat(14)) && rows[i].trim() !== ""; i++) out.push(rows[i].slice(14).trimEnd());
  return out;
}

test("TRIGGER_DETAIL shows the skills dir in full, wrapping a path wider than the pane (#482)", async () => {
  // One WORD wider than the 53 columns `kv` leaves, so it exercises wrapColumns' long-word cut: a clip here
  // would show the operator a different directory while looking whole.
  const dir = "/home/operator/deployments/production/skills/review-kit-with-a-very-long-name/v2";
  const lines = await openDetail({ ...BADGED, skillsDir: dir }, {}, THEME);
  for (const l of lines) assert.equal(visibleLen(stripAnsi(l).trim()), 70, `within the frame: ${JSON.stringify(stripAnsi(l))}`);
  const parts = kvValues(lines, "skills");
  assert.ok(parts.length >= 2, "the path wraps");
  assert.equal(parts.join(""), dir, "every character of the path, none clipped");
  for (const part of parts) assert.ok(lines.some((l) => l.includes(painted("accent", part))), `accent on ${part}`);
  // Nothing on the pane is clipped, the trust model's secrets bullets included: they wrap under their indent.
  assert.doesNotMatch(stripAnsi(lines.join("\n")), /…/, "nothing on the pane was clipped");
  const rows = lines.map((l) => stripAnsi(l).trim().slice(1, -1));
  const at = rows.findIndex((r) => r.includes("resolved on the host"));
  assert.equal(`${rows[at].trim()} ${rows[at + 1].trim()}`, "· resolved on the host before the container; the job holds no vault credential");
  assert.match(rows[at + 1], /^ {3}\S/, "a continuation sits under the bullet's text, not under its dot");
});

test("TRIGGER_DETAIL shows the instructions text scrubbed and capped, and a secrets row (#482)", async () => {
  // A long word AFTER short ones: the cut must flush the words before it first, or the order changes.
  const url = "https://example.com/a/very/long/runbook/path/that/cannot/fit/on/one/line.md";
  const text = `Always run the full test suite before you push.\nNever touch vendor/.\u001b[2J See ${url} first. Keep commits small.`;
  const lines = await openDetail(BADGED, { 0: text }, THEME);
  const raw = lines.join("\n");
  for (const l of lines) assert.equal(visibleLen(stripAnsi(l).trim()), 70, `within the frame: ${JSON.stringify(stripAnsi(l))}`);
  assert.doesNotMatch(raw, /\u001b\[2J/, "an operator string is scrubbed like every other one");
  // SUBSTITUTED, not deleted, which is the panel's rule for a control byte: the ESC and the newline become
  // spaces, and what is left of the sequence is inert text.
  assert.equal(kvValues(lines, "instructions").join(" ").replace(/\s+/g, " "), `Always run the full test suite before you push. Never touch vendor/. [2J See ${url.slice(0, 53)} ${url.slice(53)} first. Keep commits small.`);
  assert.deepEqual(kvValues(lines, "secrets"), ["2 bound via profile prod"]);
  assert.ok(raw.includes(painted("warning", "2 bound via profile prod")), "secrets is the risk colour here too");

  // An SGR run in the text is the one escape the frame's own gate lets through (it keeps the styler's
  // colour), so only the scrub at each value stops the operator's strings from painting the pane. No theme
  // here, so ANY escape in the render is one the data brought.
  const painting = await openDetail({ ...BADGED, skillsDir: "/srv/\u001b[32mskills", secretsProfile: "p\u001b[33mrod" }, { 0: "x\u001b[31mRED\u001b[0m y" });
  assert.doesNotMatch(painting.join("\n"), /\u001b/, "the text cannot colour the pane");
  for (const l of painting) assert.equal(visibleLen(stripAnsi(l).trim()), 70);

  // 2000 characters cannot push the trust model off a pane with no scroll: six lines, the rest counted.
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const capped = await openDetail(BADGED, { 0: long });
  const vals = kvValues(capped, "instructions");
  assert.equal(vals.length, 7);
  assert.match(vals[6], /^… \d+ more line\(s\) in triggers\.json$/);
  assert.match(stripAnsi(capped.join("\n")), /TRUST MODEL/);

  // Unset, all three read the dim "I checked" default.
  const plain = await openDetail({ type: "label", any: ["bug"], all: [], none: [], flow: "fix", packages: false, skillsDir: null, instructions: false, secrets: 0, secretsProfile: null }, {}, THEME);
  assert.deepEqual([kvValues(plain, "skills"), kvValues(plain, "instructions"), kvValues(plain, "secrets")], [["none injected"], ["none"], ["none bound"]]);
  assert.ok(plain.join("\n").includes(painted("dim", "none bound")));
});

test("the REAL deps factory puts the text on its own snapshot key, and the trigger records stay text-free (#482)", async () => {
  const dir = tempDir("pd-482-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["bug"] }, run: { flow: "fix", instructions: "Keep commits small." } }] }));
  // The smallest Valkey the factory reads through: every count zero, no hosts, no schedulers.
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; },
    async getFailed() { return []; }, async pause() {}, async resume() {}, async close() {},
  };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {} };
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, triggersPath }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [],
  });
  const snap = await deps.fetchSnapshot();
  await deps.dispose();
  assert.deepEqual(snap.triggerInstructions, { 0: "Keep commits small." });
  assert.equal(snap.triggers.triggers[0].instructions, true);
  assert.doesNotMatch(JSON.stringify(snap.triggers), /Keep commits/, "the records the tool also returns carry no text");
});

test("an SGR run in any trigger string cannot paint the LIST row or push it past the frame (#482)", async () => {
  // The pane gate keeps SGR because the styler emits it, so a data SGR is stopped only where the record
  // enters the renderer. No theme: any escape in the render came from the data.
  const t = { ...BADGED, any: ["b\u001b[31mug"], image: "img\u001b[1m:1", flow: "f\u001b[4mix" };
  const lines = await renderList([t], 100);
  assert.doesNotMatch(lines.join("\n"), /\u001b/);
  for (const l of lines) assert.equal(visibleLen(l), 100);
});

// --- review round 1 of PR #486 ---

test("the drill-in's instructions are the OPENED trigger's, even after the file changes under it (#482)", async () => {
  const A = { type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false, instructions: false, secrets: 0, index: 0 };
  const B = { type: "label", any: ["deploy"], all: [], none: [], flow: "ship", forge: "github", packages: false, instructions: true, secrets: 0, index: 1 };
  let snap = { ...BASE, triggers: { triggers: [A, B] }, triggerInstructions: { 1: "B's standing orders" } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 20,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
  });
  await flush();
  comp.handleInput("\r"); // open A
  await flush();
  // A deleted elsewhere: B moves to raw index 0, and the next refresh carries its text there.
  snap = { ...BASE, triggers: { triggers: [{ ...B, index: 0 }] }, triggerInstructions: { 0: "B's standing orders" } };
  await new Promise((resolve) => setTimeout(resolve, 80));
  const out = stripAnsi(comp.render(100).join("\n"));
  await comp.dispose();
  assert.match(out, /any of\s+bug/, "still A's pane");
  assert.doesNotMatch(out, /standing orders/, "never B's words under A's header");
  assert.match(out, /instructions\s+none/);
});

/** The review's shapes: every badge, a 34-column image ref, a long profile, two different rules. */
const IMG = "ghcr.io/org/" + "x".repeat(20) + ":1";
const heavy = (label, flow) => ({ type: "label", any: [label], all: [], none: [], flow, forge: "github", packages: true, image: IMG, resume: true, secrets: 3, secretsProfile: "production", skillsDir: "/a/review-kit", instructions: true });

/**
 * The width below which a row's FLOOR (cursor, kind, the selector's first columns or the cron id, the
 * target with its flow) plus its risk badges at their minimum cannot fit, and only the plain clip is left.
 * The spec states the same formula: 4 of frame, 16 of cursor and kind, the floor selector and its space,
 * the target, and each risk badge with its free text at the ellipsis.
 */
function floorWidth(t, { overdue = false } = {}) {
  const match = t.type === "cron" ? `${t.id}  ${t.pattern}` : (t.any ?? []).join(" ");
  const want = t.type === "cron" ? t.id.length + 1 : 5;
  const sel = Math.min(match.length, want);
  const target = t.type === "cron" ? `→ local ${t.folder.split("/").filter(Boolean).pop()}/${t.flow}` : `→ ${t.forge ?? "github"} ${t.flow}`;
  let risk = 0;
  if (t.packages === true) risk += " [packages]".length;
  if (t.resume === true) risk += " [resume]".length;
  if (t.replicas > 1) risk += ` [x${t.replicas}]`.length;
  if (t.secrets > 0) risk += ` [secrets ${t.secrets}${t.secretsProfile ? " via …" : ""}]`.length;
  if (overdue) risk += " ⚠ overdue".length;
  return 4 + 16 + sel + 1 + target.length + risk;
}

test("an overflowing row keeps its floor and its risk badges at every width the formula allows (#482)", async () => {
  const pair = [heavy("bug", "fix-alpha"), heavy("feature", "deploy-prod")];
  for (let w = 60; w <= 200; w += 2) {
    for (const theme of [undefined, THEME]) {
      const lines = await renderList(pair, w, theme);
      for (const l of lines) assert.equal(visibleLen(l), w, `the frame holds at ${w}`);
      const rows = ["fix-alpha", "deploy-prod"].map((f) => stripAnsi(lines.find((l) => stripAnsi(l).includes(`→ github ${f}`)) ?? ""));
      assert.ok(rows.every(Boolean), `the target and its flow are the floor, at every width (${w})`);
      pair.forEach((t, i) => {
        if (w < floorWidth(t)) return;
        assert.match(rows[i], /\[packages\] .*\[resume\] \[secrets 3 via [^\]]+\]/, `every risk badge survives at ${w}: ${rows[i]}`);
        assert.match(rows[i], i === 0 ? /label +bug →/ : /label +feat\S* →/, `the selector's floor survives at ${w}: ${rows[i]}`);
      });
      // A cut is never wasted: a row that clipped something is not also padded with blanks.
      for (const r of rows) if (/…/.test(r)) assert.match(r, /\S │$/, `no slack beside a clip at ${w}: ${r}`);
    }
  }
});

test("rules that differ ONLY in their selector, or only in their cron id, never render as one row (#482)", async () => {
  const labels = [heavy("bug", "fix"), heavy("regression", "fix")];
  const crons = ["nightly-a", "nightly-b"].map((id) => ({ type: "cron", id, pattern: "0 3 * * *", folder: "/r/repo", flow: "sweep", packages: true, image: IMG, resume: true, secrets: 2, secretsProfile: "production", skillsDir: "/a/review-kit" }));
  let checked = 0;
  for (const pair of [labels, crons]) {
    const floor = Math.max(...pair.map((t) => floorWidth(t)));
    for (let w = 60; w <= 200; w++) {
      const lines = (await renderList(pair, w)).map((l) => stripAnsi(l)).filter((l) => /→ (github fix|local repo\/sweep)/.test(l));
      assert.equal(lines.length, 2);
      if (w < floor) continue;
      checked++;
      assert.notEqual(lines[0].slice(2), lines[1].slice(2), `two rules, two rows at ${w}:\n${lines.join("\n")}`);
      for (const l of lines) assert.match(l, /\[packages\] .*\[resume\] \[secrets \d via [^\]]+\]/, `risk badges at ${w}: ${l}`);
    }
  }
  assert.ok(checked > 200, "most of the sweep is at or above the floor");
});

test("the room given back goes to the risk badge's text before an image ref's (#482)", async () => {
  // At some width the profile and the image ref both have been cut: the profile must never be the
  // shorter of the two while the image ref shows more than its ellipsis.
  let compared = 0;
  for (let w = 90; w <= 170; w++) {
    const row = stripAnsi((await renderList([heavy("bug", "fix")], w)).find((l) => stripAnsi(l).includes("→ github fix")));
    const prof = /\[secrets 3 via ([^\]]*)\]/.exec(row)?.[1];
    const img = /\[(ghcr[^\]]*)\]/.exec(row)?.[1];
    if (prof === undefined || img === undefined || img === "…") continue;
    compared++;
    assert.equal(prof, "production", `the profile is whole before the image ref grows at ${w}: ${row}`);
  }
  assert.ok(compared > 0);
});

test("the health badge survives an overflowing cron row as well (#482)", async () => {
  const cron = { type: "cron", id: "s1", pattern: "0 3 * * *", folder: "/r/repo", flow: "sweep", packages: true, image: IMG, resume: true, secrets: 2, secretsProfile: "production", skillsDir: "/a/review-kit" };
  for (let w = floorWidth(cron, { overdue: true }); w <= 162; w += 2) {
    const snap = { ...BASE, triggers: { triggers: [cron] }, schedulers: [{ key: "s1", next: AT + 1000, overdueMs: 5000 }] };
    const comp = makeDashboard({
      paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
      deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
    });
    await flush();
    const row = stripAnsi(comp.render(w).find((l) => stripAnsi(l).includes("sweep")));
    await comp.dispose();
    assert.match(row, /s1…? .*\[secrets 2[^\]]*\] ⚠ overdue +│$/, `health, secrets and the cron id all survive at ${w}: ${row}`);
    // A profile cut below the ellipsis's own width shows the ellipsis, never a bare first letter.
    assert.doesNotMatch(row, /via [a-z]\]/, `no one-letter profile at ${w}: ${row}`);
  }
});

test("every trigger renderer scrubs, the unframed degrade and render.mjs's own lines included (#482)", async () => {
  const { renderTriggers } = await import("../src/render.mjs");
  const t = { type: "comment", phrase: "\u001b[41mfix it", flow: "f\u001b[4mix", forge: "github", packages: false, image: "i\u001b[1mmg", secrets: 1, secretsProfile: "p\u001b[7m", skillsDir: "/s/\u001b[2mk", instructions: false, index: 0 };
  assert.doesNotMatch(renderTriggers({ triggers: { triggers: [t] } }), /\u001b/, "the model-visible and degraded line");
  for (const w of [undefined, NaN]) {
    const lines = await renderList([t], w);
    assert.ok(lines.some((l) => /fix it/.test(l)), `the degrade at ${w} renders the row`);
    assert.doesNotMatch(lines.join("\n"), /\u001b/, `no data escape in the degrade at ${w}`);
  }
});

test("clipStyled never leaves a joiner in front of its ellipsis, even across a colour code (#482)", () => {
  const t = makeStyler(THEME);
  // The first run FITS and ends in a joiner; the cut lands at the very start of the next run.
  const line = t.fg("accent", "a‍") + t.fg("warning", "bcdef");
  const cut = t.clipStyled(line, 2);
  assert.ok(!cut.includes("‍"), JSON.stringify(cut));
  assert.match(stripAnsi(cut), /^a…$/);
});

test("the drill-in reads the instructions at the trigger's RAW file index, not its row position (#482)", async () => {
  // Raw indices 1, 3, 4: an unusable entry at 0 and 2 is how a display row and a file index come apart.
  const tr = (i) => ({ type: "label", any: [`l${i}`], all: [], none: [], flow: "f", packages: false, instructions: i !== 4, secrets: 0, index: i });
  const snap = { ...BASE, triggers: { triggers: [tr(1), tr(3), tr(4)] }, triggerInstructions: { 1: "TEXT-FOR-ONE", 3: "TEXT-FOR-THREE" } };
  const want = ["TEXT-FOR-ONE", "TEXT-FOR-THREE", "none"];
  for (const downs of [0, 1, 2]) {
    const comp = makeDashboard({
      paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
      deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT },
    });
    await flush();
    for (let d = 0; d < downs; d++) comp.handleInput("\x1b[B");
    comp.handleInput("\r");
    await flush();
    const lines = comp.render(80);
    await comp.dispose();
    assert.deepEqual(kvValues(lines, "instructions"), [want[downs]], `row ${downs}`);
  }
});

test("ONE bound secret is badged and rowed like any other count (#482)", async () => {
  const one = { ...BADGED, secrets: 1, secretsProfile: null };
  const row = (await renderList([one], 100)).map((l) => stripAnsi(l)).join("\n");
  assert.match(row, /\[secrets 1\]/);
  assert.deepEqual(kvValues(await openDetail(one, {}), "secrets"), ["1 bound"]);
});

test("a long word breaks between graphemes, never inside a joined emoji (#482)", async () => {
  // 51 columns of path, then a family emoji (one grapheme, a ZWJ sequence): the man fits the 53-column
  // budget and the woman does not, so a cut by columns alone lands between them, on the joiner.
  const fam = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
  const dir = "/" + "a".repeat(50) + fam + "b".repeat(20);
  const lines = await openDetail({ ...BADGED, skillsDir: dir }, {});
  const parts = kvValues(lines, "skills");
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.doesNotMatch(part, /^\u200d|\u200d$/, `no line starts or ends on a joiner: ${JSON.stringify(part)}`);
  assert.equal(parts.join(""), dir, "the whole path, the emoji intact");
});

test("both surfaces badge the same skills basename, win32 paths and bare roots included (#482)", async () => {
  const { renderTriggers } = await import("../src/render.mjs");
  for (const [dir, base] of [["C:\\ops\\skills\\kit", "kit"], ["/srv/skills/kit/", "kit"], ["/", "-"]]) {
    const t = { type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false, skillsDir: dir, instructions: false, secrets: 0 };
    assert.match(renderTriggers({ triggers: { triggers: [t] } }), new RegExp(`\\[skills ${base}\\]`), `render.mjs for ${dir}`);
    assert.match((await renderList([t], 100)).map((l) => stripAnsi(l)).join("\n"), new RegExp(`\\[skills ${base}\\]`), `the LIST row for ${dir}`);
  }
});

test("the selector takes back the room a dropped badge frees, before the badges' own text does (#482)", async () => {
  // A long selector and ONE badge with free text: once the image badge is dropped, only the selector can
  // use what it freed, so any blank beside a clipped selector is a cut nobody needed.
  const t = { type: "label", any: ["needs-triage", "backend", "priority-high", "customer-reported"], all: [], none: [], flow: "fix", forge: "github", packages: true, image: IMG, resume: true, secrets: 2, secretsProfile: null, instructions: false };
  let dropped = 0;
  for (let w = 70; w <= 140; w++) {
    const row = stripAnsi((await renderList([t], w)).find((l) => stripAnsi(l).includes("→ github fix")));
    if (!row.includes("[ghcr")) dropped++;
    if (/…/.test(row)) assert.match(row, /\S │$/, `no slack beside a clip at ${w}: ${row}`);
  }
  assert.ok(dropped > 0, "some width drops the image badge, which is the case under test");
});
