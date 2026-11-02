import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { GATEWAY_CSS, GATEWAY_PAGE_CSS, GATEWAY_PAGE_CSS_SHA256 } from "../src/style.mjs";
import { GATEWAY_CONSOLE_CSS, GATEWAY_CONSOLE_CSS_SHA256 } from "../../admin/src/console/gateway-css.mjs";
import { PAGE_CSS, pageCss } from "../../admin/src/console/page-css.mjs";
import { gatewayLanding } from "../../admin/src/console/gateway.mjs";
import { gatewayPage } from "../src/page.mjs";
import { GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";
import { PAGES } from "../../admin/src/console/pages.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = new URL("../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const CARDS = ["SandboxTerminal", "SandboxGatewaySignIn", "SandboxGatewayStates"];

test("gateway and console fresh-sign-in styles are the published-source components, with scoped console rules", () => {
	const preview = source("design/system/components/SandboxTerminal/preview.html");
	const own = /<style>([\s\S]*?)<\/style>/.exec(preview)?.[1];
	assert.ok(own); assert.equal(own.trim(), GATEWAY_PAGE_CSS.trim());
	assert.equal(sha(GATEWAY_PAGE_CSS), GATEWAY_PAGE_CSS_SHA256); assert.equal(sha(GATEWAY_CONSOLE_CSS), GATEWAY_CONSOLE_CSS_SHA256);
	const signin = source("design/system/components/SandboxGatewaySignIn/preview.html");
	assert.equal(/<style>([\s\S]*?)<\/style>/.exec(signin)[1].trim(), `${GATEWAY_PAGE_CSS}${GATEWAY_CONSOLE_CSS}`.trim());
	assert.equal(PAGE_CSS["sandbox-gateway"], GATEWAY_CONSOLE_CSS);
	assert.match(pageCss(), /body\[data-page="sandbox-gateway"\] \.gw-stepup/);
	assert.doesNotMatch(GATEWAY_CSS, /@font-face|@import|url\(|<script|style=/);
	assert.match(GATEWAY_CSS, /--font-sans:/); assert.match(GATEWAY_CSS, /--font-mono:/);
	assert.ok(GATEWAY_PAGE_CSS.includes(`@media (max-width: ${GATEWAY_LIMITS.minimumWidth - 1}px)`), "the phone fallback and runtime admission use the same breakpoint");
	assert.match(String(gatewayLanding({ mode: "authorize" })), /class="gw-stepup"/);
});

test("every gateway reference panel and README requirement has an element ledger with actual source and verification", () => {
	for (const card of CARDS) {
		const ledger = JSON.parse(source(`gateway/test/fixtures/design-ledger/${card}.json`));
		const readme = source(`design/system/components/${card}/README.md`), preview = source(`design/system/components/${card}/preview.html`);
		assert.equal(ledger.card, card); assert.equal(ledger.issue, 754);
		const panels = [...readme.match(/\*\*Panels\.\*\*([^\n]+)/)[1].matchAll(/`(p-[a-z-]+)`/g)].map((m) => m[1]);
		assert.deepEqual(ledger.panels, panels);
		assert.deepEqual([...preview.matchAll(/id="(p-[a-z-]+)"[^>]*data-panel/g)].map((m) => m[1]), panels);
		for (const bullet of readme.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2))) assert.equal(ledger.elements.filter((element) => element.el === bullet).length, 1, `${card}: ${bullet}`);
		for (const element of ledger.elements) {
			const match = /^(?:gateway|admin)\/src\/[A-Za-z0-9_./-]+\.mjs#[A-Za-z_$][\w$]*$/.exec(element.source);
			assert.ok(match, `${card}: a code export for ${element.el}`);
			const [path, name] = element.source.split("#");
			assert.match(source(path), new RegExp(`export (?:async )?(?:function|const) ${name}\\b`));
			assert.ok(element.verification.length);
			for (const path of element.verification) { assert.ok(existsSync(new URL(path, root))); assert.match(source(path), /\btest\(/); }
		}
		assert.match(ledger.fixture, /illustrative/);
	}
	// Traceability checks above do not substitute for terminal/authority behavior: those suites drive actual
	// input, output, revocation, races and fixed refusals. A new card cannot merely acquire headings to claim support.
	assert.match(source("gateway/test/frontend.test.mjs"), /term\.input\(/);
	assert.match(source("admin/test/console-gateway-broker.test.mjs"), /different|same|revok/i);
});

test("generic arrival markup has only its expected own-origin resources and an enrolled console return", () => {
	const text = gatewayPage({ consoleOrigin: "https://console.example.test" });
	const refs = [...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(refs, ["/static/gateway.css", "/static/gateway.js", "#main", "https://console.example.test/sandbox/gateway/return"]);
	assert.doesNotMatch(text, /terminal\.js|<iframe|<form|type="password"|sessionStorage|handoff|connectionId/);
});

test("the design guide records the implemented #753 views and separate gateway routes without their superseded proposal claims", () => {
	const guide = source("design/system/README.md");
	// This is a feature-family summary, not an exact copy of fix_markers.py's card inventory. Pin the
	// owned route/card relationships without pretending every friendly screen label is a directory name.
	assert.equal(PAGES.sandboxes.path, "/runs/sandboxes"); assert.equal(PAGES["zero-touch"].path, "/runs/zero-touch");
	for (const path of [PAGES.sandboxes.path, PAGES["zero-touch"].path, "/s/<intent>", "/sandbox/gateway/authorize"]) assert.ok(guide.includes(`\`${path}\``), path);
	for (const title of ["Sandbox terminal", "Sandbox gateway sign-in", "Sandbox gateway states"]) assert.ok(guide.includes(title), title);
	assert.match(guide, /Unsent drafts and helper runs add none/);
	assert.doesNotMatch(guide, /browser-terminal proposal remains #754|Proposed only, not asked for: a browser terminal|terminal inside the browser is shown only as a proposal/);
});
