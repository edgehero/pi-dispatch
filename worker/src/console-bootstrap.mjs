/** A terminal-only composition of existing bootstrap, token, service and login-link commands (#774). */
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConsoleEntry, findOnPath, consoleTokensPathFor, installedUnitPaths, planServiceSetup, runService } from "./service.mjs";
import { addToken, readTokensFile, TOKEN_NAME_RE } from "./console-tokens.mjs";
import { makeConsoleAudit } from "./console-audit.mjs";
import { deploymentServiceEnv } from "./service-env.mjs";
import { logsDirPath } from "./config.mjs";
import { probeConsole, consoleProbeTarget } from "./console-probe.mjs";
import { resolveSetupWorkerEntry, setupCachePath, trustedSetupFile } from "./setup-host-entry.mjs";

function command(bin, args, options = {}) {
	return new Promise((done) => {
		try { execFile(bin, args, { ...options, timeout: 15_000, maxBuffer: 65536, killSignal: "SIGKILL" }, (error, stdout) => done({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout: String(stdout ?? "") })); }
		catch { done({ code: null, stdout: "" }); }
	});
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

export async function runConsoleUp(argv, deps = {}) {
	const fs = deps.fs ?? nodeFs;
	const env = deps.env ?? process.env;
	const cwd = deps.cwd ?? process.cwd();
	const platform = deps.platform ?? process.platform;
	const uid = deps.euid ?? process.geteuid?.();
	const home = deps.home ?? homedir();
	const out = deps.out ?? ((text) => process.stdout.write(text));
	const prompt = deps.prompt ?? (await import("./up.mjs")).defaultPrompt;
	const run = deps.consoleCommand ?? command;
	const refuse = (text) => { out(`up --console: ${text}\n`); return 2; };
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
	if (!["linux", "darwin"].includes(platform) || (platform === "darwin" && uid === 0)) return refuse("browser host setup needs a Linux user systemd manager or your macOS LaunchAgent session; use terminal setup on this platform.");
	let dir;
	try {
		dir = fs.realpathSync(cwd);
		const st = fs.statSync(dir);
		if (st.uid !== uid || (st.mode & 0o022)) return refuse("the deployment directory must belong to this account and be writable by this account alone.");
	} catch { return refuse("the deployment directory could not be validated."); }
	const declaredConsoleKeys = [...new Set(["PI_CONSOLE_LISTEN", "PI_CONSOLE_TOKENS_FILE", "PI_LOGS_DIR", ...Object.keys(env).filter((key) => key.startsWith("PI_CONSOLE_"))])];
	const read = deploymentServiceEnv({ env: {}, dir, keys: declaredConsoleKeys, fs, uid, platform });
	if (read.untrusted || read.unreadable && read.unreadable !== "ENOENT" || read.unread?.length || read.hazardSkipped?.length) return refuse("the deployment environment is unsafe or ambiguous; correct it before console bootstrap.");
	if (declaredConsoleKeys.some((key) => typeof env[key] === "string" && env[key] !== read.env[key])) return refuse("console settings in this shell differ from the deployment service's environment. Unset the shell overrides before bootstrap.");
	const target = consoleProbeTarget(read.env.PI_CONSOLE_LISTEN);
	if (target.unknown) return refuse("the console needs a concrete local port or private socket so its one-time setup link can be reached.");
	if (target.kind === "unix") {
		try { const parent = fs.lstatSync(dirname(target.path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) return refuse("the console socket's parent must be a private directory owned by this account."); }
		catch { return refuse("the console socket's private parent directory must exist before bootstrap."); }
	}
	const tokensPath = (deps.consoleTokensPath ?? consoleTokensPathFor)(dir, platform);
	let existing = null;
	try { if (fs.existsSync(tokensPath)) { const got = (deps.readTokens ?? readTokensFile)({ path: tokensPath, fs, uid }); if (got.refusal) return refuse("the console tokens file is unsafe or invalid; correct it before bootstrap."); existing = got.file; } }
	catch { return refuse("the console tokens file could not be inspected."); }
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
	const manager = await run(platform === "linux" ? "systemctl" : "launchctl", platform === "linux" ? ["--user", "show-environment"] : ["print", `gui/${uid}`], { cwd: dir, env });
	if (manager.code !== 0) return refuse("the account's user service manager did not answer. Start it before console bootstrap.");
	const operators = existing?.tokens.filter((entry) => entry.role === "operator") ?? [];
	let name = operators.length === 1 ? operators[0].name : null;
	if (operators.length > 1) {
		out(`Operator entries: ${operators.map((row) => row.name).join(", ")}\n`);
		name = String(await prompt("Name the operator entry for this setup link: ")).trim();
		if (!operators.some((row) => row.name === name)) return refuse("no existing operator was selected; nothing was changed.");
	}
	if (operators.length === 0) {
		name = argv.includes("--yes") ? "operator" : String(await prompt("Name the new operator entry [operator]: ")).trim() || "operator";
		if (!TOKEN_NAME_RE.test(name) || existing?.tokens.some((row) => row.name === name)) return refuse("choose an unused valid operator name; nothing was changed.");
	}
	out("Console bootstrap will grant this account's console bounded local host setup (--host-setup). It starts the console service; the worker is started only by a separate confirmed action.\n");
	if (!argv.includes("--yes") && !/^y(es)?$/i.test(String(await prompt("Proceed with console bootstrap? [y/N] ")).trim())) { out("Console bootstrap declined; nothing was changed.\n"); return 0; }
	const upCode = await deps.runUpFn(argv.filter((arg) => arg !== "--console"), { ...deps, cwd: dir });
	if (!fs.existsSync(join(dir, ".env"))) return refuse("up left no deployment .env, so no token or console unit was made; finish pi-dispatch up first.");
	const logRead = deploymentServiceEnv({ env: {}, dir, keys: ["PI_LOGS_DIR"], fs, uid, platform });
	const audit = deps.audit ?? makeConsoleAudit({ logsDir: resolve(dir, logsDirPath(logRead.env)), fs, now: deps.now ?? Date.now });
	if (operators.length === 0) {
		try { audit.append({ actor: { name: "shell", role: "shell", session: null }, action: "token-added", target: name, outcome: "ok" }); }
		catch { return refuse("the audit log could not be written, so no operator token was created."); }
		const made = (deps.addToken ?? addToken)({ path: tokensPath, name, role: "operator", fs, uid, now: deps.now ?? Date.now });
		if (made.invalid) {
			try { audit.append({ actor: { name: "shell", role: "shell", session: null }, action: "token-added", target: name, outcome: "failed", reason: "token-write-refused" }); } catch { /* The failed write is still reported by the command. */ }
			return refuse("the operator entry could not be created; inspect the token file and use pi-dispatch-console token add in the host terminal.");
		}
		delete made.token;
		// Deliberately retain the hash only; recovering another link needs the account's CLI, not this plaintext.
		out(`Created operator entry ${name}; its durable plaintext was discarded.\n`);
	} else out(`Using existing operator entry ${name}.\n`);
	const service = deps.runServiceFn ?? runService;
	const serviceRow = { actor: { name: "shell", role: "shell", session: null }, action: "write", kind: units.length ? "setup-console-start" : "setup-console-install", target: "console", outcome: "ok" };
	try { audit.append(serviceRow); } catch { return refuse("the audit log could not be written, so the console service was not changed; the operator entry remains."); }
	const code = await service([units.length ? "start" : "install", "--console", ...(!units.length ? ["--host-setup"] : [])], { ...serviceDeps, ...(consolePlan ? { setupExpected: consolePlan } : {}) });
	const recovery = `pi-dispatch-console link --deployment ${shellWord(dir)} --name ${name}${target.kind === "unix" ? " --port 4790" : ""} --next /setup`;
	if (code !== 0) {
		try { audit.append({ ...serviceRow, outcome: "failed", reason: "console-start-refused" }); } catch { /* Never repeat an uncertain service action for its audit row. */ }
		return refuse(`the operator entry remains, but the console service did not start. Fix it with pi-dispatch service install --console --host-setup; then ${recovery}`);
	}
	const now = deps.now ?? Date.now;
	const wait = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	const probe = deps.probeConsole ?? probeConsole;
	const until = now() + (deps.consoleWaitMs ?? 15_000);
	let ready = false;
	do { if ((await probe(read.env)).state === "running") { ready = true; break; } if (now() >= until) break; await wait(250); } while (true);
	if (!ready) return refuse(`the console did not answer within the startup bound. Its token/unit remain. Once it answers, run ${recovery}`);
	const link = await run(process.execPath, [consoleEntry, "link", "--deployment", dir, "--name", name, ...(target.kind === "unix" ? ["--port", "4790"] : []), "--next", "/setup"], { cwd: dir, env });
	if (link.code !== 0 || !/^http:\/\/[^\s]+\/login\/code#[A-Za-z0-9_-]{43}&next=\/setup\s*$/.test(link.stdout.trim())) return refuse(`the console runs but no setup link was produced. Run ${recovery}`);
	if (target.kind === "unix") out(`Reach this private socket through your tunnel first: ssh -L 4790:${shellWord(target.path)} <this host>\n`);
	out(`${link.stdout.trim()}\nOpen it within 60 seconds; it works once. To make another link: ${recovery}\nTo replace the durable token: pi-dispatch-console token rotate --deployment ${shellWord(dir)} --name ${name}\n`);
	if (upCode !== 0) out("Doctor reports remaining setup. Continue on /setup.\n");
	return 0;
}
