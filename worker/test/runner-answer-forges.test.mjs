import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ANSWER_FORGES, createAnswerSourceReader, validateAnswerInput } from "../../image/runner/src/answerer.mjs";
import { FORGES, FORGE_KINDS, forgeApiRoot } from "../src/forges.mjs";

/**
 * Issue #824: the job image's answer draft reads name each forge they accept in one table, `ANSWER_FORGES`, and refuse
 * any other kind. The runner cannot import the forge table at run time, so its rows are a copy, and this is the bolt
 * that keeps them one: a forge added to FORGES without a row has every answer draft refused `answer-draft-refused`, and
 * before the table its drafts were read with Azure's token, header and paths.
 */

const AT = Date.UTC(2026, 9, 31, 12);
const input = (kind, apiUrl = "https://api.github.com") => ({ version: 1, rule: { id: "help", categories: ["how-to"], confidence: 0.9, mode: "draft", decisionModel: { provider: "test", id: "classifier" } }, source: { kind, repo: "acme/web", target: { type: "issue", number: 7 }, selfId: 99, apiUrl, questionCommentId: "123", startedAt: AT - 60_000, parkedAt: AT }, standing: [], baseSha: "b".repeat(40), flow: { name: "answer", revision: "b".repeat(40), text: "Cite a documented command." } });
// The names a row's token read asks the environment for, recorded rather than parsed out of the source.
const tokenNames = (row) => { const asked = []; row.token(new Proxy({}, { get: (_, name) => { asked.push(name); return undefined; } })); return asked; };
// What the table owes a forge, as a list of what is missing: empty for the shipped kinds, and naming the place for one it
// lacks, which a widened list below stands in for.
const missing = (kinds) => kinds.flatMap((kind) => {
	const row = Object.hasOwn(ANSWER_FORGES, kind) ? ANSWER_FORGES[kind] : null;
	if (!row) return [`${kind}: image/runner/src/answerer.mjs ANSWER_FORGES has no row, so its answer drafts are refused`];
	const asked = tokenNames(row);
	return asked.length === 1 && asked[0] === FORGES[kind]?.tokenVars[0] ? [] : [`${kind}: ANSWER_FORGES reads ${asked.join(", ")}, the mint writes ${FORGES[kind]?.tokenVars[0]} first`];
});

test("the runner's answer forges are FORGE_KINDS, row for row, each reading the token the worker's mint writes first", () => {
	assert.deepEqual(Object.keys(ANSWER_FORGES), [...FORGE_KINDS]);
	assert.deepEqual(missing(FORGE_KINDS), []);
	assert.deepEqual(missing([...FORGE_KINDS, "bitbucket"]), ["bitbucket: image/runner/src/answerer.mjs ANSWER_FORGES has no row, so its answer drafts are refused"]);
	for (const kind of FORGE_KINDS) {
		const row = ANSWER_FORGES[kind];
		assert.ok(Object.isFrozen(row), `${kind}: a row cannot be widened at run time`);
		for (const read of ["token", "headers", "comment", "admitted", "replies"]) assert.equal(typeof row[read], "function", `${kind}: ${read}`);
		// A fixed origin is the forge table's own API root, so the root the worker hands a draft is the one the runner takes.
		assert.equal(row.origin, FORGES[kind].apiRoot.url === undefined ? null : new URL(forgeApiRoot(kind, {})).origin, `${kind}: origin`);
	}
	// No read branches on the kind outside the table, so a kind without a row has no other forge's branch to fall into.
	const source = readFileSync(new URL("../../image/runner/src/answerer.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\.kind\s*[!=]==\s*"(?!string")/, "a per-kind choice in the runner's answer reads belongs in ANSWER_FORGES");
});

test("every forge kind's draft input is taken, and any other kind refused before a token is read, with no prototype name or array taken for one", () => {
	for (const kind of FORGE_KINDS) {
		const draft = input(kind, ANSWER_FORGES[kind].origin ?? "https://forge.example/base");
		assert.equal(validateAnswerInput(draft), draft, kind);
		const env = { [FORGES[kind].tokenVars[0]]: "SCOPED" };
		assert.equal(typeof createAnswerSourceReader(draft, { env, fetch: async () => { throw new Error("no request is made at construction"); } }).question, "function", kind);
		assert.throws(() => createAnswerSourceReader(draft, { env: {}, fetch: async () => {} }), (e) => e.piDispatchReason === "answer-draft-refused", `${kind}: no token, no reader`);
	}
	for (const kind of ["local", "bitbucket", "GitHub", "toString", "constructor", "__proto__", "hasOwnProperty", "", null, 7, ["github"]]) {
		assert.throws(() => validateAnswerInput(input(kind)), (e) => e.piDispatchReason === "answer-draft-refused", JSON.stringify(kind));
	}
	assert.throws(() => validateAnswerInput(input("github", "https://github.example")), (e) => e.piDispatchReason === "answer-draft-refused", "github's origin is fixed");
});

// Issue #824: what each forge's question, reply and replies reads send, the method, the URL and the header that carries
// the token, written out for every FORGE_KINDS forge. They are the requests the reads sent before ANSWER_FORGES, so a row
// that moves a path, a page parameter, an origin or a header fails here, which the row-for-row walk above cannot see.
const AZURE_PROJECT = "33333333-3333-3333-3333-333333333333";
const SERVED = {
	github: { source: { apiUrl: "https://api.github.com" }, author: 88 },
	gitlab: { source: { apiUrl: "https://gitlab.example/team", projectId: 42 }, author: 88 },
	forgejo: { source: { apiUrl: "https://code.example/forgejo" }, author: 88 },
	azure: { source: { apiUrl: "https://dev.azure.com/acme", selfId: "11111111-1111-1111-1111-111111111111", azure: { project: "Web App", projectId: AZURE_PROJECT } }, author: "22222222-2222-2222-2222-222222222222" },
};
// Every forge's token in every environment, each its own value, so a read with another forge's token shows in its header.
const TOKENS = { GITHUB_TOKEN: "scoped-github", GITLAB_TOKEN: "scoped-gitlab", FORGEJO_TOKEN: "scoped-forgejo", AZURE_DEVOPS_EXT_PAT: "scoped-azure" };
const GITHUB = "Authorization: token scoped-github", GITLAB = "PRIVATE-TOKEN: scoped-gitlab", FORGEJO = "Authorization: token scoped-forgejo";
// Basic over an empty user name and the PAT: the base64 of ":scoped-azure".
const AZURE = "Authorization: Basic OnNjb3BlZC1henVyZQ==";
const GITLAB_MEMBER = ["GET", "https://gitlab.example/team/api/v4/projects/42/members/all/88", GITLAB];
const FORGEJO_PERMISSION = ["GET", "https://code.example/forgejo/api/v1/repos/acme/web/collaborators/dev/permission", FORGEJO];
const AZURE_ADMITTED = [
	["GET", "https://vssps.dev.azure.com/acme/_apis/graph/descriptors/22222222-2222-2222-2222-222222222222?api-version=7.1-preview.1", AZURE],
	["GET", `https://vssps.dev.azure.com/acme/_apis/graph/descriptors/${AZURE_PROJECT}?api-version=7.1-preview.1`, AZURE],
	["GET", "https://vssps.dev.azure.com/acme/_apis/graph/memberships/descriptor-22222222-2222-2222-2222-222222222222?direction=up&api-version=7.1-preview.1", AZURE],
];
const SENT = {
	github: {
		question: [["GET", "https://api.github.com/repos/acme/web/issues/comments/123", GITHUB]],
		reply: [["GET", "https://api.github.com/repos/acme/web/issues/comments/124", GITHUB]],
		replies: [["GET", "https://api.github.com/repos/acme/web/issues/7/comments?per_page=20&page=1", GITHUB]],
	},
	gitlab: {
		question: [["GET", "https://gitlab.example/team/api/v4/projects/42/issues/7/notes/123", GITLAB]],
		reply: [["GET", "https://gitlab.example/team/api/v4/projects/42/issues/7/notes/124", GITLAB], GITLAB_MEMBER],
		replies: [["GET", "https://gitlab.example/team/api/v4/projects/42/issues/7/notes?per_page=20&page=1&sort=desc", GITLAB], GITLAB_MEMBER],
	},
	forgejo: {
		question: [["GET", "https://code.example/forgejo/api/v1/repos/acme/web/issues/comments/123", FORGEJO]],
		reply: [["GET", "https://code.example/forgejo/api/v1/repos/acme/web/issues/comments/124", FORGEJO], FORGEJO_PERMISSION],
		replies: [["GET", "https://code.example/forgejo/api/v1/repos/acme/web/issues/7/comments?limit=20&page=1", FORGEJO], FORGEJO_PERMISSION],
	},
	azure: {
		question: [["GET", "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7/comments/123?api-version=7.1-preview.4", AZURE]],
		reply: [["GET", "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7/comments/124?api-version=7.1-preview.4", AZURE], ...AZURE_ADMITTED],
		replies: [["GET", "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7/comments?$top=20&api-version=7.1-preview.4", AZURE], ...AZURE_ADMITTED],
	},
};
// One server for every forge: comment 123 is the question, by the draft's own identity, 124 an admitted member's reply,
// and a replies page holds that reply. Each answer carries every forge's field names, so only the request differs.
function serve(url, kind) {
	const { pathname } = new URL(url), last = pathname.split("/").pop();
	if (pathname.includes("/members/all/")) return { access_level: 30 };
	if (pathname.includes("/collaborators/")) return { permission: "write" };
	if (pathname.includes("/graph/descriptors/")) return { value: `descriptor-${last}` };
	if (pathname.includes("/graph/memberships/")) return { value: [{ containerDescriptor: `descriptor-${AZURE_PROJECT}` }] };
	const comment = (id) => {
		const by = id === "123" ? SERVED[kind].source.selfId ?? 99 : SERVED[kind].author, at = new Date(id === "123" ? AT - 1000 : AT - 120_000).toISOString(), text = id === "123" ? "Q?" : "A.";
		return { id: Number(id), workItemId: 7, issue_url: `${url.slice(0, url.indexOf("/issues/"))}/issues/7`, body: text, text, user: { id: by, login: "dev" }, author: { id: by }, createdBy: { id: by }, author_association: "MEMBER", created_at: at, createdDate: at };
	};
	if (last === "comments" || last === "notes") return pathname.includes("/workItems/") ? { comments: [comment("124")] } : [comment("124")];
	return comment(last);
}
const carried = (headers) => Object.entries(headers).filter(([name]) => name !== "accept").map(([name, value]) => `${name}: ${value}`).join(", ");
const READS = [["question", (r) => r.question()], ["reply", async (r) => (await r.reply(7, "124")).text], ["replies", (r) => r.replies(7)]];
async function reads(kind) {
	let requests;
	const fetch = async (url, init) => { requests.push([init.method, url, carried(init.headers)]); return Response.json(serve(url, kind)); };
	const draft = input(kind);
	Object.assign(draft.source, SERVED[kind].source);
	const reader = createAnswerSourceReader(draft, { env: TOKENS, fetch });
	const sent = {}, results = {};
	for (const [read, call] of READS) {
		requests = [];
		try { results[read] = await call(reader); } catch (e) { results[read] = e.message; }
		sent[read] = requests;
	}
	return { sent, results };
}

test("each forge's question, reply and replies reads send the method, URL and token header its API takes (#824)", async () => {
	for (const kind of FORGE_KINDS) {
		assert.ok(Object.hasOwn(SENT, kind), `${kind}: worker/test/runner-answer-forges.test.mjs needs the requests its answer draft reads send`);
		const { sent, results } = await reads(kind);
		assert.deepEqual(sent, SENT[kind], kind);
		assert.deepEqual(results, { question: "Q?", reply: "A.", replies: { references: [{ issue: 7, commentId: "124" }], partial: false } }, `${kind}: every read reaches its answer`);
	}
});
