import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VALKEY_IMAGE, valkeyContainerOwner, valkeyDockerRunArgs, valkeyOwnerCheckArgs } from "../src/valkey-auth.mjs";
import { OLDER_VALKEY_IMAGES, olderValkeyImage } from "../src/older-state.mjs";
import { TEMPLATE_PINS } from "../src/service.mjs";

// Issue #761: every Valkey this project starts or ships runs ONE pinned minor, `VALKEY_IMAGE`. A copy that moved alone
// would put the fleet's hosts, CI and the specs' measurements on different Valkeys, and the smoke script's
// `--pull=never` would fail on an image the workflow never pulled.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
// A line that is a comment in YAML, a unit file or a shell step says nothing about what runs.
const codeLines = (text) => text.split("\n").filter((l) => !/^\s*[#;]/.test(l));

test("VALKEY_IMAGE is a Docker Hub valkey minor, never a floating major, a patch or a digest (#761)", () => {
	assert.match(VALKEY_IMAGE, /^valkey\/valkey:\d+\.\d+$/);
	assert.equal(VALKEY_IMAGE, "valkey/valkey:8.1", "moving it is a release with a docs/upgrading.md row and the measurements re-run (valkey-auth.mjs)");
	// The value it replaced is an older image in both spellings, and it is not one itself.
	assert.ok(!OLDER_VALKEY_IMAGES.includes(VALKEY_IMAGE));
	assert.ok(!OLDER_VALKEY_IMAGES.includes(`docker.io/${VALKEY_IMAGE}`));
	assert.equal(olderValkeyImage(VALKEY_IMAGE), null);
	assert.equal(olderValkeyImage(`docker.io/${VALKEY_IMAGE}`), null);
});

test("the compose file and the Quadlet unit, and their published mirrors, name VALKEY_IMAGE on their one image line (#761)", () => {
	for (const dir of ["deploy", "worker/deploy"]) {
		const compose = codeLines(read(`${dir}/docker-compose.yml`));
		const valkeyImages = compose.filter((l) => /^\s*image:\s*\S*valkey/.test(l));
		assert.deepEqual(valkeyImages, [`    image: ${VALKEY_IMAGE}`], `${dir}/docker-compose.yml`);
		// It is the valkey service's own line: the first image line after `  valkey:`.
		const at = compose.indexOf("  valkey:");
		assert.ok(at >= 0);
		assert.equal(compose.slice(at + 1).find((l) => /^\s*image:/.test(l)), `    image: ${VALKEY_IMAGE}`);
		const quadlet = codeLines(read(`${dir}/pi-dispatch-valkey.container`));
		assert.deepEqual(quadlet.filter((l) => /^\s*Image\s*=/.test(l)), [`Image=docker.io/${VALKEY_IMAGE}`], `${dir}/pi-dispatch-valkey.container`);
	}
	// service install refuses to render a unit whose pinned lines moved (service.test.mjs reads them back).
	assert.ok(TEMPLATE_PINS["pi-dispatch-valkey.container"].includes(`Image=docker.io/${VALKEY_IMAGE}`));
});

test("up's docker run and the owner check run VALKEY_IMAGE (#761)", () => {
	const run = valkeyDockerRunArgs({ port: 6380, deployment: "/d" });
	assert.equal(run[run.indexOf("sh") - 1], VALKEY_IMAGE);
	assert.equal(run.filter((a) => /valkey\/valkey/.test(a)).length, 1);
	const check = valkeyOwnerCheckArgs("/d");
	assert.equal(check[check.indexOf("valkey-server") - 1], VALKEY_IMAGE);
	assert.equal(check.filter((a) => /valkey\/valkey/.test(a)).length, 1);
});

test("CI's Valkey services name VALKEY_IMAGE, and the smoke script runs the image the workflow pulls by the same constant (#761)", () => {
	const workflows = readdirSync(join(REPO, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
	const images = [];
	for (const file of workflows) {
		const lines = codeLines(read(`.github/workflows/${file}`));
		for (const line of lines) {
			// Every Valkey image a workflow names outside a comment is a service's `image:` equal to the constant.
			if (/valkey\/valkey/.test(line)) {
				images.push(file);
				assert.equal(line.trim(), `image: ${VALKEY_IMAGE}`, `${file}: ${line.trim()}`);
			}
		}
	}
	// Non-vacuous: the three services of pi-upgrade-check.yml (the suite's, the Connections lane's and the image job's
	// gateway) and podman-conformance.yml's one.
	assert.deepEqual(images.sort(), ["pi-upgrade-check.yml", "pi-upgrade-check.yml", "pi-upgrade-check.yml", "podman-conformance.yml"]);
	// The image job pulls what the smoke script then runs with --pull=never, both from the constant, in one step.
	const step = read(".github/workflows/pi-upgrade-check.yml");
	const pull = `docker pull "$(node --input-type=module -e 'import {VALKEY_IMAGE} from "./worker/src/valkey-auth.mjs"; console.log(VALKEY_IMAGE)')"`;
	assert.ok(step.includes(`          ${pull}\n          node .github/scripts/canary-runtime-smoke.mjs "$IMAGE_REF"\n`), "the pull sits right before the smoke script");
	const smoke = read(".github/scripts/canary-runtime-smoke.mjs");
	assert.match(smoke, /^import \{ VALKEY_IMAGE \} from "\.\.\/\.\.\/worker\/src\/valkey-auth\.mjs";$/m);
	assert.match(smoke, /"--pull=never", [^\n]*, VALKEY_IMAGE\]\);/);
	assert.doesNotMatch(smoke, /valkey\/valkey/);
});

// Code without comments, as valkey-clients.test.mjs strips it: a comment that names an image runs nothing.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

test("no source names a Valkey image but valkey-auth.mjs (the constant) and older-state.mjs (the older ones) (#761)", () => {
	const trees = ["worker/src", "receiver/src", "admin/src", "gateway/src", "image/runner", ".github/scripts"];
	const found = [];
	let scanned = 0;
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (!["test", "node_modules", "dist"].includes(name)) walk(p);
			} else if ([".mjs", ".js", ".cjs", ".ts", ".mts"].includes(extname(name))) {
				scanned++;
				const code = stripComments(readFileSync(p, "utf8"));
				const hits = code.match(/["'`](?:docker\.io\/)?valkey\/valkey[:@][^"'`]*["'`]/g) ?? [];
				for (const hit of hits) found.push(`${relative(REPO, p)}: ${hit}`);
			}
		}
	};
	for (const tree of trees) walk(join(REPO, tree));
	assert.ok(scanned > 100, "the scan reads the sources");
	assert.deepEqual(found, [
		`worker/src/older-state.mjs: "valkey/valkey:8"`,
		`worker/src/older-state.mjs: "docker.io/valkey/valkey:8"`,
		`worker/src/valkey-auth.mjs: "${VALKEY_IMAGE}"`,
	]);
});

test("valkeyContainerOwner hands back the container's image as docker recorded it, and nothing when it has none (#761)", async () => {
	const record = (image) => ({ code: 0, stdout: JSON.stringify([{ Name: "/pi-dispatch-valkey", Config: { Labels: { "com.pi-dispatch.deployment": "/d" }, ...(image === undefined ? {} : { Image: image }) } }]), stderr: "" });
	const query = (image) => async () => record(image);
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { dirs: ["/d"], port: 6379, query: query("valkey/valkey:8") }), { ours: true, owner: "the deployment in /d", image: "valkey/valkey:8" });
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { dirs: ["/d"], port: 6379, query: query(undefined) }), { ours: true, owner: "the deployment in /d" });
	assert.deepEqual(await valkeyContainerOwner("pi-dispatch-valkey", { dirs: ["/d"], port: 6379, query: query(42) }), { ours: true, owner: "the deployment in /d" }, "a non-string is no image");
});
