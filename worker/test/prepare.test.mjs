import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeForgePreparers, makePrepareWorkspace } from "../src/prepare.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

/** A fresh real jobsDir under os.tmpdir, plus a cleanup fn — mkdtempSync(join(jobsDir,"job-")) needs it real. */
function withJobsDir() {
	const jobsDir = mkdtempSync(join(tmpdir(), "pi-jobs-"));
	return { jobsDir, cleanup: () => rmSync(jobsDir, { recursive: true, force: true }) };
}

test("dispatches a github job to prepareGithub with (job, token, { jobDir, resolveDefaultBranchSha })", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const fakeResolve = async () => ({ sha: "deadbeef" });
		const calls = [];
		const fakeGithub = async (...args) => {
			calls.push(args);
			return { outcome: "ok" };
		};
		let localCalled = false;
		const fakeLocal = async () => {
			localCalled = true;
		};

		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: fakeResolve } }),
			preparers: { github: fakeGithub },
			prepareLocal: fakeLocal,
		});

		const ghJob = { kind: "github", repo: "o/n", flow: "fix", issueNumber: 7 };
		const result = await prepareWorkspace(ghJob, "tok");

		assert.equal(result.outcome, "ok");
		assert.equal(calls.length, 1);
		assert.equal(localCalled, false);

		const [job, token, opts] = calls[0];
		assert.equal(job, ghJob);
		assert.equal(token, "tok");
		assert.equal(typeof opts.jobDir, "string");
		assert.ok(opts.jobDir.startsWith(jobsDir));
		assert.equal(opts.resolveDefaultBranchSha, fakeResolve);
	} finally {
		cleanup();
	}
});

test("dispatches a local job to prepareLocal with { folder, task, jobDir, event }", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const calls = [];
		const fakeLocal = async (arg) => {
			calls.push(arg);
			return { outcome: "ok" };
		};
		let githubCalled = false;
		const fakeGithub = async () => {
			githubCalled = true;
		};

		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
			preparers: { github: fakeGithub },
			prepareLocal: fakeLocal,
		});

		const localJob = { kind: "local", folder: "/some/folder", flow: "tidy", task: "clean up" };
		await prepareWorkspace(localJob, undefined);

		assert.equal(githubCalled, false);
		assert.equal(calls.length, 1);
		const arg = calls[0];
		assert.equal(arg.folder, "/some/folder");
		// Exact composition: flow hint, then the fixed event.json pointer line, then the operator's task.
		assert.equal(
			arg.task,
			'Use the "tidy" skill for this task.\n\nContext about this run -- its trigger and schedule -- is in /job/event.json.\n\nclean up',
		);
		assert.equal(typeof arg.jobDir, "string");
		assert.ok(arg.jobDir.startsWith(jobsDir));
		assert.deepEqual(arg.event, { source: "manual" }, "no trigger, no parentJobId -> a manual run");
	} finally {
		cleanup();
	}
});

// The local-event helper for the cases below: a dispatcher with stubbed local/github preparers and a
// recording findPreviousRun, returning the single prepareLocal arg for a given job + queueJobId.
async function dispatchLocal(jobsDir, job, { queueJobId, findPreviousRun } = {}) {
	const calls = [];
	const prepareWorkspace = makePrepareWorkspace({
		jobsDir,
		forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
		preparers: { github: async () => {} },
		prepareLocal: async (arg) => {
			calls.push(arg);
			return { outcome: "ok" };
		},
		...(findPreviousRun ? { findPreviousRun } : {}),
	});
	await prepareWorkspace(job, undefined, queueJobId === undefined ? {} : { queueJobId });
	assert.equal(calls.length, 1);
	return calls[0];
}

test("a cron job's event carries trigger + scheduledFor + previousRunAt from the repeat jobId", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const lookups = [];
		const findPreviousRun = (arg) => {
			lookups.push(arg);
			return "2026-07-26T03:00:00.000Z";
		};
		const trigger = { id: "t", pattern: "0 3 * * *" };
		const job = { kind: "local", folder: "/some/folder", task: "x", trigger };

		const arg = await dispatchLocal(jobsDir, job, { queueJobId: "repeat:t:1758868620000", findPreviousRun });

		assert.deepEqual(arg.event, {
			source: "cron",
			trigger,
			scheduledFor: new Date(1758868620000).toISOString(),
			previousRunAt: "2026-07-26T03:00:00.000Z",
		});
		assert.deepEqual(lookups, [{ schedulerId: "t", beforeMillis: 1758868620000 }], "the lookup is keyed on the trigger id and the fire instant");
	} finally {
		cleanup();
	}
});

test("a chained child's event is { source: 'chain' } even without a trigger field", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const job = { kind: "local", folder: "/some/folder", task: "x", parentJobId: "local-parent", chainDepth: 1 };
		const arg = await dispatchLocal(jobsDir, job, {});
		assert.deepEqual(arg.event, { source: "chain" });
	} finally {
		cleanup();
	}
});

test("a plain local job's event is { source: 'manual' }", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const arg = await dispatchLocal(jobsDir, { kind: "local", folder: "/some/folder", task: "x" }, {});
		assert.deepEqual(arg.event, { source: "manual" });
	} finally {
		cleanup();
	}
});

test("a cron job with a missing or unparseable queueJobId gets null scheduledFor AND null previousRunAt (lookup skipped)", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const trigger = { id: "t", pattern: "0 3 * * *" };
		const nullEvent = { source: "cron", trigger, scheduledFor: null, previousRunAt: null };
		let looked = false;
		const findPreviousRun = () => {
			looked = true;
			return "2026-07-26T03:00:00.000Z";
		};

		for (const queueJobId of [undefined, "local-abc123", "repeat:t:not-millis"]) {
			const job = { kind: "local", folder: "/some/folder", task: "x", trigger };
			const arg = await dispatchLocal(jobsDir, job, { queueJobId, findPreviousRun });
			assert.deepEqual(arg.event, nullEvent, `queueJobId=${JSON.stringify(queueJobId)} -> nulls, never a guess`);
		}
		assert.equal(looked, false, "an unparseable fire instant skips the history lookup entirely");
	} finally {
		cleanup();
	}
});

test("a command job's prompt is EXACTLY /name args -- no pointer line, no task, no trailing newline", async () => {
	// Issue #189. prepareLocalWorkspace writes `task` to prompt.md verbatim (String(task)), so strict
	// equality here IS the written-bytes pin: a trailing newline would ride into the handler's argument
	// string (everything after the first space is args, verbatim), and the pointer sentence would too.
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const arg = await dispatchLocal(jobsDir, { kind: "local", folder: "/some/folder", command: "wf run nightly" }, {});
		assert.equal(arg.task, "/wf run nightly");
		assert.deepEqual(arg.event, { source: "manual" }, "event.json is untouched -- it is the handler's context channel");
	} finally {
		cleanup();
	}
});

test("a cron command job still gets the full cron event -- the command changes the prompt, never the context", async () => {
	// The handler's data channel is /job/event.json, which is exactly why the prompt may stay bare: the
	// trigger/scheduledFor facts must keep arriving there unchanged.
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const trigger = { id: "t", pattern: "0 3 * * *" };
		const arg = await dispatchLocal(jobsDir, { kind: "local", folder: "/some/folder", command: "wf run", trigger }, { queueJobId: "repeat:t:1758868620000", findPreviousRun: () => null });
		assert.equal(arg.task, "/wf run");
		assert.equal(arg.event.source, "cron");
		assert.deepEqual(arg.event.trigger, trigger);
	} finally {
		cleanup();
	}
});

test("a flow job's prompt composition is byte-identical when the command feature is unused", async () => {
	// The command arm sits FIRST in the ternary, so this pins that an absent command falls through to
	// exactly the flow-hint + pointer + task string the pre-#189 dispatcher built.
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const arg = await dispatchLocal(jobsDir, { kind: "local", folder: "/some/folder", flow: "tidy", task: "clean up" }, {});
		assert.equal(arg.task, 'Use the "tidy" skill for this task.\n\nContext about this run -- its trigger and schedule -- is in /job/event.json.\n\nclean up');
	} finally {
		cleanup();
	}
});

test("throws on an unknown job kind", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "x" }) } }),
			preparers: { github: async () => {} },
			prepareLocal: async () => {},
		});

		await assert.rejects(() => prepareWorkspace({ kind: "banana" }, undefined), /unknown job kind/);
	} finally {
		cleanup();
	}
});

test("makeForgePreparers hands the gitlab arm a GitLab clone URL and the glab envelope", async () => {
	// A gitlab job cloning from github.com is a silent failure: the URL either does not exist, or -- worse
	// -- does, and the job runs against a stranger's repository and reports success.
	const seen = [];
	const preparers = makeForgePreparers({
		gitlabApiUrl: "https://gl.internal",
		prepareForge: async (job, _token, opts) => (seen.push({ kind: job.kind, url: opts.remoteUrlFor?.(job), prompt: opts.buildPrompt }), { ok: true }),
	});

	await preparers.gitlab({ kind: "gitlab", repo: "group/sub/proj", flow: "fix", target: { type: "issue", number: 3 } }, "tok", { jobDir: "/j" });
	assert.equal(seen[0].url, "https://gl.internal/group/sub/proj.git");
	assert.ok(seen[0].prompt({ flow: "fix", target: { type: "issue", number: 3 } }).includes("glab"), "and the envelope must speak glab, not gh");

	// The github arm is the bare preparer: no URL builder and no prompt override, so it keeps its own
	// defaults and stays byte-identical to before the map existed.
	await preparers.github({ kind: "github", repo: "o/r" }, "tok", { jobDir: "/j" });
	assert.equal(seen[1].url, undefined);
	assert.equal(seen[1].prompt, undefined);
});

test("makeForgePreparers hands the forgejo arm a Forgejo clone URL and the tea envelope", async () => {
	// Same silent failure as the gitlab arm: a job cloning from the wrong instance either finds nothing or
	// -- worse -- finds a stranger's repository and reports success against it.
	const seen = [];
	const preparers = makeForgePreparers({
		forgejoApiUrl: "https://fj.internal",
		prepareForge: async (job, _token, opts) => (seen.push({ kind: job.kind, url: opts.remoteUrlFor?.(job), prompt: opts.buildPrompt }), { ok: true }),
	});

	await preparers.forgejo({ kind: "forgejo", repo: "acme/widgets", flow: "fix", target: { type: "issue", number: 3 } }, "tok", { jobDir: "/j" });
	assert.equal(seen[0].url, "https://fj.internal/acme/widgets.git");
	const envelope = seen[0].prompt({ flow: "fix", target: { type: "issue", number: 3 } });
	assert.ok(envelope.includes("tea"), "the envelope must speak tea");
	assert.equal(/\bgh (pr|issue) /.test(envelope), false, "and never gh -- gh implements the GitHub API");
});

test("every forge the table knows has a preparer -- a kind with none throws 'unknown job kind' at run time", async () => {
	// `prepare.mjs` dispatches on `preparers[job.kind]` and throws when there is none. That throw is loud,
	// but it happens INSIDE a job, after the budget slot is taken. Asserting the map covers the table moves
	// the discovery to here.
	const preparers = makeForgePreparers({ prepareForge: async () => ({ ok: true }) });
	for (const kind of FORGE_KINDS) {
		assert.equal(typeof preparers[kind], "function", `${kind}: a forge with no preparer burns a budget slot before it fails`);
	}
});

test("a prepared job carries the stamp cleanup needs to retain it (REQ-RESURRECTABLE-SANDBOX)", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:deployment-default",
			preparers: { github: async (_j, _t, { jobDir }) => ({ jobDir, workspace: join(jobDir, "workspace"), sha: "s" }) },
			forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha: "s" }) } }),
		});

		const plain = await prepareWorkspace({ kind: "github", repo: "a/b" }, "tok", { queueJobId: "gh-7" });
		assert.deepEqual(plain.sandbox, { jobId: "gh-7", kind: "github", image: "pi-job:deployment-default" });

		// A trigger's own run.image wins, resolved through the SAME function the preflight and the runner
		// use -- so the tag that was checked, the tag that ran and the tag a sandbox re-opens are one answer.
		const perTrigger = await prepareWorkspace({ kind: "github", repo: "a/b", image: "pi-job:custom" }, "tok", { queueJobId: "gh-8" });
		assert.equal(perTrigger.sandbox.image, "pi-job:custom");
	} finally {
		cleanup();
	}
});

test("a preparer's policy refusal carries no jobDir, so it is passed through unstamped", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			preparers: { github: async () => ({ outcome: "policy", reason: "sha-gone" }) },
			forgeFor: () => ({ host: {} }),
		});
		const refused = await prepareWorkspace({ kind: "github", repo: "a/b" }, "tok", { queueJobId: "gh-9" });
		// The processor's policy branch reads exactly the object it always did -- no extra key, and nothing
		// that could make a refusal look retainable.
		assert.deepEqual(refused, { outcome: "policy", reason: "sha-gone" });
	} finally {
		cleanup();
	}
});

test("a policy refusal removes the mkdtemp'd jobDir -- it used to leak one per refusal", async () => {
	// Neither teardown path can do it: a refusal carries no jobDir (the test above pins that), and
	// both `cleanup` and `makeCleanup` guard on `prepared?.jobDir`. So the directory created at the
	// top of prepareWorkspace, which by then may hold a partial clone, was simply left behind. True of
	// sha-gone since it shipped, and issue #60 adds cap refusals a misconfigured repo hits on EVERY
	// delivery.
	const { jobsDir, cleanup } = withJobsDir();
	try {
		let seenJobDir = null;
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			preparers: {
				github: async (_job, _token, { jobDir }) => {
					seenJobDir = jobDir;
					assert.equal(existsSync(jobDir), true, "the preparer should be handed a real directory");
					return { outcome: "policy", reason: "pi-too-large" };
				},
			},
			forgeFor: () => ({ host: {} }),
		});
		const refused = await prepareWorkspace({ kind: "github", repo: "a/b" }, "tok", { queueJobId: "gh-9" });
		assert.deepEqual(refused, { outcome: "policy", reason: "pi-too-large" });
		assert.equal(existsSync(seenJobDir), false, "the refused job's directory was left on disk");
	} finally {
		cleanup();
	}
});

test("a local job's policy refusal removes its jobDir too", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		let seenJobDir = null;
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			prepareLocal: async ({ jobDir }) => {
				seenJobDir = jobDir;
				return { outcome: "policy", reason: "pi-too-many-files" };
			},
			preparers: {},
			forgeFor: () => ({ host: {} }),
		});
		const refused = await prepareWorkspace({ kind: "local", folder: "/tmp/x", flow: "tidy", task: "t" }, null, {});
		assert.deepEqual(refused, { outcome: "policy", reason: "pi-too-many-files" });
		assert.equal(existsSync(seenJobDir), false, "the refused local job's directory was left on disk");
	} finally {
		cleanup();
	}
});

test("with retention OFF, cleanup is the rm it always was", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const { makeCleanup } = await import("../src/prepare.mjs");
		const jobDir = mkdtempSync(join(jobsDir, "job-"));
		const prepared = { jobDir, workspace: join(jobDir, "workspace"), sandbox: { jobId: "gh-1", kind: "github", image: "i" } };

		await makeCleanup({ sandboxDir: join(jobsDir, "sandboxes"), retentionHours: 0 })(prepared);
		assert.equal(existsSync(jobDir), false, "the per-job dir is deleted, exactly as before the feature");
		assert.equal(existsSync(join(jobsDir, "sandboxes")), false, "and nothing is retained anywhere");
	} finally {
		cleanup();
	}
});

test("with retention ON, cleanup retains the directory under the sandbox root", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const { makeCleanup } = await import("../src/prepare.mjs");
		const sandboxDir = join(jobsDir, "sandboxes");
		const jobDir = mkdtempSync(join(jobsDir, "job-"));
		mkdirSync(join(jobDir, "workspace"), { recursive: true });
		writeFileSync(join(jobDir, "prompt.md"), "task");
		const prepared = { jobDir, workspace: join(jobDir, "workspace"), sandbox: { jobId: "gh-1", kind: "github", image: "pi-job:latest" } };

		await makeCleanup({ sandboxDir, retentionHours: 24 })(prepared);
		assert.equal(existsSync(jobDir), false, "the original per-job dir is gone -- moved, not copied");
		assert.equal(existsSync(join(sandboxDir, "gh-1", "prompt.md")), true, "the run's /job inputs travelled with it");
		const manifest = JSON.parse(readFileSync(join(sandboxDir, "gh-1", "manifest.json"), "utf8"));
		assert.equal(manifest.workspace, join(sandboxDir, "gh-1", "workspace"), "the workspace path follows the rename");
	} finally {
		cleanup();
	}
});

// --- run.skillsDir injection (issue #60, REQ-PER-TRIGGER-SKILLS) ---

test("a job with run.skillsDir gets jobDir/trigger-skills; one without gets no such directory", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const seen = [];
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			injectSkills: (src, dest) => {
				seen.push({ src, dest });
				mkdirSync(dest, { recursive: true });
				return { dirs: 1, files: 2, bytes: 30, skipped: { symlinks: 0, badNames: 0, nonRegular: 0 } };
			},
			preparers: { github: async (_j, _t, { jobDir }) => ({ jobDir, workspace: join(jobDir, "workspace"), sha: "s" }) },
			forgeFor: () => ({ host: {} }),
		});

		const withDir = await prepareWorkspace({ kind: "github", repo: "a/b", skillsDir: "/srv/skills" }, "tok", {});
		assert.equal(seen.length, 1);
		assert.equal(seen[0].src, "/srv/skills");
		assert.equal(seen[0].dest, join(withDir.jobDir, "trigger-skills"), "the container path's last segment is fixed");
		assert.equal(existsSync(join(withDir.jobDir, "trigger-skills")), true);

		const without = await prepareWorkspace({ kind: "github", repo: "a/b" }, "tok", {});
		assert.equal(seen.length, 1, "a job without run.skillsDir must not call the copier at all");
		assert.equal(existsSync(join(without.jobDir, "trigger-skills")), false);
	} finally {
		cleanup();
	}
});

test("the injection runs for BOTH kinds -- a local job takes the same path a forge job does", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const seen = [];
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			injectSkills: (src, dest) => {
				seen.push(dest);
				mkdirSync(dest, { recursive: true });
				return { dirs: 1, files: 1, bytes: 3, skipped: { symlinks: 0, badNames: 0, nonRegular: 0 } };
			},
			prepareLocal: async ({ jobDir }) => ({ jobDir, workspace: "/f", sha: "s" }),
			preparers: {},
			forgeFor: () => ({ host: {} }),
		});
		await prepareWorkspace({ kind: "local", folder: "/f", flow: "tidy", task: "t", skillsDir: "/srv/skills" }, null, {});
		assert.equal(seen.length, 1, "a cron job must inject too -- the copy site is shared on purpose");
	} finally {
		cleanup();
	}
});

test("a copier refusal is a policy return that removes the jobDir and never reaches the preparer", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		let preparerRan = false;
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			injectSkills: () => ({ refused: "skills-dir-empty" }),
			preparers: {
				github: async () => {
					preparerRan = true;
					return { outcome: "ok" };
				},
			},
			forgeFor: () => ({ host: {} }),
		});
		const refused = await prepareWorkspace({ kind: "github", repo: "a/b", skillsDir: "/srv/skills" }, "tok", {});
		assert.deepEqual(refused, { outcome: "policy", reason: "skills-dir-empty" });
		assert.equal(preparerRan, false, "the clone must not run behind a refused injection");
		assert.deepEqual(readdirSync(jobsDir), [], "the refused job's directory was left on disk");
	} finally {
		cleanup();
	}
});

test("the injection log line carries COUNTS only, never a host path or a skill name", async () => {
	const { jobsDir, cleanup } = withJobsDir();
	try {
		const lines = [];
		const prepareWorkspace = makePrepareWorkspace({
			jobsDir,
			jobImage: "pi-job:latest",
			log: (event, fields) => lines.push({ event, fields }),
			injectSkills: (_src, dest) => {
				mkdirSync(dest, { recursive: true });
				return { dirs: 2, files: 5, bytes: 900, skipped: { symlinks: 1, badNames: 0, nonRegular: 0 } };
			},
			preparers: { github: async (_j, _t, { jobDir }) => ({ jobDir, workspace: "/w", sha: "s" }) },
			forgeFor: () => ({ host: {} }),
		});
		await prepareWorkspace({ kind: "github", repo: "a/b", skillsDir: "/srv/secret-layout/skills" }, "tok", {});
		const line = lines.find((l) => l.event === "trigger_skills_injected");
		assert.deepEqual(line.fields, { dirs: 2, files: 5, bytes: 900 });
		assert.ok(!JSON.stringify(line).includes("secret-layout"), "the log line leaked the host path");
	} finally {
		cleanup();
	}
});
