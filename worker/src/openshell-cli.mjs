/**
 * The openshell venue's facts that need no run path (issue #683): the tested release and the judgement of the gateway's
 * `status -o json`, shared by the adapter (worker/src/backend-openshell.mjs) and doctor (doctor-openshell.mjs). A leaf
 * with no imports, so doctor reads them without loading the run path and pi with it.
 */

/** The OpenShell release this adapter was measured on: doctor's floor and ceiling (issue #683), one place. */
export const OPENSHELL_TESTED_VERSION = "0.1.4";

/**
 * The gateway's answer to "where are you" (`openshell status -o json`), judged: `{ connected, local, server, version }`.
 * `status` exits 0 even when the gateway is down (measured), so the JSON's own `status` decides `connected`. Local means
 * a loopback host or a unix socket; anything else, or a server this cannot parse, is not local.
 */
export function judgeGatewayStatus(doc) {
	const status = typeof doc?.status === "string" ? doc.status : null;
	const server = typeof doc?.server === "string" ? doc.server : null;
	let local = false;
	if (server !== null) {
		if (server.startsWith("unix:")) local = true;
		else {
			try {
				const host = new URL(server).hostname.replace(/^\[|\]$/g, "");
				local = host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
			} catch {
				local = false;
			}
		}
	}
	return { connected: status === "connected" || status === "connected_http", local, server, version: typeof doc?.version === "string" ? doc.version : null };
}
