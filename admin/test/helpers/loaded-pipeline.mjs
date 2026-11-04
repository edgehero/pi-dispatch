/**
 * A run record as production makes one: the runner's recorder and signed exit line, the worker's sink, `rebuildLoaded`, `runJob` and
 * `buildRecord`, each the real module, with only the container and the forge faked. A record's shape written by hand can hold a
 * reason the worker's vocabulary folds away, or a field no line carries, and a test over it proves words about a record that cannot
 * exist. So a test about what a real run reads builds it here.
 */
import { EventEmitter } from "node:events";
import { createExitWriter } from "../../../image/runner/src/exit-line.mjs";
import { createLoadedRecorder, createLoadTee } from "../../../image/runner/src/loaded.mjs";
import { makeImagePreflight } from "../../../worker/src/image-preflight.mjs";
import { leftOutOf, rebuildLoaded } from "../../../worker/src/loaded-record.mjs";
import { InfraRetry, runJob } from "../../../worker/src/processor.mjs";
import { buildRecord, makeLogSink } from "../../../worker/src/run-history.mjs";
import { EXCLUDABLE_TOOL_NAMES } from "../../../worker/src/triggers.mjs";

const KEY = "0123456789abcdef".repeat(4);
const OVERLAY_ROOT = "/opt/pi-global";
const OVERLAY_EXTENSIONS = `${OVERLAY_ROOT}/extensions`;
const ROOTS = { packages: [], jobPi: "/job/pi", triggerSkills: "/job/trigger-skills", overlay: OVERLAY_ROOT, workspace: "/workspace" };
const REPOSITORY_FLOW = { name: "fix", filePath: "/job/pi/skills/fix/SKILL.md" };

/** What the loader's log hands the record when `overlayExtensionEntries` holds the whole overlay back, through the real tee. */
export function heldBackOverlay() {
  const tee = createLoadTee(() => {}, { overlayExtensions: OVERLAY_EXTENSIONS });
  tee.log("overlay_extensions_withheld", { reason: "ignore-matcher-unavailable", root: OVERLAY_EXTENSIONS });
  return tee.failures();
}

/** What the loader's log hands the record when these entries of the overlay fail to load, through the real tee. */
export function failedOverlayEntries(entries) {
  const tee = createLoadTee(() => {}, { overlayExtensions: OVERLAY_EXTENSIONS });
  tee.log("extension_load_failed", { extensions: entries.map((entry) => ({ entry, root: OVERLAY_EXTENSIONS, kind: "load" })) });
  return tee.failures();
}

/** The fake redis `runJob`'s gates count on: every counter under its cap. */
function fakeRedis() {
  let n = 0;
  return { incr: async () => ++n, decr: async () => --n, expire: async () => {}, get: async () => null };
}

/** The runtime's CLI as the real preflight reads it: an inspect that answers with the id and the pi label, and no other label. */
const fakeImageInspect = (piVersion, capabilities = null) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  queueMicrotask(() => {
    child.stdout.emit("data", `sha256:${"7".repeat(64)}|${piVersion ?? "<no value>"}|<no value>|${capabilities ?? "<no value>"}\n`);
    child.emit("close", 0);
  });
  return child;
};

/**
 * The record of one run. `stages` is what the runner notes, in order, as `run-job.mjs` does, and a stage named in `brokenAt` throws as a
 * repository's extension can make the report throw, so the recorder keeps the note before it. `exit` is the line's own fields.
 * `flowFound: false` is a flow in no tier, `failures` what `createLoadTee` would hand over. `packages` are what the host staged and
 * `overlay` the names in its overlay's extensions folder, every one of them loaded. `hostImage` is this host's `PI_JOB_IMAGE` and
 * `jobImage` the job's own `image`, read by the real preflight, whose inspect answers with `imagePi`. No `hostImage`, no image facts.
 * `containerThrows` is a run whose container wrapper gave up with what the container said, so the worker's facts are added on the way out.
 * `tools` are further tools the session holds, `{ name, path }`. `servers` are the trigger's server names and `mcpAt(stage)` their `[state, tools]` rows.
 * `jobFields` are the trigger's fields the job carries, from which the real `leftOutOf` says what it left out, `excludedNotHere` the names of them this host holds
 * neither way, and `unmatched` the positions in `run.excludeExtensionTools` the runner says matched nothing. `imageCapabilities` is the image's capabilities label.
 */
export async function recordThroughPipeline({ jobId = "gh-1c40", stages = ["start", "loader", "session", "ready"], brokenAt = [], exit, flowFound = true, failures = [], turnsOnLine = undefined, packages = [{ name: "pi-lint", version: "1.4.2" }], overlay = [], hostImage = null, jobImage = undefined, imagePi = "1.5.0", host = "mini1", endedAt = "2026-07-16T10:01:00.000Z", pi = "1.5.0", tools = [], servers = [], mcpAt = () => [], containerThrows = false, jobFields = {}, excludedNotHere = [], unmatched = [], imageCapabilities = null } = {}) {
  const out = [];
  const writer = createExitWriter({ key: KEY, jobId, write: (line) => out.push(line), exit: () => {} });
  const recorder = createLoadedRecorder({ pi, note: (loaded) => writer.note({ loaded }), log: () => {} });
  const packageRoots = packages.map(({ name }) => `${OVERLAY_ROOT}/packages/${name}`);
  const extensions = [...packageRoots.map((root) => `${root}/ext.js`), ...overlay.map((name) => `${OVERLAY_EXTENSIONS}/${name}`)];
  const loaderFacts = () => ({ roots: { ...ROOTS, packages: packageRoots }, flow: "fix", extensions, skills: flowFound ? [REPOSITORY_FLOW] : [], prompts: [], themes: [], failures, drops: [], shadowed: [] });
  const liveTools = (stage) => () => ({ tools: [{ name: "read", path: "builtin:read" }, ...tools], active: ["read"], ownNames: ["read"], mcp: mcpAt(stage), ...(stage === "ready" ? { unmatched } : {}) });
  const broken = () => { throw new Error("an extension broke the report"); };
  for (const stage of stages) {
    const facts = stage === "start" ? undefined : stage === "loader" ? loaderFacts : liveTools(stage);
    recorder.record(stage, brokenAt.includes(stage) ? broken : facts);
  }
  writer.writeExit({ ...exit, ...(turnsOnLine === undefined ? {} : { turns: turnsOnLine }) });

  const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })(jobId, { exitKey: KEY });
  sink.write(out[0]);
  const closed = await sink.close();
  const loaded = rebuildLoaded(closed.loaded, { packages, overlayExtensions: [...new Set([...overlay.map((path) => path.split("/")[0]), ...failures.flatMap((failure) => failure.name ?? [])])], servers, ownTools: EXCLUDABLE_TOOL_NAMES, leftOut: leftOutOf(jobFields, { excludedNotHere }), excludeExtensionTools: jobFields.excludeExtensionTools ?? [] });

  const job = { ...jobFields, ...(jobImage === undefined ? {} : { image: jobImage }), kind: "github", repo: "acme/web", target: { type: "issue", number: 490 }, provider: "anthropic", model: "claude-sonnet-5-5", maxTurns: 20, flow: "fix", trigger: { matched: { index: 2, type: "comment" } } };
  const deps = {
    redis: fakeRedis(), caps: { day: 10, week: null, month: null }, softHoldPct: null,
    ...(hostImage === null ? {} : { imagePreflight: makeImagePreflight({ image: hostImage, spawnFn: fakeImageInspect(imagePi, imageCapabilities) }) }),
    mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", sha: "a".repeat(40) }),
    runContainer: async () => {
      if (containerThrows) throw new InfraRetry("the container's wrapper gave up", { reason: "container-infra-exit", budgetReserved: true, loaded });
      return { code: closed.exitLineCode ?? exit.code, aborted: false, exitReason: closed.exitReason, turns: closed.turns, tokens: closed.tokens, loaded };
    },
    collectChain: async () => ({ enqueued: 0, refused: 0 }), cleanup: async () => undefined, comment: async () => undefined, now: new Date("2026-07-16T10:00:00Z"),
  };
  // An infrastructure failure throws, as the queue needs it to, and the record is written from what it threw.
  const outcome = await runJob(job, deps).then((result) => ({ result }), (error) => ({ error }));
  return buildRecord({ job: { id: jobId, name: "github", attemptsMade: 0, data: job }, ...outcome, startedAt: "2026-07-16T10:00:00.000Z", endedAt, host });
}
