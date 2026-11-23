import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignCheckIds, buildDoctorRecord, doctorKey } from "@edgehero/pi-dispatch/doctor-results";
import { RUNS_INDEX, runRecordKey } from "@edgehero/pi-dispatch/run-mirror";
import { loadPageData, PAGES, pagePanels, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { dataUnread } from "../../src/console/panels/common.mjs";
import { makeAnswererService } from "../../src/answerer-data.mjs";
import { readHostLoadsView } from "../../src/host-loads-view.mjs";
import { assembleHostCapacity } from "../../src/insights-assembly.mjs";
import { readProjectView } from "../../src/project-view.mjs";
import { createFleetReader, readCapacity, readSubscriptions, scanRunRecords } from "../../src/read-model.mjs";
import { makeSandboxService } from "../../src/sandbox-data.mjs";
import { triggerListOf } from "../../src/trigger-list.mjs";
import { keyedRedis, quietQueue, registryKeys } from "./fleet-reader-fakes.mjs";
import { tempDir } from "./temp-dir.mjs";

/**
 * A console on the REAL loader, fleet reader, answer rules, sandbox report, host loads, project view and trigger list,
 * wired as `cli.mjs` wires them, over a client and queues that answer, hold nothing or fail one command, and over real
 * files in a temp folder (issue #988). A state a test draws from here is the shape its reader gives it, and a
 * sentence is the one the page's own panels draw: nothing is put together by hand.
 */

export const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
export const iso = (ago) => new Date(NOW - ago).toISOString();

/**
 * A deployment folder that holds `records` as this host's run files. `files` puts one of its three configuration files
 * in a state of its own: "absent" (it does not exist), "invalid" (it is there and is not JSON) or "unreadable" (it is
 * there and nobody may read it).
 */
export function deployment(records = [], { logs = "folder", files = {} } = {}) {
  const dir = join(tempDir("pd-988-pill-"), "deployment");
  mkdirSync(logs === "folder" ? join(dir, "logs") : dir, { recursive: true });
  // `logs: "file"`: the run history's folder is not one, so this host's run files cannot be listed.
  if (logs === "file") writeFileSync(join(dir, "logs"), "not a folder");
  const paths = { valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), globalPiDir: join(dir, "pi"), schedulerStallMax: 2, triggersPath: join(dir, "triggers.json"), projectsFile: join(dir, "projects.json"), settingsFile: join(dir, "settings.json"), subscriptionsPath: join(dir, "subscriptions.json") };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] }));
  writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  writeFileSync(paths.settingsFile, JSON.stringify({ maxTurns: 30 }));
  if (logs === "folder") for (const record of records) writeFileSync(join(paths.logsDir, `${record.jobId}.json`), JSON.stringify(record));
  for (const [file, state] of Object.entries(files)) {
    const path = { triggers: paths.triggersPath, projects: paths.projectsFile, settings: paths.settingsFile }[file];
    if (state === "absent") rmSync(path);
    if (state === "invalid") writeFileSync(path, "{ not json");
    if (state === "unreadable") chmodSync(path, 0o000);
  }
  return { dir, paths, env: { PI_WORKER_NAME: "build3" } };
}

/**
 * A console's page dependencies as `cli.mjs` wires them for these four pages, on `redis` and `queue` and over a
 * deployment folder that holds `records`.
 */
export function consoleOn({ redis, queue = quietQueue(), records = [], logs = "folder", files = {}, gateway = async () => ({ enabledHosts: [], sessions: [] }) }) {
  const { dir, paths, env } = deployment(records, { logs, files });
  const fleet = createFleetReader(paths, { redisFn: () => redis, makeQueueFn: queue, parseConnectionFn: () => ({}), nowFn: () => NOW, readOnly: true, dollarEnvFn: () => env });
  const services = { paths, env, now: () => NOW, redisFn: () => redis };
  return {
    now: () => NOW, env, fleet, paths,
    answerer: makeAnswererService(services),
    sandboxes: makeSandboxService({ ...services, deploymentDir: dir, fleet }),
    hostLoads: () => readHostLoadsView(redis, { now: () => NOW }),
    // The console's own wiring of the browser terminals, with no gateway file: nothing is asked of Valkey for it.
    gatewayView: gateway,
    hostCapacity: (host) => assembleHostCapacity(paths, host, NOW, { envFn: () => env, readCapacityFn: (opts) => readCapacity({ ...opts, redisFn: () => redis }) }),
    subscriptions: () => readSubscriptions({ subscriptionsPath: paths.subscriptionsPath }),
    selfHost: () => "build3",
    setupGranted: () => false,
    watch: fleet.watch,
    projectView: (id, snapshot, { within } = {}) => readProjectView({ id, snapshot, paths, env, deploymentDir: dir, fleet, now: NOW, within }),
    // The list's history: this host's scan and what the snapshot holds of the fleet's mirror, with the coverage the
    // console states for it (a scan that failed is a side unread).
    triggerList: async (snapshot) => {
      const history = scanRunRecords({ logsDir: paths.logsDir, sinceMs: NOW - 30 * 86400_000, nowMs: NOW });
      const mirrored = snapshot?.recordDetails instanceof Map ? [...snapshot.recordDetails.values()] : Array.isArray(snapshot?.runs) ? snapshot.runs : null;
      return triggerListOf({ snapshot, records: Array.isArray(history) ? [...history, ...(mirrored ?? [])] : mirrored, now: NOW, scheduleZones: {}, coverage: { complete: false, partial: !Array.isArray(history) } });
    },
  };
}

export const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

/**
 * What a page can say "could not be read" of that is not a read the console makes for the page, or not one its stream
 * makes again: never the pill's, each with why.
 */
export const NOT_THE_PILLS = [
  [/The host's capacity history could not be read\./g, "read once when the page is drawn and never by the stream, as its card says"],
  [/Its list of running jobs could not be read/g, "what a host published about itself, which no read of the console's changes"],
  [/The runtime's CPU reserve could not be read\./g, "what a host published about itself"],
  [/The \d+ files? this run kept could not be read here\./g, "another host's files, which this host's store cannot read"],
  [/\(its data could not be read\)/g, "one job's data in an action's preview, which the preview read and says"],
];
/** Whether a page's words say a read could not be made: "could not be read", but for the sentences above. */
export const saysUnread = (words) => NOT_THE_PILLS.reduce((left, [sentence]) => left.replace(sentence, " "), words).includes("could not be read");
/** Whether a page says anywhere what it lacks, in any of the words the panels have for it. */
export const saysWhatIsMissing = (words) => /could not be read|was read in part|not read this time|could not be counted|cannot be told|not known/.test(words);
/** Whether a page the server drew carries the pill's mark; null where it draws no pill (a page that is not live). */
export const pillOf = (page) => {
  const tag = /<span id="live-status"[^>]*>/.exec(page);
  return tag === null ? null : / data-unread>$/.test(tag[0]);
};

/**
 * A page as a console draws it for `role`: its data; every place a panel says "could not be read", as `said` (the
 * panel and the words around it, a sentence or a cell of a table) and counted per panel as `times`; what the rule
 * says of that data (`pill`); the whole page's words (`words`); and whether the page the server draws carries the
 * pill's mark (`marked`, null on a page with no pill).
 */
export async function drawn(page, qs, deps, role) {
  const query = parsePageQuery(page, new URLSearchParams(qs)).query;
  const data = await loadPageData(page, query, deps, { role });
  const ctx = { query, session: { name: "ada", role }, data, readOnly: false };
  const said = [];
  const times = {};
  for (const panel of await pagePanels(page, ctx)) {
    const words = wordsOf(panel.html);
    const found = words.match(/[^.]{0,120}could not be read[^.]{0,80}/g) ?? [];
    if (found.length > 0) times[panel.id] = words.split("could not be read").length - 1;
    for (const place of found) said.push(`${panel.id}: ${place.trim()}`);
  }
  const whole = String((await renderPage(page, ctx)).html);
  return { data, said, times, pill: dataUnread(data), words: wordsOf(whole), marked: pillOf(whole) };
}

export const RUN = { v: 1, jobId: "gh-1", attempt: 1, kind: "github", target: "acme/web#12", project: "web", host: "build3", backend: "local", flow: "fix", outcome: "completed", reason: null, startedAt: iso(120_000), endedAt: iso(60_000) };
export const REFUSED = { ...RUN, jobId: "gh-2", outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
/** A run of another host, which this host's files do not hold: the fleet's mirror alone does. */
export const FAR = { ...RUN, jobId: "gh-9", host: "build7", target: "acme/web#13", startedAt: iso(300_000), endedAt: iso(240_000) };
export const HOST = registryKeys({ build3: { version: "5.4.2", image: "pi-job:latest", concurrency: "2", pid: "1", beatAt: String(Date.now() - 2_000), startedAt: String(NOW - 3_600_000), jobs: "[]", jobsMore: "0" } });

/** What `host`'s doctor published a minute ago: a record of `checks`, as the worker builds it and under its key. */
export function doctorKeys(host, checks) {
  return { [doctorKey(host)]: JSON.stringify(buildDoctorRecord({ checks, ids: assignCheckIds(checks), at: NOW - 60_000, version: "5.4.2", every: 24, by: { uid: 501, worker: true } })) };
}

/**
 * A Valkey that answers every command these pages send and holds `keys`: `keyedRedis`, with the server's clock, an
 * empty transcript stream, no open shell, and the run mirror's window script over an index that holds nothing.
 */
export const healthy = (keys = {}) => ({
  ...keyedRedis(keys),
  async time() { return [String(Math.floor(NOW / 1000)), "0"]; },
  async xlen() { return 0; },
  async xrange() { return []; },
  async xrevrange() { return []; },
  async zrangebyscore() { return []; },
  async eval() { return [0]; },
});
/**
 * That Valkey on a fleet whose run mirror is on and holds `records`: the index, read by score from the newest as the
 * mirror's readers ask, and each record's body.
 */
export function mirroring(records, keys = HOST) {
  const members = records.map((record) => [record.jobId, Date.parse(record.endedAt)]).sort((a, b) => b[1] - a[1]);
  const edge = (text) => (text === "+inf" ? [Infinity, true] : text === "-inf" ? [-Infinity, true] : String(text).startsWith("(") ? [Number(String(text).slice(1)), false] : [Number(text), true]);
  return {
    ...healthy({ ...keys, [RUNS_INDEX]: { zset: members }, ...Object.fromEntries(records.map((record) => [runRecordKey(record.jobId), JSON.stringify(record)])) }),
    async zrevrangebyscore(key, max, min, ...rest) {
      if (key !== RUNS_INDEX) return [];
      const [top, topIn] = edge(max);
      const [low, lowIn] = edge(min);
      const inside = members.filter(([, score]) => (topIn ? score <= top : score < top) && (lowIn ? score >= low : score > low));
      const at = rest.indexOf("LIMIT");
      const page = at < 0 ? inside : inside.slice(Number(rest[at + 1]), Number(rest[at + 1]) + Number(rest[at + 2]));
      return rest.includes("WITHSCORES") ? page.flatMap(([id, score]) => [id, String(score)]) : page.map(([id]) => id);
    },
  };
}
/**
 * The roles a page is drawn for: an operator's alone, or all three. An agent's session is loaded as the server loads
 * it, so its page is drawn from the agent's copy of the data (`agentReadProjection`), whose words are not the readers'.
 */
export const rolesOf = (page) => (PAGES[page].auth === "operator" ? ["operator"] : ["operator", "viewer", "agent"]);
/** That Valkey with `commands` taken and never answered inside their bound, as a client ends one. */
export const failing = (client, commands) => new Proxy(client, { get: (target, key) => (commands.includes(key) ? () => Promise.reject(new Error("Command timed out")) : target[key]) });
/** A pipeline whose commands are taken and whose `exec` is never answered inside its bound. */
export const unanswered = new Proxy({}, { get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : key === "exec" ? () => Promise.reject(new Error("Command timed out")) : () => unanswered) });
/** A queue that answers, but for `calls`. */
export const failingQueue = (calls) => (connection, opts) => ({ ...quietQueue()(connection, opts), ...Object.fromEntries(calls.map((call) => [call, () => Promise.reject(new Error("Command timed out"))])) });
