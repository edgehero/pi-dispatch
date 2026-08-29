import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";

/**
 * The live dashboard overlay. `makeDashboard` takes one injection seam -- `deps` (fetchSnapshot + the
 * pause/resume/dispose actions) -- so every test here runs fully offline against a canned snapshot and
 * spies, never opening a Redis connection. Loaded through pi's own jiti (the production extension loader),
 * since the component is authored in erasable TS.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const dashboardPath = fileURLToPath(new URL("../src/dashboard.ts", import.meta.url));
const { makeDashboard, targetUrl } = await jiti.import(dashboardPath);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeTui = () => ({ requestRender() {} });

const SNAPSHOT = {
  queue: { pausedState: true, counts: { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 }, workers: 1 },
  budget: { day: 5, week: 0, month: 0 },
  settings: { path: "/s", overlay: { model: "claude-x", dailyCap: 25 } },
  runs: [
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 },
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ],
  schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
};

function cannedDeps(overrides = {}) {
  return {
    fetchSnapshot: async () => SNAPSHOT,
    pause: async () => {},
    resume: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

test("renders every section from the last snapshot, reusing the command renderers", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  // The colored LIST layout (rendered plain here — no theme passed, so PLAIN_THEME, no ANSI).
  assert.match(out, /PAUSED/, "the status header shows the paused state");
  assert.match(out, /2 waiting/, "counts line");
  assert.match(out, /1 workers/, "worker count");
  assert.match(out, /5\/25/, "the day spend meter shows reserved/cap");
  assert.match(out, /j1/, "last runs");
  assert.match(out, /model claude-x/, "settings summary");
  assert.match(out, /p\/r pause/, "key hints (the merged pause\/resume pair, issue #54)");
  assert.match(out, /q quit/, "key hints");
});

test("the footer advertises i insights unclipped at 80; c/g are inert; i resolves with the openInsights action", async () => {
  // The consolidation pins (issue #181): the analytics views left the terminal for the page, so the
  // footer names the one door, the old entry keys do nothing, and `i` resolves the overlay with the
  // done-action index.ts turns into a write-and-open between overlays (the addTrigger route).
  let resolved = "unset";
  const comp = makeDashboard({ paths: {}, done: (r) => { resolved = r; }, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();

  const footer = comp.render(80).map(stripAnsi).find((l) => l.includes("q quit"));
  assert.ok(footer, "the LIST footer renders");
  assert.match(footer, /i insights/, "the insights key is advertised");
  assert.doesNotMatch(footer, /c costs|g graph/, "the removed views' keys are not");
  assert.ok(!footer.includes("…"), "the width-80 footer fits with no ellipsis glyph");

  for (const key of ["c", "g"]) {
    comp.handleInput(key);
    await flush();
    assert.match(stripAnsi(comp.render(80).join("\n")), /pi-dispatch/, `${key} stays on the LIST -- inert, not a hidden view`);
  }

  comp.handleInput("i");
  await flush();
  assert.deepEqual(resolved, { action: "openInsights" }, "i closes the overlay carrying the action");
});

test("the LIST shows a PAUSE WINDOWS section and marks an active window with a resume countdown", async () => {
  const snap = { ...SNAPSHOT, pauseWindows: { windows: [{ scope: "acme/web", from: "00:00", to: "23:59", tz: "UTC", fromMin: 0, toMin: 1439 }] } };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const out = comp.render(90).join("\n");
  await comp.dispose();
  assert.match(out, /PAUSE WINDOWS/, "the pause-windows section renders");
  assert.match(out, /acme\/web/, "the window's scope");
  assert.match(out, /resumes in/, "an all-day window is active now -> resume countdown");
});

test("with a theme, the framed LIST is colored (ANSI present) but every line still fits the width", async () => {
  // A theme whose fg/bold emit real SGR, so the overlay is colored and the width stays ANSI-aware.
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: cannedDeps() });
  await flush();
  const lines = comp.render(80);
  await comp.dispose();

  assert.ok(lines.some((l) => l.includes("\x1b[")), "the overlay applies ANSI color");
  for (const l of lines) {
    assert.equal(visibleLen(l), 80, `every framed line is exactly 80 visible cols: ${JSON.stringify(stripAnsi(l))}`);
  }
  assert.match(stripAnsi(lines.join("\n")), /PAUSED/, "plain content survives under the color");
});

test("paths.asciiGlyphs threads into the overlay styler: the frame degrades with the panel, together", async () => {
  // PI_DISPATCH_ASCII used to flip panel.mjs' table but not the overlay's own frame glyphs -- the
  // half-ASCII gap the old dashboard comment deferred. The opt-in is per styler instance on purpose
  // (setGlyphs must not restyle overlays behind a styler's back), so the thread is paths -> makeStyler.
  const comp = makeDashboard({ paths: { asciiGlyphs: true }, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const ascii = comp.render(80);
  await comp.dispose();
  assert.ok(ascii[0].startsWith("+"), "ascii corners frame the overlay");
  const joined = ascii.join("\n");
  assert.ok(!joined.includes("┌") && !joined.includes("│") && !joined.includes("├"), "no frame box-drawing glyph leaks through the ascii overlay");

  const comp2 = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const box = comp2.render(80);
  await comp2.dispose();
  assert.ok(box[0].startsWith("┌"), "no opt-in keeps the box-drawing default, byte-identically");
});

test("before the first fetch resolves it renders a loading panel, not a crash", () => {
  // A fetch that never resolves: the panel must still render (from the null snapshot) synchronously.
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: () => new Promise(() => {}) }),
  });
  const out = comp.render(80).join("\n");
  comp.dispose();
  assert.match(out, /loading/);
  assert.match(out, /\[p\]ause/);
});

test("a throwing fetch degrades the whole panel to one unreachable line", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        throw new Error("down");
      },
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(out, /unreachable \(down\)/);
});

test("p pauses and r resumes on the held queue, each refreshing the snapshot", async () => {
  let paused = 0;
  let resumed = 0;
  let fetches = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        fetches++;
        return SNAPSHOT;
      },
      pause: async () => {
        paused++;
      },
      resume: async () => {
        resumed++;
      },
    }),
  });
  await flush();
  const afterInit = fetches;

  comp.handleInput("p");
  await flush();
  assert.equal(paused, 1, "p paused the held queue");
  assert.ok(fetches > afterInit, "pause refreshes the snapshot immediately");

  comp.handleInput("r");
  await flush();
  assert.equal(resumed, 1, "r resumed the held queue");

  await comp.dispose();
});

test("q and escape close the overlay and its held clients", async () => {
  for (const key of ["q", "\x1b"]) {
    let closed = 0;
    let disposed = 0;
    const comp = makeDashboard({
      paths: {},
      done: () => {
        closed++;
      },
      tui: fakeTui(),
      intervalMs: 100000,
      deps: cannedDeps({
        dispose: async () => {
          disposed++;
        },
      }),
    });
    await flush();
    comp.handleInput(key);
    await flush();
    assert.equal(closed, 1, `${JSON.stringify(key)} closes the overlay`);
    assert.equal(disposed, 1, `${JSON.stringify(key)} closes the held clients`);
  }
});

test("dispose clears the interval so no fetch fires afterward, and closes the held clients once", async () => {
  let fetches = 0;
  let disposed = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 10,
    deps: cannedDeps({
      fetchSnapshot: async () => {
        fetches++;
        return SNAPSHOT;
      },
      dispose: async () => {
        disposed++;
      },
    }),
  });
  await delay(35);
  const before = fetches;
  assert.ok(before >= 1, "the live panel polls while open");

  await comp.dispose();
  await delay(35);

  assert.equal(fetches, before, "no fetch fires after dispose -- the interval is cleared");
  assert.equal(disposed, 1, "the held clients are closed exactly once");

  await comp.dispose();
  assert.equal(disposed, 1, "dispose is idempotent");
});

test("dashboard.ts has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)), "utf8");
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b/.test(src),
    "the dashboard renders records/counts/settings only -- raw .log bytes belong to the logs viewer alone",
  );
});

test("frames to a sane width and degrades to unframed plain lines at a tiny width", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const framed = comp.render(80);
  const tiny = comp.render(4).join("\n");
  await comp.dispose();

  assert.match(framed.join("\n"), /[┌┐└┘│─]/, "a sane width draws a box frame");
  assert.ok(framed.every((l) => l.length <= 80), "no framed line exceeds the requested width");
  assert.doesNotMatch(tiny, /[┌┐└┘│─]/, "below MIN_WIDTH the panel drops the frame rather than emitting a ragged box");
});

test("the spend meter shows a filled bar against a known cap, and (cap unknown) with no bar otherwise", async () => {
  const known = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  const knownOut = known.render(80).join("\n");
  await known.dispose();

  const unknown = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    // Overlay carries no dailyCap, so the true cap is unknown to this process: no bar, no denominator.
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, settings: { path: "/s", overlay: { model: "m" } } }) }),
  });
  await flush();
  const unknownOut = unknown.render(80).join("\n");
  await unknown.dispose();

  assert.match(knownOut, /5\/25/, "reserved/cap label against the overlay cap");
  assert.match(knownOut, /[█]/, "a filled block glyph fills the bar");
  assert.match(unknownOut, /cap unknown/, "an unknown cap renders as text");
  assert.doesNotMatch(unknownOut, /[█]/, "no bar is drawn against an unknown denominator");
});

test("the spend panel shows the soft-hold state (amber-as-text) when a window is in the band", async () => {
  // day cap 10, softHoldPct 80 -> threshold 8; reserved 9 is in-band, week/month set so all three meter.
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({
        ...SNAPSHOT,
        budget: { day: 9, week: 1, month: 1 },
        settings: { path: "/s", overlay: { dailyCap: 10, weeklyCap: 50, monthlyCap: 200, softHoldPct: 80 } },
      }),
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /9\/10/, "the day meter shows reserved/cap");
  assert.match(out, /· soft-hold/, "the day meter carries the soft-hold marker");
  assert.match(out, /soft-hold band: 80%/, "the configured band is shown");
  assert.match(out, /1\/50/, "the week window is listed once its cap is set");
});

test("the TRIGGERS section unifies the label allowlist with the schedulers block", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({
        ...SNAPSHOT,
        triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix" }] },
      }),
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /TRIGGERS/, "the triggers section divider");
  assert.match(out, /bug → github fix/, "the label trigger row: match → target flow");
});

test("an issue trigger renders a list row: [action] #number → forge flow (#231)", async () => {
  // The colored twin of render.mjs's issue line: same facts, this file's [action]-first idiom. The
  // number is the row's only match clause, so a narrowed rule must show it -- a one-shot on issue #40
  // that renders like "every close" hides exactly what the operator armed.
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({
        ...SNAPSHOT,
        triggers: { triggers: [{ type: "issue", action: ["closed"], number: 40, once: true, flow: "deploy", forge: "github", packages: false }] },
      }),
    }),
  });
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /issue\s+\[closed\] #40 → github deploy/, "the issue row: kind badge, action, item number, forge target");
});

// --- staged packages (REQ-GLOBAL-PI-OVERLAY): which triggers load the operator's third-party code ---

/** A one-trigger snapshot: `packages` is the trigger's normalized flag, `staged` the overlay's manifest read. */
const pkgSnap = (packages, staged = { stagedAt: null, packages: [] }) => ({
  ...SNAPSHOT,
  runs: [],
  activeJobId: null,
  triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix", packages }] },
  stagedPackages: staged,
});

const openTrigger = async (snap) => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const list = stripAnsi(comp.render(80).join("\n"));
  comp.handleInput("\r"); // row 0 is the trigger -- triggers lead the rows list
  await flush();
  const detail = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  return { list, detail };
};

test("the LIST badges a packages-loading trigger, and leaves a declining one unmarked", async () => {
  // `true` is what a trigger that OMITS run.packages normalizes to -- the opt-out default, and the case that
  // used to render bare.
  const loading = await openTrigger(pkgSnap(true, { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2"] }));
  assert.match(loading.list, /bug → github fix \[packages\]/, "a loading trigger row says it loads staged packages");

  const plain = await openTrigger(pkgSnap(false));
  assert.doesNotMatch(plain.list, /\[packages\]/, "a trigger that declined third-party code is unmarked");
});

test("the packages badge is colored post-layout: the badged row still measures exactly `inner` cols", async () => {
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const snap = pkgSnap(true, { stagedAt: null, packages: ["pi-web-search@1.4.2"] });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  const lines = comp.render(80);
  await comp.dispose();
  assert.match(stripAnsi(lines.join("\n")), /\[packages\]/, "the badge survives under the color");
  for (const l of lines) {
    assert.equal(visibleLen(l), 80, `every framed line is exactly 80 visible cols: ${JSON.stringify(stripAnsi(l))}`);
  }
});

test("TRIGGER_DETAIL's trust model names the staged packages and warns, unless the trigger declined", async () => {
  const loading = await openTrigger(pkgSnap(true, { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2", "pi-jira@0.9.0"] }));
  assert.match(loading.detail, /TRUST MODEL/, "the packages lines join the per-kind trust model");
  assert.match(loading.detail, /collaborator's label/, "the static per-kind trust model still renders");
  assert.match(loading.detail, /packages loaded · pi-web-search@1\.4\.2 · pi-jira@0\.9\.0/, "the staged names+versions");
  assert.match(loading.detail, /third-party code on adversarial input, open network egress/, "the one-line consequence");

  const plain = await openTrigger(pkgSnap(false, { stagedAt: null, packages: ["pi-web-search@1.4.2"] }));
  assert.match(plain.detail, /TRUST MODEL/);
  assert.doesNotMatch(plain.detail, /packages loaded/, "a declining trigger loads none of them, staged or not");
  assert.doesNotMatch(plain.detail, /open network egress/);
});

test("TRIGGER_DETAIL says so when a trigger loads packages but the overlay stages nothing", async () => {
  const { detail } = await openTrigger(pkgSnap(true, { stagedAt: null, packages: [] }));
  assert.match(detail, /packages loaded · \(none staged in the overlay\)/, "loading with nothing staged is stated, not blank");
});

// --- one-shot badges + the close trust model (issue #231) ---

/** A one-trigger snapshot for the close-capable kinds; `t` is the display record under test. */
const shotSnap = (t) => ({
  ...SNAPSHOT,
  runs: [],
  activeJobId: null,
  triggers: { triggers: [t] },
  stagedPackages: { stagedAt: null, packages: [] },
});

test("the LIST badges a one-shot: [once] armed, [spent] disarmed, absent otherwise -- both close-capable kinds", async () => {
  // The colored twin of render.mjs's badge pair, this file's colour doctrine: [once] accent (it
  // narrows spend -- an override, not a risk), [spent] dim (a rule that finished its job).
  const armed = { type: "issue", action: ["closed"], number: 40, once: true, flow: "deploy", forge: "github", packages: false };
  const a = await openTrigger(shotSnap(armed));
  assert.match(a.list, /\[closed\] #40 → github deploy \[once\]/, "an armed one-shot row says so");
  assert.doesNotMatch(a.list, /\[spent\]/);

  const spent = { ...armed, once: true, disarmed: { at: "2026-08-20T09:00:00Z", jobId: "gh-77" } };
  const s = await openTrigger(shotSnap(spent));
  assert.match(s.list, /\[closed\] #40 → github deploy \[spent\]/, "a spent one-shot row says so");
  assert.doesNotMatch(s.list, /\[once\]/, "the states are mutually exclusive");

  // The close-only pull_request twin carries the same pair.
  const pr = { type: "pull_request", action: ["closed"], number: 7, once: true, any: [], all: [], none: [], flow: "archive", forge: "github", packages: false };
  const p = await openTrigger(shotSnap(pr));
  assert.match(p.list, /\[closed\] #7 → github archive \[once\]/);

  // The negative claim: a standing close rule (no once, no disarmed) renders no badge at all.
  const standing = { type: "issue", action: ["closed"], number: null, once: false, flow: "announce", forge: "github", packages: false };
  const n = await openTrigger(shotSnap(standing));
  assert.doesNotMatch(n.list, /\[once\]|\[spent\]/, "no one-shot fields, no badge -- the row is byte-identical to before");
});

test("TRIGGER_DETAIL's trust model names the CLOSER gate and the worker's disarm on close-capable rules", async () => {
  // The gate is the CLOSER's resolved write access, never author_association (GitHub sends none for
  // a close), and the disarm is the WORKER's write after the run record -- stated where an operator
  // is already reading who authorizes what.
  const armed = { type: "issue", action: ["closed"], number: 40, once: true, flow: "deploy", forge: "github", packages: false };
  const a = await openTrigger(shotSnap(armed));
  assert.match(a.detail, /CLOSER's resolved repository permission/, "the github close gate names the closer");
  assert.doesNotMatch(a.detail, /collaborator's label/, "the label line would name a gate this rule never runs");
  // The width-80 frame clips the bullet's tail (the trust lines are written for a real terminal's
  // width, like the gitlab access-level line above them) -- the visible prefix is the claim.
  assert.match(a.detail, /one-shot: the WORKER writes on\.disarmed into triggers\.json/);
  assert.match(a.detail, /one-shot\s+armed/, "the MATCHES section states the armed state");

  const spent = { ...armed, disarmed: { at: "2026-08-20T09:00:00Z", jobId: "gh-77" } };
  const s = await openTrigger(shotSnap(spent));
  assert.match(s.detail, /one-shot\s+spent 2026-08-20T09:00:00Z by gh-77/, "the spent state carries its provenance");

  // A close-only gitlab MR rule keeps its own forge lines and gains the disarm bullet.
  const gl = { type: "pull_request", action: ["close"], number: 7, once: true, any: [], all: [], none: [], flow: "archive", forge: "gitlab", packages: false };
  const g = await openTrigger(shotSnap(gl));
  assert.match(g.detail, /resolved project access level/, "the gitlab arm already reads the actor -- the closer, on a close delivery");
  assert.match(g.detail, /one-shot: the WORKER writes on\.disarmed/);

  // The negative claim: a non-close PR rule keeps the label trust model, and no disarm bullet appears.
  const labeled = { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review", forge: "github", packages: false };
  const l = await openTrigger(shotSnap(labeled));
  assert.match(l.detail, /collaborator's label/, "the non-close trust model is unchanged");
  assert.doesNotMatch(l.detail, /WORKER writes on\.disarmed/, "no one-shot, no disarm line");
});

// --- the per-trigger job image (issue #41): which image a job runs is which code it runs ---

const imgSnap = (image) => ({
  ...SNAPSHOT,
  runs: [],
  activeJobId: null,
  triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix", packages: false, image }] },
  stagedPackages: { stagedAt: null, packages: [] },
});

test("the LIST badges a non-default image, and a default-image row is byte-identical", async () => {
  const named = await openTrigger(imgSnap("my-python:1.2.0"));
  assert.match(named.list, /bug → github fix \[my-python:1\.2\.0\]/, "the row names the image, not merely that there is one");

  // Appended last with an empty suffix, so a deployment using no per-trigger images renders exactly as it
  // did before the feature existed -- the whole framed panel, byte for byte.
  const plain = await openTrigger(imgSnap(null));
  assert.doesNotMatch(plain.list, /\[my-python/);
  assert.equal(plain.list, await openTrigger(imgSnap(undefined)).then((r) => r.list), "no image and an absent image render identically");
});

test("TRIGGER_DETAIL states the image on BOTH branches -- a dim default means 'I checked', not 'I don't know'", async () => {
  const named = await openTrigger(imgSnap("my-python:1.2.0"));
  assert.match(named.detail, /image\s+my-python:1\.2\.0/);

  const plain = await openTrigger(imgSnap(null));
  assert.match(plain.detail, /image\s+deployment default/, "an omitted row would read as unknown; this reads as checked");
});

test("Enter on a run opens its detail dump, and Esc backs out to the list without quitting", async () => {
  let closed = 0;
  const comp = makeDashboard({
    paths: {},
    done: () => {
      closed++;
    },
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps(),
  });
  await flush();

  comp.handleInput("\x1b[B");
  comp.handleInput("\r");
  await flush();
  const detail = comp.render(80).join("\n");
  assert.match(detail, /run j1/, "the detail view titles on the selected run");
  assert.match(detail, /completed/, "the grouped post-mortem shows the colored outcome");
  assert.match(detail, /timing/, "the post-mortem groups the timing");
  assert.match(detail, /chain[\s\S]*root/, "the chain line marks a root run");
  assert.match(detail, /tokens\s+5000/, "the drill-in surfaces total tokens");
  assert.match(detail, /\$0\.0523/, "the drill-in surfaces cost as $-prefixed USD");
  assert.match(detail, /POST-MORTEM/, "the post-mortem divider is present");

  comp.handleInput("\x1b");
  await flush();
  const back = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(back, /p\/r pause/, "Esc returns to the interactive list");
  assert.equal(closed, 0, "Esc from a sub-view never closes the overlay");
});

test("RUN_DETAIL breaks out the subagent token share, and shows nothing for a pre-metering record", async () => {
  const openRun = async (tokens) => {
    const comp = makeDashboard({
      paths: {},
      done() {},
      tui: fakeTui(),
      intervalMs: 100000,
      deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, runs: [{ ...SNAPSHOT.runs[0], tokens }] }) }),
    });
    await flush();
    comp.handleInput("\r"); // row 0 is the only run
    await flush();
    const out = stripAnsi(comp.render(80).join("\n"));
    await comp.dispose();
    return out;
  };

  const metered = await openRun({ input: 4000, output: 1000, total: 5000, cost: 0.0523, otherTotal: 1200 });
  assert.match(metered, /tokens\s+5000/, "the existing tokens line is unchanged");
  assert.match(metered, /of which\s+subagents: 1200/, "the process-wide meter's subagent share");

  // A record written before the runner metered process-wide has no `otherTotal` at all: no line, and
  // certainly no NaN or a misleading bare 0.
  const preMetering = await openRun({ input: 4000, output: 1000, total: 5000, cost: 0.0523 });
  assert.match(preMetering, /tokens\s+5000/);
  assert.doesNotMatch(preMetering, /subagents/, "an older record renders nothing extra");
  assert.doesNotMatch(preMetering, /NaN/);

  // A metered run that spawned no subagent reports 0 -- also nothing, rather than a noise line.
  assert.doesNotMatch(await openRun({ total: 5000, cost: 0.01, otherTotal: 0 }), /subagents/);
  assert.doesNotMatch(await openRun(null), /subagents|NaN/, "a run with no usage at all still renders");
});

test("Enter on a cron trigger opens a detail with next/health/stalls from the scheduler", async () => {
  const snap = {
    queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
    budget: { day: 0, week: 0, month: 0 },
    settings: { path: "/s", overlay: {} },
    triggers: { triggers: [{ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv", flow: "tidy" }] },
    schedulers: [{ key: "nightly", pattern: "0 3 * * *", next: Date.UTC(2030, 0, 1, 3, 0, 0), overdueMs: null }],
    schedulerStalls: { nightly: "1" },
    schedulerStallMax: 2,
    runs: [],
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  comp.handleInput("\r"); // row 0 is the cron trigger (triggers lead the rows list)
  await flush();
  const d = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(d, /trigger · cron/, "titles on the cron trigger");
  assert.match(d, /healthy/, "shows a health marker when the scheduler is not overdue");
  assert.match(d, /2030-01-01 03:00/, "formats the scheduler's real next-fire timestamp");
  assert.match(d, /stalls 1\/2/, "surfaces the stall count against the threshold");
});

test("Enter on the ACTIVE row tails its live log inside the overlay", async () => {
  const calls = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: (args) => {
        calls.push(args);
        return { lines: ["HELLO_TAIL"] };
      },
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /HELLO_TAIL/, "the captured tail line renders in the overlay");
  assert.match(out, /live jA/, "the tail view titles on the id-only active job");
  assert.match(out, /\[\d+\/\d+\]/, "a windowed footer counts the tail");
  assert.equal(calls[0].jobId, "jA", "the tail is keyed by the id-only active job id");
});

test("the live tail reports a missing captured log by job id", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: () => ({ missing: true }),
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /no captured log \(PI_CAPTURE_JOB_LOGS/, "a missing log degrades to a captured-off notice");
});

test("the live tail reports unavailable when no tail capability is injected", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    // No tailLog capability in deps: the view degrades rather than reaching for a .log surface.
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }) }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();

  assert.match(out, /unavailable/, "an absent tail capability renders as unavailable in this build");
});

test("the live tail opens at the bottom in follow mode; scrolling up pauses, the bottom re-arms", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: () => ({ lines: Array.from({ length: 50 }, (_, i) => "L" + i) }),
    }),
  });
  await flush();

  comp.handleInput("\r");
  await flush();
  await flush();
  const opened = comp.render(80).join("\n");
  // The newest lines are what the view is opened for: the first frame is pinned to the bottom, and the
  // footer names the state so a paused tail can never masquerade as a live one.
  assert.match(opened, /\[50\/50\] follow/, "the tail opens pinned to the bottom, following");
  assert.match(opened, /L49/, "the newest line is on screen at open");

  comp.handleInput("\x1b[5~"); // PageUp pauses follow at the scrolled window
  await flush();
  const paused = comp.render(80).join("\n");
  assert.match(paused, /\[30\/50\] paused/, "PageUp scrolls a viewport back and pauses following");

  comp.handleInput("\x1b[6~"); // PageDown back to the bottom re-arms follow
  await flush();
  const rearmed = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(rearmed, /\[50\/50\] follow/, "reaching the bottom re-arms follow mode");
});

test("'l' in the list jumps straight to the live tail of the active job, and is inert without one", async () => {
  const calls = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }),
      tailLog: (args) => {
        calls.push(args);
        return { lines: ["HELLO_TAIL"] };
      },
    }),
  });
  await flush();

  comp.handleInput("l");
  await flush();
  await flush();
  const out = comp.render(80).join("\n");
  await comp.dispose();
  assert.match(out, /live jA/, "the advertised logs key opens the tail without arrowing to the ACTIVE row");
  assert.equal(calls[0].jobId, "jA", "the tail is keyed by the id-only active job id");

  // Without an active job the key is inert: there is no log to open, and no view change happens.
  const idle = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  idle.handleInput("l");
  await flush();
  const still = idle.render(80).join("\n");
  await idle.dispose();
  assert.match(still, /pi-dispatch/, "the list frame is still up");
  assert.doesNotMatch(still, /live /, "no tail view opened without an active job");
});

// --- CRUD signaling: overlay keys close with an action the command loop drives via ctx.ui dialogs ---

const triggerSnap = (triggers) => ({ ...SNAPSHOT, runs: [], activeJobId: null, triggers: { triggers } });

test("pressing 'a' in the list signals an addTrigger action", async () => {
  const actions = [];
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  comp.handleInput("a");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "addTrigger" }]);
});

test("pressing 's' in the list signals an editSettings action", async () => {
  const actions = [];
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  comp.handleInput("s");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "editSettings" }]);
});

test("Enter on a trigger opens TRIGGER_DETAIL (trust model); e/x signal edit/delete with the file index", async () => {
  const actions = [];
  const snap = triggerSnap([{ type: "label", any: ["bug"], all: [], none: [], flow: "fix" }]);
  const comp = makeDashboard({ paths: {}, done: (v) => actions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();

  comp.handleInput("\r"); // selected 0 is the trigger -> TRIGGER_DETAIL
  await flush();
  const detail = stripAnsi(comp.render(80).join("\n"));
  assert.match(detail, /TRUST MODEL/, "the drill-in shows the per-kind trust model");
  assert.match(detail, /collaborator's label/, "the label trust model text");

  comp.handleInput("e");
  await flush();
  await flush();
  assert.deepEqual(actions, [{ action: "editTrigger", index: 0 }], "e signals editTrigger with the file index");
});

test("x in TRIGGER_DETAIL arms an in-frame y/n; y signals a pre-confirmed delete, n stands down", async () => {
  const snap = triggerSnap([{ type: "cron", id: "n", pattern: "0 3 * * *", folder: "/p", flow: "tidy" }]);
  // y path: the overlay's own footer asked the question, so the action carries `confirmed` and the
  // command loop must not ask it again.
  const delActions = [];
  const c1 = makeDashboard({ paths: {}, done: (v) => delActions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  c1.handleInput("\r");
  await flush();
  c1.handleInput("x");
  await flush();
  assert.deepEqual(delActions, [], "x alone deletes nothing -- it only arms the question");
  assert.match(stripAnsi(c1.render(80).join("\n")), /delete this trigger\?/, "the footer becomes the y/n question");
  c1.handleInput("y");
  await flush();
  await flush();
  assert.deepEqual(delActions, [{ action: "deleteTrigger", index: 0, confirmed: true }]);

  // n path: stands down to the ordinary detail footer, still in TRIGGER_DETAIL, no action signaled.
  const nActions = [];
  const c2 = makeDashboard({ paths: {}, done: (v) => nActions.push(v), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  c2.handleInput("\r");
  await flush();
  c2.handleInput("x");
  await flush();
  c2.handleInput("n");
  await flush();
  const detail = stripAnsi(c2.render(80).join("\n"));
  assert.deepEqual(nActions, [], "a declined delete signals no CRUD action");
  assert.match(detail, /x delete/, "the ordinary footer is back");
  assert.match(detail, /TRUST MODEL/i, "still in the trigger detail, not popped to the list");

  // esc path: no action, back to LIST (unchanged from before the confirm existed)
  c2.handleInput("\x1b");
  await flush();
  assert.deepEqual(nActions, [], "Esc from the trigger detail signals no CRUD action");
  await c2.dispose();
});

/** The rendered LIST and TRIGGER_DETAIL for one trigger, stripped of colour. */
async function renderTrigger(trigger) {
  const comp = makeDashboard({ paths: {}, done: () => {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => triggerSnap([trigger]) }) });
  await flush();
  const list = stripAnsi(comp.render(100).join("\n"));
  comp.handleInput("\r");
  await flush();
  return { list, detail: stripAnsi(comp.render(100).join("\n")) };
}

test("a command trigger's target and drill-in show /name, and the full staged line lives in the detail", async () => {
  // Before this, both surfaces rendered a bare "-" for a command trigger, as if it targeted nothing
  // (issue #188's display half). The /name comes from render.mjs's one exported vocabulary.
  const { list, detail } = await renderTrigger({ type: "comment", forge: "github", phrase: "@pi deploy", flow: null, command: "deploy prod --now", packages: false, image: null, skillsDir: null, instructions: false, resume: false, replicas: null });
  assert.ok(list.includes("/deploy"), "the target column shows the slash name, not '-'");
  assert.equal(list.includes("deploy prod --now"), false, "the args stay out of the list row");
  assert.ok(detail.includes("→ /deploy"), "the drill-in header names the command the way it names a flow");
  assert.ok(detail.includes("/deploy prod --now"), "the full staged line belongs in the detail, the operator's own session");
});

test("a trigger's row names its forge ONCE -- the target says it, so no badge repeats it", async () => {
  // The badge existed because the target read `-> github` for every forge, so a gitlab row contradicted its
  // own badge. Fixing the target removed the badge's REASON to exist, not merely its wrongness. render.mjs
  // keeps its badge, and its own suite still pins it, because that line never names the forge at all.
  const { list } = await renderTrigger({ type: "label", forge: "gitlab", any: ["pi:go"], all: [], none: [], flow: "fix" });
  assert.ok(list.includes("gitlab"), "the forge is named");
  assert.equal(list.includes("[gitlab]"), false, "and not named a second time as a badge");
});

test("a trigger's row names ITS forge, never github by default", async () => {
  // The row read `-> github <flow>  [gitlab]` before this: the line contradicting its own badge. The forge
  // is carried verbatim by read-model.mjs, so an unrecognised one shows as itself rather than as a
  // plausible default the operator would then trust.
  for (const forge of ["gitlab", "forgejo", "azure"]) {
    const { list } = await renderTrigger({ type: "label", forge, any: ["pi:go"], all: [], none: [], flow: "fix" });
    assert.ok(list.includes(forge), `${forge}: the row must name the forge it listens to`);
    assert.equal(list.includes("github"), false, `${forge}: and must not also claim github`);
  }
});

test("the trust model is per forge -- an azure trigger must not claim HMAC or a delivery GUID", async () => {
  // Both are FALSE on Azure: Service Hooks offer no HMAC at all and send no delivery-id header. A trust
  // model that is wrong is worse than one that is absent, because an operator reads it to decide whether
  // they are comfortable running the thing.
  const azure = (await renderTrigger({ type: "label", forge: "azure", any: ["pi:go"], all: [], none: [], flow: "fix" })).detail;
  assert.match(azure, /NO HMAC/);
  assert.equal(/X-GitHub-Delivery/.test(azure), false, "Azure sends no such header");
  assert.match(azure, /project membership/);

  const gitlab = (await renderTrigger({ type: "label", forge: "gitlab", any: ["pi:go"], all: [], none: [], flow: "fix" })).detail;
  assert.match(gitlab, /access level/, "a GitLab label is not an approval -- the resolved level is the gate");

  const forgejo = (await renderTrigger({ type: "label", forge: "forgejo", any: ["pi:go"], all: [], none: [], flow: "fix" })).detail;
  assert.match(forgejo, /repository permission/);

  const github = (await renderTrigger({ type: "label", forge: "github", any: ["pi:go"], all: [], none: [], flow: "fix" })).detail;
  assert.match(github, /X-GitHub-Delivery/);
});

/** Open RUN_DETAIL on the single canned run, with sandbox seams wired as given. */
async function openRunDetail(deps = {}, tui = fakeTui()) {
  const comp = makeDashboard({ paths: {}, done() {}, tui, intervalMs: 100000, deps: cannedDeps(deps) });
  await flush();
  comp.handleInput("\r"); // row 0 is the only run
  await flush();
  return comp;
}

test("RUN_DETAIL shows a run's retention state, and offers `b` only when there is something to open", async () => {
  const retained = await openRunDetail({
    sandboxInfo: () => ({ retained: true, expiresIn: "19h" }),
    launchSandbox: async () => {},
  });
  const out = stripAnsi(retained.render(80).join("\n"));
  await retained.dispose();
  assert.match(out, /sandbox\s+retained · 19h left/);
  assert.match(out, /b\s+sandbox/, "the footer advertises the key");

  const swept = await openRunDetail({ sandboxInfo: () => ({ retained: false, reason: "swept" }), launchSandbox: async () => {} });
  const sweptOut = stripAnsi(swept.render(80).join("\n"));
  await swept.dispose();
  assert.match(sweptOut, /sandbox\s+swept/);
  assert.equal(/b\s+sandbox/.test(sweptOut), false, "a key that would refuse is not advertised");
});

test("`b` suspends pi's TUI around the launch, and resumes it even when the launch fails", async () => {
  // The whole contract of the handoff: docker owns the terminal only BETWEEN stop and start, and start is
  // in a `finally` so a failed launch cannot leave the panel suspended with no way back.
  const order = [];
  const tui = {
    requestRender: (force) => order.push(force ? "requestRender(true)" : "requestRender"),
    stop: () => order.push("stop"),
    start: () => order.push("start"),
  };
  const comp = await openRunDetail(
    {
      sandboxInfo: () => ({ retained: true }),
      launchSandbox: async ({ jobId }) => {
        order.push(`launch:${jobId}`);
      },
    },
    tui,
  );
  order.length = 0; // drop the renders from opening the view
  comp.handleInput("b");
  await flush();
  await comp.dispose();
  assert.deepEqual(order, ["stop", "launch:j1", "start", "requestRender(true)"]);

  const failOrder = [];
  const failTui = {
    requestRender: (force) => failOrder.push(force ? "requestRender(true)" : "requestRender"),
    stop: () => failOrder.push("stop"),
    start: () => failOrder.push("start"),
  };
  const failing = await openRunDetail(
    {
      sandboxInfo: () => ({ retained: true }),
      launchSandbox: async () => {
        failOrder.push("launch");
        throw new Error("docker exploded");
      },
    },
    failTui,
  );
  failOrder.length = 0;
  failing.handleInput("b");
  await flush();
  await failing.dispose();
  assert.deepEqual(failOrder, ["stop", "launch", "start", "requestRender(true)"], "the finally is the whole guarantee");
});

test("`b` is inert without the seam, and inert on a swept run -- it never suspends the panel for nothing", async () => {
  for (const [deps, why] of [
    [{ sandboxInfo: () => ({ retained: true }) }, "an unwired build has no launchSandbox"],
    [{ sandboxInfo: () => ({ retained: false, reason: "swept" }), launchSandbox: async () => {} }, "there is nothing retained to open"],
  ]) {
    const order = [];
    const tui = { requestRender() {}, stop: () => order.push("stop"), start: () => order.push("start") };
    const comp = await openRunDetail(deps, tui);
    comp.handleInput("b");
    await flush();
    await comp.dispose();
    assert.deepEqual(order, [], why);
  }
});

test("escape still backs out of RUN_DETAIL and drops the sandbox state it read on entry", async () => {
  const comp = await openRunDetail({ sandboxInfo: () => ({ retained: true, expiresIn: "19h" }), launchSandbox: async () => {} });
  assert.match(stripAnsi(comp.render(80).join("\n")), /sandbox\s+retained/);
  comp.handleInput("\x1b");
  await flush();
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(out, /TRIGGERS|PAUSED/, "back on the list");
});

// --- replica runs in the panel (REQ-REPLICA-RUNS) ---

/** A snapshot holding a replica PAIR on one target, plus one ordinary run. */
const REPLICA_SNAPSHOT = {
  ...SNAPSHOT,
  activeJobId: null,
  runs: [
    { jobId: "gh-g1-r1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, replica: 1, replicas: 2, endedAt: "2026-08-01T00:00:00.000Z" },
    { jobId: "gh-g1-r2", target: "o/r#5", flow: "fix", outcome: "completed", turns: 6, replica: 2, replicas: 2, endedAt: "2026-08-01T00:01:00.000Z" },
    { jobId: "gh-g2", target: "o/r#6", flow: "fix", outcome: "completed", turns: 3, endedAt: "2026-08-01T00:02:00.000Z" },
  ],
};

test("the runs list badges each replica, and leaves an unreplicated row unmarked", async () => {
  // A row that is silently one of two racing jobs is the misreading this list can produce: two rows on one
  // target look like an accidental double-run rather than the pair the operator asked for.
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => REPLICA_SNAPSHOT }) });
  await flush();
  const out = stripAnsi(comp.render(100).join("\n"));
  await comp.dispose();
  assert.match(out, /r1\/2 gh-g1-r1/);
  assert.match(out, /r2\/2 gh-g1-r2/);
  assert.doesNotMatch(out, /r\d\/\d gh-g2/, "the unreplicated run carries no badge at all");
});

test("RUN_DETAIL names the sibling replica, reusing the scan the chain line already does", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => REPLICA_SNAPSHOT }) });
  await flush();
  comp.handleInput("\r"); // selected 0 is the first replica
  await flush();
  const detail = stripAnsi(comp.render(100).join("\n"));
  await comp.dispose();
  assert.match(detail, /replica\s+r1\/2/);
  assert.match(detail, /sibling r2 gh-g1-r2/, "matched on same target + flow, different index");
});

test("RUN_DETAIL shows no replica line for an ordinary run", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  comp.handleInput("\x1b[B");
  comp.handleInput("\r");
  await flush();
  const detail = stripAnsi(comp.render(100).join("\n"));
  await comp.dispose();
  assert.doesNotMatch(detail, /replica/, "an ordinary post-mortem is byte-identical to before the feature");
});

test("TRIGGER_DETAIL states the multiplier for a replicating trigger, and 'one run per delivery' otherwise", async () => {
  const open = async (replicas) => {
    const snap = triggerSnap([{ type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", replicas }]);
    const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
    await flush();
    comp.handleInput("\r");
    await flush();
    const out = stripAnsi(comp.render(80).join("\n"));
    await comp.dispose();
    return out;
  };

  const racing = await open(2);
  assert.match(racing, /replicas\s+2 sandboxes race this flow/);
  assert.match(racing, /2 budget slots reserved/, "the arithmetic is stated where the trust model is read, not only in the docs");
  assert.match(racing, /nothing cancels a sibling/);

  // The "I checked" dim default, not an omitted row: a missing row reads as "I don't know".
  const plain = await open(null);
  assert.match(plain, /replicas\s+one run per delivery/);
  assert.doesNotMatch(plain, /budget slots reserved/);
});

// --- runs viewport, section jump, detail navigation, sort (dashboard usability, issue #71) ---

/** A snapshot with `n` runs named r0..r(n-1), newest-first like listRuns serves them. */
const manyRuns = (n) => ({
  ...SNAPSHOT,
  activeJobId: null,
  runs: Array.from({ length: n }, (_, i) => ({
    jobId: `r${i}`,
    target: "o/r#1",
    flow: "f",
    outcome: "completed",
    reason: null,
    turns: 1,
    tokens: { input: 1, output: 1, total: 100 + i, cost: (100 + i) / 1000 },
    endedAt: `2026-07-21T00:00:${String(59 - i).padStart(2, "0")}.000Z`,
  })),
});

test("the runs list is a cursor-following viewport with edge markers, not a 50-row wall", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => manyRuns(15) }) });
  await flush();

  const first = stripAnsi(comp.render(80).join("\n"));
  assert.match(first, /r0/, "the window opens at the top of the list");
  assert.match(first, /r9/, "a full viewport of rows is visible");
  assert.doesNotMatch(first, /\br12\b/, "rows past the viewport are not rendered");
  assert.match(first, /↓ 5 more/, "the lower edge marker counts what is out of view");
  assert.doesNotMatch(first, /↑ \d+ more/, "no upper marker at the top");

  for (let i = 0; i < 12; i++) comp.handleInput("\x1b[B");
  await flush();
  const scrolled = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(scrolled, /↑ 5 more/, "the window followed the cursor down");
  assert.match(scrolled, /\br14\b/, "the last records are reachable now");
  assert.match(scrolled, /› .*r12/, "the cursor row is inside the window");
});

test("Tab jumps between the trigger and run section heads instead of arrowing through every row", async () => {
  const snap = { ...manyRuns(3), triggers: { triggers: [{ type: "label", any: ["bug"], all: [], none: [], flow: "fix" }] } };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();

  comp.handleInput("\t"); // from the trigger head to the first run row
  comp.handleInput("\r");
  await flush();
  const runDetail = stripAnsi(comp.render(80).join("\n"));
  assert.match(runDetail, /run r0/, "Tab then Enter opens the first run, not the trigger");

  comp.handleInput("\x1b"); // back to LIST
  await flush();
  comp.handleInput("\t"); // and back to the trigger head
  comp.handleInput("\r");
  await flush();
  const trgDetail = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(trgDetail, /TRUST MODEL/i, "Tab wraps back to the triggers section");
});

test("←/→ walk the run records inside RUN_DETAIL and re-read sandbox state through the seam", async () => {
  const seen = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({
      fetchSnapshot: async () => manyRuns(3),
      sandboxInfo: ({ jobId }) => {
        seen.push(jobId);
        return null;
      },
    }),
  });
  await flush();

  comp.handleInput("\r"); // open r0
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /run r0/);

  comp.handleInput("\x1b[C"); // → r1
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /run r1/, "right steps to the next record in place");

  comp.handleInput("\x1b[C"); // → r2
  comp.handleInput("\x1b[C"); // → past the end: stays put
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /run r2/, "the last record is a wall, not a wrap");

  comp.handleInput("\x1b[D"); // ← r1
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /run r1/, "left steps back");
  assert.deepEqual(seen, ["r0", "r1", "r2", "r1"], "sandbox state is one read per record shown, through the seam");

  // The LIST cursor followed, so Esc lands on the run being read rather than where the walk began.
  comp.handleInput("\x1b");
  await flush();
  const list = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(list, /› .*\br1\b/, "the list cursor is on the record the walk ended at");
});

test("'o' cycles the runs sort; absent numbers sort last and the divider names the order", async () => {
  const snap = {
    ...SNAPSHOT,
    activeJobId: null,
    runs: [
      { jobId: "rA", target: "o/r#1", flow: "f", outcome: "completed", turns: 1, tokens: { total: 100, cost: 0.9 }, endedAt: "2026-07-21T00:00:03.000Z" },
      { jobId: "rB", target: "o/r#1", flow: "f", outcome: "failed", reason: "error", turns: 1, tokens: { total: 900, cost: 0.1 }, endedAt: "2026-07-21T00:00:02.000Z" },
      { jobId: "rC", target: "o/r#1", flow: "f", outcome: "completed", turns: 1, tokens: null, endedAt: "2026-07-21T00:00:01.000Z" },
    ],
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();

  const order = (out) => ["rA", "rB", "rC"].sort((a, b) => out.indexOf(a) - out.indexOf(b)).join(",");
  const time = stripAnsi(comp.render(80).join("\n"));
  assert.match(time, /o time/, "the divider names the default order");
  assert.equal(order(time), "rA,rB,rC", "time is listRuns' own order");

  comp.handleInput("o");
  await flush();
  const tokens = stripAnsi(comp.render(80).join("\n"));
  assert.match(tokens, /o tokens/);
  assert.equal(order(tokens), "rB,rA,rC", "tokens descending, and a null tokens record sorts LAST -- unknown is not cheap");

  comp.handleInput("o");
  await flush();
  const cost = stripAnsi(comp.render(80).join("\n"));
  assert.equal(order(cost), "rA,rB,rC", "cost descending, null still last");

  comp.handleInput("o");
  await flush();
  const outcome = stripAnsi(comp.render(80).join("\n"));
  assert.equal(order(outcome), "rB,rA,rC", "outcome puts failures first -- the triage order");

  comp.handleInput("o");
  await flush();
  const wrapped = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(wrapped, /o time/, "the cycle wraps back to time");
});

test("Enter opens the row the sorted list shows, not the row the unsorted list had there", async () => {
  const snap = {
    ...SNAPSHOT,
    activeJobId: null,
    runs: [
      { jobId: "rA", target: "o/r#1", flow: "f", outcome: "completed", turns: 1, tokens: { total: 100, cost: 0.1 }, endedAt: "2026-07-21T00:00:02.000Z" },
      { jobId: "rB", target: "o/r#1", flow: "f", outcome: "completed", turns: 1, tokens: { total: 900, cost: 0.9 }, endedAt: "2026-07-21T00:00:01.000Z" },
    ],
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  comp.handleInput("o"); // tokens sort: rB now leads
  comp.handleInput("\r");
  await flush();
  const detail = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(detail, /run rB/, "the cursor and the rendered order share one rows model");
});

test("a cron trigger whose scheduler is overdue or stall-capped carries an amber badge in LIST", async () => {
  const open = async (schedulers, stalls, stallMax) => {
    const snap = {
      ...SNAPSHOT,
      activeJobId: null,
      runs: [],
      triggers: { triggers: [{ type: "cron", id: "s1", pattern: "0 3 * * *", folder: "/p", flow: "tidy" }] },
      schedulers,
      schedulerStalls: stalls,
      schedulerStallMax: stallMax,
    };
    const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
    await flush();
    const out = stripAnsi(comp.render(80).join("\n"));
    await comp.dispose();
    return out;
  };

  const overdue = await open([{ key: "s1", next: 1, overdueMs: 60000 }], {}, 2);
  assert.match(overdue, /⚠ overdue/, "an overdue scheduler is a LIST-level fact, not only a drill-in one");

  const stalled = await open([{ key: "s1", next: 1, overdueMs: 0 }], { s1: 2 }, 2);
  assert.match(stalled, /⚠ stalled/, "a stall counter at the backstop max badges the row");

  const healthy = await open([{ key: "s1", next: 1, overdueMs: 0 }], {}, 2);
  assert.doesNotMatch(healthy, /⚠/, "a healthy row renders byte-identically to before");
});

// --- OSC-8 links, OSC-52 copy, live-tail search, height-aware collapsing (the terminal round) ---

/** A theme whose fg/bold emit real SGR (the shape the width tests above use), shared by this section. */
const SGR_THEME = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };

/** The canned run re-declared as a github one: `kind` is what targetUrl keys off. */
const githubRunSnap = () => ({ ...SNAPSHOT, runs: [{ ...SNAPSHOT.runs[0], kind: "github" }] });

test("targetUrl: a github repo#N target yields the one derivable URL; everything else is null", () => {
  // issues/N redirects to pull/N when N is a PR, so the one shape covers both kinds.
  assert.equal(targetUrl({ kind: "github", target: "o/r#5" }), "https://github.com/o/r/issues/5");
  assert.equal(targetUrl({ kind: "github", target: "acme/web#123" }), "https://github.com/acme/web/issues/123");
  // A gitlab/azure/forgejo instance host is unknowable from the record: null, never a guessed URL.
  assert.equal(targetUrl({ kind: "gitlab", target: "grp/proj#5" }), null);
  assert.equal(targetUrl({ kind: "local", target: "local:folder" }), null);
  assert.equal(targetUrl({ kind: "github", target: "o/r#" }), null, "malformed: no number");
  assert.equal(targetUrl({ kind: "github", target: "o r#5" }), null, "malformed: whitespace in the repo");
  assert.equal(targetUrl({ kind: "github", target: null }), null);
  assert.equal(targetUrl(null), null);
});

test("a github run's target is an OSC-8 link under a theme, still width-true; the plain path has no escape bytes", async () => {
  const themed = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme: SGR_THEME, deps: cannedDeps({ fetchSnapshot: async () => githubRunSnap() }) });
  await flush();
  const lines = themed.render(80);
  assert.ok(lines.join("\n").includes("\x1b]8;;https://github.com/o/r/issues/5\x07"), "the LIST run row links its target");
  // stripAnsi covers OSC-8: asserted once explicitly on a linked row -- the link adds zero visible columns.
  const linked = lines.find((l) => l.includes("\x1b]8;;"));
  assert.equal(visibleLen(linked), 80, "the linked row still measures exactly the frame width");

  themed.handleInput("\r"); // the run is row 0 (no triggers, no active row in this snapshot)
  await flush();
  const detail = themed.render(80).join("\n");
  await themed.dispose();
  assert.ok(detail.includes("\x1b]8;;https://github.com/o/r/issues/5\x07"), "RUN_DETAIL's target line links too");

  const plain = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => githubRunSnap() }) });
  await flush();
  const out = plain.render(80).join("\n");
  plain.handleInput("\r");
  await flush();
  const plainDetail = plain.render(80).join("\n");
  await plain.dispose();
  assert.ok(!out.includes("\x1b]8;;"), "PLAIN_THEME's link is a byte-identical passthrough on the list");
  assert.ok(!plainDetail.includes("\x1b]8;;"), "and on the drill-in");
});

test("`y`/`Y` copy the job id and target URL through the seam, with a one-input transient note", async () => {
  const copied = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: async () => githubRunSnap(), copyText: (text) => copied.push(text) }),
  });
  await flush();
  comp.handleInput("\r"); // open RUN_DETAIL on j1
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /y copy/, "the footer advertises the key while the seam is wired");

  comp.handleInput("y");
  assert.deepEqual(copied, ["j1"], "y hands the terminal the job id");
  assert.match(stripAnsi(comp.render(80).join("\n")), /copied job id/, "the acknowledgment rides the footer");
  comp.handleInput("z"); // any next input outdates the note (z is otherwise inert in RUN_DETAIL)
  assert.doesNotMatch(stripAnsi(comp.render(80).join("\n")), /copied/, "the note is transient by construction");

  comp.handleInput("Y");
  assert.deepEqual(copied, ["j1", "https://github.com/o/r/issues/5"], "Y hands over the browsable URL");
  assert.match(stripAnsi(comp.render(80).join("\n")), /copied target url/);
  await comp.dispose();
});

test("without the copy seam y/Y are inert and unadvertised; Y with no derivable URL copies nothing", async () => {
  const bare = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps() });
  await flush();
  bare.handleInput("\x1b[B");
  bare.handleInput("\r");
  await flush();
  assert.doesNotMatch(stripAnsi(bare.render(80).join("\n")), /y copy/, "no seam, no hint");
  bare.handleInput("y");
  bare.handleInput("Y");
  assert.doesNotMatch(stripAnsi(bare.render(80).join("\n")), /copied/, "no seam, no note");
  await bare.dispose();

  // SNAPSHOT's run carries no `kind`, so targetUrl is null: Y must stay inert rather than guess a URL.
  const copied = [];
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ copyText: (t) => copied.push(t) }) });
  await flush();
  comp.handleInput("\r");
  await flush();
  comp.handleInput("Y");
  assert.deepEqual(copied, [], "no URL, no copy");
  assert.doesNotMatch(stripAnsi(comp.render(80).join("\n")), /copied/, "and no note claiming otherwise");
  await comp.dispose();
});

// --- LIVE_TAIL search: the `/` layer, n/N navigation, the post-clip highlight ---

const TAIL_CANNED = ["alpha", "beta ERR one", "gamma", "delta err two", "epsilon"];

/** A dashboard with LIVE_TAIL open (`l` from LIST) over canned tail lines. */
async function openTail(lines, { theme } = {}) {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    theme,
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAPSHOT, activeJobId: "jA" }), tailLog: () => ({ lines }) }),
  });
  await flush();
  comp.handleInput("l");
  await flush();
  await flush();
  return comp;
}

test("'/' opens the tail search; printable keys land in the query first; Enter arms; n/N navigate and wrap", async () => {
  const comp = await openTail(TAIL_CANNED);
  comp.handleInput("/");
  await flush();
  comp.handleInput("t"); // a printable must join the query, never act as a view key
  await flush();
  let out = stripAnsi(comp.render(80).join("\n"));
  assert.match(out, /\/ t/, "the bar renders the typed query");

  comp.handleInput("\x7f"); // backspace routes to the input too
  for (const ch of "err") comp.handleInput(ch);
  comp.handleInput("\r"); // Enter closes the input, keeping the query armed
  await flush();
  out = stripAnsi(comp.render(80).join("\n"));
  assert.doesNotMatch(out, /\/ err/, "the bar is closed");
  assert.match(out, /\/err · 0\/2/, "the footer names the armed query and the match count before any jump");
  assert.match(out, /follow/, "arming alone does not disturb follow mode");

  comp.handleInput("n");
  await flush();
  out = stripAnsi(comp.render(80).join("\n"));
  assert.match(out, /paused/, "a matched jump suspends follow exactly as manual scrolling does");
  assert.match(out, /\/err · 1\/2/, "the footer shows the match position");

  comp.handleInput("n");
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /\/err · 2\/2/);

  comp.handleInput("n"); // past the last match: wraps to the first
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /\/err · 1\/2/, "n wraps");

  comp.handleInput("N"); // before the first match: wraps back to the last
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /\/err · 2\/2/, "N wraps");
  await comp.dispose();
});

test("Esc pops the search layer first, the view second; an unmatched query says so", async () => {
  const comp = await openTail(TAIL_CANNED);
  comp.handleInput("/");
  for (const ch of "zzz") comp.handleInput(ch);
  comp.handleInput("\r");
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /\/zzz · no match/, "an armed query with no hit is stated in the footer");
  comp.handleInput("n"); // nothing to jump to: stays put
  await flush();
  const still = stripAnsi(comp.render(80).join("\n"));
  assert.match(still, /no match/);
  assert.match(still, /follow/, "a jump that cannot happen does not suspend follow");

  comp.handleInput("\x1b"); // pops the search alone
  await flush();
  const popped = stripAnsi(comp.render(80).join("\n"));
  assert.doesNotMatch(popped, /\/zzz/, "the query is cleared");
  assert.match(popped, /live jA/, "still in the tail view");

  comp.handleInput("\x1b"); // now the view pops
  await flush();
  assert.match(stripAnsi(comp.render(80).join("\n")), /pi-dispatch/, "back on the LIST");
  await comp.dispose();
});

test("the current match line is highlighted post-clip under a theme, and every line stays width-true", async () => {
  const comp = await openTail(TAIL_CANNED, { theme: SGR_THEME });
  comp.handleInput("/");
  for (const ch of "err") comp.handleInput(ch);
  comp.handleInput("\r");
  comp.handleInput("n");
  await flush();
  const lines = comp.render(80);
  await comp.dispose();
  // The warning wrap sits AROUND the clipped text: clip ran first (the untrusted-byte gate), color second.
  assert.ok(lines.some((l) => l.includes("\x1b[38;5;42mbeta ERR one")), "the match line is color-wrapped after clip");
  assert.ok(!lines.some((l) => l.includes("\x1b[38;5;42mgamma")), "non-match tail lines stay plain clip output");
  for (const l of lines) {
    assert.equal(visibleLen(l), 80, `every framed line is exactly 80 visible cols: ${JSON.stringify(stripAnsi(l))}`);
  }
});

// --- height-aware collapsing: the injected terminalRows seam and the section collapse budget ---

/** A tall LIST snapshot: 4 triggers, 6 pause windows, 3 runs -- enough to overflow a short terminal. */
const tallSnap = () => ({
  ...manyRuns(3),
  triggers: { triggers: Array.from({ length: 4 }, (_, i) => ({ type: "label", any: [`t${i}`], all: [], none: [], flow: "fix" })) },
  pauseWindows: { windows: Array.from({ length: 6 }, (_, i) => ({ scope: `acme/p${i}`, from: "01:00", to: "02:00", tz: "UTC", fromMin: 60, toMin: 120 })) },
});

test("with terminalRows the LIST collapses by priority, never the cursor's section, and fits the budget", async () => {
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: cannedDeps({ fetchSnapshot: async () => tallSnap(), terminalRows: () => 18 }),
  });
  await flush();

  // Cursor opens on the triggers: they stay expanded while everything foldable around them gives way.
  let text = stripAnsi(comp.render(80).join("\n"));
  assert.match(text, /t0/, "the cursor's section (triggers) is never collapsed");
  assert.match(text, /6 hidden — w to view/, "pause windows fold first, to their divider alone");
  assert.match(text, /2 hidden — s to view/, "settings fold too, naming their key");
  assert.doesNotMatch(text, /hidden — tab to view/, "triggers hold while the cursor is in them");

  comp.handleInput("\t"); // jump the cursor to the runs head: triggers become foldable
  await flush();
  const lines = comp.render(80);
  text = stripAnsi(lines.join("\n"));
  await comp.dispose();
  assert.ok(lines.length <= 18, `the composed frame fits the 18-row budget (got ${lines.length})`);
  assert.match(text, /4 hidden — tab to view/, "triggers fold once the cursor leaves them");
  assert.match(text, /› .*r0/, "the runs viewport (which bounds itself) still shows the cursor row");
});

test("rows 999 or an absent seam render byte-identically to the panel without the feature", async () => {
  const mk = (over) => makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => tallSnap(), ...over }) });
  const base = mk({});
  const big = mk({ terminalRows: () => 999 });
  const blind = mk({ terminalRows: () => null });
  await flush();
  // The status clock is the one legitimately time-varying byte; scrub it so the compare is about layout.
  const scrub = (lines) => lines.map((l) => l.replace(/\d\d:\d\d:\d\d/, "HH:MM:SS"));
  const a = scrub(base.render(80));
  const b = scrub(big.render(80));
  const c = scrub(blind.render(80));
  await base.dispose();
  await big.dispose();
  await blind.dispose();
  assert.deepEqual(b, a, "a tall terminal collapses nothing");
  assert.deepEqual(c, a, "an unknown height (not a TTY) collapses nothing");
  assert.doesNotMatch(a.join("\n"), /hidden/, "and the full panel carries no collapse markers");
});

test("the viewport, markers and badges keep every colored line at exactly the frame width", async () => {
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const snap = { ...manyRuns(15), triggers: { triggers: [{ type: "cron", id: "s1", pattern: "0 3 * * *", folder: "/p", flow: "tidy" }] } };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), theme, intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  for (let i = 0; i < 9; i++) comp.handleInput("\x1b[B");
  await flush();
  const lines = comp.render(80);
  await comp.dispose();
  for (const l of lines) assert.equal(visibleLen(l), 80, `every line is exactly 80 visible cols: ${JSON.stringify(l)}`);
});

test("a LIST trigger row carries the RAW file index, so delete targets the right entry past a dropped row", async () => {
  // The display drops unusable entries but keeps raw indexes; the row using its display POSITION was
  // a live-fire wrong-delete: garbage at file row 0, x+y on the visible trigger deleted the garbage
  // and reported the real trigger gone while it kept firing (review finding).
  const snap = {
    ...SNAPSHOT,
    triggers: { count: 2, triggers: [{ type: "label", index: 1, any: ["ai"], all: [], none: [], flow: "fix", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" }] },
  };
  let payload = null;
  const comp = makeDashboard({ paths: {}, done: (p) => (payload = p), tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snap }) });
  await flush();
  comp.handleInput("\r"); // cursor starts on the one trigger row
  await flush();
  comp.handleInput("x");
  comp.handleInput("y");
  await flush();
  await comp.dispose();
  assert.equal(payload?.action, "deleteTrigger");
  assert.equal(payload?.index, 1, "the RAW file index, not the display position 0");
});

test("the sibling scan does not cross forges -- a stranger's run is never named as your replica (#187)", async () => {
  // `target` is repo + separator + number, and targetFor renders github and forgejo with the SAME `#`, so
  // a github `o/r#5` and a forgejo `o/r#5` are one string. While github alone could replicate, no two
  // replica runs could collide on it; #187 is what makes this reachable. The fixtures above carry no
  // `kind` at all, so they cannot catch it -- this one does.
  const snapshot = {
    ...SNAPSHOT,
    activeJobId: null,
    runs: [
      { jobId: "gh-g1-r1", kind: "github", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, replica: 1, replicas: 2, endedAt: "2026-08-01T00:00:00.000Z" },
      { jobId: "fj-x9-r2", kind: "forgejo", target: "o/r#5", flow: "fix", outcome: "completed", turns: 6, replica: 2, replicas: 2, endedAt: "2026-08-01T00:01:00.000Z" },
    ],
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => snapshot }) });
  await flush();
  comp.handleInput("\r");
  await flush();
  const detail = stripAnsi(comp.render(100).join("\n"));
  await comp.dispose();
  assert.match(detail, /replica\s+r1\/2/, "it is still a replica run");
  assert.doesNotMatch(detail, /sibling r2 fj-x9-r2/, "a different forge's run is not this job's sibling");
  assert.match(detail, /no sibling in this window/, "and saying so is better than naming a stranger");
});
