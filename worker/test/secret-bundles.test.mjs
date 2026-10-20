// Project secret bundles (issue #704): the declaration parsers, the strict output parsers, the resolver against a real
// file-backed script, the merge, the triggers-file validator and the worker's own read of the binding.
import assert from "node:assert/strict";
import { chmodSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readOverlay, resolveSettings } from "../src/runtime-settings.mjs";
import { MAX_BUNDLE_BYTES, makeBundleResolver, mergeBundleSecrets, parseBundleOutput } from "../src/secret-bundles.mjs";
import { parseSecretBundleProfiles } from "../src/secret-profiles.mjs";
import { MAX_SECRET_BYTES } from "../src/secrets.mjs";
import { SECRET_BUNDLE_VARS_MAX, parseTriggers, parseTriggersDocument } from "../src/triggers.mjs";
import { makeFindSecretBundle } from "../src/triggers-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The operator's resolver, for real: a shell script that prints the bundle file named by its one argument, exits 2 for
// an unknown reference and 1 when a marker says the "manager" is down. The same shape docs/secrets.md Recipe D shows.
function fileBackedResolver() {
	const dir = tempDir("pi-bundles-");
	const script = join(dir, "resolve.sh");
	writeFileSync(script, `#!/bin/sh\n[ -e "${dir}/down" ] && exit 1\n[ -e "${dir}/$1.env" ] || exit 2\nexec cat "${dir}/$1.env"\n`);
	chmodSync(script, 0o755);
	return { dir, script, write: (ref, text) => writeFileSync(join(dir, `${ref}.env`), text), down: () => writeFileSync(join(dir, "down"), ""), up: () => unlinkSync(join(dir, "down")) };
}

const binding = (over = {}) => ({ id: "shop", profile: "shop-env", ref: "shop", project: "shop", ...over });
const job = { kind: "github", repo: "acme/shop", provider: "anthropic" };

test("PI_SECRET_BUNDLES parses name:path:format, keeps a drive letter, and requires the format", () => {
	assert.deepEqual(parseSecretBundleProfiles("shop:/etc/pi/shop.sh:dotenv, op:/etc/pi/op.mjs:json"), { shop: { path: "/etc/pi/shop.sh", format: "dotenv" }, op: { path: "/etc/pi/op.mjs", format: "json" } });
	assert.deepEqual(parseSecretBundleProfiles(""), {});
	assert.throws(() => parseSecretBundleProfiles("shop:/etc/pi/shop.sh"), /must be name:\/absolute\/path:format|must end in :dotenv or :json/);
	assert.throws(() => parseSecretBundleProfiles("shop:/etc/pi/shop.sh:yaml"), /must end in :dotenv or :json/);
	assert.throws(() => parseSecretBundleProfiles("shop:rel/shop.sh:json"), /ABSOLUTE/);
	assert.throws(() => parseSecretBundleProfiles("a:/x:json,a:/y:json"), /twice/);
	assert.equal(loadConfig({ PI_SECRET_BUNDLES: "shop:/etc/pi/shop.sh:dotenv" }).secretBundleProfiles.shop.format, "dotenv");
	assert.deepEqual(loadConfig({}).secretBundleProfiles, {});
});

test("the overlay's secretBundles is validated strictly and rides beside the settings, never inside them", () => {
	const dir = tempDir("pi-overlay-");
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ secretBundles: { shop: { path: "/opt/pi/shop.sh", format: "json" } } }));
	const read = readOverlay(path);
	assert.deepEqual(read.overlay.secretBundles, { shop: { path: "/opt/pi/shop.sh", format: "json" } });
	assert.deepEqual(resolveSettings(loadConfig({}), read).secretBundles, { shop: { path: "/opt/pi/shop.sh", format: "json" } });
	for (const bad of [{ shop: { path: "/x" } }, { shop: { path: "/x", format: "yaml" } }, { shop: { path: "/x", format: "json", fromat: "json" } }, { "a b": { path: "/x", format: "json" } }, ["x"]]) {
		writeFileSync(path, JSON.stringify({ secretBundles: bad }));
		assert.ok(readOverlay(path).invalid, JSON.stringify(bad));
	}
});

test("dotenv is strict: NAME=value lines, blanks and comments, nothing else", () => {
	assert.deepEqual(parseBundleOutput("# shop\nA=1\n\nB=two words = fine\r\n", "dotenv").vars, { A: "1", B: "two words = fine" });
	assert.deepEqual(parseBundleOutput("A=1\nnot a line\n", "dotenv"), { failure: "malformed", line: 2 });
	assert.equal(parseBundleOutput("export A=1", "dotenv").failure, "malformed");
	assert.equal(parseBundleOutput("A = 1", "dotenv").failure, "malformed");
	assert.deepEqual(parseBundleOutput('A="quoted"', "dotenv"), { failure: "quoted", name: "A" });
	assert.deepEqual(parseBundleOutput("A=1\nA=2", "dotenv"), { failure: "duplicate", name: "A" });
	assert.deepEqual(parseBundleOutput("A=", "dotenv"), { failure: "empty-value", name: "A" });
	assert.equal(parseBundleOutput("1A=x", "dotenv").failure, "bad-name");
	assert.equal(parseBundleOutput("__proto__=x", "dotenv").failure, "bad-name");
	assert.equal(parseBundleOutput("# nothing\n", "dotenv").failure, "empty");
	assert.deepEqual(parseBundleOutput("A=1\r\r\n", "dotenv"), { failure: "malformed", line: 1 }, "a second carriage return is no dotenv value");
});

test("json is one object of non-empty strings, a duplicate key refused, never a non-string", () => {
	assert.deepEqual(parseBundleOutput('{"PEM":"-----BEGIN-----\\nabc\\n-----END-----\\n","B":"2"}', "json").vars, { PEM: "-----BEGIN-----\nabc\n-----END-----\n", B: "2" });
	assert.deepEqual(parseBundleOutput('{"A":1}', "json"), { failure: "not-string", name: "A" });
	assert.deepEqual(parseBundleOutput('{"A":{"b":"c"}}', "json"), { failure: "not-string", name: "A" });
	assert.equal(parseBundleOutput('["A"]', "json").failure, "malformed");
	assert.equal(parseBundleOutput("A=1", "json").failure, "malformed");
	assert.deepEqual(parseBundleOutput('{"A":"1","A":"2"}', "json"), { failure: "duplicate", name: "A" });
	assert.deepEqual(parseBundleOutput('{"A":"x\\u0000y"}', "json"), { failure: "nul", name: "A" });
	assert.equal(parseBundleOutput('{"__proto__":"x"}', "json").failure, "bad-name");
	assert.equal(parseBundleOutput("{}", "json").failure, "empty");
	assert.deepEqual(parseBundleOutput('{"A":"1","B":{"k":"1","k":"2"}}', "json"), { failure: "not-string", name: "B" }, "a nested duplicate is a non-string value, not a duplicate variable");
});

test("caps: more than 64 variables and a value over MAX_SECRET_BYTES each refuse", () => {
	const many = Array.from({ length: SECRET_BUNDLE_VARS_MAX + 1 }, (_, i) => `V${i}=x`).join("\n");
	assert.equal(parseBundleOutput(many, "dotenv").failure, "too-many");
	assert.ok(parseBundleOutput(Array.from({ length: SECRET_BUNDLE_VARS_MAX }, (_, i) => `V${i}=x`).join("\n"), "dotenv").vars);
	assert.deepEqual(parseBundleOutput(`BIG=${"x".repeat(MAX_SECRET_BYTES + 1)}`, "dotenv"), { failure: "value-too-large", name: "BIG" });
});

test("a file-backed bundle resolves, and an added variable reaches the next read while a removed one is gone", async () => {
	const r = fileBackedResolver();
	const resolver = makeBundleResolver({ envBundles: { "shop-env": { path: r.script, format: "dotenv" } } });
	r.write("shop", "STRIPE_KEY=sk_one\nDB_URL=postgres://x\n");
	assert.deepEqual(await resolver.resolve(job, binding()), { ok: true, vars: { STRIPE_KEY: "sk_one", DB_URL: "postgres://x" } });
	r.write("shop", "STRIPE_KEY=sk_one\nNEW_FLAG=on\n");
	assert.deepEqual((await resolver.resolve(job, binding())).vars, { STRIPE_KEY: "sk_one", NEW_FLAG: "on" }, "the next read is the current set: DB_URL gone, NEW_FLAG in");
});

test("exit 2 refuses (unresolved), exit 1 retries (unreachable), and neither result carries a value", async () => {
	const r = fileBackedResolver();
	const logs = [];
	const resolver = makeBundleResolver({ envBundles: { "shop-env": { path: r.script, format: "dotenv" } }, log: (event, fields) => logs.push({ event, fields }) });
	const refused = await resolver.resolve(job, binding({ ref: "nope" }));
	assert.equal(refused.unresolved, true);
	assert.equal(refused.code, 2);
	r.write("shop", "A=secret-value\n");
	r.down();
	const down = await resolver.resolve(job, binding());
	assert.equal(down.unreachable, true);
	assert.equal(down.code, 1);
	r.up();
	assert.ok(!JSON.stringify(logs).includes("secret-value") && !JSON.stringify(logs).includes(r.script), "logs name no value and no path");
});

test("output over 256 KiB in all refuses, never truncated", async () => {
	const r = fileBackedResolver();
	const resolver = makeBundleResolver({ envBundles: { "shop-env": { path: r.script, format: "dotenv" } } });
	const line = `V=${"x".repeat(1000)}\n`;
	r.write("shop", Array.from({ length: Math.ceil(MAX_BUNDLE_BYTES / line.length) + 1 }, (_, i) => line.replace("V=", `V${i}=`)).join(""));
	const read = await resolver.resolve(job, binding());
	assert.equal(read.unresolved, true);
	assert.equal(read.failure, "overflow");
});

test("a reserved name refuses naming the variable: the static set, the job's provider key and PI_FORWARD_ENV", async () => {
	const r = fileBackedResolver();
	const resolver = makeBundleResolver({ envBundles: { "shop-env": { path: r.script, format: "dotenv" } }, forwardEnv: ["CUSTOM_KEY"] });
	for (const name of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "CUSTOM_KEY", "HOME"]) {
		r.write("shop", `OK=1\n${name}=x\n`);
		assert.deepEqual(await resolver.resolve(job, binding()), { reserved: name }, name);
	}
	// Bundle-only: the loader and steering names an unreviewed environment may not carry.
	for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "BASH_ENV", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "PYTHONPATH", "RUBYOPT"]) {
		r.write("shop", `${name}=x\n`);
		assert.deepEqual(await resolver.resolve(job, binding()), { reserved: name }, name);
	}
	r.write("shop", "OPENAI_API_KEY=x\n");
	assert.equal((await resolver.resolve(job, binding())).ok, true, "another provider's key is the project's own business, as for run.secrets");
});

test("the profile lookup: unknown, ambiguous, and an overlay path outside the roots", async () => {
	const r = fileBackedResolver();
	const env = { "shop-env": { path: r.script, format: "dotenv" } };
	const resolver = makeBundleResolver({ envBundles: env, roots: [] });
	assert.deepEqual(resolver.lookup("other"), { profileUnknown: "other" });
	assert.deepEqual(resolver.lookup("toString"), { profileUnknown: "toString" });
	assert.deepEqual(resolver.lookup("shop-env", { overlayBundles: env }), { ambiguous: "shop-env" });
	assert.deepEqual(makeBundleResolver({ roots: [] }).lookup("p", { overlayBundles: { p: { path: r.script, format: "json" } } }), { profileUnknown: "p" });
	assert.equal(makeBundleResolver({ roots: [realpathSync(r.dir)] }).lookup("p", { overlayBundles: { p: { path: r.script, format: "json" } } }).ok, true);
});

test("the merge: run.secrets wins a clash, and the shadowed names are returned", () => {
	assert.deepEqual(mergeBundleSecrets({ A: "bundle", B: "bundle" }, { A: "trigger", C: "trigger" }), { secrets: { B: "bundle", A: "trigger", C: "trigger" }, shadowed: ["A"] });
	assert.deepEqual(mergeBundleSecrets({ A: "1" }, {}), { secrets: { A: "1" }, shadowed: [] });
});

const cron = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/shop", flow: "f", task: "t" } };
const doc = (secretBundles, triggers = [cron]) => JSON.stringify({ triggers, ...(secretBundles !== undefined && { secretBundles }) });

test("the triggers file's secretBundles: shape, strict fields, one bundle per project, ref rules", () => {
	assert.deepEqual(parseTriggersDocument(doc(undefined), "t").secretBundles, {});
	const ok = parseTriggersDocument(doc({ shop: { profile: "shop-env", ref: "env-1", project: "shop", forkReviews: false, endpoints: { STRIPE_KEY: { host: "API.stripe.com", auth: "header:X-Api-Key" } } } }), "t").secretBundles;
	assert.deepEqual(ok, { shop: { profile: "shop-env", ref: "env-1", project: "shop", forkReviews: false, endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "header:X-Api-Key" } } } });
	const refuses = [
		[{ shop: { profile: "p", ref: "r", project: "shop", forkreviews: true } }, /unknown field "forkreviews"/],
		[{ a: { profile: "p", ref: "r", project: "shop" }, b: { profile: "p", ref: "r2", project: "shop" } }, /already bound by bundle "a"/],
		[{ shop: { profile: "p", ref: " r", project: "shop" } }, /whitespace/],
		[{ shop: { profile: "p", ref: "-r", project: "shop" } }, /must not start with "-"/],
		[{ shop: { profile: "p", ref: "", project: "shop" } }, /ref must be a non-empty string/],
		[{ shop: { profile: "p,q", ref: "r", project: "shop" } }, /profile must name/],
		[{ shop: { profile: "p", ref: "r", project: "Shop" } }, /project must be a projects.json id/],
		[{ shop: { profile: "p", ref: "r", project: "shop", forkReviews: "yes" } }, /forkReviews must be true or false/],
		[{ shop: { profile: "p", ref: "r", project: "shop", endpoints: { K: { host: "https://x.com", auth: "bearer" } } } }, /host must be a host name/],
		[{ shop: { profile: "p", ref: "r", project: "shop", endpoints: { K: { host: "x.com", auth: "token" } } } }, /auth must be/],
		[{ shop: { profile: "p", ref: "r", project: "shop", endpoints: { GITHUB_TOKEN: { host: "x.com", auth: "bearer" } } } }, /reserved/],
		[{ "a b": { profile: "p", ref: "r", project: "shop" } }, /bundle id/],
		[{ ["a".repeat(129)]: { profile: "p", ref: "r", project: "shop" } }, /1 to 128/],
		[[], /must be an object/],
	];
	for (const [value, why] of refuses) assert.throws(() => parseTriggersDocument(doc(value), "t"), why, JSON.stringify(value));
	assert.throws(() => parseTriggers(doc({ shop: { profile: "p", ref: "r", project: "shop", extra: 1 } }), "t"), /unknown field/, "parseTriggers refuses the whole file, as every loader does");
});

test("run.secretBundle is accepted on every trigger type, strictly boolean", () => {
	const types = [
		cron,
		{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f" } },
		{ on: { type: "comment", phrase: "/pi" }, run: { kind: "github", flow: "f" } },
		{ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "f" } },
		{ on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "f" } },
	];
	for (const t of types) {
		const parsed = parseTriggers(JSON.stringify({ triggers: [{ ...t, run: { ...t.run, secretBundle: false } }] }), "t");
		assert.equal(parsed[0].run.secretBundle, false, t.on.type);
		assert.throws(() => parseTriggers(JSON.stringify({ triggers: [{ ...t, run: { ...t.run, secretBundle: "false" } }] }), "t"), /run.secretBundle must be true or false/, t.on.type);
	}
});

test("the worker's read: the project's bundle, the live opt-out, a changed trigger, and the last good read", () => {
	const dir = tempDir("pi-trig-");
	const path = join(dir, "triggers.json");
	const bundles = { shop: { profile: "shop-env", ref: "shop", project: "shop" } };
	const pr = { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review" } };
	const logs = [];
	const cronJob = { kind: "local", folder: "/srv/shop", flow: "f", task: "t", trigger: { id: "nightly" } };
	const forgeJob = { kind: "github", flow: "review", trigger: { matched: { index: 1, type: "pull_request" } } };
	// Never read: a broken file has nothing to fall back on, and a job with no project needs none.
	writeFileSync(path, "{ not json");
	const fresh = makeFindSecretBundle({ triggersPath: path, log: (event, fields) => logs.push({ event, fields }) });
	assert.deepEqual(fresh(cronJob, { project: "shop" }), { unreadable: "invalid" });
	assert.deepEqual(fresh(cronJob, { project: null }), { none: true });
	writeFileSync(path, doc(bundles, [cron, pr]));
	const find = makeFindSecretBundle({ triggersPath: path, log: (event, fields) => logs.push({ event, fields }) });
	assert.deepEqual(find(cronJob, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: "cron" });
	assert.deepEqual(find(forgeJob, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: "forge" });
	assert.deepEqual(find(cronJob, { project: "other" }), { none: true });
	assert.deepEqual(find({ kind: "local" }, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: null });
	writeFileSync(path, doc(bundles, [{ ...cron, run: { ...cron.run, secretBundle: false } }, pr]));
	assert.equal(find(cronJob, { project: "shop" }).optedOut, true, "the opt-out is read from the live file");
	writeFileSync(path, doc(bundles, [pr, cron]));
	assert.equal(find(forgeJob, { project: "shop" }).triggerChanged, true, "an index that now holds another trigger is not the job's");
	writeFileSync(path, "{ not json");
	assert.deepEqual(find(cronJob, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: "cron" }, "a broken save is answered from the last good read");
	find(cronJob, { project: "shop" });
	assert.equal(logs.filter((l) => l.event === "secret_bundles_last_good").length, 2, "logged once per failure reason, per finder");
	unlinkSync(path);
	assert.deepEqual(find(cronJob, { project: "shop" }), { none: true }, "a missing file is a good read of no bundles");
});

test("the record's bundle is rebuilt from names only: anything that is not an environment name voids it", async () => {
	const { recordedBundle } = await import("../src/run-history.mjs");
	assert.deepEqual(recordedBundle({ id: "shop", variables: ["B", "A"], shadowed: ["A"], values: { A: "x" } }), { id: "shop", variables: ["A", "B"], shadowed: ["A"] });
	assert.equal(recordedBundle({ id: "shop", variables: ["A=sk_live_value"], shadowed: [] }), null);
	assert.equal(recordedBundle({ id: "shop prod", variables: ["A"] }), null);
	assert.equal(recordedBundle({ id: "shop", variables: Array.from({ length: 65 }, (_, i) => `V${i}`) }), null);
	assert.equal(recordedBundle(null), null);
	// Issue #704 part 3: the OpenShell counts, as a pair of bounded integers or not at all.
	assert.deepEqual(recordedBundle({ id: "shop", variables: ["A", "B"], shadowed: [], placeholders: 1, plain: 1 }), { id: "shop", variables: ["A", "B"], shadowed: [], placeholders: 1, plain: 1 });
	for (const bad of [{ placeholders: 1 }, { placeholders: -1, plain: 1 }, { placeholders: 1.5, plain: 0 }, { placeholders: "1", plain: 1 }, { placeholders: 2, plain: 1 }]) {
		assert.deepEqual(recordedBundle({ id: "shop", variables: ["A", "B"], shadowed: [], ...bad }), { id: "shop", variables: ["A", "B"], shadowed: [] }, JSON.stringify(bad));
	}
});

test("docs/secrets.md's list of names a bundle may not carry is the worker's table, both directions", async () => {
	const { readFileSync } = await import("node:fs");
	const { BUNDLE_LOADER_NAMES, BUNDLE_LOADER_PREFIXES, BUNDLE_LOADER_PREFIXES_ANY_CASE, bundleLoaderName } = await import("../src/secret-bundles.mjs");
	const doc = readFileSync(new URL("../../docs/secrets.md", import.meta.url), "utf8");
	const between = /<!-- bundle-loader-names:start -->([\s\S]*?)<!-- bundle-loader-names:end -->/.exec(doc);
	assert.ok(between, "the markers are there");
	const listed = [...between[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
	const table = [...BUNDLE_LOADER_NAMES, ...BUNDLE_LOADER_PREFIXES.map((p) => `${p.replace(/_$/, "_")}*`), ...BUNDLE_LOADER_PREFIXES_ANY_CASE.map((p) => `${p}*`)].sort();
	assert.deepEqual(listed, table);
	assert.ok(bundleLoaderName("NPM_CONFIG_REGISTRY") && bundleLoaderName("npm_config_registry") && bundleLoaderName("Npm_Config_Script_Shell"), "npm_config_ in any case");
	assert.ok(!bundleLoaderName("STRIPE_KEY") && !bundleLoaderName("DATABASE_URL"));
});

test("a missing triggers file is no bundles on a host that declares none, and a failure on one that declares any", () => {
	const dir = tempDir("pi-trig-missing-");
	const path = join(dir, "triggers.json");
	const job = { kind: "local", folder: "/srv/shop", flow: "f", task: "t", trigger: { id: "nightly" } };
	assert.deepEqual(makeFindSecretBundle({ triggersPath: path })(job, { project: "shop" }), { none: true });
	assert.deepEqual(makeFindSecretBundle({ triggersPath: path, bundlesDeclared: () => true })(job, { project: "shop" }), { unreadable: "absent" });
	// After a good read, a file that goes missing on a declaring host keeps the last good bundles.
	writeFileSync(path, doc({ shop: { profile: "p", ref: "r", project: "shop" } }));
	const find = makeFindSecretBundle({ triggersPath: path, bundlesDeclared: () => true });
	assert.equal(find(job, { project: "shop" }).id, "shop");
	unlinkSync(path);
	assert.equal(find(job, { project: "shop" }).id, "shop");
});

test("a misspelt opt-out or bundle block refuses the file rather than silently granting or ignoring", () => {
	const bundles = { e: { profile: "p", ref: "r", project: "shop" } };
	for (const key of ["secretBundles", "secret_bundle", "secretbundle", "SecretBundle", "secret-bundle", "SECRET_BUNDLES", "secrеtBundle"]) {
		assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [{ ...cron, run: { ...cron.run, [key]: false } }], secretBundles: bundles }), "t"), /did you mean run\.secretBundle/, `run.${key}`);
	}
	for (const key of ["secretBundle", "secret_bundle"]) {
		assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [{ ...cron, on: { ...cron.on, [key]: false } }] }), "t"), /on\..* is not a field/, `on.${key}`);
	}
	for (const key of ["secret_bundles", "SecretBundles", "secretBundle", "secretbundles"]) {
		assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [], [key]: bundles }), "t"), /did you mean "secretBundles"/, key);
	}
	assert.equal(parseTriggersDocument(JSON.stringify({ triggers: [{ ...cron, run: { ...cron.run, secretBundle: false } }], secretBundles: bundles }), "t").triggers[0].run.secretBundle, false, "the exact spellings load");
});
