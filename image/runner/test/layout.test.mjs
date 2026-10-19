import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRunnerEnv } from "../src/config.mjs";
import { DEFAULT_LAYOUT, LAYOUT, LAYOUT_ENV, LAYOUTS, layoutName } from "../src/layout.mjs";

/**
 * Issue #683: the container's file layout is one closed name, `mounts` or `sandbox`, never a path the environment
 * carries. These pin the table, the refusal of a name it does not hold, and that every module reading a path follows it.
 */

const BASE = { PI_PROVIDER: "anthropic", PI_MODEL: "m", PI_MAX_TURNS: "5" };

test("the mounts layout is exactly the paths every runner before issue #683 used", () => {
	assert.deepEqual(LAYOUTS.mounts, { job: "/job", workspace: "/workspace", session: "/session", outbox: "/outbox", inbox: "/inbox", global: "/opt/pi-global" });
	assert.equal(DEFAULT_LAYOUT, "mounts");
	// This test file runs with no PI_JOB_LAYOUT, so the process layout is the default one.
	assert.equal(LAYOUT, LAYOUTS.mounts);
});

test("the sandbox layout puts every path under the image's WORKDIR, and has no inbox", () => {
	for (const [key, path] of Object.entries(LAYOUTS.sandbox)) {
		if (key === "inbox") assert.equal(path, null);
		else assert.match(path, /^\/sandbox\/[a-z-]+$/, key);
	}
	// The session must never sit inside the worktree the agent commits from (parseSessionFile), on either layout.
	for (const layout of Object.values(LAYOUTS)) assert.ok(!layout.session.startsWith(`${layout.workspace}/`));
});

test("a layout name the table does not hold is refused, unset and empty are the default", () => {
	assert.equal(layoutName({}), "mounts");
	assert.equal(layoutName({ [LAYOUT_ENV]: "" }), "mounts");
	assert.equal(layoutName({ [LAYOUT_ENV]: "sandbox" }), "sandbox");
	for (const bad of ["/sandbox", "Sandbox", "mounts ", "toString", "__proto__", "hasOwnProperty"]) {
		assert.equal(layoutName({ [LAYOUT_ENV]: bad }), null, bad);
		assert.throws(() => parseRunnerEnv({ ...BASE, [LAYOUT_ENV]: bad }), (err) => err.piDispatchExit === 2 && /PI_JOB_LAYOUT/.test(err.message), bad);
	}
	assert.equal(parseRunnerEnv({ ...BASE, [LAYOUT_ENV]: "sandbox" }).layout, "sandbox");
	assert.equal(parseRunnerEnv(BASE).layout, "mounts");
});

test("a steered job is refused on the sandbox layout, which has no inbox", () => {
	assert.throws(() => parseRunnerEnv({ ...BASE, [LAYOUT_ENV]: "sandbox", PI_STEER: "1" }), (err) => err.piDispatchExit === 2 && /PI_STEER/.test(err.message));
	assert.equal(parseRunnerEnv({ ...BASE, PI_STEER: "1" }).steer, true);
});

test("every module that names a container path follows the layout the process starts with", () => {
	// A child process, because the paths are read once at import: this process already has the default layout.
	const src = fileURLToPath(new URL("../src/", import.meta.url));
	const script = `
		const packages = await import(${JSON.stringify(`${src}packages.mjs`)});
		const plan = await import(${JSON.stringify(`${src}plan-check.mjs`)});
		const inbox = await import(${JSON.stringify(`${src}inbox.mjs`)});
		const config = await import(${JSON.stringify(`${src}config.mjs`)});
		console.log(JSON.stringify({ skills: packages.PROTECTED_SKILL_ROOTS, outbox: plan.OUTBOX_DIR, snapshot: plan.SNAPSHOT_PATH, inbox: inbox.INBOX_DIR, home: config.HOME_FORBIDDEN_ROOTS }));
	`;
	const read = (layout) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, [LAYOUT_ENV]: layout }, encoding: "utf8" }));
	assert.deepEqual(read("sandbox"), {
		skills: ["/sandbox/job/pi/skills", "/sandbox/job/trigger-skills", "/sandbox/pi-global/skills"],
		outbox: "/sandbox/outbox",
		snapshot: "/sandbox/job/portfolio.json",
		inbox: null,
		home: ["/sandbox/workspace", "/sandbox/job", "/sandbox/outbox", "/sandbox/session"],
	});
	assert.deepEqual(read("mounts"), {
		skills: ["/job/pi/skills", "/job/trigger-skills", "/opt/pi-global/skills"],
		outbox: "/outbox",
		snapshot: "/job/portfolio.json",
		inbox: "/inbox",
		home: ["/workspace", "/job", "/outbox", "/session"],
	});
});
