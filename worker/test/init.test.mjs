import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-init-"));
function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}

test("init scaffolds the six config files with the empty templates the loaders validate against", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n"); // stand in for the repo's example
	const { out, text } = capture();

	const code = runInit(dir, { out });

	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, ".env")), ".env is copied from the example");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "triggers.json"), "utf8")), { triggers: [] });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pause-windows.json"), "utf8")), { windows: [] });
	// Empty by default: staging pins third-party code into every job, so it is opted into package by package.
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-packages.json"), "utf8")), { packages: [] });
	// Versioned from the first byte: a later reader must be able to refuse a newer file loudly (issue #53).
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")), { version: 1, subscriptions: [] });
	// Scoped limits (issue #242): versioned for the sharper reason -- enforcement config a newer file
	// could silently widen. Empty is inert, and the folder mutex needs no scaffold at all.
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "scoped-limits.json"), "utf8")), { version: 1, limits: [] });
	assert.match(text(), /the folder mutex needs no file/, "the scaffold line says what is NOT configuration");
	assert.match(text(), /pi install npm:@edgehero\/pi-dispatch-admin/, "next steps name the operator panel");
});

test("init is idempotent and never overwrites operator edits", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-mine\n"); // already configured
	writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [{ id: "keep" }] }));
	writeFileSync(join(dir, "pi-packages.json"), JSON.stringify({ packages: [{ name: "@a/b", version: "1.0.0" }] }));
	const { out, text } = capture();

	const code = runInit(dir, { out });

	assert.equal(code, 0);
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), "ANTHROPIC_API_KEY=sk-mine\n", ".env left untouched");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "triggers.json"), "utf8")), { triggers: [{ id: "keep" }] });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-packages.json"), "utf8")), { packages: [{ name: "@a/b", version: "1.0.0" }] }, "a pinned package list is never overwritten");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "pause-windows.json"), "utf8")), { windows: [] }, "the missing ones are still created");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")), { version: 1, subscriptions: [] });
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "scoped-limits.json"), "utf8")), { version: 1, limits: [] });
	assert.match(text(), /kept.*\.env/, "an existing file is reported as kept");
});

test("init without a cwd .env.example falls back to the copy shipped with the package (the npm-install path)", () => {
	// No seeded .env.example: this is `pi-dispatch init` in an empty deployment folder, where the bin
	// came from an npm install and the repo root does not exist. The fallback must reach the REAL
	// worker/.env.example next to src/, so the real fs is used, not a fake.
	const dir = tmp();
	const { out, text } = capture();

	const code = runInit(dir, { out });

	assert.equal(code, 0);
	const packaged = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), packaged, ".env is the packaged worker/.env.example, byte for byte");
	assert.match(text(), /created\s+\.env/, "the fallback still reports .env as created");
});

test("init scaffolds an egress allowlist that WORKS, not an empty one", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	runInit(dir, { out: () => {} });
	const list = readFileSync(join(dir, "egress-allowlist.conf"), "utf8");
	// Every other scaffold in init is EMPTY because empty is inert: no triggers, no windows, no packages.
	// An empty allowlist is not inert -- it is a deployment where every job dies at its first turn and
	// spends two budget slots doing it -- so this one ships the working minimum instead.
	assert.match(list, /^api\.anthropic\.com$/m, "the provider is an ordinary entry, with no address rule anywhere");
	assert.match(list, /^\.github\.com$/m);
	assert.match(list, /^registry\.npmjs\.org$/m);
	// The honest part: the flow-specific tail is the half nobody can enumerate for an operator.
	assert.match(list, /Your flows are the part nobody can list for you/);
});

test("init never overwrites an edited allowlist", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	writeFileSync(join(dir, "egress-allowlist.conf"), "example.com\n");
	runInit(dir, { out: () => {} });
	assert.equal(readFileSync(join(dir, "egress-allowlist.conf"), "utf8"), "example.com\n", "create-only, like every other scaffold here");
});
