import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { cloneHostWorkspace, createAskpassHelper, hostCloneEnvironment, HOST_CLONE_FLAGS } from "../src/host-clone.mjs";

const sha = "a".repeat(40);

test("Windows checkout retains absolute drive and UNC Git tool paths without admitting current-directory entries", () => {
	const env = hostCloneEnvironment({ home: "C:\\private\\empty", path: "C:\\Program Files\\Git\\cmd;.;relative;D:\\node;\\\\server\\tools", platform: "win32" });
	assert.equal(env.PATH, "C:\\Program Files\\Git\\cmd;D:\\node;\\\\server\\tools");
	assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
	assert.equal(env.GIT_DIR, undefined);
});

test("clone argv carries shared hardening; only fetch sees the credential and no ambient execution setting survives", async () => {
	const root = tempDir("host-clone-test-");
	const calls = [];
	let helper;
	const git = async (cwd, args, options) => { calls.push({ cwd, args, options }); return args.includes("rev-parse") ? `${sha}\n` : ""; };
	const result = await cloneHostWorkspace({ workspace: join(root, "workspace"), remote: "https://github.com/owner/repo.git", ref: "refs/pull/42/head", token: "clone-secret", env: { PATH: "/usr/bin:.:relative:/bin", GIT_SSH_COMMAND: "attack", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.x.smudge", GIT_CONFIG_VALUE_0: "attack", PROVIDER_KEY: "provider-secret" }, git, askpass: () => (helper = createAskpassHelper()) });
	assert.equal(result.sha, sha);
	assert.deepEqual(calls.map(({ args }) => args.slice(HOST_CLONE_FLAGS.length)[0]), ["init", "remote", "fetch", "checkout", "rev-parse"]);
	for (const { args, options } of calls) {
		assert.deepEqual(args.slice(0, HOST_CLONE_FLAGS.length), [...HOST_CLONE_FLAGS]);
		assert.doesNotMatch(JSON.stringify(args), /clone-secret|provider-secret/);
		assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
		assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
		assert.equal(options.env.GIT_ATTR_NOSYSTEM, "1");
		assert.equal(options.env.GIT_SSH_COMMAND, undefined);
		assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
		assert.equal(options.env.PROVIDER_KEY, undefined);
		assert.equal(options.env.PATH, "/usr/bin:/bin");
		assert.equal(options.timeout, 120_000);
		assert.equal(options.env.GIT_ASKPASS_TOKEN, args.includes("fetch") ? "clone-secret" : undefined);
	}
	const fetched = calls.find(({ args }) => args.includes("fetch"));
	assert.ok(fetched.args.includes("--no-recurse-submodules"));
	assert.ok(fetched.args.includes("--no-tags"));
	assert.equal(existsSync(helper.dir), false, "the helper and empty home are removed after checkout");
	assert.deepEqual(readdirSync(root), ["workspace"], "nothing token-bearing is staged beside the workspace");
});

test("askpass helper holds only a variable reference and is outside the clone; failures always remove it", async () => {
	const root = tempDir("host-clone-failure-test-");
	let helper;
	await assert.rejects(cloneHostWorkspace({ workspace: join(root, "workspace"), remote: "https://github.com/owner/repo.git", ref: "main", token: "never-on-disk", askpass: () => {
		helper = createAskpassHelper();
		assert.doesNotMatch(readFileSync(helper.path, "utf8"), /never-on-disk/);
		assert.match(readFileSync(helper.path, "utf8"), /GIT_ASKPASS_TOKEN/);
		assert.equal(helper.path.startsWith(root), false);
		return helper;
	}, git: async () => { throw new Error("socket reset"); } }), /socket reset/);
	assert.equal(existsSync(helper.dir), false);
	for (const remote of ["file:///private", "ext::evil", "https://token@evil/repo", "https://evil/repo?token=secret"]) {
		await assert.rejects(cloneHostWorkspace({ workspace: join(root, "unused"), remote, ref: "main", token: "x", git: () => assert.fail("no git for hostile origin") }));
	}
	assert.equal(existsSync(join(root, "unused")), false);
});

test("a real checkout cannot select an ambient smudge program; its positive control executes that program", async () => {
	const root = tempDir("host-clone-filter-test-");
	const source = join(root, "source");
	mkdirSync(source);
	const baseEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	const run = (cwd, args, env = baseEnv) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	run(source, ["init", "-q", "-b", "main"]);
	writeFileSync(join(source, ".gitattributes"), "*.txt filter=trap\n");
	writeFileSync(join(source, "tracked.txt"), "repository contents\n");
	run(source, ["add", "."]);
	run(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
	const marker = join(root, "host-program-ran");
	const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
	const program = `${quote(process.execPath)} -e ${quote(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");process.stdin.pipe(process.stdout);`)}`;
	const poisoned = { ...baseEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.trap.smudge", GIT_CONFIG_VALUE_0: program };
	const checkout = join(root, "safe");
	await cloneHostWorkspace({ workspace: checkout, remote: "https://github.com/owner/repo.git", ref: "main", token: "clone-secret", env: poisoned, git: async (cwd, args, options) => {
		const actual = [...args];
		if (actual.includes("fetch")) {
			// Replace only the transport with this test's local fixture; production never admits a file origin.
			actual.splice(actual.indexOf("fetch"), 0, "-c", "protocol.file.allow=always");
			actual[actual.indexOf("origin")] = source;
		}
		return run(cwd, actual, options.env);
	} });
	assert.equal(existsSync(marker), false, "repository attributes could not select the ambient host program");
	assert.equal(readFileSync(join(checkout, "tracked.txt"), "utf8"), "repository contents\n");
	const gitConfig = readFileSync(join(checkout, ".git", "config"), "utf8");
	assert.match(gitConfig, /https:\/\/github.com\/owner\/repo\.git/);
	assert.doesNotMatch(gitConfig, /clone-secret|filter\.trap|host-program/);
	const control = join(root, "control");
	run(root, ["clone", "-q", "--no-checkout", source, control]);
	run(control, ["checkout", "--detach", "HEAD"], poisoned);
	assert.equal(readFileSync(marker, "utf8"), "ran", "the same fixture executes the program when ambient config is inherited");
});
