import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The REAL baked persona files (issue #505). `loader.test.mjs` composes fixtures for most of its cases, so nothing there
 * would notice a protocol file that lost its sentinel, a Dockerfile that stopped copying it, or an image check that
 * stopped looking. These read the files the image is built from. No pi needed, so they run everywhere.
 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const PERSONAS = [
	{ file: "OUTBOX_PROTOCOL.md", marker: "OUTBOX-SENTINEL", sentinel: "pi-dispatch-outbox-v1" },
	{ file: "PORTFOLIO_PROTOCOL.md", marker: "PORTFOLIO-SENTINEL", sentinel: "pi-dispatch-portfolio-v1" },
];

for (const { file, marker, sentinel } of PERSONAS) {
	test(`guardrails/${file} carries its sentinel, is copied into the image where the loader reads it, and the image check looks for it`, () => {
		const text = read(`../../../guardrails/${file}`);
		assert.ok(text.includes(`<!-- ${marker}: ${sentinel} -->`), `${file} lost its sentinel`);
		const dockerfile = read("../../Dockerfile");
		assert.ok(dockerfile.includes(`COPY guardrails/${file} /opt/pi-dispatch/${file}`), `the Dockerfile does not copy ${file}`);
		const verify = read("../../verify-image.sh");
		assert.ok(verify.includes(`-q "${sentinel}" /opt/pi-dispatch/${file}`), `verify-image.sh does not check ${file}`);
	});
}

test("the loader reads the protocols from the paths the Dockerfile copies them to", () => {
	const loader = read("../src/loader.mjs");
	assert.match(loader, /export const OUTBOX_PROTOCOL_PATH = "\/opt\/pi-dispatch\/OUTBOX_PROTOCOL\.md";/);
	assert.match(loader, /export const PORTFOLIO_PROTOCOL_PATH = "\/opt\/pi-dispatch\/PORTFOLIO_PROTOCOL\.md";/);
	assert.match(loader, /export const PORTFOLIO_SNAPSHOT_PATH = "\/job\/portfolio\.json";/);
	assert.match(loader, /\[guardrails, outboxProtocol, portfolioProtocol, globalPersona, projectPersona\]/, "the order is the contract");
});

test("the portfolio persona has no dashes as punctuation and names no tool of the operator", () => {
	const text = read("../../../guardrails/PORTFOLIO_PROTOCOL.md");
	// The en and em dash by code point (8211, 8212), so this line carries neither character itself.
	assert.ok(![...text].some((c) => c.codePointAt(0) === 8211 || c.codePointAt(0) === 8212));
	assert.doesNotMatch(text, /dispatch_/, "a job never sees an admin tool, so the persona must not name one");
});
