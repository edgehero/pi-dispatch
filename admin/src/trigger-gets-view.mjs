/**
 * What a trigger's jobs get, in words (issue #800, the TriggerEnvironment card): the one place the trigger page's card gets them.
 * Three sources, and a sentence never lets one read as another:
 *   - THE TRIGGERS FILE says what the next job gets. Each row's control is drawn from it, read once with the digest the page
 *     sends back (`readTriggerGetsEntry`), so what a person saw and what the stale check compares are one read.
 *   - WHAT EACH HOST PUBLISHED (`readHostLoadsView`) says what that host can load. A host that published nothing, whose record is
 *     old or newer than this build reads, or whose list of what matters here is cut, is unknown and never "the same": that is
 *     the one word a host on an older release could otherwise earn by saying nothing.
 *   - A RUN'S RECORD says what that run had, through `loaded-words.mjs` and no second copy of its words. It is quoted under a row as
 *     the past, by its id and host, and never fills in what the file does not say.
 *
 * PURE apart from `readTriggerGetsEntry`. No money or policy here either: whether a model fits a cap, whether a host reads a field and
 * whether a job in line is refused are the planner's to judge at the preview (`trigger-environment-plans.mjs`), so nothing on this
 * card can disagree with what the Confirm does. REJECTED: greying out a model the cap cannot pay for, which would be a second copy
 * of a rule that moves with the deployment's settings.
 */
import * as nodeFs from "node:fs";
import { FORGE_MCP_KINDS, FORGE_MCP_SERVER_NAME } from "@edgehero/pi-dispatch/mcp-config";
import { EXCLUDABLE_TOOL_NAMES, MCP_EXCLUDABLE_TOOL_NAMES, mcpServerToolPattern, triggersFileVersionProblem } from "@edgehero/pi-dispatch/triggers";
import { hostsAgree } from "@edgehero/pi-dispatch/host-loads";
import { optionalUsdMicros } from "@edgehero/pi-dispatch/money";
import { hostLoadsRow, hostPiFor, triggerLastRun } from "./loaded-words.mjs";
import { normalizeTriggerForDisplay } from "./read-model.mjs";
import { triggerEntryDigest } from "./trigger-edit-core.mjs";
import { listed } from "./words.mjs";

/** The card's fixed sentences, exported so its ledger can cite each one. */
export const TRIGGER_GETS_WORDS = Object.freeze({
  title: "What its jobs get",
  how: "How a change applies",
  fileSays: "The rows say what the next job gets, from the triggers file.",
  noRun: "No run in the available history.",
  noRecord: "No run in the available history says what it loaded.",
  historyUnread: "The run history could not be read just now, so this says nothing of what its runs had.",
  repositoryPart: "The repository’s part is decided at its base commit.",
  noHost: "No live host says it can run this trigger’s jobs.",
  noLiveList: "No live host is listed just now, so these are the hosts that last published, running or not.",
  hostsUnread: "The hosts’ doctor runs could not be read, so each reads unknown, never the same.",
  repositoryExtensions: ".pi/extensions at the base commit, merge-gated. Changed in the repository, not here.",
  oneExtension: "A trigger cannot turn off one extension: it takes all the staged packages, or none.",
  newExtension: "A new extension, or another version, is staged first, for every trigger.",
  packagesOff: "The file says \"packages\": false, so these jobs load none of them, nor their tools, skills, prompt templates or themes.",
  packagesOn: "Off writes \"packages\": false, and none load, nor their tools, skills, prompt templates or themes.",
  packagesLoad: "Its jobs load what is staged on the host that runs them.",
  noExtensions: "The hosts that can say name no staged package or overlay extension.",
  noExtensionsKnown: "No host’s doctor run can say which extensions it has.",
  forgeServer: "the job’s own forge, with its own token; in no overlay",
  noServers: "The hosts that can say name no MCP server, and this trigger names none.",
  noServersKnown: "No host’s doctor run can say which MCP servers it has, and this trigger names none.",
  serverRefused: "A job on a host without a server it names, or with it off, is refused as mcp-server-unknown, before it spends; a host with no overlay or no mcp.json refuses it as mcp-config-invalid. A key a server uses must reach the job, through run.secrets in the file or a host’s PI_FORWARD_ENV, or the job is refused as mcp-secret-unmapped.",
  toolsOn: "On means not removed. powershell, grep, find and ls stay off unless an extension turns them on, so a trigger can remove them too.",
  extensionTools: "A trigger cannot remove a tool an extension adds. A repository’s tools stay a count, so they have no chip here.",
  serverToolsLater: "A server’s tools are offered once this trigger names it: turn it on and confirm first.",
  lastWay: "Removing every tool that reaches a server refuses its jobs at pickup as mcp-excluded, before they spend. The preview refuses that where the file alone decides it, and warns where this host’s overlay routes it so; another host’s may route it another way.",
  jobTool: "report_progress comes with run.progress, in the Edit form: no list removes it.",
  elsewhere: "Set elsewhere: the image in each host’s environment or run.image in the file, secrets on the Secrets page, and the skills folder (run.skillsDir) in the file.",
  noScript: "Enable JavaScript to preview and confirm a change. Reading and navigation work without it.",
  readOnly: "Forms are off on this read-only console.",
  viewer: "An operator changes these on this page, with one preview and one Confirm.",
  noTool: "No tool reaches this action; dispatch_trigger_edit keeps today’s scope.",
  flowPicker: "It leaves out what is in a skills folder, or in a repository not on this host, and any other name can be typed.",
  reloadDrops: "A Confirm elsewhere on this page reloads it, and drops any change not yet written in What its jobs get.",
  othersUnread: "This page read the triggers file, and its other reads failed: the run history, the hosts and the jobs in line are unknown.",
  pillOrder: "differs in the order or kind of what it loads",
  notLinked: "A change made on this card is not linked to that run’s refusal.",
  unreadRow: "This page could not read this trigger’s row from the file, so it shows the last read and offers no change. Reload to try again.",
  watch: "A watch rule’s run is set in the file: it allows only some of these fields, so this page offers no change here.",
  command: "not a flow, set in the file",
  barOne: "1 change, not written yet:",
  barMany: "{n} changes, not written yet:",
});

const code = (text) => ({ code: text });
const run = (id) => ({ run: id });
const time = (ms) => ({ time: ms });

const unique = (items) => [...new Set(items)];

/**
 * This row of the file, as a person's page draws it, with the digest of those same bytes when the page draws a form. One read, so a
 * file changed between two reads cannot put a digest beside values the person never saw. The digest covers the entry's prompt and
 * secret references, so it is asked for only for an operator's form. Null where there is no row, the file cannot be read, or a newer
 * release wrote it: its entries may use fields this build cannot read, and the planner would refuse any change to it.
 */
export function readTriggerGetsEntry({ triggersPath, index, withDigest = false, fs = nodeFs }) {
  try {
    const doc = JSON.parse(fs.readFileSync(triggersPath, "utf8"));
    if (triggersFileVersionProblem(doc)?.newer === true) return null;
    const entry = doc?.triggers?.[index];
    const trigger = entry === undefined ? null : normalizeTriggerForDisplay(entry);
    if (trigger === null) return null;
    return { trigger: { ...trigger, index }, ...(withDigest ? { pageDigest: triggerEntryDigest(entry) } : {}) };
  } catch {
    return null;
  }
}

// ---- the hosts -------------------------------------------------------------------------------------------------------

/** Why this host's row can say nothing of this trigger's jobs, or null. Only a part this trigger would load from counts. */
function cannotSay(row, trigger) {
  if (row.state === "old") return "old";
  if (row.state !== "current") return row.why ?? "absent";
  const blind = (part) => (row.unread ?? []).includes(part) || (row.more?.[part] ?? 0) > 0;
  if (blind("skills")) return "partial";
  if (trigger.packages !== false && blind("packages")) return "partial";
  if (row.overlayExtensionsAllowed === true && blind("extensions")) return "partial";
  const named = overlayServersOf(trigger);
  if (named.length > 0 && (blind("mcp") || blind("keys") || (row.mcp ?? []).some((server) => named.includes(server.name) && server.where === null))) return "partial";
  return null;
}

/** The servers this trigger names that an overlay must define: `forge` is the job's own, on no host's list. */
const overlayServersOf = (trigger) => (trigger.mcp ?? []).filter((name) => name !== FORGE_MCP_SERVER_NAME);

/** What a job of this trigger gets on this host, each fact keyed so two hosts can be compared and worded so a pill can say it. */
function hostFacts(row, trigger) {
  const facts = new Map();
  if (trigger.packages !== false) for (const pkg of row.packages ?? []) facts.set(`p:${pkg.name} ${pkg.version}`, `${pkg.name} ${pkg.version}`);
  if (row.overlayExtensionsAllowed === true) for (const entry of row.extensions ?? []) facts.set(`o:${entry.name}`, `${entry.name}, from its overlay`);
  for (const name of row.skills ?? []) facts.set(`s:${name}`, `skill ${name}`);
  for (const name of overlayServersOf(trigger)) if ((row.mcp ?? []).some((server) => server.name === name && server.enabled === true)) facts.set(`m:${name}`, name);
  return facts;
}

/**
 * This host's record, cut to what reaches a job of this trigger, for `hostsAgree`: its packages unless it withholds them, the overlay's
 * extensions where the host allows them, its skills, the servers it names and its own flow's answer. So "the same" is asked of the one rule
 * every other surface uses, and it is about what these jobs get. REJECTED: asking it of the whole record, where another trigger's flow or a
 * server this one never names would deny "the same" over what no job of this trigger touches. A server it does not name has its own row, and
 * that row says the server is not on for these jobs and what turning it on would meet (`mcpRow`), so the pill and the row do not disagree.
 */
function agreeRow(row, trigger) {
  const named = overlayServersOf(trigger);
  return {
    state: "current",
    unread: [],
    more: {},
    overlayExtensionsAllowed: true,
    extensions: row.overlayExtensionsAllowed === true ? row.extensions ?? [] : [],
    skills: row.skills ?? [],
    mcp: (row.mcp ?? []).filter((server) => named.includes(server.name) && server.enabled === true),
    packages: trigger.packages === false ? [] : row.packages ?? [],
    flows: (row.flows ?? []).filter((entry) => entry.trigger === trigger.index && entry.flow === trigger.flow),
  };
}

/** How a host defines a server: the same four facts the MCP row says of it, so the pill and the row cannot disagree. */
const serverDefinition = (server) => JSON.stringify([server.transport, server.where, server.exposure, server.keys]);

const FLOW_TIER_WORDS = Object.freeze({ repository: "from the repository", trigger: "from its skills folder", overlay: "from the overlay", none: "in no tier", unknown: "in no tier a host can see" });

/** Where doctor found this trigger's flow on this host, or null when it has no answer for this flow: it may have run before an edit. */
function flowAnswer(row, trigger) {
  const found = (row.flows ?? []).find((entry) => entry.trigger === trigger.index && entry.flow === trigger.flow);
  if (!found) return null;
  return found.tier === "package" ? `from ${found.package ?? "a staged package"}` : FLOW_TIER_WORDS[found.tier] ?? null;
}

/**
 * Whether doctor looked everywhere a job of this trigger would and found this flow nowhere: `none` with the repository's own answer `absent`,
 * so its folder is on this host and said so (`flowTierOf`). A forge's repository is not on a host, so its row is `unknown`, and a host that
 * could not read a tier demotes `none` to `unknown` before it publishes: each of those may still find it, and neither is said to lack it.
 * REJECTED: `none` alone, which trusts the one word to imply the other when the reader's parse takes any pair of them.
 */
function lacksFlow(row, trigger) {
  const found = trigger.flow === null ? null : (row.flows ?? []).find((entry) => entry.trigger === trigger.index && entry.flow === trigger.flow);
  return found?.tier === "none" && found.repo === "absent";
}

/**
 * One pill per host: `{ name, tone, icon, word }`. A pill must not say what the rows beneath it contradict, so "the same" needs two or more
 * hosts that can say, `hostsAgree` true of what reaches this trigger's jobs (`agreeRow`), and what it does not compare, the image and its pi,
 * alike too. A host alone has nothing to be the same as, and REJECTED is "the same" there: it would read a one-host deployment and a host
 * beside three silent ones as proof. Each difference is said by what a host has over another, what it goes without, what it runs and how it
 * defines a server. A host with no answer for the flow, or no image to read, is said as that: not known to differ, and not the same. A host
 * whose doctor found the flow nowhere says so whoever agrees with it, and alone or beside silent hosts as much as beside others: hosts that all
 * lack it do agree, and REJECTED is "the same" there, over jobs that would not find what they are told to run. `liveList`: whether these rows are the
 * live hosts'. Where they are only who last published (every worker stopped, or the fleet not read yet), a stopped host's record is still in date, so
 * one row proves nothing about how many hosts there are, and "the only host" is a claim only the live list can back.
 */
function hostPills(rows, trigger, liveList) {
  const named = overlayServersOf(trigger);
  const known = rows.filter((row) => cannotSay(row, trigger) === null).map((row) => ({ row, facts: hostFacts(row, trigger), flow: trigger.flow === null ? null : flowAnswer(row, trigger), lacksFlow: lacksFlow(row, trigger) }));
  // A server it names is what its jobs ask for, so going without one is said even where every host does.
  const everything = new Map([...named.map((name) => [`m:${name}`, name]), ...known.flatMap(({ facts }) => [...facts])]);
  const flows = unique(known.map(({ flow }) => flow).filter((flow) => flow !== null));
  const imageOf = (row) => (row.image ? `${row.image}${row.piVersion ? ` with pi ${row.piVersion}` : ""}` : null);
  const images = unique(known.map(({ row }) => imageOf(row)));
  const definitions = new Map(named.map((name) => [name, unique(known.flatMap(({ row }) => (row.mcp ?? []).filter((server) => server.name === name && server.enabled === true).map(serverDefinition)))]));
  const agree = hostsAgree(known.map(({ row }) => agreeRow(row, trigger)));
  return rows.map((row) => {
    const mine = known.find((entry) => entry.row === row);
    if (!mine) return { name: row.name, tone: "unknown", icon: "minus", word: "unknown" };
    if (known.length === 1 && !mine.lacksFlow) return { name: row.name, tone: "plain", icon: "info", word: rows.length === 1 && liveList ? "the only host" : "the only one known" };
    const also = [...mine.facts.entries()].filter(([key]) => known.some(({ facts }) => !facts.has(key))).map(([, word]) => word);
    const without = [...everything.entries()].filter(([key]) => !mine.facts.has(key)).map(([, word]) => word.replace(", from its overlay", ""));
    const redefined = named.filter((name) => definitions.get(name).length > 1 && (row.mcp ?? []).some((server) => server.name === name && server.enabled === true));
    const image = trigger.image ? null : imageOf(row);
    const flowSays = flows.length > 1 || mine.lacksFlow;
    const differs = [
      also.length > 0 ? `also ${listed(also)}` : null,
      without.length > 0 ? `without ${listed(without)}` : null,
      ...redefined.map((name) => `${name} defined differently`),
      flowSays && mine.flow !== null ? `its flow ${mine.flow}` : null,
      images.length > 1 && image !== null ? `runs ${image}` : null,
    ].filter(Boolean);
    // Beside a host with no answer, one with an answer says what it is and claims nothing of the other.
    const flowSaid = trigger.flow === null ? null : mine.flow === null ? "no answer for its flow" : !flowSays && known.some(({ flow }) => flow === null) ? `its flow ${mine.flow}` : null;
    const unsaid = [flowSaid, !trigger.image && image === null ? "its image unknown" : null].filter(Boolean);
    if (differs.length > 0) return { name: row.name, tone: "attention", icon: "attention", word: [...differs, ...unsaid].join("; ") };
    if (unsaid.length > 0) return { name: row.name, tone: "plain", icon: "minus", word: unsaid.join("; ") };
    return agree === true ? { name: row.name, tone: "ok", icon: "done", word: "the same" } : { name: row.name, tone: "attention", icon: "attention", word: TRIGGER_GETS_WORDS.pillOrder };
  });
}

/** How old each host's answer is, and why the rest have none. A sentence per kind, so a fleet's worth of hosts stays one line. */
function hostsNote(rows, trigger, hostLoads, liveList) {
  if (hostLoads?.unreachable) return [TRIGGER_GETS_WORDS.hostsUnread];
  const by = (why) => rows.filter((row) => cannotSay(row, trigger) === why).map((row) => row.name);
  const known = rows.filter((row) => cannotSay(row, trigger) === null);
  const parts = known.length > 0 ? ["What each host’s last doctor run published: ", ...known.flatMap((row, at) => [...(at > 0 ? [", "] : []), `${row.name} at `, time(row.at)]), ". "] : [];
  const sentences = [
    liveList ? null : TRIGGER_GETS_WORDS.noLiveList,
    by("absent").length > 0 ? `${listed(by("absent"))} ${by("absent").length === 1 ? "has" : "have"} published none, so ${by("absent").length === 1 ? "it reads" : "they read"} unknown, never the same.` : null,
    by("unreachable").length > 0 ? `${listed(by("unreachable"))} could not be read, so ${by("unreachable").length === 1 ? "it reads" : "they read"} unknown.` : null,
    by("unreadable").length > 0 ? `${listed(by("unreadable"))}’s could not be read, or a newer release wrote it, so it reads unknown.` : null,
    by("old").length > 0 ? `${listed(by("old"))}’s is old, so it reads unknown.` : null,
    by("partial").length > 0 ? `${listed(by("partial"))} left out part of what it can load, so it reads unknown.` : null,
    (hostLoads?.more ?? 0) > 0 ? `${hostLoads.more} more ${hostLoads.more === 1 ? "host was" : "hosts were"} not read.` : null,
  ].filter(Boolean);
  return [...parts, ...(sentences.length > 0 ? [`${sentences.join(" ")} `] : []), TRIGGER_GETS_WORDS.repositoryPart];
}

// ---- the rows --------------------------------------------------------------------------------------------------------

/** The picker's catalog: the priced models of the providers this trigger and the deployment use. Anything else can still be typed, and the preview judges it. */
export const MODEL_CHOICES_MAX = 200;
const PROVIDER_CHOICES_MAX = 64;
const FLOW_CHOICES_MAX = 200;

/**
 * The deployment's job cap, as written, where it is an amount; else null. `readTriggerEditor` fills its fact tables' words in where no layer
 * sets one, a value the worker refuses at boot could be anything typed into the wrong field, and an editor that could not be read has no
 * value at all, so each is asked of the parser the worker uses. REJECTED: truthiness, which drew "the deployment's $no per-job dollar cap",
 * and "the deployment sets none" for the rest, which holds of one of those three. What a blank means for a job there is the preview's to
 * say, from what the worker would read.
 */
function deploymentCapOf(value) {
  try {
    return optionalUsdMicros(value, "maxCostUsd") === null ? null : value;
  } catch {
    return null;
  }
}

function modelRow({ trigger, defaults, modelChoices }) {
  const allowed = defaults?.models;
  const inUse = unique([trigger.provider, defaults?.provider, ...[...(trigger.models ?? []), ...(trigger.fallbackModels ?? [])].map((ref) => String(ref).split("/")[0])].filter(Boolean));
  const catalog = (Array.isArray(modelChoices) ? modelChoices : []).filter((ref) => typeof ref === "string" && ref.includes("/"));
  const refs = catalog.filter((ref) => inUse.includes(ref.split("/")[0])).slice(0, MODEL_CHOICES_MAX);
  const cap = trigger.maxCostUsd ?? null;
  const deploymentCap = deploymentCapOf(defaults?.maxCostUsd);
  return {
    provider: trigger.provider ?? "",
    model: trigger.model ?? "",
    cap: cap ?? "",
    deployment: { provider: defaults?.provider ?? null, model: defaults?.model ?? null },
    capHint: deploymentCap !== null ? `Blank uses the deployment’s $${deploymentCap}; a trigger can only lower it.` : "Blank means no cap of its own.",
    allowed: trigger.models ?? [],
    fallbacks: trigger.fallbackModels ?? [],
    allowedNone: Array.isArray(allowed) ? `The deployment’s list applies: ${allowed.join(", ")}.` : "Any model is allowed.",
    providers: unique(catalog.map((ref) => ref.split("/")[0])).slice(0, PROVIDER_CHOICES_MAX),
    models: unique(refs.map((ref) => ref.slice(ref.indexOf("/") + 1))),
    refs,
    read: [
      trigger.model ? `${trigger.provider ? `${trigger.provider} / ` : ""}${trigger.model}` : `the deployment’s model${defaults?.model ? `, ${defaults.provider ? `${defaults.provider} / ` : ""}${defaults.model}` : ""}`,
      trigger.models ? `allowed: ${trigger.models.join(", ")}` : Array.isArray(allowed) ? "the deployment’s allowed list" : "any model allowed",
      trigger.fallbackModels ? `fallbacks: ${trigger.fallbackModels.join(", ")}` : "no fallback",
      cap !== null ? `$${cap} cap` : deploymentCap !== null ? `the deployment’s $${deploymentCap} cap` : "no cap of its own",
    ].join(" · "),
  };
}

/**
 * The flow picker's suggestions: what the file says, what this console can list and each host's overlay skills. Not complete, and the how panel
 * says so (`flowPicker`). A skills folder is a folder on each host, and no reader of this page or publication lists it. REJECTED: reading the
 * trigger's `run.skillsDir` here, which would add a filesystem read of a path in the file to a page load, on the console's host, to offer names
 * the host that runs the job may not have.
 */
function flowRow({ trigger, rows, editor }) {
  const offered = [...(trigger.flow ? [{ name: trigger.flow, from: "as the file says" }] : []), ...(editor?.flows ?? []).map((entry) => ({ name: entry.name, from: entry.tier === "packages" ? "a staged package" : entry.tier === "overlay" ? "the overlay" : "the repository" })), ...rows.flatMap((row) => (row.skills ?? []).map((name) => ({ name, from: `${row.name}’s overlay` })))];
  const seen = new Set();
  const choices = offered.filter((entry) => !seen.has(entry.name) && seen.add(entry.name)).slice(0, FLOW_CHOICES_MAX);
  const groups = new Map();
  const silent = [];
  for (const row of rows) {
    if (trigger.flow === null || row.state !== "current") continue;
    const word = flowAnswer(row, trigger);
    if (word === null) silent.push(row.name);
    else groups.set(word, [...(groups.get(word) ?? []), row.name]);
  }
  const unknown = rows.filter((row) => row.state !== "current").map((row) => row.name);
  const lacking = rows.filter((row) => row.state === "current" && lacksFlow(row, trigger)).map((row) => row.name);
  const said = [
    ...[...groups].map(([word, names]) => `${listed(names)} ${names.length === 1 ? "finds" : "find"} ${trigger.flow} ${word}`),
    silent.length > 0 ? `${listed(silent)} ${silent.length === 1 ? "has" : "have"} no answer for it yet` : null,
    unknown.length > 0 ? `${listed(unknown)} ${unknown.length === 1 ? "has" : "have"} no answer to read` : null,
  ].filter(Boolean);
  return {
    command: trigger.command ?? null,
    flow: trigger.flow ?? "",
    choices,
    doctor: said.length > 0 ? `${said.join("; ")}.` : null,
    lacking: lacking.length > 0 ? `As doctor last read it, a job on ${listed(lacking)} would not find ${trigger.flow}: it is not at the repository’s HEAD, nor in any other tier this trigger loads from.` : null,
    forge: Boolean(trigger.forge),
    skillsDir: trigger.skillsDir ?? null,
  };
}

/** Whether this host's row lists this part whole, so a name not on it is one the host does not have. */
const listsWhole = (row, part) => row.state === "current" && !(row.unread ?? []).includes(part) && !((row.more?.[part] ?? 0) > 0);

/** Which hosts have this, as a person reads it: `staged on a and b, unknown on c`. A list cut short still proves what is on it. */
function whereWords(rows, part, holds, word) {
  const has = rows.filter((row) => row.state === "current" && holds(row)).map((row) => row.name);
  const lacks = rows.filter((row) => listsWhole(row, part) && !holds(row)).map((row) => row.name);
  const unknown = rows.filter((row) => !has.includes(row.name) && !lacks.includes(row.name)).map((row) => row.name);
  return [has.length > 0 ? `${word} on ${listed(has)}` : null, lacks.length > 0 ? `not on ${listed(lacks)}` : null, unknown.length > 0 ? `unknown on ${listed(unknown)}` : null].filter(Boolean).join(", ");
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What a run's record says one extension brought. Its own words: the card's sentence and the record's counts are never mixed up. */
function broughtWords(source) {
  if (!source) return null;
  const parts = [source.tools > 0 ? plural(source.tools, "tool") : null, source.skills > 0 ? plural(source.skills, "skill") : null, source.prompts > 0 ? plural(source.prompts, "prompt template") : null].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function extensionsRow({ trigger, rows, last }) {
  const known = rows.filter((row) => row.state === "current");
  const packages = [...new Map(known.flatMap((row) => row.packages ?? []).map((pkg) => [`${pkg.name} ${pkg.version}`, pkg])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const overlay = unique(known.flatMap((row) => (row.extensions ?? []).map((entry) => entry.name))).sort();
  const brought = (name, version = null) => {
    const row = (last?.sources ?? []).find((source) => source.name === name && (version === null || source.version === version));
    const words = broughtWords(row);
    return words === null ? null : `${words}, as ${last.id} loaded it`;
  };
  const items = [
    ...packages.map((pkg) => {
      const holds = (row) => (row.packages ?? []).some((entry) => entry.name === pkg.name && entry.version === pkg.version);
      return { name: `${pkg.name} ${pkg.version}`, sub: [whereWords(rows, "packages", holds, "staged"), ...(trigger.packages === false ? [] : [brought(pkg.name, pkg.version)])].filter(Boolean).join(" · ") };
    }),
    ...overlay.map((name) => {
      const holds = (row) => (row.extensions ?? []).some((entry) => entry.name === name);
      const off = known.filter((row) => holds(row) && row.overlayExtensionsAllowed !== true).map((row) => row.name);
      return { name, sub: [whereWords(rows, "extensions", holds, "in the overlay"), off.length > 0 ? `its overlay extensions off on ${listed(off)}` : null, brought(name)].filter(Boolean).join(" · ") };
    }),
  ];
  const morePackages = known.reduce((total, row) => total + (row.more?.packages ?? 0) + (row.more?.extensions ?? 0), 0);
  return { packagesOn: trigger.packages !== false, items, more: morePackages, none: items.length === 0, noneWord: known.length > 0 ? TRIGGER_GETS_WORDS.noExtensions : TRIGGER_GETS_WORDS.noExtensionsKnown };
}

/**
 * How the hosts define a server. Two definitions are a difference in what these jobs get only where this trigger names the server, and the pill
 * says so then. Where it does not, the jobs do not use it and their pills do not compare it, so the row says that, and what it would mean to
 * turn it on. REJECTED: "defined differently by host" there, a line that read as the contradiction of "the same" above it.
 */
function serverWords(rows, named) {
  const defined = rows.map((row) => row.server);
  const same = new Set(defined.map((server) => JSON.stringify([server.transport, server.where, server.exposure, server.keys]))).size === 1;
  if (!same) return named ? "defined differently by host" : "not on for these jobs; turning it on would differ by host";
  const [{ transport, where, exposure, keys }] = defined;
  return [transport, where, exposure, keys.length > 0 ? `uses ${listed(keys)} by name` : null].filter(Boolean).join(" · ");
}

function mcpRow({ trigger, rows, overlayServers }) {
  const forge = FORGE_MCP_KINDS.includes(trigger.forge);
  const named = trigger.mcp ?? [];
  const published = rows.flatMap((row) => (row.state === "current" ? (row.mcp ?? []) : []).map((server) => server.name));
  const local = (overlayServers ?? []).map((server) => server?.name).filter((name) => typeof name === "string");
  const names = unique([...named, ...published.sort(), ...local.sort(), ...(forge ? [FORGE_MCP_SERVER_NAME] : [])]);
  const items = names.map((name) => {
    if (name === FORGE_MCP_SERVER_NAME) return { name, on: named.includes(name), sub: TRIGGER_GETS_WORDS.forgeServer, tag: "", lacks: false };
    const defined = rows.filter((row) => row.state === "current" && !(row.unread ?? []).includes("mcp")).flatMap((row) => (row.mcp ?? []).filter((server) => server.name === name).map((server) => ({ host: row.name, server })));
    const on = defined.filter(({ server }) => server.enabled === true).map(({ host }) => host);
    const off = defined.filter(({ server }) => server.enabled !== true).map(({ host }) => host);
    const lacking = rows.filter((row) => listsWhole(row, "mcp") && !(row.mcp ?? []).some((server) => server.name === name)).map((row) => row.name);
    const unknown = rows.filter((row) => !on.includes(row.name) && !off.includes(row.name) && !lacking.includes(row.name)).map((row) => row.name);
    const tag = [on.length > 0 ? listed(on) : null, off.length > 0 ? `off on ${listed(off)}` : null, lacking.length > 0 ? `not on ${listed(lacking)}` : null, unknown.length > 0 ? `unknown on ${listed(unknown)}` : null].filter(Boolean).join("; ");
    return { name, on: named.includes(name), sub: defined.length > 0 ? serverWords(defined, named.includes(name)) : "no host says how it is defined", tag, lacks: off.length + lacking.length > 0 };
  });
  return { items, none: items.length === 0, noneWord: rows.some((row) => row.state === "current") ? TRIGGER_GETS_WORDS.noServers : TRIGGER_GETS_WORDS.noServersKnown };
}

function toolsRow({ trigger, last }) {
  const removed = trigger.excludeTools ?? [];
  const chip = (name, label = name) => ({ name, label, on: !removed.includes(name) });
  const own = [...EXCLUDABLE_TOOL_NAMES].map((name) => chip(name));
  const servers = trigger.mcp ?? [];
  const offered = new Set([...EXCLUDABLE_TOOL_NAMES]);
  const serverChips = servers.length === 0 ? [] : [...servers.map((name) => chip(mcpServerToolPattern(name), `all of ${name}’s tools`)), ...[...MCP_EXCLUDABLE_TOOL_NAMES].map((name) => chip(name))];
  for (const entry of serverChips) offered.add(entry.name);
  // An entry nothing above offers would vanish from the list on any edit of it, so it stays a chip. The loader refuses such a file, so this is a display's belt.
  const other = removed.filter((name) => !offered.has(name)).map((name) => chip(name));
  // No host publishes a tool's name: only a run knows them, so each is said as that run's. What came with the staged packages does not reach a
  // job of a trigger that withholds them now, whatever that run had. `report_progress` is the file's: `run.progress`, and no record's.
  const fromExtensions = (last?.tools ?? []).filter((group) => group.kind !== "package" || trigger.packages !== false).map((group) => ({ heading: `${group.from}${group.kind === "overlay" ? " in its overlay" : ""}, as ${last.id} loaded it${last.host ? ` on ${last.host}` : ""}`, names: group.names }));
  return { own, servers, serverChips, other, fromExtensions, jobTool: trigger.progress === true };
}

/** Each host's image and pi, as it beats them out, or what the file names instead. */
function imageRow({ trigger, rows }) {
  if (trigger.image) {
    const pis = unique(rows.map((row) => hostPiFor(row, trigger.image)).filter(Boolean));
    return { words: [code(trigger.image), `, as run.image names it${pis.length === 1 ? `, with pi ${pis[0]}` : ""}`] };
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.image ? `${row.image}${row.piVersion ? ` with pi ${row.piVersion}` : ""}` : "unknown";
    groups.set(key, [...(groups.get(key) ?? []), row.name]);
  }
  if (groups.size === 0) return { words: ["each host’s own PI_JOB_IMAGE; no host says which"] };
  return { words: [...groups].flatMap(([word, names], at) => [...(at > 0 ? ["; "] : []), ...(word === "unknown" ? [`unknown on ${listed(names)}`] : [code(word), ` on ${listed(names)}`])]) };
}

// ---- the card --------------------------------------------------------------------------------------------------------

/**
 * Everything the card says, for one trigger. `liveHosts`: the names of the live hosts able to run it, or null where no live host is
 * known, and then what the hosts last published says who they are. `records`: this trigger's runs, newest first; `historyUnread` says the
 * read failed, which is not a trigger with no runs.
 */
export function triggerGetsOf({ trigger, records = [], historyUnread = false, hostLoads = null, liveHosts = null, defaults = {}, editor = null, modelChoices = [], overlayServers = [] }) {
  const liveList = liveHosts !== null;
  const names = liveHosts ?? (Array.isArray(hostLoads?.hosts) ? hostLoads.hosts.map((row) => row?.name).filter((name) => typeof name === "string") : []);
  const rows = names.map((name) => hostLoadsRow(hostLoads, name));
  const last = triggerLastRun(records, hostLoads);
  const quoted = last.quoted;
  const noRun = historyUnread ? TRIGGER_GETS_WORDS.historyUnread : TRIGGER_GETS_WORDS.noRun;
  const under = (label) => {
    if (quoted === null) return [last.newest === null ? noRun : TRIGGER_GETS_WORDS.noRecord];
    const row = quoted.rows[label];
    return [`Last run${quoted.host ? ` on ${quoted.host}` : ""}, `, run(quoted.id), ": ", ...(Array.isArray(row?.value) ? row.value : [row?.value ?? "not kept"]), ...(row?.more ? ["; ", ...(Array.isArray(row.more) ? row.more : [row.more])] : []), "."];
  };
  const quote = quoted === null
    ? [TRIGGER_GETS_WORDS.fileSays, " ", last.newest === null ? noRun : "Its last run, ", ...(last.newest === null ? [] : [run(last.newest.id), `: ${last.newest.said}`])]
    : [TRIGGER_GETS_WORDS.fileSays, " Under each is what ", run(quoted.id), `, its ${last.newest.id === quoted.id ? "last run" : "newest run that says what it loaded"}, had${quoted.host ? ` on ${quoted.host}` : ""}.`, ...quoted.notes.map((note) => ` ${note}`), ...(last.newest.id === quoted.id ? [] : [" The last it started, ", run(last.newest.id), `: ${last.newest.said}`])];
  return {
    pills: hostPills(rows, trigger, liveList),
    hostsNote: rows.length === 0 ? (hostLoads?.unreachable ? [TRIGGER_GETS_WORDS.hostsUnread] : [TRIGGER_GETS_WORDS.noHost]) : hostsNote(rows, trigger, hostLoads, liveList),
    quote,
    problems: quoted?.problems ?? {},
    record: quoted?.record ?? null,
    last: { Model: under("Model"), Skills: under("Skills"), Extensions: under("Extensions"), MCP: under("MCP"), Tools: under("Tools"), pi: under("pi") },
    model: modelRow({ trigger, defaults, modelChoices }),
    flow: flowRow({ trigger, rows, editor }),
    extensions: extensionsRow({ trigger, rows, last: quoted }),
    mcp: mcpRow({ trigger, rows, overlayServers }),
    tools: toolsRow({ trigger, last: quoted }),
    image: imageRow({ trigger, rows }),
    secrets: { profile: trigger.secretsProfile ?? null, count: trigger.secrets ?? 0, optedOut: trigger.secretBundle === false },
  };
}
