import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { tempDir } from "./helpers/temp-dir.mjs";
import { SANDBOX_DEPLOYMENT_KEYS, SANDBOX_PREPARATION_KEYS, sandboxDeploymentEnv } from "../src/sandbox-deployment.mjs";
import { createSandboxPreparer, observeSandboxPreparation, planSandboxPreparation } from "../src/sandbox-prepare.mjs";
import { loadConfig } from "../src/config.mjs";
import { loadProjects } from "../src/projects.mjs";
import { loadScopedLimits } from "../src/scoped-limits.mjs";
import { readManifest } from "../src/sandbox-store.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

/**
 * Issue #863: `pi-dispatch sandbox --new ... --deployment <dir>` re-runs itself with only `SANDBOX_DEPLOYMENT_KEYS`
 * from that deployment's `.env`, and the list had none of the files and settings the preparation plans from. A
 * sandbox prepared that way got no project, the default size and the default image, while the deployment's own worker
 * and the console's preview planned it with the project's. These tests prepare through the handoff, and hold the list
 * to what a preparation actually reads.
 */

const AMBIENT = Object.freeze({ HOME: homedir(), PATH: "/usr/bin:/bin", TERM: "xterm-256color" });
const GITHUB = FORGE_KINDS.indexOf("github");
const REQUEST = Object.freeze({ repo: "acme/web", ref: "main", triggerIndex: GITHUB, host: "mini1", pin: true });

/**
 * A deployment folder as `pi-dispatch up` leaves one, with one trigger per forge, a project holding acme/web on every
 * forge, and a size for that project. The triggers file has a name of its own, so a handoff that drops
 * PI_TRIGGERS_FILE cannot quietly read the default `triggers.json` in its place.
 */
function deployment() {
	const dir = fs.realpathSync(tempDir("sandbox-deployment-plan-"));
	fs.chmodSync(dir, 0o700);
	const write = (name, value) => fs.writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
	write("triggers.deploy.json", { triggers: FORGE_KINDS.map((kind) => ({ on: { type: "label", any: ["pi:human"] }, run: { kind, flow: "fix", ...(kind === "azure" ? { repository: "web" } : {}) } })) });
	write("projects.json", { version: 1, projects: [{ id: "web", members: FORGE_KINDS.map((kind) => `${kind}:acme/web`) }] });
	write("limits.json", { version: 3, limits: [{ scope: "project:web", memory: "1536m", cpus: 0.75 }] });
	const settings = {
		PI_WORKER_NAME: "mini1",
		// Relative, as an operator writes them: the service resolves them in its WorkingDirectory, the deployment folder.
		PI_TRIGGERS_FILE: "triggers.deploy.json",
		PI_PROJECTS_FILE: "projects.json",
		PI_SCOPED_LIMITS_FILE: join(dir, "limits.json"),
		PI_JOB_IMAGE: "pi-job:deployment",
		PI_JOB_MEMORY: "6g",
		PI_JOB_CPUS: "3",
		PI_BACKENDS: "local",
		PI_SANDBOX_DIR: join(dir, "sandboxes"),
		PI_JOBS_DIR: join(dir, "jobs"),
		PI_SANDBOX_RETENTION_HOURS: "48",
		PI_EGRESS_PROXY: "deployment-egress",
		PI_MAX_COST_USD: "5",
		// Every forge configured, so each forge's settings are read below. None of them may reach the handoff.
		GITLAB_TOKEN: "glpat-private-not-carried",
		GITLAB_URL: "https://gitlab.example",
		FORGEJO_TOKEN: "forgejo-private-not-carried",
		FORGEJO_URL: "https://forgejo.example",
		AZURE_TOKEN: "azure-private-not-carried",
		AZURE_ORG_URL: "https://dev.azure.com/acme",
	};
	write(".env", Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(""));
	// The service's process: its account's own basics plus every line of the file (`deploy/worker.service`).
	return { dir, serviceEnv: { ...AMBIENT, ...settings } };
}

/** Everything a preparation does outside this process, faked; what it reads from config and env stays real. */
function outside() {
	return {
		// The CLI's own forge factory (`defaultForgeFor`) asks the forge over the network (`gh auth token`, then the API),
		// so it is replaced. It reads `config[kind]` before it does, which `sandboxRemoteUrl` reads below as well.
		forgeFor: async () => ({ auth: { mintToken: async () => "host-only-token" } }),
		resolveRef: async ({ ref }) => ({ fetchRef: ref }),
		clone: async () => ({ sha: "c".repeat(40) }),
		// The real observation, so its config read (the venue floor) is recorded; only the runtime's answers are faked.
		observe: (args) => observeSandboxPreparation({ ...args, inspectImage: async () => ({ ok: true }), decideUser: async () => ({ user: "1001:1001", home: "/home/pi" }), readStore: async () => "/store" }),
	};
}

/** The re-exec runs in the deployment folder (`runDeploymentSandbox`, pinned in sandbox-cli.test.mjs). */
async function inFolder(dir, body) {
	const prev = process.cwd();
	process.chdir(dir);
	try {
		return await body();
	} finally {
		process.chdir(prev);
	}
}

/** The plan the deployment's own worker makes, which is the one the console previews: the service's whole environment. */
function servicePlan(serviceEnv, request) {
	const config = loadConfig(serviceEnv);
	return planSandboxPreparation({ request, config, env: serviceEnv, triggersText: fs.readFileSync(config.triggersFile, "utf8"), projects: loadProjects(config), limits: loadScopedLimits(config) });
}

test("a deployment's triggers file, project size, image and default size reach a preparation made through --deployment", async () => {
	const d = deployment();
	// `preparing`, as sandbox-cli.mjs asks for `--new` alone: an open or attach is handed none of these (sandbox-deployment.test.mjs).
	const handoff = sandboxDeploymentEnv({ dir: d.dir, env: AMBIENT, expectedHost: "mini1", preparing: true });
	assert.equal(handoff.refused, undefined, handoff.message);
	for (const key of ["GITLAB_TOKEN", "GITLAB_URL", "FORGEJO_TOKEN", "AZURE_TOKEN", "PI_MAX_COST_USD"]) assert.equal(handoff.env[key], undefined, `${key} is not sandbox authority and stays out of the handoff`);
	assert.equal(handoff.env.PI_PROJECTS_FILE, "projects.json", "carried as written: the folder the re-exec runs in resolves it");
	await inFolder(d.dir, async () => {
		const own = servicePlan(d.serviceEnv, REQUEST).plan;
		assert.equal(own.project, "web");
		assert.deepEqual(own.size, { memMiB: 1536, cpuCenti: 75, source: "project" });
		assert.equal(own.image, "pi-job:deployment");
		// What `pi-dispatch sandbox --new` does in the re-exec (sandbox-cli.mjs): its config from the handed-over environment.
		const config = loadConfig(handoff.env);
		const prepare = createSandboxPreparer({ config, env: handoff.env, ...outside() });
		// The service's digest rides on the request, as a console preview's does: a plan made otherwise refuses with
		// `sandbox-plan-changed`, which is exactly what #863 would have shown had the two been compared.
		const ready = await prepare({ ...REQUEST, planDigest: own.planDigest });
		assert.equal(ready.refused, undefined, ready.message);
		assert.equal(ready.prepared, true);
		const manifest = readManifest({ sandboxDir: config.sandboxDir, jobId: ready.id });
		assert.deepEqual(manifest.size, own.size, "the project's size, not the built-in 4g and 2");
		assert.equal(manifest.image, "pi-job:deployment", "the deployment's image, not pi-job:latest");
		// A repository in no project gets the deployment's default size, which the handoff carries as well.
		const other = servicePlan(d.serviceEnv, { ...REQUEST, repo: "acme/api" }).plan;
		assert.deepEqual([other.project, other.size], [null, { memMiB: 6144, cpuCenti: 300, source: "env" }]);
		const second = await prepare({ ...REQUEST, repo: "acme/api", planDigest: other.planDigest });
		assert.equal(second.refused, undefined, second.message);
	});
	// Outside the folder the same environment names files that are not there, which is why the re-exec runs in it.
	const elsewhere = createSandboxPreparer({ config: loadConfig(handoff.env), env: handoff.env, ...outside() });
	assert.equal((await elsewhere({ ...REQUEST })).refused, "sandbox-config-invalid");
});

/**
 * HOW A SETTING IS JUDGED. The real preparer runs over the service's whole configuration, once per forge, pinned and
 * not, with `outside()` faked, and a Proxy notes every config field and every environment key it reads. `loadConfig`
 * builds all of its fields at once, so a read of its environment cannot say which field it was for. Instead each key it
 * reads is set to every value in PROBES in turn (and removed) over the same deployment, and the fields that change are
 * the fields that key sets. A key that sets a field the preparation read, or that the preparation read itself, is an
 * input of the plan, and must be carried by the handoff or named in NOT_CARRIED with its reason.
 *
 * WHAT FAILS, AND WHAT DOES NOT. A key that sets no field the preparation reads is not this test's business, and
 * neither is a key whose values PROBES does not hold (a `json|text` setting, a credential that needs another key beside
 * it): setting it changes nothing here, so it passes. What fails is a field the preparation reads that no probe moves,
 * since then a key behind it cannot be judged, and an input that is neither carried nor named. So a field the
 * preparation starts to read fails until its key is decided, whatever values that key takes. Left open: a field already
 * judged through one key that gains a second key no probe moves.
 *
 * WHAT IS OUT OF REACH. The container runtime's own environment (DOCKER_HOST, CONTAINER_HOST, the XDG folders) is read
 * by the docker and podman binaries, not by this code, so no Proxy sees it; sandbox-deployment.test.mjs holds those.
 */
const PROBES = [undefined, "", "0", "1", "2", "48", "2000", "podman", "local,podman", "x", "/probe", "probe.json", "probe:1", "8g", "egress=enforced", "probe:/probe", "probe:/probe:json", "probe/model", "pat", "app", "gh", "https://probe.example"];

/** An input of the plan the handoff deliberately does not carry from the deployment, with why. */
const NOT_CARRIED = {
	TMPDIR: "an OS setting the handoff takes from the launching account (its OS keys), never from the deployment; it places only the default jobs and sandbox folders, which a deployment pins with PI_JOBS_DIR and PI_SANDBOX_DIR",
	TEMP: "TMPDIR's fallback, taken from the launching account for the same reason",
};

/**
 * A key that sets only a forge's own field (`config.github`, `.gitlab`, `.forgejo`, `.azure`: the forge's credential
 * and the address it is sent to) is never carried, and the test fails if one is. #771 made the handoff load sandbox
 * authority only. Without them a GitHub trigger clones with the launching account's own `gh` login, and a GitLab,
 * Forgejo or Azure trigger refuses as `sandbox-forge-unconfigured`; the console's preparation runs in the worker, with
 * the worker's own credential.
 */
const FORGE_FIELDS = new Set(FORGE_KINDS);

/** What a `--new` through `--deployment` is handed from the deployment (`sandboxDeploymentEnv` with `preparing`). */
const CARRIED = new Set([...SANDBOX_DEPLOYMENT_KEYS, ...SANDBOX_PREPARATION_KEYS]);

const watched = (target, into, { own = false } = {}) => new Proxy(target, { get: (t, key) => ((typeof key === "string" && (!own || Object.hasOwn(t, key)) && into.add(key)), t[key]) });

test("every setting a sandbox's preparation reads is carried by the deployment handoff, or named here with its reason", async () => {
	const d = deployment();
	const fields = new Set();
	const direct = new Set();
	await inFolder(d.dir, async () => {
		for (const [index, kind] of FORGE_KINDS.entries()) {
			for (const pin of [true, false]) {
				const prepare = createSandboxPreparer({ config: watched(loadConfig(d.serviceEnv), fields, { own: true }), env: watched(d.serviceEnv, direct), ...outside() });
				const ready = await prepare({ ...REQUEST, triggerIndex: index, pin });
				assert.equal(ready.prepared, true, `${kind}, pin ${pin}: ${ready.message}`);
			}
		}
	});

	const options = { fileExists: () => true };
	const read = new Set();
	const base = loadConfig(watched(d.serviceEnv, read), options);
	const movedBy = (key) => {
		const moved = new Set();
		for (const probe of PROBES) {
			const env = { ...d.serviceEnv, [key]: probe };
			if (probe === undefined) delete env[key];
			let config;
			try { config = loadConfig(env, options); } catch { continue; }
			for (const field of Object.keys(base)) if (!isDeepStrictEqual(config[field], base[field])) moved.add(field);
		}
		return moved;
	};

	const problems = [];
	const inputs = new Map();
	const judged = new Set();
	for (const key of [...new Set([...read, ...direct])].sort()) {
		const decides = [...movedBy(key)].filter((field) => fields.has(field));
		for (const field of decides) judged.add(field);
		if (direct.has(key) || decides.length > 0) inputs.set(key, decides);
	}
	for (const field of [...fields].sort()) {
		if (!judged.has(field)) problems.push(`the preparation reads config.${field}, but no value in PROBES moves it, so the key behind it cannot be judged; add a value that key takes to PROBES`);
	}
	for (const [key, decides] of inputs) {
		const forgeOnly = decides.length > 0 && decides.every((field) => FORGE_FIELDS.has(field));
		if (forgeOnly && CARRIED.has(key)) problems.push(`${key} sets only the forge's credential or address (${decides.join(", ")}), which the handoff must never carry (#771)`);
		if (!forgeOnly && !CARRIED.has(key) && !Object.hasOwn(NOT_CARRIED, key)) problems.push(`${key} decides ${decides.length ? `config.${decides.join(", config.")}` : "the preparation directly"}; carry it in SANDBOX_PREPARATION_KEYS (SANDBOX_DEPLOYMENT_KEYS if opening a shell reads it too) or name it in NOT_CARRIED with its reason`);
	}
	// The preparation's own list exists for the plan alone, so a key in it the plan no longer reads is stale.
	for (const key of SANDBOX_PREPARATION_KEYS) if (!inputs.has(key)) problems.push(`${key} is in SANDBOX_PREPARATION_KEYS but no preparation reads it; take it out`);
	for (const key of Object.keys(NOT_CARRIED)) {
		if (!inputs.has(key)) problems.push(`${key} is in NOT_CARRIED but the preparation no longer reads it; take it out`);
		if (CARRIED.has(key)) problems.push(`${key} is both carried and named as not carried`);
	}
	assert.deepEqual(problems, []);

	// Not vacuous: the forge rule had forge keys to judge.
	assert.ok([...inputs].some(([, decides]) => decides.includes("gitlab")), "a forge's own settings were judged");

	// docs/sandbox.md tells an operator which of the deployment's settings `--new --deployment` reads. That list is the
	// carried inputs, both ways, so a new input carried here is named there too.
	const docs = fs.readFileSync(new URL("../../docs/sandbox.md", import.meta.url), "utf8");
	const marker = "`--new` reads these settings from that deployment, as its worker does:";
	const at = docs.indexOf(marker);
	assert.ok(at > 0, "docs/sandbox.md lists what --new reads through --deployment");
	const named = [...docs.slice(at, docs.indexOf(".", at + marker.length)).matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]).sort();
	assert.deepEqual(named, [...inputs.keys()].filter((key) => CARRIED.has(key)).sort());

	// NOT_CARRIED's reason is a claim about the handoff, so check it: the account's temp root comes from its own shell.
	const handoff = sandboxDeploymentEnv({ dir: d.dir, env: { ...AMBIENT, TMPDIR: "/account/tmp", TEMP: "/account/temp" }, expectedHost: "mini1", preparing: true });
	assert.deepEqual([handoff.env?.TMPDIR, handoff.env?.TEMP], ["/account/tmp", "/account/temp"], handoff.message);
});
