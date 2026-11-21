import { readFileSync } from "node:fs";

/**
 * This receiver package's own version, from its package.json, for the display records both entry points publish: the
 * receiver's (`serve`, receiver/src/start.mjs) and, since issue #970, the poller's heartbeat (receiver/src/poller.mjs).
 * One read for both, so the two records of one install cannot name different versions. An unreadable file is "", which
 * each record's own rule then refuses to publish rather than name a version it does not know.
 */
export const RECEIVER_VERSION = (() => {
	try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? ""; }
	catch { return ""; }
})();
