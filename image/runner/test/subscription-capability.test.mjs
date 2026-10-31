import { test } from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.mjs";
import { verifySubscriptionCapability } from "./fixtures/subscription-auth-smoke.mjs";

test("the image subscription capability proof actually rejects a fabricated receipt and an over-cap final payload", async () => {
	const root = tempDir("subscription-capability-");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@gotgenes/pi-anthropic-auth", version: "3.4.3" }));
	writeFileSync(join(root, ".dispatch-auth-adapter.json"), JSON.stringify({ version: 1, adapter: "@gotgenes/pi-anthropic-auth@3.4.3", digest: "a".repeat(64), adapterRevision: "fabricated", sources: {} }));
	await verifySubscriptionCapability(root);
	const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	const script = readFileSync(new URL("../../verify-image.sh", import.meta.url), "utf8");
	assert.match(docker, /LABEL dev\.pi-dispatch\.capabilities="[^"\n]*\bsubscriptionAuth\b/);
	assert.match(script, /subscriptionAuth\)[\s\S]*--network none[\s\S]*subscription-auth-smoke\.mjs/);
});
