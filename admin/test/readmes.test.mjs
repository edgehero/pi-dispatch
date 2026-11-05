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
  // The goal, then what it takes to start, then the path, so nobody is asked to install what nobody has explained, and the way
  // back in is found before it is needed.
  const order = ["dark engineering", "## Install in four steps", "## Open the web page", "## How to use it", "## Manage a swarm of agents", "## Is this for you?"].map((part) => top.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `every part is there: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
});

test("each stage of the path says what it is and how to get there, in one place", () => {
  const path = ROOT.slice(ROOT.indexOf("## How to use it"), ROOT.indexOf("## Manage a swarm of agents"));
  const stages = path.split(/^### /m).slice(1);
  assert.equal(stages.length, 3);
  for (const stage of stages) assert.match(stage, /\*\*To get here:\*\*/, stage.slice(0, 40));
});

test("the install prompt leaves a person's step to the person, and says what Claude Code is not", () => {
  const prompt = /\*\*With Claude Code\*\*[^`]*```text\n([^]*?)\n```/.exec(ROOT)?.[1]?.replace(/\s+/g, " ");
  assert.ok(prompt, "the prompt");
  // Without a terminal every question `up` asks answers no, so an agent could only get through with --yes, which accepts nearly
  // all of them at once. And it prints an operator's sign in link, which /dispatch console --link keeps out of a model's context.
  assert.match(prompt, /Do not run `pi-dispatch up` yourself/);
  assert.match(prompt, /do not ask me for any key or password/);
  assert.doesNotMatch(prompt, /--yes/);
  assert.match(read("worker/src/up.mjs"), /no interactive stdin/);
  assert.match(read("admin/src/console-command.mjs"), /nothing here reaches model context/);
  // The steps it sends an agent to are there, under the name it uses.
  assert.match(prompt, /"By hand"/);
  assert.match(ROOT, /\*\*By hand\*\*, install into a folder/);
  assert.ok(ROOT.replace(/\s+/g, " ").includes("Claude Code only does the installing: your jobs run on pi"));
});

test("the README says the web page is not on npm for exactly as long as that is true", () => {
  // 4.3.1 went out before the console existed (its tag does not hold `admin/src/console/cli.mjs`), and the README describes what
  // `main` holds. A release moves this version, which makes the note false: take it out in that pull request, and this test with it.
  const note = "The web page is not on npm yet";
  if (JSON.parse(read("admin/package.json")).version === "4.3.1") assert.ok(ROOT.includes(note), "say so");
  else assert.ok(!ROOT.includes(note), "the release that moved the version carries the web page");
});

test("the root README plays the film, and calls it a first look for exactly as long as that is true", () => {
  // The form GitHub itself writes for an uploaded video, and renders as a player: its bare address, alone on its line.
  const film = ROOT.match(/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/m);
  assert.ok(film, "the film's address, alone on its line");
  assert.ok(ROOT.indexOf("</p>") < film.index && film.index < ROOT.indexOf("# pi-dispatch\n"), "right under the banner, above the title");
  // The film announces a version npm does not have yet. A release moves this version: reword the caption in that pull request.
  const caption = "A first look at the next release";
  if (JSON.parse(read("admin/package.json")).version === "4.3.1") assert.ok(ROOT.includes(caption), "say so");
  else assert.ok(!ROOT.includes(caption), "the film is no longer a first look once its release is out");
});

test("Open the web page says what the console's commands do", () => {
  const section = ROOT.slice(ROOT.indexOf("## Open the web page"), ROOT.indexOf("## How to use it"));
  const consoleCli = read("admin/src/console/cli.mjs");
  const bootstrap = read("worker/src/console-bootstrap.mjs");
  assert.ok(section.includes("http://127.0.0.1:4790"));
  assert.match(consoleCli, /default 127\.0\.0\.1:4790/);
  // The name setup gives the first operator when nobody chooses one, so the command works as it is printed here.
  assert.ok(section.includes("pi-dispatch-console link --name operator"));
  assert.match(bootstrap, /"--yes"\) \? "operator" : .*\|\| "operator"/);
  assert.match(consoleCli, /link --name <name>/);
  assert.match(consoleCli, /token list/);
  // Setup keeps only the token's hash, which is why this section offers a token to keep at all.
  assert.ok(section.includes("Setup keeps no password you could paste"));
  assert.match(bootstrap, /delete made\.token/);
  assert.ok(section.includes("pi-dispatch-console token rotate --name operator"));
  assert.match(consoleCli, /token rotate --name <name>/);
  assert.ok(section.includes("/dispatch console --link"));
  assert.match(read("admin/src/console-command.mjs"), /\[--link \[token name\]\]/);
  assert.ok(section.includes("service start --console") && section.includes("service status --console"));
  assert.match(read("worker/src/cli.mjs"), /service <render\|install\|uninstall\|status\|start\|stop\|restart> \[--receiver\|--console\]/);
  assert.match(read("docs/console.md"), /One-time links do not work on a Windows host/);
});

test("Manage a swarm says what pi-dispatch does for many agents, and that it does not direct them", () => {
  const section = ROOT.slice(ROOT.indexOf("## Manage a swarm of agents"), ROOT.indexOf("## Is this for you?"));
  const words = section.replace(/\s+/g, " ");
  assert.ok(section.includes("console/console-overview.png"), "the page it talks about");
  for (const said of ["adds no agent of its own", "does not plan the work", "does not have agents talk to each other"]) assert.ok(words.includes(said), said);
  assert.match(read("docs/replicas.md"), /Neither replica knows what the other did/);
  for (const word of ["Swarm", "Dark engineering"]) assert.match(ROOT, new RegExp(`^\\| \\*\\*${word}\\*\\* \\| `, "m"), word);
  assert.doesNotMatch(ROOT.slice(0, ROOT.indexOf("## For engineers\n")), /orchestrat/i);
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
  const end = ROOT.indexOf("## Words used here\n");
  assert.ok(start > 0 && start < end, "the section comes before the glossary");
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
  for (const word of ["Skill", "Extension", "Package", "Overlay", "Host", "MCP server", "Tool", "Base commit", "Staged", "Job cap", "Fallback model", "Doctor", "Triggers file"]) assert.match(ROOT, new RegExp(`^\\| \\*\\*${word}\\*\\* \\| `, "m"), word);
});

test("What a job gets says what the trigger's page does: the card by its name, the buttons by theirs, what it refuses, and the preview shown", () => {
  const section = ROOT.slice(ROOT.indexOf("## What a job gets\n"), ROOT.indexOf("## Words used here\n"));
  const words = section.replaceAll("**", "").replace(/\s+/g, " ");
  for (const said of [TRIGGER_GETS_WORDS.title, "Preview the change", "Confirm", "Undo", "job cap", "is marked unknown", "can only lower"]) assert.ok(words.includes(said), said);
  // Each of these had no referent for someone new to this, and each has plain words now.
  for (const stumble of ["for free", "the one you set for everything", "Nothing is written", "as before", "would get the same", "has not reported", "in one bar", "on this machine", "says no here", "the model a job starts on", "even if you would confirm"]) assert.ok(!words.includes(stumble), stumble);
  assert.ok(section.includes("console/console-trigger-change.png"), "the section shows the preview it describes");
  // The card itself is shown where the READMEs list the console's pages, and the line there sends a reader here.
  const item = ROOT.slice(ROOT.indexOf("**A trigger:**"), ROOT.indexOf("**Your phone:**"));
  assert.ok(item.includes("console/console-trigger.png") && item.includes("(#what-a-job-gets)"));
  // A plain name for each row a person changes on the image. A row added to the card fails here until the section says it.
  const plain = { Model: "the model", "Job cap": "its job cap", "Flow and skills": "the flow", Extensions: "your packages", "MCP servers": "the outside systems", Tools: "the tools" };
  for (const [row, name] of Object.entries(plain)) assert.ok(words.includes(name), `${row} is said as ${name}`);
});

test("nothing promises what is not built: no switch per extension, however it is put, and no field still to come", () => {
  // The words a switch or a chip for one extension could be put in. "One switch for all the staged packages" is what is built, and matches none.
  const perExtension = /\b(?:switch|toggle|chip)(?:es)?\b[^.|]{0,40}\b(?:per|for each|for every|each|every|one)[\s-]+(?:staged\s+)?(?:package|extension|overlay)\b|\b(?:each|every|one|per)[\s-]+(?:staged\s+)?(?:package|extension)\b[^.|]{0,40}\b(?:switch|toggle|chip)(?:es)?\b/i;
  for (const said of ["with a switch per extension", "each extension has its own switch", "a per-extension toggle", "one chip per staged package"]) assert.match(said, perExtension, said);
  assert.doesNotMatch("One switch for all the staged packages. Each staged package and overlay extension is shown, with where it is, and is not switched.", perExtension);
  for (const path of ["README.md", "admin/README.md", "docs/console.md"]) {
    const text = read(path).replace(/\s+/g, " ");
    assert.doesNotMatch(text, perExtension, path);
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

test("both READMEs say what no tool can set as the six fields it cannot, and neither overreaches to what a job may spend or reach", () => {
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(read("admin/src/write-plans.mjs"))[1];
  const fields = [...proof.matchAll(/"run\.([^"]+)"/g)].map((m) => m[1]).sort();
  const section = ROOT.slice(ROOT.indexOf("## What a job gets\n"), ROOT.indexOf("## Words used here\n")).replace(/\s+/g, " ");
  // Whose: pi-dispatch's own commands, and not everything an AI can run. pi's own `bash` is outside this, as SECURITY.md says, so "No AI tool" overclaims.
  assert.match(read("SECURITY.md").replace(/\s+/g, " "), /A pi process’s own bash, write and edit tools are outside this policy/);
  const said = /The commands pi-dispatch gives an AI cannot set a trigger's (.*?): one that tries is refused before you are asked/.exec(section)?.[1];
  assert.ok(said, "the root README's sentence");
  assert.doesNotMatch(section, /No AI tool/);
  // What those commands can still do, as `docs/triggers.md` says: without it the list reads as ruling out a one-confirm change of the model.
  assert.match(section, /They can still move a trigger's flow, provider and model, and only after you confirm/);
  assert.match(read("docs/triggers.md").replace(/\s+/g, " "), /`dispatch_trigger_edit` can still set the first three/);
  const plain = { maxCostUsd: "job cap", models: "the list of models its jobs may use", fallbackModels: "fallback models", mcp: "outside systems", excludeTools: "which tools its jobs lose", packages: "load your packages" };
  assert.deepEqual(Object.keys(plain).sort(), fields, "one plain name per field");
  for (const [field, name] of Object.entries(plain)) assert.ok(said.includes(name), `${field} is said as ${name}`);
  const admin = read("admin/README.md").replace(/\s+/g, " ");
  const adminPlain = { maxCostUsd: "job cap", models: "allowed models", fallbackModels: "fallbacks", mcp: "MCP servers", excludeTools: "tool exclusions", packages: "staged packages" };
  assert.deepEqual(Object.keys(adminPlain).sort(), fields);
  const list = /no `dispatch_\*` tool can set a trigger's (job cap[^.]*?)\. A pi process's own `bash`, `write` and `edit` tools are outside this policy/.exec(admin)?.[1];
  assert.ok(list, "the admin README's sentence, and what it does not cover");
  for (const [field, name] of Object.entries(adminPlain)) assert.ok(list.includes(name), `${field} is said as ${name}`);
  assert.doesNotMatch(admin, /never by a tool/);
  assert.match(admin, /`dispatch_trigger_edit` can still move its flow, provider and model behind a confirm/);
  // `dispatch_set` and `dispatch_trigger_edit` each move a job's spend behind a confirm, so neither README may say no tool can.
  for (const [path, text] of [["README.md", ROOT], ["admin/README.md", read("admin/README.md")]]) assert.doesNotMatch(text.replace(/\s+/g, " "), /(?:change|what) (?:what )?a (?:trigger's )?jobs? may spend or reach/, path);
});
