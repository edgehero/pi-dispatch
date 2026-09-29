// Issue #481 (PR #485 review round 1): the oracle for `EMPTY_READ_AS_UNSET`, doctor's allowlist of keys whose empty
// `.env` value a "read from .env" line may leave out. The first version was a denylist (empty is unset, save HOME), and
// it hid keys whose readers take empty as a value: PI_TRIGGERS_FILE (both processes refuse to start), GITLAB_URL (the
// API base becomes ""), CONTAINER_HOST (podman goes remote). So every worker or receiver key on the list is proven here
// against the REAL loaders, and every CLI key on it is one whose tool's source is cited in doctor.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "../src/config.mjs";
import { loadReceiverConfig } from "../../receiver/src/config.mjs";
import { CLI_SERVICE_KEYS, EMPTY_READ_AS_UNSET, SERVICE_ENV_KEYS } from "../src/doctor.mjs";

// Hermetic filesystem: an absolute path exists and holds an empty triggers list; anything else (the empty string, a
// relative name) does not, which is what a real `existsSync("")` answers.
const fileExists = (p) => typeof p === "string" && isAbsolute(p);
const readFile = (p) => {
	if (!fileExists(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	return '{"triggers":[]}';
};

// One base per branch the loaders take, so a key read only under one forge or one GitHub auth source is read here.
const common = { HOME: "/home/u", PATH: "/usr/bin", ANTHROPIC_API_KEY: "x", WEBHOOK_SECRET: "s", PI_TRIGGERS_FILE: "/d/triggers.json" };
const BASES = {
	plain: common,
	gitlab: { ...common, GITLAB_TOKEN: "t", GITLAB_URL: "https://gl.example", GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "g" },
	forgejo: { ...common, FORGEJO_TOKEN: "t", FORGEJO_URL: "https://fj.example", FORGEJO_WEBHOOK_SECRET: "f" },
	azure: { ...common, AZURE_TOKEN: "t", AZURE_ORG_URL: "https://dev.azure.com/o", AZURE_WEBHOOK_SECRET: "a", AZURE_WEBHOOK_MODE: "header", AZURE_WEBHOOK_HEADER: "X-A" },
	app: { ...common, GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" },
	pat: { ...common, GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "p" },
};

const outcome = (load, env) => {
	try {
		return { config: load(env) };
	} catch (error) {
		// Only a tagged config refusal is an answer; anything else is this harness failing, and must not read as "same".
		assert.equal(error?.piDispatchConfig, true, `an untagged throw: ${error?.message}`);
		return { refused: true };
	}
};
const worker = (env) => outcome((e) => loadConfig(e, { fileExists }), env);
// `webhookSecret` is dropped where the receiver serves no GitHub, and only there: receiver/src/config.mjs passes it
// through unread in that case ("Nothing reads it in that case"), and its one reader, `makeGitHubHandler` in
// receiver.mjs, is built only when `cfg.servesGithub`. Where it serves GitHub the field is compared as returned.
const receiver = (env) =>
	outcome((e) => {
		const cfg = loadReceiverConfig(e, { readFile, fileExists });
		if (!cfg.servesGithub) delete cfg.webhookSecret;
		return cfg;
	}, env);
const LOADERS = { worker, receiver };
const same = (a, b) => (a.refused === true && b.refused === true) || (a.config !== undefined && b.config !== undefined && isDeepStrictEqual(a.config, b.config));

const without = (env, key) => {
	const { [key]: _drop, ...rest } = env;
	return rest;
};
/** Whether the loaders give the same answer for `key` set to `value` as for it absent, in every base. */
const asAbsent = (key, value) =>
	Object.values(BASES).every((base) => Object.values(LOADERS).every((load) => same(load({ ...without(base, key), [key]: value }), load(without(base, key)))));
/** Whether any loader, in any base, reads `key` at all: some value changes its answer. */
const readByLoaders = (key) =>
	Object.values(BASES).some((base) =>
		Object.values(LOADERS).some((load) => ["zz-probe", "/zz/probe", "7"].some((v) => !same(load({ ...without(base, key), [key]: v }), load(without(base, key))))),
	);

const CLI_KEYS = new Set(Object.values(CLI_SERVICE_KEYS).flat());
// The CLI keys whose tool reads an empty value as unset, each cited in doctor.mjs beside the list. Pinned here so an
// addition is a reviewed claim about a tool's source, not an edit to one table.
const CITED_CLI_KEYS = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE"];
// Read by more than one program, at least one of which takes empty (or a set variable) as a value.
const NEVER_LISTED = ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINERS_STORAGE_CONF", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HOME", "TMPDIR", "TEMP"];

test("the harness bases load, and load the same twice (#481)", () => {
	for (const [name, base] of Object.entries(BASES)) {
		for (const [who, load] of Object.entries(LOADERS)) {
			const a = load(base);
			assert.ok(a.config, `${name}/${who}: the base itself must load, or every comparison is between two refusals`);
			assert.ok(same(a, load(base)), `${name}/${who}: stable`);
		}
	}
});

test("every worker and receiver key on EMPTY_READ_AS_UNSET is read by the real loaders, which answer the same for it empty as absent (#481)", () => {
	for (const [key, rule] of Object.entries(EMPTY_READ_AS_UNSET)) {
		assert.ok(SERVICE_ENV_KEYS.includes(key), `${key}: a key doctor resolves`);
		assert.ok(rule === "empty" || rule === "blank", `${key}: rule`);
		if (CLI_KEYS.has(key)) continue;
		assert.ok(readByLoaders(key), `${key}: no loader reads it, so nothing here proves how its reader takes empty`);
		assert.ok(asAbsent(key, ""), `${key}: empty is not the loaders' unset`);
		// Per value shape: "blank" exactly where the loaders also take whitespace alone as unset.
		assert.equal(rule === "blank", asAbsent(key, "  "), `${key}: "${rule}", but a blank value ${asAbsent(key, "  ") ? "is" : "is not"} the loaders' unset`);
	}
});

test("the CLI keys on EMPTY_READ_AS_UNSET are exactly the cited ones, none of them read by the loaders (#481)", () => {
	const listed = Object.keys(EMPTY_READ_AS_UNSET).filter((k) => CLI_KEYS.has(k));
	assert.deepEqual([...listed].sort(), [...CITED_CLI_KEYS].sort());
	for (const key of listed) {
		assert.equal(EMPTY_READ_AS_UNSET[key], "empty", `${key}: its tool compares with "", it does not trim`);
		assert.ok(!readByLoaders(key), `${key}: a loader reads it too, so the loaders must prove it`);
	}
	for (const key of NEVER_LISTED) assert.ok(!Object.hasOwn(EMPTY_READ_AS_UNSET, key), `${key}: some reader takes empty as a value`);
});

test("the keys the review found hidden are off the list: their empty value is a value (#481)", () => {
	for (const key of ["PI_TRIGGERS_FILE", "GITLAB_URL", "VALKEY_URL", "PI_JOBS_DIR", "GITHUB_AUTH_SOURCE", "GITHUB_PAT_VAR"]) {
		assert.ok(!Object.hasOwn(EMPTY_READ_AS_UNSET, key), key);
		assert.ok(!asAbsent(key, ""), `${key}: the oracle agrees it is a value`);
	}
});
