/**
 * The PURE side of the trigger/flow graph (issue #54): text scanners over skill content, and the
 * model assembler every graph consumer renders from. No fs, no child_process, no redis, no queue,
 * no env -- read-model.mjs supplies bytes and joins, this module supplies meaning. The purity is
 * enforced by a source-regex test, the render.mjs/panel.mjs/costs.mjs pattern.
 */

// SKILL_NAME_RE is a plain frozen RegExp; importing it keeps the charset single-sourced (the
// issue #92 lesson) without breaking this module's purity -- nothing here spawns or reads anything.
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";

// One frontmatter value line: `key: value`, an optional surrounding double quote, single-line only.
// The same block-isolation discipline as flow-gate.mjs's aiTriggerAllows, and deliberately NOT a YAML
// parser for the same recorded reason: two display strings do not justify js-yaml, and a scanner that
// accepts only what it understands cannot be driven into surprising shapes by hostile frontmatter.
const FRONTMATTER_BLOCK_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

// Display values are CLIPPED, not refused: a viewer degrades. 120 chars covers every honest
// name/description and bounds what a hostile one can push into a panel row or an HTML tooltip.
const META_VALUE_MAX_CHARS = 120;

/**
 * Read a skill's display metadata (`name`, `description`) from its SKILL.md frontmatter.
 * Total function: any input shape yields `{ name, description }` with nulls, never a throw.
 */
export function parseSkillMeta(text) {
  const empty = { name: null, description: null };
  if (typeof text !== "string") return empty;
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const block = FRONTMATTER_BLOCK_RE.exec(normalized);
  if (!block) return empty;
  return {
    name: frontmatterValue(block[1], "name"),
    description: frontmatterValue(block[1], "description"),
  };
}

function frontmatterValue(block, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block);
  if (!m) return null;
  let value = m[1].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value === "") return null;
  return value.length > META_VALUE_MAX_CHARS ? `${value.slice(0, META_VALUE_MAX_CHARS)}…` : value;
}

// A mention is "strong" when it sits near chaining vocabulary -- the outbox protocol's own words.
// Distance, not co-occurrence-anywhere: a README-style skill that lists every sibling once should
// not promote all of them to likely chain targets.
const CHAIN_VOCAB_RE = /outbox|request-|"flow"|\bchain\b|follow-up/i;
const CHAIN_VOCAB_RADIUS = 200;

/**
 * Find which sibling skill names a skill's text mentions -- the heuristic half of the potential
 * flow->flow edge (the exact half is the target's own `ai-trigger: allow`). The name space makes
 * this workable where free-text search would not be: SKILL_NAME_RE names are a closed, enumerable
 * set the caller supplies, so this scans for a handful of known literals and nothing else.
 *
 * Boundary-matched against the SKILL NAME charset itself, not `\b`: a skill name may contain `-`,
 * and `\b` calls a hyphen a boundary, so `\bfix\b` would fire inside `prefix-fix` -- the lookarounds
 * refuse any neighbouring name-charset character instead. A name that is also an English word can
 * still false-positive in prose, which is exactly why these edges render as "potential" and never as
 * observed. Returns `[{ name, strong }]` in the callers' name order; total function, never throws.
 */
export function findSiblingMentions(text, siblingNames) {
  if (typeof text !== "string" || !Array.isArray(siblingNames)) return [];
  const mentions = [];
  for (const name of siblingNames) {
    if (typeof name !== "string" || name === "") continue;
    // EVERY occurrence is tested, not only the first (review finding): a skill mentioned early in
    // prose and again beside the outbox vocabulary is a strong mention -- the distance rule is about
    // any co-location, not the first one. Bounded, because a hostile SKILL.md could repeat a name
    // thousands of times and this scan already runs once per sibling.
    const re = new RegExp(`(?<![a-z0-9_-])${escapeRegExp(name)}(?![a-z0-9_-])`, "g");
    let found = false;
    let strong = false;
    let match;
    let occurrences = 0;
    while ((match = re.exec(text)) !== null && occurrences++ < 32) {
      found = true;
      const windowStart = Math.max(0, match.index - CHAIN_VOCAB_RADIUS);
      const windowEnd = Math.min(text.length, match.index + name.length + CHAIN_VOCAB_RADIUS);
      if (CHAIN_VOCAB_RE.test(text.slice(windowStart, windowEnd))) {
        strong = true;
        break;
      }
    }
    if (found) mentions.push({ name, strong });
  }
  return mentions;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The iteration vocabulary a skill's prose can use. There is NO structured loop construct anywhere in
// the system -- a "loop inside a skill" is a sentence telling the agent to iterate -- so a bounded
// phrase scan is the only static evidence that exists, and it renders as exactly that: a hint read
// from the text, never a promise (the potential-edge discipline, applied to a node's insides).
const LOOP_HINT_RE = /\b(?:until|repeat(?:ing)?|iterate(?:s|d)?|loop(?:s|ing)?|while|for each|keep \w+ing|try again)\b[^.\n]{0,60}/gi;
const LOOP_HINT_MAX = 3;

/**
 * Find the iteration phrases in a skill's BODY text (the frontmatter block is stripped first, so a
 * `description: repeat daily` cannot read as a loop). Returns up to LOOP_HINT_MAX `{ hint }` entries,
 * each the matched phrase clipped to its sentence fragment -- the graph groups these INSIDE the
 * skill node, because everything a skill's loop does happens inside that one job, one container, one
 * budget slot (docs/workflows.md). Total function, never throws.
 */
export function findLoopHints(text) {
  if (typeof text !== "string") return [];
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const body = normalized.replace(FRONTMATTER_BLOCK_RE, "");
  const hints = [];
  const seen = new Set();
  let match;
  LOOP_HINT_RE.lastIndex = 0;
  while ((match = LOOP_HINT_RE.exec(body)) !== null && hints.length < LOOP_HINT_MAX) {
    const hint = match[0].trim();
    const key = hint.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ hint });
  }
  return hints;
}

// The closed edge and flag vocabularies. Closed on purpose and pinned in the tests: every consumer
// (the text renderer, the TUI view, the HTML export) switches on these strings, and a producer
// minting a new one without a renderer arm should go red in a unit test, not render as nothing.
export const GRAPH_EDGE_KINDS = Object.freeze(["config", "observed", "potential", "cron-rearm"]);
export const GRAPH_FLAGS = Object.freeze([
  "no-skill", // config edge target absent in EVERY checkable applicable tier (readFlowGate's precise token, now with the full ladder behind it)
  "charset-invalid", // run.flow fails SKILL_NAME_RE: can never materialise, a distinct defect from no-skill
  "orphan", // no trigger, no ai-trigger, no incoming mention: dead by every path the system has
  "ai-reachable-no-trigger", // no trigger but ai-trigger: allow -- deliberately chain/dispatch_run-reachable
  "injected-ai-trigger", // an injected skill carrying ai-trigger: allow is a silent no-op (OQ-022)
  "unread", // SKILL.md unreadable/oversized at enumeration: facts unknown, gate read as closed
  "pr-spend-loop-risk", // pull_request on opened/synchronize: the OQ-020 cross-actor spend-loop signature
]);
// The node kinds, closed and pinned like the two vocabularies above since issue #188 grew them: a
// renderer meets every one of these or a new producer goes red in a unit test. The edge and flag sets
// are BYTE-UNCHANGED by that issue -- REQ-TOPOLOGY-GRAPH (h)'s "the closed vocabularies stay closed"
// holds literally; resolution honesty lives in kinds and node facts, never in a new flag.
export const GRAPH_NODE_KINDS = Object.freeze([
  "trigger",
  "skill", // committed at HEAD in an enumerated folder
  "skill-missing", // absent in every checkable applicable tier: the one red, dangling state
  "skill-unverified", // the folder itself was never readable (forge/remote): a read that never happened
  "skill-not-at-head", // absent at HEAD, but some lower tier was not checkable from this session
  "injected", // run.skillsDir working-tree skill: trigger-reachable, never AI-reachable
  "overlay", // deployment overlay skills/: trigger-reachable, never AI-reachable
  "staged", // a staged pi package's skill: trigger-reachable, never AI-reachable
]);

// The ladder's tier names, one vocabulary for `tiersUnknown` and the no-skill detail text; doctor's
// per-trigger flow lines spell the same tiers so an operator can cross-read the two surfaces.
const TIER_INJECTED = "injected run.skillsDir";
const TIER_OVERLAY = "overlay skills/";
const TIER_STAGED = "staged packages";

/**
 * Assemble the graph model every consumer renders from. Pure fold over the read-model's outputs --
 * this function performs no I/O, applies the EDGE HONESTY RULES (DES-GRAPH-EDGE-DERIVATION), and is
 * the single place they live:
 *
 *   - every trigger with a `run.flow` gets exactly one `config` edge, always;
 *   - `observed` edges come only from run records (they carry count + lastEndedAt);
 *   - `potential` edges come only from a text mention, labelled `strong`/`eligible`, and eligibility
 *     is a NODE badge (`aiTrigger`), never an all-pairs edge;
 *   - `cron-rearm` is the one self-edge every cron trigger carries by definition;
 *   - no chain edge is ever drawn out of a forge trigger's flow or across folders -- the harness
 *     makes both unrepresentable (OQ-009), and drawing either would draw a lie;
 *   - an UNREACHABLE folder produces zero dangling flags ("unverified" is not "dangling": deny and
 *     no-skill are different facts, and a read that never happened proves neither);
 *   - `caps` ride every model, because a consumer that renders edges without their bounds invites
 *     the reader to extrapolate an unbounded chain fabric out of a depth-1, width-2 reality.
 *
 * Total function: absent or malformed inputs degrade to an empty-but-well-formed model, never a
 * throw (the read-model's viewer doctrine, one layer up).
 */
export function buildGraphModel({ triggers, schedulers, folderSkills, injectedSkills, overlaySkills, stagedSkills, foldersTruncated, forgeRepos, cronStats, runJoin, chainEdges, caps, nowMs, triggerCosts } = {}) {
  const triggerList = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const schedulerList = Array.isArray(schedulers) ? schedulers : [];
  const folders = folderSkills && typeof folderSkills === "object" ? folderSkills : {};
  const injected = injectedSkills && typeof injectedSkills === "object" ? injectedSkills : {};
  // The two deployment-wide skill tiers (issue #188). Null OR malformed reads as "tier not checkable
  // from this session" -- the deployment pointer cannot carry PI_GLOBAL_PI_DIR, so a wizard-launched
  // console legitimately sees nothing -- and only a well-formed result can ever produce a known miss:
  // degrading junk to an empty-but-known shape here would re-mint the false red this issue removes.
  const overlay = overlaySkills && typeof overlaySkills === "object" && Array.isArray(overlaySkills.skills) ? overlaySkills : null;
  const staged = stagedSkills && typeof stagedSkills === "object" && Array.isArray(stagedSkills.skills) ? stagedSkills : null;
  const statsById = cronStats?.byId && typeof cronStats.byId === "object" ? cronStats.byId : {};
  const statsByIndex = runJoin?.byIndex && typeof runJoin.byIndex === "object" ? runJoin.byIndex : {};
  const observed = Array.isArray(chainEdges?.edges) ? chainEdges.edges : [];
  // The per-trigger spend map (costs.mjs foldTriggerCosts), keyed by this module's own node ids.
  // Spend is a node FACT like runs/lastOutcome -- no new edge kind, no new flag: the closed
  // vocabularies stay closed, and a fold that wires no costs simply grows no badges.
  const spendByNode = triggerCosts && typeof triggerCosts === "object" ? triggerCosts : {};

  const model = {
    folders: [],
    nodes: [],
    edges: [],
    flags: [],
    caps: {
      chainDepthMax: Number.isInteger(caps?.chainDepthMax) ? caps.chainDepthMax : null,
      chainMaxPerJob: Number.isInteger(caps?.chainMaxPerJob) ? caps.chainMaxPerJob : null,
      sameFolderOnly: true,
      windowDays: Number.isInteger(caps?.windowDays) ? caps.windowDays : null,
    },
    meta: {
      generatedAt: Number.isFinite(nowMs) ? nowMs : null,
      triggersMissing: triggers?.missing === true,
      triggersInvalid: typeof triggers?.invalid === "string" ? triggers.invalid : null,
      unattributedRuns: Number.isInteger(runJoin?.unattributed) ? runJoin.unattributed : 0,
      chainRefusals: chainEdges?.refusals && typeof chainEdges.refusals === "object" ? chainEdges.refusals : {},
      truncated: {
        // collectGraphInputs' cap flag rides its spread into this input (review finding: this was
        // hardcoded false, so the cap-reached banner could never fire on any surface).
        folders: foldersTruncated === true,
        skills: Object.values(folders).some((f) => f?.truncated === true) || overlay?.truncated === true || staged?.truncated === true,
        edges: chainEdges?.truncated === true,
      },
      droppedObservedEdges: 0,
      // Injected dirs whose readdir failed (review finding): the OQ-022 badge is the one fact the
      // injected enumeration exists for, and an unreadable dir must not make it silently vanish.
      injectedUnreachable: Object.entries(injected)
        .filter(([, r]) => typeof r?.unreachable === "string")
        .map(([dir]) => dir)
        .sort(),
      // The two tier-honesty counters (issue #188): an overlay whose skills/ failed to read, and the
      // staged packages whose pattern manifests defeat enumeration. Both feed the softened state
      // below AND a banner, because a tier the ladder silently skipped would read as "checked".
      overlayUnreachable: overlay?.unreachable === "unreadable",
      stagedUnenumerable: (Array.isArray(staged?.unenumerable) ? staged.unenumerable : []).filter((p) => typeof p === "string").sort(),
    },
  };

  // ---- folder groups: one per enumerated local folder, one per forge named by a webhook trigger ----
  const folderByPath = new Map();
  for (const [path, result] of Object.entries(folders)) {
    const group = {
      key: `folder:${path}`,
      path,
      label: basenameOf(path),
      kind: "local",
      head: typeof result?.head === "string" ? result.head : null,
      unreachable: typeof result?.unreachable === "string" ? result.unreachable : null,
      triggerIds: [],
      skillIds: [],
    };
    folderByPath.set(path, group);
    model.folders.push(group);
  }
  const forgeGroups = new Map();
  const forgeGroup = (forge) => {
    const name = typeof forge === "string" && forge !== "" ? forge : "forge";
    let group = forgeGroups.get(name);
    if (!group) {
      // A forge trigger's repo is not on this host, so its skills are unverifiable from the admin
      // (readFlowGate needs a local git dir); the group says so instead of growing dangling flags.
      // `repos` names the repositories the window's RECORDS actually ran against (target is the
      // id-only repo#n string every runs view already shows) -- the answer to "which repos is this
      // group even about", derived from history because a github trigger's config names none.
      const repos = Array.isArray(forgeRepos?.[name]) ? forgeRepos[name] : [];
      group = { key: `forge:${name}`, path: null, label: name, kind: "forge", head: null, unreachable: "remote-repo", repos, triggerIds: [], skillIds: [] };
      forgeGroups.set(name, group);
      model.folders.push(group);
    }
    return group;
  };

  // ---- skill nodes from the enumerations ----
  const skillNode = new Map(); // "folderKey name" -> node
  const addSkill = (group, skill) => {
    const id = `skill:${group.key}:${skill.name}`;
    const node = {
      id,
      kind: "skill",
      name: skill.name,
      folderKey: group.key,
      isSub: skill.isSub === true,
      group: skill.isSub === true ? skill.group : null,
      aiTrigger: skill.aiTrigger === true,
      meta: skill.meta ?? null,
      // The prose-loop hints read from the SKILL.md body (findLoopHints): everything a loop does
      // happens INSIDE this one node's job, which is why consumers group the marker inside the
      // skill rather than drawing an edge anywhere.
      loops: Array.isArray(skill.loops) ? skill.loops.filter((l) => typeof l?.hint === "string") : [],
      unread: skill.unread === true,
      isFlow: false, // set true when a config edge lands on it
      mentionedBy: 0,
    };
    skillNode.set(`${group.key} ${skill.name}`, node);
    model.nodes.push(node);
    group.skillIds.push(id);
    if (node.unread) model.flags.push({ nodeId: id, flag: "unread", detail: "SKILL.md unreadable at enumeration; gate read as closed" });
    return node;
  };
  for (const [path, result] of Object.entries(folders)) {
    const group = folderByPath.get(path);
    for (const skill of Array.isArray(result?.skills) ? result.skills : []) {
      if (typeof skill?.name === "string" && skill.name !== "") addSkill(group, skill);
    }
  }
  for (const [dir, result] of Object.entries(injected)) {
    for (const skill of Array.isArray(result?.skills) ? result.skills : []) {
      if (typeof skill?.name !== "string" || skill.name === "") continue;
      const id = `injected:${dir}:${skill.name}`;
      model.nodes.push({ id, kind: "injected", name: skill.name, dir, aiTrigger: skill.aiTrigger === true });
      if (skill.aiTrigger === true) {
        model.flags.push({ nodeId: id, flag: "injected-ai-trigger", detail: "ai-trigger: allow on an injected skill is a silent no-op (OQ-022)" });
      }
    }
  }
  // The two deployment-wide tiers render like the injected dirs (issue #188): every enumerated skill
  // gets a node, capped upstream, bucketed by the page into its own tier group, orphan-exempt by
  // kind. Neither joins skillNode -- that map answers "committed at HEAD in THIS folder", and a tier
  // node resolves a config edge only through the precedence ladder below.
  const overlayNodeId = new Map(); // name -> node id
  if (overlay) {
    for (const skill of overlay.skills) {
      if (typeof skill?.name !== "string" || skill.name === "" || overlayNodeId.has(skill.name)) continue;
      const id = `overlay:${skill.name}`;
      overlayNodeId.set(skill.name, id);
      model.nodes.push({ id, kind: "overlay", name: skill.name });
    }
  }
  const stagedNodeId = new Map(); // name -> FIRST matching node id: manifest order is loader order
  if (staged) {
    const seenStagedIds = new Set();
    for (const skill of staged.skills) {
      if (typeof skill?.name !== "string" || skill.name === "" || typeof skill?.dir !== "string" || skill.dir === "") continue;
      const id = `staged:${skill.dir}:${skill.name}`;
      if (!seenStagedIds.has(id)) {
        seenStagedIds.add(id);
        model.nodes.push({ id, kind: "staged", name: skill.name, package: typeof skill.package === "string" && skill.package !== "" ? skill.package : skill.dir });
      }
      if (!stagedNodeId.has(skill.name)) stagedNodeId.set(skill.name, id);
    }
  }

  // A config edge may point at a flow the enumeration did not find; the target then exists as a
  // `skill-missing` node so the edge has a visible end. Created lazily, once per (group, name).
  const missingNode = (group, name) => {
    const key = `${group.key} ${name}`;
    let node = skillNode.get(key);
    if (node) return node;
    node = { id: `skill:${group.key}:${name}`, kind: "skill-missing", name, folderKey: group.key, isSub: false, group: null, aiTrigger: false, meta: null, unread: false, isFlow: false, mentionedBy: 0 };
    skillNode.set(key, node);
    model.nodes.push(node);
    group.skillIds.push(node.id);
    return node;
  };

  // missingNode's softened sibling (issue #188): the flow is known absent at HEAD, but at least one
  // lower tier was not checkable from this session, so neither "missing" styling nor a dangling flag
  // would be honest. Shares missingNode's id space; where a red and a softened claimant land on one
  // (group, name) -- per-trigger tier knowledge differs by skillsDir and run.packages -- the softened
  // kind wins in EITHER arrival order, because red asserts "definitively nowhere" and the softened
  // claimant's unknown tiers refute exactly that. The red claimant loses nothing: its no-skill flag
  // rides its own TRIGGER node and survives the shared target.
  const notAtHeadNode = (group, name, tiers) => {
    const node = missingNode(group, name);
    if (node.kind === "skill-missing") node.kind = "skill-not-at-head";
    if (node.kind === "skill-not-at-head") {
      node.tiersUnknown = [...new Set([...(Array.isArray(node.tiersUnknown) ? node.tiersUnknown : []), ...tiers])].sort();
    }
    return node;
  };

  // ---- trigger nodes + config edges + cron-rearm self-edges ----
  for (const t of triggerList) {
    if (!t || typeof t !== "object" || !Number.isInteger(t.index)) continue;
    const id = `trigger:${t.index}`;
    const isCron = t.type === "cron";
    let group = null;
    if (isCron) {
      if (typeof t.folder === "string" && t.folder !== "") {
        group = folderByPath.get(t.folder) ?? null;
        if (!group) {
          // The folder cap (or a caller that never enumerated) left this folder unscanned; the
          // trigger and its config edge still draw -- the config fact is real -- on a group that
          // says why its skills are unknown, rather than silently losing the edge.
          group = { key: `folder:${t.folder}`, path: t.folder, label: basenameOf(t.folder), kind: "local", head: null, unreachable: "not-enumerated", triggerIds: [], skillIds: [] };
          folderByPath.set(t.folder, group);
          model.folders.push(group);
        }
      } else {
        // A cron entry with no usable folder (only the fail-soft display normalizer can produce one;
        // the worker refuses it at boot) still draws its trigger and config edge -- "every trigger
        // naming a flow gets one, ALWAYS" admits no exception for broken entries, which are exactly
        // the ones an operator needs to see (review finding).
        group = folderByPath.get("") ?? null;
        if (!group) {
          group = { key: "folder:(none)", path: null, label: "(no folder)", kind: "local", head: null, unreachable: "no-folder", triggerIds: [], skillIds: [] };
          folderByPath.set("", group);
          model.folders.push(group);
        }
      }
    } else {
      group = forgeGroup(t.forge);
    }
    const stats = isCron ? (typeof t.id === "string" ? statsById[t.id] : undefined) : statsByIndex[t.index];
    const sched = isCron ? matchScheduler(schedulerList, t) : null;
    const node = {
      id,
      kind: "trigger",
      index: t.index,
      onType: t.type,
      forge: isCron ? null : (t.forge ?? null),
      cronId: isCron ? (t.id ?? null) : null,
      pattern: isCron ? (t.pattern ?? null) : null,
      label: triggerMatchLabel(t),
      flow: t.flow ?? null,
      // A command trigger's dispatched extension command (issue #189), flow's mutually-exclusive
      // sibling. Carried on the node so the display half (issue #188) has the fact to render; nothing
      // in THIS module consumes it -- a command names no SKILL.md, so the config-edge machinery below
      // (guarded on `typeof t.flow === "string"`) correctly draws nothing for it.
      command: t.command ?? null,
      replicas: t.replicas ?? null,
      folderKey: group?.key ?? null,
      runs: Number.isInteger(stats?.runs) ? stats.runs : 0,
      lastOutcome: stats?.lastOutcome ?? null,
      lastEndedAt: stats?.lastEndedAt ?? null,
      next: sched?.next ?? null,
      overdueMs: sched?.overdueMs ?? null,
      // The window's typed spend for this trigger, or null when none was wired/attributed. Carried
      // whole (usd/class/floor) so every renderer keeps the fmtCost labeling discipline.
      cost: spendByNode[id]?.cost ?? null,
    };
    model.nodes.push(node);
    if (group) group.triggerIds.push(id);

    // The OQ-020 cross-actor spend-loop signature is static and cheap; the graph is where an
    // operator can actually see it, so it badges here rather than only in SECURITY.md prose.
    if (t.type === "pull_request" && Array.isArray(t.action) && t.action.some((a) => a === "opened" || a === "synchronize")) {
      model.flags.push({ nodeId: id, flag: "pr-spend-loop-risk", detail: "fires on opened/synchronize; a flow that pushes can loop with another bot (OQ-020)" });
    }

    // Every cron trigger re-arms by definition: the one self-edge that is config, not history.
    if (isCron) model.edges.push({ from: id, to: id, kind: "cron-rearm", label: t.pattern ?? null });

    // The config edge -- every trigger that names a flow gets one, ALWAYS.
    if (typeof t.flow === "string" && t.flow !== "") {
      if (!SKILL_NAME_RE.test(t.flow)) {
        // A charset-invalid flow can never materialise (materialize.mjs refuses the name), and the
        // gate answers deny, not no-skill -- a distinct, currently-invisible defect class.
        const target = group ? missingNode(group, clipName(t.flow)) : null;
        if (target) model.edges.push({ from: id, to: target.id, kind: "config" });
        model.flags.push({ nodeId: id, flag: "charset-invalid", detail: `run.flow ${JSON.stringify(clipName(t.flow))} fails the skill charset and can never materialise` });
        continue;
      }
      if (isCron && group && group.unreachable === null) {
        const existing = skillNode.get(`${group.key} ${t.flow}`);
        if (existing && existing.kind === "skill" && !existing.isSub) {
          existing.isFlow = true;
          model.edges.push({ from: id, to: existing.id, kind: "config" });
        } else {
          // Absent at HEAD -- but the repo is only the top of the loader's four tiers (issue #188).
          // Probe the rest in precedence order, per trigger: injected run.skillsDir, overlay
          // skills/, staged packages. Each probe answers hit, miss, or unknown, and a tier node is
          // claimed only when every higher applicable tier is a KNOWN miss: a config edge asserts
          // node identity ("the job loads THIS file"), so a hit below an unknown tier stays soft.
          // Doctor probes past an unknown on purpose -- its check answers the existential "does the
          // name resolve anywhere", which a lower hit satisfies regardless of which tier shadows it;
          // an identity claim may not, because the wrong node is a wrong tick
          // (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS's one forbidden direction).
          const probes = [];
          if (typeof t.skillsDir === "string" && t.skillsDir !== "") {
            // Applicable only when THIS trigger injects a dir; an unreadable or truncated listing
            // proves nothing about the name (the miss may sit past the cap).
            const r = injected[t.skillsDir];
            if (!r || typeof r.unreachable === "string") probes.push({ tier: TIER_INJECTED, state: "unknown" });
            else if ((Array.isArray(r.skills) ? r.skills : []).some((s) => s?.name === t.flow)) probes.push({ tier: TIER_INJECTED, state: "hit", nodeId: `injected:${t.skillsDir}:${t.flow}` });
            else probes.push({ tier: TIER_INJECTED, state: r.truncated === true ? "unknown" : "miss" });
          }
          if (overlay === null || typeof overlay.unreachable === "string") probes.push({ tier: TIER_OVERLAY, state: "unknown" });
          else if (overlayNodeId.has(t.flow)) probes.push({ tier: TIER_OVERLAY, state: "hit", nodeId: overlayNodeId.get(t.flow) });
          else probes.push({ tier: TIER_OVERLAY, state: overlay.truncated === true ? "unknown" : "miss" });
          if (t.packages === false) {
            // Withheld by the trigger's own config is a KNOWN miss: the job would not load the tier
            // either. Named in the detail text so a red on a packages:false trigger says why the
            // staged tier could not have saved it.
            probes.push({ tier: `${TIER_STAGED} (withheld: run.packages false)`, state: "miss" });
          } else if (staged === null) probes.push({ tier: TIER_STAGED, state: "unknown" });
          else if (stagedNodeId.has(t.flow)) probes.push({ tier: TIER_STAGED, state: "hit", nodeId: stagedNodeId.get(t.flow) });
          else probes.push({ tier: TIER_STAGED, state: staged.unenumerable.length > 0 || staged.truncated === true ? "unknown" : "miss" });

          let target = null;
          let blocked = false;
          for (const probe of probes) {
            if (probe.state === "hit" && !blocked) {
              target = probe.nodeId;
              break;
            }
            if (probe.state === "unknown") blocked = true;
          }
          if (target !== null) {
            // Resolved in a lower tier: the edge lands on the tier node that already renders its own
            // "never AI-reachable" truth, and NO flag is minted -- the flow runs fine.
            model.edges.push({ from: id, to: target, kind: "config" });
          } else if (probes.some((p) => p.state === "unknown")) {
            const soft = notAtHeadNode(group, t.flow, probes.filter((p) => p.state === "unknown").map((p) => p.tier));
            model.edges.push({ from: id, to: soft.id, kind: "config" });
          } else {
            // Every applicable tier checked and missed: readFlowGate's precise "no-skill", the one
            // token that means dangling (deny would prove nothing), now with the whole ladder
            // behind it -- the detail names the tiers so the claim is auditable.
            const target2 = missingNode(group, t.flow);
            model.edges.push({ from: id, to: target2.id, kind: "config" });
            const alsoChecked = probes.length > 0 ? `; also checked: ${probes.map((p) => p.tier).join(", ")}` : "";
            model.flags.push({ nodeId: id, flag: "no-skill", detail: `.pi/skills/${t.flow}/SKILL.md absent at HEAD${alsoChecked}` });
          }
        }
      } else if (group) {
        // Forge repo (not local) or unreachable folder: the edge still draws -- the config fact is
        // real -- but no dangling flag can honestly attach to a read that never happened, so the
        // target is an UNVERIFIED node, a different kind from skill-missing on purpose.
        const target = missingNode(group, t.flow);
        if (target.kind === "skill-missing") target.kind = "skill-unverified";
        target.isFlow = true;
        model.edges.push({ from: id, to: target.id, kind: "config" });
      }
    }
  }

  // ---- observed chain edges (records only), resolved onto folder groups by target basename ----
  const localGroups = model.folders.filter((f) => f.kind === "local");
  for (const edge of observed) {
    if (typeof edge?.parentFlow !== "string" || typeof edge?.childFlow !== "string") continue;
    const base = typeof edge.target === "string" && edge.target.startsWith("local:") ? edge.target.slice("local:".length) : null;
    const matches = base === null ? [] : localGroups.filter((f) => f.label === base);
    if (matches.length !== 1) {
      // No enumerated folder (or an ambiguous basename) to hang the edge on: dropping it and saying
      // so beats guessing, which could pin real history onto the wrong folder's skills.
      model.meta.droppedObservedEdges++;
      continue;
    }
    const group = matches[0];
    if (group.unreachable !== null) {
      // An unreachable folder has no real skill nodes to hang history on: minting them here would
      // badge phantom "[missing at HEAD]" endpoints off a read that never happened (review finding),
      // so the edge is dropped INTO THE COUNTER, same as the ambiguous case.
      model.meta.droppedObservedEdges++;
      continue;
    }
    const from = missingNode(group, edge.parentFlow);
    const to = missingNode(group, edge.childFlow);
    model.edges.push({ from: from.id, to: to.id, kind: "observed", count: Number.isInteger(edge.count) ? edge.count : 0, lastEndedAt: edge.lastEndedAt ?? null });
  }

  // ---- potential edges from text mentions, within each enumerated folder only ----
  for (const [path, result] of Object.entries(folders)) {
    const group = folderByPath.get(path);
    for (const skill of Array.isArray(result?.skills) ? result.skills : []) {
      if (skill?.isSub === true) continue;
      const from = skillNode.get(`${group.key} ${skill?.name}`);
      if (!from) continue;
      for (const mention of Array.isArray(skill?.mentions) ? skill.mentions : []) {
        const to = skillNode.get(`${group.key} ${mention?.name}`);
        if (!to || to.isSub) continue;
        to.mentionedBy++;
        model.edges.push({
          from: from.id,
          to: to.id,
          kind: "potential",
          strong: mention.strong === true,
          // Eligibility is the exact static half: without ai-trigger: allow on the TARGET, the
          // outbox gate refuses this edge every time, so a mention alone renders "can never fire".
          eligible: to.aiTrigger === true,
        });
      }
    }
  }

  // ---- orphan / reachability flags, only where the enumeration actually succeeded ----
  for (const [path] of Object.entries(folders)) {
    const group = folderByPath.get(path);
    if (group.unreachable !== null) continue;
    for (const id of group.skillIds) {
      const node = model.nodes.find((n) => n.id === id);
      if (!node || node.kind !== "skill" || node.isSub || node.unread) continue;
      if (node.isFlow) continue;
      if (node.aiTrigger) {
        model.flags.push({ nodeId: id, flag: "ai-reachable-no-trigger", detail: "no trigger names it, but ai-trigger: allow keeps it chain/dispatch_run-reachable" });
      } else if (node.mentionedBy === 0) {
        model.flags.push({ nodeId: id, flag: "orphan", detail: "no trigger, no ai-trigger, no mention: dead by every path the system has" });
      }
    }
  }

  return model;
}

/** The display label for a trigger's match side, mirroring render.mjs's triggerLine vocabulary.
 * Exported for the read-model's cost attribution (issue #175): one vocabulary for what a trigger is
 * called, however many tables call it. */
export function triggerMatchLabel(t) {
  switch (t?.type) {
    case "cron":
      return `${t.id ?? "-"} ${t.pattern ?? "-"}`;
    case "label":
      return selectorLabel(t);
    case "comment":
      return `"${t.phrase ?? "-"}"`;
    case "pull_request":
      return `action[${(Array.isArray(t.action) ? t.action : []).join(",")}]`;
    case "issue": {
      // pull_request's vocabulary plus the one narrowing an issue rule can carry: `#<n>` is the forge's own
      // spelling of the item, so the label reads back the way the operator wrote the rule (issue #231).
      const action = `action[${(Array.isArray(t.action) ? t.action : []).join(",")}]`;
      return Number.isInteger(t.number) ? `${action} #${t.number}` : action;
    }
    default:
      return "(unknown)";
  }
}

function selectorLabel(t) {
  const parts = [];
  if (Array.isArray(t.any) && t.any.length) parts.push(`any[${t.any.join(",")}]`);
  if (Array.isArray(t.all) && t.all.length) parts.push(`all[${t.all.join(",")}]`);
  if (Array.isArray(t.none) && t.none.length) parts.push(`none[${t.none.join(",")}]`);
  return parts.join(" ") || "(no selector)";
}

/** Match a cron display trigger to its resident scheduler: by key/name (the id), else by pattern. */
function matchScheduler(schedulers, t) {
  if (typeof t?.id === "string") {
    const byId = schedulers.find((s) => s?.key === t.id || s?.name === t.id);
    if (byId) return byId;
  }
  return typeof t?.pattern === "string" ? (schedulers.find((s) => s?.pattern === t.pattern) ?? null) : null;
}

/** Basename without importing node:path (this module is pure); both separators, trailing-sep safe. */
function basenameOf(path) {
  const trimmed = String(path).replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** Clip an arbitrary (possibly hostile) flow string for node display; the honest badge needs the name. */
function clipName(name) {
  const s = String(name);
  return s.length > 64 ? `${s.slice(0, 64)}…` : s;
}
