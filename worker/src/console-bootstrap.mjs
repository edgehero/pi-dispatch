/** A terminal-only composition of existing bootstrap, token, service and login-link commands (#774). */
import * as nodeFs from "node:fs";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConsoleEntry, findOnPath, consoleTokensPathFor, installedUnitPaths, planServiceSetup, runService } from "./service.mjs";
import { addToken, readTokensFile, TOKEN_NAME_RE, tokenNames } from "./console-tokens.mjs";
import { makeConsoleAudit } from "./console-audit.mjs";
import { deploymentServiceEnv } from "./service-env.mjs";
import { logsDirPath } from "./config.mjs";
import { probeConsole, consoleProbeTarget } from "./console-probe.mjs";
import { resolveSetupWorkerEntry, setupCachePath, trustedSetupFile } from "./setup-host-entry.mjs";
import { fileURLToPath } from "node:url";

/**
 * What the service manager's probe may print. `launchctl print gui/<uid>` describes the whole login session: 141 KiB on one real Mac,
 * and more on a busier one. execFile kills a child that passes its bound and reports a string code, so the small bound below read a
 * manager that answered as one that did not, and `up --console` refused the README's install on that Mac. Only this probe's exit code
 * is read, so it gets a bound for what it may print, and every other command keeps the small one. REJECTED: reading the overflow as an
 * answer, since the kill means no exit status was ever seen.
 */
export const MANAGER_PROBE_MAX_BUFFER = 16 * 1024 * 1024;

export function boundedCommand(bin, args, { maxBuffer = 65536, ...options } = {}) {
	return new Promise((done) => {
		try { execFile(bin, args, { ...options, timeout: 15_000, maxBuffer, killSignal: "SIGKILL" }, (error, stdout) => done({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout: String(stdout ?? "") })); }
		catch { done({ code: null, stdout: "" }); }
	});
}
/**
 * Is this very file running out of npx's own cache? Judged on the real path, because npx reaches it through a link. `_npx` only, and
 * deliberately narrower than `setupCachePath`: a durable install under some `.cache` folder is no npx run, and telling it to install
 * itself would send it round in a circle. pnpm dlx, yarn dlx and bunx are not recognised here and meet the ordinary refusal below.
 */
export function runningFromNpmCache({ entry = fileURLToPath(import.meta.url), realpath = nodeFs.realpathSync } = {}) {
	try { return /(?:^|[/\\])_npx(?:[/\\]|$)/.test(realpath(entry)); } catch { return false; }
}
const shellWord = (value) => /^[A-Za-z0-9_./+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** Inspect the installed peer's metadata without importing pi or accepting npm's floating peer resolution. */
export function verifyConsolePeer(consoleEntry, { fs = nodeFs, uid = process.geteuid?.(), expected = JSON.parse(nodeFs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-ai"] } = {}) {
	let parent = dirname(dirname(consoleEntry));
	for (;;) {
		const path = join(parent, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
		try {
			if (!trustedSetupFile(path, { uid, stat: fs.statSync, realpath: fs.realpathSync })) {
				if (!fs.existsSync(path)) throw Object.assign(new Error(), { code: "ENOENT" });
				return false;
			}
			const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
			const bin = pkg.bin?.pi;
			return pkg.name === "@earendil-works/pi-coding-agent" && pkg.version === expected && bin === "dist/bundle/cli.js" && trustedSetupFile(join(dirname(path), bin), { uid, stat: fs.statSync, realpath: fs.realpathSync }) !== null && Object.entries(pkg.dependencies ?? {}).filter(([name]) => name.startsWith("@earendil-works/")).every(([, version]) => version === expected);
		} catch (e) { if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return false; }
		if (parent === dirname(parent)) return false;
		parent = dirname(parent);
	}
}

/** The flags only `up --console` reads. The plain `up` pass it composes never sees them. */
const CONSOLE_ONLY_FLAGS = Object.freeze(["--console", "--no-open", "--ask-each"]);

/** `--flag value` or `--flag=value` from an argv, or null. */
export function flagValue(argv, flag) {
	const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
	if (inline !== undefined) return inline.slice(flag.length + 1);
	const at = argv.indexOf(flag);
	return at === -1 || typeof argv[at + 1] !== "string" || argv[at + 1].startsWith("--") ? null : argv[at + 1];
}

/** `argv` with `up --console`'s own flags, and `--name`'s value, taken out. */
export function upArgvOf(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--name=")) continue;
		if (argv[i] === "--name") { i += flagValue(argv.slice(i), "--name") === null ? 0 : 1; continue; }
		if (!CONSOLE_ONLY_FLAGS.includes(argv[i])) out.push(argv[i]);
	}
	return out;
}

/** The refusal for two flags that ask opposite things, or null. Refused rather than resolved, so neither reading is ever a surprise. */
export function consentFlagProblem(argv) {
	return argv.includes("--yes") && argv.includes("--ask-each") ? "--yes and --ask-each ask for opposite things; pass one." : null;
}

/** Whether a name can be the new first operator of this tokens file: the refusal sentence, or null. Free, so it runs before anything is written. */
export function newOperatorNameProblem(name, existing) {
	// Every name the file holds, an entry kept for a role this build does not know included (issue #761).
	return !TOKEN_NAME_RE.test(name) || tokenNames(existing).includes(name) ? "choose an unused valid operator name with --name; nothing was changed." : null;
}

/** Is `name` in `dir` the shortcut this tooling makes? Anything else at the name is someone's file, which no message may tell a person to run. */
function isOurShortcut(dir, fs) {
	try { return fs.lstatSync(join(dir, "pi-dispatch")).isSymbolicLink() && fs.readlinkSync(join(dir, "pi-dispatch")) === join("node_modules", ".bin", "pi-dispatch"); } catch { return false; }
}

/**
 * What to type to run this deployment's own commands: the short name where it exists, because a local install puts nothing on PATH.
 * Relative only when the person is standing in the folder (`from`), since `./pi-dispatch` means nothing from anywhere else.
 */
export function commandsHere(dir, fs = nodeFs, { from = dir } = {}) {
	const has = (rel) => { try { return fs.existsSync(join(dir, rel)); } catch { return false; } };
	const at = (rel) => (from === dir ? `./${rel}` : shellWord(join(dir, rel)));
	const workerBin = join("node_modules", ".bin", "pi-dispatch");
	const consoleBin = join("node_modules", ".bin", "pi-dispatch-console");
	return {
		worker: isOurShortcut(dir, fs) && has(workerBin) ? at("pi-dispatch") : has(workerBin) ? at(workerBin) : "pi-dispatch",
		console: has(consoleBin) ? at(consoleBin) : "pi-dispatch-console",
	};
}

/** The bits a umask must always have, so what npm and the deployment write cannot be changed by another account. */
export function tightenedUmask(current) {
	return current | 0o022;
}

/** Refusal for a `--name` that cannot be used with the operators already in this file, or null. */
export function operatorChoiceProblem(named, operators) {
	if (named === null) return null;
	if (operators.length === 1 && operators[0].name !== named) return `this deployment's operator is "${operators[0].name}", so --name ${named} names no one; nothing was changed.`;
	if (operators.length > 1 && !operators.some((row) => row.name === named)) return "no existing operator was selected; nothing was changed.";
	return null;
}

/** A child on this terminal, for the commands that have to talk to the person. Resolves to its exit code, null when it could not run. */
export function attachedCommand(bin, args, { cwd, env, stdio = "inherit", timeout, spawn = nodeSpawn } = {}) {
	return new Promise((done) => {
		try {
			const child = spawn(bin, args, { cwd, env, stdio, ...(timeout ? { timeout, killSignal: "SIGKILL" } : {}) });
			child.on("error", () => done(null));
			child.on("close", (code) => done(typeof code === "number" ? code : null));
		} catch { done(null); }
	});
}

/** Poll until the console answers or `ms` has passed: true when it answered. */
export async function waitForConsole(env, { probe = probeConsole, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), ms = 15_000 } = {}) {
	const until = now() + ms;
	do { if ((await probe(env)).state === "running") return true; if (now() >= until) return false; await sleep(250); } while (true);
}

/**
 * `./pi-dispatch`, a relative symlink to this folder's own pinned binary, so the command that gets someone back in is short enough to
 * remember: true when the shortcut is there. Relative, so moving the folder keeps it working. REJECTED: a link in `~/.local/bin`, which
 * is account-wide and wrong as soon as there are two deployments, and `npx pi-dispatch`, which outside this folder fetches whatever
 * unrelated package holds that name. Anything else already at the name is left alone: it is not ours to replace.
 */
export function ensureConsoleShortcut(dir, fs = nodeFs) {
	const target = join("node_modules", ".bin", "pi-dispatch");
	if (!fs.existsSync(join(dir, target))) return false;
	const link = join(dir, "pi-dispatch");
	try { const st = fs.lstatSync(link); return st.isSymbolicLink() && fs.readlinkSync(link) === target; }
	catch (e) { if (e?.code !== "ENOENT") return false; }
	try { fs.symlinkSync(target, link); return true; } catch { return false; }
}

/**
 * The one question a first run asks. Yes is exactly `--yes`: commands still print, and what `--yes` never covers still asks, so this
 * adds no authority a person could not already give by typing the flag. The list is by kind, not by command, because `up` picks its
 * commands from what it finds as it goes. Anything but y or a is no, as every consent in `up` defaults to no.
 */
export async function askFirstRun({ dir, installing, prompt, out }) {
	out(`This sets up pi-dispatch in ${dir}:\n`);
	if (installing) out("  - install the exact matching packages into this folder, with install scripts off\n");
	out("  - run pi-dispatch up: write this folder's settings, get the job image, and start the queue and the egress proxy (one already running with no job attached is replaced)\n");
	out("  - create an operator sign in, keeping only its hash\n");
	out("  - start the console as a service for your account, with bounded local host setup (--host-setup)\n");
	out("  - add a ./pi-dispatch shortcut in this folder, and open your browser signed in\n");
	out("Each command is shown as it runs. The worker is started only by a separate confirmed action.\n");
	const said = String(await prompt("Do all of this? y for yes to all, a to be asked before each step, n to stop [y/a/N] ")).trim();
	return /^y(es)?$/i.test(said) ? "yes" : /^a(sk)?$/i.test(said) ? "each" : "no";
}

/**
 * Every refusal that needs nothing installed: platform, folder, the deployment's settings, the console's address and the tokens file.
 * Its own function because the npm-cache path has to run all of them BEFORE its install (`REQ-BROWSER-FIRST-RUN-SETUP`: refuse before
 * any host mutation), and a refusal there must leave no `node_modules` behind. `{ refused }` is the exit code of a refusal already said.
 */
export function deploymentPreflight({ fs, env, cwd, platform, uid, refuse, consoleTokensPath, readTokens, looseEmptyIgnoring = null }) {
	const stop = (text) => ({ refused: refuse(text) });
	if (!["linux", "darwin"].includes(platform) || (platform === "darwin" && uid === 0)) return stop("browser host setup needs a Linux user systemd manager or your macOS LaunchAgent session; use terminal setup on this platform.");
	let dir;
	try {
		dir = fs.realpathSync(cwd);
		const st = fs.statSync(dir);
		// An empty folder of this account's with a loose mode is what `mkdir` makes under Ubuntu's default umask, and the self-install tightens it
		// after the question and looks again. A caller that does not do both must leave this null.
		if (st.uid !== uid || ((st.mode & 0o022) && !(looseEmptyIgnoring && fs.readdirSync(dir).every((name) => looseEmptyIgnoring.has(name))))) return stop("the deployment directory must belong to this account and be writable by this account alone.");
	} catch { return stop("the deployment directory could not be validated."); }
	const declaredConsoleKeys = [...new Set(["PI_CONSOLE_LISTEN", "PI_CONSOLE_TOKENS_FILE", "PI_LOGS_DIR", ...Object.keys(env).filter((key) => key.startsWith("PI_CONSOLE_"))])];
	const read = deploymentServiceEnv({ env: {}, dir, keys: declaredConsoleKeys, fs, uid, platform });
	if (read.untrusted || read.unreadable && read.unreadable !== "ENOENT" || read.unread?.length || read.hazardSkipped?.length) return stop("the deployment environment is unsafe or ambiguous; correct it before console bootstrap.");
	if (declaredConsoleKeys.some((key) => typeof env[key] === "string" && env[key] !== read.env[key])) return stop("console settings in this shell differ from the deployment service's environment. Unset the shell overrides before bootstrap.");
	const target = consoleProbeTarget(read.env.PI_CONSOLE_LISTEN);
	if (target.unknown) return stop("the console needs a concrete local port or private socket so its one-time setup link can be reached.");
	if (target.kind === "unix") {
		try { const parent = fs.lstatSync(dirname(target.path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) return stop("the console socket's parent must be a private directory owned by this account."); }
		catch { return stop("the console socket's private parent directory must exist before bootstrap."); }
	}
	const tokensPath = (consoleTokensPath ?? consoleTokensPathFor)(dir, platform);
	let existing = null;
	try { if (fs.existsSync(tokensPath)) { const got = (readTokens ?? readTokensFile)({ path: tokensPath, fs, uid }); if (got.refusal) return stop("the console tokens file is unsafe or invalid; correct it before bootstrap."); existing = got.file; } }
	catch { return stop("the console tokens file could not be inspected."); }
	return { dir, read, target, tokensPath, existing };
}

/** Does this account's service manager answer? Printed output is ignored, so it gets the larger bound (`MANAGER_PROBE_MAX_BUFFER`). */
export async function serviceManagerAnswers({ run, platform, uid, dir, env }) {
	const manager = await run(platform === "linux" ? "systemctl" : "launchctl", platform === "linux" ? ["--user", "show-environment"] : ["print", `gui/${uid}`], { cwd: dir, env, maxBuffer: MANAGER_PROBE_MAX_BUFFER });
	return manager.code === 0;
}

export async function runConsoleUp(argv, deps = {}) {
	const fs = deps.fs ?? nodeFs;
	const env = deps.env ?? process.env;
	const cwd = deps.cwd ?? process.cwd();
	const platform = deps.platform ?? process.platform;
	const uid = deps.euid ?? process.geteuid?.();
	const home = deps.home ?? homedir();
	const out = deps.out ?? ((text) => process.stdout.write(text));
	const prompt = deps.prompt ?? (await import("./up.mjs")).defaultPrompt;
	const run = deps.consoleCommand ?? boundedCommand;
	const refuse = (text) => { out(`up --console: ${text}\n`); return 2; };
	const flagProblem = consentFlagProblem(argv);
	if (flagProblem) return refuse(flagProblem);
	// A run from npm's cache has no admin package beside it, so this comes before the missing-admin refusal below, which still holds for
	// a durable worker: the cache is the one case where installing is the right answer rather than a surprise.
	if ((deps.fromNpmCache ?? runningFromNpmCache)()) {
		const { runSelfInstall } = await import("./console-install.mjs");
		return runSelfInstall(argv, { ...deps, fs, env, cwd, platform, euid: uid, home, out, prompt, consoleCommand: run, refuse });
	}
	const worker = (deps.resolveSetupEntry ?? resolveSetupWorkerEntry)();
	// env-internal PATH: find the installed admin binary; never a browser-supplied program search path.
	const consoleEntry = (deps.resolveConsole ?? (() => resolveConsoleEntry({ findBin: (name) => findOnPath(name, env.PATH), realpath: fs.realpathSync })))();
	// Every determinate bootstrap refusal comes before init, image pulls, tokens or unit writes.
	if (!consoleEntry) return refuse("the admin package's built console is missing. Install exact matching @edgehero/pi-dispatch and @edgehero/pi-dispatch-admin versions durably in this deployment, then run its installed pi-dispatch up --console.");
	if (!worker.entry || setupCachePath(consoleEntry)) return refuse("service entries must come from durable installed packages, never an npm execution cache. Install both packages into the deployment and use node_modules/.bin/pi-dispatch up --console.");
	try {
		const metadata = join(dirname(consoleEntry), "..", "package.json");
		if (!trustedSetupFile(consoleEntry, { uid, stat: fs.statSync, realpath: fs.realpathSync }) || !trustedSetupFile(metadata, { uid, stat: fs.statSync, realpath: fs.realpathSync })) return refuse("the built admin entry and its installation directories must belong to this account or root and be writable by them alone.");
		const pkg = JSON.parse(fs.readFileSync(metadata, "utf8"));
		if (pkg.name !== "@edgehero/pi-dispatch-admin" || pkg.version !== worker.version || !fs.statSync(consoleEntry).isFile()) return refuse("the worker and built admin package must have the same exact version.");
	} catch { return refuse("the admin package's built entry or package metadata could not be validated."); }
	if (!(deps.verifyConsolePeer ?? verifyConsolePeer)(consoleEntry, { fs, uid })) return refuse("the installed admin's pi peer is missing, unsafe or differs from the worker's exact pin. Install the matching pinned pi-coding-agent package before bootstrap.");
	const pre = deploymentPreflight({ fs, env, cwd, platform, uid, refuse, consoleTokensPath: deps.consoleTokensPath, readTokens: deps.readTokens });
	if (pre.refused !== undefined) return pre.refused;
	const { dir, read, target, tokensPath, existing } = pre;
	const units = installedUnitPaths(platform, home).filter((row) => row.which === "console" && fs.existsSync(row.path));
	let consolePlan;
	const serviceDeps = { ...deps, cwd: dir, env, platform, euid: uid, home, fs, resolveConsole: () => consoleEntry, setupConsoleGrant: true };
	for (const unit of units) {
		try {
			if (unit.scope !== "user") return refuse("a console unit already exists without this exact setup grant or for another deployment. Review it and reinstall explicitly with service install --console --host-setup --force.");
			consolePlan = await (deps.consoleServicePlan ?? planServiceSetup)(["start", "--console"], serviceDeps);
			if (!consolePlan || consolePlan.refusal || typeof consolePlan !== "object") return refuse("the existing console unit or loaded manager command differs from this exact setup grant. Review it and reinstall explicitly with service install --console --host-setup --force.");
		} catch { return refuse("the existing console service could not be validated."); }
	}
	if (!(await serviceManagerAnswers({ run, platform, uid, dir, env }))) return refuse("the account's user service manager did not answer. Start it before console bootstrap.");
	const operators = existing?.tokens.filter((entry) => entry.role === "operator") ?? [];
	const named = flagValue(argv, "--name");
	const choiceProblem = operatorChoiceProblem(named, operators);
	if (choiceProblem) return refuse(choiceProblem);
	let name = operators.length === 1 ? operators[0].name : null;
	if (operators.length > 1) {
		name = named;
		if (name === null) {
			out(`Operator entries: ${operators.map((row) => row.name).join(", ")}\n`);
			name = String(await prompt("Name the operator entry for this setup link: ")).trim();
		}
		if (!operators.some((row) => row.name === name)) return refuse("no existing operator was selected; nothing was changed.");
	}
	if (operators.length === 0) {
		// No prompt: nobody who has not used this before knows what the name is for, and `--name` is there for anyone who does.
		name = named ?? "operator";
		const nameProblem = newOperatorNameProblem(name, existing);
		if (nameProblem) return refuse(nameProblem);
	}
	let yes = argv.includes("--yes");
	// Only with no `.env`: the question's list says "start the queue", and on a deployment already in use `--yes` can restart a live one.
	if (!yes && !argv.includes("--ask-each") && operators.length === 0 && units.length === 0 && !fs.existsSync(join(dir, ".env"))) {
		const answer = await askFirstRun({ dir, installing: false, prompt, out });
		if (answer === "no") { out("Console bootstrap declined; nothing was changed.\n"); return 0; }
		yes = answer === "yes";
	}
	out("Console bootstrap will grant this account's console bounded local host setup (--host-setup). It starts the console service; the worker is started only by a separate confirmed action.\n");
	if (!yes && !/^y(es)?$/i.test(String(await prompt("Proceed with console bootstrap? [y/N] ")).trim())) { out("Console bootstrap declined; nothing was changed.\n"); return 0; }
	const upCode = await deps.runUpFn([...upArgvOf(argv).filter((arg) => arg !== "--yes"), ...(yes ? ["--yes"] : [])], { ...deps, cwd: dir, skipNextSteps: true });
	if (!fs.existsSync(join(dir, ".env"))) return refuse(`up did not finish, so no token or console unit was made. Fix what it printed above, then run ${commandsHere(dir, fs).worker} up --console`);
	const logRead = deploymentServiceEnv({ env: {}, dir, keys: ["PI_LOGS_DIR"], fs, uid, platform });
	const audit = deps.audit ?? makeConsoleAudit({ logsDir: resolve(dir, logsDirPath(logRead.env)), fs, now: deps.now ?? Date.now });
	if (operators.length === 0) {
		try { audit.append({ actor: { name: "shell", role: "shell", session: null }, action: "token-added", target: name, outcome: "ok" }); }
		catch { return refuse("the audit log could not be written, so no operator token was created."); }
		const made = (deps.addToken ?? addToken)({ path: tokensPath, name, role: "operator", fs, uid, now: deps.now ?? Date.now });
		if (made.invalid) {
			try { audit.append({ actor: { name: "shell", role: "shell", session: null }, action: "token-added", target: name, outcome: "failed", reason: "token-write-refused" }); } catch { /* The failed write is still reported by the command. */ }
			return refuse(`the operator entry could not be created; inspect the token file and use ${commandsHere(dir, fs).console} token add in the host terminal.`);
		}
		delete made.token;
		// Deliberately retain the hash only; recovering another link needs the account's CLI, not this plaintext.
		out(`Created operator entry ${name}; its durable plaintext was discarded.\n`);
	} else out(`Using existing operator entry ${name}.\n`);
	const service = deps.runServiceFn ?? runService;
	const serviceRow = { actor: { name: "shell", role: "shell", session: null }, action: "write", kind: units.length ? "setup-console-start" : "setup-console-install", target: "console", outcome: "ok" };
	try { audit.append(serviceRow); } catch { return refuse("the audit log could not be written, so the console service was not changed; the operator entry remains."); }
	const code = await service([units.length ? "start" : "install", "--console", ...(!units.length ? ["--host-setup"] : [])], { ...serviceDeps, ...(consolePlan ? { setupExpected: consolePlan } : {}) });
	const before = commandsHere(dir, fs);
	const recovery = `${before.console} link --deployment ${shellWord(dir)} --name ${name}${target.kind === "unix" ? " --port 4790" : ""} --next /setup`;
	if (code !== 0) {
		try { audit.append({ ...serviceRow, outcome: "failed", reason: "console-start-refused" }); } catch { /* Never repeat an uncertain service action for its audit row. */ }
		return refuse(`the operator entry remains, but the console service did not start. Fix it with ${before.worker} service install --console --host-setup; then ${recovery}`);
	}
	const ready = await waitForConsole(read.env, { probe: deps.probeConsole ?? probeConsole, now: deps.now ?? Date.now, ms: deps.consoleWaitMs ?? 15_000, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
	if (!ready) return refuse(`the console did not answer within the startup bound. Its token/unit remain. Once it answers, run ${recovery}`);
	ensureConsoleShortcut(dir, fs);
	const here = commandsHere(dir, fs);
	if (upCode !== 0) out("Doctor reports remaining setup. Continue on /setup.\n");
	// Before `open`, which waits for the browser: this is the line someone needs later, and it must not wait behind a prompt.
	out(`Get back in any time: ${here.worker} console\n`);
	// The wizard signs the person in itself, so a second link here would be one more live code for nothing.
	if (argv.includes("--no-open")) return 0;
	const opened = await (deps.consoleOpen ?? attachedCommand)(process.execPath, [consoleEntry, "open", "--deployment", dir, "--name", name, ...(target.kind === "unix" ? ["--port", "4790"] : []), "--next", "/setup"], { cwd: dir, env });
	if (opened !== 0) return refuse(`the console runs but no sign-in was opened. Run ${recovery}`);
	return 0;
}
