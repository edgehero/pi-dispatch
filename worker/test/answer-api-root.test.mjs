import assert from "node:assert/strict";
import { test } from "node:test";
import { answerApiRoot } from "../src/answerer.mjs";

test("answer source roots preserve the reviewed instance path while canonicalizing equivalent HTTPS origins", () => {
	assert.equal(answerApiRoot("https://FORGE.invalid:443/team///"), "https://forge.invalid/team");
	assert.equal(answerApiRoot("https://api.github.com/"), "https://api.github.com");
	assert.equal(answerApiRoot("https://forge.invalid/team/api/v4/"), "https://forge.invalid/team/api/v4");
	assert.equal(answerApiRoot("https://forge.invalid/team/api/v1/"), "https://forge.invalid/team/api/v1");
	assert.notEqual(answerApiRoot("https://forge.invalid/Team"), answerApiRoot("https://forge.invalid/team"));
	assert.notEqual(answerApiRoot("https://dev.azure.com/old"), answerApiRoot("https://dev.azure.com/new"));
	for (const value of [null, undefined, "", "http://forge.invalid/team", "https://user:secret@forge.invalid/team", "https://forge.invalid/team?token=secret", "https://forge.invalid/team#fragment", "https://forge.invalid/team\n", "https://forge.invalid/team path", `https://forge.invalid/${"x".repeat(2048)}`]) assert.equal(answerApiRoot(value), null);
});
