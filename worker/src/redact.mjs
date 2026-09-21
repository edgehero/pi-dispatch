/**
 * Take credentials out of a subprocess's own words, so a fault line can carry them (issue #339).
 *
 * IMPORT-FREE, and it has to stay that way. `backend-registry.mjs` and `retention-sweep.mjs` import nothing
 * at all today, and this is their first import; a heavy one would pull the docker adapter into every graph
 * that reaches `reapAll`. Same shape as `transient.mjs`, which says the same thing about itself.
 *
 * WHY A SCRUBBER AND NOT A FIXED TOKEN, which is the other shape this repo already uses
 * (`classifyEndpointFailure` classifies on values and never reads stderr). The twelve call sites are not one
 * kind of error. Five carry filesystem faults where the message IS the diagnosis (`EACCES: permission
 * denied, scandir '/var/lib/...'`), and two exist to catch a throwing FACTORY, where `makeSandboxReaperFn is
 * not a function` is the entire value of the line. A token would delete the diagnosis at most sites to
 * protect three. A byte COUNTER (`secrets.mjs`) is right where the text is always secret-adjacent; here it
 * is usually not.
 *
 * THE RULE IS THE URL GRAMMAR, never any runtime's prose, so Podman's different wording and its own
 * connection URIs (`ssh://user@host:22/run/user/1000/podman/podman.sock`) are covered by construction.
 * Nothing here mentions docker, a daemon, a context or an exit code.
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied. A credential holding whitespace or a bare quote that
 * the runtime printed UNQUOTED: both docker and podman print an unparseable endpoint through Go's `%q`,
 * which quotes and escapes it, and the quoted rule covers that exactly. Closing the unquoted case needs a
 * rule that crosses whitespace, and such a rule eats the useful half of every line holding an unrelated `@`.
 * It also does not catch a secret that is not in a userinfo position: a bearer token echoed as a bare word,
 * a registry auth blob, the contents of a key. And it deliberately keeps the HOST, which is the fact an
 * operator needs and is never credential material.
 */

/**
 * `scheme://userinfo@host` inside a Go `%q`-quoted region, where `\X` is an escape rather than a delimiter.
 * Both runtimes print an endpoint they could not parse this way, and it is the only form that survives a
 * credential containing whitespace or a quote.
 */
const QUOTED_USERINFO = /"([a-z][a-z0-9+.-]*:\/\/)?(?:[^"\\\n]|\\.)*@/gi;
/** The same, unquoted: a run of non-delimiter characters up to and including the LAST `@` in it. */
const BARE_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)?[^\s"'`<>]*@/gi;
/** The account segment of a home path, which an identity-file error carries (no-pii-in-logs). */
const POSIX_HOME = /(\/(?:home|Users)\/)[^/\s"'`<>:,;]+/g;
const WINDOWS_HOME = /([A-Za-z]:\\Users\\)[^\\\s"'`<>,;]+/g;

/**
 * The cap. Applied AFTER scrubbing, never before: a cut that lands inside a credential leaves its prefix,
 * which is the whole failure mode this file exists to prevent.
 */
export const SCRUBBED_MAX = 300;

/** Any `"..."` region, so a fragment repeated outside its URL can be checked against what was just taken. */
const QUOTED_REGION = /"((?:[^"\\\n]|\\.)*)"/g;
/** Below this, a fragment is too short to redact elsewhere without eating the diagnosis around it. */
const MIN_ECHOED = 2;

/**
 * A subprocess's message with anything in a userinfo position, and any home-directory account, replaced.
 *
 * TWO PASSES, because one is not enough against a MEASURED error. Go's URL parser quotes the offending
 * fragment a second time in its own words: `parse "ssh://bob:pa?ss@remote": invalid port ":pa" after host`.
 * The first pass takes the userinfo inside the URL and leaves `":pa"` standing beside it. So whatever the
 * first pass removed is treated as a known secret for the rest of the string, and any QUOTED region that is
 * a substring of it goes too.
 *
 * QUOTED regions only, and a length floor, because the safe direction here has a cost: a one-character
 * password would otherwise redact every occurrence of that character and destroy the diagnosis this file
 * exists to preserve. A fragment shorter than two characters, or one echoed UNQUOTED, survives -- stated
 * rather than claimed away, and neither runtime is known to echo one that way.
 */
export function scrubCredentials(value) {
	if (typeof value !== "string" || value === "") return "unknown";
	const taken = [];
	const remember = (m, scheme) => {
		taken.push(m);
		return `${scheme ?? ""}[redacted]@`;
	};
	let out = value
		.replace(QUOTED_USERINFO, (m, scheme) => `"${remember(m.slice(1), scheme)}`)
		.replace(BARE_USERINFO, remember)
		.replace(POSIX_HOME, "$1[redacted]")
		.replace(WINDOWS_HOME, "$1[redacted]");
	if (taken.length > 0) {
		out = out.replace(QUOTED_REGION, (m, inner) =>
			inner.length >= MIN_ECHOED && taken.some((t) => t.includes(inner)) ? '"[redacted]"' : m,
		);
	}
	return out.length > SCRUBBED_MAX ? `${out.slice(0, SCRUBBED_MAX)}\u2026` : out;
}
