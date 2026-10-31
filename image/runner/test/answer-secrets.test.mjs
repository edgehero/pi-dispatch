import assert from "node:assert/strict";
import { test } from "node:test";
import { knownAnswerSecretMatcher } from "../src/answer-secrets.mjs";

test("cited text rejects the job's known credential spellings without changing safe source bytes", () => {
	const credential = "provider-credential-canary-772/with+punctuation";
	const contains = knownAnswerSecretMatcher({ OPENAI_API_KEY: credential, GITHUB_TOKEN: "forge-credential-canary-772", AZURE_DEVOPS_EXT_PAT: "azure-credential-canary-772", PI_REPORT_PROGRESS: "on", ORDINARY_LABEL: "public-repository-convention", SECRET_FLAG: "yes" });
	for (const spelling of [credential, JSON.stringify(credential).slice(1, -1), encodeURIComponent(credential), encodeURIComponent(credential).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()), Buffer.from(credential).toString("base64"), Buffer.from(`:${credential}`).toString("base64"), "forge-credential-canary-772", "azure-credential-canary-772"]) assert.equal(contains(`source before ${spelling} after`), true);
	for (const safe of ["Run npm test.", "An ordinary API_KEY field name, never its value.", "public-repository-convention", "yes", "", null]) assert.equal(contains(safe), false);
	assert.equal(knownAnswerSecretMatcher({})(credential), false, "no claim to recognize a credential the job was never given");
});
