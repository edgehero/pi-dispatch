import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogHosts, catalogModelsSource, catalogRowsIn, CATALOG_FILE, derive, derivedChanges, DERIVED_FILES, HOSTS_FILES, hostsIn, installedPiFacts, TOOLS_FILE, withHosts, withToolNames } from "../../.github/scripts/pi-derived.mjs";

// Issue #587: the pi tables this repository can derive are generated from the pinned pi, so a bump regenerates them
// instead of a person copying them. This holds every checked-in copy to its generation (a hand edit goes red), and the
// generators' rules on constructed input.

const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");

let facts = null;
try {
	facts = await installedPiFacts(repo);
} catch {
	facts = null;
}
const skip = facts ? false : "pi is not installed (run npm ci at the repo root)";
// The CI posture fails rather than skips: a skip here would let a hand-edited table through unseen.
if (skip && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("pi must be importable here in CI; a skip would hide a derived pi table drifting from its generation.");
}

test("every derived pi table in this repository equals its generation from the installed pi", { skip }, () => {
	const { changed, errors } = derivedChanges({ read, facts });
	assert.deepEqual(errors, [], "a derived table could not be generated from the installed pi");
	assert.deepEqual(changed, [], "run node .github/scripts/pi-derived.mjs --write; a derived table is never edited by hand");
});

test("a hand edit of any derived table goes red", { skip }, () => {
	const edits = {
		[HOSTS_FILES[0]]: (text) => text.replace('\t"api.groq.com",\n', ""),
		[HOSTS_FILES[1]]: (text) => text.replace('\t"openrouter.ai",\n', '\t"openrouter.ai",\n\t"evil.example",\n'),
		[CATALOG_FILE]: (text) => text.replace('"output":15,', '"output":14,'),
		[TOOLS_FILE]: (text) => text.replace('"powershell", ', ""),
	};
	assert.deepEqual(Object.keys(edits).sort(), [...DERIVED_FILES].sort(), "every derived file has a hand-edit case");
	for (const [path, edit] of Object.entries(edits)) {
		const edited = edit(read(path));
		assert.notEqual(edited, read(path), `${path}: the edit applies`);
		const { changed } = derivedChanges({ read: (p) => (p === path ? edited : read(p)), facts });
		assert.deepEqual(changed, [path], `${path}: a hand edit is a difference`);
	}
});

const row = (provider, api, id, baseUrl, extra = {}) => ({ file: `${provider}.json`, key: `chat:${id}`, row: { id, name: id, api, provider, baseUrl, reasoning: false, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, ...extra } });

test("catalog hosts are the openai-completions hosts, sorted and unique; an empty baseUrl names none and one that does not parse is reported", () => {
	const catalog = [
		row("b", "openai-completions", "m1", "https://b.example/v1"),
		row("a", "openai-completions", "m2", "https://a.example/v1"),
		row("a", "openai-completions", "m3", "https://a.example/v2"),
		row("azure", "openai-completions", "m4", ""),
		row("c", "openai-responses", "m5", "https://c.example/v1"),
		row("d", "openai-completions", "m6", "not a url"),
	];
	assert.deepEqual(catalogHosts(catalog), { hosts: ["a.example", "b.example"], unparsable: ['d.json chat:m6: baseUrl "not a url" does not parse; skipped, so it counts as the operator\'s own server'] });
});

test("the hosts block is rewritten in place, and its added and removed hosts are reported", () => {
	const source = 'x\nexport const COMPLETIONS_CATALOG_HOSTS = Object.freeze([\n\t"a.example",\n\t"old.example",\n]);\ny\n';
	assert.deepEqual(hostsIn(source), ["a.example", "old.example"]);
	assert.equal(withHosts(source, ["a.example", "new.example"]), 'x\nexport const COMPLETIONS_CATALOG_HOSTS = Object.freeze([\n\t"a.example",\n\t"new.example",\n]);\ny\n');
	const files = { [HOSTS_FILES[0]]: source, [HOSTS_FILES[1]]: source, [CATALOG_FILE]: "export const CATALOG_ROWS = Object.freeze({\n});\n", [TOOLS_FILE]: 'export const EXCLUDABLE_TOOL_NAMES = new Set(["a"]);\n' };
	const catalogFacts = { catalog: [row("p", "openai-completions", "m", "https://a.example"), row("q", "openai-completions", "n", "https://new.example")], allToolNames: ["a"] };
	assert.throws(() => catalogRowsIn(files[CATALOG_FILE]), /no CATALOG_ROWS/, "an empty row list is not a block this generator recognises");
	files[CATALOG_FILE] = 'export const CATALOG_ROWS = Object.freeze({\n\tM: ["p", "openai-completions", "m"],\n});\n';
	const { hosts, changed } = derivedChanges({ read: (path) => files[path], facts: catalogFacts });
	assert.deepEqual(hosts, { added: ["new.example"], removed: ["old.example"] });
	assert.deepEqual(changed, [...DERIVED_FILES.slice(0, 3)]);
});

test("a generator whose target moved, or whose catalog row is gone, is an error for that file alone, never a pass", () => {
	assert.throws(() => hostsIn("export const COMPLETIONS_CATALOG_HOSTS = [];", "f.mjs"), /f\.mjs: no COMPLETIONS_CATALOG_HOSTS/);
	assert.throws(() => withToolNames("export const EXCLUDABLE_TOOL_NAMES = new Set(names);", ["a"]), /no EXCLUDABLE_TOOL_NAMES/);
	const empty = derive({ read: () => "", facts: { catalog: [], allToolNames: [] } });
	assert.deepEqual(empty.errors.map((e) => e.path), [...DERIVED_FILES]);
	assert.equal(empty.files.size, 0);
	// A renamed model: the catalog file errs by name, and the other three are still generated.
	const files = { [HOSTS_FILES[0]]: 'export const COMPLETIONS_CATALOG_HOSTS = Object.freeze([\n]);\n', [HOSTS_FILES[1]]: 'export const COMPLETIONS_CATALOG_HOSTS = Object.freeze([\n]);\n', [CATALOG_FILE]: 'export const CATALOG_ROWS = Object.freeze({\n\tM: ["p", "openai-completions", "renamed"],\n});\n', [TOOLS_FILE]: 'export const EXCLUDABLE_TOOL_NAMES = new Set(["a"]);\n' };
	const renamed = derivedChanges({ read: (path) => files[path], facts: { catalog: [row("p", "openai-completions", "m", "https://a.example")], allToolNames: ["a", "b"] } });
	assert.deepEqual(renamed.errors, [{ path: CATALOG_FILE, message: `${CATALOG_FILE}: M (p openai-completions renamed) is gone from the pinned catalog; change CATALOG_ROWS` }]);
	assert.deepEqual(renamed.changed, [HOSTS_FILES[0], HOSTS_FILES[1], TOOLS_FILE]);
	assert.deepEqual(renamed.hosts, { added: ["a.example"], removed: [] });
});

test("the tool names keep pi's order", () => {
	assert.equal(withToolNames('a\nexport const EXCLUDABLE_TOOL_NAMES = new Set(["x"]);\nb', ["read", "bash", "ls"]), 'a\nexport const EXCLUDABLE_TOOL_NAMES = new Set(["read", "bash", "ls"]);\nb');
});

test("a catalog fixture keeps only the fields the bound reads, plus the fallbacks, and a row that is gone or ambiguous throws", () => {
	const fallbacks = [{ provider: "p", model: "m2", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }];
	const catalog = [row("p", "anthropic-messages", "m", "https://p.example", { compat: { allowedFallbackModels: fallbacks, other: true } }), row("p", "openai-responses", "n", "https://p.example", { compat: { supportsStrictMode: true } })];
	const source = catalogModelsSource(catalog, [["M", ["p", "anthropic-messages", "m"]], ["N", ["p", "openai-responses", "n"]]]);
	assert.match(source, /^\/\*\* p\.json anthropic-messages chat:m \*\/\nexport const M = Object\.freeze\(\{"id":"m","api":"anthropic-messages","provider":"p","baseUrl":"https:\/\/p\.example","cost":\{"input":1,"output":2,"cacheRead":0,"cacheWrite":0\},"contextWindow":1000,"maxTokens":100,"compat":\{"allowedFallbackModels":\[\{"provider":"p","model":"m2",/m);
	assert.match(source, /export const N = Object\.freeze\(\{[^\n]*"maxTokens":100\}\);/, "no compat when it holds no fallbacks");
	assert.deepEqual(catalogRowsIn(source), [["M", ["p", "anthropic-messages", "m"]], ["N", ["p", "openai-responses", "n"]]], "the generated file reads back as its own input");
	assert.throws(() => catalogModelsSource(catalog, [["X", ["p", "anthropic-messages", "gone"]]]), /X \(p anthropic-messages gone\) is gone from/);
	assert.throws(() => catalogModelsSource([...catalog, catalog[0]], [["M", ["p", "anthropic-messages", "m"]]]), /is ambiguous in/);
});
