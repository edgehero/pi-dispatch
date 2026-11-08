/**
 * `pi-dispatch console`: get me into the console (issue #849). One command to remember, whatever state things are in.
 *
 * The work is split by who owns what. This side owns the service: is the console answering, and if not, can it be started. The admin's
 * `pi-dispatch-console open` owns the credential: which operator, the audit row, the one-time code and the browser. So a code is minted
 * only by the package that has always minted one.
 *
 * It starts a service that is already installed and stopped, because that is what someone typing this wants, and starting one is not a
 * new grant: the unit exists because they installed it. It never installs one, which is `up --console`'s decision and asks first.
 */
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attachedCommand, commandsHere, waitForConsole } from "./console-bootstrap.mjs";
import { makeConsoleAudit } from "./console-audit.mjs";
import { consoleProbeTarget, probeConsole } from "./console-probe.mjs";
import { logsDirPath } from "./config.mjs";
import { findOnPath, installedConsoleUnitPath, resolveConsoleEntry, runService } from "./service.mjs";
import { deploymentServiceEnv } from "./service-env.mjs";
import { consoleTokensPathFor } from "./service.mjs";
import { readTokensFile, tokenNames } from "./console-tokens.mjs";

const SHELL = Object.freeze({ name: "shell", role: "shell", session: null });

const USAGE = "usage: pi-dispatch console [--name <name>] [--next /setup] [--port <n>] [--deployment <dir>]\n";

export async function runConsoleOpen(argv, deps = {}) {
	const fs = deps.fs ?? nodeFs;
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const uid = deps.euid ?? process.geteuid?.();
	const home = deps.home ?? homedir();
	const out = deps.out ?? ((text) => process.stdout.write(text));
	const refuse = (text) => { out(`pi-dispatch console: ${text}\n`); return 2; };
	// Strict, as the console's own command is: a misread flag here would start a service or sign in the wrong person.
	let values;
	try { ({ values } = parseArgs({ args: argv, options: { deployment: { type: "string" }, name: { type: "string" }, next: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h" } } })); }
	catch (e) { return refuse(`${e?.message ?? "the arguments could not be read"}; run pi-dispatch console --help`); }
	if (values.help) { out(USAGE); return 0; }
	// Free refusals first: a typo must not start a service and write a row before anyone finds out.
	if (values.deployment === "") return refuse("--deployment needs a folder.");
	if (values.next !== undefined && values.next !== "/setup") return refuse("--next must be /setup.");
	if (values.port !== undefined && !(/^\d{1,5}$/.test(values.port) && Number(values.port) >= 1 && Number(values.port) <= 65535)) return refuse("--port must be a port number (1 to 65535).");
	const realpath = fs.realpathSync;
	const from = realpath(deps.cwd ?? process.cwd());
	let dir;
	try { dir = realpath(resolve(from, values.deployment ?? ".")); }
	catch { return refuse("that deployment folder does not exist."); }
	const here = commandsHere(dir, fs, { from });
	if (!fs.existsSync(join(dir, ".env"))) return refuse(values.deployment === undefined ? "this folder is not a deployment. Run this from your deployment folder, or pass --deployment <dir>." : "that folder is not a deployment: it has no .env.");
	// Read whatever `--name` says: a file the admin would refuse, or a choice it could not make, is known now, before a service starts.
	let tokens = null;
	try { tokens = (deps.readTokens ?? readTokensFile)({ path: (deps.consoleTokensPath ?? consoleTokensPathFor)(dir, platform), fs, uid }); } catch { /* the admin's own read says what is wrong */ }
	if (tokens?.refusal) return refuse(`the console tokens file cannot be used: ${tokens.refusal}. Run ${here.worker} doctor.`);
	if (tokens?.file) {
		// `tokenNames`: an entry kept for a role this build does not know is no missing name, and the admin explains it (issue #761).
		if (values.name !== undefined && !tokenNames(tokens.file).includes(values.name)) return refuse(`there is no token named "${values.name}" in this deployment.`);
		const operators = tokens.file.tokens.filter((entry) => entry.role === "operator").length;
		if (values.name === undefined && operators !== 1) return refuse(operators === 0 ? `there is no operator token yet. Run ${here.worker} up --console.` : `there are ${operators} operator tokens, so name one with --name <name>.`);
	}
	// env-internal PATH: find the installed admin binary, as `up --console` does.
	const consoleEntry = (deps.resolveConsole ?? (() => resolveConsoleEntry({ findBin: (name) => findOnPath(name, env.PATH), realpath })))();
	if (!consoleEntry) return refuse(`the console package is not installed here. Run ${here.worker} up --console in your deployment folder to set it up.`);

	// PI_LOGS_DIR too: the service start's row and the sign-in's row must land in one audit chain.
	const shellConsoleKeys = Object.keys(env).filter((key) => key.startsWith("PI_CONSOLE_") || key === "PI_LOGS_DIR");
	const read = deploymentServiceEnv({ env: {}, dir, keys: [...new Set(["PI_CONSOLE_LISTEN", "PI_LOGS_DIR", ...shellConsoleKeys])], fs, uid, platform });
	if (read.untrusted || (read.unreadable && read.unreadable !== "ENOENT")) return refuse(`this deployment's .env is unsafe or cannot be read. Run ${here.worker} doctor in this folder.`);
	// The admin's `open` reads this shell's values first; the probe and the service read the file. Two answers would put the link, or the
	// code, somewhere the running console never looks.
	if (shellConsoleKeys.some((key) => env[key] !== read.env[key])) return refuse("console settings in this shell differ from the deployment's .env. Unset them here.");
	const target = consoleProbeTarget(read.env.PI_CONSOLE_LISTEN);
	if (target.unknown) return refuse("the console has no concrete local address (PI_CONSOLE_LISTEN), so no link could reach it.");

	const probe = deps.probeConsole ?? probeConsole;
	if ((await probe(read.env)).state !== "running") {
		// This deployment's own unit, never just any console unit on the account: another's could carry a `--host-setup` grant.
		if ((deps.consoleUnit ?? installedConsoleUnitPath)({ platform, home, cwd: dir }) === null) return refuse(`the console is not running, and no service for this deployment is installed. Run ${here.worker} up --console to set it up, or ${here.console} serve to run it in this terminal.`);
		out("The console is not running. Starting its service.\n");
		const audit = deps.audit ?? makeConsoleAudit({ logsDir: resolve(dir, logsDirPath(read.env)), fs, now: deps.now ?? Date.now });
		const row = { actor: SHELL, action: "write", kind: "setup-console-start", target: "console", outcome: "ok" };
		try { audit.append(row); } catch { return refuse(`the audit log could not be written, so the console service was not started. Run ${here.worker} doctor.`); }
		const started = await (deps.runServiceFn ?? runService)(["start", "--console"], { cwd: dir, env, platform, euid: uid, home, fs, resolveConsole: () => consoleEntry });
		if (started !== 0) {
			try { audit.append({ ...row, outcome: "failed", reason: "console-start-refused" }); } catch { /* the refusal below is what the person must see */ }
			return refuse(`the console service did not start. ${here.worker} service status --console says why.`);
		}
		const ready = await waitForConsole(read.env, { probe, now: deps.now ?? Date.now, ms: deps.consoleWaitMs ?? 15_000, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
		if (!ready) return refuse(`the console service started but did not answer in time. ${here.worker} service status --console says why.`);
	}

	const passed = [];
	for (const flag of ["name", "next", "port"]) if (values[flag] !== undefined) passed.push(`--${flag}`, values[flag]);
	// A unix socket has no port of its own; 4790 is the local end of the tunnel the printed `ssh -L` line sets up.
	if (target.kind === "unix" && values.port === undefined) passed.push("--port", "4790");
	const code = await (deps.consoleOpen ?? attachedCommand)(process.execPath, [consoleEntry, "open", "--deployment", dir, ...passed], { cwd: dir, env });
	return typeof code === "number" ? code : refuse("the console command could not be started.");
}
