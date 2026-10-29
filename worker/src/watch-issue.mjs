import { createHash, randomUUID } from "node:crypto";
import { watchDurationMs } from "./watch-contract.mjs";

export const WATCH_ISSUES_PER_SOURCE_MAX = 4096;
export function issueIdentity(target, source, ruleId, fingerprint) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(ruleId) || !/^[a-f0-9]{64}$/.test(fingerprint) || !["github", "gitlab", "forgejo"].includes(target?.kind) || typeof target.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) || target.repo.split("/").some(x => [".", ".."].includes(x))) throw new Error("invalid watch issue identity");
	// Quiet policy is mutable reviewed config, never part of the remote issue's permanent identity.
	return createHash("sha256").update(JSON.stringify([{ kind: target.kind, repo: target.repo }, source, ruleId, fingerprint])).digest("hex");
}
export const WATCH_ISSUE_ACTIVITY_SCRIPT = `-- watch-issue-activity
if not redis.call('GET',KEYS[2]) then return cjson.encode({at=tonumber(ARGV[1]),version=0}) end
local raw=redis.call('GET',KEYS[1]); local activity=raw and cjson.decode(raw) or {at=0,version=0}
activity.at=math.max(activity.at,tonumber(ARGV[1])); activity.version=activity.version+1
redis.call('SET',KEYS[1],cjson.encode(activity),'PX',2678400000)
local mapped=redis.call('GET',KEYS[2]); if mapped then local m=cjson.decode(mapped); if m.closeAfterMs and m.state=='mapped' then redis.call('ZADD',KEYS[3],activity.at+m.closeAfterMs,ARGV[2]) end end
return cjson.encode(activity)`;
export async function noteWatchIssueActivity(redis, { target, source, ruleId, fingerprint }, { prefix = "watch:issue", now = () => Date.now() } = {}) {
	const identity = issueIdentity(target, source, ruleId, fingerprint);
	return JSON.parse(await redis.eval(WATCH_ISSUE_ACTIVITY_SCRIPT, 3, `${prefix}:activity:${identity}`, `${prefix}:${identity}`, `${prefix}:quiet`, now(), identity));
}
const RESERVE = `-- watch-issue-reserve
local existing=redis.call('GET',KEYS[1]); if existing then return cjson.encode({owner=false,mapping=cjson.decode(existing)}) end
if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[1]) then return cjson.encode({capped=true}) end
redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); redis.call('SET',KEYS[1],ARGV[4]); return cjson.encode({owner=true,mapping=cjson.decode(ARGV[4])})`;
const CLAIM = `-- watch-issue-close-claim
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
return redis.call('SET',KEYS[3],ARGV[3],'NX','PX',30000) and 1 or 0`;
const COMMIT = `-- watch-issue-close-commit
if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end
if redis.call('GET',KEYS[1])~=ARGV[2] then return 0 end
if redis.call('GET',KEYS[2])~=ARGV[3] then return 0 end
redis.call('SET',KEYS[1],ARGV[4]); redis.call('ZREM',KEYS[4],ARGV[5]); return 1`;
const UNLOCK = `-- watch-issue-unlock
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;

/** Forge adapters own transport. Pending writes reconcile by marker, never blind-create again. */
export function makeWatchIssuePublisher({ redis, adapter, prefix = "watch:issue", now = () => Date.now(), maxPerSource = WATCH_ISSUES_PER_SOURCE_MAX, canClose = async () => false, reportClose = async () => {} }) {
	for (const method of ["findIssue", "createIssue", "updateIssue"]) if (typeof adapter?.[method] !== "function") throw new Error("watch issue adapter is incomplete");
	if (!Number.isSafeInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > WATCH_ISSUES_PER_SOURCE_MAX) throw new Error("invalid watch issue index bound");
	const activityKey = id => `${prefix}:activity:${id}`;
	const noteActivity = args => noteWatchIssueActivity(redis, args, { prefix, now });
	const schedule = async (identity, mapping) => { if (mapping.closeAfterMs) { const activity = JSON.parse(await redis.get(activityKey(identity))); await redis.zadd(`${prefix}:quiet`, activity.at + mapping.closeAfterMs, identity); } };
	const publish = async function publishWatchIssue({ source, ruleId, fingerprint, finding, target }) {
		const identity = issueIdentity(target, source, ruleId, fingerprint);
		const closeAfterMs = target.closeAfter === undefined ? undefined : watchDurationMs(target.closeAfter);
		if (closeAfterMs && typeof adapter.closeIssue !== "function") throw new Error("watch issue quiet closure unsupported");
		const key = `${prefix}:${identity}`; const marker = `pi-dispatch-watch:${identity}`;
		const pending = { state: "pending", marker, source, ruleId, fingerprint, target: { kind: target.kind, repo: target.repo }, ...(closeAfterMs ? { closeAfterMs } : {}) };
		const reserved = JSON.parse(await redis.eval(RESERVE, 2, key, `${prefix}:source:${source}`, maxPerSource, now(), identity, JSON.stringify(pending)));
		if (reserved.capped) return { status: "capped", reason: "watch-issue-cap" };
		await noteActivity({ source, ruleId, fingerprint, target });
		let mapping = reserved.mapping;
		const title = `[watch] ${ruleId} ${fingerprint.slice(0, 12)}`;
		const count = Number.isSafeInteger(finding.count) && finding.count >= 0 ? finding.count : 0;
		const severity = ["debug", "info", "warning", "error", "critical"].includes(finding.severity) ? finding.severity : "unknown";
		const body = `<!-- ${marker} -->\nWatch rule: ${ruleId}\nSource: ${source}\nFingerprint: ${fingerprint}\nSeverity: ${severity}\nEvents: ${count}\n\nA person with repository write access must apply the configured label before code work starts.`;
		if (!reserved.owner && mapping.state === "pending") {
			let found; try { found = await adapter.findIssue({ target, marker }); } catch { throw new Error("watch issue reconciliation unavailable"); }
			if (!found) return { status: "uncertain", reason: "watch-issue-uncertain" };
			mapping = { ...pending, state: "mapped", issueId: String(found.id) };
			await redis.set(key, JSON.stringify(mapping));
		}
		if (mapping.issueId !== undefined) {
			try { await adapter.updateIssue({ target, id: mapping.issueId, title, body, state: "open" }); } catch { throw new Error("watch issue update unavailable"); }
			mapping = { ...pending, state: "mapped", issueId: mapping.issueId };
			await redis.set(key, JSON.stringify(mapping)); await schedule(identity, mapping);
			if (!closeAfterMs) await redis.zrem(`${prefix}:quiet`, identity);
			return { status: "updated", issueId: mapping.issueId };
		}
		let issue; try { issue = await adapter.createIssue({ target, title, body, marker }); } catch { throw new Error("watch issue create outcome unknown"); }
		if (!issue || issue.id === undefined) throw new Error("watch issue create outcome unknown");
		mapping = { ...pending, state: "mapped", issueId: String(issue.id) };
		await redis.set(key, JSON.stringify(mapping)); await schedule(identity, mapping);
		return { status: "created", issueId: mapping.issueId };
	};
	publish.noteActivity = noteActivity;
	publish.sweep = async function sweep() {
		const outcomes = [];
		const report = async (outcome, mapping) => { outcomes.push(outcome); try { await reportClose(outcome, mapping); } catch {} };
		for (const identity of await redis.zrangebyscore(`${prefix}:quiet`, "-inf", now(), "LIMIT", 0, 128)) {
			if (!/^[a-f0-9]{64}$/.test(identity)) continue;
			const key = `${prefix}:${identity}`; const lock = `${prefix}:closing:${identity}`;
			const raw = await redis.get(key); const activityRaw = await redis.get(activityKey(identity));
			let mapping; let activity;
			try { mapping = JSON.parse(raw); activity = JSON.parse(activityRaw); } catch { await report({ identity, status: "uncertain", reason: "watch-issue-close-uncertain" }, null); continue; }
			if (!mapping?.closeAfterMs || mapping.state !== "mapped") { await redis.zrem(`${prefix}:quiet`, identity); continue; }
			if (!activity || activity.at + mapping.closeAfterMs > now()) { if (activity) await redis.zadd(`${prefix}:quiet`, activity.at + mapping.closeAfterMs, identity); continue; }
			let allowed = false; try { allowed = await canClose(mapping); } catch {}
			if (!allowed) { await redis.zrem(`${prefix}:quiet`, identity); await report({ identity, status: "suppressed", reason: "watch-issue-close-policy-changed" }, mapping); continue; }
			const token = randomUUID();
			if (!await redis.eval(CLAIM, 3, key, activityKey(identity), lock, raw, activityRaw, token)) continue;
			try {
				await adapter.closeIssue({ target: mapping.target, id: mapping.issueId });
				const closed = { ...mapping, state: "closed" };
				const committed = await redis.eval(COMMIT, 4, key, activityKey(identity), lock, `${prefix}:quiet`, token, raw, activityRaw, JSON.stringify(closed), identity);
				if (!committed) {
					// A collector advanced activity during the remote close. Reopen rather than hide that race.
					await adapter.updateIssue({ target: mapping.target, id: mapping.issueId, state: "open" });
					const current = JSON.parse(await redis.get(key));
					if (current?.state === "closed") await redis.set(key, JSON.stringify({ ...current, state: "mapped" }));
					await schedule(identity, mapping);
					await report({ identity, status: "active", reason: "watch-issue-close-raced" }, mapping);
				} else await report({ identity, status: "closed" }, mapping);
			} catch { await report({ identity, status: "uncertain", reason: "watch-issue-close-uncertain" }, mapping); }
			finally { await redis.eval(UNLOCK, 1, lock, token); }
		}
		return outcomes;
	};
	return publish;
}
