/**
 * Every pi package this repository installs is the ONE release the runner pins (CONST-PI-VERSION-PINNED, issue #587).
 *
 * THE FAILURE THIS EXISTS FOR is new at pi 1.0.1. Up to pi 0.99.1 pi-coding-agent shipped an npm-shrinkwrap.json, so
 * its own pi-ai, pi-agent-core, pi-tui and the rest were locked by pi itself. 1.0.1 dropped the shrinkwrap, and
 * pi-coding-agent depends on its siblings by a RANGE (`^1.0.3`). A lockfile regenerated on another day can then
 * resolve a sibling to a newer release than the one every pinned assumption was checked against, with every pin in
 * every package.json still exact. So the root package.json carries an `overrides` block that pins each pi package to
 * the runner's pin, and this checks both halves:
 *   - the overrides name every pi package the lockfile holds, each at the pin;
 *   - every pi package entry in package-lock.json (at any depth) is at the pin;
 *   - the four places the pin is written by hand agree with it: the worker's pi-ai, the admin devDependency,
 *     admin/src/index.ts's SUPPORTED_PI_VERSION and image/Dockerfile's PI_VERSION.
 *
 * `piPinProblems` is pure (the files are handed in) so its test pins the rule on constructed input as well as on this
 * repository's own files. Run as a script it reads the repository and exits 1 on any problem.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCOPE = "@earendil-works/";

/** The problems with these files' pi pins, as sentences; empty when every pin agrees. */
export function piPinProblems({ root, lock, runner, worker, admin, adminIndex, dockerfile }) {
	const problems = [];
	const pin = runner?.dependencies?.[`${SCOPE}pi-coding-agent`];
	if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin)) return [`image/runner/package.json pins pi-coding-agent at ${JSON.stringify(pin)}, not an exact version`];
	const want = (where, value) => {
		if (value !== pin) problems.push(`${where} is ${JSON.stringify(value)}, not the pin ${pin}`);
	};
	want("worker/package.json's @earendil-works/pi-ai", worker?.dependencies?.[`${SCOPE}pi-ai`]);
	want("admin/package.json's devDependency @earendil-works/pi-coding-agent", admin?.devDependencies?.[`${SCOPE}pi-coding-agent`]);
	want("admin/src/index.ts's SUPPORTED_PI_VERSION", /^export const SUPPORTED_PI_VERSION = "([^"]*)";$/m.exec(adminIndex ?? "")?.[1]);
	want("image/Dockerfile's PI_VERSION", /^ARG PI_VERSION=(\S*)$/m.exec(dockerfile ?? "")?.[1]);
	const overrides = root?.overrides ?? {};
	const locked = new Map();
	for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
		const at = path.lastIndexOf(`node_modules/${SCOPE}`);
		if (at < 0) continue;
		const name = path.slice(at + "node_modules/".length);
		if (name.split("/").length !== 2) continue;
		locked.set(path, { name, version: entry?.version });
	}
	if (locked.size === 0) problems.push("package-lock.json holds no pi package at all");
	for (const [path, { name, version }] of locked) want(`package-lock.json's ${path}`, version);
	const named = new Set([...[...locked.values()].map(({ name }) => name), ...Object.keys(overrides).filter((name) => name.startsWith(SCOPE))]);
	for (const name of named) want(`package.json's overrides["${name}"]`, overrides[name]);
	return problems;
}

/** This repository's files, as piPinProblems reads them. */
export function repositoryPins(repo) {
	const json = (path) => JSON.parse(readFileSync(new URL(path, repo), "utf8"));
	return {
		root: json("package.json"),
		lock: json("package-lock.json"),
		runner: json("image/runner/package.json"),
		worker: json("worker/package.json"),
		admin: json("admin/package.json"),
		adminIndex: readFileSync(new URL("admin/src/index.ts", repo), "utf8"),
		dockerfile: readFileSync(new URL("image/Dockerfile", repo), "utf8"),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = piPinProblems(repositoryPins(new URL("../../", import.meta.url)));
	for (const problem of problems) console.error(`::error::${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log("OK: every pi package, override and hand-written pin is the runner's pin");
}
