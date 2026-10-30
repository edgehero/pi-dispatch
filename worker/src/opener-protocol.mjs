/** Secret-free terminal handoff. No URL field is ever interpreted as a command or configuration. */
import { WORKER_NAME_RE } from "./worker-name.mjs";

export const SANDBOX_OPEN_VERBS = Object.freeze(["open", "attach"]);
export const SANDBOX_OPEN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export function sandboxOpenFields({ verb, id, host } = {}) {
	if (!SANDBOX_OPEN_VERBS.includes(verb)) throw new Error("the opener verb must be open or attach");
	if (typeof id !== "string" || !SANDBOX_OPEN_ID_RE.test(id)) throw new Error("the opener id is not a run or sandbox id");
	if (typeof host !== "string" || !WORKER_NAME_RE.test(host) || /\.(?:json|log)$/i.test(host)) throw new Error("the opener host is not a worker name");
	return { verb, id, host };
}
export function sandboxOpenUrl(fields) {
	const { verb, id, host } = sandboxOpenFields(fields);
	return `pi-dispatch-open://${verb}/${encodeURIComponent(id)}?host=${encodeURIComponent(host)}`;
}
export const buildSandboxOpenUrl = sandboxOpenUrl;
export function parseSandboxOpenUrl(value) {
	if (typeof value !== "string" || value.length > 1024) throw new Error("the opener link is invalid");
	// Match the wire grammar before URL normalisation can hide a path traversal or a second decoding.
	const match = /^pi-dispatch-open:\/\/(open|attach)\/([^/?#]+)\?host=([^&#]+)$/.exec(value);
	if (!match) throw new Error("the opener link must name one open or attach verb, id and host");
	let fields;
	try { fields = sandboxOpenFields({ verb: match[1], id: decodeURIComponent(match[2]), host: decodeURIComponent(match[3]) }); }
	catch (error) { throw new Error(error instanceof URIError ? "the opener link has invalid encoding" : error.message); }
	if (sandboxOpenUrl(fields) !== value) throw new Error("the opener link is not canonical");
	return fields;
}
