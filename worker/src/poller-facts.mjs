/**
 * What `pi-dispatch status` says of the poller (issue #970): `{ expected, hosts, complete, note?, local? }`.
 *
 * In #970 a poller restarted on an invalid triggers.json exited 2 and stayed down, while the worker kept its old
 * schedules and `status` looked healthy. This is the half of the answer `status` can give: the pollers' heartbeats
 * (poller-status.mjs) read from Valkey, set beside what this deployment says (`GITHUB_INGEST`, `POLL_REPOS`) and this host's own copy
 * of the triggers file.
 *
 *  - `expected`: whether this deployment polls GitHub, `pollerExpected` (poller-status.mjs, the rule Connections asks
 *    too) over `GITHUB_INGEST` and `POLL_REPOS` read as `run --trigger` reads its settings (`cliDeploymentEnv`: this
 *    shell, else `./.env`): true for `poll` and `both`, false for `webhook` (under which a poller refuses to start), and
 *    with it unset true where `POLL_REPOS` names repositories, else null. A poller on any host satisfies it: the poller
 *    is one per deployment, not one per host.
 *  - `hosts`: each heartbeat as `readPollerStatus` reads it (the record with its `ageMs`, or `{ name, unreadable }`).
 *  - `complete`: false when the read did not finish; then an empty `hosts` proves no absence.
 *  - `note`: sentences, joined, where something needs saying. A poller that keeps an older file because it refused the
 *    current one: when the digest of what it refused is this host's file's, the reason is this host's own judgement of
 *    it (`pi-dispatch triggers check`'s, `judgeDeploymentTriggers`), since the record carries no reason (its path would
 *    reach Valkey); when it is another digest, the copy is another host's, or this one changed since. A poller on the
 *    current file whose digest is not this host's says when it reads its file again. A deployment that polls with no
 *    heartbeat over a complete read says so, with the reason a poller would refuse this host's file to start, which is
 *    #970's case: a poller older than this release publishes none, so the sentence says that too.
 *  - `local`: why this host's half could not be judged (a setting this shell and `.env` disagree on, an unreadable or
 *    missing file), never a value.
 *
 * Never throws and never fails `status`: every half that cannot be read is said, and `status` exits 0 as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubIngestFrom } from "./config.mjs";
import { pollerExpected, readPollerStatus, triggersDigest } from "./poller-status.mjs";
import { cliDeploymentEnv, resolveServiceEnv, serviceEnvFileOf, serviceEnvLoader } from "./service-env.mjs";
import { judgeDeploymentTriggers } from "./triggers-cli.mjs";

/**
 * POLL_REPOS for `pollerExpected`, asked only where GITHUB_INGEST is unset and judged by PRESENCE alone (it names
 * repositories, or it is unset or blank), since the rule asks nothing else of it: `{ value }`, this shell's where it sets
 * the key and its presence agrees with the `.env`'s, else the `.env`'s, or `{ problem }`, naming the key and no value,
 * where the two disagree on whether it names repositories or the `.env`'s line cannot be read as the service reads it.
 * Two different lists that both name repositories are no disagreement here: which ones the poller polls is not the
 * question, and a check by value would print both.
 */
function pollReposOf(env, { cwd, platform, readEnv }) {
	const envPath = join(cwd, ".env");
	const named = (value) => typeof value === "string" && value.trim() !== "";
	const shell = typeof env.POLL_REPOS === "string" ? env.POLL_REPOS : undefined;
	let file;
	try {
		file = serviceEnvFileOf(readEnv(envPath), envPath, serviceEnvLoader(platform));
	} catch (error) {
		if (error?.code !== "ENOENT" && shell === undefined) return { problem: `${envPath} could not be read (${error?.code ?? "error"}), so whether POLL_REPOS is set cannot be told` };
		return { value: shell };
	}
	const read = resolveServiceEnv({ env, file, keys: ["POLL_REPOS"] });
	if (read.unread.length > 0 || read.hazardSkipped.length > 0) return { problem: `${envPath} has a line for POLL_REPOS that the service's loader may read differently, so whether it is set cannot be told (pi-dispatch doctor names the line)` };
	if (shell === undefined) return { value: read.env.POLL_REPOS };
	const inFile = read.shellOnly.includes("POLL_REPOS") ? undefined : (read.disagreements.find((d) => d.key === "POLL_REPOS")?.file ?? shell);
	if (named(shell) !== named(inFile)) {
		const said = (value) => (named(value) ? "names repositories" : value === undefined ? "has no line" : "is blank");
		return { problem: `POLL_REPOS ${named(shell) ? "names repositories" : "is blank"} in this shell and ${said(inFile)} in ${envPath} (neither value is shown), so whether this deployment polls cannot be told: make them agree (the services read the .env)` };
	}
	return { value: shell };
}

/** When a poller reads its file again, by its record: the next cycle's start, or the cycle it is in. */
function rereadAt(host) {
	return host.nextAt === null ? "within its current cycle" : `by ${new Date(host.nextAt).toISOString()}`;
}

/**
 * The sentence for one readable heartbeat, or null when it runs on this host's copy of the current file. `local` is
 * this host's file as judged here, `{ digest, reason, unjudged }`: `unjudged` is why the file was read and could not be
 * judged (a setting or secret this shell and the `.env` disagree on), or null; `local` itself is null when the file
 * could not even be read, and then no digest is compared.
 */
function hostNote(host, who, local) {
	if (host.triggers === "kept") {
		const kept = `${who}: running on the previous triggers.json`;
		if (host.refusal === "missing") return `${kept}, the current file is missing where it runs`;
		if (host.refusal === "unreadable") return `${kept}, the current file cannot be read where it runs`;
		if (local !== null && host.rejected === local.digest) {
			if (local.reason !== null) return `${kept}, the current file is invalid: ${local.reason}`;
			if (local.unjudged !== null) return `${kept}, it refused this host's file, which cannot be judged from this shell: ${local.unjudged}`;
			return `${kept}, it refused the current file, which this host's check takes: its settings differ from this shell's, so run pi-dispatch triggers check where it runs`;
		}
		// Not read here (a setting this shell and the .env disagree on comes first, or the file would not open), so nothing is
		// compared: saying the copy is another host's would be a guess.
		if (local === null) return `${kept}; this host's file was not read here (see local), so whether the copy it refused is this one is not known: run pi-dispatch triggers check where it runs`;
		return `${kept}; the copy it refused is not this host's file (another host's copy, or this one changed since: it reads its file again ${rereadAt(host)}), so run pi-dispatch triggers check where it runs`;
	}
	if (local !== null && host.running !== local.digest) return `${who}: running on a triggers.json that is not this host's file (another host's copy, or this one changed since: it reads its file again ${rereadAt(host)})`;
	return null;
}

export async function readPollerFacts(redis, { env = process.env, cwd = process.cwd(), platform = process.platform, now = Date.now, read = readPollerStatus, judge = judgeDeploymentTriggers, readEnv = (p) => readFileSync(p), readText = (p) => readFileSync(p, "utf8") } = {}) {
	let polled;
	try {
		polled = await read(redis, { now });
	} catch {
		polled = null;
	}
	const hosts = Array.isArray(polled?.hosts) ? polled.hosts : [];
	const facts = { expected: null, hosts, complete: polled?.complete === true };
	const problems = [];
	try {
		// GITHUB_INGEST alone decides where it is set, so a POLL_REPOS this shell and the .env disagree on cannot unsay it.
		const deployment = cliDeploymentEnv(env, ["GITHUB_INGEST"], { cwd, platform, readFile: readEnv });
		if (deployment.problem) problems.push(deployment.problem);
		else if (githubIngestFrom(deployment.env) !== null) facts.expected = pollerExpected(deployment.env);
		else {
			const repos = pollReposOf(env, { cwd, platform, readEnv });
			if (repos.problem) problems.push(repos.problem);
			else facts.expected = pollerExpected({ ...deployment.env, POLL_REPOS: repos.value });
		}
	} catch (error) {
		// A GITHUB_INGEST every receiver command refuses: githubIngestFrom's own sentence, which shows no long value.
		problems.push(error?.message ?? String(error));
	}
	if (facts.expected === true || hosts.length > 0) {
		// This host's copy, judged as `pi-dispatch triggers check` judges it: the reason a poller refuses it, if one does.
		// WEBHOOK_SECRET is the one secret a poller's start judges (a blank one where serve serves GitHub); a watch source's
		// secret is `serve`'s alone (issue #994), so it is not resolved here and a shell that disagrees with the .env on it
		// leaves the poller's answer judged.
		let local = null;
		try {
			const judged = await judge({ env, cwd, platform, readEnv, readText, now, secrets: ["WEBHOOK_SECRET"] });
			if (judged.problem) problems.push(judged.problem);
			// A file read and not judged still has its digest: a poller that refused it refused this host's file.
			if (typeof judged.text === "string") {
				const reasons = judged.problem ? [] : judged.result.refusals.filter((r) => r.readers.includes("poller")).map((r) => r.reason);
				local = { digest: triggersDigest(judged.text), reason: reasons.length > 0 ? reasons.join("; ") : null, unjudged: judged.problem ?? null };
			}
		} catch (error) {
			problems.push(`this host's triggers file could not be judged (${error?.code ?? "error"})`);
		}
		const notes = [];
		for (const host of hosts) {
			const who = hosts.length > 1 ? `poller on ${host.name}` : "poller";
			if (host.unreadable) notes.push(`${who}: its heartbeat cannot be read (written by another release, or damaged)`);
			else {
				const note = hostNote(host, who, local);
				if (note !== null) notes.push(note);
			}
		}
		if (facts.expected === true && hosts.length === 0) {
			if (!facts.complete) notes.push("poller: the heartbeats could not be read completely, so whether a poller runs is not known");
			else {
				const refused = local?.reason ? `; the current triggers.json is invalid, so a poller started on it refuses to start (exit 2): ${local.reason}` : "";
				notes.push(`poller: no poller has published a heartbeat (a poller older than this release publishes none)${refused}`);
			}
		}
		if (notes.length > 0) facts.note = notes.join("; ");
	}
	if (problems.length > 0) facts.local = problems.join("; ");
	return facts;
}
