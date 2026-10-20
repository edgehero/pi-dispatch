// doctor's project secret bundle lines (issue #704): the listing, the failures, the folder warning, the rate figure and
// `--secrets`, which resolves each bundle on this host and prints names only.
import assert from "node:assert/strict";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { secretBundleChecks } from "../src/doctor-bundles.mjs";
import { realExecutable } from "../src/secrets.mjs";
import { makeBundleResolver } from "../src/secret-bundles.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

function script() {
	const dir = tempDir("pi-doctor-bundles-");
	const path = join(dir, "resolve.sh");
	writeFileSync(path, `#!/bin/sh\n[ -e "${dir}/$1.env" ] || exit 2\nexec cat "${dir}/$1.env"\n`);
	chmodSync(path, 0o755);
	writeFileSync(join(dir, "shop.env"), "STRIPE_KEY=sk_live_doctor_value\nDB_URL=postgres://x\n");
	return { dir, path };
}

const projects = [{ id: "shop", members: ["github:acme/shop"] }, { id: "tools", members: ["/srv/tools"] }];

test("each bundle is listed by id, profile, format and project, and the rate figure is stated", async () => {
	const s = script();
	const checks = await secretBundleChecks({ bundles: { shop: { profile: "shop-env", ref: "shop", project: "shop" } }, projects, envRaw: `shop-env:${s.path}:dotenv`, realExecutablePath: realExecutable });
	assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
	assert.ok(checks.some((c) => c.label === "secret bundle shop: profile shop-env (dotenv), project shop"));
	assert.ok(checks.some((c) => /one resolver call per job start/.test(c.label)));
});

test("an undeclared profile, an unknown project and a missing triggers file each fail", async () => {
	const checks = await secretBundleChecks({ bundles: { shop: { profile: "nope", ref: "shop", project: "ghost" } }, projects, envRaw: "other:/opt/x.sh:json", triggersPresent: false });
	const failed = checks.filter((c) => !c.ok).map((c) => c.label);
	assert.ok(failed.some((l) => /names profile nope, which this host does not declare/.test(l)), failed.join("\n"));
	assert.ok(failed.some((l) => /names project ghost, which projects.json does not hold/.test(l)));
	assert.ok(failed.some((l) => /no triggers file to read secretBundles from/.test(l)));
	const garbled = await secretBundleChecks({ envRaw: "shop:/x.sh" });
	assert.equal(garbled[0].ok, false);
	assert.match(garbled[0].label, /PI_SECRET_BUNDLES does not parse/);
});

test("a profile declared twice and an overlay profile outside the roots fail apart from undeclared", async () => {
	const s = script();
	const ambiguous = await secretBundleChecks({ bundles: { shop: { profile: "p", ref: "shop", project: "shop" } }, projects, envRaw: `p:${s.path}:dotenv`, overlayBundles: { p: { path: s.path, format: "dotenv" } }, realExecutablePath: realExecutable });
	assert.ok(ambiguous.some((c) => !c.ok && /declared in both/.test(c.label)));
	const outside = await secretBundleChecks({ bundles: { shop: { profile: "p", ref: "shop", project: "shop" } }, projects, overlayBundles: { p: { path: s.path, format: "dotenv" } }, roots: ["/nowhere"], realExecutablePath: realExecutable });
	assert.ok(outside.some((c) => !c.ok && /declared in the settings overlay but not usable/.test(c.label)));
	const inside = await secretBundleChecks({ bundles: { shop: { profile: "p", ref: "shop", project: "shop" } }, projects, overlayBundles: { p: { path: s.path, format: "dotenv" } }, roots: [realpathSync(s.dir)], realExecutablePath: realExecutable });
	assert.ok(inside.every((c) => c.ok), JSON.stringify(inside));
});

test("a bundle whose project holds a folder is a warning", async () => {
	const s = script();
	const checks = await secretBundleChecks({ bundles: { tools: { profile: "p", ref: "shop", project: "tools" } }, projects, envRaw: `p:${s.path}:dotenv` });
	const warn = checks.find((c) => c.warn === true);
	assert.ok(warn && warn.ok === true, JSON.stringify(checks));
	assert.match(warn.label, /holds 1 folder/);
});

test("--secrets resolves each bundle here and prints its names and count, never a value", async () => {
	const s = script();
	const resolver = makeBundleResolver({ envBundles: { p: { path: s.path, format: "dotenv" } } });
	const checks = await secretBundleChecks({
		bundles: { shop: { profile: "p", ref: "shop", project: "shop" }, wrong: { profile: "p", ref: "absent", project: "tools" } },
		projects,
		envRaw: `p:${s.path}:dotenv`,
		resolveBundle: (binding) => resolver.resolve({ provider: "anthropic" }, binding),
	});
	assert.ok(checks.some((c) => c.ok && c.label === "secret bundle shop resolved on this host: 2 variable(s): DB_URL, STRIPE_KEY"));
	assert.ok(checks.some((c) => !c.ok && /secret bundle wrong's resolver was refused \(exit/.test(c.label)));
	assert.ok(!JSON.stringify(checks).includes("sk_live_doctor_value") && !JSON.stringify(checks).includes("postgres://x"));
});

test("silent on a deployment with no bundle and no bundle profile", async () => {
	assert.deepEqual(await secretBundleChecks({ bundles: {}, envRaw: undefined }), []);
});
