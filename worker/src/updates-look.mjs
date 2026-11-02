/**
 * The daily look (issue #796, `REQ-PACKAGE-UPDATES`): which pi and which staged extensions are newer, and whether this repository's checks on the
 * newest pi hold. Free, and it changes nothing. It runs in a child the worker starts (`doctor-spawner.mjs`'s reason: it must stay off the loop that
 * renews paid job locks), and never in a job. Off until `PI_UPDATES_LOOK=1`.
 *
 * Bounded as doctor's model proposals are: five seconds, 1 MiB, no redirects, and through `PI_UPDATES_PROXY` when one is declared, with no direct
 * fallback. A failed read is **unknown, never passing**.
 */
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { readStageManifest } from "./packages.mjs";
import { PINNED_PI_NEEDLES } from "./host-pi.mjs";
import { compareVersions, parseLookRecord, UPDATES_LOOK_EVERY_HOURS } from "./updates.mjs";

/** Public repository, public API, no token: this reads what anyone can read. */
export const BUMP_CHECKS_REPO = "edgehero/pi-dispatch";
export const BUMP_BRANCH = "chore/pi-bump";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MAX_BYTES = 1024 * 1024;

/**
 * The members of pi's extension API the admin extension needs, by the names `USED_API` declares in `admin/src/index.ts`. A dependency points from admin
 * to the worker, so this is a copy, bolted to that list by `admin/test/updates-view.test.mjs`. A look starts pi only to ask its version and loads no extension, so
 * it can only say whether the host's pi still defines them: the real probe is the extension's own at load.
 */
export const ADMIN_USED_API = Object.freeze(["registerCommand", "registerTool", "sendMessage", "on"]);

/** Refusals here are thrown and turn into `unknown` at the caller: nothing below this line decides a state. */
export async function boundedJson(url, { proxyUrl = null, request = undiciFetch, timeoutMs = 5000, maxBytes = MAX_BYTES, headers = {}, ProxyAgentClass = ProxyAgent } = {}) {
	const dispatcher = proxyUrl ? new ProxyAgentClass(proxyUrl) : undefined;
	try {
		const response = await request(url, { ...(dispatcher ? { dispatcher } : {}), redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "user-agent": "pi-dispatch-updates-look", ...headers } });
		if (!response.ok) return { status: response.status, value: null };
		const parts = [];
		let length = 0;
		for await (const part of response.body) {
			length += part.length;
			if (length > maxBytes) throw new Error("response too large");
			parts.push(part);
		}
		return { status: response.status, value: JSON.parse(Buffer.concat(parts).toString("utf8")) };
	} finally {
		await dispatcher?.close();
	}
}

/** The `latest` dist-tag only, so a pre-release is never offered. Reading the version document keeps it small and downloads no tarball. */
export async function newestVersion(pkg, { get, registry = DEFAULT_REGISTRY }) {
	const { value } = await get(`${registry}/${pkg.startsWith("@") ? pkg.replace("/", "%2f") : pkg}/latest`);
	return typeof value?.version === "string" ? value.version : null;
}

/**
 * The checks on the bump branch, as long as that branch is about this version. A branch still on an older bump would otherwise report that older pi's
 * checks as this one's, which is how a passing word would come to mean nothing.
 */
export async function bumpChecks(version, { get, api = "https://api.github.com" }) {
	const ref = encodeURIComponent(BUMP_BRANCH);
	const commit = await get(`${api}/repos/${BUMP_CHECKS_REPO}/commits/${ref}`);
	const subject = String(commit.value?.commit?.message ?? "").split("\n")[0];
	if (subject !== `chore(pi): run on pi ${version}`) return "unknown";
	const { value } = await get(`${api}/repos/${BUMP_CHECKS_REPO}/commits/${ref}/check-runs?per_page=100`);
	const runs = value?.check_runs;
	// Fewer listed than exist means an unread run could be failing, which is unknown rather than a verdict on the ones read.
	if (!Array.isArray(runs) || runs.length === 0 || value.total_count !== runs.length) return "unknown";
	if (runs.some((run) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(run?.conclusion))) return "failing";
	if (runs.some((run) => run?.status !== "completed")) return "pending";
	return runs.every((run) => ["success", "neutral", "skipped"].includes(run?.conclusion)) ? "passing" : "unknown";
}

/**
 * This host's own pi against the version pi-dispatch is tested with, and whether what it mirrors still holds there. `resolvePi` and `versionOf` are
 * `chat-fork.mjs`'s, the pi this account would run. `needles` are `PINNED_PI_NEEDLES`; `absent` means there is simply no pi here, which is a normal host.
 */
export function hostPiFacts({ tested, resolvePi, versionOf, fs = nodeFs, needles = PINNED_PI_NEEDLES, api = ADMIN_USED_API }) {
	const found = resolvePi();
	if (!found?.path) return { version: null, tested, state: "absent", needles: "unknown", extension: "unknown" };
	const version = versionOf(found.path);
	const state = !version || !tested ? "unknown" : compareVersions(version, tested) === 0 ? "same" : compareVersions(version, tested) > 0 ? "newer" : "older";
	const root = piPackageRoot(found.path, fs);
	if (!root) return { version, tested, state, needles: "unknown", extension: "unknown" };
	let needlesHold = "ok", extension = "ok";
	try {
		for (const [file, list] of Object.entries(needles)) {
			const text = fs.readFileSync(join(root, file), "utf8");
			if (!list.every((needle) => text.includes(needle))) needlesHold = "drift";
		}
	} catch { needlesHold = "drift"; }
	try {
		const loader = fs.readFileSync(join(root, "dist/core/extensions/loader.js"), "utf8");
		if (!api.every((member) => loader.includes(`${member}(`))) extension = "drift";
	} catch { extension = "drift"; }
	return { version, tested, state, needles: needlesHold, extension };
}

/** The pi package a `pi` command belongs to, through its symlink. `null` for a wrapper that lives elsewhere: unknown, not a failure. */
function piPackageRoot(piPath, fs) {
	try {
		let dir = dirname(fs.realpathSync(piPath));
		for (let i = 0; i < 6; i += 1) {
			const pkg = join(dir, "package.json");
			if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8"))?.name === PI_PACKAGE) return dir;
			dir = dirname(dir);
		}
	} catch { /* unreadable: unknown below */ }
	return null;
}

/** Assemble one host's look. Throws nothing: every read that fails is a word on the record. */
export async function buildLook({ env, host, pinned, now = Date.now, fs = nodeFs, get, hostPi, globalPiDir = env.PI_GLOBAL_PI_DIR }) {
	const registry = env.PI_UPDATES_REGISTRY || DEFAULT_REGISTRY;
	const attempt = async (fn) => { try { return { read: "ok", value: await fn() }; } catch { return { read: "unknown", value: null }; } };
	const pi = await attempt(() => newestVersion(PI_PACKAGE, { get, registry }));
	const newest = pi.read === "ok" && typeof pi.value === "string" ? pi.value : null;
	let checks = null;
	if (newest && pinned && compareVersions(newest, pinned) > 0) checks = (await attempt(() => bumpChecks(newest, { get }))).value ?? "unknown";
	const manifest = globalPiDir ? readStageManifest({ globalPiDir, readFile: (p, e) => fs.readFileSync(p, e), fileExists: (p) => fs.existsSync(p) }) : null;
	const packages = [];
	for (const pkg of manifest?.packages ?? []) {
		const got = await attempt(() => newestVersion(pkg.name, { get, registry }));
		packages.push({ name: pkg.name, version: pkg.version, newest: got.read === "ok" ? got.value : null, read: got.read === "ok" && got.value ? "ok" : "unknown" });
	}
	const record = { v: 1, host, at: now(), everyHours: UPDATES_LOOK_EVERY_HOURS, pi: { pinned, newest, read: newest ? "ok" : "unknown", checks }, hostPi: await hostPi(), packages };
	return parseLookRecord(record);
}
