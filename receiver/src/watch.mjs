import { makeWatchVerifiedHandler } from "./verify-watch.mjs";
import { parseWatchFinding, matchesWatchFinding, watchFingerprint } from "@edgehero/pi-dispatch/watch-contract";
import { respond } from "@edgehero/pi-dispatch/http-body";
import { createHash } from "node:crypto";

/** Push and pull share the same deterministic admission; collector text is discarded by default. */
export async function ingestWatchFinding({ cfg, store, enqueue, source, finding, delivery, log = () => {}, redact = () => "[redacted]", signature = "verified" }) {
	const sources = cfg.watchSources ?? cfg.triggers?.watchSources ?? {};
	if (!Object.hasOwn(sources, source)) throw new Error("watch source not configured");
	const declared = sources[source];
	const safeFinding = parseWatchFinding({ ...finding, samples: finding.samples.map(sample => redact(sample)) });
	const rules = cfg.watchTriggers ?? cfg.triggers?.watch ?? [];
	const results = [];
	// Validate every matching identity before any rule can enqueue, so one malformed finding
	// cannot partially start work and then receive a determinate bad-input response.
	for (const entry of rules) { const rule = entry.on ?? entry; if (rule.source === source && matchesWatchFinding(rule, safeFinding)) watchFingerprint(source, rule, safeFinding); }
	for (const entry of rules) {
		const rule = entry.on ?? entry;
		if (rule.source !== source) continue;
		if (!matchesWatchFinding(rule, safeFinding)) {
			await store.recordVerdict?.(rule.id, source, "unmatched");
			continue;
		}
		const policyDigest = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
		const result = await store.ingest({ source, rule, finding: { ...safeFinding, policyDigest }, delivery, sourceMaxPerDay: declared.maxPerDay });
		if (entry.run?.issue && store.noteIssueActivity) await store.noteIssueActivity({ target: entry.run.issue, source, ruleId: rule.id, fingerprint: result.fingerprint ?? watchFingerprint(source, rule, safeFinding) });
		await store.recordVerdict?.(rule.id, source, result.status);
		if (result.id && store.appendTrace) {
			const traceId = createHash("sha256").update(JSON.stringify([source, rule.id, delivery])).digest("hex");
			await store.appendTrace(result.id, { id: `${traceId}-stream`, kind: "stream", source, signature, count: safeFinding.count, fingerprint: result.fingerprint });
			await store.appendTrace(result.id, { id: `${traceId}-rule`, kind: "rule", ruleId: rule.id, status: result.status, checks: { match: "passed", threshold: "at-window-end", cooldown: result.status === "suppressed" ? "active" : "passed", cap: result.status === "capped" ? "refused" : "passed" } });
		}
		if (result.status === "held") await enqueue({ id: result.id, ruleId: rule.id, dueAt: result.dueAt });
		log("watch_delivery", { source, trigger: rule.id, fingerprint: result.fingerprint?.slice(0, 12), verdict: result.status });
		results.push({ trigger: rule.id, ...result });
	}
	const status = results.some(x => x.status === "held") ? "held" : results.some(x => x.status === "capped") ? "capped" : results.some(x => x.status === "suppressed") ? "suppressed" : "unmatched";
	return { status, results };
}

/** Config is read per request so a reviewed source removal takes effect without restarting. */
export function makeWatchHandler({ cfg, store, enqueue, env = process.env, now = () => Date.now(), log = () => {}, redact = () => "[redacted]" }) {
	return async function watchHandler(req, res, namedSource) {
		const source = namedSource ?? String(req.url ?? "").split("?")[0].match(/^\/watch\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
		const sources = cfg.watchSources ?? cfg.triggers?.watchSources ?? {};
		if (!source || !Object.hasOwn(sources, source)) return respond(res, 404, { error: "watch source not configured" });
		const declared = sources[source]; const secret = env[declared.secretEnv];
		if (typeof secret !== "string" || !secret) return respond(res, 503, { error: "watch source secret unavailable" });
		const verified = makeWatchVerifiedHandler({ secret, bodyLimit: declared.maxBodyBytes, now, log: (_event, fields) => log("watch_signature", { source, ...fields }) }, async ({ rawBody, delivery }, reply) => {
			let finding;
			try { finding = parseWatchFinding(JSON.parse(rawBody)); } catch { return respond(reply, 400, { error: "invalid watch finding" }); }
			if (finding.source !== undefined && finding.source !== source) return respond(reply, 400, { error: "finding source mismatch" });
			try {
				const result = await ingestWatchFinding({ cfg, store, enqueue, source, finding, delivery, log, redact });
				return respond(reply, 202, result);
			} catch (error) { if (error?.piDispatchConfig) return respond(reply, 400, { error: "invalid watch finding" }); throw error; }
		});
		return verified(req, res);
	};
}
