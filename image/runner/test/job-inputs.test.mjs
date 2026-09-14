import assert from "node:assert/strict";
import { constants } from "node:fs";
import { test } from "node:test";
import { assertJobInputsReadable, assertSessionMountReady, HOME_FORBIDDEN_ROOTS, mountAdvisories, readPrompt } from "../src/config.mjs";

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
