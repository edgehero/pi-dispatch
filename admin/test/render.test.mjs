import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView, renderWhatIf, commandSlashLabel } from "../src/render.mjs";

test("render.mjs has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/render.mjs", import.meta.url)), "utf8");
  // A renderer has no I/O: no fs read and no call into the log tail. (A doc comment may name `.log`;
  // what matters is that no code path reads one.)
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b|require\(|import\s+.*node:fs/.test(src),
    "renderers must never read raw log content -- that surface belongs to the overlay viewer only",
  );
});

test("renderStatus shows paused state, counts, and workers", () => {
  const out = renderStatus({
    pausedState: false,
    counts: { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 },
    workers: 1,
  });
  assert.match(out, /Queue: running/);
  assert.match(out, /waiting 2/);
  assert.match(out, /failed 3/);
  assert.match(out, /workers: 1/);
});

test("renderStatus reports paused and unreachable", () => {
  assert.match(renderStatus({ pausedState: true, counts: {}, workers: "unknown" }), /Queue: paused/);
  assert.match(renderStatus({ unreachable: "down" }), /unreachable \(down\)/);
});

test("renderRuns aligns columns with a header and a data row, including the chain marker", () => {
  const out = renderRuns([
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      chainDepth: 1,
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  assert.match(out, /JOB ID/);
  assert.match(out, /CHAIN/);
  assert.match(out, /j1/);
  assert.match(out, /o\/r#5/);
  assert.match(out, /completed/);
  assert.match(out, /\bd1\b/, "a chained child renders a d<n> depth marker");
});

test("renderRuns surfaces per-job tokens and cost, and dashes them when usage is absent", () => {
  const out = renderRuns([
    { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 }, endedAt: "2026-07-21T00:00:00.000Z" },
    { jobId: "j2", target: "o/r#6", flow: "fix", outcome: "failed", turns: null, tokens: null, endedAt: "2026-07-21T00:01:00.000Z" },
  ]);
  assert.match(out, /TOKENS/);
  assert.match(out, /COST/);
  assert.match(out, /\b5000\b/, "total tokens render for a run that reported usage");
  assert.match(out, /\$0\.0523/, "cost renders as a $-prefixed fixed-decimal");
  const noUsageRow = out.split("\n").find((l) => l.includes("j2"));
  assert.match(noUsageRow, /-/, "a run without usage dashes its token/cost cells");
});

test("renderRuns renders a fully-null record as dashes (chain column included)", () => {
  const out = renderRuns([{ jobId: null, target: null, flow: null, outcome: null, reason: null, turns: null, chainDepth: null, endedAt: null }]);
  assert.match(out, /CHAIN/);
  const dataRow = out.split("\n")[1];
  assert.match(dataRow, /^-(\s+-)+\s*$/, "a non-chain record renders '-' in the chain column");
});

test("renderRuns degrades on empty and unreachable inputs", () => {
  assert.match(renderRuns([]), /No runs/);
  assert.match(renderRuns({ unreachable: "x" }), /unreachable/);
});

test("renderBudget shows the day window's reserved count and the overlay-derived cap", () => {
  const out = renderBudget({ budget: { day: 5, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(out, /day: reserved 5 \/ cap 25 \(overlay\)/);
});

test("renderBudget marks the day cap unknown when the overlay omits dailyCap", () => {
  const out = renderBudget({ budget: { day: 0 }, settings: { path: "/s", overlay: {} } });
  assert.match(out, /day: reserved 0 \/ cap unknown/);
});

test("renderBudget shows week/month windows only when the overlay sets their cap (or they are reserving)", () => {
  const withCaps = renderBudget({
    budget: { day: 1, week: 4, month: 9 },
    settings: { path: "/s", overlay: { dailyCap: 25, weeklyCap: 100, monthlyCap: 400 } },
  });
  assert.match(withCaps, /week: reserved 4 \/ cap 100 \(overlay\)/);
  assert.match(withCaps, /month: reserved 9 \/ cap 400 \(overlay\)/);

  // No overlay week/month caps and zero reserved -> those lines are omitted (window not in play).
  const dayOnly = renderBudget({ budget: { day: 1, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.doesNotMatch(dayOnly, /week:/);
  assert.doesNotMatch(dayOnly, /month:/);

  // An env-configured window the admin cannot read the cap for still surfaces once it is reserving.
  const envWeek = renderBudget({ budget: { day: 1, week: 3, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(envWeek, /week: reserved 3 \/ cap unknown/);
});

test("renderBudget marks a window soft-hold / over via the shared windowState, and shows the band", () => {
  // day cap 10, softHoldPct 80 -> threshold 8; reserved 9 is inside the band.
  const soft = renderBudget({ budget: { day: 9 }, settings: { path: "/s", overlay: { dailyCap: 10, softHoldPct: 80 } } });
  assert.match(soft, /day: reserved 9 \/ cap 10 \(overlay\) \[soft-hold\]/);
  assert.match(soft, /soft-hold band: 80%/);

  const over = renderBudget({ budget: { day: 11 }, settings: { path: "/s", overlay: { dailyCap: 10 } } });
  assert.match(over, /\[over\]/);
});

test("renderBudget reports unreachable", () => {
  assert.match(renderBudget({ budget: { unreachable: "down" }, settings: {} }), /unreachable/);
});

test("renderTriggers lists schedulers with next + overdue drift and a label trigger line", () => {
  const out = renderTriggers({
    schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
    triggers: { triggers: [{ type: "label", any: ["pi:frontend"], all: [], none: ["wontfix"], flow: "frontend-fix" }] },
  });
  assert.match(out, /s1/);
  assert.match(out, /next 2026-07-21T00:00:00.000Z/);
  assert.match(out, /overdue by 5s/);
  assert.match(out, /label {2}any\[pi:frontend\] none\[wontfix\] → frontend-fix/);
});

test("renderTriggers renders each of the four on.types", () => {
  const out = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy" },
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix" },
        { type: "comment", phrase: "@pi", flow: "fix" },
        { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review" },
      ],
    },
  });
  assert.match(out, /cron {2}nightly {2}0 3 \* \* \* → \/srv\/p\/tidy/);
  assert.match(out, /label {2}any\[pi:frontend\] → frontend-fix/);
  assert.match(out, /comment {2}"@pi" → fix/);
  assert.match(out, /pull_request {2}action\[labeled\] any\[pi:review\] → review/);
});

test("renderTriggers renders an issue trigger: action word, and #number when narrowed (#231)", () => {
  // pull_request's line shape with the item number in the clause slot -- the plain twin of the dashboard's
  // issue row, which must state the same facts. An ARMED one-shot now carries [once] (the marker this
  // comment used to defer to a later phase); a standing rule's line is byte-identical to before.
  const out = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "issue", action: ["closed"], number: 40, once: true, flow: "deploy", forge: "github", packages: false },
        { type: "issue", action: ["close"], number: null, once: false, flow: "announce", forge: "gitlab", packages: false },
      ],
    },
  });
  assert.match(out, /issue {2}action\[closed\] #40 → deploy {2}\[once\]$/m, "a narrowed one-shot names its item and its armed state");
  assert.match(out, /issue {2}action\[close\] → announce {2}\[gitlab\]$/m, "an unnarrowed rule ends at the action, and a non-github forge is named");
});

test("the one-shot badges: [once] armed, [spent] disarmed, absent otherwise -- both close-capable kinds (#231)", () => {
  // The plain surface must state the same facts as the colored one (renderRunList's rule): an armed
  // one-shot and a spent one must never share a line shape, and a rule that is neither must render
  // byte-identically to a deployment that never heard of on.once.
  const line = (t) => renderTriggers({ schedulers: [], triggers: { triggers: [t] } });
  const armed = { type: "issue", action: ["closed"], number: 7, once: true, flow: "deploy", forge: "github", packages: false };
  const spent = { ...armed, disarmed: { at: "2026-08-20T09:00:00Z", jobId: "gh-1" } };

  assert.match(line(armed), /issue {2}action\[closed\] #7 → deploy {2}\[once\]$/m, "armed shows [once]");
  assert.doesNotMatch(line(armed), /\[spent\]/, "and never [spent]");
  assert.match(line(spent), /issue {2}action\[closed\] #7 → deploy {2}\[spent\]$/m, "spent shows [spent]");
  assert.doesNotMatch(line(spent), /\[once\]/, "and never [once] -- the states are mutually exclusive");

  // The close-only pull_request twin carries the same pair.
  const prArmed = { type: "pull_request", action: ["closed"], number: 40, once: true, any: [], all: [], none: [], flow: "archive", forge: "github", packages: false };
  assert.match(line(prArmed), /pull_request {2}action\[closed\] #40 → archive {2}\[once\]$/m);
  const prSpent = { ...prArmed, disarmed: { at: "2026-08-21T10:00:00Z" } };
  assert.match(line(prSpent), /pull_request {2}action\[closed\] #40 → archive {2}\[spent\]$/m);

  // The negative claim: a rule without the fields is byte-identical to its pre-#231 line.
  const standing = { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review", packages: false };
  assert.match(line(standing), /pull_request {2}action\[labeled\] any\[pi:review\] → review$/m);
});

test("renderTriggers shows a command trigger as /name in the flow position; flow triggers unchanged", () => {
  // The NAME only (the first space-delimited token), slash-prefixed: the slash marks "dispatches a
  // registered extension command" apart from a flow, and the args stay in the detail view so the line
  // keeps its skimmable width -- the [skills basename] doctrine restated.
  const command = { type: "comment", phrase: "@pi deploy", flow: null, command: "deploy prod --now", packages: false };
  const out = renderTriggers({ schedulers: [], triggers: { triggers: [command] } });
  assert.match(out, /comment {2}"@pi deploy" → \/deploy$/m, "name only, slash-prefixed, in the flow position");

  // A flow trigger renders byte-identically to a deployment that never heard of run.command.
  const flowLine = renderTriggers({ schedulers: [], triggers: { triggers: [{ type: "comment", phrase: "@pi", flow: "fix", packages: false }] } });
  assert.match(flowLine, /comment {2}"@pi" → fix$/m);

  // Neither flow nor command (a degraded display record) keeps the "-" placeholder.
  const neither = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...command, command: null }] } });
  assert.match(neither, /comment {2}"@pi deploy" → -$/m);
});

test("commandSlashLabel is the one /name vocabulary every surface shares (issue #188)", () => {
  // Exported so the list line here, the TUI's target column and the drill-in header cannot drift on
  // what a command trigger is called: three renderings, one token rule.
  assert.equal(commandSlashLabel({ command: "deploy prod --now" }), "/deploy");
  assert.equal(commandSlashLabel({ command: "  wf  run " }), "/wf", "surrounding whitespace never reaches the token");
  assert.equal(commandSlashLabel({ command: "" }), null);
  assert.equal(commandSlashLabel({ flow: "fix" }), null, "a flow trigger has no slash label");
  assert.equal(commandSlashLabel(null), null);
});

test("renderTriggers marks a packages-loading trigger and leaves a declining one unchanged", () => {
  const cron = (packages) => ({ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy", packages });
  // `true` is what normalizeTriggerForDisplay yields for a trigger that OMITS run.packages -- the common
  // case under the opt-out polarity, and the one that used to render bare.
  const loading = renderTriggers({ schedulers: [], triggers: { triggers: [cron(true)] } });
  assert.match(loading, /cron {2}nightly {2}0 3 \* \* \* → \/srv\/p\/tidy {2}\[packages\]/, "a loading cron line carries the marker");

  // A trigger that declined must read exactly as it did before the marker existed.
  const declined = renderTriggers({ schedulers: [], triggers: { triggers: [cron(false)] } });
  assert.doesNotMatch(declined, /\[packages\]/);

  // All four kinds carry it -- every kind loads the operator-staged packages unless it declined.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", packages: true },
        { type: "comment", phrase: "@pi", flow: "fix", packages: true },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", packages: true },
      ],
    },
  });
  assert.equal(all.split("[packages]").length - 1, 3, "label, comment and pull_request each show the marker");
});

test("renderTriggers shows a non-default image, and a default-image line is byte-identical", () => {
  const cron = (image) => ({ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy", packages: false, image });
  const named = renderTriggers({ schedulers: [], triggers: { triggers: [cron("my-python:1.2.0")] } });
  assert.match(named, /\[image my-python:1\.2\.0\]/, "which image a job runs is which code it runs, so the row says it");

  // The suffix is empty and appended last, so a deployment using no per-trigger images renders exactly as
  // it did before the feature existed.
  const plain = renderTriggers({ schedulers: [], triggers: { triggers: [cron(null)] } });
  assert.doesNotMatch(plain, /\[image/);

  // All four kinds carry it.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", image: "a:1" },
        { type: "comment", phrase: "@pi", flow: "fix", image: "b:1" },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", image: "c:1" },
      ],
    },
  });
  assert.equal(all.split("[image ").length - 1, 3, "label, comment and pull_request each show their image");
});

test("renderTriggers degrades on no schedulers and a missing triggers file", () => {
  const out = renderTriggers({ schedulers: [], triggers: { missing: true } });
  assert.match(out, /none configured/);
  assert.match(out, /triggers file not found/);
});

test("renderTriggers reports an invalid triggers file and an empty list", () => {
  assert.match(renderTriggers({ schedulers: [], triggers: { invalid: "bad" } }), /triggers file invalid: bad/);
  assert.match(renderTriggers({ schedulers: [], triggers: { triggers: [] } }), /\(no triggers\)/);
});

test("renderTriggers reports an unreachable scheduler read", () => {
  assert.match(renderTriggers({ schedulers: { unreachable: "down" }, triggers: { triggers: [] } }), /unreachable \(down\)/);
});

test("renderSettingsView lists all ten keys, unset ones marked", () => {
  const out = renderSettingsView({ path: "/s", overlay: { model: "claude", dailyCap: 5, weeklyCap: 100, softHoldPct: 80, maxTokens: 500000 } });
  assert.match(out, /Settings \(\/s\)/);
  assert.match(out, /model: claude/);
  assert.match(out, /dailyCap: 5/);
  assert.match(out, /weeklyCap: 100/);
  assert.match(out, /softHoldPct: 80/);
  assert.match(out, /maxTokens: 500000/);
  assert.match(out, /provider: \(unset\)/);
  assert.match(out, /monthlyCap: \(unset\)/);
  assert.match(out, /dailyTokenCap: \(unset\)/);
  assert.match(out, /concurrency: \(unset\)/);
});

test("renderSettingsView surfaces invalid overlays", () => {
  assert.match(renderSettingsView({ path: "/s", invalid: "dailyCap must be an integer >= 1" }), /invalid/);
});

test("a non-github forge is badged in the LIST line, and a github one renders byte-identically", () => {
  const gh = { type: "label", any: ["pi:fix"], all: [], none: [], flow: "fix", packages: false, image: null, forge: "github" };
  const gl = { ...gh, forge: "gitlab" };

  // Byte identity is the assertion, not a regex: the whole point is that an existing deployment's panel
  // does not move, and a comparison against the forge-less record proves it exactly.
  const show = (t) => renderTriggers({ schedulers: [], triggers: { triggers: [t] } });
  const { forge: _drop, ...noForge } = gh;
  assert.equal(show(gh), show(noForge), "a github trigger must render exactly as it did before the field existed");

  assert.ok(show(gl).includes("[gitlab]"), "a gitlab trigger must say so -- two forges can select the same label");
  assert.ok(!show(gh).includes("[github]"), "github is the unmarked default");
});

test("a resume-armed trigger is BADGED, and an unarmed one renders byte-identically to before", () => {
  // The failure this guards is the one 0.1.4 shipped a fix for, arriving in a new field: a trigger whose
  // jobs persist the agent's working history to disk rendering identically to one whose jobs do not --
  // no badge and no warning, quiet exactly where the risk is.
  const base = { type: "comment", phrase: "@pi", flow: "fix", packages: false, image: null, forge: "github" };
  const armed = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...base, resume: true }] } });
  assert.match(armed, /\[resume\]/);

  for (const cold of [false, undefined]) {
    const out = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...base, resume: cold }] } });
    assert.equal(out.includes("[resume]"), false, `resume ${JSON.stringify(cold)} must not badge`);
    assert.equal(out, renderTriggers({ schedulers: [], triggers: { triggers: [base] } }), "an unarmed trigger must render byte-identically to a deployment that never heard of this feature");
  }
});

test("the badge is opt-IN -- the opposite polarity to [packages], which is the bug that shipped once", () => {
  // [packages] is `=== true` on an opt-OUT field, so absent means LOADING and the badge is present.
  // [resume] is `=== true` on an opt-IN field, so absent means COLD and the badge is absent. Testing both
  // in one place is what stops the next person from "harmonising" them.
  const t = { type: "label", any: ["x"], all: [], none: [], flow: "f", forge: "github" };
  const neither = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...t, packages: undefined, resume: undefined }] } });
  assert.equal(neither.includes("[resume]"), false, "absent resume is a cold start");
  const both = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...t, packages: true, resume: true }] } });
  assert.match(both, /\[packages\]/);
  assert.match(both, /\[resume\]/);
});

test("renderRuns adds a REPLICA column, and an unreplicated run reads '-' rather than '0'", () => {
  // Derived like CHAIN, and for the same reason: `cell()` would render 0 as "0". The set size rides along
  // because `r2` alone does not say whether a sibling exists -- the two rows need not be adjacent.
  const out = renderRuns([
    { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, replica: 1, replicas: 2, endedAt: "2026-08-01T00:00:00.000Z" },
    { jobId: "j2", target: "o/r#5", flow: "fix", outcome: "completed", turns: 6, replica: 2, replicas: 2, endedAt: "2026-08-01T00:01:00.000Z" },
    { jobId: "j3", target: "o/r#6", flow: "fix", outcome: "completed", turns: 3, endedAt: "2026-08-01T00:02:00.000Z" },
  ]);
  assert.match(out, /REPLICA/);
  assert.match(out, /\br1\/2\b/);
  assert.match(out, /\br2\/2\b/);
  // The third row is the unreplicated one; a "0/..." anywhere would mean the derive leaked a falsy index.
  assert.doesNotMatch(out, /\br0\b/);
});

test("renderWhatIf shows the estimate through fmtCost, and the seeded band verbatim", () => {
  const est = renderWhatIf(
    { class: "estimated", usd: 12.5, perRun: 1.25, coverage: 0.8, excluded: 2, ratesVersion: "1.2.3" },
    { flow: "fix", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(est, /What-if fix @ anthropic\/claude-sonnet-4:/);
  assert.match(est, /~\$12\.50 est\. total · ~\$1\.25 est\. per run/);
  assert.match(est, /coverage 80% of observed runs ledgered · excluded 2 \(no ledger\)/);
  assert.match(est, /rates pi-ai 1\.2\.3/);

  const seeded = renderWhatIf(
    { class: "seeded", low: 0.5, high: 5, note: "unmeasured (OQ-002)" },
    { flow: "new-flow", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(seeded, /~~\$0\.50 seeded to ~~\$5\.00 seeded/, "both band edges keep their seeded class marker");
  assert.match(seeded, /unmeasured \(OQ-002\)/, "the fold's own note rides through verbatim");
});

test("renderTriggers marks a replicating trigger, and an unflagged line is byte-identical", () => {
  // A spend multiplier must not render like a preference -- the same class of badge as [resume], appended
  // last so every existing line is unchanged.
  const label = (replicas) => ({ type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", packages: false, replicas });
  const racing = renderTriggers({ schedulers: [], triggers: { triggers: [label(2)] } });
  assert.match(racing, /\[x2\]/);

  const plain = renderTriggers({ schedulers: [], triggers: { triggers: [label(null)] } });
  assert.doesNotMatch(plain, /\[x/);
  assert.equal(plain, renderTriggers({ schedulers: [], triggers: { triggers: [label(undefined)] } }), "absent and null render the same single-run line");

  // All three webhook kinds carry it; cron can never hold one, so it has nothing to show.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", replicas: 2 },
        { type: "comment", phrase: "@pi", flow: "fix", replicas: 3 },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", replicas: 2 },
      ],
    },
  });
  assert.equal(all.split("[x").length - 1, 3, "label, comment and pull_request each show their count");
});
