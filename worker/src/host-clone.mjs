/** Shared host-clone primitives. The credential helper lives outside every agent-reachable tree (#771). */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { GIT_SAFE_CONFIG, storeGitEnv } from "./git-hardening.mjs";

const exec = promisify(execFile);
export const HOST_CLONE_FLAGS = Object.freeze([...GIT_SAFE_CONFIG, "-c", "protocol.ext.allow=never", "-c", "credential.helper=", "--no-pager"]);
export const hardenedCloneArgs = (args) => [...HOST_CLONE_FLAGS, ...args];

export function createAskpassHelper() {
	const dir = mkdtempSync(join(tmpdir(), "pi-askpass-"));
	const path = join(dir, "askpass.sh");
	try {
		writeFileSync(path, "#!/bin/sh\nprintf '%s' \"$GIT_ASKPASS_TOKEN\"\n", { mode: 0o700 });
		chmodSync(path, 0o700);
		return { dir, path };
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function defaultHostGit(cwd, args, { env, signal, timeout } = {}) {
	const { stdout } = await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env, ...(timeout ? { timeout } : {}), ...(signal ? { signal } : {}) });
	return stdout;
}

/** The determinate missing-ref class, shared with the job preparer's existing refusal. */
export function isCloneRefGone(error) {
	const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`.toLowerCase();
	return ["couldn't find remote ref", "not our ref", "unadvertised object", "did not send all necessary objects", "reference is not a tree"].some((part) => text.includes(part));
}

/** storeGitEnv's trust switches are shared; Windows keeps absolute drive/UNC tool paths with its own separator. */
export function hostCloneEnvironment({ home, path, platform = process.platform }) {
	const clean = storeGitEnv({ home, path });
	delete clean.GIT_DIR;
	if (platform === "win32") clean.PATH = String(path ?? "").split(";").filter((entry) => win32.isAbsolute(entry)).join(";");
	return clean;
}

/**
 * A credential-free checkout after the one authenticated fetch. No materialisation, prompt, session or agent inputs.
 * The empty helper home and allowlisted environment also stop a repository's attributes selecting a host filter.
 */
export async function cloneHostWorkspace({ workspace, remote, ref, token, env = process.env, git = defaultHostGit, askpass = createAskpassHelper, platform = process.platform, signal } = {}) {
	const url = new URL(remote);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("sandbox clone requires a credential-free configured http(s) remote");
	const helper = askpass();
	try {
		const home = join(helper.dir, "home");
		mkdirSync(home, { mode: 0o700 });
		mkdirSync(workspace, { recursive: true, mode: 0o700 });
		// env-internal PATH: use only absolute host tool directories, as the checkpoint-store Git does.
		const clean = hostCloneEnvironment({ home, path: env.PATH, platform });
		// env-internal GIT_SSL_CAINFO: an operator's private CA trust input, never repository content or a container env.
		if (typeof env.GIT_SSL_CAINFO === "string") clean.GIT_SSL_CAINFO = env.GIT_SSL_CAINFO;
		const run = (args, net = false) => git(workspace, hardenedCloneArgs(args), { timeout: 120_000, env: net ? { ...clean, GIT_ASKPASS: helper.path, GIT_ASKPASS_TOKEN: token } : clean, ...(signal ? { signal } : {}) });
		await run(["init"]);
		await run(["remote", "add", "origin", remote]);
		await run(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", ref], true);
		await run(["checkout", "--detach", "FETCH_HEAD"]);
		const sha = String(await run(["rev-parse", "HEAD"])).trim();
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("sandbox clone returned no commit id");
		return { workspace, sha };
	} finally {
		rmSync(helper.dir, { recursive: true, force: true });
	}
}
