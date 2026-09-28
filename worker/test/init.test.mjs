import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const tmp = () => tempDir("pi-init-");
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

// --- issue #453: the next steps follow the venue ------------------------------------------------------------------------

// Byte for byte what init printed before #453, and still prints for every venue set that includes `local`.
const DOCKER_NEXT = `
Next:
  1. docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image (or build image/Dockerfile)
  2. docker compose -f deploy/docker-compose.yml up -d  # the durable queue (Valkey)
  3. edit .env                                          # set ANTHROPIC_API_KEY (or your provider's key)
  4. pi-dispatch doctor                                 # verify Docker, Valkey, image, and key
  5. pi-dispatch worker                                 # drain the queue

Operator panel (optional): pi install npm:@edgehero/pi-dispatch-admin   then   /dispatch
  (or let the panel do all of the above: /dispatch setup walks these steps with a consent per action)
`;

// The podman ladder, docs/podman.md "Setup" in the order a fresh folder needs it, linger named up front (gate 456).
const PODMAN_NEXT = `
Next (the podman venue; run these as the worker's own account. First set the account up as docs/podman.md "Setup"
steps 1-4 say, linger included: sudo loginctl enable-linger <account>, without which a job gets no bounds):
  1. podman pull ghcr.io/edgehero/pi-job:latest && podman tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image, in this account's own store
  2. edit .env                                          # PI_BACKENDS=podman, and ANTHROPIC_API_KEY (or your provider's key)
  3. pi-dispatch up                                     # Valkey and the egress proxy as Quadlet units in your user manager
  4. pi-dispatch doctor                                 # verify Podman, Valkey, image, and key
  5. pi-dispatch service install                        # the worker as a user service, after those units (also installs them)
  6. pi-dispatch doctor --live                          # read the bounds, egress and job user back off real containers

Operator panel (optional): pi install npm:@edgehero/pi-dispatch-admin   then   /dispatch
  (or let the panel do all of the above: /dispatch setup walks these steps with a consent per action)
`;

// Off Linux the podman venue refuses the host, so there is no ladder to print.
const PODMAN_OFF_LINUX = `
Next: PI_BACKENDS lists only the podman venue, which runs on Linux alone: on this host the worker refuses it
(podman-platform), so there are no podman steps to run here. Run this deployment on a Linux host, or add \`local\` to
PI_BACKENDS to run jobs on Docker here (then run \`pi-dispatch init\` again for those steps).
`;

function nextFor({ envFile, env, venues, platform = "linux" } = {}) {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile);
	const { out, text } = capture();
	assert.equal(runInit(dir, { out, env, venues, platform }), 0);
	return { text: text(), dir };
}

test("init's next steps: the docker text byte for byte wherever `local` is a venue (#453)", () => {
	for (const [label, opts] of [
		["no env, fresh .env", {}],
		["shell PI_BACKENDS unset, .env without it", { envFile: "ANTHROPIC_API_KEY=\n" }],
		["local,podman in .env", { envFile: "PI_BACKENDS=local,podman\n" }],
		["podman,local in the shell", { env: { PI_BACKENDS: "podman,local" } }],
		["'local, podman' in the shell", { env: { PI_BACKENDS: "local, podman" } }],
		["up's venues", { venues: { localUsed: true, podmanUsed: true, podmanDefault: false }, env: { PI_BACKENDS: "podman" } }],
		["off Linux with local listed", { env: { PI_BACKENDS: "local,podman" }, platform: "darwin" }],
	]) {
		const { text } = nextFor(opts);
		assert.ok(text.endsWith(DOCKER_NEXT), `${label}:\n${text}`);
		assert.doesNotMatch(text, /podman pull/, label);
	}
});

test("init's next steps: the podman ladder when podman is the only venue, from the shell, the .env or up (#453)", () => {
	for (const [label, opts] of [
		["the shell", { env: { PI_BACKENDS: "podman" } }],
		["the shell, spaced", { env: { PI_BACKENDS: " podman " } }],
		["the deployment .env", { envFile: "ANTHROPIC_API_KEY=\nPI_BACKENDS=podman\n" }],
		["the .env with CRLF", { envFile: "PI_BACKENDS=podman\r\n" }],
		["the .env, quoted, which systemd unquotes", { envFile: 'PI_BACKENDS="podman"\n' }],
		["up's venues, whatever the shell says", { venues: { localUsed: false, podmanUsed: true, podmanDefault: true }, env: { PI_BACKENDS: "local" } }],
	]) {
		const { text } = nextFor(opts);
		assert.ok(text.endsWith(PODMAN_NEXT), `${label}:\n${text}`);
		assert.doesNotMatch(text, /docker/, label);
	}
});

test("init decides the venue exactly as up does: a disagreement, a line the loaders read differently, an unknown backend or a non-Linux host get no ladder (#453 gate)", () => {
	// Gate 456's adversary harness: each of these printed the docker ladder silently.
	const conflict = nextFor({ env: { PI_BACKENDS: "local" }, envFile: "PI_BACKENDS=podman\n" });
	assert.match(conflict.text, new RegExp(`\\nNext: which venue this deployment runs is unknown, so no steps are shown: PI_BACKENDS is "local" in this shell and "podman" in ${join(conflict.dir, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\. init's next steps would be for the shell's venue while the service runs the file's\\.`));
	// An empty shell value is a value: it means `local`, which the file's podman contradicts, as up reads it.
	assert.match(nextFor({ env: { PI_BACKENDS: "" }, envFile: "PI_BACKENDS=podman\n" }).text, /\nNext: which venue this deployment runs is unknown, so no steps are shown: PI_BACKENDS is "" in this shell and "podman" in /);
	for (const envFile of ["export PI_BACKENDS=podman\n", "PI_BACKENDS = podman\n", "PI_BACKENDS=podman # venue\n", "PI_BACKENDS=podman, local\n", "PI_BACKENDS=pod\\\nman\n"]) {
		const { text } = nextFor({ envFile });
		assert.match(text, /\nNext: which venue this deployment runs is unknown, so no steps are shown: /, JSON.stringify(envFile));
		assert.doesNotMatch(text, /docker pull|podman pull/, JSON.stringify(envFile));
	}
	for (const env of [{ PI_BACKENDS: "Podman" }, { PI_BACKENDS: '"podman"' }]) {
		const { text } = nextFor({ env });
		assert.match(text, /\nNext: which venue this deployment runs is unknown, so no steps are shown: PI_BACKENDS names an unknown backend/, JSON.stringify(env));
	}
	// Off Linux, podman alone: the venue refuses the host, so no Quadlet steps. The .env is read with that platform's
	// loader, and a line it reads differently is a note, as up says it.
	assert.ok(nextFor({ env: { PI_BACKENDS: "podman" }, platform: "darwin" }).text.endsWith(PODMAN_OFF_LINUX));
	assert.ok(nextFor({ envFile: "PI_BACKENDS=podman\n", platform: "darwin" }).text.endsWith(PODMAN_OFF_LINUX));
});
