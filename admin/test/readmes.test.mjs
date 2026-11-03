import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONSOLE_PICKS } from "../../launch/console-picks.mjs";

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
  for (const word of ["Valkey", "BullMQ", "egress", "webhooks?", "rootless", "Quadlet", "CONST-", "REQ-", "DES-", "INT-", "cron", "OCI", "forges?"]) {
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
