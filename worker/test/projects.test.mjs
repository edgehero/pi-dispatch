import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_PROJECTS_FINGERPRINT, PROJECTS_VERSION, PROJECT_ID_RE, isProjectId, loadProjects, parseProjects, projectOf, projectsFingerprint, projectsFingerprintInput } from "../src/projects.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const wrap = (projects, version = 1) => JSON.stringify({ version, projects });
const parse = (projects, version) => parseProjects(wrap(projects, version), "projects.json");
const refused = (projects, re, version) => assert.throws(() => parse(projects, version), (e) => e.piDispatchConfig === true && re.test(e.message), String(re));

// ── the parser ──────────────────────────────────────────────────────────────────────────────────────────

test("parseProjects accepts the issue's example and normalizes each project to { id, name, members }", () => {
	const projects = parse([{ id: "shop", name: "Webshop", members: ["github:acme/web", "forgejo:acme/platform", "/srv/shop-tools"], note: "dropped" }]);
	assert.deepEqual(projects, [{ id: "shop", name: "Webshop", members: ["github:acme/web", "forgejo:acme/platform", "/srv/shop-tools"] }]);
	assert.deepEqual(parse([{ id: "a", members: ["gitlab:grp/sub/repo"] }]), [{ id: "a", name: null, members: ["gitlab:grp/sub/repo"] }], "name absent reads null");
	assert.deepEqual(parse([]), [], "an empty list is valid: no projects");
	assert.equal(PROJECTS_VERSION, 1);
});

test("a local member is stored resolved, and a qualified member trimmed and NFC", () => {
	const [p] = parse([{ id: "a", members: ["  /srv//shop-tools/ ", " github:acme/we\u0301b "] }]);
	assert.deepEqual(p.members, [resolve("/srv/shop-tools"), "github:acme/w\u00e9b"]);
});

test("the version: required, an integer >= 1, and a newer one is refused", () => {
	assert.throws(() => parseProjects(JSON.stringify({ projects: [] }), "p.json"), /must have "version": 1/);
	assert.throws(() => parseProjects(JSON.stringify({ version: 0, projects: [] }), "p.json"), /must have "version": 1/);
	assert.throws(() => parseProjects(JSON.stringify({ version: "1", projects: [] }), "p.json"), /must have "version": 1/);
	refused([], /written by a newer pi-dispatch \(version 2; this build understands 1\)/, 2);
});

test("the shape: an object with a projects array, each project an object", () => {
	assert.throws(() => parseProjects("[]", "p.json"), /must be an object/);
	assert.throws(() => parseProjects(JSON.stringify({ version: 1 }), "p.json"), /"projects" array/);
	refused(["shop"], /project at index 0: must be an object/);
});

test("an id must match the charset: Shop, a:b, a 33-character id, a leading dash and a slash are refused", () => {
	for (const id of ["Shop", "a:b", "x".repeat(33), "-shop", "a/b", "a#b", "", " shop", 7, null]) {
		refused([{ id, members: ["github:acme/web"] }], /project at index 0: id must match/);
	}
	assert.deepEqual(parse([{ id: "x".repeat(32), members: ["github:acme/web"] }])[0].id, "x".repeat(32), "32 characters is the ceiling");
	assert.equal(parse([{ id: "0-shop-2", members: ["github:acme/web"] }])[0].id, "0-shop-2");
	assert.equal(PROJECT_ID_RE.source, "^[a-z0-9][a-z0-9-]{0,31}$", "the contract's pattern, as written in INT-PROJECTS-FILE-CONTRACT");
});

test("a duplicate id is refused, naming both indexes", () => {
	refused([{ id: "shop", members: ["github:acme/web"] }, { id: "shop", members: ["github:acme/api"] }], /project at index 1: duplicate id "shop" \(first at index 0\)/);
});

test("a scope claimed by two projects is refused, naming BOTH ids", () => {
	refused([{ id: "a", members: ["github:acme/web"] }, { id: "b", members: ["github:acme/web"] }], /"github:acme\/web" is claimed by both "a" and "b"/);
	// Two spellings of one folder are one scope.
	refused([{ id: "a", members: ["/srv/site"] }, { id: "b", members: ["/srv/site/"] }], /claimed by both "a" and "b"/);
	// One repo on two forges is two scopes, so it may sit in two projects.
	assert.equal(parse([{ id: "a", members: ["github:acme/web"] }, { id: "b", members: ["forgejo:acme/web"] }]).length, 2);
});

test("a member listed twice in one project is refused", () => {
	refused([{ id: "a", members: ["/srv/site", "/srv/site/."] }], /member 1: ".*site" is listed twice/);
});

test("members: empty, missing, or not an array is refused", () => {
	refused([{ id: "a", members: [] }], /members must be a non-empty array/);
	refused([{ id: "a" }], /members must be a non-empty array/);
	refused([{ id: "a", members: "github:acme/web" }], /members must be a non-empty array/);
	refused([{ id: "a", members: [""] }], /member 0: must be a non-empty string/);
	refused([{ id: "a", members: [7] }], /member 0: must be a non-empty string/);
});

test("a bare member is refused, naming the qualified spelling", () => {
	refused([{ id: "a", members: ["acme/web"] }], /"acme\/web" is a bare repo, which names that repo on every forge; write it with its forge, such as github:acme\/web/);
});

test("a relative folder, an unknown prefix, a malformed qualified repo and a glob are refused", () => {
	// A relative folder name reads as a bare scope, and is refused as one: it is not an absolute folder.
	refused([{ id: "a", members: ["shop-tools"] }], /is a bare repo/);
	refused([{ id: "a", members: ["./shop-tools"] }], /is a bare repo/);
	refused([{ id: "a", members: ["gitub:acme/web"] }], /unknown prefix "gitub:"/);
	refused([{ id: "a", members: ["project:shop"] }], /unknown prefix "project:"/);
	refused([{ id: "a", members: ["github:acme/web/"] }], /is not a forge repo/);
	refused([{ id: "a", members: ["github:acme/*"] }], /no globs/);
	refused([{ id: "a", members: ["*"] }], /no globs/);
});

test("a drive path on a POSIX host is refused rather than kept as a member no job can have", { skip: process.platform === "win32" ? "a drive path is absolute here" : false }, () => {
	refused([{ id: "a", members: ["C:\\srv\\site"] }], /is not an absolute path on this host/);
});

test("name: optional display text; a bad one is refused WITHOUT quoting it", () => {
	assert.equal(parse([{ id: "a", name: "  Web Shop  ", members: ["github:acme/web"] }])[0].name, "Web Shop");
	assert.equal(parse([{ id: "a", name: null, members: ["github:acme/web"] }])[0].name, null);
	for (const name of ["", "   ", 7, "Private\nName", "P".repeat(121)]) {
		assert.throws(
			() => parse([{ id: "a", name, members: ["github:acme/web"] }]),
			(e) => /project at index 0 \("a"\): name, when given, must be a string/.test(e.message) && (typeof name !== "string" || name.trim() === "" || !e.message.includes(name.trim())),
		);
	}
});

test("invalid JSON is refused without the parser's message, which quotes file text (a name stays out of every log)", () => {
	assert.throws(
		// An unquoted name: Node's own message here quotes the text around the fault ("Private Pe"), measured on Node 23.
		() => parseProjects('{ "version": 1, "projects": [ { "id": "a", "name": Private Person } ] }', "p.json"),
		(e) => e.piDispatchConfig === true && /^projects file is not valid JSON/.test(e.message) && !e.message.includes("Private"),
	);
});

test("isProjectId is the record's charset check", () => {
	assert.equal(isProjectId("shop"), true);
	for (const v of ["Shop", "", null, undefined, 3, "a b", "x".repeat(33), "Webshop Name"]) assert.equal(isProjectId(v), false, String(v));
});

// ── the loader ──────────────────────────────────────────────────────────────────────────────────────────

test("loadProjects: unset is [], an empty value or a missing file is refused, a file loads", () => {
	assert.deepEqual(loadProjects({ projectsFile: null }), []);
	assert.deepEqual(loadProjects({}), []);
	assert.throws(() => loadProjects({ projectsFile: "" }), /projects file does not exist: $/);
	const dir = tempDir("pi-projects-");
	const file = join(dir, "projects.json");
	assert.throws(() => loadProjects({ projectsFile: file }), /does not exist/);
	writeFileSync(file, wrap([{ id: "shop", members: ["github:acme/web"] }]));
	assert.deepEqual(loadProjects({ projectsFile: file }), [{ id: "shop", name: null, members: ["github:acme/web"] }]);
	// The injectable seams, the scoped-limits loader's shape.
	const seen = [];
	const io = { existsSync: () => true, readFileSync: (p) => (seen.push(p), wrap([])) };
	assert.deepEqual(loadProjects({ projectsFile: "/x/projects.json" }, io), []);
	assert.deepEqual(seen, ["/x/projects.json"]);
});

// ── projectOf ───────────────────────────────────────────────────────────────────────────────────────────

const PROJECTS = parse([
	{ id: "shop", name: "Webshop", members: ["github:acme/web", "forgejo:acme/platform", "/srv/shop-tools"] },
	{ id: "ops", members: ["gitlab:acme/web"] },
]);

test("projectOf matches a forge job by kind:repo, so one repo on two forges resolves to two projects", () => {
	assert.equal(projectOf({ kind: "github", repo: "acme/web" }, PROJECTS), "shop");
	assert.equal(projectOf({ kind: "forgejo", repo: "acme/platform" }, PROJECTS), "shop");
	assert.equal(projectOf({ kind: "gitlab", repo: "acme/web" }, PROJECTS), "ops");
	assert.equal(projectOf({ kind: "forgejo", repo: "acme/web" }, PROJECTS), null, "a forge whose acme/web is no member");
	assert.equal(projectOf({ kind: "github", repo: "acme/api" }, PROJECTS), null, "a non-member");
});

test("projectOf never resolves by bare repo: a member is only ever the qualified spelling", () => {
	// A job with no kind has no qualified scope, so it belongs to no project even though its repo is a member's.
	assert.equal(projectOf({ repo: "acme/web" }, PROJECTS), null);
	// And a hand-built list holding a bare spelling (the parser refuses one) still matches nothing.
	assert.equal(projectOf({ kind: "github", repo: "acme/web" }, [{ id: "bare", members: ["acme/web"] }]), null);
});

test("projectOf matches a local job by its resolved folder", () => {
	assert.equal(projectOf({ kind: "local", folder: "/srv/shop-tools" }, PROJECTS), "shop");
	assert.equal(projectOf({ kind: "local", folder: "/srv/shop-tools/" }, PROJECTS), "shop", "a trailing slash is one folder");
	assert.equal(projectOf({ kind: "local", folder: "/srv/x/../shop-tools" }, PROJECTS), "shop");
	assert.equal(projectOf({ kind: "local", folder: "/srv/other" }, PROJECTS), null);
});

test("projectOf is null with no projects, no job, or no scope", () => {
	assert.equal(projectOf({ kind: "github", repo: "acme/web" }, []), null);
	assert.equal(projectOf({ kind: "github", repo: "acme/web" }, null), null);
	assert.equal(projectOf(undefined, PROJECTS), null);
	assert.equal(projectOf({ kind: "github" }, PROJECTS), null);
	assert.equal(projectOf({ kind: "local" }, PROJECTS), null);
});

// ── the fleet fingerprint (issue #499 part C) ───────────────────────────────────────────────────────────

test("fpProjects hashes ids and member hashes only: never a name, never a member in clear", () => {
	const projects = parse([
		{ id: "shop", name: "Private Webshop Name", members: ["github:acme/web", "/srv/private-folder"] },
		{ id: "tools", name: "\u202eevil", members: ["forgejo:acme/tools"] },
	]);
	const input = projectsFingerprintInput(projects);
	const text = JSON.stringify(input);
	for (const secret of ["Private Webshop Name", "Webshop", "evil", "acme/web", "/srv/private-folder", "private-folder", "acme/tools"]) assert.ok(!text.includes(secret), `${secret} is not in the input`);
	assert.deepEqual(input.map((p) => p.id), ["shop", "tools"]);
	for (const p of input) for (const m of p.members) assert.match(m, /^[0-9a-f]{16}$/, "a member is its hash");
	assert.match(projectsFingerprint(projects), /^[0-9a-f]{16}$/);
});

test("fpProjects moves with an id and with membership, and not with a name or the order", () => {
	const base = parse([{ id: "shop", name: "A", members: ["github:acme/web", "/srv/a"] }, { id: "ops", members: ["/srv/b"] }]);
	const fp = projectsFingerprint(base);
	assert.equal(projectsFingerprint(parse([{ id: "ops", members: ["/srv/b"] }, { id: "shop", name: "B", members: ["/srv/a", "github:acme/web"] }])), fp, "a renamed name and a reordered file agree");
	assert.notEqual(projectsFingerprint(parse([{ id: "shop", members: ["github:acme/web"] }, { id: "ops", members: ["/srv/b", "/srv/a"] }])), fp, "a member moved to another project disagrees");
	assert.notEqual(projectsFingerprint(parse([{ id: "store", members: ["github:acme/web", "/srv/a"] }, { id: "ops", members: ["/srv/b"] }])), fp, "a renamed id disagrees");
	assert.notEqual(projectsFingerprint(parse([{ id: "shop", members: ["forgejo:acme/web", "/srv/a"] }, { id: "ops", members: ["/srv/b"] }])), fp, "the same repo on another forge disagrees");
	assert.equal(projectsFingerprint([]), EMPTY_PROJECTS_FINGERPRINT, "no projects is a fingerprint of its own, never an abstention");
	assert.notEqual(fp, EMPTY_PROJECTS_FINGERPRINT);
});
