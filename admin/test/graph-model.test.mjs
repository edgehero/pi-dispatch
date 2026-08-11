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
