import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { artifactsComment, artifactsCommentText, artifactsLink, readArtifactsManifest, textMayMatchPhrase } from "../src/artifacts-comment.mjs";
import { consolePublicUrlOf } from "../src/config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const MANIFEST = { v: 1, jobId: "gh-1", createdAt: "2026-11-18T09:00:00.000Z", keepUntil: "2026-12-02T09:00:00.000Z", files: [{ name: "after.png", size: 184_213, sha256: "a".repeat(64), type: "image/png", scrubbed: false }, { name: "e2e-report.txt", size: 6224, sha256: "b".repeat(64), type: "text/plain", scrubbed: true }], dropped: { size: 1 } };
const COUNTS = { kept: 2, bytes: 190_437, dropped: { size: 1 } };

function storeWith(manifest) {
	const store = tempDir("pi-artifacts-comment-");
	mkdirSync(join(store, manifest.jobId), { recursive: true });
	writeFileSync(join(store, manifest.jobId, "manifest.json"), JSON.stringify(manifest));
	return store;
}

test("the comment names each kept file and its size, each reason a file was not kept, and links the run page", () => {
	assert.equal(artifactsCommentText({ jobId: "gh-1", counts: COUNTS, manifest: MANIFEST, consoleUrl: "https://console.example.org" }), [
		"pi-dispatch kept 2 files from job `gh-1` for its reviewer:",
		"- `after.png` (179.9 KB)",
		"- `e2e-report.txt` (6.1 KB)",
		"1 file was not kept: it was larger than one file may be (PI_ARTIFACTS_MAX_FILE_MB).",
		"Open them on the run page: https://console.example.org/run?id=gh-1#p-artifacts",
	].join("\n"));
	assert.match(artifactsCommentText({ jobId: "gh-1", counts: COUNTS, manifest: MANIFEST }), /Open them on the console's page for job `gh-1`\.$/, "no address: says where, links nowhere");
	assert.equal(artifactsCommentText({ jobId: "gh-1", counts: { kept: 0, bytes: 0, dropped: { secret: 2 } } }), "pi-dispatch kept no file from job `gh-1`.\n2 files were not kept: it held one of the job's secrets and could not be cleaned.");
	assert.equal(artifactsCommentText({ jobId: "gh-1", counts: { kept: 0, bytes: 0, dropped: {} } }), null);
	assert.equal(artifactsLink("https://c.example", "gh-1:r2"), "https://c.example/run?id=gh-1%3Ar2#p-artifacts");
});

test("the link names the worker that kept the files, so one console address finds the run on its host (#942)", () => {
	assert.equal(artifactsLink("https://c.example", "gh-1:r2", "mac-mini-1"), "https://c.example/run?id=gh-1%3Ar2&historyHost=mac-mini-1#p-artifacts");
	assert.equal(artifactsLink("https://c.example", "gh-1", "Box_2.lan"), "https://c.example/run?id=gh-1&historyHost=Box_2.lan#p-artifacts");
	assert.equal(artifactsLink("https://c.example", "gh-1"), "https://c.example/run?id=gh-1#p-artifacts", "no name: no historyHost");
	assert.equal(artifactsLink("https://c.example", "gh-1", null), "https://c.example/run?id=gh-1#p-artifacts");
	for (const bad of ["", "-lead", "a b", "a&b=c", "x".repeat(65), "host/../x", 7]) {
		assert.equal(artifactsLink("https://c.example", "gh-1", bad), "https://c.example/run?id=gh-1#p-artifacts", `outside the charset: ${bad}`);
	}
	assert.equal(artifactsLink(null, "gh-1", "mac-mini-1"), null, "no console address: no link, name or not");
	assert.match(artifactsComment({ jobId: "gh-1", counts: COUNTS, storeDir: storeWith(MANIFEST), consoleUrl: "https://c.example", host: "mac-mini-1" }), /\nOpen them on the run page: https:\/\/c\.example\/run\?id=gh-1&historyHost=mac-mini-1#p-artifacts$/);
});

test("names come from this host's manifest only; without it the record's counts are said", () => {
	const store = storeWith(MANIFEST);
	assert.deepEqual(readArtifactsManifest(store, "gh-1").files.map((f) => f.name), ["after.png", "e2e-report.txt"]);
	assert.equal(readArtifactsManifest(store, "gh-2"), null);
	assert.match(artifactsComment({ jobId: "gh-2", counts: COUNTS, storeDir: store }), /^pi-dispatch kept 2 files from job `gh-2` for its reviewer:\n- 2 files, 186 KB in all\n/);
	writeFileSync(join(store, "gh-1", "manifest.json"), JSON.stringify({ ...MANIFEST, files: [{ ...MANIFEST.files[0], name: "@team [x](y)" }] }));
	assert.equal(readArtifactsManifest(store, "gh-1"), null, "a name outside the charset makes the manifest unreadable, never a comment");
});

test("a text that could spell the trigger's phrase drops the names, and says nothing when even the counts could", () => {
	const store = storeWith({ ...MANIFEST, files: [{ ...MANIFEST.files[0], name: "please-fix.png" }] });
	const named = artifactsComment({ jobId: "gh-1", counts: COUNTS, storeDir: store, phrase: "please-fix" });
	assert.doesNotMatch(named, /please-fix/);
	assert.match(named, /- 1 file, /);
	assert.equal(artifactsComment({ jobId: "gh-1", counts: COUNTS, storeDir: store, phrase: "pi-dispatch kept" }), null);
	assert.equal(textMayMatchPhrase("@PI", "ask @pi later"), true);
	assert.equal(textMayMatchPhrase(null, "x"), false);
});

test("PI_CONSOLE_PUBLIC_URL is an origin: https, or http on a loopback host, nothing else", () => {
	assert.equal(consolePublicUrlOf({}), null);
	assert.equal(consolePublicUrlOf({ PI_CONSOLE_PUBLIC_URL: "" }), null);
	assert.equal(consolePublicUrlOf({ PI_CONSOLE_PUBLIC_URL: "https://console.example.org/" }), "https://console.example.org");
	assert.equal(consolePublicUrlOf({ PI_CONSOLE_PUBLIC_URL: "http://127.0.0.1:8080" }), "http://127.0.0.1:8080");
	for (const bad of ["http://console.example.org", "https://u:p@c.example", "https://c.example/run", "https://c.example/?a=1", "https://c.example/#x", "javascript:alert(1)", "not a url"]) {
		assert.throws(() => consolePublicUrlOf({ PI_CONSOLE_PUBLIC_URL: bad }), /PI_CONSOLE_PUBLIC_URL/, bad);
	}
});
