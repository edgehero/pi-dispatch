/**
 * The run-record fixtures (issue #761, INT-RUN-HISTORY-FILE-CONTRACT): the record each released `buildRecord` makes from
 * the shared cases (`worker/test/fixtures/run-records/cases.mjs`), so today's readers are tested against every record
 * shape a release could have left on disk or in the run mirror. A record outlives the release that wrote it (retention
 * can keep it forever), and a reader that only ever met today's shape is how an upgrade would misread one.
 *
 * For each `v*` release tag, oldest first, `git archive` puts that tag's `worker/src` in a folder INSIDE this repository
 * (`EXTRACT_DIR`, gitignored and removed afterwards), so its relative imports resolve as they did in that release, and
 * its own `buildRecord` is called with every case. A release whose records equal the one before it for every case joins
 * that one's shape, so each shape is stored once, named after the first tag that wrote it. The working tree is the last
 * entry, `next`, with no tags, when its records differ from the newest release's. A tag whose builder cannot run is
 * listed under `skipped` with the reason, never left out silently. No network: tags come from the local clone.
 *
 * No release needs its input adapted today: every builder has taken one object, ignored the keys it does not name, and
 * read each input in the form the cases give it. A release that changes the form of an argument gets an adapter in
 * `recordsOf`, applied to the cases for the tags before it, rather than a second set of cases.
 *
 * Output, in `FIXTURE_DIR`: `<shape>.<case>.json` (the record, indented so a diff shows one line per field; readers
 * parse it either way) and `manifest.json`, `{ shapes: [{ id, tags }], skipped: [{ tag, reason }] }`.
 * `synthetic-v2.json` is hand-written (a record of a version no release has written yet) and never touched here.
 *
 * The fixtures are the SHAPES each release's builder makes from these inputs, not everything that release wrote: see
 * cases.mjs.
 *
 * Usage: node .github/scripts/run-record-fixtures.mjs --write       regenerates every shape from the tags
 *        node .github/scripts/run-record-fixtures.mjs --next-only   rewrites only `next`, from the working tree (no tags
 *                                                                   needed: what a change to `buildRecord` runs)
 *        node .github/scripts/run-record-fixtures.mjs --check       exits 1 and names each file that differs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where the fixtures live, relative to the repository. */
export const FIXTURE_DIR = "worker/test/fixtures/run-records";
/** Where each tag's `worker/src` is extracted while the generator runs (gitignored). */
export const EXTRACT_DIR = ".run-record-fixtures";
/** The working tree's entry. */
export const NEXT_ID = "next";
/** A generated fixture's name: `<shape id>.<case>.json`. */
export const FIXTURE_NAME_RE = /^(next|v\d+\.\d+\.\d+)\.([a-z][a-z-]*)\.json$/;

const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The release tags in version order, oldest first. A tag that is not `vX.Y.Z` (a family prefix, a pre-release) is not one. */
export function releaseTags(list) {
	const key = (tag) => tag.match(RELEASE_TAG_RE).slice(1).map(Number);
	return list
		.filter((tag) => RELEASE_TAG_RE.test(tag))
		.sort((a, b) => {
			const [x, y] = [key(a), key(b)];
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
		});
}

/** A record as its fixture file holds it. */
export const fixtureText = (record) => `${JSON.stringify(record, null, 2)}\n`;

/** Each case's record from one `buildRecord`, as fixture text, or a thrown error naming the case. */
async function recordsOf(buildRecord, cases) {
	const out = {};
	for (const name of cases.RUN_RECORD_CASES) {
		try {
			out[name] = fixtureText(buildRecord(cases.caseInput(name)));
		} catch (error) {
			throw new Error(`buildRecord threw on case ${name}: ${error?.message ?? error}`);
		}
	}
	return out;
}

const sameRecords = (a, b, cases) => a !== null && b !== null && cases.RUN_RECORD_CASES.every((name) => a[name] === b[name]);

/** One tag's records: its `worker/src` extracted under `dir`, its builder imported and called. */
async function tagRecords(tag, dir, cases) {
	const archive = execFileSync("git", ["archive", "--format=tar", `--prefix=${tag}/`, tag, "worker/src"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
	execFileSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive });
	const path = join(dir, tag, "worker/src/run-history.mjs");
	if (!existsSync(path)) throw new Error("no worker/src/run-history.mjs at this tag");
	const mod = await import(pathToFileURL(path).href);
	if (typeof mod.buildRecord !== "function") throw new Error("its run-history.mjs exports no buildRecord");
	return recordsOf(mod.buildRecord, cases);
}

/** The working tree's records. */
async function nextRecords(cases) {
	const mod = await import(pathToFileURL(join(ROOT, "worker/src/run-history.mjs")).href);
	return recordsOf(mod.buildRecord, cases);
}

/**
 * Every shape from the tags, then `next`: `{ manifest, files }`, `files` a map from file name to text. `tags` is the
 * release tags in order.
 */
export async function generate(tags, cases) {
	const shapes = [];
	const skipped = [];
	const files = new Map();
	const dir = join(ROOT, EXTRACT_DIR);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	let last = null;
	try {
		for (const tag of tags) {
			let records;
			try {
				records = await tagRecords(tag, dir, cases);
			} catch (error) {
				skipped.push({ tag, reason: String(error?.message ?? error).split("\n")[0] });
				continue;
			}
			if (sameRecords(last, records, cases)) {
				shapes.at(-1).tags.push(tag);
				continue;
			}
			shapes.push({ id: tag, tags: [tag] });
			for (const name of cases.RUN_RECORD_CASES) files.set(`${tag}.${name}.json`, records[name]);
			last = records;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const next = await nextRecords(cases);
	if (!sameRecords(last, next, cases)) {
		shapes.push({ id: NEXT_ID, tags: [] });
		for (const name of cases.RUN_RECORD_CASES) files.set(`${NEXT_ID}.${name}.json`, next[name]);
	}
	return { manifest: { shapes, skipped }, files };
}

/**
 * Only `next`, from the committed manifest and fixtures: the newest tagged shape is read from its files, and `next` is
 * written when the working tree's records differ from it, removed when they do not.
 */
export async function generateNext(manifest, readFixture, cases) {
	const shapes = manifest.shapes.filter((s) => s.id !== NEXT_ID);
	const files = new Map();
	for (const shape of shapes) for (const name of cases.RUN_RECORD_CASES) files.set(`${shape.id}.${name}.json`, readFixture(`${shape.id}.${name}.json`));
	const newest = shapes.at(-1);
	const last = newest ? Object.fromEntries(cases.RUN_RECORD_CASES.map((name) => [name, files.get(`${newest.id}.${name}.json`)])) : null;
	const next = await nextRecords(cases);
	if (!sameRecords(last, next, cases)) {
		shapes.push({ id: NEXT_ID, tags: [] });
		for (const name of cases.RUN_RECORD_CASES) files.set(`${NEXT_ID}.${name}.json`, next[name]);
	}
	return { manifest: { shapes, skipped: manifest.skipped ?? [] }, files };
}

/** The generated files on disk (by `FIXTURE_NAME_RE`), never the cases, the manifest or a hand-written fixture. */
function generatedOnDisk(dir) {
	return readdirSync(dir).filter((name) => FIXTURE_NAME_RE.test(name));
}

/** What differs between a generation and the folder: a list of file names, empty when none. */
export function differences(dir, { manifest, files }) {
	const out = [];
	const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
	if (read("manifest.json") !== `${JSON.stringify(manifest, null, 2)}\n`) out.push("manifest.json");
	for (const [name, text] of files) if (read(name) !== text) out.push(name);
	for (const name of generatedOnDisk(dir)) if (!files.has(name)) out.push(name);
	return out;
}

/** Write a generation: every generated file replaced, one the generation no longer has removed. */
export function write(dir, { manifest, files }) {
	for (const name of generatedOnDisk(dir)) if (!files.has(name)) rmSync(join(dir, name));
	for (const [name, text] of files) writeFileSync(join(dir, name), text);
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2];
	if (mode !== "--write" && mode !== "--next-only" && mode !== "--check") {
		console.error("usage: node .github/scripts/run-record-fixtures.mjs --write|--next-only|--check");
		process.exit(2);
	}
	const dir = join(ROOT, FIXTURE_DIR);
	const cases = await import(pathToFileURL(join(dir, "cases.mjs")).href);
	let generation;
	if (mode === "--next-only") {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		generation = await generateNext(manifest, (name) => readFileSync(join(dir, name), "utf8"), cases);
	} else {
		const tags = releaseTags(execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
		if (tags.length === 0) {
			console.error("::error::no v* release tag in this clone (a shallow clone has none): fetch the tags, or run --next-only");
			process.exit(1);
		}
		generation = await generate(tags, cases);
	}
	if (mode === "--check") {
		const changed = differences(dir, generation);
		for (const name of changed) console.error(`::error::${FIXTURE_DIR}/${name} differs from what run-record-fixtures.mjs generates. Run node .github/scripts/run-record-fixtures.mjs --write; never edit a generated fixture by hand.`);
		process.exit(changed.length > 0 ? 1 : 0);
	}
	write(dir, generation);
	const { shapes, skipped } = generation.manifest;
	console.log(JSON.stringify({ shapes: shapes.map((s) => `${s.id} (${s.tags.length} tag${s.tags.length === 1 ? "" : "s"})`), skipped }, null, 2));
}
