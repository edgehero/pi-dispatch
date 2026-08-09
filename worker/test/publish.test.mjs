/**
 * The publish contract for the two npm-published services (issue #80): the worker ships as
 * `@edgehero/pi-dispatch` (bin `pi-dispatch`), the receiver as `@edgehero/pi-dispatch-receiver`
 * (bin `pi-dispatch-receiver`).
 *
 * Three families of assertion:
 *   - sync: the package-local copies that make the tarball self-sufficient (worker/.env.example,
 *     worker/deploy/*) are byte-identical to their repo-root originals — the ROOT copies stay the
 *     documented, edited ones; the mirrors only ship.
 *   - manifest: package.json says what publishing needs (name, no private, files, bin, and a caret
 *     range on the receiver's worker dep — `*` cannot resolve from the registry).
 *   - tarball: `npm pack --dry-run --json` (offline — no registry hit) agrees file by file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO_ROOT, "worker");
const RECEIVER_DIR = join(REPO_ROOT, "receiver");

// The deploy templates `pi-dispatch service` renders (see TEMPLATE_PINS in src/service.mjs), the
// wrapper scripts the rendered units invoke, and the compose file the docs point every deployment at
// (an npm install has no repo checkout to read deploy/docker-compose.yml from) — the full set
// worker/deploy must mirror and ship.
const MIRRORED_DEPLOY = [
	"com.pi-dispatch.worker.plist",
	"docker-compose.yml",
	"nssm-install.cmd",
	"receiver.service",
	"worker-env-wrapper.cmd",
	"worker-env-wrapper.sh",
	"worker.service",
];

// Everything the ROOT deploy/ holds: the mirrored set above, plus the one example triggers file that
// stays behind because the receiver's tests read it and the docs point at it. Nothing else belongs here.
// A config file dropped in among the service templates reads as a deployment artifact and is not one --
// the worker resolves triggers.json, pause-windows.json and friends from the DEPLOYMENT folder or an
// explicit env path, never from this directory (issue #104, which is where deploy/pause-windows.json
// sat unread since the day it was added).
const ROOT_DEPLOY = [...MIRRORED_DEPLOY, "triggers.json"].sort();

// npm pack forks a whole npm; generous headroom so a cold cache on CI never flakes the suite.
const PACK_TIMEOUT = { timeout: 120_000 };

// ---------------------------------------------------------------------------------------------------
// sync: the shipped mirrors track their repo-root originals byte for byte
// ---------------------------------------------------------------------------------------------------

test("sync: worker/.env.example is byte-identical to the root .env.example", () => {
	assert.equal(
		readFileSync(join(WORKER_DIR, ".env.example"), "utf8"),
		readFileSync(join(REPO_ROOT, ".env.example"), "utf8"),
		"the ROOT .env.example is the documented, edited copy — after changing it, re-copy it to worker/.env.example (the one npm ships and init falls back to)",
	);
});

test("sync: every worker/deploy template is byte-identical to its root deploy/ twin", () => {
	assert.deepEqual(
		readdirSync(join(WORKER_DIR, "deploy")).sort(),
		MIRRORED_DEPLOY,
		"worker/deploy must hold exactly the templates the service renderer reads plus the shipped compose file — nothing missing, no strays",
	);
	for (const name of MIRRORED_DEPLOY) {
		assert.equal(
			readFileSync(join(WORKER_DIR, "deploy", name), "utf8"),
			readFileSync(join(REPO_ROOT, "deploy", name), "utf8"),
			`worker/deploy/${name} drifted from deploy/${name} — the ROOT deploy/ is the documented source; edit both (copy root over the mirror)`,
		);
	}
});

test("sync: the root deploy/ holds the mirrored templates and the example triggers file, nothing else", () => {
	// The mirror test above enumerates worker/deploy and only INDEXES root deploy/ by name, so a stray
	// under deploy/ is invisible to it — which is how a dead pause-windows.json lived there unread. This
	// is the other direction: a new file here is either a service artifact that belongs in the mirror and
	// the npm tarball, or operator config that belongs in the deployment folder. Adding it to this list
	// is the moment to decide which.
	assert.deepEqual(
		readdirSync(join(REPO_ROOT, "deploy")).sort(),
		ROOT_DEPLOY,
		"an unexpected file under deploy/ — mirror it into worker/deploy (and MIRRORED_DEPLOY) if it ships, or move it out if it is operator config that nothing here reads",
	);
});

// ---------------------------------------------------------------------------------------------------
// manifest: what package.json promises the registry
// ---------------------------------------------------------------------------------------------------

test("worker package.json: scoped name, publishable (no private), files list, unchanged bin", () => {
	const pkg = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8"));
	assert.equal(pkg.name, "@edgehero/pi-dispatch");
	assert.ok(!("private" in pkg), "private:true would make npm publish refuse");
	assert.deepEqual(pkg.files, ["src", ".env.example", "deploy"], "the three things the CLI needs at runtime");
	assert.deepEqual(pkg.bin, { "pi-dispatch": "src/cli.mjs" }, "the bin NAME survives the scope rename");
	assert.ok(pkg.repository?.directory === "worker" && pkg.license === "MIT" && pkg.description && pkg.keywords?.length, "registry metadata present");
});

test("receiver package.json: scoped name, publishable (no private), files list, caret worker range", () => {
	const pkg = JSON.parse(readFileSync(join(RECEIVER_DIR, "package.json"), "utf8"));
	assert.equal(pkg.name, "@edgehero/pi-dispatch-receiver");
	assert.ok(!("private" in pkg), "private:true would make npm publish refuse");
	assert.deepEqual(pkg.files, ["src"]);
	assert.deepEqual(pkg.bin, { "pi-dispatch-receiver": "src/cli.mjs" }, "the bin NAME survives the scope rename");
	assert.ok(!("@pi-dispatch/worker" in (pkg.dependencies ?? {})), "the old workspace dep name must be gone");
	assert.match(
		pkg.dependencies["@edgehero/pi-dispatch"],
		/^\^\d+\.\d+\.\d+$/,
		"the worker dep must be a real caret range: `*` cannot resolve from the registry, while the workspace still links locally because the workspace version satisfies the caret",
	);
	assert.ok(pkg.repository?.directory === "receiver" && pkg.license === "MIT" && pkg.description && pkg.keywords?.length, "registry metadata present");
});

test("receiver's caret worker range actually SATISFIES the in-repo worker version", () => {
	// The test above pins the range's SHAPE and nothing else, which is how this nearly shipped broken:
	// on a 0.x version `^0.1.0` means `>=0.1.0 <0.2.0`, so bumping the worker to 0.2.0 and leaving the
	// range alone resolves an installed receiver against the OLD worker. That matters more here than a
	// stale dependency usually does, because the receiver imports `@edgehero/pi-dispatch/triggers` and
	// runs the shared validator: an old one DROPS unknown `run.*` fields by reconstruction, so a new
	// trigger field would be silently absent on the webhook path with no error anywhere.
	//
	// Hand-rolled rather than pulling in `semver`: the range is asserted to be exactly `^X.Y.Z` above, so
	// the only rule needed is caret's own, and a transitive dev dep is not worth taking for it.
	const range = JSON.parse(readFileSync(join(RECEIVER_DIR, "package.json"), "utf8")).dependencies["@edgehero/pi-dispatch"];
	const worker = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")).version;
	const [ra, rb, rc] = range.slice(1).split(".").map(Number);
	const [wa, wb, wc] = worker.split(".").map(Number);

	assert.equal(wa, ra, `caret pins the left-most non-zero digit: worker ${worker} cannot satisfy ${range}`);
	if (ra === 0) {
		// ^0.Y.Z allows only 0.Y.*, so the MINOR must match exactly.
		assert.equal(wb, rb, `on 0.x, ^${range.slice(1)} means >=0.${rb}.${rc} <0.${rb + 1}.0 -- worker ${worker} is outside it. Bump the receiver's range in the same commit as the worker.`);
		assert.ok(wc >= rc, `worker ${worker} is older than the range floor ${range}`);
	} else {
		assert.ok(wb > rb || (wb === rb && wc >= rc), `worker ${worker} is older than the range floor ${range}`);
	}
});

// ---------------------------------------------------------------------------------------------------
// tarball: npm pack --dry-run --json, the file list npm would actually publish
// ---------------------------------------------------------------------------------------------------

/** The pack report for the package at cwd. --dry-run --json is offline: no tarball, no registry. */
function npmPack(cwd) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("npm", ["pack", "--dry-run", "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let errOut = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (errOut += d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`npm pack --dry-run exited ${code}:\n${errOut}`));
			else resolvePromise(JSON.parse(out)[0]);
		});
	});
}

test("npm pack (worker): ships src, .env.example and every deploy template — and never test/", PACK_TIMEOUT, async () => {
	const report = await npmPack(WORKER_DIR);
	assert.equal(report.name, "@edgehero/pi-dispatch");
	const paths = report.files.map((f) => f.path);
	assert.ok(paths.includes("src/cli.mjs"), "the bin target ships");
	assert.ok(paths.includes("src/service.mjs"), "the service renderer ships");
	assert.ok(paths.includes(".env.example"), "init's packaged fallback ships");
	for (const name of MIRRORED_DEPLOY) {
		assert.ok(paths.includes(`deploy/${name}`), `deploy/${name} must ship — the service renderer reads it from the package`);
	}
	assert.ok(paths.includes("package.json"));
	assert.deepEqual(paths.filter((p) => p.startsWith("test/")), [], "test/ stays out of the tarball");
});

test("npm pack (receiver): ships src (cli.mjs included) — and never test/", PACK_TIMEOUT, async () => {
	const report = await npmPack(RECEIVER_DIR);
	assert.equal(report.name, "@edgehero/pi-dispatch-receiver");
	const paths = report.files.map((f) => f.path);
	assert.ok(paths.includes("src/cli.mjs"), "the bin target ships");
	assert.ok(paths.includes("src/start.mjs"), "the exports target ships");
	assert.ok(paths.includes("package.json"));
	assert.deepEqual(paths.filter((p) => p.startsWith("test/")), [], "test/ stays out of the tarball");
});

// ---------------------------------------------------------------------------------------------------
// drift: the pre-rename specifier must never come back
// ---------------------------------------------------------------------------------------------------

test("drift: the old @pi-dispatch/worker specifier appears nowhere in receiver/src or admin/src", () => {
	const offenders = [];
	for (const dir of [join(RECEIVER_DIR, "src"), join(REPO_ROOT, "admin", "src")]) {
		for (const rel of readdirSync(dir, { recursive: true })) {
			if (!/\.(mjs|ts)$/.test(rel)) continue;
			if (readFileSync(join(dir, rel), "utf8").includes("@pi-dispatch/worker")) offenders.push(join(dir, rel));
		}
	}
	assert.deepEqual(offenders, [], "imports (and comments) must use @edgehero/pi-dispatch — the old name resolves to nothing once installed from the registry");
});
