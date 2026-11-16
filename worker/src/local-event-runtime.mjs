import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseTriggersDocument } from "./triggers.mjs";
import { buildLocalEventJob, localEventDigest, localEventJobId, validLocalEvent } from "./local-event.mjs";
import { localRunData } from "./local-job.mjs";

export class LocalEventWait extends Error {
	constructor(untilMs) { super("local event is waiting for its debounce window"); this.untilMs = untilMs; }
}

const refusal = (reason) => ({ outcome: "policy", reason, budgetReserved: false });

/** Re-read authority at pickup and again immediately before the first credential operation. */
export function makeLocalEventRuntime({ store, triggersPath, worker, readFile = readFileSync, now = Date.now }) {
	return {
		store,
		async check(job) {
			const meta = job.data?.localEvent;
			if (!validLocalEvent(meta) || job.data.kind !== "local" || localEventJobId(meta.generation) !== job.id) return refusal("local-event-invalid");
			if (meta.worker !== worker || job.data.worker !== worker) return refusal("local-event-wrong-worker");
			let doc, text;
			try { text = readFile(triggersPath, "utf8"); }
			catch (error) { if (error?.code === "ENOENT") return refusal("local-event-trigger-changed"); throw error; }
			try { doc = parseTriggersDocument(text, triggersPath); }
			catch (error) { return error.newer ? { newer: true } : refusal("local-event-config-invalid"); }
			const raw = JSON.parse(text);
			const index = raw.triggers.findIndex((t) => t?.on?.id === meta.id && t.on.forge === meta.forge && t.run?.kind === "local");
			if (index < 0) return refusal("local-event-trigger-changed");
			let trigger = doc.triggers[index];
			if (raw.triggers[index].on.disarmed !== undefined) {
				if (raw.triggers[index].on.disarmed.jobId !== job.id) return refusal("once-already-spent");
				delete raw.triggers[index].on.disarmed;
				trigger = parseTriggersDocument(JSON.stringify(raw), triggersPath).triggers[index];
			}
			if (localEventDigest(trigger) !== meta.digest || !isDeepStrictEqual(localRunData(trigger.run), localRunData(job.data))) return refusal("local-event-trigger-changed");
			const expected = buildLocalEventJob(trigger, meta.generation);
			if (!isDeepStrictEqual(expected.localEvent, meta)) return refusal("local-event-invalid");
			const state = await store.read(meta);
			if (!state || state.current.generation !== meta.generation) return refusal("local-event-superseded");
			if (state.current.cancelled) return refusal("operator-cancel");
			if (typeof store.ready === "function") {
				const ready = await store.ready(meta);
				if (ready.untilMs) return { untilMs: ready.untilMs };
				return ready.ok ? { ok: true, index } : refusal(ready.cancelled ? "operator-cancel" : "local-event-superseded");
			}
			return state.current.phase === "pending" && state.current.dueAt > now() ? { untilMs: state.current.dueAt } : { ok: true, index };
		},
		async claim(job, owner) {
			const result = await this.check(job);
			if (result.untilMs) throw new LocalEventWait(result.untilMs);
			if (!result.ok) return result;
			const claimed = await store.claim(job.data.localEvent, owner);
			if (claimed.untilMs) throw new LocalEventWait(claimed.untilMs);
			return claimed.ok ? { ok: true } : refusal(claimed.cancelled ? "operator-cancel" : "local-event-superseded");
		},
	};
}
