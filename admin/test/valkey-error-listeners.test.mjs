import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { resolvePaths } from "../src/read-model.mjs";
import { assembleInsightsView } from "../src/insights-assembly.mjs";

// Issue #846: during a Valkey outage every read of an /insights page printed ioredis' "Unhandled error event" with a
// stack trace (17 lines of that kind per read of /insights, 7 per read of each of the other three). A client with no
// `error` listener does that once per reconnect attempt, for as long as the outage outlasts the call, and the reads
// that built one per call had none (`readBudget`, `readHosts` and five more). The listener is a line beside each
// construction, so two tests hold it: a scan of every construction in `admin/src` (the fast hint, which sees a call
// shape), and the pages themselves against a port nothing answers (the oracle, which sees what ioredis prints).

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every `.mjs` and `.ts` file under `dir`. */
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:mjs|ts)$/.test(name) ? [path] : [];
  });
}

/** A construction of a Valkey client: `<name> = redisFn(` or `= ...makeRedisClient(`, the client held in `<name>`. */
const CONSTRUCTION = /\b(\w+)\s*=\s*(?:[\w.?]+\.)?(?:redisFn|makeRedisClient)\(/;
/** How far below its construction a client's listener may stand. */
const NEAR = 4;
/**
 * Lines that build a client and attach no listener beside it, each with its reason. Each must match exactly one line,
 * so a stale entry fails rather than excusing a new construction that happens to look like it.
 */
const EXEMPT = [
  // A factory the reads are handed, not a client: each read that calls it attaches its own listener.
  [/redisFn: \(u, o = \{\}\) => makeRedisClient\(u, \{ \.\.\.o, context \}\)/, "the fleet reader's factory, which builds no client itself"],
];

/** The constructions in `text` (named `file`) that have no `error` listener within `NEAR` lines, as `file:line`. */
export function unlistened(text, file) {
  const lines = text.split("\n");
  const missing = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*)/.test(line)) return;
    const m = CONSTRUCTION.exec(line);
    if (!m || EXEMPT.some(([re]) => re.test(line))) return;
    const name = m[1];
    const below = lines.slice(i, i + 1 + NEAR).join("\n");
    const listens = new RegExp(`\\b${name}\\??\\.on\\??\\.?\\(\\s*"error"|onValkeyError\\(\\s*${name}\\b`).test(below);
    if (!listens) missing.push(`${file}:${i + 1}`);
  });
  return missing;
}

test("every Valkey client the console and the extension build has an error listener beside it (#846)", () => {
  const files = sources(SRC);
  const missing = files.flatMap((f) => unlistened(readFileSync(f, "utf8"), f.slice(SRC.length)));
  assert.deepEqual(missing, [], "a client built here without an `error` listener prints a stack trace per reconnect attempt in an outage");
  // The scan sees the constructions it is meant to: the reads #846 named, among the rest.
  const all = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => CONSTRUCTION.test(l)));
  assert.ok(all.length >= 25, `the scan still finds the constructions (${all.length})`);
  // Each exemption matches exactly one line.
  for (const [re, why] of EXEMPT) assert.equal(files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => re.test(l))).length, 1, why);
  // Planted, so the scan is not vacuous: a construction with no listener, and one whose listener is too far below.
  assert.deepEqual(unlistened("  let redis;\n  redis = redisFn(url);\n  await redis.get(k);\n", "planted.mjs"), ["planted.mjs:2"]);
  assert.deepEqual(unlistened(`  const redis = redisFn(url);\n${"  x();\n".repeat(NEAR)}  redis.on?.("error", () => {});\n`, "far.mjs"), ["far.mjs:1"]);
  assert.deepEqual(unlistened('  owned = redisFn(u);\n  owned.on?.("error", () => {});\n', "ok.mjs"), []);
  assert.deepEqual(unlistened('  redis = m.makeRedisClient(u) ?? null;\n  redis?.on?.("error", () => {});\n', "optional.mjs"), []);
});

/** A loopback port nothing listens on: bound, then closed. */
async function deadPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const PRICING = { getPricedModel: () => null, isZeroRated: () => false, reprice: () => null, listPricedModels: () => [], piAiVersion: () => "1.2.3" };

test("the four /insights pages print no ioredis stack trace while nothing answers VALKEY_URL (#846)", async () => {
  const dir = tempDir("admin-insights-outage-");
  const env = {
    VALKEY_URL: `redis://127.0.0.1:${await deadPort()}`,
    PI_LOGS_DIR: join(dir, "logs"),
    PI_SETTINGS_FILE: join(dir, "settings.json"),
    PI_TRIGGERS_FILE: join(dir, "triggers.json"),
    PI_PROJECTS_FILE: join(dir, "projects.json"),
    PI_GRAPH_DIR: join(dir, "graph"),
  };
  writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [] }));
  writeFileSync(env.PI_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ id: "site", members: ["github:acme/web"] }] }));
  const paths = resolvePaths(env);
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(args.map(String).join(" "));
  try {
    for (const view of ["spend", "budget-split", "capacity", "flows"]) {
      await assembleInsightsView(paths, "7d", { view, role: "operator", nowMs: Date.now(), pricing: PRICING, envFn: () => env });
    }
    // Long enough for a client left reconnecting to try again: ioredis' first retry comes within 50 ms.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    console.error = original;
  }
  assert.deepEqual(printed.filter((line) => /Unhandled error event/.test(line)), [], "a down Valkey is each page's answer, never a stack trace on the console's output");
});
