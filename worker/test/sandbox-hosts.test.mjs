import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFile, lex, stringConstants } from "./helpers/env-reads.mjs";
import { sandboxHostsPath } from "../src/sandbox-hosts.mjs";

// The sandbox hosts file has one default (issue #806): PI_SANDBOX_HOSTS_FILE, or `sandbox-hosts.json`, in the
// deployment folder. A second default would name a file nobody writes, and a missing file reads as no hosts.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("sandboxHostsPath resolves PI_SANDBOX_HOSTS_FILE, or sandbox-hosts.json, against the deployment folder", () => {
	assert.equal(sandboxHostsPath({}, "/srv/dep"), "/srv/dep/sandbox-hosts.json");
	assert.equal(sandboxHostsPath({ PI_SANDBOX_HOSTS_FILE: "" }, "/srv/dep"), "/srv/dep/sandbox-hosts.json");
	assert.equal(sandboxHostsPath({ PI_SANDBOX_HOSTS_FILE: "  " }, "/srv/dep"), "/srv/dep/sandbox-hosts.json");
	assert.equal(sandboxHostsPath({ PI_SANDBOX_HOSTS_FILE: "state/hosts.json" }, "/srv/dep"), "/srv/dep/state/hosts.json");
	assert.equal(sandboxHostsPath({ PI_SANDBOX_HOSTS_FILE: "/etc/pd/hosts.json" }, "/srv/dep"), "/etc/pd/hosts.json");
	// No folder is no answer: neither the current directory nor the account's configuration folder stands in for it.
	assert.throws(() => sandboxHostsPath({ XDG_CONFIG_HOME: "/home/a/.config" }), TypeError);
});

test("only sandbox-hosts.mjs reads PI_SANDBOX_HOSTS_FILE, so every other reader takes its path from sandboxHostsPath", () => {
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (!["test", "node_modules", "dist"].includes(name)) walk(path);
			} else if ([".mjs", ".js", ".cjs", ".ts", ".mts"].includes(extname(name))) files.push(path);
		}
	};
	for (const tree of ["worker/src", "receiver/src", "admin/src", "gateway/src"]) walk(join(ROOT, tree));
	// The environment-read classifier, not a list of spellings: a member, a bracketed key, a key held in one of the
	// file's string constants and a destructured name are each a read, and a comment naming the variable is not. It
	// follows `env` and its aliases only, so a member read off any other object (a shell's or a resolved file's
	// environment) is matched on the comment-free code as well.
	const reads = (src) => {
		const { code } = lex(src);
		const constants = stringConstants(code);
		return classifyFile(src, (id) => constants.get(id)).names.includes("PI_SANDBOX_HOSTS_FILE") || /\.PI_SANDBOX_HOSTS_FILE\b/.test(code);
	};
	const readers = files.filter((path) => reads(readFileSync(path, "utf8")));
	assert.deepEqual(readers.map((path) => path.slice(ROOT.length + 1)), ["worker/src/sandbox-hosts.mjs"]);
});
