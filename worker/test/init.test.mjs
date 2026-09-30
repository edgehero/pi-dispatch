import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGED_EGRESS_PROXY_CONF, runInit } from "../src/init.mjs";
import { loadModelEndpoints, renderEndpointsInclude } from "../src/model-endpoints.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const tmp = () => tempDir("pi-init-");
function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}

test("init scaffolds the config files with the empty templates the loaders validate against", () => {
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
	// Issue #503: the declared model endpoints, empty and versioned, which the worker's own loader reads as none, and the
	// proxy include rendered from them, the header alone (squid starts on it and refuses a missing file).
	assert.equal(readFileSync(join(dir, "model-endpoints.json"), "utf8"), '{\n  "version": 1,\n  "endpoints": []\n}\n');
	assert.deepEqual(loadModelEndpoints({ modelEndpointsFile: null }, { cwd: dir }), [], "the default file loads to no endpoints");
	assert.equal(readFileSync(join(dir, "model-endpoints.conf"), "utf8"), renderEndpointsInclude([]), "the include is exactly the empty render");
	assert.match(text(), /^created\s+model-endpoints\.json\s/m);
	assert.match(text(), /^created\s+model-endpoints\.conf\s/m);
});

test("init keeps an existing model-endpoints.json and model-endpoints.conf byte for byte (#503)", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	const declared = JSON.stringify({ version: 1, endpoints: [{ id: "mac", host: "host.docker.internal", port: 11434, slots: 2 }] });
	writeFileSync(join(dir, "model-endpoints.json"), declared);
	writeFileSync(join(dir, "model-endpoints.conf"), "# mine\n");
	const { out, text } = capture();
	assert.equal(runInit(dir, { out }), 0);
	assert.equal(readFileSync(join(dir, "model-endpoints.json"), "utf8"), declared);
	assert.equal(readFileSync(join(dir, "model-endpoints.conf"), "utf8"), "# mine\n");
	assert.match(text(), /^kept\s+model-endpoints\.json\s+already exists/m);
	assert.match(text(), /^kept\s+model-endpoints\.conf\s+already exists/m);
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

	const code = runInit(dir, { out, newPassword: () => PASSWORD });

	assert.equal(code, 0);
	const packaged = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
	// Issue #468: byte for byte but for the one line init fills in, the deployment's own Valkey password.
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), packaged.replace("\n# VALKEY_PASSWORD=\n", `\nVALKEY_PASSWORD=${PASSWORD}\n`), ".env is the packaged worker/.env.example, byte for byte, with its password");
	assert.match(text(), /created\s+\.env/, "the fallback still reports .env as created");
});

// Issue #468: a new .env carries the deployment's own Valkey password, is readable by this account alone, never shows
// the value, and an existing one is left as it is (init's contract; `up` and `service install` add a missing password).
const PASSWORD = "0f1e2d3c".repeat(8);
test("init writes a new .env at mode 0600 with a generated VALKEY_PASSWORD it never prints, and never touches an existing one (#468)", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n# the password\n# VALKEY_PASSWORD=\n");
	const { out, text } = capture();
	assert.equal(runInit(dir, { out, newPassword: () => PASSWORD }), 0);
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), `ANTHROPIC_API_KEY=\n# the password\nVALKEY_PASSWORD=${PASSWORD}\n`);
	if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600, "readable by this account alone");
	assert.ok(!text().includes(PASSWORD), "the value is never printed");
	assert.match(text(), /created\s+\.env\s+from \.env\.example, mode 0600, with a generated VALKEY_PASSWORD \(value not shown\)/);
	// A second run keeps the file, password and all: init never overwrites.
	assert.equal(runInit(dir, { out: () => {}, newPassword: () => "f".repeat(64) }), 0);
	assert.match(readFileSync(join(dir, ".env"), "utf8"), new RegExp(`^VALKEY_PASSWORD=${PASSWORD}$`, "m"));
	// Every password init can generate reads back the same under every loader of the file (the hex rule, #447's writer).
	const example = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
	assert.match(example, /^# VALKEY_PASSWORD=$/m, "the shipped example carries the commented line init fills in");
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

// What init prints for every venue set that includes `local`. Step 2 was a compose command naming deploy/docker-compose.yml,
// which a folder made by init alone does not have, and it started no egress proxy; it is `pi-dispatch up` since #480.
const DOCKER_NEXT = `
Next:
  1. docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest
                                                        # the prebuilt job image (or build your own from a clone)
  2. pi-dispatch up                                     # Valkey and the egress proxy (unless PI_EGRESS=0)
  3. edit .env                                          # set ANTHROPIC_API_KEY (or your provider's key)
  4. pi-dispatch doctor                                 # verify Docker, Valkey, image, and key
  5. pi-dispatch worker                                 # drain the queue

Operator panel (optional): pi install npm:@edgehero/pi-dispatch-admin   then   /dispatch
  (or let the panel do all of the above: /dispatch setup walks these steps with a consent per action)
`;

// The podman ladder, docs/podman.md "Setup" in the order a fresh folder needs it, linger named up front (gate 456).
const PODMAN_NEXT = `
Next (the podman venue; run these as the worker's own account. First set the account up as the Podman guide's "Setup"
steps 1-4 say (https://github.com/edgehero/pi-dispatch/blob/main/docs/podman.md), linger included:
sudo loginctl enable-linger <account>, without which a job gets no bounds):
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

// --- issue #480: the no-clone folder gets the proxy's rules, and init's output names only what the folder has --------------

test("init in an empty folder scaffolds deploy/egress-proxy.conf, the package's own copy byte for byte, and lists it (#480)", () => {
	// No seeded example and no deploy/: the folder `npx @edgehero/pi-dispatch up` starts from.
	const dir = tmp();
	const { out, text } = capture();
	assert.equal(runInit(dir, { out, newPassword: () => PASSWORD }), 0);
	const packaged = readFileSync(fileURLToPath(new URL("../deploy/egress-proxy.conf", import.meta.url)));
	assert.equal(PACKAGED_EGRESS_PROXY_CONF, fileURLToPath(new URL("../deploy/egress-proxy.conf", import.meta.url)), "resolved from the module, as service.mjs resolves its templates");
	assert.deepEqual(readFileSync(join(dir, "deploy", "egress-proxy.conf")), packaged, "the shipped rules, verbatim");
	assert.match(text(), /^created deploy\/egress-proxy\.conf the egress proxy's rules/m);
});

test("init never overwrites an existing deploy/egress-proxy.conf, and reports it kept (#480)", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	mkdirSync(join(dir, "deploy"));
	writeFileSync(join(dir, "deploy", "egress-proxy.conf"), "# a clone's own rules\n");
	const { out, text } = capture();
	assert.equal(runInit(dir, { out, readPackageFile: () => assert.fail("a kept file is never read from the package") }), 0);
	assert.equal(readFileSync(join(dir, "deploy", "egress-proxy.conf"), "utf8"), "# a clone's own rules\n");
	assert.match(text(), /^kept\s+deploy\/egress-proxy\.conf\s+already exists/m);
});

test("init's ladders name no file the folder does not have, docker and podman (#480)", () => {
	for (const [label, opts] of [["docker", {}], ["podman", { env: { PI_BACKENDS: "podman" } }]]) {
		const { text, dir } = nextFor(opts);
		const ladder = text.slice(text.indexOf("\nNext"));
		assert.ok(ladder.length > 5, `${label}: a ladder was printed`);
		// Every token shaped like a relative path or a config file: a word with a slash in it (a registry reference or an npm
		// spec aside, which carry `:`), or a name ending in a config extension, and `.env` itself.
		const named = new Set();
		for (const token of ladder.split(/[\s()`,]+/)) {
			if (!token || token.includes(":") || token.includes("@")) continue;
			if (/^\.?[\w.-]+(\/[\w.-]+)+\/?$/.test(token) || /\.(ya?ml|conf|json|env)$/.test(token) || token === ".env") named.add(token);
		}
		assert.ok(named.has(".env"), `${label}: the scan sees the files a step names: ${[...named]}`);
		for (const file of named) assert.ok(existsSync(join(dir, file)), `${label}: the ladder names ${file}, which init's folder does not have`);
		assert.doesNotMatch(ladder, /docker-compose\.yml|image\/Dockerfile/, label);
	}
});

test("init's file column is as wide as the longest name, so every note starts in one column (#480)", () => {
	const { text } = nextFor({});
	const rows = text.slice(0, text.indexOf("\nNext:")).split("\n").filter(Boolean);
	assert.equal(rows.length, 10, text);
	const starts = new Set(rows.map((row) => row.match(/^\S+\s+\S+\s+/)[0].length));
	assert.equal(starts.size, 1, `every note starts in one column:\n${rows.join("\n")}`);
	assert.ok(rows.some((row) => row.includes("egress-allowlist.conf ")), "the 21-character name is followed by a space before its note");
});

test("init with steps: false prints the file list and no Next ladder (what up passes, #480)", () => {
	for (const venues of [undefined, { localUsed: true, podmanUsed: false, podmanDefault: false }, { localUsed: false, podmanUsed: true, podmanDefault: true }]) {
		const dir = tmp();
		const { out, text } = capture();
		assert.equal(runInit(dir, { out, venues, steps: false, platform: "linux" }), 0);
		assert.match(text(), /^created deploy\/egress-proxy\.conf /m, "the created lines stay");
		assert.doesNotMatch(text(), /Next/, JSON.stringify(venues));
	}
});

// PR #488's review: every scaffold is written create-only (`wx`), so nothing is written through a link out of the folder.
test("init never writes through a dangling symlink: every scaffold is kept, and the link's target is never created (#488)", { skip: process.platform === "win32" }, () => {
	const dir = tmp();
	const outside = tmp();
	mkdirSync(join(dir, "deploy"));
	const names = [".env", "triggers.json", "pause-windows.json", "pi-packages.json", "subscriptions.json", "scoped-limits.json", "model-endpoints.json", "model-endpoints.conf", "egress-allowlist.conf", "deploy/egress-proxy.conf"];
	for (const name of names) symlinkSync(join(outside, name.replace("/", "-")), join(dir, name));
	const { out, text } = capture();
	assert.equal(runInit(dir, { out, newPassword: () => PASSWORD }), 0);
	assert.deepEqual(readdirSync(outside), [], "nothing was written where a link points");
	for (const name of names) {
		assert.ok(lstatSync(join(dir, name)).isSymbolicLink(), `${name} is still the link`);
		assert.match(text(), new RegExp(`^kept\\s+${name.replace(/[./]/g, "\\$&")}\\s+already exists, left untouched$`, "m"), name);
	}
});

test("init refuses a symlinked deploy/, or a deploy/ that is not a directory, and writes nothing into it (#488)", { skip: process.platform === "win32" }, () => {
	for (const shape of ["symlink", "file"]) {
		const dir = tmp();
		const outside = tmp();
		if (shape === "symlink") symlinkSync(outside, join(dir, "deploy"));
		else writeFileSync(join(dir, "deploy"), "not a folder\n");
		const { out, text } = capture();
		assert.equal(runInit(dir, { out, newPassword: () => PASSWORD }), 1, `${shape}: a refused scaffold fails init`);
		assert.deepEqual(readdirSync(outside), [], `${shape}: nothing written where deploy/ points`);
		assert.match(text(), new RegExp(`^refused deploy/egress-proxy\\.conf deploy/ here is ${shape === "symlink" ? "a symlink" : "not a directory"}, so init writes nothing into it`, "m"), shape);
		assert.ok(existsSync(join(dir, "triggers.json")), `${shape}: the other scaffolds are still written`);
		assert.match(text(), /^created triggers\.json /m, `${shape}: and listed, the refusal beside them`);
	}
});

test("init refuses a directory where a scaffold's file belongs, deploy/egress-proxy.conf included, and never calls it kept (#488)", () => {
	const dir = tmp();
	writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
	mkdirSync(join(dir, "deploy", "egress-proxy.conf"), { recursive: true });
	mkdirSync(join(dir, "triggers.json"));
	// Issue #503: the proxy include too. Docker Desktop creates a DIRECTORY for a missing bind source, and squid then
	// reads that path as an empty include with no warning (measured), so the refusal is what names it.
	mkdirSync(join(dir, "model-endpoints.conf"));
	const { out, text } = capture();
	assert.equal(runInit(dir, { out }), 1);
	assert.match(text(), /^refused model-endpoints\.conf\s+model-endpoints\.conf here is a directory, not a file/m);
	assert.match(text(), /^refused deploy\/egress-proxy\.conf deploy\/egress-proxy\.conf here is a directory, not a file: remove it, then run `pi-dispatch init` again$/m);
	assert.match(text(), /^refused triggers\.json\s+triggers\.json here is a directory, not a file/m);
	assert.doesNotMatch(text(), /^kept\s+(deploy\/egress-proxy\.conf|triggers\.json)/m);
	assert.ok(existsSync(join(dir, "pause-windows.json")), "the rest are written");
});

test("a write that throws part way still prints what init already created, then throws (PR #488's final review)", () => {
	const dir = tempDir("init-throw-");
	const lines = [];
	const out = (s) => lines.push(s);
	const eacces = Object.assign(new Error("EACCES: permission denied, open 'deploy/egress-proxy.conf'"), { code: "EACCES" });
	const fs = {
		existsSync, lstatSync, mkdirSync, readFileSync, statSync,
		copyFileSync: () => {},
		writeFileSync: (path, ...rest) => {
			if (String(path).endsWith("egress-proxy.conf")) throw eacces;
			return writeFileSync(path, ...rest);
		},
	};
	assert.throws(() => runInit(dir, { out, fs, steps: false }), /EACCES/);
	const printed = lines.join("");
	for (const name of [".env", "triggers.json", "egress-allowlist.conf"]) assert.match(printed, new RegExp(`created ${name.replace(".", "\\.")}`), printed);
	assert.doesNotMatch(printed, /Next:/);
});
