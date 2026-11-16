import { createHash } from "node:crypto";
import { localRunData } from "./local-job.mjs";
import { withJobDataVersion } from "./job-data-version.mjs";
import { LOCAL_EVENT_ID_RE, LOCAL_EVENT_GENERATION_RE, LOCAL_EVENT_WORKER_RE } from "./local-event-identity.mjs";
import { FORGE_KINDS } from "./forges.mjs";

export { LOCAL_EVENT_ID_RE, LOCAL_EVENT_GENERATION_RE, LOCAL_EVENT_WORKER_RE, validLocalEvent } from "./local-event-identity.mjs";
export const LOCAL_EVENT_MAX_AGE_MS = 300_000;

function ordered(value) {
	if (Array.isArray(value)) return value.map(ordered);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, ordered(value[key])]));
	return value;
}

/** The reviewed definition, independent of row position and object property order. Disarm is checked separately. */
export function localEventDigest(trigger) {
	const { disarmed: _disarmed, ...on } = trigger.on;
	return createHash("sha256").update(JSON.stringify(ordered({ on, run: trigger.run }))).digest("hex");
}

export function localEventIdentity({ id, forge }) {
	if (!LOCAL_EVENT_ID_RE.test(id ?? "") || !FORGE_KINDS.includes(forge)) throw new Error("invalid local event identity");
	return createHash("sha256").update(JSON.stringify([forge, id])).digest("hex");
}

export function localEventJobId(generation) {
	if (!LOCAL_EVENT_GENERATION_RE.test(generation ?? "")) throw new Error("invalid local event generation");
	return `local-event-${generation}`;
}

/** No payload, actor or last-event target: a generation can stand for several repositories and items. */
export function buildLocalEventJob(trigger, generation) {
	const { on, run } = trigger;
	localEventIdentity({ id: on.id, forge: on.forge });
	localEventJobId(generation);
	if (run.kind !== "local" || typeof run.command !== "string" || !LOCAL_EVENT_WORKER_RE.test(run.worker ?? "")) throw new Error("invalid local event execution");
	return withJobDataVersion({
		...localRunData(run),
		localEvent: { id: on.id, forge: on.forge, type: on.type, worker: run.worker, digest: localEventDigest(trigger), generation, ...(on.once === true && { once: true, number: on.number }) },
		trigger: { id: on.id },
	});
}
