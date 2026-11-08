/**
 * `npx @edgehero/pi-dispatch up --console` in an empty folder (issue #849): turn three install lines into one.
 *
 * A worker running from npm's execution cache can never become a service: the cache is disposable, so a unit pointing into it would
 * break whenever npm prunes it (`setup-host-entry.mjs`). That refusal stays. What changes is the cache path's answer: rather than tell
 * the person to run three more commands, it runs them, with the same exact pins the README and the wizard use, and hands over to the
 * binary it just installed in the folder. Everything after the handover is the ordinary durable path, so nothing the cache run did can
 * become a service.
 *
 * ORDER IS THE CONTRACT. Every refusal that needs nothing installed runs first, then the one question, and only then does anything
 * touch the folder, so a refusal leaves no `node_modules` (`REQ-BROWSER-FIRST-RUN-SETUP`).
 *
 * THE INSTALL HAPPENS IN A STAGING FOLDER and is moved into place only after npm exits 0. npx looks in the current folder first: if a
 * stopped install left the worker package here without its bin, npx would try to run a bin that does not exist, this code would never
 * start, and the same command could never recover. REJECTED: cleaning up after a non-zero exit, which a Ctrl-C or the timeout's SIGKILL
 * never reaches.
 *
 * THE ENVIRONMENT IS CLEANED, not inherited. npx exports `npm_config_*` values of its own run (the package it fetched, its prefix) and
 * puts its cache's `.bin`, every ancestor folder's `node_modules/.bin` and npm's `node-gyp-bin` first on PATH. An install or a service
 * that inherited those would be describing the cache, and a folder's `.bin` on PATH would let a planted `launchctl` run before the person
 * has answered anything. A registry or proxy the person set themselves is not on the list and survives.
 */
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedUnitPaths } from "./service.mjs";
import { setupCachePath, trustedSetupFile } from "./setup-host-entry.mjs";
import { askFirstRun, attachedCommand, commandsHere, deploymentPreflight, ensureConsoleShortcut, flagValue, newOperatorNameProblem, operatorChoiceProblem, serviceManagerAnswers, tightenedUmask } from "./console-bootstrap.mjs";
import { VALKEY_PASSWORD_KEY } from "./valkey-auth.mjs";
import { EXACT_VERSION_RE } from "./package-names.mjs";
import { readUnitSeam } from "./service.mjs";

/** How long the install may take. A bound, so a stalled registry ends in a refusal rather than a terminal that hangs forever. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The name of the private `package.json`, which also marks it as ours. */
const DEPLOYMENT_PACKAGE_NAME = "pi-dispatch-deployment";

/** Where the install is built before it is moved into place. What a stopped install left here is removed before the next one. */
const STAGING_DIR = ".pi-dispatch-install";

/** Names a folder may hold and still count as empty: files that say nothing about what the folder is for. */
const IGNORABLE = new Set([".DS_Store", ".git", ".gitignore", STAGING_DIR]);

/**
 * What a folder may hold and still be a deployment: what `init` scaffolds (a test holds this to a real run of `init`) and what the
 * console and this tooling add there. Anything else is someone's project, whatever else sits beside it.
 */
export const DEPLOYMENT_FILES = new Set([".env", "triggers.json", "pause-windows.json", "pi-packages.json", "subscriptions.json", "scoped-limits.json", "projects.json", "egress-allowlist.conf", "model-endpoints.conf", "model-endpoints.json", "deploy", "console-tokens.json", "console-login-codes", "console-devices", "pi-dispatch", ".pi-dispatch-setup.lock"]);

/** What only npx puts in the environment. An allowlist of npm's own exports, so a person's `npm_config_registry` is left alone. */
const NPX_ENV_RE = /^(?:INIT_CWD|NODE|npm_(?:command|execpath|node_execpath|lifecycle_\w+|package_\w+|config_(?:call|cache|global_prefix|globalconfig|ignore_scripts|init_module|local_prefix|node_gyp|noproxy|npm_version|package|prefix|user_agent|userconfig|yes)))$/;

/** This package's own version and the exact pi it was built against, read from its own `package.json`, never from a flag. */
export function ownPackageVersions({ path = fileURLToPath(new URL("../package.json", import.meta.url)), fs = nodeFs } = {}) {
	const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
	return { version: pkg.version, piVersion: pkg.dependencies?.["@earendil-works/pi-ai"] };
}

/**
 * The npm argv for the durable install. The same packages and flags as the wizard's `browserInstallArgs` (the admin workspace's test
 * holds the two equal), written out here because the worker cannot import from the admin package it is about to install.
 */
export function selfInstallArgs({ version, piVersion }) {
	return ["install", `@edgehero/pi-dispatch-admin@${version}`, `@earendil-works/pi-coding-agent@${piVersion}`, "--save-exact", `@edgehero/pi-dispatch@${version}`, "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
}

/** Is this PATH entry something npx put there? Narrower than `setupCachePath`, so a person's own `~/.cache/foo/bin` stays. */
const npxPathEntry = (part) => /(?:^|[/\\])_npx(?:[/\\]|$)/.test(part) || /(?:^|[/\\])node_modules[/\\]\.bin[/\\]?$/.test(part) || /[/\\]node-gyp-bin[/\\]?$/.test(part);

/** `env` without what npx added: its exports, and what it put on PATH. */
export function cleanedNpxEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) if (!NPX_ENV_RE.test(key)) out[key] = value;
	// env-internal PATH: an environment passed through, with only what npx added taken out.
	if (typeof env.PATH === "string") out.PATH = env.PATH.split(":").filter((part) => !npxPathEntry(part)).join(":");
	return out;
}

/**
 * A private root `package.json`, so npm cannot settle on some project higher up the tree (the wizard's own guard). `wx`: a name that is
 * a dangling link was missed by the folder check's `exists`, and must not be written through.
 */
function ensureDeploymentPackageJson(fs, dir) {
	const path = join(dir, "package.json");
	if (!fs.existsSync(path)) fs.writeFileSync(path, `${JSON.stringify({ name: DEPLOYMENT_PACKAGE_NAME, private: true }, null, 2)}\n`, { flag: "wx" });
}

/** Is there a symlink here, even one that points nowhere? `existsSync` follows the link and says no to a dangling one. */
function isLink(fs, path) {
	try { return fs.lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Do the folder and every parent belong to this account or root, and are they closed to others? `trustedSetupFile` asks this after the install; asking it now means a refusal leaves nothing behind. */
function folderChainTrusted(fs, dir, uid) {
	for (let parent = dirname(dir); ; parent = dirname(parent)) {
		const st = fs.statSync(parent);
		if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) && !(st.mode & 0o1000))) return false;
		if (parent === dirname(parent)) return true;
	}
}

/**
 * Is the `package.json` here exactly what this tooling writes? A failed install leaves it behind, and a re-run must not be refused for it.
 * The exact keys matter: `overrides` or `dependencies` under our name would redirect what the pinned install resolves.
 */
function ourPackageJson(fs, dir) {
	try {
		const pkg = JSON.parse(fs.readFileSync(join(dir, "package.json"), "utf8"));
		return Object.keys(pkg).sort().join(",") === "name,private" && pkg.name === DEPLOYMENT_PACKAGE_NAME && pkg.private === true;
	} catch { return false; }
}

/** Does `.env` hold a key `init` writes? `.env` alone is in every other web project, and is no evidence of a deployment. */
function initWroteEnv(fs, dir) {
	try { return new RegExp(`^${VALKEY_PASSWORD_KEY}=`, "m").test(fs.readFileSync(join(dir, ".env"), "utf8")); } catch { return false; }
}

/** Is this folder empty, or already a deployment? Anything else is someone's project, and installing into it would be a surprise. */
function folderProblem(fs, dir, home, uid) {
	let isHome = false;
	try { isHome = dir === fs.realpathSync(home); } catch { /* an unreadable home is simply not this folder */ }
	if (isHome) return "this is your home folder. Make a new folder for the deployment and run this there.";
	if (setupCachePath(dir)) return "this folder is inside a cache, which can be emptied at any time. Make a folder somewhere that will stay and run this there.";
	if (!folderChainTrusted(fs, dir, uid)) return "a folder above this one can be written by another account, so what is installed here could not be trusted. Make a folder somewhere only you can write and run this there.";
	// The real path, so a `.bin` planted beside our own package.json counts as the leftover it is, not as an installation to send someone to.
	let installed = false;
	try { installed = fs.realpathSync(join(dir, "node_modules", ".bin", "pi-dispatch")) === join(dir, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs"); } catch { /* no bin, so no installation */ }
	if (installed) return "this folder already has pi-dispatch installed. Run its own: ./node_modules/.bin/pi-dispatch up --console";
	const ours = ourPackageJson(fs, dir);
	const names = fs.readdirSync(dir).filter((name) => !IGNORABLE.has(name) && !(ours && (name === "package.json" || name === "node_modules")));
	if (names.length === 0) return null;
	const foreign = names.find((name) => !DEPLOYMENT_FILES.has(name));
	const isDeployment = names.includes("triggers.json") || (names.includes(".env") && initWroteEnv(fs, dir));
	if (foreign !== undefined || !isDeployment) return `this folder already holds other files (${foreign ?? names.join(", ")}) and is not a deployment. Make a new empty folder and run this there.`;
	return null;
}

export async function runSelfInstall(argv, deps) {
	const { fs, env, cwd, platform, euid: uid, home, out, prompt, consoleCommand: run, refuse } = deps;
	let own;
	try { own = (deps.ownPackage ?? ownPackageVersions)(); } catch { return refuse("this package's own version could not be read, so nothing can be pinned; nothing was changed."); }
	if (!EXACT_VERSION_RE.test(String(own.version)) || !EXACT_VERSION_RE.test(String(own.piVersion))) return refuse("this package does not name exact versions to install, so nothing can be pinned; nothing was changed.");

	// The folder before the preflight's mode check, so a folder that holds someone's project under a loose umask is told that, not about its mode.
	// Only on a platform that can run this: the platform refusal below is the better sentence on the others.
	if (["linux", "darwin"].includes(platform)) {
		let problem;
		try { problem = folderProblem(fs, fs.realpathSync(cwd), home, uid); } catch { return refuse("the deployment folder could not be read; nothing was changed."); }
		if (problem) return refuse(problem);
	}
	const pre = deploymentPreflight({ fs, env, cwd, platform, uid, refuse, consoleTokensPath: deps.consoleTokensPath, readTokens: deps.readTokens, looseEmptyIgnoring: IGNORABLE });
	if (pre.refused !== undefined) return pre.refused;
	const { dir, existing } = pre;
	// Free, and the installed binary would refuse it after the install otherwise.
	const operators = existing?.tokens.filter((entry) => entry.role === "operator") ?? [];
	const choice = operatorChoiceProblem(flagValue(argv, "--name"), operators);
	if (choice) return refuse(choice);
	if (operators.length > 1 && flagValue(argv, "--name") === null && !(deps.isTTY ?? Boolean(process.stdin.isTTY))) return refuse("there are several operators and no terminal to ask on, so name one with --name; nothing was changed.");
	if (operators.length === 0) {
		const nameProblem = newOperatorNameProblem(flagValue(argv, "--name") ?? "operator", existing);
		if (nameProblem) return refuse(nameProblem);
	}
	// A console unit is account-wide. The installed binary would refuse a foreign one after the install; refusing here leaves no node_modules.
	const unit = installedUnitPaths(platform, home).find((row) => row.which === "console" && fs.existsSync(row.path));
	if (unit) {
		let owner = null;
		try { owner = readUnitSeam(fs.readFileSync(unit.path, "utf8"), platform).deployDir; } catch { /* the path alone still says which service */ }
		const there = owner ? commandsHere(owner, fs, { from: dir }).worker : "pi-dispatch";
		return refuse(`this account already has a console service (${unit.path})${owner ? `, for ${owner}` : ""}. Run ${there} up --console for that deployment, or ${there} service uninstall --console there first; nothing was changed.`);
	}
	// The cleaned PATH: a planted `launchctl` in some folder's `node_modules/.bin` must not run, and this probe comes before any answer.
	const clean = cleanedNpxEnv(env);
	if (!(await serviceManagerAnswers({ run, platform, uid, dir, env: clean }))) return refuse("the account's user service manager did not answer. Start it before console bootstrap.");

	const installLine = `npm ${selfInstallArgs(own).join(" ")}`;
	// One question only for a new deployment, as in `runConsoleUp`: on one in use, `--yes` can restart a live queue.
	const isNew = !fs.existsSync(join(dir, ".env"));
	const decision = argv.includes("--yes") ? "yes" : argv.includes("--ask-each") || !isNew ? "each" : await askFirstRun({ dir, installing: true, prompt, out });
	if (decision === "no") { out("Console bootstrap declined; nothing was changed.\n"); return 0; }
	out(`  ${installLine}\n`);
	if (decision === "each" && !/^y(es)?$/i.test(String(await prompt("Run that in this folder? [y/N] ")).trim())) { out("Console bootstrap declined; nothing was changed.\n"); return 0; }

	// Under a umask like Ubuntu's 002 npm writes group-writable files, which the durable checks then rightly refuse, after all the work.
	// Set here, so the install and the handed-over child both inherit it.
	(deps.tightenUmask ?? (() => process.umask(tightenedUmask(process.umask()))))();
	const staging = join(dir, STAGING_DIR);
	try {
		const st = fs.statSync(dir);
		if (st.mode & 0o022) {
			fs.chmodSync(dir, st.mode & ~0o022 & 0o7777);
			// Looked at again now that nobody else can add to it: the check before the question was only true then, and it may have waited a long time.
			if (fs.readdirSync(dir).some((name) => !IGNORABLE.has(name))) return refuse("files appeared in this folder while it was open to other accounts, so nothing was installed. Make a new folder and run this there.");
		}
		// The retries are for an interrupted npm, which goes on writing here for about a second after Ctrl-C has returned the prompt.
		// NOT under the deployment's setup lock, though two runs at once in one folder would share this name: a Ctrl-C would leave that lock
		// behind, and a lock nobody may remove would bring back the dead end this staging folder exists to prevent.
		fs.rmSync(staging, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
		fs.mkdirSync(staging, { mode: 0o700 });
		ensureDeploymentPackageJson(fs, staging);
	} catch { return refuse("the deployment folder could not be prepared; an earlier install may still be stopping, so wait a moment and run this again. Nothing else was changed."); }
	const install = deps.npmInstall ?? ((args, options) => attachedCommand("npm", args, { ...options, stdio: ["ignore", "inherit", "inherit"], timeout: INSTALL_TIMEOUT_MS }));
	const code = await install(selfInstallArgs(own), { cwd: staging, env: clean });
	if (code !== 0) return refuse("npm could not install the packages. Fix what it printed above and run this again.");
	try {
		// Whatever appeared while npm ran is someone's, and the renames below would replace it without a word.
		if ((fs.existsSync(join(dir, "package.json")) && !ourPackageJson(fs, dir)) || fs.existsSync(join(dir, "package-lock.json"))) return refuse("this folder changed while it was being set up, so nothing was installed. Run this again in an empty folder.");
		// What an earlier install left. Only reached beside our own `package.json`, read again here because the question may have waited a long
		// time. A symlink is removed, not followed.
		const leftover = join(dir, "node_modules");
		if (fs.existsSync(leftover) || isLink(fs, leftover)) {
			if (!ourPackageJson(fs, dir)) return refuse("this folder changed while it was being set up, so nothing was installed. Run this again in an empty folder.");
			out("  removing what an earlier install left in node_modules\n");
			fs.rmSync(leftover, { recursive: true, force: true });
		}
		// node_modules first. If anything stops between these, what is here is complete and the next run uses it.
		fs.renameSync(join(staging, "node_modules"), leftover);
		for (const name of ["package.json", "package-lock.json"]) if (fs.existsSync(join(staging, name))) fs.renameSync(join(staging, name), join(dir, name));
		fs.rmSync(staging, { recursive: true, force: true });
	} catch { return refuse("the installed packages could not be moved into this folder; run this again."); }

	const entry = join(dir, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs");
	const metadata = join(dirname(dirname(entry)), "package.json");
	try {
		const trust = deps.trustedFile ?? ((path) => trustedSetupFile(path, { uid, stat: fs.statSync, realpath: fs.realpathSync }));
		const pkg = JSON.parse(fs.readFileSync(metadata, "utf8"));
		if (!trust(entry) || !trust(metadata) || pkg.name !== "@edgehero/pi-dispatch" || pkg.version !== own.version) return refuse("the installed package could not be trusted or is not the expected version; nothing was started.");
	} catch { return refuse("the installed package could not be validated; nothing was started."); }
	// Straight away, so that if the steps after this fail (Docker not running is the likely one) the way to retry exists and can be named.
	const shortcut = ensureConsoleShortcut(dir, fs);

	// The answer crosses the handover as a flag, so the person is never asked the same thing twice.
	const rest = argv.filter((arg) => arg !== "--yes" && arg !== "--ask-each" && arg !== "--console");
	const handed = await (deps.handOver ?? attachedCommand)(process.execPath, [entry, "up", "--console", decision === "yes" ? "--yes" : "--ask-each", ...rest], { cwd: dir, env: clean });
	const retry = `${shortcut ? "./pi-dispatch" : "./node_modules/.bin/pi-dispatch"} up --console`;
	if (typeof handed !== "number") return refuse(`the installed pi-dispatch could not be started. Run this in this folder: ${retry}`);
	if (handed !== 0) out(`Fix what is printed above, then run this in this folder: ${retry}\n`);
	return handed;
}
