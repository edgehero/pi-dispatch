/**
 * What an error reply's code says of its cause, as a leaf: no import, so the modules that word a sentence on a code can
 * each take it (the Valkey client module re-exports it beside `replyErrorCode`, where a reader of a reply finds both;
 * the CLI and the admin's words import it here, without the client).
 */

/**
 * WHAT A REPLY'S CODE SAYS OF ITS CAUSE (issue #1036), the one table every sentence built on a code asks, so that
 * none claims more than the code supports. Each error reply was worded as a key of the wrong type: an ACL user without
 * HGETALL made doctor say "that key is not a host's row" and "remove or repair the key" of healthy rows (NOPERM), and
 * a script that kept Valkey busy for nine seconds was said as a cause waiting does not end while the same read was
 * whole three seconds later (BUSY). Four classes:
 *
 *   key         WRONGTYPE. The key holds another kind of value. Lasting: waiting does not change it. The remedy names
 *               the key: remove or repair it.
 *   permission  NOPERM, NOAUTH, WRONGPASS. The Valkey user this process connects as may not run the command or read
 *               the key, or is not signed in. Lasting. The remedy is that user's ACL or the credentials, never the
 *               key, which may be perfectly sound.
 *   passing     BUSY, LOADING, TRYAGAIN, CLUSTERDOWN, MASTERDOWN. Valkey could not serve the command just then (a
 *               script running past its threshold, a dataset still loading, a cluster moving a slot or without its
 *               primary). Waiting may end it, so "try again" is true here and nowhere else, and there is nothing to
 *               repair.
 *   other       Every other code (ERR, READONLY, OOM, MISCONF, NOSCRIPT, the word "error" for a reply without one).
 *               Said as it is: Valkey answered with that code. Nothing is claimed of how long it lasts and no remedy
 *               is named. READONLY is here on purpose: whether a write refused by a replica passes depends on a
 *               failover this client cannot see.
 *
 * `lasting` is true, false, or null where nothing is known. `means` is what a sentence may say of the cause, `remedy`
 * what it may tell a person to do (a caller that knows the key names it), and `waiting` the clause it may add about
 * waiting; each is null where the class supports no such claim.
 */
export const REPLY_ERROR_CLASSES = Object.freeze({
	key: Object.freeze({ lasting: true, means: "the key holds another kind of value", remedy: "remove or repair the key", waiting: "Waiting does not change that" }),
	permission: Object.freeze({ lasting: true, means: "the Valkey user this connects as may not run the command or read the key", remedy: "give that Valkey user the permission in its ACL, or connect as a user that has it", waiting: "Waiting does not change that" }),
	passing: Object.freeze({ lasting: false, means: "Valkey could not serve the command just then", remedy: "try again", waiting: "A later read may succeed" }),
	other: Object.freeze({ lasting: null, means: null, remedy: null, waiting: null }),
});

const REPLY_CODE_CLASS = Object.freeze({ WRONGTYPE: "key", NOPERM: "permission", NOAUTH: "permission", WRONGPASS: "permission", BUSY: "passing", LOADING: "passing", TRYAGAIN: "passing", CLUSTERDOWN: "passing", MASTERDOWN: "passing" });

/**
 * The class of a reply's code (`REPLY_ERROR_CLASSES`' key): "key", "permission", "passing", or "other" for every code
 * the table does not name, a value that is no code among them. A code is `replyErrorCode`'s word, compared whole.
 */
export function replyErrorClass(code) {
	return typeof code === "string" && Object.hasOwn(REPLY_CODE_CLASS, code) ? REPLY_CODE_CLASS[code] : "other";
}

/** The codes the table names, by class, for a text that lists them (a tool's description, the docs' own test). */
export const REPLY_CODES_BY_CLASS = Object.freeze(Object.fromEntries(Object.keys(REPLY_ERROR_CLASSES).map((name) => [name, Object.freeze(Object.keys(REPLY_CODE_CLASS).filter((code) => REPLY_CODE_CLASS[code] === name))])));
