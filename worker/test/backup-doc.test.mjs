import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lex } from "./helpers/env-reads.mjs";

// `docs/backup.md` (issue #761) promises to name every store a deployment keeps, and a store it leaves out is one an
// operator does not copy: the console's tokens can only be minted again, a durable run's checkpoint is its only way
// back. The page restates four derivable things, so they are BOLTED here (AGENTS.md: a hand-written table is derived
// or pinned, never trusted):
//
//   - every path setting, a `*_FILE`, `*_DIR`, `*_DIRS` or `*_PATH` name in `.env.example` or read from the
//     environment by the host-side source, is named on the page or sits in `NOT_A_STORE` with its reason;
//   - every subfolder the source makes inside the run history or the session store (`join(logsDir, "x")`, a
//     `*_DIR` or `*_SUBDIR` constant resolved to its value) is named on the page or sits in `NOT_A_STORE_FOLDER`;
//   - every store whose file or folder name is fixed in code, with no path setting to find it by, is pinned in
//     `FIXED_STORES` by a source file and a literal that must occur in its code, and named on the page;
//   - every Valkey key family is named in the page's "What the Valkey volume holds" table, and that table names
//     nothing else. The families are pinned below, each by a source file and a literal that must occur in its code,
//     and every exported constant whose value has a key's shape (`export const NAME = "family:..."`, whatever NAME
//     is) must fall in one or sit in `NOT_A_KEY` with its reason.
//
// WHAT THIS CANNOT SEE, so a person reading the change must: a store whose fixed file or folder name `FIXED_STORES`
// does not list, and a key family built inline (a template literal or a helper's default, with no exported constant).
// The source spells names and keys in too many ways (a `join` of literals, a helper's `prefix` default, `key("meta")`,
// a script's KEYS) for a scan of literals to tell a store or a key from a message, so the pinned tables are the honest
// form: they fail when a pinned literal moves or the page drops a name, and a new one needs a row by hand.
//
// The source is read with comments stripped (`lex`, the tokenizer `provider-steering.test.mjs` checks), so a name a
// comment mentions is not a read.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const doc = read("docs/backup.md");

// The trees whose code runs on a host. `image/runner` runs inside a job's container, so what it reads there is a job
// input, never a store of the deployment's.
const TREES = ["worker/src", "receiver/src", "admin/src", "gateway/src"];
const SOURCE_EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);
const SKIP_DIRS = new Set(["test", "node_modules", "dist"]);

function sourceFiles() {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(path);
			} else if (SOURCE_EXTS.has(extname(name))) out.push(path);
		}
	};
	for (const tree of TREES) walk(join(ROOT, tree));
	return out.map((path) => ({ path: path.slice(ROOT.length + 1), code: lex(readFileSync(path, "utf8")).code }));
}
const SOURCES = sourceFiles();
const codeOf = (rel) => {
	const file = SOURCES.find((f) => f.path === rel);
	assert.ok(file, `${rel} exists in a scanned tree`);
	return file.code;
};

/** The page names `name` inside a code span, the way every store on it is written. */
const named = (name) => new RegExp("`[^`\\n]*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^`\\n]*`").test(doc);

// Path settings that are not a store of the deployment, with why.
const NOT_A_STORE = new Map([
	["PI_SESSION_FILE", "set inside a job's container: the transcript pi resumes there, a job input the worker builds"],
	["PI_AGENTS_FILE", "set by the worker for a job's container, pointing into that job's read only /job inputs"],
	["PI_MODEL_ROLES_FILE", "set by the worker for a job's container, pointing into that job's read only /job inputs"],
	["XDG_RUNTIME_DIR", "the operating system's runtime folder of a login, read to reach the account's systemd and Podman"],
]);

const PATH_NAME = /\b([A-Z][A-Z0-9_]*_(?:FILE|DIR|DIRS|PATH))\b/g;

test("every path setting is named on the backup page or excluded with its reason", () => {
	const fromExample = new Set([...read(".env.example").matchAll(PATH_NAME)].map((m) => m[1]));
	const fromSource = new Set();
	for (const { code } of SOURCES) {
		for (const m of code.matchAll(/\b\w*[eE]nv\??\.([A-Z][A-Z0-9_]*_(?:FILE|DIR|DIRS|PATH))\b/g)) fromSource.add(m[1]);
		for (const m of code.matchAll(/\b\w*[eE]nv\[\s*["']([A-Z][A-Z0-9_]*_(?:FILE|DIR|DIRS|PATH))["']\s*\]/g)) fromSource.add(m[1]);
	}
	// Not vacuous: both sources name the run history's setting.
	assert.ok(fromExample.has("PI_LOGS_DIR") && fromSource.has("PI_LOGS_DIR"), "the scans find PI_LOGS_DIR in .env.example and in the source");
	const all = [...new Set([...fromExample, ...fromSource])].sort();
	const missing = all.filter((name) => !named(name) && !NOT_A_STORE.has(name));
	assert.deepEqual(missing, [], `docs/backup.md must name each of these, or NOT_A_STORE must say why it is not a store: ${missing.join(", ")}`);
	for (const name of NOT_A_STORE.keys()) assert.ok(all.includes(name), `NOT_A_STORE's ${name} is still read or documented somewhere (remove it if not)`);
});

// Names the source makes inside the run history or the session store that are not stores, with why.
const NOT_A_STORE_FOLDER = new Map([
	[".console.lock", "the console's single writer lock inside console-audit/, held only while a console runs"],
]);

/** The arguments of the call whose `(` is at `open`, as source text, split at its top level commas. */
function argsAt(code, open) {
	const args = [];
	let depth = 0;
	let quote = null;
	let start = open + 1;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) {
				args.push(code.slice(start, i).trim());
				return args;
			}
		} else if (c === "," && depth === 1) {
			args.push(code.slice(start, i).trim());
			start = i + 1;
		}
	}
	return args;
}

test("every subfolder the source makes in the run history or the session store is on the backup page", () => {
	const constants = new Map();
	for (const { code } of SOURCES) for (const m of code.matchAll(/\bconst ([A-Z][A-Z0-9_]*_(?:DIR|SUBDIR)) = ["']([^"'\n]+)["']/g)) constants.set(m[1], m[2]);
	const found = new Map();
	for (const { path, code } of SOURCES) {
		for (const m of code.matchAll(/\b(?:join|resolve)\(/g)) {
			const args = argsAt(code, m.index + m[0].length - 1);
			if (args.length < 2 || !/\b(?:\w*[lL]ogsDir|\w*[sS]essionsDir|PI_LOGS_DIR|PI_SESSIONS_DIR)\b/.test(args[0])) continue;
			for (const arg of args.slice(1)) {
				const literal = /^["']([^"'\n]+)["']$/.exec(arg)?.[1] ?? /^`([^`$\n]+)`$/.exec(arg)?.[1] ?? constants.get(arg);
				if (literal !== undefined) found.set(literal, path);
			}
		}
	}
	// Not vacuous: the folders the page names today, found through a literal, a member expression and both constants.
	for (const name of ["allocations", "console-audit", "touch-outbox", "sandbox-gateway-active", ".checkpoints", ".fork-sources", "forks"]) {
		assert.ok(found.has(name), `the scan finds ${name}`);
	}
	const missing = [...found].filter(([name]) => !named(name) && !NOT_A_STORE_FOLDER.has(name)).map(([name, path]) => `${name} (${path})`);
	assert.deepEqual(missing, [], `docs/backup.md must name each of these folders, or NOT_A_STORE_FOLDER must say why it is not a store: ${missing.join(", ")}`);
	for (const name of NOT_A_STORE_FOLDER.keys()) assert.ok(found.has(name), `NOT_A_STORE_FOLDER's ${name} is still made by the source`);
});

// Every store whose file or folder name is fixed in code, with no `*_FILE`, `*_DIR`, `*_DIRS` or `*_PATH` setting the
// path test above could find it by, as the page names it, pinned by where its name is made: a file and a literal
// that must occur in its code. The page drops one, or its literal moves, and this fails.
const FIXED_STORES = new Map([
	["./.env", [["worker/src/up.mjs", 'join(cwd, ".env")']]],
	["model-proposals.json", [["worker/src/doctor-model-proposals.mjs", 'join(cwd, "model-proposals.json")']]],
	["egress-allowlist.conf", [["worker/src/start.mjs", 'join(process.cwd(), "egress-allowlist.conf")']]],
	["model-endpoints.conf", [["worker/src/model-endpoints.mjs", 'MODEL_ENDPOINTS_INCLUDE_NAME = "model-endpoints.conf"']]],
	["opener/hosts.json", [["worker/src/opener-cli.mjs", '"pi-dispatch", "opener")'], ["worker/src/opener-cli.mjs", 'join(directory, "hosts.json")']]],
	["valkey.env", [["worker/src/podman-stack.mjs", '".config", "pi-dispatch", "valkey.env"']]],
	["packages/.undo", [["worker/src/packages.mjs", 'PACKAGES_SUBDIR = "packages"'], ["worker/src/package-stage.mjs", 'UNDO_DIR = ".undo"']]],
	["pi-dispatch-valkey-data", [["worker/src/valkey-auth.mjs", 'VALKEY_VOLUME = "pi-dispatch-valkey-data"']]],
	[".pi-dispatch-valkey-volume.json", [["worker/src/valkey-auth.mjs", 'VALKEY_VOLUME_RECORD = ".pi-dispatch-valkey-volume.json"'], ["worker/src/up.mjs", "join(cwd, VALKEY_VOLUME_RECORD)"], ["admin/src/setup-wizard.ts", "join(dir, VALKEY_VOLUME_RECORD)"]]],
	["console-login-codes/", [["admin/src/console/login-codes.mjs", 'join(dirname(tokensPath), "console-login-codes")']]],
]);

test("every store with a fixed name is pinned to its source and named on the backup page", () => {
	for (const [name, pins] of FIXED_STORES) {
		for (const [file, literal] of pins) assert.ok(codeOf(file).includes(literal), `${name}: ${file} names it (${literal})`);
	}
	const missing = [...FIXED_STORES.keys()].filter((name) => !named(name));
	assert.deepEqual(missing, [], `docs/backup.md must name each of these stores in a code span: ${missing.join(", ")}`);
});

// Every Valkey key family, as the page's table writes it, pinned by where it is built: a file and a literal that must
// occur in its code. A family whose literal moves fails here, and so does one the page drops or adds.
const KEY_FAMILIES = new Map([
	["bull:*", [["worker/src/bullmq-internals.mjs", 'BULL_PREFIX = "bull"']]],
	["budget:*", [["worker/src/budget.mjs", 'prefix = "budget"'], ["worker/src/budget.mjs", "}:t:"], ["worker/src/dollar-budget.mjs", '"budget:usd"'], ["worker/src/scoped-limits.mjs", "`budget:s:"]]],
	["run:budget:*", [["worker/src/run-budget-ledger.mjs", '"run:budget:"']]],
	["run:approval:*", [["worker/src/approval-state.mjs", '"run:approval:"']]],
	["run:checkpoint:*", [["worker/src/run-checkpoint.mjs", '"run:checkpoint:"']]],
	["run:recover:*", [["worker/src/recovery-queue.mjs", '"run:recover:claim:"'], ["worker/src/recovery-queue.mjs", '"run:recover:pending"']]],
	["run:steer:*", [["worker/src/steer-inbox.mjs", "`run:steer:"]]],
	["run:inbox:*", [["worker/src/steer-inbox.mjs", "`run:inbox:"]]],
	["run:await:*", [["worker/src/held-replies.mjs", '"run:await:target:"']]],
	["run:held:*", [["worker/src/held-replies.mjs", "`run:held:"]]],
	["run:live:*", [["worker/src/live-transcript.mjs", '"run:live:"']]],
	["run:progress:*", [["worker/src/run-progress.mjs", '"run:progress:"']]],
	["wait:*", [["worker/src/wait-state.mjs", '"wait:held"'], ["worker/src/fleet-lease.mjs", "`wait:check:"]]],
	["defer:job:*", [["worker/src/defer-reasons.mjs", '"defer:job:"']]],
	["cancel:*", [["worker/src/cancel-state.mjs", "`cancel:req:"]]],
	["slot:*", [["worker/src/fleet-lease.mjs", "`slot:s:"], ["worker/src/fleet-lease.mjs", "`slot:m:"]]],
	["watch:*", [["worker/src/watch-store.mjs", 'prefix = "watch"']]],
	["answerer:*", [["worker/src/answerer.mjs", 'prefix = "answerer:"']]],
	["touch:*", [["worker/src/touch-state.mjs", '"touch:index"']]],
	["zero-touch:*", [["worker/src/question-groups.mjs", '"zero-touch:questions:'], ["worker/src/zero-touch-fixes.mjs", '"zero-touch:fixes:']]],
	["alloc:*", [["worker/src/allocation.mjs", '"alloc:plan"']]],
	["dispatch:*", [["worker/src/model-failover.mjs", "`dispatch:model-attempt:"], ["worker/src/model-cooldowns.mjs", "`dispatch:model-cooldown:"], ["worker/src/subscription-status.mjs", "`dispatch:subscription-status:"], ["worker/src/subscription-quota.mjs", "`dispatch:subscription-quota:"], ["worker/src/canary-lock.mjs", '"dispatch:canary:exclusive"']]],
	["host:*", [["worker/src/host-registry.mjs", '"host:live"']]],
	["receiver:*", [["worker/src/receiver-status.mjs", '"receiver:live"']]],
	["doctor:*", [["worker/src/doctor-results.mjs", '"doctor:hosts"']]],
	["hook:*", [["worker/src/hook-runs.mjs", 'HOOK_HOSTS = "hook:hosts"'], ["worker/src/hook-runs.mjs", "`hook:h:"]]],
	["runs:*", [["worker/src/run-mirror.mjs", '"runs:index"']]],
	["console:audit", [["worker/src/console-audit.mjs", '"console:audit"']]],
	["console:trail:*", [["worker/src/processor.mjs", "`console:trail:"]]],
	["sandbox:*", [["worker/src/sandbox-sessions.mjs", '"sandbox:shells"'], ["worker/src/sandbox-inventory.mjs", '"sandbox:inventory:hosts"'], ["worker/src/sandbox-prepare-requests.mjs", "`sandbox:prepare:pending:"]]],
	["sandbox-gateway:*", [["worker/src/sandbox-gateway-protocol.mjs", 'prefix = "sandbox-gateway:"']]],
	["updates:*", [["worker/src/updates.mjs", '"updates:hosts"']]],
	["poll:*", [["receiver/src/poller.mjs", "`poll:"]]],
	["steer:steered:*", [["receiver/src/steer.mjs", "`steer:steered:"]]],
	["trigger-fire:*", [["admin/src/trigger-fire.mjs", "`trigger-fire:"]]],
	["pi-dispatch:owner", [["worker/src/valkey-auth.mjs", '"pi-dispatch:owner"']]],
	["pi-dispatch:sched-stalls", [["worker/src/scheduler-stall-guard.mjs", '"pi-dispatch:sched-stalls"']]],
]);

/** The families the page's "What the Valkey volume holds" table names in its first column. */
function pageFamilies() {
	const at = doc.indexOf("\n### What the Valkey volume holds\n");
	assert.ok(at >= 0, "docs/backup.md has its What the Valkey volume holds section");
	const end = doc.indexOf("\n#", at + 2);
	const section = doc.slice(at, end < 0 ? undefined : end);
	const out = [];
	for (const line of section.split("\n")) {
		const m = /^\| (`[^|]+`) \|/.exec(line);
		if (m) out.push(...m[1].split(/,\s*/).map((s) => s.replace(/^`|`$/g, "")));
	}
	return { out, section };
}

test("every Valkey key family is pinned to its source and named in the backup page's Valkey table", () => {
	for (const [family, pins] of KEY_FAMILIES) {
		for (const [file, literal] of pins) assert.ok(codeOf(file).includes(literal), `${family}: ${file} builds it (${literal})`);
	}
	const { out, section } = pageFamilies();
	assert.deepEqual([...out].sort(), [...KEY_FAMILIES.keys()].sort(), "the page's Valkey table names exactly the pinned families");
	// The row says what a reset costs, and what doctor sees of it.
	assert.ok(section.includes("dollars.window-reset") && /Every cap reopens/.test(section), "the Valkey section says a reset reopens caps and names dollars.window-reset");
	assert.ok(/`Queue and counters`|\| Queue and counters \|/.test(doc) && doc.includes("(#what-the-valkey-volume-holds)"), "the Valkey row links the family table");
});

// Exported constants whose value has a key's shape but is not a Valkey key, each by its exact value, with why. Each
// must still be one the scan finds, so an entry outlives no constant.
const NOT_A_KEY = new Map([
	["a:", "a field name prefix inside the wait answer hash, not a key"],
	["model:", "a scoped-limits row's scope prefix (`model:<provider>/<model>`), not a key"],
	["project:", "a scoped-limits row's scope prefix (`project:<id>`), not a key"],
	["builtin:", "pi's own `BUILTIN_PATH_PREFIX`, quoted as a needle in host-pi.mjs: pi's name for a builtin extension, not a key"],
]);

/** Every `export const NAME = "<value>"` (a string, or a template literal with no substitution) whose value has a key's shape. */
function keyShapedConstants(files) {
	const out = [];
	for (const { path, code } of files) {
		for (const m of code.matchAll(/\bexport const ([A-Za-z_$][\w$]*) = ["'`]([^"'`$\n]*)["'`]/g)) {
			if (/^[a-z][a-z0-9-]*:[A-Za-z0-9:._@-]*$/.test(m[2])) out.push({ path, name: m[1], value: m[2] });
		}
	}
	return out;
}

/** The family `family` (a `*` at its end is any rest) holds the key `value`. */
const covers = (family, value) => (family.endsWith("*") ? value.startsWith(family.slice(0, -1)) : value === family);

/** The constants of `constants` that fall in no pinned family and that `NOT_A_KEY` does not name by their exact value. */
const looseConstants = (constants) => constants.filter((c) => ![...KEY_FAMILIES.keys()].some((f) => covers(f, c.value)) && !NOT_A_KEY.has(c.value));

test("every exported constant with a key's shape falls in a pinned family", () => {
	const constants = keyShapedConstants(SOURCES);
	// Not vacuous: the scan sees the dollar counters' prefix, the defer records' key and a constant whose name says
	// nothing about a key (the failure hook's index of hosts).
	for (const value of ["budget:usd", "defer:job:", "hook:hosts"]) assert.ok(constants.some((c) => c.value === value), `the scan finds the constant ${value}`);
	// Planted: a key in a template literal is read like one in quotes, and a value that only STARTS with a `NOT_A_KEY`
	// entry ("model:" here) is still a key, since an entry excuses one exact value and never a family under it.
	const planted = keyShapedConstants([{ path: "planted", code: 'export const somethingElse = "brand-new:index";\nexport const ROSTER = `roster:all`;\nexport const MSG = "see: the docs";\nexport const MODEL_INDEX = "model:index";' }]);
	assert.deepEqual(planted.map((c) => c.value), ["brand-new:index", "roster:all", "model:index"], "the scan reads any name, quotes and template literals alike, and only a key-shaped value");
	assert.deepEqual(looseConstants(planted).map((c) => c.value), ["brand-new:index", "roster:all", "model:index"], "NOT_A_KEY excuses an exact value, never a key that starts with one");
	const loose = looseConstants(constants);
	assert.deepEqual(loose.map((c) => `${c.name} = "${c.value}" (${c.path})`), [], "a key constant outside every family: add its family to KEY_FAMILIES and the page, or say in NOT_A_KEY why it is no key");
	for (const value of NOT_A_KEY.keys()) assert.ok(constants.some((c) => c.value === value), `NOT_A_KEY's "${value}" is still an exported constant's value (remove it if not)`);
});
