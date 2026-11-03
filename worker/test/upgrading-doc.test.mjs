import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// `docs/upgrading.md` (issue #761) is the one place an operator reads before an upgrade: the order, what each release
// changed in stored state, and how to roll back. Three things about it restate something derivable, so they are
// BOLTED here (AGENTS.md: a hand-written table is derived or pinned, never trusted):
//
//   - every release note links it. Each notes step of `.github/workflows/release.yml` and `repo-release.yml` appends
//     an `**Upgrading**` line pointing at the guide at that release's own tag, after both the AI path and the commit
//     list fallback and outside `if [ -n "$PREV" ]`, so a first release carries it too. The steps are found from the
//     files, not listed here, so a package added to the release workflow without the line turns this red. The line
//     shows in release notes from the first release cut after it landed: the notes already published do not change.
//   - every guide that keeps its own upgrade notes links it, and it links every one of them back. A guide is found by
//     an upgrade heading or a bold upgrade lead (`## Upgrading...`, `**Upgrade order.**`), plus a pinned list of the
//     guides whose note says to upgrade parts "together" without such a heading.
//   - every relative link in it resolves, anchors included, and so does every link into it from the docs and the
//     README.
//
// WHAT NO TEST HERE CAN CHECK: the release numbers on the page. They come from `git tag --contains <commit>` in a clone
// that has the tags, and CI checks out without them, so a wrong number stays wrong until someone reads it. The page
// says so for the maintainer who adds a row. What is checked is their shape and order.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = join(ROOT, "docs");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** The heading anchors of a markdown text, the way GitHub makes them: lower case, punctuation dropped, each space a dash, a repeat suffixed. */
function anchorsOf(text) {
	const seen = new Map();
	const out = new Set();
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const base = m[2].trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		out.add(n === 0 ? base : `${base}-${n}`);
	}
	return out;
}

/** Every `[text](target)` outside fenced code, as `{ target, line }`. */
function linksOf(text) {
	const out = [];
	let fence = false;
	text.split("\n").forEach((line, i) => {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) return;
		for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) out.push({ target: m[1], line: i + 1 });
	});
	return out;
}

/** Resolve one relative link from `fromFile` (repo-relative). Returns a problem, or null when it resolves. */
function linkProblem(fromFile, target) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // https:, mailto: and the like: not a file
	const [path, anchor] = target.split("#");
	const file = path === "" ? join(ROOT, fromFile) : resolve(dirname(join(ROOT, fromFile)), path.split("?")[0]);
	if (!existsSync(file)) return `${target}: no such file`;
	if (anchor === undefined || !file.endsWith(".md")) return null;
	return anchorsOf(readFileSync(file, "utf8")).has(anchor) ? null : `${target}: no heading makes #${anchor}`;
}

/** The `run:` block of each step in a workflow, keyed by the step's name. Steps are `      - name:` at one indent. */
function stepsOf(workflow) {
	const steps = [];
	let current = null;
	for (const line of workflow.split("\n")) {
		const m = /^ {6}- name: "?(.*?)"?\s*$/.exec(line);
		if (m) {
			current = { name: m[1], lines: [] };
			steps.push(current);
			continue;
		}
		if (current) current.lines.push(line);
	}
	return steps.map((s) => ({ name: s.name, body: s.lines.join("\n") }));
}

/** Each notes step of a release workflow, with the facts its Upgrading line is checked against. */
function notesSteps(file) {
	const workflow = read(file);
	const steps = stepsOf(workflow);
	const notes = steps.filter((s) => s.body.includes("node .github/scripts/release-notes.mjs"));
	return notes.map((s) => {
		const prefix = /git tag --list '([a-z-]*)v\*'/.exec(s.body)?.[1];
		const notesFile = /release-notes\.mjs > (\/tmp\/[\w.-]+\.md) 2>/.exec(s.body)?.[1];
		const version = /\.\.\.[a-z-]*v%s\\n' \\\n\s+"\$\{\{ github\.server_url \}\}" "\$\{\{ github\.repository \}\}" "\$PREV" "(\$\{\{ steps\.[\w-]+\.outputs\.version \}\})"/.exec(s.body)?.[1];
		return { file, name: s.name, body: s.body, prefix, notesFile, version, workflow };
	});
}

const WORKFLOWS = [".github/workflows/release.yml", ".github/workflows/repo-release.yml"];

test("every release note links the upgrade guide at its own tag, on both paths and on a first release", () => {
	const all = WORKFLOWS.flatMap(notesSteps);
	// Not vacuous: release.yml cuts a release per package and repo-release.yml the whole tool's.
	assert.ok(all.length >= 5, `found ${all.length} release notes steps, expected one per package and one for the tool`);
	for (const step of all) {
		const where = `${step.file}, step "${step.name}"`;
		assert.ok(step.prefix !== undefined && step.notesFile && step.version, `${where}: its tag prefix, notes file and version are found`);
		// Both paths write the one notes file the Upgrading line appends to.
		assert.ok(step.body.includes(`} > ${step.notesFile}`), `${where}: the commit list fallback writes ${step.notesFile}`);
		const want = `printf '\\n**Upgrading**: %s/%s/blob/${step.prefix}v%s/docs/upgrading.md\\n' \\\n            "\${{ github.server_url }}" "\${{ github.repository }}" "${step.version}" >> ${step.notesFile}`;
		const at = step.body.indexOf(want);
		assert.ok(at >= 0, `${where} must append, exactly:\n${want}`);
		assert.equal(step.body.indexOf(want, at + 1), -1, `${where}: one Upgrading line`);
		// After the AI or fallback branch and after the PREV block has closed, so it is on every path.
		const prevOpen = step.body.indexOf('if [ -n "$PREV" ]; then');
		assert.ok(prevOpen >= 0, `${where}: the compare link's PREV test is found`);
		const prevClose = step.body.indexOf("\n          fi\n", prevOpen);
		assert.ok(prevClose >= 0 && at > prevClose, `${where}: the Upgrading line sits after the PREV block, not inside it`);
		const fallbackClose = step.body.lastIndexOf("\n          fi\n", prevOpen);
		assert.ok(fallbackClose >= 0 && fallbackClose < at, `${where}: the Upgrading line sits after the AI and fallback branch`);
		// The release it describes is cut under the same tag and from the same file.
		const create = `gh release create "${step.prefix}v${step.version}"`;
		assert.ok(step.workflow.includes(create), `${step.file} creates the release ${create}`);
		const createAt = step.workflow.indexOf(create);
		assert.ok(step.workflow.slice(createAt, createAt + 400).includes(`--notes-file ${step.notesFile}`), `${step.file}: ${create} publishes ${step.notesFile}`);
	}
	// One release per notes step: a package whose release has no notes step would carry no link.
	for (const file of WORKFLOWS) {
		const creates = (read(file).match(/gh release create "/g) ?? []).length;
		assert.equal(creates, all.filter((s) => s.file === file).length, `${file}: every gh release create has a notes step with the Upgrading line`);
	}
});

// A guide whose upgrade note says to move some parts "together" without an upgrade heading of its own. The heading
// rule below finds the rest; these are pinned because their note is a sentence inside a section about something else.
const PINNED_GUIDES = ["secrets.md", "mcp.md", "sessions.md", "wait-for.md", "multi-host.md", "durable-runs.md", "canary.md", "zero-touch.md", "console.md"];

/** The guides that keep an upgrade note: an upgrade heading or bold lead, or the pinned list. */
function guidesWithUpgradeNotes() {
	const found = new Set(PINNED_GUIDES);
	for (const name of readdirSync(DOCS)) {
		if (!name.endsWith(".md") || name === "upgrading.md") continue;
		const text = readFileSync(join(DOCS, name), "utf8");
		if (/^#{1,6} .*upgrad/im.test(text) || /^\s*(?:[-*] |\d+\. )?\*\*upgrad/im.test(text)) found.add(name);
	}
	return [...found].sort();
}

test("every guide with upgrade notes links the upgrade guide, and the upgrade guide links it back", () => {
	const guides = guidesWithUpgradeNotes();
	// Not vacuous: the heading rule alone finds these, so a rule that matched nothing would fail here.
	for (const name of ["backup.md", "costs.md", "egress.md", "global-pi-overlay.md", "job-image.md", "pause-windows.md", "podman.md", "replicas.md", "scoped-limits.md", "sizing.md", "triggers.md"]) {
		assert.ok(guides.includes(name), `the upgrade heading rule finds docs/${name}`);
	}
	const upgrading = read("docs/upgrading.md");
	const notes = upgrading.slice(upgrading.indexOf("\n## Notes kept in each guide"), upgrading.indexOf("\n## For maintainers"));
	assert.ok(notes.length > 100, "docs/upgrading.md has its Notes kept in each guide section");
	for (const name of guides) {
		const text = readFileSync(join(DOCS, name), "utf8");
		assert.ok(/\]\(upgrading\.md(?:#[^)]*)?\)/.test(text), `docs/${name} keeps upgrade notes, so it links upgrading.md`);
		assert.ok(notes.includes(`](${name}`), `docs/upgrading.md's notes section links docs/${name}`);
	}
	for (const name of PINNED_GUIDES) assert.ok(existsSync(join(DOCS, name)), `pinned guide docs/${name} exists`);
});

test("every relative link in the upgrade guide resolves, and so does every link into it", () => {
	const text = read("docs/upgrading.md");
	const links = linksOf(text);
	assert.ok(links.length > 40, "the upgrade guide links the guides it summarises");
	const problems = links.map((l) => [l.line, linkProblem("docs/upgrading.md", l.target)]).filter(([, p]) => p).map(([line, p]) => `docs/upgrading.md:${line}: ${p}`);
	const into = [];
	for (const name of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
		const rel = `docs/${name}`;
		for (const l of linksOf(read(rel))) if (/(^|\/)upgrading\.md(#|$)/.test(l.target)) into.push([rel, l]);
	}
	for (const l of linksOf(read("README.md"))) if (/(^|\/)upgrading\.md(#|$)/.test(l.target)) into.push(["README.md", l]);
	assert.ok(into.some(([from]) => from === "README.md"), "the README links the upgrade guide");
	for (const [from, l] of into) {
		const p = linkProblem(from, l.target);
		if (p) problems.push(`${from}:${l.line}: ${p}`);
	}
	assert.deepEqual(problems, [], `links that do not resolve:\n${problems.join("\n")}`);
});

test("the release rows are version numbers, newest first (their values come from git tags, which CI does not have)", () => {
	const text = read("docs/upgrading.md");
	const section = text.slice(text.indexOf("\n## What each release changed in stored state"), text.indexOf("\n## Rolling back"));
	const releases = [...section.matchAll(/^### (\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
	const rows = [...section.matchAll(/^\| (\d+\.\d+\.\d+) \|/gm)].map((m) => m[1]);
	assert.ok(releases.length >= 1 && rows.length >= 5, "the section has a heading per new release and a table of earlier ones");
	const order = [...releases, ...rows].map((v) => v.split(".").map(Number));
	const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	for (let i = 1; i < order.length; i++) assert.ok(cmp(order[i - 1], order[i]) >= 0, `release ${order[i].join(".")} is listed after a newer one`);
});
