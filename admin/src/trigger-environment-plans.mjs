/**
 * A person's change to what a trigger's jobs get (issue #800, `trigger-environment-edit`, `CARD_FIELDS`), with one preview
 * and one Confirm: which flow and model they run on, what each may spend, which servers and tools they reach, and whether
 * they load the staged packages.
 *
 * DELIBERATELY OUTSIDE `write-plans.mjs`, and that is the boundary, not a tidiness. `tool-actions.mjs` hands a tool
 * `{ ...writePlans }`, every export, so a planner there is a planner a model's call can reach. `TOOL_PROOF_FIELDS` are
 * the operator's to write, and a person at the console is the operator while a model's call is not, even behind a confirm.
 * This module is loaded by the console's `cli.mjs` alone and handed to the action
 * through `ctx.a`, which a tool's context does not carry. `trigger-environment-boundary.test.mjs` walks the import graph of
 * `tool-actions.mjs` and of the extension to hold that, so the action table takes the field names from `trigger-edit-core.mjs`
 * and never imports this file. REJECTED: a parameter on `planTriggerEdit`, which any call that reaches it could pass.
 *
 * WHY THE PREVIEW JUDGES MORE THAN THE FILE. The file's parser cannot know a deployment's cap, a model's first call or the
 * jobs in line, and each of those fails later, for free or nearly (CONST-BUDGET-BEFORE-TOKENS). So the preview says what the
 * loader cannot, before anything is written, and the funnel's own parser still has the last word on the file itself: the
 * preview dry-runs `writeTriggers` and refuses in its words.
 *
 * ONE CHANGE, ONE WAY BACK. Keys that are not sent keep their values and their places; `null` deletes a key. An Undo is an edit
 * like any other, previewed the same way, and puts back the keys it touched: the old value as JSON reads it from the file,
 * `null` for a key the edit added, and `keyOrder` where putting a deleted key back would otherwise leave it at the end. In a
 * file the writer wrote those are the same bytes. In one it did not, the first write puts the whole file in its form, as every
 * writer of this file does: its layout, a `"version": 1` written as nothing, a number as JSON reads it. No Undo restores those.
 */
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom, forwardEnvList } from "@edgehero/pi-dispatch/config";
import { egressArmed } from "@edgehero/pi-dispatch/egress";
import { parseAllowlist } from "@edgehero/pi-dispatch/egress-allowlist";
import { jobDataVersionFor } from "@edgehero/pi-dispatch/job-data-version";
import { FIRST_CALL_SHORT_TASK_BYTES, boundModelOf, builtinChatModels as catalogChatModels, builtinModel as catalogModel, checkModelsKnown as catalogCheck, firstCallBoundMicros, firstCallFloorMicros } from "@edgehero/pi-dispatch/model-catalog";
import { FORGE_MCP_KINDS, FORGE_MCP_SERVER_NAME, forgeMcpServer, readOverlayMcp } from "@edgehero/pi-dispatch/mcp-config";
import { makeMcpCheck, mcpRouteCuts, reservedJobNames } from "@edgehero/pi-dispatch/mcp-preflight";
import { readOverlayModels } from "@edgehero/pi-dispatch/model-endpoints";
import { checkFailoverCandidate, selectFailoverJob } from "@edgehero/pi-dispatch/model-failover";
import { RADIUS_COST_CAP_FIX, RADIUS_COST_CAP_LABEL } from "@edgehero/pi-dispatch/model-observation";
import { failoverListUsable, modelOnList, splitModelEntry } from "@edgehero/pi-dispatch/model-ref";
import { effectiveCostCapMicros, formatMicros, optionalUsdMicros, parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { outputCapView, outputUnboundable } from "@edgehero/pi-dispatch/output-cap";
import { parseProjects } from "@edgehero/pi-dispatch/projects";
import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { readOverlay } from "@edgehero/pi-dispatch/runtime-settings";
import { DEFAULT_ON_TOOL_NAMES, EXCLUDABLE_TOOL_NAMES, parseTriggers, parseTriggersDocument, triggersFileVersionProblem } from "@edgehero/pi-dispatch/triggers";
import { writeTriggers } from "@edgehero/pi-dispatch/triggers-file";
import { dryRunFs } from "./console/actions.mjs";
import { collectModelPolicies } from "./models-view.mjs";
import { PROVIDER_KEY_NAMES, providerKeyNames } from "./provider-key-names.mjs";
import { writeInputs } from "./read-model.mjs";
import { CARD_FIELDS, TRIGGER_ENVIRONMENT_EDIT_FIELDS, planTriggerEditCore, rowName, triggerEntryDigest } from "./trigger-edit-core.mjs";
import { fieldNamed, listed } from "./words.mjs";

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refuse = (refusal, status = 400, state = null) => ({ refusal, status, ...(state ? { state } : {}) });
const denied = { refusal: "Only a person in the operator console can change what a trigger's jobs get.", status: 403 };
const unreadableFile = () => refuse("The triggers file could not be read, so this change could not be judged. Nothing is written over a file this page cannot read.", 409, "changed");
const authority = (ctx) => ctx?.surface === "console" && ctx?.role === "operator";
const money = (micros) => `$${formatMicros(micros)}`;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const STRING_FIELDS = Object.freeze(["provider", "model"]);
const LIST_FIELDS = Object.freeze(["models", "fallbackModels", "mcp", "excludeTools"]);
/** The fields whose change is judged against what a job may call and spend (`judgeModels`), and only then. */
const MODEL_OR_CAP = Object.freeze(["provider", "model", "models", "fallbackModels", "maxCostUsd"]);
/** The fields whose change the pickup's MCP check speaks of. A model edit reaches the same check and is not asked: it would speak of a server nobody touched. */
const MCP_CHECK_FIELDS = Object.freeze(["mcp", "excludeTools"]);
/** A server as the most generous host could route it, so what still cuts it off is the file's doing on every host. */
const ANY_HOST_SERVER = Object.freeze({ exposure: "direct" });
/** The one line a pickup warning stands beside: what the console, reading this host's files, cannot see. */
const PICKUP_TAIL = "This reads this host's .env and overlay; what the worker's own service environment sets cannot be seen from here.";
/** The most job ids a preview names. A queue can hold 200 in view, and the sentence stays a sentence. */
const SKEW_NAMED_MAX = 5;
/** How long the preview waits for the jobs in line, `SNAPSHOT_TIMEOUT_MS`'s bound and for its reason. */
const JOBS_READ_MS = 10_000;
/** What `failoverOrder` answers the worker's loop with for a model that passes, so the loop goes on to the next. */
const QUALIFIES = "qualifies";

/** A built-in tool no job has unless an extension turns it on: `DEFAULT_ON_TOOL_NAMES`' other half. */
const offByDefault = (name) => EXCLUDABLE_TOOL_NAMES.has(name) && !DEFAULT_ON_TOOL_NAMES.has(name);

/** Why this body is not one the form could send, or null: nothing is read until it is. */
function shapeProblem(body) {
  if (!plain(body)) return "The change must be an object of the trigger's fields.";
  const unknown = Object.keys(body).find((key) => body[key] !== undefined && !TRIGGER_ENVIRONMENT_EDIT_FIELDS.includes(key));
  if (unknown !== undefined) return `This form takes ${TRIGGER_ENVIRONMENT_EDIT_FIELDS.join(", ")} only; ${fieldNamed(unknown)} is not one of them.`;
  if (!Number.isSafeInteger(body.index) || body.index < 0) return "index must be a whole number, 0 or more.";
  if (typeof body.pageDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.pageDigest)) return "The page did not say what it saw (pageDigest). Reload it and make the change again.";
  if (body.flow === null) return "A trigger's flow cannot be removed: choose another flow.";
  if (body.flow !== undefined && typeof body.flow !== "string") return "flow must be a string.";
  // Blank is what a text box sends for "no value", and the shared body reads blank as not sent: here that would be a change
  // that silently is not one, so removing a key says so with null.
  for (const key of STRING_FIELDS) if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== "string" || body[key].trim() === "")) return `${key} must be a non-empty string, or null to remove it.`;
  for (const key of LIST_FIELDS) if (body[key] !== undefined && body[key] !== null && (!Array.isArray(body[key]) || body[key].some((entry) => typeof entry !== "string"))) return `${key} must be a list of names, or null to remove it.`;
  if (body.keyOrder !== undefined && (!Array.isArray(body.keyOrder) || body.keyOrder.some((key) => typeof key !== "string"))) return "keyOrder must be a list of the entry's run keys.";
  return null;
}

/** A dollar value as the page says it; a value the parser refuses is the funnel's to name, so this never throws. */
function dollars(value) {
  try {
    return money(parseUsdMicros(value, "run.maxCostUsd"));
  } catch {
    return String(value);
  }
}

/**
 * Whether two values of a key say one thing. `null` is absent (the loader's rule for the model keys), and a cap is its amount: `1.5`
 * and `"1.50"` are one cap, so neither is a change to say, to write or to undo. A value that does not parse stays itself, for the
 * funnel to refuse. REJECTED: reading `run.packages: true` as no key. A job loads the staged packages under either, but `true` is an
 * operator's word that this flow needs them, and doctor fails a host with none staged only on that word (`requiring`), so the page
 * could not clear it, nor put it back.
 */
function sameToAJob(key, before, after) {
  const read = (value) => {
    if (key !== "maxCostUsd") return value;
    try {
      return parseUsdMicros(value, "run.maxCostUsd");
    } catch {
      return value;
    }
  };
  return same(read(before) ?? null, read(after) ?? null);
}

/** Host names in a sentence, sorted: `listed` keeps the order it is given, and a registry's order is nobody's to read. */
const hostsNamed = (names) => listed([...names].sort());

/** What a list gained and lost, and whether only its order moved. */
function delta(before, after) {
  const was = Array.isArray(before) ? before : [];
  const now = Array.isArray(after) ? after : [];
  const added = now.filter((name) => !was.includes(name));
  const removed = was.filter((name) => !now.includes(name));
  return { added, removed, reordered: added.length === 0 && removed.length === 0 && !same(was, now) };
}

/** A model list's change in words, `models` and `fallbackModels` alike. */
function listChange(word, before, after) {
  if (after === undefined) return `${word}: the list removed.`;
  if (before === undefined) return `${word}: ${after.join(", ")}, where this trigger listed none.`;
  const d = delta(before, after);
  if (d.reordered) return `${word}: the same models in a new order.`;
  return `${word}: ${[d.added.length ? `${d.added.join(", ")} added` : "", d.removed.length ? `${d.removed.join(", ")} removed` : ""].filter(Boolean).join(", ")}.`;
}

/**
 * Each change in words (`write-plans.mjs` `planTriggerDelete`, #737: a confirm says what it does in words and never an arrow),
 * with a widening said as one, on a line of its own. `facts` is what the spend judgement read (`judgeModels`), there whenever
 * a model field or the cap was sent, and those are the only changes that read it. Whether a job may call more models is not
 * said here: that is the resolver's answer, before and after (`callableWidening`), not this key's.
 */
function changeWords(key, before, after, facts, effective = null) {
  const removedKey = after === undefined;
  const addedKey = before === undefined;
  switch (key) {
    case "flow":
      return { line: `Flow: ${before ?? "none"} to ${after}.` };
    case "provider":
    case "model": {
      const word = key === "provider" ? "Provider" : "Model";
      if (removedKey) return { line: `${word}: ${before} removed, so its jobs use the deployment's.` };
      return { line: `${word}: ${before ?? "the deployment's"} to ${after}.` };
    }
    case "maxCostUsd": {
      const was = facts.capOf(before);
      const will = facts.capOf(after);
      const widened = (was !== null && will === null) || (was !== null && will !== null && will > was);
      const under = facts.deploymentCap === null ? "the deployment sets none, so its jobs have no cap" : `its jobs run under the deployment's ${money(facts.deploymentCap)}`;
      return {
        line: removedKey ? `Job cap: ${dollars(before)} removed; ${under}.` : addedKey ? `Job cap: ${dollars(after)}, where this trigger set none.` : `Job cap: ${dollars(before)} to ${dollars(after)}.`,
        ...(widened ? { widening: `This widens what each job may spend: ${will === null ? "no cap at all" : `up to ${money(will)}`}.` } : {}),
      };
    }
    case "models":
      return { line: listChange("Allowed models", before, after) };
    case "fallbackModels":
      return { line: listChange("Fallback models", before, after) };
    case "mcp": {
      const d = delta(before, after);
      const moved = [...d.added.map((name) => `${name} on`), ...d.removed.map((name) => `${name} off`)];
      // An empty list the loader refuses, taken out: nothing moves, and "MCP: ." says nothing at all.
      return { line: d.reordered ? "MCP: the same servers in a new order." : moved.length > 0 ? `MCP: ${moved.join(", ")}.` : "MCP: the empty list the file held removed.", addedServers: d.added };
    }
    case "packages": {
      if (after === false) return { line: "Staged packages: off." };
      if (before === false) return { line: "Staged packages: on.", widening: "This widens what its jobs load: every package staged on the host that runs them." };
      return { line: after === true ? "Staged packages: stay on, and the file now says this flow needs them, so doctor fails a host with none staged." : "Staged packages: stay on, and the file no longer says this flow needs them, so doctor stops failing a host with none staged." };
    }
    case "excludeTools": {
      const raw = delta(before, after);
      if (raw.reordered) return { line: "Tools: the same removals in a new order." };
      // What a job lacks is the loader's list and not the file's: a watch rule's keeps edit, write, bash and powershell off
      // whatever the file says. And a tool a job would not have anyway comes back to nothing: pi's defaults are read, bash,
      // edit and write, so taking `ls` out of the list turns nothing on until an extension does.
      const d = delta(effective?.before ?? before, effective?.after ?? after);
      const moved = [...d.added.map((name) => `${name} off`), ...d.removed.map((name) => (offByDefault(name) ? `${name} no longer removed, and off unless an extension turns it on` : `${name} on`))];
      if (moved.length > 0) {
        const wider = d.removed.filter((name) => !offByDefault(name));
        return { line: `Tools: ${moved.join(", ")}.`, ...(wider.length > 0 ? { widening: `This widens what its jobs can do: ${wider.join(", ")} back on.` } : {}) };
      }
      const named = [raw.added.length > 0 ? `now names ${listed(raw.added)}` : "", raw.removed.length > 0 ? `no longer names ${listed(raw.removed)}` : ""].filter(Boolean).join(" and ");
      return { line: named !== "" ? `Tools: the file's list ${named}, and what its jobs lack does not change.` : "Tools: the empty list the file held removed." };
    }
    default:
      throw new RangeError(`no words for ${key}`);
  }
}

/**
 * What a job of this trigger may call that it could not before, from what the real resolver answers for the entry on each side,
 * per project: `"any model"`, a list of names, or null. Not from whether `run.models` was there: it replaces the deployment's
 * list (`effectiveJobOf`), and under a role map the resolver unions the main model and every role's into it, so a list added to
 * a trigger with none can still make a model callable, and removing one can leave a real list in place. No list on the old
 * side means any model already, so nothing can widen there.
 */
function callableWidening(before, after, envList) {
  const listOf = (job) => job.models ?? envList ?? null;
  const was = new Map(before.runs.map((job) => [job.project ?? null, listOf(job)]));
  const fresh = new Set();
  let any = false;
  for (const job of after.runs) {
    const old = was.get(job.project ?? null);
    if (old === null || old === undefined) continue;
    const now = listOf(job);
    if (now === null) any = true;
    else for (const ref of now) if (!old.includes(ref)) fresh.add(ref);
  }
  return any ? "any model" : fresh.size > 0 ? [...fresh].join(", ") : null;
}

/** A server's where and key, when every host that has it agrees; a sentence must be true of each host a job can land on. */
function serverReach(name, hosts) {
  const rows = hosts.flatMap((host) => (host?.state === "current" && Array.isArray(host.mcp) ? host.mcp.filter((row) => row?.name === name && row.enabled === true) : []));
  if (rows.length === 0 || new Set(rows.map((row) => JSON.stringify([row.where, row.keys]))).size !== 1) return name;
  const [{ where, keys }] = rows;
  if (typeof where !== "string") return name;
  return `${where}${Array.isArray(keys) && keys.length > 0 ? `, with ${listed(keys)} by name` : ""}`;
}

/**
 * The hosts whose publication says a flow is not theirs to give (`doctor:loads:<name>`), read as `serverHosts` reads them: a host that
 * has not published, or whose publication is old or whose skills were cut or unread, says nothing. What is published is a host's
 * overlay skills and a staged package only where a trigger already resolved one, so this is no claim about a repository, a
 * trigger's skills folder or a package's other skills: the warning names those, and a repository can gain the flow at any commit.
 */
function hostsWithoutFlow(flow, hosts, loadsPackages) {
  const answers = (host) => host?.state === "current" && Array.isArray(host.skills) && !(host.unread ?? []).includes("skills") && !(host.more?.skills > 0);
  const holds = (host) => host.skills.includes(flow) || (host.flows ?? []).some((row) => row?.flow === flow && (row.tier === "overlay" || (row.tier === "package" && loadsPackages)));
  return hosts.filter((host) => answers(host) && !holds(host)).map((host) => host.name);
}

/**
 * Which hosts have a server, by what each published (`doctor:loads:<name>`), read as the card reads it (`readHostLoadsView`'s
 * `state`). A host that has not published, whose publication is old or was written by a newer release, or whose list of servers
 * was cut or unread, reads unknown: never as having it, and never as lacking it. Names go in order, whatever order the registry
 * answers in, so a sentence reads the same on a preview, on the card and from one page load to the next.
 */
function serverHosts(name, hosts) {
  const has = [];
  const lacks = [];
  const unknown = [];
  for (const host of hosts) {
    const row = Array.isArray(host?.mcp) ? host.mcp.find((entry) => entry?.name === name) : undefined;
    const answers = host?.state === "current" && Array.isArray(host?.mcp) && !(host?.unread ?? []).includes("mcp");
    if (row?.enabled === true && answers) has.push(host.name);
    else if (answers && (row !== undefined || !(host?.more?.mcp > 0))) lacks.push(host.name);
    else unknown.push(host.name);
  }
  const parts = [has.length ? `${hostsNamed(has)} ${has.length === 1 ? "has" : "have"} it` : "", lacks.length ? `${hostsNamed(lacks)} ${lacks.length === 1 ? "does" : "do"} not` : "", unknown.length ? `${hostsNamed(unknown)} ${unknown.length === 1 ? "reads" : "read"} unknown` : ""].filter(Boolean);
  return parts.join("; ");
}

/** The keys a job's models and cap read from a worker's environment. */
const MODEL_FACT_KEYS = Object.freeze(["PI_PROVIDER", "PI_MODEL", "PI_MAX_COST_USD", "PI_ALLOWED_MODELS"]);

/**
 * The deployment's `.env` as far as a model edit needs it, or what could not be read of it: `{ env, note }`. The file and not the
 * console's own environment, for `judgeMcp`'s reason and with more at stake: that environment is built once at the console's
 * start with its shell winning, so it could pass a cap above the one in the file, and `loadSchedules` refuses the whole file over
 * that. A file it cannot vouch for leaves those keys unjudged and says so, and says what is at stake, since Confirm stays: another
 * host may read its own. REJECTED: believing a key's own plain line beside a line the loader reads differently. Under a sourcing
 * shell that other line may run anything: `OTHER=ab export PI_MAX_COST_USD=9`, `unset`, or `exit`. The test beside this one measures
 * each in a real shell. A line that is only a value it cannot read, as `OTHER=ab cd` is
 * to systemd, is no such line: the reader takes the key's value there, and the cap is judged.
 */
function modelEnv(readHostEnv) {
  const cannot = "so the deployment's job cap and its list of models could not be judged here. A trigger's cap above what the worker reads makes it refuse the whole file.";
  let read;
  try {
    read = readHostEnv(MODEL_FACT_KEYS);
  } catch {
    return { env: {}, note: `This host's .env could not be read as the worker reads it, ${cannot}` };
  }
  if (read.hazardLine) return { env: read.env, note: `Line ${read.hazardLine} of this host's .env could not be read as the worker reads it, ${cannot}` };
  if (read.unread.length > 0) return { env: read.env, note: `This host's .env holds ${listed(read.unread)} in a line that could not be read as the worker reads it, ${cannot}` };
  return { env: read.env, note: null };
}

/**
 * What the deployment says of a job's models and cap, read fresh for each judgement, or the refusal that it cannot say:
 * `deployment` as a job resolves it (overlay over env), `deploymentCap` the merged cap, `ceiling` the most a trigger's may be.
 */
function modelFacts({ paths, readHostEnv, fs }) {
  const { env, note } = modelEnv(readHostEnv);
  let settings;
  try {
    settings = paths.settingsFile ? readOverlay(paths.settingsFile, { fs }) : { overlay: {} };
  } catch {
    return refuse("The deployment's settings could not be read, so this change could not be judged.", 409);
  }
  if (settings.invalid) return refuse("The deployment's settings file is invalid; correct it before changing a trigger's model or cap.", 409);
  let envList;
  try {
    envList = allowedModelsFrom(env);
  } catch {
    return refuse("PI_ALLOWED_MODELS is invalid; correct it before changing a trigger's model or cap.", 409);
  }
  const set = (value) => (value === undefined || value === null || value === "" ? null : value);
  const deployment = { provider: settings.overlay.provider ?? env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: settings.overlay.model ?? env.PI_MODEL ?? DEFAULT_MODEL, maxCostUsd: set(settings.overlay.maxCostUsd) ?? set(env.PI_MAX_COST_USD) };
  let deploymentCap;
  let ceiling;
  try {
    deploymentCap = optionalUsdMicros(deployment.maxCostUsd, "maxCostUsd");
    // The lower of the two the worker reads. A job runs under the merged cap (`effectiveJobOf`), and `loadSchedules` refuses
    // the whole file over one above the env's, whichever way an overlay moved the merged one.
    const envCap = optionalUsdMicros(set(env.PI_MAX_COST_USD), "PI_MAX_COST_USD");
    ceiling = [deploymentCap, envCap].filter((cap) => cap !== null).reduce((low, cap) => (low === null ? cap : Math.min(low, cap)), null);
  } catch {
    return refuse("The deployment's job cap could not be read; correct it before changing a trigger's model or cap.", 409);
  }
  return { deployment, deploymentCap, ceiling, envList, note, capOf: (value) => effectiveCostCapMicros(value, deployment.maxCostUsd) };
}

export function createTriggerEnvironmentActions({ paths, env = {}, fs = nodeFs, now = Date.now, checkModelsKnown = catalogCheck, builtinModel = catalogModel, builtinChatModels = catalogChatModels, readHosts = async () => ({ unreachable: "the live hosts are not wired" }), readHostLoads = async () => ({ hosts: [] }), readSkew = async () => ({ rows: [], incomplete: true }), versionTables = {}, jobsReadMs = JOBS_READ_MS, deploymentDir = ".", readHostEnv = () => ({ env, unread: [] }), readEndpoints = () => [] } = {}) {
  const triggersTables = versionTables.triggers ?? {};
  const jobDataTables = versionTables.jobData ?? {};

  /**
   * One judgement's read of the overlay models.json: at most once, and a read that failed stays failed for every model asked of
   * it. Answering null to the next one read as an overlay with nothing in it, so that model was priced from the builtin table
   * and judged known or unknown without the file that may define it.
   */
  const overlayReader = () => {
    let read = null;
    return () => {
      if (read === null) {
        try {
          read = { overlay: readOverlayModels(paths.globalPiDir, { readFileSync: (...args) => fs.readFileSync(...args), lstatSync: (...args) => fs.lstatSync(...args) }) };
        } catch (error) {
          read = { error };
        }
      }
      if (Object.hasOwn(read, "error")) throw read.error;
      return read.overlay;
    };
  };

  /** What a job of this entry resolves to under the file's role map and the projects, as the worker resolves it. */
  function policyOf({ entry, text, facts }) {
    try {
      const roles = parseTriggersDocument(text, paths.triggersPath, triggersTables).modelRoles;
      const projects = paths.projectsFile ? parseProjects(fs.readFileSync(paths.projectsFile, "utf8"), paths.projectsFile) : [];
      return { resolved: collectModelPolicies({ entries: [entry], modelRoles: roles, projects, deployment: facts.deployment, envList: facts.envList, resolveFolder: (path) => fs.realpathSync(path) }) };
    } catch {
      return refuse("The trigger's project or role policy could not be read; correct those files before changing its model or cap.", 409);
    }
  }

  /**
   * What the worker's pickup would say of this edit. A preview refuses only what the file alone decides, and that holds on every
   * host: exclusions that leave a server no way in however a host routes it. Everything else depends on this host (its overlay,
   * its `.env`, its allowlist, its endpoints), and another host may run the job, so it is a warning, in the worker's own reason,
   * and the person can still Confirm. REJECTED: refusing on this host's answer. A change that works on the host that will run it
   * cost a person the page, and pickup's own refusal is free and names its reason, so a warning costs little.
   *
   * It speaks only of what the edit touches: a server it adds, and a route it newly cuts. Each added server is asked alone, without
   * the exclusions, so a server nobody touched neither speaks nor hides one behind it; the routes are asked apart, new cuts only.
   */
  function judgeMcp({ was, run, entry, text, facts }) {
    const names = Array.isArray(run?.mcp) ? run.mcp : [];
    if (names.length === 0) return { warnings: [] };
    const wasNames = Array.isArray(was?.mcp) ? was.mcp : [];
    const excluded = new Set(run.excludeTools ?? []);
    const wasExcluded = new Set(was?.excludeTools ?? []);
    const newCuts = (servers, list, options) => {
      const already = new Set(mcpRouteCuts(servers, list.was, wasExcluded, options).map((cut) => cut.name));
      return mcpRouteCuts(servers, list.now, excluded, options).filter((cut) => !already.has(cut.name));
    };
    const anyHost = Object.fromEntries([...new Set([...names, ...wasNames])].map((name) => [name, ANY_HOST_SERVER]));
    const [cut] = newCuts(anyHost, { was: wasNames, now: names });
    if (cut) return refuse(`On every host this trigger's jobs would be refused as mcp-excluded, before they spend. ${cut.name}: ${cut.why}. ${explainReason("mcp-excluded").next ?? ""}`.trim());

    const could = (line) => ({ warnings: [line, PICKUP_TAIL] });
    if (facts.refusal) return could("The deployment's settings could not be read as the worker reads them, so the worker's pickup check could not be run.");
    const policy = policyOf({ entry, text, facts });
    if (policy.refusal) return could("The trigger's project or role policy could not be read, so the worker's pickup check could not be run.");
    const notRead = "This host's .env could not be read as the worker reads it, so the worker's pickup check could not be run.";
    let host;
    try {
      host = readHostEnv(["PI_FORWARD_ENV", "PI_EGRESS", "GITLAB_URL"]);
    } catch {
      return could(notRead);
    }
    if (host.hazardLine) return could(`Line ${host.hazardLine} of this host's .env could not be read as the worker reads it, so the worker's pickup check could not be run.`);
    if (host.unread.length > 0) return could(`This host's .env holds ${listed(host.unread)} in a line that could not be read as the worker reads it, so the worker's pickup check could not be run.`);
    let egress;
    let forwardEnv;
    try {
      egress = egressArmed(host.env);
      forwardEnv = forwardEnvList(host.env.PI_FORWARD_ENV, egress);
    } catch {
      return could("This host's PI_EGRESS or PI_FORWARD_ENV is one the worker refuses, so the worker's pickup check could not be run.");
    }
    let forwarded;
    try {
      forwarded = readHostEnv(forwardEnv);
    } catch {
      return could(notRead);
    }
    // A line the reader cannot vouch for is no answer either way, so the check treats the key as held and a sentence says so.
    const hostEnv = { ...forwarded.env, ...Object.fromEntries(forwarded.unread.map((key) => [key, "unread"])) };
    const gitlabUrl = host.env.GITLAB_URL ?? "https://gitlab.com";
    const read = (dir) => readOverlayMcp(dir, { readFileSync: (...args) => fs.readFileSync(...args), lstatSync: (...args) => fs.lstatSync(...args) });
    const readOverlayDoc = overlayReader();
    // Which of the check's own reads threw: the sentence names that one, and the `.env` it did not touch stays out of it.
    let failedRead = null;
    const named = (what, reader) => () => {
      try {
        return reader();
      } catch (error) {
        failedRead = what;
        throw error;
      }
    };
    const check = makeMcpCheck({
      globalPiDir: paths.globalPiDir,
      forwardEnv,
      hostEnv,
      egress,
      // The worker's is null where it serves no GitLab, and such a host refuses the job for that; this host cannot tell.
      gitlabUrl,
      read,
      reserved: (job) => reservedJobNames(job, { readModels: readOverlayDoc, defaultProvider: facts.deployment.provider, allowedModels: facts.envList, everyProvider: Object.keys(PROVIDER_KEY_NAMES), candidatesOf: providerKeyNames }),
      allowlist: named("egress allowlist", () => {
        try {
          return parseAllowlist(fs.readFileSync(join(deploymentDir, "egress-allowlist.conf"), "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") return [];
          throw error;
        }
      }),
      endpoints: named("model endpoints", readEndpoints),
    });
    const jobs = policy.resolved.runs.length > 0 ? policy.resolved.runs : [{ provider: facts.deployment.provider, model: facts.deployment.model, project: null }];
    const whose = (hit) => {
      if (hit.size === jobs.length) return "this trigger's jobs";
      const projects = [...hit].map((job) => job.project).filter((project) => project !== null);
      const outside = [...hit].some((job) => job.project === null);
      const where = [projects.length > 0 ? `${projects.length === 1 ? "project" : "projects"} ${listed(projects)}` : "", outside ? "no project" : ""].filter(Boolean).join(" and ");
      return `this trigger's jobs in ${where}`;
    };
    const warnings = [];
    const added = delta(wasNames, names).added;
    const refusals = new Map();
    for (const name of added) {
      for (const job of jobs) {
        const list = job.models ?? facts.envList ?? null;
        let answer;
        try {
          answer = check({ ...run, mcp: [name], excludeTools: undefined, provider: job.provider, model: job.model, ...(list === null ? {} : { models: list }) });
        } catch {
          warnings.push(failedRead ? `This host's ${failedRead} could not be read, so the worker's pickup check could not judge ${name}.` : `The worker's pickup check could not judge ${name} on this host.`);
          continue;
        }
        if (answer.unavailable) warnings.push(`An overlay file the worker's pickup check reads could not be read just now, so it could not judge ${name}; a pickup asks again.`);
        if (!answer.refused) continue;
        const key = JSON.stringify([answer.refused, answer.name, answer.why]);
        if (!refusals.has(key)) refusals.set(key, { answer, hit: new Set() });
        refusals.get(key).hit.add(job);
      }
    }
    for (const { answer, hit } of refusals.values()) {
      // What to do is the reason's own line (`docs/reasons.md`). This one's way out is also not on this page, so it says where.
      const elsewhere = answer.refused === "mcp-secret-unmapped" ? " `run.secrets` is set in the triggers file, not on this page." : "";
      warnings.push(`On this host ${whose(hit)} would be refused as ${answer.refused}, before they spend. ${answer.name ?? "The list"}: ${answer.why}. ${explainReason(answer.refused).next ?? ""}${elsewhere}`.trim());
    }
    let overlay = null;
    try {
      overlay = read(paths.globalPiDir || "");
    } catch {
      // The servers it adds were told so by the check. Exclusions alone were not, and nothing below can judge them.
      if (added.length === 0) warnings.push("This host's overlay mcp.json could not be read, so whether these tools still reach a server could not be judged here.");
    }
    if (overlay !== null) {
      const servers = { ...overlay.servers };
      if (FORGE_MCP_KINDS.includes(run.kind)) servers[FORGE_MCP_SERVER_NAME] = forgeMcpServer(run.kind, { gitlabUrl });
      const offered = (list) => list.filter((name) => Object.hasOwn(servers, name) && servers[name].enabled !== false);
      for (const hostCut of newCuts(servers, { was: offered(wasNames), now: offered(names) }, { autoEnableCodemode: overlay.autoEnableCodemode })) {
        warnings.push([`On this host this trigger's jobs would be refused as mcp-excluded, before they spend. ${hostCut.name}: ${hostCut.why}.`, explainReason("mcp-excluded").next, "Another host's overlay may route it another way."].filter(Boolean).join(" "));
      }
      for (const name of added) {
        const passed = new Set(Object.keys(run.secrets ?? {}));
        for (const ref of Object.hasOwn(servers, name) ? servers[name].refs ?? [] : []) {
          if (forwarded.unread.includes(ref) && !passed.has(ref)) warnings.push(`${ref} is forwarded by this host, and its line in the .env could not be read as the worker reads it, so whether ${name} gets that key could not be judged here.`);
        }
      }
    }
    return { warnings: warnings.length > 0 ? [...new Set(warnings), PICKUP_TAIL] : [] };
  }

  /**
   * The worker's own selection (`selectFailoverJob`) asked of a job's models on this host: each candidate in its order, with the reason
   * it is skipped or `QUALIFIES`, so what a job starts on is the first that qualifies. Its loop and its check, and no copy of either. A
   * cooldown, a dollar window or a busy endpoint is a moment's and no preview reads them, so `redis` answers none and no limit or
   * endpoint is handed over. Every model that passes is answered as if it had not, or the loop would stop at the first and say nothing
   * of a fallback behind it.
   */
  async function failoverOrder(job, list, overlay) {
    const order = [];
    await selectFailoverJob({ ...job, models: list }, {
      redis: { get: async () => null },
      id: "preview",
      models: overlay,
      now,
      log: (event, row) => {
        if (event === "model_candidate_skipped") order.push(row);
      },
      checkCandidate: async (candidate) => (await checkFailoverCandidate(candidate, { models: overlay, lookup: builtinModel })) ?? QUALIFIES,
    });
    return order;
  }

  /**
   * What a job of this entry would call under the deployment's cap (issue #800), judged only when the edit touches a model field
   * or the cap, and only of what it touches, so an edit of the flow is never refused over a pairing the person did not touch.
   *
   * What pickup refuses for free and this host's overlay or `.env` decides (a model it does not know, a list that comes from its
   * PI_ALLOWED_MODELS) is a warning: another host may hold what this one lacks, `judgeMcp`'s rule. A job with fallbacks is not refused
   * for one model at all: the worker's own selection skips it and starts the job on the next, so that is what is said (`failoverOrder`).
   * What stays a refusal costs more than a free refusal: a cap above the deployment's refuses the whole file at the loader, and a cap
   * the model a job STARTS ON cannot clear refuses its every call inside a paid container, so those are stopped here
   * (CONST-BUDGET-BEFORE-TOKENS). Any other model that cannot clear it is a warning: the cost guard refuses a call to it only if the job
   * makes one, which stops the job as `cost-cap`. A list the file itself contradicts on every host is the loader's to refuse, in the
   * funnel. One that clears only the smallest possible request is said out loud (`thin`).
   */
  async function judgeModels({ entry, was, text, facts, touched }) {
    const run = entry.run;
    const has = (key) => touched.includes(key);
    const capTouched = has("maxCostUsd");
    const mainTouched = has("provider") || has("model");
    if (capTouched && run.maxCostUsd !== undefined && run.maxCostUsd !== null && facts.ceiling !== null) {
      let asked;
      try {
        asked = parseUsdMicros(run.maxCostUsd, "run.maxCostUsd");
      } catch (error) {
        return refuse(String(error?.message ?? error));
      }
      // Never "raise the deployment's cap": a trigger cannot, so the sentence says who can move it. The worker runs the smaller of the two,
      // so a value above reads as allowing more than it does, and above the env's it refuses the whole file at load.
      if (asked > facts.ceiling) return refuse(`A trigger's job cap can only lower the deployment's: ${money(asked)} is above its ${money(facts.ceiling)}. Set ${money(facts.ceiling)} or less here, or remove this trigger's cap to run under the deployment's. The deployment's own cap belongs to its settings, not to this page.`);
    }
    const readOverlayDoc = overlayReader();
    const policy = policyOf({ entry, text, facts });
    if (policy.refusal) return policy;
    const { resolved } = policy;
    if (resolved.checks.length > 0 && resolved.runs.length === 0) return refuse(`This trigger's model could not be resolved (${resolved.checks[0].reason}): every job would be refused before it spends. Correct its model or its role.`);
    const warnings = new Set();
    for (const unresolved of resolved.checks) warnings.add(`${unresolved.project ? `In project ${unresolved.project}` : "In no project"} this trigger's model could not be resolved (${unresolved.reason}), so those jobs would be refused before they spend. Correct its model or its role.`);
    const unjudged = new Set();
    const thin = new Set();
    const refsOf = (entries) => (Array.isArray(entries) ? entries : []).map(splitModelEntry).filter((ref) => ref !== null).map((ref) => ({ provider: ref.provider, id: ref.model }));
    const addedRefs = (key) => (has(key) ? refsOf(delta(was?.run?.[key], run[key]).added) : []);
    const onHost = (reason, sentence) => `On this host this trigger's jobs would be refused as ${reason}, before they spend: ${sentence}`;
    for (const job of resolved.runs) {
      const main = { provider: job.provider, id: job.model };
      const mainName = `${main.provider}/${main.id}`;
      const list = job.models ?? facts.envList ?? null;
      const fallbacks = refsOf(job.fallbackModels);
      const failover = fallbacks.length > 0;
      // The model this job starts on: its main one, unless the worker's selection would pass that over.
      let startName = mainName;
      let selected = false;
      if (failover) {
        if (has("fallbackModels") || has("models")) {
          const offList = fallbacks.find((ref) => !failoverListUsable({ models: list, fallbackModels: [`${ref.provider}/${ref.id}`] }));
          // A list written in this entry that leaves out its own fallback never gets here: the loader refuses that, in the funnel.
          if (offList) warnings.add(onHost("model-failover-no-candidate", `every fallback must be on the allowed list (run.models, or PI_ALLOWED_MODELS when the trigger has none), and ${offList.provider}/${offList.id} is not.`));
        }
        let overlay;
        try {
          overlay = readOverlayDoc();
          selected = true;
        } catch {
          // Said below, by the questions that need the file, and no selection is claimed without it.
        }
        if (selected) {
          const order = await failoverOrder(job, list, overlay);
          const start = order.find((row) => row.reason === QUALIFIES)?.model;
          if (start !== undefined) startName = start;
          const skipped = order.filter((row) => row.reason !== QUALIFIES);
          const named = (rows) => listed(rows.map((row) => `${row.model} (${row.reason})`));
          const added = addedRefs("fallbackModels").map((ref) => `${ref.provider}/${ref.id}`);
          const spoken = skipped.filter((row) => has("models") || (mainTouched && row.model === mainName) || added.includes(row.model));
          if (order.length > 0 && start === undefined && (mainTouched || has("models") || has("fallbackModels"))) warnings.add(onHost("model-failover-no-candidate", `a job skips ${named(skipped)} and has no model left.`));
          else if (start !== undefined && spoken.length > 0) warnings.add(`On this host a job of this trigger skips ${named(spoken)} and starts on ${start}.`);
        }
      }
      // A job with fallbacks reaches none of these as itself, since selection answers for each of its models. One whose overlay could
      // not be read is asked what can be said without it, and that names the file and claims nothing of a model.
      if (!selected) {
        const asked = [...(mainTouched ? [{ ...main, main: true }] : []), ...addedRefs("models"), ...addedRefs("fallbackModels")];
        for (const ref of asked) {
          const name = `${ref.provider}/${ref.id}`;
          const known = checkModelsKnown([ref], { readOverlay: readOverlayDoc });
          if (known?.unavailable) warnings.add(`The overlay's models.json could not be read just now, so whether this deployment knows ${name} could not be judged here; a pickup asks again.`);
          // Not the model's fault and no other model's way out: every model on this provider, or every model at all, meets this.
          else if (known?.unknown && known.why !== "not-in-catalog") warnings.add(`The overlay's models.json could not be read or used for ${name} (${known.why}), so this host cannot run it. Fix that file, since another model may be refused the same way.`);
          else if (known?.unknown) warnings.add(onHost("model-unknown", `${name} is a model this deployment does not know (${known.why}). Choose one from the catalog, or declare it in the overlay's models.json.`));
          else if (known?.ok !== true && !known?.fallbackUnlisted) warnings.add(`The model catalog could not judge ${name} here; a pickup asks again.`);
        }
      }
      if (!failover) {
        if (has("models") && Array.isArray(list) && list.length > 0) {
          const known = checkModelsKnown(refsOf(list), { readOverlay: readOverlayDoc });
          if (known?.fallbackUnlisted) warnings.add(onHost("model-not-allowed", `${known.fallbackUnlisted.provider}/${known.fallbackUnlisted.id} declares fallback models the allowed list does not name. Add them to the list, or remove it.`));
        }
        // A main model and a list both written in this entry that disagree never get here: the loader refuses them, in the funnel.
        if ((mainTouched || has("models")) && Array.isArray(list) && !modelOnList(list, main.provider, main.id)) warnings.add(onHost("model-not-allowed", `${mainName} is not on the models they may call here. Add it to the list, or choose another model.`));
      }
      const cap = facts.capOf(job.maxCostUsd);
      if (cap === null) continue;
      // The main model and what the trigger itself names. Not the deployment's list or a role map's every model: a job under a
      // cap simply cannot call one it does not fit, and lowering this trigger's cap is no fault of a model it never asked for.
      // A model edit under a cap it did not touch asks only of the model it moved.
      const named = capTouched ? [main, ...refsOf(run.models), ...fallbacks] : [...(mainTouched ? [main] : []), ...addedRefs("models"), ...addedRefs("fallbackModels")];
      for (const ref of new Map(named.map((one) => [`${one.provider}/${one.id}`, one])).values()) {
        const name = `${ref.provider}/${ref.id}`;
        // What this model's failing means for a job: it cannot start at all, or it stops at a call to this one. Failover can move a job
        // to it with no check of the cap (`selectFailoverJob`), so the job then starts a container before that first call is refused.
        const stopped = (sentence) => {
          if (name === startName) return refuse(sentence);
          warnings.add(`${sentence} A call to this one stops the job as cost-cap, and a job moved to it starts a paid container first.`);
          return null;
        };
        // A models.json that cannot be read now was said above, and an amount read without it would be a guess.
        let overlay;
        try {
          overlay = readOverlayDoc();
        } catch {
          unjudged.add(name);
          continue;
        }
        const view = outputCapView({ models: overlay, provider: ref.provider, modelId: ref.id, builtinModel, builtinChatModels });
        if (view?.api === "pi-messages" || (view?.api === undefined && ref.provider === "radius")) {
          const refused = stopped(`${name}: ${RADIUS_COST_CAP_LABEL}. ${RADIUS_COST_CAP_FIX}.`);
          if (refused) return refused;
          continue;
        }
        if (outputUnboundable(view)) {
          const refused = stopped(`${name}'s output cap travels as max_completion_tokens to a server that may ignore it, so the runner counts every call to it unboundable and refuses it under a job cap. Set "compat": { "maxTokensField": "max_tokens" } on it in models.json, or choose another model: docs/egress.md, "Local model servers".`);
          if (refused) return refused;
          continue;
        }
        const priced = boundModelOf(ref, { builtinModel, overlay });
        const floor = firstCallFloorMicros(priced);
        if (floor === null) {
          unjudged.add(name);
          continue;
        }
        // The amount a person is told is a short task's, never the floor's: a cap at the floor admits a request no job sends,
        // so it would read as the answer and refuse every real job. The floor only decides which of the two this is: below
        // it nothing can be sent at all, and between the two a job small enough might be.
        const shortTask = firstCallBoundMicros(priced, FIRST_CALL_SHORT_TASK_BYTES);
        if (shortTask <= cap) continue;
        const room = facts.ceiling === null || shortTask <= facts.ceiling;
        const out = room ? `Choose another model, or a job cap of at least ${money(shortTask)}; a repository's context files and a longer task need more.` : "A trigger can only lower the deployment's job cap: choose another model. The deployment's own cap belongs to its settings, not to this page.";
        // "At least", because the bound is a lower one for any larger request: it grows with the whole of it, and a repository's
        // context files go in the system prompt before any task does (`FIRST_CALL_SHORT_TASK_BYTES` holds none).
        if (floor > cap) {
          const refused = stopped(`${name} needs at least ${money(shortTask)} for a short task's first call, above ${room ? "this trigger's" : "the deployment's"} ${money(room ? cap : facts.ceiling)} job cap, so the runner would refuse every call to it before it is sent. ${out}`);
          if (refused) return refused;
          continue;
        }
        thin.add(`${name} clears this ${money(cap)} job cap only for the smallest first call: a short task's needs ${money(shortTask)}, so most jobs that call it would be refused before they spend. ${out}`);
      }
    }
    return { unjudged: [...unjudged], thin: [...thin], warnings: [...warnings] };
  }

  /**
   * Everything the file and the settings say, with no queue or registry read: the preview's and the apply's one judgement. The
   * apply runs it again because a deployment's cap can move between the two, and `expect` covers only the triggers file.
   */
  async function judge(rawBody) {
    const body = plain(rawBody) && typeof rawBody.index === "string" && /^\d{1,6}$/.test(rawBody.index) ? { ...rawBody, index: Number(rawBody.index) } : rawBody;
    const problem = shapeProblem(body);
    if (problem) return refuse(problem);
    if (!paths?.triggersPath) return refuse("This console does not name its triggers file.", 409);
    const expect = writeInputs({ paths: [paths.triggersPath], fs });
    let doc;
    let beforeText;
    try {
      beforeText = fs.readFileSync(paths.triggersPath, "utf8");
      doc = JSON.parse(beforeText);
    } catch {
      return unreadableFile();
    }
    const newer = triggersFileVersionProblem(doc, { supported: triggersTables.supported });
    if (newer?.newer) return refuse(`${newer.message}, so nothing was written and nothing in it was lost; change it with that release.`, 409);
    const row = rowName("trigger", body.index, "console");
    const entry = Array.isArray(doc?.triggers) ? doc.triggers[body.index] : undefined;
    if (!plain(entry) || !plain(entry.run)) return refuse(`There is no trigger at row ${body.index + 1} any more. Reload the page.`, 409, "changed");
    // What the Confirm's `expect` cannot cover: the minutes on the page before this preview. The entry, not the file, so another
    // trigger's edit does not send this person back (`triggerEntryDigest`).
    if (triggerEntryDigest(entry) !== body.pageDigest) return refuse("This trigger changed since the page drew it, so nothing was changed. Reload the page and make the change again.", 409, "changed");

    // What the trigger edit's own body judges: a value, by the loader's words. The rest, and a null, this planner applies. A form
    // that had nothing to send and one that sent what the file holds are one answer: a model typed that is already on the list
    // sends nothing, and that is no error, only no change.
    const sent = CARD_FIELDS.filter((key) => body[key] !== undefined && !sameToAJob(key, entry.run[key], body[key]));
    if (sent.length === 0) return { unchanged: `${row} already says this.` };
    const coreKeys = ["flow", "provider", "model"].filter((key) => typeof body[key] === "string");
    const restKeys = sent.filter((key) => !coreKeys.includes(key));
    const withRest = (run) => {
      const next = { ...run };
      for (const key of restKeys) {
        if (body[key] === null) delete next[key];
        else next[key] = body[key];
      }
      return next;
    };
    let core = null;
    if (coreKeys.length > 0) {
      const planned = planTriggerEditCore({ params: { index: body.index, ...Object.fromEntries(coreKeys.map((key) => [key, body[key]])) }, paths, env, surface: "console", fs, baseRun: withRest });
      if (planned.refusal) return refuse(planned.refusal);
      core = planned.plan;
    }
    const finish = (run) => {
      const next = withRest(run);
      if (body.keyOrder === undefined) return next;
      if (!same([...body.keyOrder].sort(), Object.keys(next).sort())) return null;
      return Object.fromEntries(body.keyOrder.map((key) => [key, next[key]]));
    };
    const mutate = (raw) => (core ? core.mutate(raw) : raw).map((tr, i) => (i === body.index ? { ...tr, run: finish(tr.run) } : tr));
    if (finish(core ? core.mutate(doc.triggers)[body.index].run : entry.run) === null) return refuse("This trigger's keys changed since the edit being undone. Reload the page and make the change again.", 409, "changed");

    // The funnel itself, against a file system that keeps every write in memory: the bytes the Confirm will write, or its own
    // words for why not. What it stamps as the file's version is the file's need.
    const dry = dryRunFs(fs);
    let result;
    try {
      result = writeTriggers({ triggersPath: paths.triggersPath, mutate, expect, fs: dry, now, ...triggersTables });
    } catch (error) {
      return refuse(`the change could not be checked (${typeof error?.code === "string" ? error.code : "error"}); nothing was changed`);
    }
    // The read inside the funnel can fail where the one above did not, and says what the one above says.
    if (result?.unreadable) return unreadableFile();
    if (result?.invalid) return refuse(`rejected: ${result.invalid}`, result.newer ? 409 : 400);
    const afterText = dry.files.get(paths.triggersPath);
    const afterDoc = JSON.parse(afterText);
    const nextEntry = afterDoc.triggers[body.index];
    // By value, key by key: a reorder alone moves nothing a job reads, and the writer's own formatting is not a change.
    const touched = CARD_FIELDS.filter((key) => !same(entry.run[key], nextEntry.run[key]));
    if (touched.length === 0) return { unchanged: `${row} already says this.` };

    // Each side's `run` as the loader keeps it, which is what a job gets. The old side is one the loader may refuse, since a person
    // can come here to fix it: then what the file held is all there is to compare with, and it has no way back.
    const loadedRun = (text) => {
      try {
        return parseTriggers(text, paths.triggersPath, triggersTables)[body.index]?.run ?? null;
      } catch {
        return undefined;
      }
    };
    const wasLoaded = loadedRun(beforeText);
    const wasRun = wasLoaded ?? entry.run;
    const nowRun = loadedRun(afterText) ?? nextEntry.run;

    let facts = null;
    let unjudged = [];
    let thin = [];
    let warnings = [];
    if (sent.some((key) => MODEL_OR_CAP.includes(key))) {
      facts = modelFacts({ paths, readHostEnv, fs });
      if (facts.refusal) return facts;
      const judged = await judgeModels({ entry: nextEntry, was: entry, text: afterText, facts, touched });
      if (judged.refusal) return judged;
      unjudged = judged.unjudged;
      thin = judged.thin;
      warnings = [...(facts.note ? [facts.note] : []), ...judged.warnings];
    }
    // Only an edit of the servers or the exclusions: a model edit would be told about a server nobody touched.
    const reachesPickup = touched.some((key) => MCP_CHECK_FIELDS.includes(key));
    if (reachesPickup) {
      facts ??= modelFacts({ paths, readHostEnv, fs });
      const judged = judgeMcp({ was: wasRun, run: nowRun, entry: nextEntry, text: afterText, facts });
      if (judged.refusal) return judged;
      warnings = [...warnings, ...judged.warnings];
    }

    // Undo: the keys it touched, as the file held them. A key the file held as null is the one value `null` cannot say (it
    // means delete), and a trigger the same judgement would refuse today is one this page would refuse to put back, so each of
    // those is said by hand rather than offered as a button that refuses.
    const afterDigest = triggerEntryDigest(nextEntry);
    const heldNull = touched.find((key) => entry.run[key] === null);
    // A file the loader refused as it was: this write may be what fixes it, and no button writes the broken one back.
    const beforeLoads = wasLoaded !== undefined;
    let backRefused = null;
    if (beforeLoads && heldNull === undefined) {
      if (touched.some((key) => MODEL_OR_CAP.includes(key))) backRefused = (await judgeModels({ entry, was: nextEntry, text: beforeText, facts, touched })).refusal ?? null;
      if (backRefused === null && reachesPickup) backRefused = judgeMcp({ was: nowRun, run: wasRun, entry, text: beforeText, facts }).refusal ?? null;
    }
    let inverse = null;
    if (beforeLoads && heldNull === undefined && backRefused === null) {
      const fields = Object.fromEntries(touched.map((key) => [key, entry.run[key] ?? null]));
      const replayed = { ...nextEntry.run };
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete replayed[key];
        else replayed[key] = value;
      }
      inverse = { action: "trigger-environment-edit", body: { index: body.index, pageDigest: afterDigest, ...fields, ...(same(Object.keys(replayed), Object.keys(entry.run)) ? {} : { keyOrder: Object.keys(entry.run) }) } };
    }
    // Whether the writer, changing nothing, would write these bytes back. On a hand-written file it does not: the first write
    // puts all of it in the writer's layout, every line of the diff moves for that, and an Undo restores values, not bytes, so
    // neither the Confirm nor the Undo may read as though only this key moved.
    const keepsLayout = (() => {
      const probe = dryRunFs(fs);
      try {
        const same = writeTriggers({ triggersPath: paths.triggersPath, mutate: (raw) => raw, fs: probe, now, ...triggersTables });
        if (same?.ok === true) return probe.files.get(paths.triggersPath) === beforeText;
      } catch {
        // The bytes are what is asked about, and they were read above.
      }
      return `${JSON.stringify(doc, null, 2)}\n` === beforeText;
    })();
    const undo = !beforeLoads ? `Edit ${row} back by hand: the file did not load as it was, and this page will not write that back` : inverse !== null ? (keepsLayout ? `Put ${row} back as it was` : `Put ${row}'s values back; the file keeps the layout this write gave it`) : heldNull !== undefined ? `Edit ${row} back by hand: the file held run.${heldNull} as null, which this page cannot write` : `Edit ${row} back by hand: this page would refuse what it said before. ${backRefused}`;

    const effectiveTools = wasLoaded ? { before: wasRun.excludeTools ?? [], after: nowRun.excludeTools ?? [] } : null;
    const changes = touched.map((key) => ({ key, ...changeWords(key, entry.run[key] ?? undefined, nextEntry.run[key] ?? undefined, facts, key === "excludeTools" ? effectiveTools : null) }));
    if (sent.some((key) => MODEL_OR_CAP.includes(key))) {
      const before = policyOf({ entry, text: afterText, facts });
      const after = policyOf({ entry: nextEntry, text: afterText, facts });
      const callable = before.refusal || after.refusal ? null : callableWidening(before.resolved, after.resolved, facts.envList);
      const named = changes.filter((change) => ["provider", "model", "models", "fallbackModels"].includes(change.key)).at(-1);
      if (callable !== null && named) named.widening = `This widens which models its jobs may call: ${callable}.`;
    }
    const need = {
      triggersVersion: Number.isSafeInteger(afterDoc.version) ? afterDoc.version : 1,
      // Over what the loader keeps of each trigger, doctor's count: a `run` key it drops reaches no job, so it needs nothing.
      jobDataVersion: parseTriggers(afterText, paths.triggersPath, triggersTables).reduce((most, trigger) => Math.max(most, jobDataVersionFor(trigger?.run, jobDataTables)), 1),
    };
    const stamped = need.triggersVersion > (Number.isSafeInteger(doc.version) ? doc.version : 1);
    return { body, expect, row, type: entry.on?.type, beforeText, afterText, mutate, dry, changes, unjudged, thin, warnings, keepsLayout, undo, inverse, need, stamped, nextRun: nowRun };
  }

  /**
   * Each live host against the proposed file's need (#761, `INT-HOST-REGISTRY-CONTRACT`). Refuses on a lower version, on none
   * (a worker from before the field drops a key it does not know, which for a narrowing runs the job wider on a clean record),
   * and on a registry it cannot read, since "unknown" is not "every host reads it". Nothing is read while the need is 1: every
   * release reads that, and a Valkey blink must not refuse an edit that needs nothing of it.
   */
  async function versionGate(need) {
    const wanted = Object.entries(need).filter(([, version]) => version > 1);
    if (wanted.length === 0) return { hosts: null };
    let read;
    try {
      read = await readHosts();
    } catch {
      read = null;
    }
    if (!Array.isArray(read?.hosts)) return refuse("The live hosts could not be read, so nothing says each reads what this change needs. Nothing was written; try again.", 503);
    const hosts = read.hosts.filter((host) => typeof host?.name === "string");
    const silent = hosts.filter((host) => wanted.some(([field]) => host[field] === undefined || host[field] === null || host[field] === ""));
    const older = hosts.filter((host) => !silent.includes(host) && wanted.some(([field, version]) => !(Number.isSafeInteger(Number(host[field])) && Number(host[field]) >= version)));
    if (silent.length > 0 || older.length > 0) {
      const what = wanted.map(([field, version]) => `${field === "triggersVersion" ? "the triggers file" : "the job data"} at version ${version}`).join(" and ");
      const parts = [older.length ? `${hostsNamed(older.map((host) => host.name))} ${older.length === 1 ? "reads" : "read"} less, and would hold every job this file touches` : "", silent.length ? `${hostsNamed(silent.map((host) => host.name))} ${silent.length === 1 ? "publishes" : "publish"} no version, and would drop what ${silent.length === 1 ? "it does" : "they do"} not know, which can run a job wider on a clean record` : ""].filter(Boolean);
      return refuse(`This change needs ${what}. ${parts.join("; ")}. Upgrade ${silent.length + older.length === 1 ? "that host" : "those hosts"} first.`, 409);
    }
    return { hosts: hosts.map((host) => host.name) };
  }

  /** The jobs in line this file would refuse, on the proposed entry. A slow queue costs the sentence, never the preview. */
  async function jobsRefused(index, dry) {
    let timer;
    try {
      const late = new Promise((resolve) => {
        timer = setTimeout(resolve, jobsReadMs, { rows: [], incomplete: true });
      });
      return (await Promise.race([Promise.resolve().then(() => readSkew(index, dry)), late])) ?? { rows: [], incomplete: true };
    } catch {
      return { rows: [], incomplete: true };
    } finally {
      clearTimeout(timer);
    }
  }

  function skewLines({ rows = [], incomplete = false }) {
    const lines = [];
    if (rows.length > 0) {
      const said = rows.slice(0, SKEW_NAMED_MAX).map((row) => (row.conditions ? `${row.jobId} as wait-skew (its wait conditions)` : `${row.jobId} as trigger-skew (run.${row.field})`));
      const more = rows.length - said.length;
      // Names, and no way out: a job a `/command` queued is not re-run from the console, so no instruction here holds of them all.
      lines.push(`With this change, a host reading this file refuses ${rows.length} of this trigger's jobs in line, before ${rows.length === 1 ? "it spends" : "they spend"}: ${said.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`);
    }
    if (incomplete) lines.push("The jobs in line could not all be read, so any of them may also be refused as trigger-skew.");
    return lines;
  }

  async function preview(body, ctx) {
    if (!authority(ctx)) return denied;
    const judged = await judge(body);
    if (judged.refusal || judged.unchanged) return judged;
    const gate = await versionGate(judged.need);
    if (gate.refusal) return gate;
    const { row, changes, undo, inverse, unjudged, thin } = judged;
    const added = changes.flatMap((change) => change.addedServers ?? []);
    // `forge` is the job's own forge and its own token (DES-FORGE-MCP), in no overlay, so no host lacks it and no host publishes it.
    const servers = added.filter((name) => name !== "forge");
    const flowChange = changes.some((change) => change.key === "flow");
    let hosts = [];
    let hostsUnread = false;
    if (servers.length > 0 || flowChange) {
      try {
        const read = await readHostLoads();
        hosts = read?.hosts ?? [];
        // No row for a read that failed is no statement about any host, and "no host has published" would be one.
        hostsUnread = !read || read.unreachable === true;
      } catch {
        hostsUnread = true;
      }
    }
    const reach = [...servers.map((name) => serverReach(name, hosts)), ...(added.includes("forge") ? ["the job's own forge server"] : [])];
    // True of every shape, so no branch has to know what else this preview says: a warning, a model, a cap or a host may stop a job
    // at pickup, and one that gets past them all connects. REJECTED: leaving "connect" out where a warning stands, which one source
    // of warnings could not know about another's.
    const said = changes.map((change) => (change.addedServers?.length > 0 ? { ...change, widening: `This widens what its jobs reach: a job that reaches its container connects to ${listed(reach)}.` } : change));
    const lacking = flowChange ? hostsWithoutFlow(judged.body.flow, hosts, judged.nextRun?.packages !== false) : [];
    const warnings = [...judged.warnings, ...(lacking.length > 0 ? [`${hostsNamed(lacking)} ${lacking.length === 1 ? "has" : "have"} no skill named ${judged.body.flow} in ${lacking.length === 1 ? "its" : "their"} overlay. A job there finds it only in its repository, the trigger's skills folder or a staged package, and runs without its flow if none holds it.`] : [])];
    // A schedule's and a watch rule's jobs carry no matched index, so the skew check has nothing to compare them with: it answers
    // `ok` for every one (`makeCheckWaitSkew`). Nothing to read, and nothing to say about what could not be read.
    const noSkew = judged.type === "cron" || judged.type === "watch";
    const skew = noSkew ? { rows: [], incomplete: false } : await jobsRefused(judged.body.index, judged.dry);
    const lines = [
      ...said.flatMap((change) => [change.line, ...(change.widening ? [change.widening] : [])]),
      ...(judged.keepsLayout ? [] : ["This file is not in the writer's layout, so this write also rewrites all of it: spacing and line breaks move in lines this change does not touch, and what each key says does not. Undo puts the values back, not that layout."]),
      ...warnings,
      ...thin,
      // Each of these is about when this file's change takes effect, and each holds of a fleet where hosts keep their own copy
      // (docs/multi-host.md, trap 2: syncing the file is the operator's). "New deliveries use this" did not: this host's file is
      // all this page writes, and a receiver in compose's single-file mount reads it only at its restart.
      "The services reading this file use it from their next reload, for the jobs they queue after that.",
      noSkew ? "A job already in line keeps what it was queued with and runs without this change. A running job is not touched." : "A job already in line keeps what it was queued with and runs without this change, unless it is named below as refused. A running job is not touched.",
      "A host with its own copy of this file keeps what it has until that copy changes.",
      ...(judged.type === "cron" ? ["While hosts' copies differ on a schedule, no host installs a change to one, so this one moves when they agree."] : []),
      ...skewLines(skew),
      ...(judged.stamped ? [`Stamps the file version ${judged.need.triggersVersion}: a host reading less waits on every trigger's jobs, not only this one's.`] : []),
      ...(gate.hosts === null ? [] : [gate.hosts.length > 0 ? `${hostsNamed(gate.hosts)} ${gate.hosts.length === 1 ? "reads" : "each read"} what this change needs.` : "No host is live right now, so no host's release could be checked."]),
      ...servers.map((name) => `A job on a host without ${name}, or with it off, is refused as mcp-server-unknown, before it spends; a host with no overlay or no mcp.json refuses it as mcp-config-invalid.${hosts.length > 0 ? ` ${serverHosts(name, hosts)}.` : hostsUnread ? " What the hosts published could not be read, so which of them have it is unknown." : " No host has published which servers it has."}`),
      ...(unjudged.length > 0 ? [`The first call on ${listed(unjudged)} could not be bounded here, so the runner judges it when a job runs.`] : []),
      `Written to ${basename(paths.triggersPath)} on this host and audited as trigger-edit, by ${typeof ctx.name === "string" && ctx.name !== "" ? ctx.name : "the operator"} at the console.`,
    ];
    return {
      target: paths.triggersPath,
      expect: judged.expect,
      beforeText: judged.beforeText,
      afterText: judged.afterText,
      summary: [`Change ${row}`, ...lines],
      plan: { index: judged.body.index, row, changes: said.map(({ key, line, widening }) => ({ key, line, ...(widening ? { widening } : {}) })), warnings, skew: { rows: skew.rows ?? [], incomplete: skew.incomplete === true }, need: judged.need, undo, inverse },
      payload: { body: structuredClone(judged.body) },
      // The file's, for the audit row (INT-CONSOLE-AUDIT-LOG): not `triggerEntryDigest`, which is one entry's.
      beforeDigest: sha(judged.beforeText),
      afterDigest: sha(judged.afterText),
    };
  }

  async function apply(entry, ctx) {
    if (!authority(ctx)) return { invalid: denied.refusal };
    if (!entry?.payload?.body) return { invalid: "This confirmation holds no change; preview it again." };
    const judged = await judge(entry.payload.body);
    if (judged.refusal) return { invalid: judged.refusal };
    if (judged.unchanged) return { invalid: judged.unchanged };
    const gate = await versionGate(judged.need);
    if (gate.refusal) return { invalid: gate.refusal };
    // The preview's snapshot, not this judgement's: `expect` is what says nothing moved between the two.
    return writeTriggers({ triggersPath: paths.triggersPath, mutate: judged.mutate, expect: Array.isArray(entry.expect) ? entry.expect : judged.expect, fs, now, ...triggersTables });
  }

  return { preview, apply };
}
