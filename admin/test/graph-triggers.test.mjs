import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { readTriggers } from "../src/read-model.mjs";
import { readGraphTriggers } from "../src/graph-triggers.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const valid = { triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }] };

function file(document) {
  const dir = tempDir("graph-triggers-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, typeof document === "string" ? document : JSON.stringify(document));
  return triggersPath;
}

test("a valid real file keeps the display reader's shape and indices", () => {
  const triggersPath = file(valid);
  assert.deepEqual(readGraphTriggers({ triggersPath }), readTriggers({ triggersPath }));
  assert.equal(readGraphTriggers({ triggersPath }).triggers[0].index, 0);
});

test("a malformed trigger in valid JSON refuses the whole graph in the loader's words", () => {
  const document = { triggers: [...valid.triggers, { on: { type: "not-a-trigger" }, run: { flow: "fix" } }] };
  const text = JSON.stringify(document);
  const triggersPath = file(text);
  assert.equal(readTriggers({ triggersPath }).triggers.length, 1, "the old lenient reader silently keeps a partial set");
  let loader;
  try { parseTriggers(text, "triggers.json"); } catch (error) { loader = error.message; }
  assert.equal(typeof loader, "string");
  const result = readGraphTriggers({ triggersPath });
  assert.deepEqual(result, { invalid: loader });
  assert.equal(result.triggers, undefined, "no valid-looking partial graph survives");
  assert.ok(!result.invalid.includes(triggersPath), "a viewer gets the file's basename");
  assert.ok(readGraphTriggers({ triggersPath, fullPaths: true }).invalid.includes(triggersPath));
});

test("duplicate keys and invalid bundle declarations are refused, not normalized into a different graph", () => {
  for (const text of [
    '{"triggers":[],"triggers":[{"on":{"type":"comment","phrase":"@pi"},"run":{"kind":"github","flow":"fix"}}]}',
    JSON.stringify({ ...valid, secretBundles: [] }),
  ]) {
    const result = readGraphTriggers({ triggersPath: file(text) });
    assert.equal(typeof result.invalid, "string");
    assert.equal(result.triggers, undefined);
  }
});

test("validation and display read the same bytes once, even while the file changes", () => {
  let reads = 0;
  const first = JSON.stringify(valid);
  const result = readGraphTriggers({ triggersPath: "/private/deployment/triggers.json", fs: { readFileSync: () => ++reads === 1 ? first : '{"triggers":null}' } });
  assert.equal(reads, 1);
  assert.equal(result.triggers[0].flow, "fix");
});

test("missing files stay missing and malformed JSON never quotes its source context", () => {
  assert.deepEqual(readGraphTriggers({ triggersPath: join(tempDir("graph-missing-"), "absent.json") }), { missing: true });
  const triggersPath = file('{"private-ref-canary": ');
  const result = readGraphTriggers({ triggersPath });
  assert.deepEqual(result, { invalid: "triggers file is not valid JSON: triggers.json" });
  assert.ok(!result.invalid.includes("private-ref-canary"));
});


test("an unreadable graph file reports the read failure rather than a JSON error", () => {
  const fs = { readFileSync() { throw Object.assign(new Error("private read failure"), { code: "EACCES" }); } };
  assert.deepEqual(readGraphTriggers({ triggersPath: "/private/triggers.json", fs }), { invalid: "triggers file could not be read (EACCES)" });
});


test("loader explanations redact a quoted invalid local path unless full paths are effective", () => {
  const document = { triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", skillsDir: "/private/deployment/skills " } }] };
  const triggersPath = file(document);
  const viewer = readGraphTriggers({ triggersPath });
  assert.match(viewer.invalid, /skillsDir must not have leading or trailing whitespace/);
  assert.ok(!viewer.invalid.includes("/private/deployment"));
  assert.ok(viewer.invalid.includes('"skills "'));
  assert.ok(readGraphTriggers({ triggersPath, fullPaths: true }).invalid.includes("/private/deployment/skills"));
});
