import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_COMPOSE_FILE, OLDER_VALKEY_IMAGES, VALKEY_CONTAINER, olderStateFindings, olderValkeyContainerFinding, olderValkeyImage, upValkeyContainerImage } from "../src/older-state.mjs";
import { COMPOSE_FILE, COMPOSE_VALKEY_OVERRIDE, VALKEY_IMAGE } from "../src/valkey-auth.mjs";
import { quadletDir } from "../src/podman-stack.mjs";

// Issue #761: `state.older` names state an older release left behind, here the floating `valkey/valkey:8` in the three
// places an upgrade does not rewrite, and fires ONLY on that exact reference: never on an image an operator chose.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CWD = "/srv/My Deploy";
const HOME = "/home/op";
const COMPOSE = join(CWD, COMPOSE_FILE);
const LEGACY = join(CWD, LEGACY_COMPOSE_FILE);
const OVERRIDE = join(CWD, COMPOSE_VALKEY_OVERRIDE);
const QUADLET = join(quadletDir(HOME), "pi-dispatch-valkey.container");

// An in-memory folder: a path absent from `files` reads as a missing file does (ENOENT).
const reader = (files) => (path) => {
	if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
	return files[path];
};
const composeWith = (imageLine) => `services:\n  valkey:\n${imageLine}\n    command: ["sh", "-c", 'x']\n  egress-proxy:\n    image: ubuntu/squid@sha256:${"0".repeat(64)}\n`;
// `valkeyContainer` answers as valkey-auth.mjs's `valkeyContainerOwner` does; `ours` is one this deployment's `up` started.
const findings = (files, valkeyContainer, handedOver = false) => olderStateFindings({ cwd: CWD, home: HOME, readFile: reader(files), valkeyContainer, handedOver });
const ours = (image) => ({ ours: true, owner: `the deployment in ${CWD}`, ...(image === undefined ? {} : { image }) });

test("OLDER_VALKEY_IMAGES is exactly the floating major older releases shipped, in both spellings, and matched exactly (#761)", () => {
	assert.deepEqual([...OLDER_VALKEY_IMAGES], ["valkey/valkey:8", "docker.io/valkey/valkey:8"]);
	assert.ok(Object.isFrozen(OLDER_VALKEY_IMAGES));
	for (const ref of ["valkey/valkey:8", "docker.io/valkey/valkey:8", "  valkey/valkey:8\n"]) assert.equal(olderValkeyImage(ref), ref.trim(), JSON.stringify(ref));
	// `:8\b` would take every one of these: a minor, a variant, a digest-pinned 8, a longer tag, another registry or image.
	for (const ref of [VALKEY_IMAGE, "valkey/valkey:8.1", "valkey/valkey:8.0.2", "valkey/valkey:8-alpine", "valkey/valkey:8@sha256:abc", "valkey/valkey:80", "valkey/valkey:9", "redis:8", "valkey:8", "ghcr.io/valkey/valkey:8", "quay.io/x/valkey/valkey:8", "", null, undefined, 8]) {
		assert.equal(olderValkeyImage(ref), null, JSON.stringify(ref));
	}
});

test("a compose file in the deployment folder naming valkey/valkey:8 is a finding; :8.1, redis:8 and a comment line are not (#761)", async () => {
	for (const line of ["    image: valkey/valkey:8", '    image: "valkey/valkey:8"', "    image: 'docker.io/valkey/valkey:8'  # pulled once", "    image:   valkey/valkey:8\r"]) {
		const got = await findings({ [COMPOSE]: composeWith(line) });
		assert.equal(got.length, 1, line);
		assert.equal(got[0].store, "valkey-compose");
		assert.ok(got[0].label.startsWith(`${COMPOSE} names `), got[0].label);
		assert.match(got[0].label, /valkey\/valkey:8 for Valkey, the floating tag an older pi-dispatch shipped/);
		assert.ok(got[0].label.endsWith(`this release pins ${VALKEY_IMAGE}`));
		assert.ok(got[0].fix.includes(`change that line to \`image: ${VALKEY_IMAGE}\``));
	}
	for (const line of ["    image: valkey/valkey:8.1", "    image: redis:8", "    # image: valkey/valkey:8", "    image: valkey/valkey:8-alpine", "    image: valkey/valkey:8@sha256:abc", "    x-image: valkey/valkey:8", "    image: ${VALKEY_IMAGE:-valkey/valkey:8}"]) {
		assert.deepEqual(await findings({ [COMPOSE]: composeWith(line) }), [], line);
	}
	// The shipped file itself is clean: a folder holding this release's compose file hears nothing.
	assert.deepEqual(await findings({ [COMPOSE]: readFileSync(join(REPO, "deploy", "docker-compose.yml"), "utf8") }), []);
});

test("the compose fix is the command /dispatch setup runs for that folder: its project, and the hand-over override where it wrote one (#761)", async () => {
	const [plain] = await findings({ [COMPOSE]: composeWith("    image: valkey/valkey:8") });
	assert.ok(plain.fix.includes(`recreate Valkey from ${CWD} with \`docker compose -p mydeploy --env-file .env -f deploy/docker-compose.yml up -d valkey\``), plain.fix);
	assert.ok(plain.fix.includes("leave out `-p mydeploy` if you run this file without it"));
	assert.match(plain.fix, /stops it first, so it writes its AOF out, and keeps its volume and the queue in it\. A job running right now is interrupted: pause first/);
	const [handed] = await findings({ [COMPOSE]: composeWith("    image: valkey/valkey:8"), [OVERRIDE]: "services: {}\n" });
	assert.ok(handed.fix.includes("`docker compose -p mydeploy --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.valkey.yml up -d valkey`"), handed.fix);
});

// Where this deployment's `up` runs the Valkey as its own container, compose does not run it: a compose file beside it
// (a /dispatch setup's copy) needs its line changed, and recreating compose's valkey would start a second, empty Valkey
// on compose's own volume, the queue left in the container. Wherever compose runs it, or nothing says who does, the
// recreate stays.
test("beside a container this deployment's up runs, the compose fix changes the line only and recreates nothing (#761)", async () => {
	const compose = { [COMPOSE]: composeWith("    image: valkey/valkey:8") };
	const lineOnly = "change that line to `image: valkey/valkey:8.1` (the installed package's deploy/docker-compose.yml has it) and nothing more: this deployment's Valkey is the pi-dispatch-valkey container `pi-dispatch up` runs, not compose's, so recreating compose's valkey from this file would start a second, empty Valkey beside the queue";
	// Both findings together: the container's fix recreates up's container, the compose file's only changes its line.
	const both = await findings(compose, () => ours("valkey/valkey:8"));
	assert.deepEqual(both.map((f) => f.store), ["valkey-compose", "valkey-container"]);
	assert.equal(both[0].fix, lineOnly);
	assert.doesNotMatch(both[0].fix, /up -d|docker compose/);
	// up's container already on this release's image is still up's: the compose file alone fires, and still recreates nothing.
	const fixed = await findings(compose, async () => ours(VALKEY_IMAGE));
	assert.deepEqual(fixed.map((f) => [f.store, f.fix]), [["valkey-compose", lineOnly]]);
	// Compose alone: the recreate, word for word as before.
	const recreate = "change that line to `image: valkey/valkey:8.1` (the installed package's deploy/docker-compose.yml has it), then recreate Valkey from /srv/My Deploy with `docker compose -p mydeploy --env-file .env -f deploy/docker-compose.yml up -d valkey` (leave out `-p mydeploy` if you run this file without it), which stops it first, so it writes its AOF out, and keeps its volume and the queue in it. A job running right now is interrupted: pause first if one is (pi-dispatch pause, wait for active jobs, then pi-dispatch resume)";
	assert.deepEqual((await findings(compose)).map((f) => f.fix), [recreate]);
	// Compose runs the Valkey (handed over), or doctor cannot tell whose it is: the recreate stays.
	const cannotTell = [
		["absent", () => ({ absent: true }), false],
		["another deployment's", () => ({ ours: false, owner: "the deployment in /srv/a", image: "valkey/valkey:8" }), false],
		["one docker could not describe", () => ({ unknown: "docker container inspect pi-dispatch-valkey exited 1" }), false],
		["a throw", () => { throw new Error("Cannot connect to the Docker daemon"); }, false],
		["handed over to compose", () => ours("valkey/valkey:8"), true],
		["a hand-over that could not be read", () => ours("valkey/valkey:8"), null],
	];
	for (const [what, valkeyContainer, handedOver] of cannotTell) {
		assert.deepEqual((await findings(compose, valkeyContainer, handedOver)).map((f) => f.fix), [recreate], what);
	}
});

test("a merge left unresolved in the valkey service is read through: a conflict between :8 and :8.1 is a finding, either side (#761)", async () => {
	const shipped = readFileSync(join(REPO, "deploy", "docker-compose.yml"), "utf8");
	const conflict = (head, upstream) => {
		const text = shipped.replace(`    image: ${VALKEY_IMAGE}\n`, `<<<<<<< HEAD\n    image: ${head}\n=======\n    image: ${upstream}\n>>>>>>> upstream\n`);
		assert.notEqual(text, shipped, "the shipped file's image line is where the conflict goes");
		return text;
	};
	for (const text of [conflict("valkey/valkey:8", VALKEY_IMAGE), conflict(VALKEY_IMAGE, "valkey/valkey:8")]) {
		const got = await findings({ [COMPOSE]: text, [LEGACY]: text });
		assert.deepEqual(got.map((f) => f.store), ["valkey-compose", "valkey-compose"], text);
		assert.match(got[0].label, / names valkey\/valkey:8 for Valkey/);
	}
	// A conflict between two images neither of which is the older one says nothing.
	assert.deepEqual(await findings({ [COMPOSE]: conflict(VALKEY_IMAGE, "valkey/valkey:8.0") }), []);
	// Outside the service a marker still ends the scan, as any top-level line does: never a false finding.
	assert.deepEqual(await findings({ [COMPOSE]: "services:\n<<<<<<< HEAD\n  valkey:\n    image: valkey/valkey:8\n=======\n>>>>>>> upstream\n" }), []);
});

// git's diff3 and zdiff3 styles (merge.conflictStyle) add the merge base, from a `|||||||` marker to the `=======`.
test("a diff3 or zdiff3 conflict in the valkey service: :8 on either side is a finding, :8 in the merge base alone is none (#761)", async () => {
	const shipped = readFileSync(join(REPO, "deploy", "docker-compose.yml"), "utf8");
	const conflict = (head, base, upstream, baseName = "merged common ancestors") => {
		const text = shipped.replace(`    image: ${VALKEY_IMAGE}\n`, `<<<<<<< HEAD\n    image: ${head}\n||||||| ${baseName}\n${base}=======\n    image: ${upstream}\n>>>>>>> upstream\n`);
		assert.notEqual(text, shipped, "the shipped file's image line is where the conflict goes");
		return text;
	};
	const sides = [
		conflict(VALKEY_IMAGE, "    image: valkey/valkey:8.1-alpine\n", "valkey/valkey:8"),
		conflict("valkey/valkey:8", "    image: valkey/valkey:8.1-alpine\n", VALKEY_IMAGE, "parent of 1a2b3c4 (pin valkey)"),
		// A base whose lines would end the service, read as one: a sibling service's key, and a top-level one.
		conflict(VALKEY_IMAGE, "  cache:\n    image: redis:7\nvolumes: {}\n", "valkey/valkey:8"),
	];
	for (const text of sides) {
		const got = await findings({ [COMPOSE]: text, [LEGACY]: text });
		assert.deepEqual(got.map((f) => f.store), ["valkey-compose", "valkey-compose"], text);
		assert.match(got[0].label, / names valkey\/valkey:8 for Valkey/);
	}
	// The base is neither side: an older line there alone says nothing.
	assert.deepEqual(await findings({ [COMPOSE]: conflict(VALKEY_IMAGE, "    image: valkey/valkey:8\n", "valkey/valkey:8.0") }), []);
	// The same conflict with CRLF line ends.
	assert.equal((await findings({ [COMPOSE]: sides[0].replace(/\n/g, "\r\n") })).length, 1);
});

// Layouts a line scan could misread: each is held to what a YAML reader sees.
test("the compose scan's layouts: a nested valkey key, a column-0 comment, a nested services key and an empty services (#761)", async () => {
	const stores = async (text) => (await findings({ [COMPOSE]: text })).map((f) => f.store);
	// A `valkey:` under another service (depends_on naming it) is not the service; the service after it is.
	assert.deepEqual(await stores("services:\n  receiver:\n    depends_on:\n      valkey:\n        condition: service_healthy\n  valkey:\n    image: valkey/valkey:8\n"), ["valkey-compose"]);
	// A comment at column 0 inside services is no top-level key.
	assert.deepEqual(await stores("services:\n#  cache:\n#    image: redis:7\n  valkey:\n    image: valkey/valkey:8\n"), ["valkey-compose"]);
	// Only the top-level `services:` is the services: one nested under another key is not.
	assert.deepEqual(await stores("x-template:\n  services:\n    valkey:\n      image: valkey/valkey:8\nservices:\n  valkey:\n    image: valkey/valkey:8.1\n"), []);
	// An empty `services:` ends at the next top-level key: a top-level `valkey:` after it is no service.
	assert.deepEqual(await stores("services:\nvalkey:\n  image: valkey/valkey:8\n"), []);
});

test("only the valkey service's own image counts: another service on valkey/valkey:8, a nested image key, or a built valkey is none (#761)", async () => {
	const file = (body) => `name: x\nservices:\n${body}volumes:\n  valkey-data:\n`;
	const none = [
		// A cache an operator added beside the queue, on the older image, after or before the valkey service: their choice.
		`  valkey:\n    image: ${VALKEY_IMAGE}\n  cache:\n    image: valkey/valkey:8\n`,
		`  cache:\n    image: valkey/valkey:8\n  valkey:\n    image: ${VALKEY_IMAGE}\n`,
		// A valkey service built rather than pulled: the next service's image is not its own.
		`  valkey:\n    build: ./valkey\n  cache:\n    image: valkey/valkey:8\n`,
		// A nested map's image key under the valkey service is not the service's.
		`  valkey:\n    x-note:\n      image: valkey/valkey:8\n    image: ${VALKEY_IMAGE}\n`,
		// A service whose name only starts with valkey.
		`  valkey-cache:\n    image: valkey/valkey:8\n`,
	];
	for (const body of none) assert.deepEqual(await findings({ [COMPOSE]: file(body), [LEGACY]: file(body) }), [], body);
	// A top-level key named valkey, outside services, is no service.
	assert.deepEqual(await findings({ [COMPOSE]: `valkey:\n  image: valkey/valkey:8\nservices:\n  valkey:\n    image: ${VALKEY_IMAGE}\n` }), []);
	// The valkey service's own line, wherever it sits among its keys, past a comment and a blank line, after another
	// service, and at whatever indentation the file uses.
	const found = [
		`  cache:\n    image: redis:7\n  valkey:\n    container_name: v\n\n    # pinned below\n    image: valkey/valkey:8\n`,
		`    valkey:\n        labels:\n            image: not-this\n        image: "valkey/valkey:8"   # older\n`,
	];
	for (const body of found) assert.deepEqual((await findings({ [COMPOSE]: file(body) })).map((f) => f.store), ["valkey-compose"], body);
	// The earlier setup's copy at the folder's top is read the same way.
	assert.equal((await findings({ [LEGACY]: file(`  cache:\n    image: valkey/valkey:8\n  valkey:\n    image: valkey/valkey:8\n`) })).length, 1);
	assert.deepEqual(await findings({ [LEGACY]: file(`  valkey:\n    image: ${VALKEY_IMAGE}\n  cache:\n    image: valkey/valkey:8\n`) }), []);
});

test("an earlier setup's copy at the folder's top naming valkey/valkey:8 is its own finding, with the way off it (#761)", async () => {
	const got = await findings({ [LEGACY]: composeWith("    image: valkey/valkey:8") });
	assert.equal(got.length, 1);
	assert.equal(got[0].store, "valkey-compose");
	assert.ok(got[0].label.startsWith(`${LEGACY} names valkey/valkey:8 for Valkey`));
	assert.ok(got[0].fix.startsWith("that file is an earlier /dispatch setup's copy, which setup no longer runs (deploy/docker-compose.yml is the one"), got[0].fix);
	assert.deepEqual(await findings({ [LEGACY]: composeWith("    image: valkey/valkey:8.1") }), []);
});

test("an installed Quadlet unit naming valkey:8 is a finding; :8.1 and a comment are not, and the fix is service install --force (#761)", async () => {
	const unit = (image) => `[Unit]\nDescription=x\n\n[Container]\n${image}\nContainerName=pi-dispatch-valkey\n`;
	for (const line of ["Image=docker.io/valkey/valkey:8", "Image = valkey/valkey:8 "]) {
		const got = await findings({ [QUADLET]: unit(line) });
		assert.equal(got.length, 1, line);
		assert.equal(got[0].store, "valkey-quadlet");
		assert.ok(got[0].label.startsWith(`${QUADLET} runs Valkey as `), got[0].label);
		assert.ok(got[0].label.endsWith(`this release pins docker.io/${VALKEY_IMAGE}`));
		assert.ok(got[0].fix.startsWith("`pi-dispatch service install --force` in the deployment folder rewrites the unit and restarts pi-dispatch-valkey.service on the same pi-dispatch-valkey-data volume"), got[0].fix);
	}
	for (const line of [`Image=docker.io/${VALKEY_IMAGE}`, "#Image=docker.io/valkey/valkey:8", "; Image=docker.io/valkey/valkey:8", "Image=docker.io/library/redis:8"]) {
		assert.deepEqual(await findings({ [QUADLET]: unit(line) }), [], line);
	}
	// The shipped unit is clean, and a unit somewhere else than quadletDir(home) is not read.
	assert.deepEqual(await findings({ [QUADLET]: readFileSync(join(REPO, "deploy", "pi-dispatch-valkey.container"), "utf8") }), []);
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: "/home/other", readFile: reader({ [QUADLET]: unit("Image=docker.io/valkey/valkey:8") }) }), []);
});

test("the pi-dispatch-valkey container: this deployment's own on valkey:8 is a finding; absent, on another image, or unreadable is none (#761)", async () => {
	assert.equal(VALKEY_CONTAINER, "pi-dispatch-valkey");
	for (const answer of ["valkey/valkey:8\n", "docker.io/valkey/valkey:8"]) {
		for (const valkeyContainer of [() => ours(answer), async () => ours(answer)]) {
			const got = await findings({}, valkeyContainer);
			assert.equal(got.length, 1);
			assert.equal(got[0].store, "valkey-container");
			assert.equal(got[0].label, `the pi-dispatch-valkey container runs ${answer.trim()}, the floating tag an older \`pi-dispatch up\` started it with, and keeps it until it is recreated; this release pins ${VALKEY_IMAGE}`);
			// stop then rm (SIGTERM, so the AOF is written), never `rm -f`.
			assert.ok(got[0].fix.startsWith("`docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey && pi-dispatch up` in the deployment folder starts valkey/valkey:8.1 on the same pi-dispatch-valkey-data volume"), got[0].fix);
			assert.doesNotMatch(got[0].fix, /rm -f/);
		}
	}
	const none = [
		["absent", () => ({ absent: true })],
		["no verdict", () => null],
		["this release's", () => ours(`${VALKEY_IMAGE}\n`)],
		["the operator's own", async () => ours("valkey/valkey:8.1-alpine")],
		["no image recorded", () => ours(undefined)],
		["an image that is no string", () => ours(8)],
		["throws", () => { throw new Error("Cannot connect to the Docker daemon"); }],
		["rejects", async () => { throw new Error("exit 1"); }],
		["an image alone", () => "valkey/valkey:8"],
	];
	for (const [what, valkeyContainer] of none) assert.deepEqual(await findings({}, valkeyContainer), [], what);
	assert.deepEqual(await findings({}, undefined), [], "no seam");
	assert.equal(await olderValkeyContainerFinding(), null);
	assert.equal(await olderValkeyContainerFinding({ valkeyContainer: ours("valkey/valkey:8"), handedOver: false }), null, "a value is no seam");
});

// On a shared Docker daemon, or a fleet host whose Valkey is elsewhere, a container named pi-dispatch-valkey may be
// another deployment's, and the container finding's fix stops and removes it; in a folder handed to compose, compose
// runs the Valkey. Neither is named.
test("upValkeyContainerImage, the one rule up and doctor share: a container this deployment's up runs, in a folder not handed to compose (#761)", async () => {
	assert.equal(upValkeyContainerImage(ours("valkey/valkey:8"), { handedOver: false }), "valkey/valkey:8");
	const not = [
		["another deployment's", { ours: false, owner: "the deployment in /srv/a", image: "valkey/valkey:8" }, false],
		["unlabelled, publishing nothing here", { ours: false, owner: "unlabelled, publishing nothing on 127.0.0.1", image: "valkey/valkey:8" }, false],
		["one docker could not describe", { unknown: "docker container inspect pi-dispatch-valkey exited 1" }, false],
		["absent", { absent: true }, false],
		["ours as a truthy non-boolean", { ours: 1, image: "valkey/valkey:8" }, false],
		["handed over to compose", ours("valkey/valkey:8"), true],
		["a hand-over that could not be read", ours("valkey/valkey:8"), null],
		["no hand-over fact", ours("valkey/valkey:8"), undefined],
	];
	for (const [what, owner, handedOver] of not) {
		assert.equal(upValkeyContainerImage(owner, { handedOver }), null, what);
		assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME, readFile: reader({}), valkeyContainer: () => owner, handedOver }), [], what);
	}
	assert.equal(upValkeyContainerImage(undefined), null);
	assert.equal(upValkeyContainerImage(ours("valkey/valkey:8")), null, "no hand-over fact is no finding");
});

test("olderStateFindings never throws: an unreadable file, a missing folder or home, and a bad seam each just say nothing (#761)", async () => {
	const broken = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME, readFile: broken, valkeyContainer: broken, handedOver: false }), []);
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME, readFile: async () => { throw new Error("EIO"); } }), []);
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME, readFile: () => null }), []);
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME, readFile: () => Buffer.from(composeWith("    image: redis:7")) }), []);
	assert.deepEqual(await olderStateFindings({ cwd: CWD, home: HOME }), [], "no read seam");
	assert.deepEqual(await olderStateFindings(), []);
	assert.deepEqual(await olderStateFindings({ cwd: "", home: "", readFile: reader({}) }), []);
	// Bytes are read as text, as a real readFileSync without an encoding gives them.
	assert.equal((await olderStateFindings({ cwd: CWD, readFile: reader({ [COMPOSE]: Buffer.from(composeWith("    image: valkey/valkey:8")) }) })).length, 1);
});

test("every finding at once, in a fixed order, and each line plain text naming the old image and the pinned one (#761)", async () => {
	const got = await findings(
		{ [COMPOSE]: composeWith("    image: valkey/valkey:8"), [LEGACY]: composeWith("    image: valkey/valkey:8"), [QUADLET]: "[Container]\nImage=docker.io/valkey/valkey:8\n" },
		() => ours("valkey/valkey:8\n"),
	);
	assert.deepEqual(got.map((f) => f.store), ["valkey-compose", "valkey-compose", "valkey-quadlet", "valkey-container"]);
	for (const f of got) {
		assert.deepEqual(Object.keys(f).sort(), ["fix", "label", "store"], "the doctor site adds id, ok and warn; the module never sets an id");
		assert.match(f.label, /valkey\/valkey:8\b/);
		assert.ok(`${f.label} ${f.fix}`.includes(VALKEY_IMAGE));
		assert.doesNotMatch(`${f.label}${f.fix}`, /[\u0000-\u001f\u007f\u2013\u2014]/, "one line each, no control byte, no dash");
	}
});
