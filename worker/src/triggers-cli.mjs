/**
 * `pi-dispatch triggers check [file]` (issue #970): judge a triggers file by the rules its readers load it by
 * (`checkTriggersText`, triggers-check.mjs), before it is moved over the file they run. It writes nothing and tells no
 * service anything: a running worker, receiver or poller reloads the file itself once it changes.
 *
 * WHICH FILE: `[file]` when given, else the deployment's, by doctor's rule (`triggersPath`: `PI_TRIGGERS_FILE`, else
 * `./triggers.json` here), which is `run --trigger`'s. A candidate is judged against the deployment's environment in
 * either case, because that is what will load it once it is moved into place. The deployment's current file is read
 * too, when it is another file, for one fact: whether a watch collector runs on it (a pull source).
 *
 * WHICH ENVIRONMENT, from one read of `./.env`, in two halves read two ways:
 *  - The keys the check judges by (`TRIGGERS_CHECK_ENV_KEYS`) through `cliDeploymentEnv`, as `run --trigger` reads its
 *    own: this shell's value, else the `.env`'s here, and a disagreement or a line the service's loader may read
 *    otherwise is refused, since the file would then be judged for a service that is not the one that runs. So is a key
 *    this shell sets and a `.env` that is there has no line for (issue #970), since the services read the `.env`; with no
 *    `.env` at all, this shell's settings are the deployment's.
 *  - The secrets the check asks about (`triggersCheckSecrets`: each watch source's variable, and `WEBHOOK_SECRET` where
 *    `serve` serves GitHub), for their PRESENCE only, through `resolveServiceEnv` over the same two places, never
 *    through `cliDeploymentEnv`, whose disagreement message prints both values (service-env.mjs). The same rule: a
 *    variable set in one place and unset or blank in the other cannot be judged and is refused, naming no value (doctor
 *    judges this shell's then and says the two disagree; a verdict for one of two services would be a guess). That
 *    includes a variable this shell sets and the `.env` does not have at all (issue #970): the services read the
 *    `.env`, so taking this shell's value passed a file their loader refuses. One the `.env` sets and this shell does not
 *    is the `.env`'s, which is what the services read. What reaches the check is a mark per variable (unset, empty,
 *    blank or set) and the judged keys, never a value.
 *
 * EXIT: 0 when every reader that would load the file here takes it; 1 when one refuses (one `error:` line per refusal,
 * naming its readers, then what a start on it would do) or when the file cannot be judged at all (no file, an unreadable
 * one, an argument this command does not take, a deployment `.env` it cannot read the keys from), as every other
 * `pi-dispatch` refusal before work does, and 1 with the usage when no subcommand is given, so a script that forgot
 * `check` moves nothing. Never 2: that is `EXIT_POLICY`, a service's refusal to start that its supervisor must not
 * retry, and this command starts nothing.
 *
 * `run --trigger` keeps its own reading of the file: firing a cron job has nothing to do with a watch source's secret.
 */
import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliDeploymentEnv, resolveServiceEnv, serviceEnvFileOf, serviceEnvLoader } from "./service-env.mjs";
import { TRIGGERS_CHECK_ENV_KEYS, TRIGGERS_READERS, checkTriggersText, triggersCheckSecrets } from "./triggers-check.mjs";
import { parseTriggersDocument } from "./triggers.mjs";

const USAGE = `pi-dispatch triggers check [file]
    judge a triggers file by the rules the worker, the receiver (serve), the poller and the watch collector load it
    by, before you move it over the file they run: [file], else PI_TRIGGERS_FILE, else ./triggers.json here, against
    this deployment's settings (this shell, else ./.env, refused where the two disagree). Exit 0 when every one of them
    that reads it here takes it; exit 1 names each that refuses and why. It changes nothing: running services reload
    the file themselves.
`;

/** `a`, `a and b`, `a, b and c`. */
function listed(words, last = "and") {
	return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

/** A value's presence by the two tests its readers make (trimmed for the loaders, falsy for the poller's stand-in). */
function presenceMark(value) {
	if (typeof value !== "string") return undefined;
	if (value === "") return "";
	return value.trim() === "" ? " " : "set";
}

const MARK_WORDS = { "": "empty", " ": "blank", set: "set" };

/**
 * `names` resolved from this shell and the `.env` (`file`, a `serviceEnvFileOf` result, null, or the error its read
 * threw) as presence marks: `{ env }`, or `{ problem }` when one cannot be told, a value never in either.
 */
function secretMarks(names, { env, envPath, file }) {
	if (names.length === 0) return { env: {} };
	if (file instanceof Error) {
		const unset = names.filter((k) => typeof env[k] !== "string");
		if (file.code !== "ENOENT" && unset.length > 0) return { problem: `${envPath} could not be read (${file.code ?? "error"}), so whether ${listed(unset)} ${unset.length === 1 ? "is" : "are"} set cannot be told` };
	}
	const read = resolveServiceEnv({ env, file: file instanceof Error ? null : file, keys: names });
	const unread = [...read.unread.map((u) => u.key), ...read.hazardSkipped];
	if (unread.length > 0) return { problem: `${envPath} has a line for ${listed(unread)} that the service's loader may read differently, so whether ${unread.length === 1 ? "it is" : "they are"} set cannot be told (pi-dispatch doctor names the line)` };
	// Set in this shell and absent from the .env (issue #970): a service reading the .env runs without it, so judging this
	// shell's value would pass a file the services refuse at their start. Empty here and absent there are both unset to
	// every reader, and are judged so.
	const shellOnly = read.shellOnly.filter((k) => presenceMark(env[k]) !== "");
	if (shellOnly.length > 0) return { problem: `${listed(shellOnly)} ${shellOnly.length === 1 ? "is" : "are"} set in this shell and not in ${envPath} (no value is shown), and the services read the .env, so whether ${shellOnly.length === 1 ? "it is" : "they are"} set for them cannot be told: add ${shellOnly.length === 1 ? "it" : "them"} to the .env, or unset ${shellOnly.length === 1 ? "it" : "them"} in this shell` };
	// Two values that are both set are no business of this command's: presence is all it judges.
	const split = read.disagreements.filter((d) => presenceMark(d.shell) !== presenceMark(d.file));
	if (split.length > 0) return { problem: `${split.map((d) => `${d.key} is ${MARK_WORDS[presenceMark(d.shell)]} in this shell and ${MARK_WORDS[presenceMark(d.file)]} in ${envPath}`).join("; ")} (neither value is shown), so whether ${split.length === 1 ? "it is" : "they are"} set cannot be told: make them agree (the service runs the file's)` };
	return { env: Object.fromEntries(names.map((key) => [key, presenceMark(read.env[key])])) };
}

/** `5 triggers (2 cron, 2 forge, 1 watch, 1 spent one-shot)`. */
function countsText({ triggers, cron, forge, watch }) {
	const spent = triggers - cron - forge - watch;
	const parts = [`${cron} cron`, `${forge} forge`, `${watch} watch`, ...(spent > 0 ? [`${spent} spent one-shot${spent === 1 ? "" : "s"}`] : [])];
	return `${triggers} trigger${triggers === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/**
 * The deployment's environment read, the file read and the check run, as `triggers check` does them: `file` (resolved
 * against `cwd`) when given, else the deployment's own triggers file. Returns `{ path, text, result }` (`result` is
 * `checkTriggersText`'s) or `{ problem }`, a sentence saying why the file could not be judged, never a value; with
 * `path` and `text` beside it where the file was read and only judging it failed. Shared with `pi-dispatch status`
 * (issue #970), which judges the deployment's file this way to say why a poller keeps an older copy, and compares the
 * text's digest with the copy the poller refused even where this shell cannot judge it.
 *
 * `secrets`, when given, limits the secrets resolved from this shell and the `.env` to those names; any other the check
 * asks about is judged unset and never resolved, so a disagreement on it cannot leave the file unjudged. `triggers
 * check` resolves every one. `status` passes the only one a poller's start judges (issue #994: a watch source's secret
 * is `serve`'s alone), and keeps only refusals that name the poller, so an unset one adds nothing it reads.
 */
export async function judgeDeploymentTriggers({ file = undefined, env = process.env, cwd = process.cwd(), platform = process.platform, readEnv = (p) => readFileSync(p), readText = (p) => readFileSync(p, "utf8"), existsSync = fsExistsSync, now = Date.now, check = checkTriggersText, secrets: only = null } = {}) {
	// One read of the deployment `.env` for both halves, so the two cannot be judged from two different files.
	const envPath = join(cwd, ".env");
	let envRead;
	try {
		envRead = readEnv(envPath);
	} catch (error) {
		envRead = error instanceof Error ? error : new Error(String(error));
	}
	const deployment = cliDeploymentEnv(env, TRIGGERS_CHECK_ENV_KEYS, { cwd, platform, readFile: () => {
		if (envRead instanceof Error) throw envRead;
		return envRead;
	} });
	if (deployment.problem) return { problem: `${deployment.problem}, so the file cannot be judged as this deployment's services load it` };
	let envFile = envRead;
	if (!(envRead instanceof Error)) {
		try {
			envFile = serviceEnvFileOf(envRead, envPath, serviceEnvLoader(platform));
		} catch (error) {
			envFile = error instanceof Error ? error : new Error(String(error));
		}
	}
	// A setting this shell sets and the .env has no line for (issue #970): the services read the .env, so judging with this
	// shell's value would pass a file they refuse, or refuse one they take. Refused like a secret, once the file is read.
	// With no .env at all there is nothing to differ from, and this shell's settings are the deployment's as before.
	const shellOnly = envFile instanceof Error ? [] : resolveServiceEnv({ env, file: envFile, keys: TRIGGERS_CHECK_ENV_KEYS }).shellOnly;
	// Empty in this shell and absent from the .env is unset, as for a secret: the services run without it. Dropped, never
	// judged as empty, since an empty setting can mean something an absent one does not (an empty PI_TRIGGERS_FILE is a
	// refusal to every reader, an absent one is ./triggers.json).
	const settingsHere = shellOnly.filter((key) => env[key] !== "");
	const serviceEnv = shellOnly.length === 0 ? deployment.env : Object.fromEntries(Object.entries(deployment.env).filter(([key]) => !shellOnly.includes(key)));
	const { triggersPath } = await import("./doctor.mjs");
	const deployed = triggersPath(serviceEnv, cwd);
	const path = file !== undefined ? resolve(cwd, file) : deployed;
	const one = settingsHere.length === 1;
	const settingsProblem = `${listed(settingsHere)} ${one ? "is" : "are"} set in this shell and not in ${envPath} (no value is shown), and the services read the .env, so the file cannot be judged as they load it: add ${one ? "it" : "them"} to the .env, or unset ${one ? "it" : "them"} in this shell`;
	if (path === "") return { problem: "PI_TRIGGERS_FILE is set to an empty value, so there is no file to judge, and every reader refuses to start on it: set it to the file, or delete the line" };
	let text;
	try {
		text = readText(path);
	} catch (error) {
		// The settings first: a file missing where the services look may be one this shell's PI_TRIGGERS_FILE points past.
		if (settingsHere.length > 0) return { problem: settingsProblem };
		return { problem: error?.code === "ENOENT" ? `no triggers file at ${path}` : `${path} could not be read (${error?.code ?? "error"})` };
	}
	if (settingsHere.length > 0) return { path, text, problem: settingsProblem };
	// Whether a watch collector runs here, from the file it runs on now; nothing when that is this very file, or unread.
	let currentCollects = false;
	if (deployed !== "" && deployed !== path) {
		try {
			currentCollects = Object.values(parseTriggersDocument(readText(deployed), deployed).watchSources ?? {}).some((s) => s.pull);
		} catch {}
	}

	const judged = Object.fromEntries(TRIGGERS_CHECK_ENV_KEYS.filter((k) => typeof serviceEnv[k] === "string").map((k) => [k, serviceEnv[k]]));
	const asked = triggersCheckSecrets(text, path, judged);
	const secrets = secretMarks(only === null ? asked : asked.filter((name) => only.includes(name)), { env, envPath, file: envFile });
	if (secrets.problem) return { path, text, problem: secrets.problem };
	return { path, text, result: check(text, path, { env: { ...judged, ...secrets.env }, existsSync, cwd, now, currentCollects }) };
}

export async function runTriggers(argv = [], deps = {}) {
	const {
		env = process.env,
		cwd = process.cwd(),
		platform = process.platform,
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		readEnv = (p) => readFileSync(p),
		readText = (p) => readFileSync(p, "utf8"),
		existsSync = fsExistsSync,
		now = Date.now,
		check = checkTriggersText,
	} = deps;
	const sub = argv[0];
	if (sub === "--help" || sub === "-h" || sub === "help") {
		out(USAGE);
		return 0;
	}
	if (sub !== "check") {
		err(sub === undefined ? USAGE : `pi-dispatch triggers: unknown subcommand ${JSON.stringify(sub)}\n${USAGE}`);
		return 1;
	}
	const args = argv.slice(1);
	if (args.includes("--help") || args.includes("-h")) {
		out(USAGE);
		return 0;
	}
	// A file whose name starts with a dash is written ./-name, as for any command: a flag is never read as a path.
	const flag = args.find((a) => a.startsWith("-"));
	if (flag !== undefined) {
		err(`error: pi-dispatch triggers check takes no flag (got ${JSON.stringify(flag)})\n${USAGE}`);
		return 1;
	}
	if (args.length > 1) {
		err(`error: pi-dispatch triggers check takes one file (got ${args.length})\n${USAGE}`);
		return 1;
	}

	const judged = await judgeDeploymentTriggers({ file: args[0], env, cwd, platform, readEnv, readText, existsSync, now, check });
	if (judged.problem) {
		err(`error: ${judged.problem}\n`);
		return 1;
	}
	const { path, result } = judged;
	if (result.ok) {
		const who = result.readers.map((r) => `the ${r}`);
		out(`${path}: ${countsText(result.counts)}. ${listed(who).replace(/^t/, "T")} ${who.length === 1 ? "takes" : "take"} it, and running ones reload it themselves.\n`);
		for (const note of result.notes) out(`note: ${note}\n`);
		return 0;
	}
	for (const { readers, reason } of result.refusals) err(`error: ${listed(readers.map((r) => `the ${r}`))} ${readers.length === 1 ? "refuses" : "refuse"} it: ${reason}\n`);
	for (const note of result.notes) err(`note: ${note}\n`);
	const refusing = [...new Set(result.refusals.flatMap((r) => r.readers))];
	const starting = TRIGGERS_READERS.filter((r) => refusing.includes(r));
	err(`A ${listed(starting, "or")} started on ${path} refuses to start (exit 2, not restarted); one already running keeps the last copy that loaded.\n`);
	return 1;
}
