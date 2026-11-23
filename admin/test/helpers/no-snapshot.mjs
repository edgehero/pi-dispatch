/**
 * A fleet reader over a Valkey that does not answer (issue #844): `snapshot()` rejects, and `fileViews()` still holds
 * what the deployment's files say, two triggers and one project among them. The pages drawn over it must say "not
 * known" for what only Valkey holds and still show the files, never an empty list or a zero.
 *
 * THE READER IS THE REAL ONE (issue #988): `createFleetReader` over a client and queues whose every command rejects
 * (`downRedis`, `downQueue`) and over real files in a temp folder. So each state here is the one the reader itself
 * makes in an outage, and a page test over it cannot pass on a shape the reader never gives, which a state written
 * out by hand did twice.
 *
 * THE FILES ARE WRITTEN ON FIRST USE, and the temp folder helper is loaded then, not imported: the browser checks'
 * fixtures load this module too (through the setup and fleet goldens), in a process that runs no test, where
 * importing that helper would start the test runner. Loading this module writes nothing.
 *
 * TWO FIELDS ARE STILL NOT THE READER'S (`asPinned`), because three goldens drawn from these files were pinned on
 * views written out by hand and are kept byte for byte: `config-no-snapshot` for both roles and `triggers-no-snapshot`.
 *   - `triggers.path`. The reader's triggers view carries no path (its settings view does). A console draws the
 *     triggers file's place from `configLocations`, which those draws do not wire, so without the path the line under
 *     the title would read "triggers file unavailable".
 *   - a pause window's `fromMin`, `toMin` and `tz`, which the reader's parser always adds ("UTC" where the file names
 *     no zone). With them /config draws the window's zone and /triggers draws the quiet hour in its week, which is
 *     what a console shows in an outage; the goldens hold "-" and "no interval in view".
 * `pinned: false` gives the views exactly as the reader reads them. A test of what a page says in an outage asks for
 * those, and so does a new golden.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createFleetReader } from "../../src/read-model.mjs";
import { downQueue, downRedis } from "./fleet-reader-fakes.mjs";

/** The reader's clock where a caller names none: a fixed instant, so no state here moves with the wall clock. */
const AT = Date.UTC(2026, 9, 8, 15, 39, 0);

// The cron rule carries a task, as the worker's loader asks of one: without it the file would not load, and the view
// would say so (`doesNotLoad`) on every page drawn from these files.
const ENTRIES = Object.freeze([
  { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: "tidy the folder" } },
  { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } },
]);

/**
 * The deployment's files, written once: the folder is named `deployment`, so a page that draws a file by its last two
 * path parts draws no temp path. The logs folder and the pi overlay are not made: a host with no run record and no
 * staged package.
 *
 * WRITTEN AGAIN WHEN THEY ARE GONE. The temp folder helper removes its folders in a hook it registers when it is
 * loaded, and loaded here, inside a running test, that hook is the test's own: the folder goes when that test ends,
 * while this module still holds its paths. A later test of the same file would then read every file as missing, and
 * pass or fail on a deployment that holds nothing. So each use looks for the folder first.
 */
let written = null;
function deploymentPaths() {
  if (written !== null && existsSync(written.triggersPath)) return written;
  const { tempDir } = createRequire(import.meta.url)("./temp-dir.mjs");
  const dir = join(tempDir("pd-988-outage-"), "deployment");
  mkdirSync(dir);
  const paths = {
    valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), globalPiDir: join(dir, "pi"), schedulerStallMax: 2,
    triggersPath: join(dir, "triggers.json"), projectsFile: join(dir, "projects.json"), settingsFile: join(dir, "settings.json"),
    scopedLimitsPath: join(dir, "scoped-limits.json"), pauseWindowsPath: join(dir, "pause-windows.json"),
  };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: ENTRIES }));
  writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  writeFileSync(paths.settingsFile, JSON.stringify({ maxTurns: 30, maxCostUsd: "2" }));
  writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 10 }] }));
  writeFileSync(paths.pauseWindowsPath, JSON.stringify({ windows: [{ scope: "*", from: "01:00", to: "02:00" }] }));
  written = paths;
  return written;
}

/** The real reader over `paths`, with a Valkey that answers no command and no queue read. */
function outageReader(paths, { now = () => AT, fs } = {}) {
  return createFleetReader(paths, { redisFn: () => downRedis(), makeQueueFn: downQueue(), parseConnectionFn: () => ({}), nowFn: now, readOnly: true, ...(fs ? { fs } : {}) });
}

/** The reader's views as the three pinned goldens hold them (the header says which two fields and why). */
function asPinned(views) {
  return {
    ...views,
    triggers: { path: "/srv/deployment/triggers.json", ...views.triggers },
    pauseWindows: { ...views.pauseWindows, windows: views.pauseWindows.windows.map(({ scope, from, to }) => ({ scope, from, to })) },
  };
}

/**
 * The deployment's paths, for a test that runs another of the console's services over the same files and a client of
 * its own that answers nothing (`downRedis`): what that service says in an outage, beside what the reader says.
 */
export function outagePaths() {
  return deploymentPaths();
}

/** The reader's `fileViews()`: the snapshot's own keys and shapes, from the files alone. `pinned: false`: exactly as read. */
export function fileViewsFixture({ pinned = true } = {}) {
  const views = outageReader(deploymentPaths()).fileViews();
  return pinned ? asPinned(views) : views;
}

/**
 * The runs page as the real reader answers it in an outage: it does not throw, it holds no run and a mirror it could
 * not reach. Read here once, over a host whose logs folder is not there (no file is written for it).
 */
const noLogs = { readdirSync() { throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }); } };
export const RUNS_PAGE_IN_OUTAGE = Object.freeze(await outageReader({ valkeyUrl: "redis://unused", logsDir: "logs" }, { fs: noLogs }).runsPage());

/**
 * The reader: every Valkey read fails as the real reader fails it, the file views answer. `over` lays other fakes on
 * it; `now` is its clock (a fixed instant where none is given); `pinned: false` leaves its file views exactly as read.
 */
export function noSnapshotFleet(over = {}, { now, pinned = true } = {}) {
  const reader = outageReader(deploymentPaths(), now ? { now } : {});
  return { ...reader, ...(pinned ? { fileViews: () => asPinned(reader.fileViews()) } : {}), ...over };
}
