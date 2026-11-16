// Safe record identity only. Keep schema, configuration and filesystem imports out of the history reader.
import { FORGE_KINDS } from "./forges.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const LOCAL_EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LOCAL_EVENT_GENERATION_RE = /^[a-f0-9]{32}$/;
export const LOCAL_EVENT_WORKER_RE = WORKER_NAME_RE;

export function validLocalEvent(value) {
	return !!value && LOCAL_EVENT_ID_RE.test(value.id ?? "") && FORGE_KINDS.includes(value.forge)
		&& ["label", "comment", "pull_request", "issue"].includes(value.type) && LOCAL_EVENT_WORKER_RE.test(value.worker ?? "")
		&& /^[a-f0-9]{64}$/.test(value.digest ?? "") && LOCAL_EVENT_GENERATION_RE.test(value.generation ?? "");
}
