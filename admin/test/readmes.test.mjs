import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONSOLE_PICKS } from "../../launch/console-picks.mjs";
import { loadedRows, outcomeNote } from "../src/loaded-words.mjs";
import { CARD_FIELDS } from "../src/trigger-edit-core.mjs";
import { TRIGGER_GETS_WORDS } from "../src/trigger-gets-view.mjs";
import { LOADED_SAMPLES as S } from "./helpers/loaded-samples.mjs";
import { TOP_HALF_BANNED } from "./helpers/plain-words.mjs";

// The READMEs are the project's front door, and several things about them are hand-written restatements of something
// else, so each is held to it (AGENTS.md: a table that restates a derivable source is derived or pinned, never trusted).
// A person who does not write code reads the top half of the root README, so that half is held to plain words too.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(`${REPO}${path}`, "utf8");
const READMES = Object.freeze(["README.md", "admin/README.md", "worker/README.md", "receiver/README.md", "gateway/README.md"]);
const ROOT = read("README.md");
/** Text with its fenced code blocks taken out, since a command or a diagram may spell a dash. */
const prose = (text) => text.replace(/^```[\s\S]*?^```$/gm, "");
/** A heading's GitHub anchor. */
const anchorOf = (heading) => heading.toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
const anchorsIn = (text) => new Set([...prose(text).matchAll(/^#{1,6} (.+)$/gm)].map((m) => anchorOf(m[1])));
const walkMarkdown = (dir) => readdirSync(`${REPO}${dir}`).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);

test("no README uses a dash as punctuation, its alt text and the banner included", () => {
  for (const path of READMES) {
    const text = prose(read(path));
    assert.doesNotMatch(text, /[–—]/, `${path} has an em or en dash`);
    // A list marker is at the start of a line and renders as a bullet, so it is not one of these.
    for (const line of text.split("\n")) assert.doesNotMatch(line.replace(/^\s*- /, ""), / - /, `${path}: ${line.slice(0, 100)}`);
  }
  assert.doesNotMatch(read("docs/images/banner.svg"), /[–—]/, "the banner's text and aria-label");
});

test("every image a README or a doc shows exists, and carries a cache tag so GitHub's image cache lets go of the old one", () => {
  for (const path of [...READMES, ...walkMarkdown("docs")]) {
    const base = path.startsWith("docs/") ? `${REPO}docs/` : REPO;
    for (const [, target] of read(path).matchAll(/(?:!\[[^\]]*\]\(|srcset="|<img src=")([^")\s]+\.(?:png|svg|gif)[^")\s]*)/g)) {
      const raw = "https://raw.githubusercontent.com/edgehero/pi-dispatch/main/";
      const file = target.startsWith(raw) ? `${REPO}${target.slice(raw.length)}` : target.startsWith("http") ? null : `${base}${target}`;
      if (file === null) continue;
      assert.ok(existsSync(file.split("?")[0]), `${path}: ${target} exists`);
      assert.match(target, /\?v=[\w.-]+$/, `${path}: ${target} has a ?v=`);
    }
  }
});

test("an npm page shows PNGs on absolute URLs, since it cannot show an SVG from raw.githubusercontent.com", () => {
  for (const [, target] of read("admin/README.md").matchAll(/<img src="([^"]+)"/g)) {
    assert.match(target, /^https:\/\/raw\.githubusercontent\.com\/.+\.png\?v=/, target);
  }
});

test("the docs index in the root README links every file in docs/, and nothing that is not one", () => {
  const index = ROOT.slice(ROOT.indexOf("## Docs\n"), ROOT.indexOf("## How it compares"));
  const linked = new Set([...index.matchAll(/\]\(docs\/([\w-]+\.md)\)/g)].map((m) => m[1]));
  const files = readdirSync(`${REPO}docs`).filter((f) => f.endsWith(".md"));
  assert.deepEqual([...linked].sort(), [...files].sort());
});

test("the top half of the root README is for someone who does not write code", () => {
  const at = ROOT.indexOf("## For engineers\n");
  assert.ok(at > 0, "a heading marks where the engineers' half starts");
  // The glossary may define its own words, and an image's address is not text a person reads.
  const top = ROOT.slice(0, at).replace(/## Words used here[\s\S]*$/, "").replace(/\]\([^)]*\)/g, "]");
  for (const word of TOP_HALF_BANNED) {
    assert.doesNotMatch(top, new RegExp(`\\b${word}(?![a-z])`, "i"), `"${word}" belongs below "For engineers"`);
  }
  for (const stage of ["In the loop", "Near the loop", "Out of the loop"]) assert.match(top, new RegExp(`### \\d\\. ${stage}`), stage);
  assert.ok(top.indexOf("## Why") < top.indexOf("## How to use it"), "why comes before how");
});

test("every link to a heading of the root README lands on one", () => {
  const anchors = anchorsIn(ROOT);
  for (const path of [...READMES, ...walkMarkdown("docs")]) {
    const text = read(path);
    for (const [, anchor] of text.matchAll(/(?:\.\.\/README\.md|github\.com\/edgehero\/pi-dispatch)#([\w-]+)/g)) {
      if (anchor === "readme") continue;
      assert.ok(anchors.has(anchor), `${path} links #${anchor}, which README.md does not have`);
    }
  }
  for (const [, anchor] of ROOT.matchAll(/\]\(#([\w-]+)\)/g)) assert.ok(anchors.has(anchor), `README.md links #${anchor} to itself`);
});

test("worker/README.md's command table has every command of the CLI", () => {
  const cli = read("worker/src/cli.mjs");
  const commands = new Set([...cli.matchAll(/cmd === "([a-z-]+)"/g)].map((m) => m[1]));
  // Not an operator's: the host step `up --console` and the console's setup call into.
  commands.delete("setup-host");
  const table = read("worker/README.md").split("## Commands")[1].split("\n\n")[1];
  const rows = table.split("\n").slice(2).map((row) => row.split(" | ")[0]);
  for (const command of commands) assert.ok(rows.some((row) => new RegExp(`\`${command}\\b`).test(row)), `worker/README.md lists ${command}`);
});

test("every console image in the tree is a pick, and every pick is shown by a README or a doc, both ways", () => {
  const committed = readdirSync(`${REPO}docs/images/console`).filter((f) => f.endsWith(".png")).sort();
  const picks = CONSOLE_PICKS.map((pick) => `${pick.name}.png`).sort();
  assert.deepEqual(committed, picks, "docs/images/console holds exactly the picks: run render-images.mjs --console");
  const shown = [...READMES, ...walkMarkdown("docs")].map(read).join("\n");
  for (const file of picks) assert.ok(shown.includes(`console/${file}`), `${file} is shown somewhere`);
});

test("What a job gets says what the console says: the words a row reads, and every line of the Loaded card by a plain name", () => {
  const start = ROOT.indexOf("## What a job gets\n");
  const end = ROOT.indexOf("## How to use it\n");
  assert.ok(start > 0 && start < end, "the section comes before How to use it");
  const section = ROOT.slice(start, end);
  const words = section.replaceAll("**", "").replace(/\s+/g, " ");
  for (const record of [S.noFlow(), S.extensionFailed()]) assert.ok(words.includes(outcomeNote(record)), outcomeNote(record));
  // A plain name for each line a reader sees on the image below it. A line added to the card fails here until the list says it.
  const named = { pi: "pi", Model: "the model", Extensions: "its extensions", Skills: "its skills", MCP: "the outside systems", Tools: "its tools" };
  assert.deepEqual(loadedRows(S.everything()).map((row) => row.label), Object.keys(named));
  for (const [label, plain] of Object.entries(named)) assert.ok(words.includes(plain), `${label} is said as ${plain}`);
  assert.ok(section.includes("console/console-run-loaded.png"), "the section shows the card it describes");
});

test("the words the root README's new section leans on are in its glossary", () => {
  for (const word of ["Skill", "Extension", "Package", "Overlay", "Host", "MCP server", "Tool", "Base commit", "Staged", "Job cap", "Fallback model", "Doctor"]) assert.match(ROOT, new RegExp(`^\\| \\*\\*${word}\\*\\* \\| `, "m"), word);
});

test("What a job gets says what the trigger's page does: the card by its name, the buttons by theirs, what it refuses, and the preview shown", () => {
  const section = ROOT.slice(ROOT.indexOf("## What a job gets\n"), ROOT.indexOf("## How to use it\n"));
  const words = section.replaceAll("**", "").replace(/\s+/g, " ");
  for (const said of [TRIGGER_GETS_WORDS.title, "Preview the change", "Confirm", "Undo", "job cap", "reads unknown, never the same", "can only lower"]) assert.ok(words.includes(said), said);
  assert.ok(section.includes("console/console-trigger-change.png"), "the section shows the preview it describes");
  // The card itself is shown where the READMEs list the console's pages, and the line there sends a reader here.
  const item = ROOT.slice(ROOT.indexOf("**A trigger:**"), ROOT.indexOf("**Your phone:**"));
  assert.ok(item.includes("console/console-trigger.png") && item.includes("(#what-a-job-gets)"));
  // A plain name for each row a person changes on the image. A row added to the card fails here until the section says it.
  const plain = { Model: "the model", "Job cap": "its job cap", "Flow and skills": "the flow", Extensions: "your packages", "MCP servers": "the outside systems", Tools: "the tools" };
  for (const [row, name] of Object.entries(plain)) assert.ok(words.includes(name), `${row} is said as ${name}`);
});

test("the READMEs promise nothing that is not built: no switch per extension, and no field still to come", () => {
  for (const path of ["README.md", "admin/README.md"]) {
    const text = read(path);
    for (const later of ["excludeExtensions", "excludeExtensionTools", "exclude-tool-not-loaded"]) assert.ok(!text.includes(later), `${path} promises ${later}`);
  }
});

test("the root README's optional fields name every field a trigger's page changes, and its sentence names exactly those, in order", () => {
  const start = ROOT.indexOf("`run` names a `flow` or a registered pi `command`");
  const sentenceAt = ROOT.indexOf("On a trigger's page in the console, a person changes ");
  assert.ok(start > 0 && sentenceAt > start, "the list, and the sentence after it");
  const list = ROOT.slice(start, sentenceAt);
  // `flow` is no option: a run names one or a command, in the line the list opens with. Every other member is a line of the list.
  for (const field of CARD_FIELDS) assert.ok(list.includes(`\`${field}\``), `the list names ${field}`);
  const said = /a person changes ((?:`[A-Za-z]+`(?:, | and\s+)?)+) with one preview and one Confirm/.exec(ROOT.slice(sentenceAt));
  assert.ok(said, "the sentence");
  assert.deepEqual([...said[1].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]), [...CARD_FIELDS]);
  // Beside it, what the same change does on a fleet: the preview's own line says this, and `console-doc-tables.test.mjs` holds the docs' quote of it.
  assert.ok(ROOT.replace(/\s+/g, " ").includes("a host keeps what it has until its copy changes"));
});

test("the admin README's list of what a person changes on a trigger's page is CARD_FIELDS, each by a plain name, and it says the panel's line truly", () => {
  const admin = read("admin/README.md").replace(/\s+/g, " ");
  const sentence = /There a person changes (.*?), with one preview that says each change in words, one Confirm, and Undo\./.exec(admin)?.[1];
  assert.ok(sentence, "the sentence");
  const plain = { flow: "the flow", provider: "the provider", model: "and model", maxCostUsd: "the job cap", models: "the allowed models", fallbackModels: "and fallbacks", mcp: "the MCP servers", packages: "switch for staged packages", excludeTools: "the tools" };
  assert.deepEqual(Object.keys(plain), [...CARD_FIELDS], "one plain name per field");
  for (const [field, name] of Object.entries(plain)) assert.ok(sentence.includes(name), `${field} is said as ${name}`);
  assert.ok(admin.includes(TRIGGER_GETS_WORDS.title), "the card by its name");
  assert.ok(!admin.includes("which neither the console nor a model callable tool makes for you"), "the staged packages switch exists now");
});
