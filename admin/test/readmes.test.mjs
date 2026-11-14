import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONSOLE_PICKS } from "../../launch/console-picks.mjs";
import { relightTranscript, renderTranscript } from "../../launch/transcript-svg.mjs";
import { TRIGGER_RUN_FIELD_VERSIONS } from "../../worker/src/triggers.mjs";
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
  const targets = [...read("admin/README.md").matchAll(/(?:<img src|srcset)="([^"]+)"/g)];
  assert.ok(targets.length > 8);
  for (const [, target] of targets) assert.match(target, /^https:\/\/raw\.githubusercontent\.com\/.+\.png\?v=/, target);
});

test("every picture a README shows follows the reader's light or dark setting, and falls back to one that exists", () => {
  for (const path of READMES) {
    const text = read(path);
    const pictures = [...text.matchAll(/<picture>[\s\S]*?<\/picture>/g)].map((m) => m[0]);
    const outside = text.replace(/<picture>[\s\S]*?<\/picture>/g, "");
    assert.doesNotMatch(outside, /!\[[^\]]*\]\([^)]*images\//, `${path}: a plain image has one look in both themes`);
    assert.doesNotMatch(outside, /<img /, `${path}: an image outside a picture has one look in both themes`);
    for (const picture of pictures) {
      const fallback = /<img src="([^"?]+)/.exec(picture)?.[1];
      assert.ok(fallback, `${path}: a picture needs an img for whatever does not read its sources: ${picture.slice(0, 120)}`);
      assert.doesNotMatch(fallback, /-(?:dark|light|still)\./, `${path}: the fallback is the plain file, which a page without themes shows and a published README loads`);
      const themed = [...picture.matchAll(/media="(?:\(prefers-reduced-motion: reduce\) and )?\(prefers-color-scheme: ?(dark|light)\)" srcset="([^"?]+)/g)];
      assert.ok(themed.length > 0, `${path}: ${fallback} has no source for the other theme`);
      // GitHub's themed-picture, for a signed-in reader whose theme is not "sync with system", replaces the whole media of a
      // source that reads `prefers-color-scheme: dark`, with the space. A still's source written that way wins for that
      // reader and they lose the animation, so it is written without the space, which a browser reads the same and that
      // script leaves alone. Measured on the real page across theme, system setting and motion.
      assert.doesNotMatch(picture, /prefers-reduced-motion: reduce\) and \(prefers-color-scheme: /, `${path}: ${fallback}: a still GitHub's script would turn on for every reader of that theme`);
      for (const [, theme, target] of themed) {
        assert.notEqual(target, fallback, `${path}: ${target} is the same picture as the fallback`);
        assert.ok(target.includes(`-${theme}`), `${path}: ${target} is not the ${theme} picture its source says`);
      }
      // A picture that moves has a still for a reader who asked for less motion, in each theme.
      const reduced = [...picture.matchAll(/media="[^"]*prefers-reduced-motion: reduce[^"]*" srcset="([^"?]+)/g)].map((m) => m[1]);
      if (/images\/(?:banner|explain\/)/.test(fallback)) assert.ok(reduced.length > 0, `${path}: ${fallback} moves, so it has a still`);
      if (reduced.length > 0) {
        assert.equal(reduced.length, 2, `${path}: ${fallback} has a still in one theme only`);
        for (const target of reduced) assert.match(target, /-still\.png$/, target);
        assert.ok(picture.indexOf("prefers-reduced-motion") < picture.indexOf('media="(prefers-color-scheme'), `${path}: ${fallback}: the first source that matches wins, so the stills come first`);
      }
    }
  }
});

test("every console pick is drawn in the theme its name says, and each picture and its other theme are the same size", () => {
  const sizeOf = (file) => { const png = readFileSync(`${REPO}docs/images/${file}`); return [png.readUInt32BE(16), png.readUInt32BE(20)].join("x"); };
  for (const pick of CONSOLE_PICKS) {
    assert.equal(pick.theme ?? "light", pick.name.endsWith("-dark") ? "dark" : "light", pick.name);
    if (pick.name.endsWith("-dark")) assert.equal(sizeOf(`console/${pick.name}.png`), sizeOf(`console/${pick.name.replace(/-dark$/, "")}.png`), pick.name);
  }
  assert.equal(CONSOLE_PICKS.length % 2, 0);
  for (const name of ["dispatch-dashboard", "dispatch-hosts", "dispatch-allocation"]) assert.equal(sizeOf(`${name}-light.png`), sizeOf(`${name}.png`), name);
  assert.equal(sizeOf("banner-light.png"), sizeOf("banner.png"));
  assert.equal(sizeOf("banner-light-still.png"), sizeOf("banner-still.png"));
  const explained = readdirSync(`${REPO}docs/images/explain`).filter((f) => f.endsWith(".png") && !f.includes("-dark"));
  assert.ok(explained.length > 0);
  for (const file of explained) assert.equal(sizeOf(`explain/${file.replace(/(-still)?\.png$/, "-dark$1.png")}`), sizeOf(`explain/${file}`), file);
});

test("a captured terminal picture's light version is the dark one relit, colour for colour, with every line where it was", () => {
  for (const name of ["cli-doctor", "dispatch-dashboard", "dispatch-hosts", "dispatch-allocation"]) {
    const dark = read(`docs/images/${name}.svg`);
    assert.equal(read(`docs/images/${name}-light.svg`), relightTranscript(dark), `${name}: run node launch/transcript-svg.mjs --relight`);
    const words = (svg) => svg.replace(/\b(?:fill|stroke)="[^"]+"/g, "");
    assert.equal(words(relightTranscript(dark)), words(dark));
    assert.doesNotMatch(relightTranscript(dark), /#0d1117|#161b22/, `${name}: a dark window on a light page`);
  }
  assert.throws(() => relightTranscript('<rect fill="#123456"/>'), /no light partner for #123456/);
  const coloured = renderTranscript(`${[...Array(8).keys()].flatMap((i) => [`\u001b[${30 + i}mx\u001b[0m`, `\u001b[${90 + i}my\u001b[0m`]).join("\n")}\n`, { prompt: "$ x", title: "t" });
  assert.doesNotThrow(() => relightTranscript(coloured), "every colour a transcript can hold has a partner");
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

test("the root README plays the film", () => {
  // The form GitHub itself writes for an uploaded video, and renders as a player: its bare address, alone on its line.
  const film = ROOT.match(/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/m);
  assert.ok(film, "the film's address, alone on its line");
  assert.ok(ROOT.indexOf("</p>") < film.index && film.index < ROOT.indexOf("# pi-dispatch\n"), "right under the banner, above the title");
});

test("Open the web page says what the console's commands do", () => {
  const section = ROOT.slice(ROOT.indexOf("## Open the web page"), ROOT.indexOf("## How to use it"));
  const words = section.replace(/\s+/g, " ");
  const consoleCli = read("admin/src/console/cli.mjs");
  // Issue #882: the address a person opens is the console's own name, while the console still binds the number.
  assert.ok(section.includes("http://pi-dispatch.localhost:4790"));
  assert.match(consoleCli, /default 127\.0\.0\.1:4790/);
  assert.match(read("admin/src/console/listen.mjs"), /isLocalhostAddress\(spec\.host\) \? CONSOLE_HOSTNAME/);
  assert.match(read("worker/src/console-probe.mjs"), /export const CONSOLE_HOSTNAME = "pi-dispatch\.localhost";/);
  // Issue #882: a link or a code from the host, which every way in here is, remembers the browser at once; a token's form has the box, ticked.
  assert.ok(words.includes("Once you sign in, the browser remembers you"));
  assert.match(read("admin/src/console/server.mjs"), /const remembering = remember \|\| \(hostMade && rememberAllowed\(ctx, entry\.role, invited\)\);/);
  assert.ok(words.includes("leave **Remember this trusted device** ticked under it"));
  assert.match(read("admin/src/console/signin.mjs"), /REMEMBER_LABEL = "Remember this trusted device"/);
  assert.match(read("admin/src/console/signin.mjs"), /<input type="checkbox" name="remember" checked>/);
  // The code to type, as `link` prints it, with each one's life.
  assert.ok(words.includes("`./node_modules/.bin/pi-dispatch-console link` prints a link and a short code such as `K7QX-9M2D`. Open the link within 60 seconds, or type the code on the sign-in page within 5 minutes"));
  assert.match(read("admin/src/console/login-codes.mjs"), /export const LINK_TTL_MS = 60000;/);
  assert.match(read("admin/src/console/login-codes.mjs"), /export const SHORT_TTL_MS = 5 \* 60000;/);
  assert.match(read("admin/src/console/cli.mjs"), /const made = mintSignIn\(signInName\(\), port, \{ short: true \}\);/);
  // The folder's shortcut: bootstrap makes it, and it starts a stopped console before signing in.
  assert.ok(words.includes("`./pi-dispatch console` starts the page if it stopped, opens it and signs you in"));
  assert.match(read("worker/src/console-install.mjs"), /const shortcut = ensureConsoleShortcut\(dir, fs\);/);
  assert.match(read("worker/src/cli.mjs"), /pi-dispatch console \[--name NAME\]/);
  // /dispatch console signs in by default (neither flag), only where pi finds the folder's tokens file and the console runs.
  const command = read("admin/src/console-command.mjs");
  assert.ok(words.includes("In pi, started in that folder | `/dispatch console` opens the page and signs you in, while the page runs"));
  assert.match(command, /const auto = !args\.link && !args\.noLink;/);
  assert.match(command, /if \(answer\.state !== "running"\) return refuse\(/);
  assert.match(read("admin/src/index.ts"), /if \(DEPLOYMENT_SCAFFOLD_FILES\.every\(\(f\) => nodeFs\.existsSync\(join\(cwd, f\)\)\)\) return tokensFilePath\(env, cwd\);/);
  // Where a remembered browser is seen and removed, by the page's own title, and that signing out forgets it.
  assert.ok(words.includes("**Remembered browsers**, linked from Configuration"));
  assert.match(read("admin/src/console/pages.mjs"), /path: "\/config\/devices", [^}]*title: "Remembered browsers"/);
  assert.match(read("admin/src/console/panels/config.mjs"), /label: "Remembered browsers"/);
  assert.ok(words.includes("Signing out in a browser also forgets it"));
  assert.match(read("admin/src/console/server.mjs"), /const done = deps\.devices\.end\(hash, "signed-out"\);/);
  assert.ok(section.includes("service start --console") && section.includes("service status --console"));
  assert.match(read("worker/src/cli.mjs"), /service <render\|install\|uninstall\|status\|start\|stop\|restart> \[--receiver\|--console\]/);
  assert.match(read("docs/console.md"), /One-time links do not work on a Windows host/);
});

test("the README's one command and its lines by hand name the release in each package.json", () => {
  const version = (pkg) => JSON.parse(read(`${pkg}/package.json`)).version;
  const install = ROOT.slice(ROOT.indexOf("## Install in four steps"), ROOT.indexOf("## Open the web page"));
  const byHand = `@edgehero/pi-dispatch@${version("worker")} @edgehero/pi-dispatch-admin@${version("admin")} `;
  assert.ok(install.includes(`npx --yes --ignore-scripts @edgehero/pi-dispatch@${version("worker")} up --console`), "the one command, at the worker's release");
  assert.ok(install.includes(byHand), "the lines by hand, at the same release");
  assert.ok(read("docs/console.md").includes(byHand), "and docs/console.md's lines by hand");
  // A new empty folder: up --console refuses one that holds other files; Mac and Linux: the setup host refuses Windows.
  assert.match(install, /\*\*In one command\*\*, from a new empty folder, on a Mac or Linux/);
  assert.match(read("docs/console.md"), /one that holds other files and is not a deployment/);
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
  // Turning one thing off, and what that is not: a reader must not take it for a lock against the agent, or a tool's switch for its extension's.
  for (const said of ["one of your packages or extensions for that trigger's jobs alone", "those jobs no longer load it", "the tool is gone, and the rest of that extension still runs", "An agent that can run commands, write files or edit files can bring back what you turned off", "also turn off the tools that do those things: `bash` and `powershell` run commands, `write` writes files and `edit` edits them"]) assert.ok(words.includes(said), said);
  // A chip comes from the newest run that says what it loaded (`triggerLastRun`) or from the file, so no sentence says any run's will do.
  assert.ok(words.includes("A tool has a switch while the newest run that says what it loaded lists it, or while your triggers file names it"));
  for (const stumble of ["one tool they add", "by itself", "lock it away", "one that tries", "They can still", "which of an extension's tools"]) assert.ok(!words.includes(stumble), stumble);
  for (const stumble of ["a switch for each tool your extensions add", "keep one trigger's jobs out of", "reads a file's version", "a name nothing registered"]) assert.ok(!ROOT.includes(stumble), stumble);
  assert.ok(section.includes("(docs/exclude-tools.md#what-exclusion-does-not-stop)"), "the section sends a reader to what this does not stop");
  // No release number here: a rename moves one page, and `docs/upgrading.md` holds it. Nor the page's refusal, which reads running workers and no other machine.
  assert.ok(words.includes("Every running machine must run a release that can read these settings. The [upgrade notes](docs/upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out) say which release, and what to do until then."));
  const offSwitch = section.slice(section.indexOf("**You can turn off one thing and keep the rest.**"), section.indexOf("**You see it in words first"));
  assert.doesNotMatch(offSwitch, /\b\d+\.\d+\.\d+\b|next release|the page refuses|turn those tools off|reads less/);
  assert.ok(!words.includes("before you are asked"), "asked what");
  assert.ok(!words.includes("your extensions',"), "a possessive with nothing after it");
  assert.ok(words.includes("which tools its jobs lose (pi's own or those your extensions add)") && words.includes("A command that tries is refused, and you are never asked to confirm it."));
  assert.ok(section.includes("(docs/upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out)"));
  // The picture says each switch by the words a reader sees it under, and the golden it is drawn from holds that switch.
  const golden = read(`admin/test/fixtures/console/${CONSOLE_PICKS.find((pick) => pick.name === "console-trigger").golden}.html`);
  const alt = /<img src="docs\/images\/console\/console-trigger\.png[^"]*" alt="([^"]*)"/.exec(ROOT)?.[1];
  for (const [list, said] of [["excludeExtensions", "one for each of your extensions"], ["excludeExtensionTools", "a switch for each tool the newest run that says what it loaded lists"]]) {
    assert.ok(golden.includes(`data-gets-list="${list}"`), list);
    assert.ok(alt.includes(said), said);
  }
});

test("both READMEs say what an exclusion is not, and every heading of the exclusions doc they link is one", () => {
  // `worker/test/exclude-extensions.test.mjs` holds the docs' own sentences of this boundary, and `image/runner/test/role-child-exclusions.integration.test.mjs` what a real job does. `write` is here beside commands because pi's write tool takes any path, and the settings file is writable in the image.
  const engineers = ROOT.slice(ROOT.indexOf("## For engineers\n"));
  const admin = read("admin/README.md");
  for (const [path, text, link] of [["README.md", engineers, "docs/"], ["admin/README.md", admin, "../docs/"]]) {
    assert.ok(text.replace(/\s+/g, " ").includes("Neither stops what an agent that can run commands, write files or edit files can reach"), path);
    assert.ok(text.includes(`(${link}exclude-tools.md#what-exclusion-does-not-stop)`), path);
  }
  // Each of the two keys by what it does: only one of them keeps code from running.
  const engineerWords = engineers.replace(/\s+/g, " ");
  assert.ok(engineerWords.includes("`excludeExtensions` keeps an extension's code from loading in a job, though its files stay readable. `excludeExtensionTools` removes only the tool, so the rest of that extension still runs."));
  assert.ok(read("admin/README.md").replace(/\s+/g, " ").includes("An extension left out does not load, and a tool removed leaves the rest of its extension running."));
  for (const [text, path] of [[ROOT, "README.md"], [admin, "admin/README.md"]]) assert.doesNotMatch(text, /stops? what a job loads on its own|stops a job from loading/, path);
  // The version a file needs, as the loader's table has it. Which release reads it is `docs/upgrading.md`'s to say, so neither paragraph holds a release's number.
  for (const field of ["excludeExtensions", "excludeExtensionTools"]) assert.ok(engineerWords.includes(`A file that uses either needs \`"version": ${TRIGGER_RUN_FIELD_VERSIONS[field]}\`, so every worker, receiver and console must run a release that can read both.`), field);
  assert.ok(engineerWords.includes("A release that cannot ignores them and runs the job with what the file turned off. The [upgrade notes](docs/upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out) say which release, and what to do until then. While a running worker cannot read them, the page refuses the change and names it."));
  const engineerParagraph = engineers.slice(engineers.indexOf("`excludeExtensions` keeps an extension's code"), engineers.indexOf("A whole project can get one environment"));
  const adminParagraphs = admin.slice(admin.indexOf("**What its jobs get**"), admin.indexOf("`dispatch_trigger_edit` also takes"));
  assert.ok(adminParagraphs.replace(/\s+/g, " ").includes("Every running machine must run a release that can read these two settings: the [upgrade notes](../docs/upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out) say which release, and what to do until then. While a running worker cannot read them, the page refuses the change and names it."));
  for (const [path, paragraph] of [["README.md", engineerParagraph], ["admin/README.md", adminParagraphs]]) assert.doesNotMatch(paragraph, /\b\d+\.\d+\.\d+\b|reads less|job data version|comes after/, path);
  assert.equal(adminParagraphs.trim().split("\n\n").length, 4, "what it says, what a person changes, what that does not stop, and who reads it: one paragraph held all four");
  assert.ok(ROOT.includes("[excluded tools and extensions](docs/exclude-tools.md)"), "the docs index says what that file covers");
  const anchors = anchorsIn(read("docs/exclude-tools.md"));
  for (const text of [ROOT, admin]) for (const [, anchor] of text.matchAll(/exclude-tools\.md#([\w-]+)/g)) assert.ok(anchors.has(anchor), anchor);
  // A person brought here by the import's list learns the narrower switch beside the wider one.
  const reading = ROOT.slice(ROOT.indexOf("**Read the list it prints.**"), ROOT.indexOf("Your projects still win."));
  for (const said of ["all your packages, or one package or extension, out of one trigger's jobs", '"packages": false', '"excludeExtensions"']) assert.ok(reading.replace(/\s+/g, " ").includes(said), said);
});

test("the root README's optional fields name every field a trigger's page changes, and its sentence names exactly those, in order", () => {
  const start = ROOT.indexOf("`run` names a `flow` or a registered pi `command`");
  const sentenceAt = ROOT.indexOf("On a trigger's page in the console, a person changes ");
  assert.ok(start > 0 && sentenceAt > start, "the list, and the sentence after it");
  const list = ROOT.slice(start, sentenceAt);
  // `flow` is no option: a run names one or a command, in the line the list opens with. Every other member is a line of the list.
  for (const field of CARD_FIELDS) assert.ok(list.includes(`\`${field}\``), `the list names ${field}`);
  // Which tools go on which key, since the loader refuses a name on the wrong one, and that a name can stop a job, since only a run can know it.
  for (const said of ["`excludeTools`: removes named tools of pi's own or an MCP server's", "`excludeExtensions`: leaves named staged packages and overlay extensions out of its jobs", "`excludeExtensionTools`: removes named tools an extension adds. If no staged package or overlay extension brought a name, the job can stop before its agent starts"]) assert.ok(list.includes(said), said);
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
  const plain = { flow: "the flow", provider: "the provider", model: "and model", maxCostUsd: "the job cap", models: "the allowed models", fallbackModels: "and fallbacks", mcp: "the MCP servers", packages: "switch for staged packages", excludeTools: "the tools", excludeExtensions: "each extension the trigger leaves out", excludeExtensionTools: "each extension's tool it removes" };
  assert.deepEqual(Object.keys(plain), [...CARD_FIELDS], "one plain name per field");
  for (const [field, name] of Object.entries(plain)) assert.ok(sentence.includes(name), `${field} is said as ${name}`);
  assert.ok(admin.includes(TRIGGER_GETS_WORDS.title), "the card by its name");
  assert.ok(!admin.includes("which neither the console nor a model callable tool makes for you"), "the staged packages switch exists now");
});

test("both READMEs say what no tool can set as exactly the fields it cannot, and neither overreaches to what a job may spend or reach", () => {
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(read("admin/src/write-plans.mjs"))[1];
  const fields = [...proof.matchAll(/"run\.([^"]+)"/g)].map((m) => m[1]).filter((key) => CARD_FIELDS.includes(key)).sort();
  const section = ROOT.slice(ROOT.indexOf("## What a job gets\n"), ROOT.indexOf("## Words used here\n")).replace(/\s+/g, " ");
  // Whose: pi-dispatch's own commands, and not everything an AI can run. pi's own `bash` is outside this, as SECURITY.md says, so "No AI tool" overclaims.
  assert.match(read("SECURITY.md").replace(/\s+/g, " "), /A pi process’s own bash, write and edit tools are outside this policy/);
  const said = /The commands pi-dispatch gives an AI cannot set a trigger's (.*?)\. A command that tries is refused, and you are never asked to confirm it/.exec(section)?.[1];
  assert.ok(said, "the root README's sentence");
  assert.doesNotMatch(section, /No AI tool/);
  // What those commands can still do, as `docs/triggers.md` says: without it the list reads as ruling out a one-confirm change of the model.
  assert.match(section, /Those commands can still move a trigger's flow, provider and model, and only after you confirm/);
  assert.match(read("docs/triggers.md").replace(/\s+/g, " "), /`dispatch_trigger_edit` can still set the first three/);
  const plain = { maxCostUsd: "job cap", models: "the list of models its jobs may use", fallbackModels: "fallback models", mcp: "outside systems", excludeTools: "which tools its jobs lose (pi's own", packages: "load your packages", excludeExtensions: "which of your packages and extensions they leave out", excludeExtensionTools: "or those your extensions add)" };
  assert.deepEqual(Object.keys(plain).sort(), fields, "one plain name per field");
  for (const [field, name] of Object.entries(plain)) assert.ok(said.includes(name), `${field} is said as ${name}`);
  const admin = read("admin/README.md").replace(/\s+/g, " ");
  const adminPlain = { maxCostUsd: "job cap", models: "allowed models", fallbackModels: "fallbacks", mcp: "MCP servers", excludeTools: "tool exclusions", packages: "staged packages", excludeExtensions: "extension exclusions", excludeExtensionTools: "extension tool exclusions" };
  assert.deepEqual(Object.keys(adminPlain).sort(), fields);
  const list = /no `dispatch_\*` tool can set a trigger's (job cap[^.]*?)\. A pi process's own `bash`, `write` and `edit` tools are outside this policy/.exec(admin)?.[1];
  assert.ok(list, "the admin README's sentence, and what it does not cover");
  for (const [field, name] of Object.entries(adminPlain)) assert.ok(list.includes(name), `${field} is said as ${name}`);
  assert.doesNotMatch(admin, /never by a tool/);
  assert.match(admin, /`dispatch_trigger_edit` can still move its flow, provider and model behind a confirm/);
  // `dispatch_set` and `dispatch_trigger_edit` each move a job's spend behind a confirm, so neither README may say no tool can.
  for (const [path, text] of [["README.md", ROOT], ["admin/README.md", read("admin/README.md")]]) assert.doesNotMatch(text.replace(/\s+/g, " "), /(?:change|what) (?:what )?a (?:trigger's )?jobs? may spend or reach/, path);
});
