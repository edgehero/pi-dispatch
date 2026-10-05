/**
 * The pi data this repository copies and can DERIVE, regenerated from the installed pin (issue #587).
 *
 * CLAUDE.md's rule is that a hand-written table restating a derivable source is either derived or pinned. Each table
 * below was pinned: a test compared it with the pinned pi and went red on a bump, and the fix was always the same
 * mechanical copy, by hand, in four places. So these four are now generated from pi itself, and
 * worker/test/pi-derived.test.mjs holds the checked-in copy to the generated one. The automated bump
 * (.github/workflows/pi-bump.yml) runs no pi code, so it does not run this: on its pull request that test goes red
 * naming each table, and a person runs `--write` on the branch and reads the hosts it reports.
 *   - COMPLETIONS_CATALOG_HOSTS, in image/runner/src/usage-meter.mjs and its copy in worker/src/output-cap.mjs: every
 *     host pi-ai's catalog serves openai-completions on. A host that joins WIDENS the cost guard's trust (a call there
 *     is bounded by the field pi picks), so `--write` reports the hosts added and removed for a person to judge.
 *   - the fixtures in image/runner/test/helpers/catalog-models.mjs, found by (provider, api, id). CATALOG_ROWS in that
 *     file is the human-owned input: add a row there and the generator writes its fixture.
 *   - EXCLUDABLE_TOOL_NAMES in worker/src/triggers.mjs: pi's own allToolNames, in pi's order.
 *
 * WHAT STAYS HUMAN-JUDGED, on purpose: the provider steering variables, the pricing pins and the admin's width table.
 * Their tests already name what changed, and each is a judgement (is a new variable a steering one; is a new price
 * right; does a width rule still hold) that a copy would only paper over.
 *
 * A generator that cannot find its target, or a catalog row that is gone, is an ERROR for that file: reported by name
 * and failing the check, never skipped, or the check would pass on a file it no longer reads. The other files are
 * still generated, so one renamed model does not hide what moved elsewhere.
 *
 * Usage: node .github/scripts/pi-derived.mjs --check   exits 1 and names each file that differs from its derivation
 *        node .github/scripts/pi-derived.mjs --write   rewrites them, and prints a JSON summary on stdout
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOSTS_FILES = Object.freeze(["image/runner/src/usage-meter.mjs", "worker/src/output-cap.mjs"]);
export const CATALOG_FILE = "image/runner/test/helpers/catalog-models.mjs";
export const TOOLS_FILE = "worker/src/triggers.mjs";
/** Every file a generator writes. */
export const DERIVED_FILES = Object.freeze([...HOSTS_FILES, CATALOG_FILE, TOOLS_FILE]);

const HOSTS_RE = /(export const COMPLETIONS_CATALOG_HOSTS = Object\.freeze\(\[\n)([^\]]*)(\]\);)/;
const TOOLS_RE = /^export const EXCLUDABLE_TOOL_NAMES = new Set\(\[[^\]\n]*\]\);$/m;
const CATALOG_ROWS_RE = /^export const CATALOG_ROWS = Object\.freeze\(\{\n((?:\t[A-Z0-9_]+: \[[^\]\n]*\],\n)+)\}\);$/m;
/** The fields callCostBound reads, in the order the fixtures keep them. */
const FIXTURE_FIELDS = Object.freeze(["id", "api", "provider", "baseUrl", "cost", "contextWindow", "maxTokens"]);

/**
 * Every host pi's catalog serves openai-completions on, sorted, and the rows whose baseUrl does not parse. An empty
 * baseUrl names no host (pi 1.0.3's azure rows): the server is the operator's own, which completionsOwnServer already
 * treats as untrusted, so it is not listed. A baseUrl that does not parse is not listed either (completionsOwnServer
 * treats it the same way), and it is reported, because a catalog that grew one is something a person should see.
 */
export function catalogHosts(catalog) {
	const hosts = new Set();
	const unparsable = [];
	for (const { file, key, row } of catalog) {
		if (row.api !== "openai-completions" || row.baseUrl === "") continue;
		try {
			hosts.add(new URL(row.baseUrl).hostname);
		} catch {
			unparsable.push(`${file} ${key}: baseUrl ${JSON.stringify(String(row.baseUrl).slice(0, 80))} does not parse; skipped, so it counts as the operator's own server`);
		}
	}
	return { hosts: [...hosts].sort(), unparsable };
}

/** The hosts a file's COMPLETIONS_CATALOG_HOSTS lists now. */
export function hostsIn(source, path = "the file") {
	const match = HOSTS_RE.exec(source);
	if (!match) throw new Error(`${path}: no COMPLETIONS_CATALOG_HOSTS = Object.freeze([...]) block to derive`);
	return [...match[2].matchAll(/^\t"([^"]+)",$/gm)].map((m) => m[1]);
}

export function withHosts(source, hosts, path = "the file") {
	hostsIn(source, path);
	return source.replace(HOSTS_RE, (_, head, _body, tail) => `${head}${hosts.map((host) => `\t${JSON.stringify(host)},\n`).join("")}${tail}`);
}

export function withToolNames(source, names, path = TOOLS_FILE) {
	if (!TOOLS_RE.test(source)) throw new Error(`${path}: no EXCLUDABLE_TOOL_NAMES = new Set([...]) line to derive`);
	return source.replace(TOOLS_RE, () => `export const EXCLUDABLE_TOOL_NAMES = new Set([${names.map((name) => JSON.stringify(name)).join(", ")}]);`);
}

/** CATALOG_ROWS as the file declares it: [[name, [provider, api, id]], ...], in the file's order. */
export function catalogRowsIn(source, path = CATALOG_FILE) {
	const match = CATALOG_ROWS_RE.exec(source);
	if (!match) throw new Error(`${path}: no CATALOG_ROWS = Object.freeze({...}) block to derive from`);
	return match[1].trimEnd().split("\n").map((line) => {
		const [, name, list] = /^\t([A-Z0-9_]+): (\[[^\]]*\]),$/.exec(line);
		return [name, JSON.parse(list)];
	});
}

const CATALOG_HEADER = `/**
 * Catalog rows the cost-bound tests price against (issue #501). GENERATED from the pinned pi-ai catalog
 * (\`dist/providers/data/*.json\`) by .github/scripts/pi-derived.mjs, and held to it by worker/test/pi-derived.test.mjs:
 * do not edit a fixture by hand. CATALOG_ROWS at the end is the input: add a row there and run the generator.
 * pinned-api.test.mjs also finds each row in the pinned copy by its (provider, api, id), whatever file holds it, so a
 * pin bump that reprices or renames one of these models fails there and in cost-guard.test.mjs rather than leaving the
 * tests asserting yesterday's prices. Keyed by identity rather than by file name since pi 1.0.3 renamed the Azure
 * provider from \`azure-openai-responses\` to \`azure\` and its file with it (issue #587). Only the fields callCostBound
 * reads are kept.
 */
`;

/** The whole catalog-models.mjs for these rows. Throws on a row the catalog lacks or holds twice. */
export function catalogModelsSource(catalog, rows) {
	const out = [CATALOG_HEADER];
	for (const [name, [provider, api, id]] of rows) {
		const found = catalog.filter(({ row }) => row.provider === provider && row.api === api && row.id === id);
		if (found.length !== 1) throw new Error(`${CATALOG_FILE}: ${name} (${provider} ${api} ${id}) is ${found.length === 0 ? "gone from" : "ambiguous in"} the pinned catalog; change CATALOG_ROWS`);
		const [{ file, key, row }] = found;
		const fixture = Object.fromEntries(FIXTURE_FIELDS.map((field) => [field, row[field]]));
		if (row.compat?.allowedFallbackModels) fixture.compat = { allowedFallbackModels: row.compat.allowedFallbackModels };
		out.push(`/** ${file} ${api} ${key} */\nexport const ${name} = Object.freeze(${JSON.stringify(fixture)});\n`);
	}
	out.push("/** Each fixture's row in the pinned catalog, as [provider, api, id]. CATALOG_ROWS is hand-written: the input. */\n");
	out.push(`export const CATALOG_ROWS = Object.freeze({\n${rows.map(([name, ref]) => `\t${name}: [${ref.map((part) => JSON.stringify(part)).join(", ")}],\n`).join("")}});\n`);
	return out.join("");
}

/**
 * Each derived file's generated text, from the files as they are (`read(path)`) and pi's facts, and an error per file
 * that could not be generated (a target that moved, a catalog row that is gone). One file's error never stops the
 * others: a pi release that renames one model must still regenerate the other three tables. Pure: the test hands in
 * a hand-edited file and checks it differs.
 */
export function derive({ read, facts }) {
	const { hosts, unparsable } = catalogHosts(facts.catalog);
	const files = new Map();
	const errors = unparsable.map((message) => ({ path: "pi's catalog", message }));
	const attempt = (path, make) => {
		try {
			files.set(path, make());
		} catch (error) {
			errors.push({ path, message: error.message });
		}
	};
	for (const path of HOSTS_FILES) attempt(path, () => withHosts(read(path), hosts, path));
	attempt(CATALOG_FILE, () => catalogModelsSource(facts.catalog, catalogRowsIn(read(CATALOG_FILE))));
	attempt(TOOLS_FILE, () => withToolNames(read(TOOLS_FILE), [...facts.allToolNames]));
	return { files, errors, hosts };
}

/** What a regeneration changes: the files that differ, the errors, and the catalog hosts added and removed. */
export function derivedChanges({ read, facts }) {
	const { files, errors, hosts } = derive({ read, facts });
	const changed = [...files].filter(([path, text]) => read(path) !== text).map(([path]) => path);
	let before = [];
	try {
		before = hostsIn(read(HOSTS_FILES[0]), HOSTS_FILES[0]);
	} catch {
		before = [];
	}
	return {
		generated: files,
		changed,
		errors,
		hosts: { added: hosts.filter((host) => !before.includes(host)), removed: before.filter((host) => !hosts.includes(host)) },
	};
}

/**
 * pi's facts, read from the pi a repository has installed: the catalog rows of the pi-ai pi-coding-agent itself loads
 * (found the way the runner's meter finds it, so never a stray copy), and pi's allToolNames. Imports the repository's
 * own modules by file URL, so a scratch checkout reads its own node_modules.
 */
export async function installedPiFacts(repo) {
	const { piOwnPackageDir } = await import(new URL("image/runner/src/usage-meter.mjs", repo).href);
	const piAi = piOwnPackageDir("pi-ai");
	const agent = piOwnPackageDir("pi-coding-agent");
	if (!piAi || !agent) throw new Error("pi is not installed: run npm ci at the repository root first");
	const dataDir = join(piAi, "dist", "providers", "data");
	const catalog = [];
	for (const file of readdirSync(dataDir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()) {
		for (const byKey of Object.values(JSON.parse(readFileSync(join(dataDir, file), "utf8")))) {
			for (const [key, row] of Object.entries(byKey)) catalog.push({ file, key, row });
		}
	}
	// The exports map is closed and does not expose allToolNames, so the file is reached by URL, as the worker's
	// exclude-tools.pinned.test.mjs does.
	const tools = await import(pathToFileURL(join(agent, "dist", "core", "tools", "index.js")).href);
	return { catalog, allToolNames: [...tools.allToolNames] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2];
	if (mode !== "--check" && mode !== "--write") {
		console.error("usage: node .github/scripts/pi-derived.mjs --check|--write");
		process.exit(2);
	}
	const repo = new URL("../../", import.meta.url);
	const read = (path) => readFileSync(new URL(path, repo), "utf8");
	const { generated, changed, errors, hosts } = derivedChanges({ read, facts: await installedPiFacts(repo) });
	for (const { path, message } of errors) console.error(`::error::${path}: ${message}`);
	if (mode === "--check") {
		for (const path of changed) console.error(`::error::${path} differs from what pi-derived.mjs generates from the installed pi. Run node .github/scripts/pi-derived.mjs --write; never edit a derived table by hand.`);
		if (changed.length > 0 || errors.length > 0) process.exit(1);
		console.log("OK: every derived pi table equals its generation");
	} else {
		for (const path of changed) writeFileSync(new URL(path, repo), generated.get(path));
		// The hosts added are the ones to read first: a new host widens the cost guard.
		console.log(JSON.stringify({ changed, hosts, errors }, null, 2));
		if (errors.length > 0) process.exit(1);
	}
}
