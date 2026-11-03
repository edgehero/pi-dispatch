/**
 * The sample records of the RunLoaded, LoadedStates and ProjectLoads cards (issue #800), built the way the worker builds
 * them. Shared by the goldens and the project page's fixture, which draws the same billing.
 */
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { recordedLoaded } from "../../../worker/src/loaded-record.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DIGEST = `sha256:7c1e0b4${"a".repeat(57)}`;
/** The commit the cards name, a41c0d2, in full as a record holds it. */
export const BASE_SHA = `a41c0d2${"b".repeat(33)}`;

/** One `sources` row, every count zero but what it names. */
export const source = (tier, over = {}) => ({
  tier,
  ...(tier === "package" ? { name: null, version: null, toolNames: [] } : {}),
  ...(tier === "overlay" ? { names: [], failedNames: [], namedTools: [] } : {}),
  extensions: 0, skills: 0, prompts: 0, themes: 0, tools: 0, failed: 0, dropped: 0, shadowed: 0, ...over,
});

const PI_LINT = source("package", { name: "pi-lint", version: "1.4.2", extensions: 1, prompts: 1, tools: 2, toolNames: ["lint_file", "lint_fix"] });
const PI_TEST_RUNNER = source("package", { name: "pi-test-runner", version: "0.9.0", extensions: 1, skills: 1, tools: 3, shadowed: 1, toolNames: ["run_tests", "test_coverage", "test_report"] });
const STAGED = Object.freeze([PI_LINT, PI_TEST_RUNNER]);
const NOTHING_LEFT_OUT = Object.freeze({ tools: [], packages: false, overlayExtensions: false, restricted: false });

/** The record's `loaded` as `recordedLoaded` keeps it: a sample that would not survive the rebuild fails here, not on a page. */
export function loadedField(over = {}) {
  const field = {
    v: 1, runner: "reported", at: "ready", cut: null, image: "pi-job:4.3.1", imageDigest: DIGEST, imagePi: "1.5.0", pi: "1.5.0",
    flow: { tier: "repository", package: null },
    sources: [...STAGED, source("overlay"), source("repository", { skills: 3 }), source("trigger"), source("other")],
    mcp: [],
    tools: { active: 10, own: ["read", "bash", "edit", "write"], job: ["report_progress"] },
    problems: { failed: 0, dropped: 0, mcp: 0 },
    leftOut: NOTHING_LEFT_OUT,
    baseSha: BASE_SHA,
    ...over,
  };
  const kept = recordedLoaded(field);
  if (kept === null) throw new Error("a loaded sample that the record's rebuild refuses");
  return kept;
}

/** A run record of the card's sample story. */
export const loadedRecord = (over = {}) => ({
  jobId: "gh-9575", kind: "github", target: "acme/web#490", project: "web", host: "mini1", backend: "local", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5",
  outcome: "completed", reason: null, exitCode: 0, attempt: 1, startedAt: new Date(NOW - 49 * MIN).toISOString(), endedAt: new Date(NOW - 27 * MIN).toISOString(),
  tokens: { input: 90_000, output: 21_000, total: 111_000, calls: 14, cost: 0.51 }, dollars: { reservedMicros: 2_000_000 }, parentJobId: null, triggerIndex: 2, triggerType: "comment",
  loaded: loadedField(), ...over,
});

export const LOADED_SAMPLES = Object.freeze({
  everything: () => loadedRecord(),
  leftOut: () => loadedRecord({ jobId: "gh-8251-r2", target: "acme/web#408", flow: "frontend-fix", host: "mini2", triggerIndex: 1, triggerType: "label", loaded: loadedField({ flow: { tier: "trigger", package: null }, sources: [source("overlay"), source("repository", { skills: 1 }), source("trigger", { skills: 1 }), source("other")], tools: { active: 3, own: ["read", "edit", "write"], job: [] }, leftOut: { tools: ["bash"], packages: true, overlayExtensions: false, restricted: false } }) }),
  leftOutOverlay: () => loadedRecord({ jobId: "gl-af91", kind: "gitlab", target: "acme/billing-ui!403", project: "billing", flow: "review", host: "mini2", triggerIndex: 3, triggerType: "pull_request", loaded: loadedField({ leftOut: { tools: [], packages: false, overlayExtensions: true, restricted: false } }) }),
  mcpConnected: () => loadedRecord({ jobId: "gh-2f6a", target: "acme/api#131", project: "api", flow: "triage", reason: "awaiting-input", triggerIndex: 6, triggerType: "label", loaded: loadedField({ mcp: [{ name: "linear", state: "connected", tools: 12 }], tools: { active: 22, own: ["read", "bash", "edit", "write"], job: ["await_human_input", "codemode", "tool_search"] } }) }),
  dropped: () => loadedRecord({ jobId: "gh-4add", target: "acme/web#489", loaded: loadedField({ sources: [...STAGED, source("overlay"), source("repository", { skills: 3, dropped: 1 }), source("trigger"), source("other")], problems: { failed: 0, dropped: 1, mcp: 0 } }) }),
  cut: () => loadedRecord({ jobId: "gh-a3ac", target: "acme/web#487", loaded: loadedField({ cut: { form: "compact", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [source("package", { extensions: 2, skills: 1, prompts: 1, tools: 5, shadowed: 1, toolNames: null }), source("overlay", { names: null, failedNames: null, namedTools: null }), source("repository", { skills: 3 }), source("trigger"), source("other")], tools: { active: 10, own: null, job: null } }) }),
  noFlow: () => loadedRecord({ jobId: "gh-03a9", target: "acme/api#122", project: "api", host: "mini2", loaded: loadedField({ flow: { tier: "none", package: null }, sources: [...STAGED, source("overlay"), source("repository"), source("trigger"), source("other")] }) }),
  extensionFailed: () => loadedRecord({ jobId: "gh-444c", target: "acme/api#120", project: "api", host: "mini2", loaded: loadedField({ sources: [...STAGED, source("overlay"), source("repository", { skills: 3, extensions: 1, failed: 1 }), source("trigger"), source("other")], problems: { failed: 1, dropped: 0, mcp: 0 } }) }),
  mcpFailed: () => loadedRecord({ jobId: "gh-6b0d", target: "acme/api#133", project: "api", flow: "triage", outcome: "policy", reason: "mcp-unavailable", exitCode: 2, triggerIndex: 6, triggerType: "label", tokens: null, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "failed", tools: 0 }], problems: { failed: 0, dropped: 0, mcp: 1 } }) }),
  mcpTimeout: () => loadedRecord({ jobId: "gh-4b12", target: "acme/api#132", project: "api", flow: "triage", outcome: "failed", reason: "container-infra-exit", exitCode: 1, attempt: 3, triggerIndex: 6, triggerType: "label", tokens: null, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "timeout", tools: 0 }], problems: { failed: 0, dropped: 0, mcp: 1 } }) }),
  hostDiffers: () => loadedRecord({ jobId: "gh-ebd7", target: "acme/billing#259", project: "billing", host: "build3", backend: "podman", loaded: loadedField({ sources: [...STAGED, source("overlay", { names: ["git-guard"], extensions: 1 }), source("repository", { skills: 3 }), source("trigger"), source("other")] }) }),
  notRecorded: () => { const { loaded: _loaded, ...older } = loadedRecord({ jobId: "gh-c3f8", target: "acme/billing#253", project: "billing", host: "build3", backend: "podman" }); return older; },
  refused: () => { const { loaded: _loaded, ...refused } = loadedRecord({ jobId: "gh-e9a0", target: "acme/billing#260", project: "billing", host: "build3", backend: "podman", outcome: "policy", reason: "egress-proxy-missing", exitCode: null, tokens: null, dollars: null, budgetReserved: false }); return refused; },
});

/** What the hosts published, as `readHostLoadsView` hands it: mini1 at the doctor run the card quotes, mini2 with nothing, build3 with its overlay. */
export const HOST_LOADS = Object.freeze({
  more: 0,
  hosts: [
    { name: "build3", state: "current", ageMs: HOUR, at: NOW - HOUR, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, extensions: [{ name: "git-guard", kind: "dir" }], skills: ["review"], mcp: [], packages: [{ name: "pi-lint", version: "1.4.2" }, { name: "pi-test-runner", version: "0.9.0" }], flows: [], unread: [], more: {}, image: "pi-job:4.3.1", piVersion: "1.5.0" },
    { name: "mini1", state: "current", ageMs: HOUR, at: NOW - HOUR, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, extensions: [], skills: ["review"], mcp: [], packages: [{ name: "pi-lint", version: "1.4.2" }, { name: "pi-test-runner", version: "0.9.0" }], flows: [], unread: [], more: {}, image: "pi-job:4.3.1", piVersion: "1.5.0" },
    { name: "mini2", state: "unknown", why: "absent", image: "pi-job:4.3.1", piVersion: "1.5.0" },
  ],
});

const at = (ago) => new Date(NOW - ago).toISOString();

/** The ProjectLoads card's billing: 18 runs on build3, 15 recorded, and 6 on mini2, all recorded. */
export function billingRecords() {
  const build3 = (i) => loadedRecord({ jobId: `gh-b${String(i).padStart(3, "0")}`, target: `acme/billing#${200 + i}`, project: "billing", host: "build3", backend: "podman", startedAt: at((i + 2) * HOUR), endedAt: at((i + 1) * HOUR), loaded: loadedField({ sources: [...STAGED, source("overlay", { names: ["git-guard"], extensions: 1 }), source("repository", { skills: 3 }), source("trigger"), source("other")] }) });
  const mini2 = (i) => loadedRecord({ jobId: `gl-m${String(i).padStart(3, "0")}`, kind: "gitlab", target: `acme/billing-ui!${400 + i}`, project: "billing", host: "mini2", backend: "local", flow: "review", triggerIndex: 3, startedAt: at((i + 2) * HOUR), endedAt: at((i + 1) * HOUR), loaded: loadedField({ flow: { tier: "overlay", package: null } }) });
  const { loaded: _a, ...refused } = loadedRecord({ jobId: "gh-e9a0", target: "acme/billing#260", project: "billing", host: "build3", backend: "podman", outcome: "policy", reason: "egress-proxy-missing", exitCode: null, tokens: null, endedAt: at(9 * MIN) });
  const { loaded: _b, ...older } = loadedRecord({ jobId: "gh-c3f8", target: "acme/billing#253", project: "billing", host: "build3", backend: "podman", endedAt: at(30 * HOUR) });
  const stopped = loadedRecord({ jobId: "gh-4a7e", target: "acme/billing#290", project: "billing", host: "build3", backend: "podman", outcome: "policy", reason: "operator-cancel", exitCode: 137, tokens: null, endedAt: at(4 * HOUR + 40 * MIN), loaded: recordedLoaded({ v: 1, runner: "absent", image: "pi-job:4.3.1", imageDigest: DIGEST, imagePi: "1.5.0" }) });
  return [refused, stopped, ...Array.from({ length: 15 }, (_, i) => build3(i)), ...Array.from({ length: 6 }, (_, i) => mini2(i)), older];
}

/** web: mini1 and mini2 load the same, but for trigger 2's, which withhold them, and the canary gh-c0a7. */
export function webRecords() {
  const run = (i, host) => loadedRecord({ jobId: `gh-w${String(i).padStart(3, "0")}`, target: `acme/web#${500 + i}`, host, startedAt: at((i + 2) * HOUR), endedAt: at((i + 1) * HOUR) });
  const withheld = loadedRecord({ jobId: "gh-8251-r2", target: "acme/web#408", flow: "frontend-fix", host: "mini2", triggerIndex: 1, loaded: LOADED_SAMPLES.leftOut().loaded });
  const canary = loadedRecord({ jobId: "gh-c0a7", target: "acme/web#493", packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" }, loaded: loadedField({ sources: [source("package", { name: "pi-lint", version: "1.4.3", extensions: 1, prompts: 1, tools: 2, toolNames: ["lint_file", "lint_fix"] }), PI_TEST_RUNNER, source("overlay"), source("repository", { skills: 3 }), source("trigger"), source("other")] }) });
  return [...Array.from({ length: 6 }, (_, i) => run(i, i % 2 === 0 ? "mini1" : "mini2")), withheld, canary];
}

/** billing, while most of its runs have no record: 9 of 24, the rest split as the card's line says. */
export function incompleteRecords() {
  const records = billingRecords();
  const read = records.filter((record) => record.loaded?.runner === "reported").slice(0, 9);
  const older = Array.from({ length: 12 }, (_, i) => { const { loaded: _l, ...row } = loadedRecord({ jobId: `gh-o${String(i).padStart(3, "0")}`, target: `acme/billing#${100 + i}`, project: "billing", host: "build3", backend: "podman" }); return row; });
  const refused = Array.from({ length: 2 }, (_, i) => { const { loaded: _l, ...row } = loadedRecord({ jobId: `gh-r${String(i).padStart(3, "0")}`, target: `acme/billing#${120 + i}`, project: "billing", host: "build3", outcome: "policy", reason: "egress-proxy-missing", exitCode: null, tokens: null }); return row; });
  const stopped = records.find((record) => record.jobId === "gh-4a7e");
  return [...read, ...refused, stopped, ...older];
}

/** A name the worker's rebuild refuses: nothing of it may reach a page. */
export const SCRIPT = "<script>alert(1)</script>";

/** Every shape a damaged or hostile `loaded` can take. */
export const HOSTILE_LOADED = Object.freeze([
  "a string", 7, true, [], [1, 2], {},
  { v: 1 }, { v: 2, runner: "reported" }, { v: 1, runner: "nonsense" }, { v: "1", runner: "reported" },
  { ...loadedField(), sources: "no" }, { ...loadedField(), sources: [null] }, { ...loadedField(), sources: [{ tier: "package", name: SCRIPT, version: "1.0.0" }] },
  { ...loadedField(), sources: [source("package", { name: SCRIPT, version: "1.0.0" })] }, { ...loadedField(), sources: [source("overlay", { names: [SCRIPT] })] },
  { ...loadedField(), sources: [source("overlay", { namedTools: [{ name: "a", tools: [SCRIPT] }] })] },
  { ...loadedField(), flow: { tier: SCRIPT, package: null } }, { ...loadedField(), flow: { tier: "package", package: SCRIPT } },
  { ...loadedField(), mcp: [{ name: SCRIPT, state: "failed", tools: 0 }] }, { ...loadedField(), mcp: [{ name: "linear", state: SCRIPT, tools: 0 }] }, { ...loadedField(), mcp: [{ name: "linear", state: "failed", tools: -1 }] },
  { ...loadedField(), tools: { active: "x", own: null, job: null } }, { ...loadedField(), tools: { active: 1, own: [SCRIPT], job: null } }, { ...loadedField(), tools: { active: 1, own: null, job: [SCRIPT] } },
  { ...loadedField(), problems: { failed: "many", dropped: 0, mcp: 0 } }, { ...loadedField(), leftOut: { tools: [SCRIPT], packages: false, overlayExtensions: false, restricted: false } },
  { ...loadedField(), cut: { form: SCRIPT, packages: 0, servers: 0, names: 0, counts: 0 } }, { ...loadedField(), pi: SCRIPT }, { ...loadedField(), at: SCRIPT },
]);
