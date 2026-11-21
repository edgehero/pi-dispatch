/**
 * What `pi-dispatch status` says of the poller (issue #970): `{ expected, hosts, complete, note?, local? }`.
 *
 * In #970 a poller restarted on an invalid triggers.json exited 2 and stayed down, while the worker kept its old
 * schedules and `status` looked healthy. This is the half of the answer `status` can give: the pollers' heartbeats
 * (poller-status.mjs) read from Valkey, set beside what this deployment says (`GITHUB_INGEST`) and this host's own copy
 * of the triggers file.
 *
 *  - `expected`: whether this deployment polls GitHub, by `GITHUB_INGEST` read as `run --trigger` reads its settings
 *    (`cliDeploymentEnv`: this shell, else `./.env`): true for `poll` and `both`, false for `webhook` (under which a
 *    poller refuses to start), null when unset, since the receiver then infers it and a poller is the operator's word.
 *    A poller on any host satisfies it: the poller is one per deployment, not one per host.
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
import { githubIngestFrom } from "./config.mjs";
import { readPollerStatus, triggersDigest } from "./poller-status.mjs";
import { cliDeploymentEnv } from "./service-env.mjs";
import { judgeDeploymentTriggers } from "./triggers-cli.mjs";

/** When a poller reads its file again, by its record: the next cycle's start, or the cycle it is in. */
function rereadAt(host) {
	return host.nextAt === null ? "within its current cycle" : `by ${new Date(host.nextAt).toISOString()}`;
}

/** The sentence for one readable heartbeat, or null when it runs on this host's copy of the current file. */
function hostNote(host, who, local) {
	if (host.triggers === "kept") {
		const kept = `${who}: running on the previous triggers.json`;
		if (host.refusal === "missing") return `${kept}, the current file is missing where it runs`;
		if (host.refusal === "unreadable") return `${kept}, the current file cannot be read where it runs`;
		if (local !== null && host.rejected === local.digest) {
			return local.reason !== null
				? `${kept}, the current file is invalid: ${local.reason}`
				: `${kept}, it refused the current file, which this host's check takes: its settings differ from this shell's, so run pi-dispatch triggers check where it runs`;
		}
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
		const deployment = cliDeploymentEnv(env, ["GITHUB_INGEST"], { cwd, platform, readFile: readEnv });
		if (deployment.problem) problems.push(deployment.problem);
		else {
			const ingest = githubIngestFrom(deployment.env);
			facts.expected = ingest === null ? null : ingest !== "webhook";
		}
	} catch (error) {
		// A GITHUB_INGEST every receiver command refuses: githubIngestFrom's own sentence, which shows no long value.
		problems.push(error?.message ?? String(error));
	}
	if (facts.expected === true || hosts.length > 0) {
		// This host's copy, judged as `pi-dispatch triggers check` judges it: the reason a poller refuses it, if one does.
		let local = null;
		try {
			const judged = await judge({ env, cwd, platform, readEnv, readText, now });
			if (judged.problem) problems.push(judged.problem);
			else {
				const reasons = judged.result.refusals.filter((r) => r.readers.includes("poller")).map((r) => r.reason);
				local = { digest: triggersDigest(judged.text), reason: reasons.length > 0 ? reasons.join("; ") : null };
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
