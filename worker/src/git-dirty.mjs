import { execFileSync } from "node:child_process";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";

/**
 * Report a folder's git working-tree state: `true` = dirty, `false` = clean, `null` = not a usable
 * git repository. Reads the WORKING TREE via `git status --porcelain` — distinct from
 * flow-gate.mjs's object-store read, which reads committed content at a pinned SHA; the two are kept
 * separate on purpose. `exec` is injectable for tests.
 *
 * HARDENED, and this is the site where it is not hypothetical. `git status` REFRESHES THE INDEX, so it
 * invokes `core.fsmonitor` -- an operator-supplied command -- where `rev-parse` does not. The folder this
 * reads is the same path a local job mounts at /workspace with write access, so the agent can write
 * `.git/config` and the next `pi-dispatch run` on that folder executes it ON THE HOST, outside any
 * container. This file was invisible to the sweep that hardened its six siblings, because that census
 * grepped for the flags that were PRESENT and this one had none.
 */
export function gitDirty(folder, { exec = execFileSync } = {}) {
	try {
		const out = exec("git", [...GIT_READ_FLAGS, "-C", folder, "status", "--porcelain"], { encoding: "utf8" });
		return out.trim().length > 0;
	} catch {
		return null;
	}
}
