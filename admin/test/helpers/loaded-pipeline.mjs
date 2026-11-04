/**
 * A run record as production makes one: the runner's recorder and signed exit line, the worker's sink, `rebuildLoaded`, `runJob` and
 * `buildRecord`, each the real module, with only the container and the forge faked. A record's shape written by hand can hold a
 * reason the worker's vocabulary folds away, or a field no line carries, and a test over it proves words about a record that cannot
 * exist. So a test about what a real run reads builds it here.
 */
import { createExitWriter } from "../../../image/runner/src/exit-line.mjs";
import { createLoadedRecorder } from "../../../image/runner/src/loaded.mjs";
import { rebuildLoaded } from "../../../worker/src/loaded-record.mjs";
import { runJob } from "../../../worker/src/processor.mjs";
import { buildRecord, makeLogSink } from "../../../worker/src/run-history.mjs";
import { EXCLUDABLE_TOOL_NAMES } from "../../../worker/src/triggers.mjs";

const KEY = "0123456789abcdef".repeat(4);
const PACKAGE_ROOT = "/opt/pi-global/packages/pi-lint";
const ROOTS = { packages: [PACKAGE_ROOT], jobPi: "/job/pi", triggerSkills: "/job/trigger-skills", overlay: "/opt/pi-global", workspace: "/workspace" };
const REPOSITORY_FLOW = { name: "fix", filePath: "/job/pi/skills/fix/SKILL.md" };

/** The fake redis `runJob`'s gates count on: every counter under its cap. */
function fakeRedis() {
  let n = 0;
  return { incr: async () => ++n, decr: async () => --n, expire: async () => {}, get: async () => null };
}

/**
 * The record of one run. `stages` is what the runner notes, in order, as `run-job.mjs` does, and a stage named in `brokenAt` throws as a
 * repository's extension can make the report throw, so the recorder keeps the note before it. `exit` is the line's own fields.
 * `flowFound: false` is a flow in no tier, `failures` what `createLoadTee` would hand over.
 */
export async function recordThroughPipeline({ jobId = "gh-1c40", stages = ["start", "loader", "session", "ready"], brokenAt = [], exit, flowFound = true, failures = [], turnsOnLine = undefined } = {}) {
  const out = [];
  const writer = createExitWriter({ key: KEY, jobId, write: (line) => out.push(line), exit: () => {} });
  const recorder = createLoadedRecorder({ pi: "1.5.0", note: (loaded) => writer.note({ loaded }), log: () => {} });
  const loaderFacts = () => ({ roots: ROOTS, flow: "fix", extensions: [`${PACKAGE_ROOT}/ext.js`], skills: flowFound ? [REPOSITORY_FLOW] : [], prompts: [], themes: [], failures, drops: [], shadowed: [] });
  const liveTools = () => ({ tools: [{ name: "read", path: "builtin:read" }], active: ["read"], ownNames: ["read"], mcp: [] });
  const broken = () => { throw new Error("an extension broke the report"); };
  for (const stage of stages) {
    const facts = stage === "start" ? undefined : stage === "loader" ? loaderFacts : liveTools;
    recorder.record(stage, brokenAt.includes(stage) ? broken : facts);
  }
  writer.writeExit({ ...exit, ...(turnsOnLine === undefined ? {} : { turns: turnsOnLine }) });

  const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })(jobId, { exitKey: KEY });
  sink.write(out[0]);
  const closed = await sink.close();
  const loaded = rebuildLoaded(closed.loaded, { packages: [{ name: "pi-lint", version: "1.4.2" }], overlayExtensions: [], servers: [], ownTools: EXCLUDABLE_TOOL_NAMES, leftOut: { tools: [], packages: false, overlayExtensions: false, restricted: false } });

  const job = { kind: "github", repo: "acme/web", target: { type: "issue", number: 490 }, provider: "anthropic", model: "claude-sonnet-5-5", maxTurns: 20, flow: "fix", trigger: { matched: { index: 2, type: "comment" } } };
  const deps = {
    redis: fakeRedis(), caps: { day: 10, week: null, month: null }, softHoldPct: null,
    mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", sha: "a".repeat(40) }),
    runContainer: async () => ({ code: closed.exitLineCode ?? exit.code, aborted: false, exitReason: closed.exitReason, turns: closed.turns, tokens: closed.tokens, loaded }),
    collectChain: async () => ({ enqueued: 0, refused: 0 }), cleanup: async () => undefined, comment: async () => undefined, now: new Date("2026-07-16T10:00:00Z"),
  };
  // An infrastructure failure throws, as the queue needs it to, and the record is written from what it threw.
  const outcome = await runJob(job, deps).then((result) => ({ result }), (error) => ({ error }));
  return buildRecord({ job: { id: jobId, name: "github", attemptsMade: 0, data: job }, ...outcome, startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:01:00.000Z", host: "mini1" });
}
