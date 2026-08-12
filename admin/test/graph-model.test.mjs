import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseSkillMeta, findSiblingMentions } from "../src/graph-model.mjs";

test("graph-model.mjs is pure: no fs, no child_process, no redis, no queue, no env", () => {
  // The purity guard comes FIRST (the render.mjs/panel.mjs/costs.mjs pattern): this module receives
  // bytes and returns meaning, and the day it grows an import is the day the graph stops being
  // testable offline and the read-model stops being the admin's one I/O funnel.
  const src = readFileSync(fileURLToPath(new URL("../src/graph-model.mjs", import.meta.url)), "utf8");
  assert.ok(!/node:fs|node:child_process|ioredis|bullmq|process\.env|readFileSync|execFile/.test(src), "graph-model must stay pure");
});

// ---- parseSkillMeta ----

test("parseSkillMeta reads name and description from the leading frontmatter", () => {
  const meta = parseSkillMeta('---\nname: tidy\ndescription: Format and fix lint.\nai-trigger: allow\n---\nBody.\n');
  assert.deepEqual(meta, { name: "tidy", description: "Format and fix lint." });
});

test("parseSkillMeta strips a BOM, normalises CRLF, and unwraps double quotes", () => {
  const meta = parseSkillMeta('\uFEFF---\r\nname: "quoted name"\r\ndescription: d\r\n---\r\n');
  assert.deepEqual(meta, { name: "quoted name", description: "d" });
});

test("parseSkillMeta returns nulls for absent frontmatter, absent keys, and non-strings", () => {
  const empty = { name: null, description: null };
  assert.deepEqual(parseSkillMeta("no frontmatter here"), empty);
  assert.deepEqual(parseSkillMeta("---\nother: x\n---\n"), empty);
  assert.deepEqual(parseSkillMeta(""), empty);
  assert.deepEqual(parseSkillMeta(null), empty);
  assert.deepEqual(parseSkillMeta(42), empty);
});

test("parseSkillMeta clips a hostile oversized value rather than refusing the skill", () => {
  const meta = parseSkillMeta(`---\nname: ${"x".repeat(500)}\n---\n`);
  assert.equal(meta.name.length, 121, "120 chars plus the ellipsis");
  assert.ok(meta.name.endsWith("…"));
});

test("parseSkillMeta reads only the LEADING block, never a --- fence later in the body", () => {
  const meta = parseSkillMeta("Body first.\n---\nname: sneaky\n---\n");
  assert.deepEqual(meta, { name: null, description: null }, "frontmatter is leading-only, like the gate's scanner");
});

// ---- findSiblingMentions ----

test("findSiblingMentions finds word-boundary sibling names and misses substrings", () => {
  const text = "After the build finishes, chain the open-pr flow. Nothing here says prefix-fix.";
  const mentions = findSiblingMentions(text, ["open-pr", "fix", "absent-skill"]);
  assert.deepEqual(
    mentions.map((m) => m.name),
    ["open-pr"],
    "fix must not fire inside prefix-fix, and absent names must not appear",
  );
});

test("findSiblingMentions marks a mention strong only near chaining vocabulary", () => {
  const strong = findSiblingMentions('Write /outbox/request-1.json with {"flow": "open-pr"}.', ["open-pr"]);
  assert.deepEqual(strong, [{ name: "open-pr", strong: true }]);

  const weak = findSiblingMentions(`See also the open-pr skill for context.${" filler".repeat(60)} outbox`, ["open-pr"]);
  assert.deepEqual(weak, [{ name: "open-pr", strong: false }], "vocabulary beyond the radius must not promote the mention");
});

test("findSiblingMentions is total: bad inputs yield [], and a self-shaped name list is fine", () => {
  assert.deepEqual(findSiblingMentions(null, ["a"]), []);
  assert.deepEqual(findSiblingMentions("text", null), []);
  assert.deepEqual(findSiblingMentions("text", [42, "", null]), []);
});

// ---- buildGraphModel (the assembler; DES-GRAPH-EDGE-DERIVATION's honesty rules live here) ----

import { buildGraphModel, GRAPH_EDGE_KINDS, GRAPH_FLAGS } from "../src/graph-model.mjs";

test("the edge and flag vocabularies are the LITERAL closed sets, frozen", () => {
  // Every consumer switches on these strings; a producer minting a new one without a renderer arm
  // must go red HERE, not render as nothing. Change these on purpose and say why in the commit body.
  assert.deepEqual([...GRAPH_EDGE_KINDS], ["config", "observed", "potential", "cron-rearm"]);
  assert.deepEqual(
    [...GRAPH_FLAGS],
    ["no-skill", "charset-invalid", "orphan", "ai-reachable-no-trigger", "injected-ai-trigger", "unread", "pr-spend-loop-risk"],
  );
  assert.ok(Object.isFrozen(GRAPH_EDGE_KINDS) && Object.isFrozen(GRAPH_FLAGS));
});

// One canned deployment the assembler tests share: a local folder with a healthy chain pair, an
// orphan, an AI-reachable skill, a sub-skill, plus a github label trigger and a dangling cron.
const CANNED = () => ({
  triggers: {
    triggers: [
      { type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/site", flow: "build-report", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
      { type: "label", index: 1, any: ["ai"], all: [], none: [], flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
      { type: "cron", index: 2, id: "gone", pattern: "0 4 * * *", folder: "/srv/site", flow: "deleted-flow", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
    ],
  },
  schedulers: [{ key: "nightly", name: "nightly", pattern: "0 3 * * *", every: null, next: "2026-08-12T03:00:00.000Z", overdueMs: null }],
  folderSkills: {
    "/srv/site": {
      head: "abc123",
      truncated: false,
      unreachable: null,
      skills: [
        { name: "build-report", isSub: false, group: null, aiTrigger: true, meta: { name: "build-report", description: "d" }, mentions: [{ name: "notify", strong: true }], unread: false },
        { name: "notify", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false },
        { name: "old-import", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group/sub", isSub: true, group: "group", aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
      ],
    },
  },
  injectedSkills: { "/inj": { skills: [{ name: "tidy", aiTrigger: true }], truncated: false, unreachable: null } },
  cronStats: { byId: { nightly: { runs: 41, lastOutcome: "completed", lastEndedAt: "2026-08-11T00:00:00.000Z" }, gone: { runs: 0, lastOutcome: null, lastEndedAt: null } } },
  runJoin: { byIndex: { 1: { runs: 12, lastOutcome: "completed", lastEndedAt: "2026-08-11T01:00:00.000Z" } }, unattributed: 2 },
  chainEdges: { edges: [{ parentFlow: "build-report", childFlow: "notify", target: "local:site", count: 3, lastEndedAt: "2026-08-10T00:00:00.000Z" }], refusals: { "build-report": 1 }, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
  nowMs: 1770000000000,
});

test("buildGraphModel: config edges always, cron joins by id, forge joins by persisted index", () => {
  const m = buildGraphModel(CANNED());
  const configs = m.edges.filter((e) => e.kind === "config");
  assert.equal(configs.length, 3, "every trigger naming a flow gets its config edge, dangling included");

  const nightly = m.nodes.find((n) => n.id === "trigger:0");
  assert.equal(nightly.runs, 41, "cron stats join by scheduler id");
  assert.equal(nightly.next, "2026-08-12T03:00:00.000Z", "the resident scheduler's next fire rides the node");

  const label = m.nodes.find((n) => n.id === "trigger:1");
  assert.equal(label.runs, 12, "forge stats join by the persisted raw index");
  assert.equal(label.folderKey, "forge:github");

  const forgeGroup = m.folders.find((f) => f.key === "forge:github");
  assert.equal(forgeGroup.unreachable, "remote-repo", "a forge repo is not on this host; its skills are unverifiable, not dangling");
  const forgeFlow = m.nodes.find((n) => n.id === "skill:forge:github:triage");
  assert.equal(forgeFlow.kind, "skill-unverified", "an unverified flow is a DIFFERENT kind from skill-missing, on purpose");
});

test("buildGraphModel: dangling is precise -- no-skill only where enumeration SUCCEEDED", () => {
  const m = buildGraphModel(CANNED());
  const flags = m.flags.filter((f) => f.flag === "no-skill");
  assert.deepEqual(flags.map((f) => f.nodeId), ["trigger:2"], "only the cron whose enumerated folder lacks the flow");
  assert.ok(m.nodes.some((n) => n.id === "skill:folder:/srv/site:deleted-flow" && n.kind === "skill-missing"), "the dangling edge still has a visible end");

  // The negative claim: an UNREACHABLE folder must produce zero dangling flags.
  const inputs = CANNED();
  inputs.folderSkills["/srv/site"] = { head: null, skills: [], truncated: false, unreachable: "not-a-git-repo" };
  const m2 = buildGraphModel(inputs);
  assert.equal(m2.flags.filter((f) => f.flag === "no-skill").length, 0, "a read that never happened proves nothing (deny != no-skill)");
  assert.equal(m2.edges.filter((e) => e.kind === "config").length, 3, "the config edges still draw; the folder says unverified instead");
});

test("buildGraphModel: charset-invalid run.flow is its own flag, distinct from no-skill", () => {
  const inputs = CANNED();
  inputs.triggers.triggers.push({ type: "cron", index: 3, id: "bad", pattern: "0 5 * * *", folder: "/srv/site", flow: "Tidy/../up", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
  const m = buildGraphModel(inputs);
  const flag = m.flags.find((f) => f.flag === "charset-invalid");
  assert.equal(flag.nodeId, "trigger:3");
  assert.equal(m.flags.filter((f) => f.flag === "no-skill" && f.nodeId === "trigger:3").length, 0, "invalid-name never doubles as no-skill: the gate would answer deny, not no-skill");
});

test("buildGraphModel: observed edges come only from records, potential only from mentions, and they never blur", () => {
  const m = buildGraphModel(CANNED());
  const observed = m.edges.filter((e) => e.kind === "observed");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].count, 3, "an observed edge carries its count; that is what observed MEANS");
  assert.equal(observed[0].from, "skill:folder:/srv/site:build-report");
  assert.equal(observed[0].to, "skill:folder:/srv/site:notify");

  const potential = m.edges.filter((e) => e.kind === "potential");
  assert.equal(potential.length, 1);
  assert.deepEqual(
    { strong: potential[0].strong, eligible: potential[0].eligible },
    { strong: true, eligible: true },
    "a mention is labelled by its evidence; eligibility is the target's own gate fact",
  );
  assert.equal("count" in potential[0], false, "a potential edge NEVER carries a count -- counts are what observed means");

  // Gate-eligibility alone draws NO edge: notify allows ai-trigger but mentions nobody, so there is
  // no notify -> * potential edge. Eligibility is a node badge, not an all-pairs fabric.
  assert.equal(potential.filter((e) => e.from === "skill:folder:/srv/site:notify").length, 0);
});

test("buildGraphModel: an observed edge with no unique folder to hang on is DROPPED and counted, never guessed", () => {
  const inputs = CANNED();
  inputs.chainEdges.edges.push({ parentFlow: "a", childFlow: "b", target: "local:elsewhere", count: 1, lastEndedAt: null });
  const m = buildGraphModel(inputs);
  assert.equal(m.edges.filter((e) => e.kind === "observed").length, 1, "only the resolvable edge draws");
  assert.equal(m.meta.droppedObservedEdges, 1, "the drop is counted, because a silent drop reads as covered-everything");
});

test("buildGraphModel: cron-rearm is the one config self-edge, labelled with the pattern", () => {
  const m = buildGraphModel(CANNED());
  const rearms = m.edges.filter((e) => e.kind === "cron-rearm");
  assert.deepEqual(
    rearms.map((e) => [e.from, e.to, e.label]),
    [["trigger:0", "trigger:0", "0 3 * * *"], ["trigger:2", "trigger:2", "0 4 * * *"]],
    "every cron trigger re-arms by definition; webhook triggers never do",
  );
});

test("buildGraphModel: orphan and AI-reachable are distinct facts, sub-skills are neither", () => {
  const m = buildGraphModel(CANNED());
  const flagsFor = (id) => m.flags.filter((f) => f.nodeId === id).map((f) => f.flag);
  assert.deepEqual(flagsFor("skill:folder:/srv/site:old-import"), ["orphan"], "no trigger, no ai-trigger, no mention: dead by every path");
  assert.deepEqual(flagsFor("skill:folder:/srv/site:notify"), ["ai-reachable-no-trigger"], "ai-trigger: allow keeps it reachable, so it is NOT an orphan");
  assert.deepEqual(flagsFor("skill:folder:/srv/site:group/sub"), [], "a sub-skill can never be a flow, so it is never an orphan candidate");
  assert.deepEqual(flagsFor("injected:/inj:tidy"), ["injected-ai-trigger"], "the OQ-022 silent no-op badges loudly here");
});

test("buildGraphModel: the pr-spend-loop signature badges pull_request triggers on opened/synchronize", () => {
  const inputs = CANNED();
  inputs.triggers.triggers.push({ type: "pull_request", index: 3, action: ["opened", "synchronize"], any: [], all: [], none: [], flow: "review", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" });
  const m = buildGraphModel(inputs);
  assert.deepEqual(m.flags.filter((f) => f.flag === "pr-spend-loop-risk").map((f) => f.nodeId), ["trigger:3"]);
});

test("buildGraphModel: caps ride every model, and a cron folder outside the enumeration still draws", () => {
  const m = buildGraphModel(CANNED());
  assert.deepEqual(m.caps, { chainDepthMax: 1, chainMaxPerJob: 2, sameFolderOnly: true, windowDays: 30 });

  const inputs = CANNED();
  inputs.triggers.triggers.push({ type: "cron", index: 3, id: "x", pattern: "0 6 * * *", folder: "/srv/unscanned", flow: "f", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
  const m2 = buildGraphModel(inputs);
  const group = m2.folders.find((f) => f.path === "/srv/unscanned");
  assert.equal(group.unreachable, "not-enumerated", "the folder cap must not silently lose a trigger's edge");
  assert.ok(m2.edges.some((e) => e.from === "trigger:3" && e.kind === "config"));
  assert.equal(m2.flags.filter((f) => f.nodeId === "trigger:3" && f.flag === "no-skill").length, 0, "and no dangling flag attaches to a read that never happened");
});

test("buildGraphModel is total: empty and malformed inputs yield an empty well-formed model", () => {
  for (const input of [undefined, {}, { triggers: { missing: true } }, { triggers: { invalid: "nope" }, chainEdges: "x", folderSkills: null }]) {
    const m = buildGraphModel(input);
    assert.deepEqual(m.nodes, []);
    assert.deepEqual(m.edges, []);
    assert.equal(m.caps.sameFolderOnly, true, "the same-folder rule is structural, stated even on an empty model");
  }
  assert.equal(buildGraphModel({ triggers: { missing: true } }).meta.triggersMissing, true);
  assert.equal(buildGraphModel({ triggers: { invalid: "bad json" } }).meta.triggersInvalid, "bad json");
});

test("buildGraphModel: meta carries the honesty counters (unattributed, refusals, truncation)", () => {
  const m = buildGraphModel(CANNED());
  assert.equal(m.meta.unattributedRuns, 2, "runs the current triggers file cannot claim are said, not hidden");
  assert.deepEqual(m.meta.chainRefusals, { "build-report": 1 });
  assert.deepEqual(m.meta.truncated, { folders: false, skills: false, edges: false });
  assert.equal(m.meta.generatedAt, 1770000000000);
});

// ---- review-driven honesty hardening (adversarial + code review findings) ----

test("an observed edge into an UNREACHABLE folder is dropped and counted, never phantom-badged", () => {
  // Without this, the edge minted skill-missing endpoints off a read that never happened -- a red
  // "[missing at HEAD]" on a folder whose HEAD was never read -- and the renderers then skipped the
  // edge row anyway, with droppedObservedEdges still claiming zero (review finding).
  const inputs = CANNED();
  inputs.folderSkills["/srv/site"] = { head: null, skills: [], truncated: false, unreachable: "not-a-git-repo" };
  const m = buildGraphModel(inputs);
  assert.equal(m.edges.filter((e) => e.kind === "observed").length, 0, "no observed edge hangs on an unreadable folder");
  assert.equal(m.meta.droppedObservedEdges, 1, "and the drop is counted, not silent");
  assert.equal(m.nodes.filter((n) => n.kind === "skill-missing").length, 0, "no phantom missing-at-HEAD endpoints");
});

test("a cron entry with no folder still draws its trigger and config edge, on a group that says so", () => {
  const inputs = CANNED();
  inputs.triggers.triggers.push({ type: "cron", index: 3, id: "broken", pattern: "0 5 * * *", folder: null, flow: "f", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
  const m = buildGraphModel(inputs);
  const group = m.folders.find((f) => f.key === "folder:(none)");
  assert.equal(group.unreachable, "no-folder", "the broken entry is exactly what an operator needs to see");
  assert.ok(m.edges.some((e) => e.from === "trigger:3" && e.kind === "config"), "every trigger naming a flow gets its edge, ALWAYS");
});

test("an unreadable injected skills dir surfaces in meta, so the OQ-022 badge cannot silently vanish", () => {
  const inputs = CANNED();
  inputs.injectedSkills["/broken"] = { skills: [], truncated: false, unreachable: "unreadable" };
  const m = buildGraphModel(inputs);
  assert.deepEqual(m.meta.injectedUnreachable, ["/broken"]);
  assert.deepEqual(buildGraphModel(CANNED()).meta.injectedUnreachable, [], "readable dirs report nothing");
});

test("collectGraphInputs' folder cap flag reaches meta.truncated.folders", () => {
  // It was hardcoded false, so the cap-reached banner could never fire on any surface (review finding).
  const m = buildGraphModel({ ...CANNED(), foldersTruncated: true });
  assert.equal(m.meta.truncated.folders, true);
});

test("findSiblingMentions marks strong on ANY occurrence near the vocabulary, not only the first", () => {
  const text = `See the notify skill for background.${" filler".repeat(60)} Then write /outbox/request-1.json with {"flow": "notify"}.`;
  assert.deepEqual(findSiblingMentions(text, ["notify"]), [{ name: "notify", strong: true }], "an early weak mention must not mask a later strong one");
});

// ---- loop hints and forge scope (user feedback round) ----

import { findLoopHints } from "../src/graph-model.mjs";

test("findLoopHints reads iteration phrases from the BODY, never the frontmatter, deduped and capped", () => {
  const md = '---\nname: x\ndescription: repeat daily\n---\nBuild it. Iterate until it renders right. Then loop over the pages. Iterate until it renders right.\n';
  assert.deepEqual(findLoopHints(md), [
    { hint: "Iterate until it renders right" },
    { hint: "loop over the pages" },
  ], "body phrases only, deduped ('Iterate until …' consumes its own 'until'); the frontmatter's 'repeat daily' must not read as a loop");
  assert.deepEqual(findLoopHints("no iteration here, plain prose."), []);
  assert.deepEqual(findLoopHints(null), []);
});

test("triggerCosts is a node FACT: the mapped typed cost rides its trigger node, absence is null (issue #175)", () => {
  const withCosts = buildGraphModel({
    ...CANNED(),
    triggerCosts: { "trigger:0": { cost: { usd: 4.05, class: "estimated", floor: false }, runs: 41 } },
  });
  assert.deepEqual(
    withCosts.nodes.find((n) => n.id === "trigger:0").cost,
    { usd: 4.05, class: "estimated", floor: false },
    "the typed dollar rides whole -- usd, class, floor -- so renderers keep the fmtCost discipline",
  );
  assert.equal(withCosts.nodes.find((n) => n.id === "trigger:1").cost, null, "no map entry, no claim");
  assert.equal(buildGraphModel(CANNED()).nodes.find((n) => n.id === "trigger:0").cost, null, "no map wired at all, same null");
  // Spend is a fact, not a flag or an edge: the closed vocabularies must not have grown for it.
  assert.deepEqual([...GRAPH_EDGE_KINDS], ["config", "observed", "potential", "cron-rearm"]);
  assert.ok(!GRAPH_FLAGS.includes("spend"), "no spend flag exists");
});

test("skill nodes carry their loops, and forge groups carry their record-derived repos", () => {
  const inputs = CANNED();
  inputs.folderSkills["/srv/site"].skills[0].loops = [{ hint: "until the report renders right" }];
  inputs.forgeRepos = { github: ["acme/website"] };
  const m = buildGraphModel(inputs);
  assert.deepEqual(m.nodes.find((n) => n.id === "skill:folder:/srv/site:build-report").loops, [{ hint: "until the report renders right" }]);
  assert.deepEqual(m.folders.find((f) => f.key === "forge:github").repos, ["acme/website"], "the group says which repos it is ABOUT");
  assert.deepEqual(buildGraphModel(CANNED()).folders.find((f) => f.key === "forge:github").repos, [], "no records, no claim");
});
