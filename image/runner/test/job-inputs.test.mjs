import assert from "node:assert/strict";
import { constants } from "node:fs";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assertJobInputsReadable, assertPackagePathsExist, assertSessionMountReady, HOME_FORBIDDEN_ROOTS, mountAdvisories, readPrompt } from "../src/config.mjs";

// Issue #341. Every collaborator is injected: the faults under test are uid faults, which a test running as its
// own file owner cannot produce with a real filesystem, and a chmod is ignored by root.
const codes = (map) => (path) => (Object.hasOwn(map, path) ? map[path] : null);
const errno = (code) => Object.assign(new Error(code), { code });

test("an untraversable /job refuses pre-spend with its own reason and the uid, for EACCES and EPERM", () => {
	for (const code of ["EACCES", "EPERM"]) {
		assert.throws(
			() => assertJobInputsReadable("/job", { accessCode: codes({ "/job": code }), uid: 1234 }),
			(e) => e.piDispatchExit === 2 && e.piDispatchReason === "job-inputs-unreadable" && /uid 1234/.test(e.message) && /\/job/.test(e.message),
			`${code} is the uid fault #341 is about, and it must not read as a missing input`,
		);
	}
});

test("the /job check asks for read AND traverse, and passes an allowed, an absent, or an unexpected answer", () => {
	let asked = null;
	assertJobInputsReadable("/job", { accessCode: (_p, mode) => ((asked = mode), null) });
	assert.equal(asked, constants.R_OK | constants.X_OK, "a dir readable but not traversable still hides prompt.md and the trigger skills");
	assert.doesNotThrow(() => assertJobInputsReadable("/job", { accessCode: codes({ "/job": "ENOENT" }) }), "an absent /job is the prompt read's fault to name");
	assert.doesNotThrow(() => assertJobInputsReadable("/job", { accessCode: codes({ "/job": "EIO" }) }), "only the two denial codes refuse");
});

test("the job-inputs check covers the operator overlay too, and an absent overlay is simply not configured", () => {
	assert.throws(
		() => assertJobInputsReadable(["/job", "/opt/pi-global"], { accessCode: codes({ "/opt/pi-global": "EACCES" }), uid: 1234 }),
		(e) => e.piDispatchReason === "job-inputs-unreadable" && /\/opt\/pi-global/.test(e.message),
		"the loader existsSync-gates the overlay, so an untraversable one would drop its models and skills silently",
	);
	assert.doesNotThrow(() => assertJobInputsReadable(["/job", "/opt/pi-global"], { accessCode: codes({ "/opt/pi-global": "ENOENT" }) }));
});

test("run-job refuses an UNREADABLE /workspace pre-spend, and an unwritable one stays advisory (issue #355)", async () => {
	// Measured on Fedora 44 with SELinux enforcing: an operator's local folder not labelled container_file_t is
	// unreadable in the container, and before this the job spent with an agent that could not read its repository.
	// Source pin for the call list (run-job.mjs has no seam to run it in-process), bound to the constant's value so
	// renaming WORKSPACE to another path cannot pass.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const call = src.match(/assertJobInputsReadable\(\[([^\]]*)\]\)/);
	assert.ok(call, "run-job must call assertJobInputsReadable with a literal list");
	assert.ok(call[1].split(",").map((s) => s.trim()).includes("WORKSPACE"), "/workspace must be in the pre-spend readable list");
	const { WORKSPACE } = await import("../src/loader.mjs");
	assert.equal(WORKSPACE, "/workspace");
	// Behaviour of that list: a read denial on /workspace alone refuses and names the path.
	const list = ["/job", "/opt/pi-global", WORKSPACE];
	assert.throws(
		() => assertJobInputsReadable(list, { accessCode: codes({ "/workspace": "EACCES" }), uid: 1234 }),
		(e) => e.piDispatchExit === 2 && e.piDispatchReason === "job-inputs-unreadable" && /: \/workspace$/.test(e.message),
	);
	// Readable but not writable: the read check passes and the advisory still carries it.
	const writeDenied = (path, mode) => (path === "/workspace" && (mode & constants.W_OK) ? "EACCES" : null);
	assert.doesNotThrow(() => assertJobInputsReadable(list, { accessCode: writeDenied }), "a read-only review of an unwritable folder is a legitimate job");
	const advisories = mountAdvisories({ env: { HOME: "/home/pi" }, uid: 1234, accessCode: writeDenied });
	assert.ok(advisories.some(([event, fields]) => event === "workspace_not_writable" && fields.path === "/workspace"));
});

test("a staged package root the job user may not enter is named as unreadable, before existence is asked", () => {
	let existsAsked = false;
	assert.throws(
		() => assertPackagePathsExist(["/opt/pi-global/packages/tools"], {
			accessCode: codes({ "/opt/pi-global/packages/tools": "EACCES" }),
			fileExists: () => ((existsAsked = true), false),
			uid: 1234,
		}),
		(e) => e.piDispatchExit === 2 && e.piDispatchReason === "job-inputs-unreadable" && /not readable by the job user \(uid 1234\)/.test(e.message),
	);
	assert.equal(existsAsked, false, "existsSync answers false for a path it may not look at, which read as never mounted");
});

test("readPrompt names a missing input, an unreadable input, and rethrows anything else", () => {
	assert.equal(readPrompt("/job/prompt.md", { readFile: () => "do the thing" }), "do the thing");
	assert.throws(
		() => readPrompt("/job/prompt.md", { readFile: () => { throw errno("ENOENT"); } }),
		(e) => e.piDispatchExit === 2 && e.piDispatchReason === "config" && /missing job input: \/job\/prompt\.md/.test(e.message),
	);
	assert.throws(
		() => readPrompt("/job/prompt.md", { readFile: () => { throw errno("EACCES"); }, uid: 4242 }),
		(e) => e.piDispatchExit === 2 && e.piDispatchReason === "job-inputs-unreadable" && /uid 4242/.test(e.message),
		"before #341 an existsSync that cannot look reported this as a missing input",
	);
	assert.throws(
		() => readPrompt("/job/prompt.md", { readFile: () => { throw errno("EISDIR"); } }),
		(e) => e.code === "EISDIR" && e.piDispatchExit === undefined,
		"an unexpected fault is not relabelled as either config reason",
	);
});

test("a session dir the job user may not enter is named as such, before existence is even asked", () => {
	let existsAsked = false;
	assert.throws(
		() => assertSessionMountReady("/session/current.jsonl", {
			accessCode: codes({ "/session": "EACCES" }),
			fileExists: () => ((existsAsked = true), false),
			checkWritable: () => {},
			uid: 1234,
		}),
		(e) => e.piDispatchExit === 2 && /not accessible to the job user \(uid 1234\)/.test(e.message) && !/did not land/.test(e.message),
	);
	assert.equal(existsAsked, false, "an existsSync that cannot look answers false, which is the misreport this check exists to prevent");
	assert.throws(
		() => assertSessionMountReady("/session/current.jsonl", { accessCode: codes({}), fileExists: () => false, checkWritable: () => {} }),
		(e) => /did not land/.test(e.message),
		"an accessible dir with no staged file is still the mount-did-not-land fault",
	);
});

test("mountAdvisories is silent for a job that can use everything", () => {
	assert.deepEqual(mountAdvisories({ env: { HOME: "/home/pi" }, uid: 1001, accessCode: codes({}) }), []);
	assert.deepEqual(
		mountAdvisories({ env: { HOME: "/home/pi" }, uid: 1001, accessCode: codes({ "/outbox": "ENOENT" }) }),
		[],
		"a forge job has no /outbox, which is not an advisory",
	);
});

test("mountAdvisories names each unwritable mount and an unwritable HOME, with the code, never content", () => {
	assert.deepEqual(
		mountAdvisories({ env: { HOME: "/" }, uid: 1234, accessCode: codes({ "/workspace": "EACCES", "/outbox": "EROFS", "/": "EACCES" }) }),
		[
			["workspace_not_writable", { path: "/workspace", uid: 1234, code: "EACCES" }],
			["outbox_not_writable", { path: "/outbox", uid: 1234, code: "EROFS" }],
			["home_not_writable", { home: "/", uid: 1234, code: "EACCES" }],
		],
	);
	assert.deepEqual(
		mountAdvisories({ env: {}, uid: 1234, accessCode: codes({}) }),
		[["home_not_writable", { home: null, uid: 1234, code: "UNSET" }]],
	);
	assert.deepEqual(
		mountAdvisories({ env: { HOME: "/home/nobody" }, uid: 1234, accessCode: codes({ "/home/nobody": "ENOENT" }) }),
		[["home_not_writable", { home: "/home/nobody", uid: 1234, code: "ENOENT" }]],
		"a HOME that does not exist cannot be written either",
	);
});

test("a writable HOME with an agent dir pi cannot write is named, and an absent agent dir is not", () => {
	assert.deepEqual(
		mountAdvisories({ env: { HOME: "/home/pi" }, uid: 1001, accessCode: codes({ "/home/pi/.pi/agent": "EACCES" }) }),
		[["agent_dir_not_writable", { path: "/home/pi/.pi/agent", uid: 1001, code: "EACCES" }]],
		"a root-owned ~/.pi/agent is exactly the failure pi's swallowed auth lock hides",
	);
	assert.deepEqual(mountAdvisories({ env: { HOME: "/home/pi/" }, uid: 1001, accessCode: codes({ "/home/pi/.pi/agent": "ENOENT" }) }), []);
});

test("a HOME inside a mount root is named, and a sibling that merely shares a prefix is not", () => {
	// Podman's passwd injection gives a --user with no entry HOME=/workspace (measured), which would put auth.json in
	// the operator's repository.
	for (const home of ["/workspace", "/workspace/.home", "/job", "/outbox/x", "/session"]) {
		const events = mountAdvisories({ env: { HOME: home }, uid: 1234, accessCode: codes({}) }).map(([e]) => e);
		assert.deepEqual(events, ["home_under_mount"], home);
	}
	for (const home of ["/workspaces", "/jobs/home", "/home/pi"]) {
		assert.deepEqual(mountAdvisories({ env: { HOME: home }, uid: 1234, accessCode: codes({}) }), [], home);
	}
});

test("the forbidden HOME roots are exactly the four job mounts", () => {
	assert.deepEqual([...HOME_FORBIDDEN_ROOTS], ["/workspace", "/job", "/outbox", "/session"]);
	assert.ok(Object.isFrozen(HOME_FORBIDDEN_ROOTS));
});

test("INT-RUNNER-EXIT-CODE-PROTOCOL names the reason and every advisory event the runner emits", () => {
	// The spec table is hand-written, so it is pinned against the code's own names: an advisory renamed in one place
	// and not the other leaves an operator grepping for a line that never appears.
	const spec = readFileSync(new URL("../../../specs/interfaces.md", import.meta.url), "utf8");
	const src = readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");
	const events = [...src.matchAll(/"([a-z]+(?:_[a-z]+)+)"\]/g)].map((m) => m[1]).concat([...src.matchAll(/push\(\["([a-z_]+)"/g)].map((m) => m[1]));
	const names = [...new Set(events)].sort();
	assert.deepEqual(names, ["agent_dir_not_writable", "home_not_writable", "home_under_mount", "outbox_not_writable", "workspace_not_writable"]);
	for (const name of [...names, "job-inputs-unreadable"]) assert.ok(spec.includes(`\`${name}\``), `interfaces.md must name ${name}`);
});
