import { egressEnv } from "./egress.mjs";
import { FORGE_HOST_VARS } from "./forges.mjs";
import { KEYLESS_ENV_NAME } from "./reserved-env.mjs";

/**
 * Take a job's own secrets out of text the agent wrote, before that text leaves the host (issue #643,
 * `DES-LIVE-TRANSCRIPT-STREAM`).
 *
 * The live transcript is agent-writable, so it is untrusted data, and it can hold anything the agent saw: a
 * `printenv`, a token pasted into a curl, a header in a tool's error. `scrubCredentials` (redact.mjs) handles URL
 * userinfo and home names only, and is the wrong tool here: it keeps the useful half of a fault line, where this
 * removes VALUES this worker itself handed the container. Two rules, applied in this order:
 *
 *   1. Every secret VALUE of at least `MIN_SECRET_LENGTH` characters, in three spellings: literal, JSON-escaped
 *      (as `JSON.stringify` writes it inside a string, which is how a tool call's arguments reach the stream) and
 *      URL-encoded (`encodeURIComponent`, both hex cases, which is how a token in a query string looks). Longest
 *      first, so a value that contains another is taken whole rather than leaving its tail behind.
 *   2. Known token SHAPES, for a secret this job was never handed (a token the agent found in a repository, or one
 *      an operator forwarded under a name this rule cannot see): GitHub's five prefixes and fine-grained PATs,
 *      GitLab PATs, Anthropic and OpenAI style keys, Slack bot and user tokens, this project's own console tokens,
 *      AWS access key ids, the credential half of a `Bearer` or `Authorization:` header, and the userinfo of a
 *      URL (`scheme://user:password@`).
 *
 * A match becomes `[redacted]`. A header keeps its scheme (`Authorization: Basic [redacted]`), because the scheme
 * is what tells a reader which kind of credential was there, and it is never itself secret.
 *
 * WHY THE LENGTH FLOOR. A value shorter than eight characters is a port, a flag or a word, and replacing every
 * occurrence of it would make the transcript unreadable while protecting nothing a guess could not reach. Real
 * credentials are longer: the shortest this worker hands out is a minted forge token.
 *
 * NOT DEFENDED, named here and in SECURITY.md: a secret the agent TRANSFORMS (base64, reversed, split across two
 * tool calls, one character per line) is not caught by either rule, and cannot be by any rule that does not know
 * the transformation. Redaction bounds an accident; it is not a boundary against an agent trying to leak.
 */

/** The shortest value rule 1 takes. Shorter values pass through untouched. */
export const MIN_SECRET_LENGTH = 8;

/** What every match becomes. */
export const REDACTED = "[redacted]";

/**
 * The token shapes of rule 2. Each body has a floor long enough that an ordinary identifier with the same prefix
 * (`sk-learn`, `ghp_test`) is left alone, and each is anchored so a prefix inside a longer word (`task-...`,
 * `disk-...`) does not match.
 */
const TOKEN_SHAPES = [
	/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{16,}/g,
	/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{16,}/g,
	/(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{16,}/g,
	// `sk-ant-` is matched by the `sk-` shape too; it is listed so the intent survives a later tightening of that one.
	/(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{16,}/g,
	/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
	/(?<![A-Za-z0-9_])xox[bp]-[A-Za-z0-9-]{10,}/g,
	/(?<![A-Za-z0-9_])pdc_[A-Za-z0-9_-]{16,}/g,
	/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
];

/** `Authorization: <scheme> <credential>`, any case, quoted or not; the scheme is kept. */
const AUTHORIZATION_HEADER = /(authorization["']?\s*[:=]\s*["']?)([A-Za-z][A-Za-z0-9_-]*)(\s+["']?)([^\s"',;]+)/gi;
/** An `Authorization` header with no scheme: the whole value is the credential (`Authorization: <credential>`). */
const AUTHORIZATION_BARE = /(authorization["']?\s*[:=]\s*["']?)([^\s"',;]{8,})(?=\s*(?:["',;]|$))/gim;
/** A bare `Bearer <credential>`, where no `Authorization` precedes it (a curl `-H` split, a log line). */
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/**
 * The userinfo of a URL, `scheme://user:password@` (or a token alone before the `@`), which becomes
 * `scheme://[redacted]@`: a proxy URL an operator forwarded with credentials, a clone URL with a token in it. The
 * URL grammar of `scrubCredentials` (redact.mjs), with the scheme REQUIRED: there a fault line is short and the
 * cost of eating an e-mail address is small, while a transcript is full of addresses and `user@host` prose that
 * carry no credential. The run stops at the first `/`, `?` or `#` (the host's end), so an `@` in a path or a query
 * is never taken, and takes up to the LAST `@` before it, so a password holding a raw `@` goes whole.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'`<>]*@/gi;

/** A string's three spellings that rule 1 matches. */
function spellingsOf(value) {
	const json = JSON.stringify(value).slice(1, -1);
	const url = encodeURIComponent(value);
	const lowerUrl = url.replace(/%[0-9A-F]{2}/g, (pct) => pct.toLowerCase());
	return [value, json, url, lowerUrl];
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `makeRedactor({ values, extraPatterns? })` returns `(text) => text`. `values` is every secret this job holds
 * (`secretValuesOf` below builds it from the container env); non-strings and values under the floor are dropped.
 * `extraPatterns` are further global regexps whose whole match is redacted. Never throws: a non-string input is
 * stringified first.
 */
export function makeRedactor({ values = [], extraPatterns = [] } = {}) {
	const forms = new Set();
	for (const value of values) {
		if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
		// Every spelling is at least as long as the value, so the floor above covers them all.
		for (const form of spellingsOf(value)) forms.add(form);
	}
	// Longest first, so the alternation takes the longest value at any position: JavaScript's alternation is
	// ordered, not leftmost-longest, so `abcdefgh|abcdefghij` would leave `ij` behind.
	const sorted = [...forms].sort((a, b) => b.length - a.length);
	const literal = sorted.length > 0 ? new RegExp(sorted.map(escapeRegExp).join("|"), "g") : null;
	const shapes = [...TOKEN_SHAPES, ...extraPatterns.filter((p) => p instanceof RegExp && p.global)];
	return function redact(text) {
		let out = String(text ?? "");
		if (literal) out = out.replace(literal, REDACTED);
		out = out.replace(AUTHORIZATION_HEADER, (_, head, scheme, gap, credential) => (credential === REDACTED ? `${head}${scheme}${gap}${credential}` : `${head}${scheme}${gap}${REDACTED}`));
		out = out.replace(AUTHORIZATION_BARE, (_, head, credential) => (credential === REDACTED ? `${head}${credential}` : `${head}${REDACTED}`));
		out = out.replace(BEARER, (_, head, credential) => (credential === REDACTED ? `${head}${credential}` : `${head}${REDACTED}`));
		out = out.replace(URL_USERINFO, (_, scheme) => `${scheme}${REDACTED}@`);
		for (const shape of shapes) out = out.replace(shape, REDACTED);
		return out;
	};
}

/**
 * The container env keys that carry NO secret: everything `buildContainerEnv` (env-allowlist.mjs) writes from a
 * structural input, so a path, a flag, a model name or a count is never redacted out of a transcript.
 *
 * THE RULE IS INVERTED ON PURPOSE: every key NOT listed here is secret-bearing. That covers, by construction, the
 * minted forge token under each of its forge's names, the provider credential under whatever name pi reads it,
 * every `PI_FORWARD_ENV` variable, every resolved trigger secret and every model-endpoint key. A variable added to
 * the container env later is redacted until someone lists it here, which is the safe direction: a missing entry
 * here costs readability, a missing entry in an allowlist of secrets would cost a leak.
 *
 * Derived where a source exists: the forge host variables from `FORGE_HOST_VARS`. The rest are `buildContainerEnv`'s
 * own literals, held to it by a test that builds an env with every structural option set and finds no other key
 * outside the credential.
 *
 * NOT the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`). With the egress policy
 * armed the worker writes them itself and they are structural, but with `PI_EGRESS=0` an operator may forward them,
 * and a forwarded proxy URL can carry a password. So they are non-secret only per job, and only with the exact
 * value the worker wrote: `secretValuesOf`'s `workerSet`, which `runContainer` fills from `egressEnv` for that job.
 */
export const NON_SECRET_ENV_KEYS = new Set([
	// Issue #693: a memory-derived concurrency count, never a credential; keep it in the structural venue env.
	"PI_CODEMODE_MAX_WORKERS",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_FORK_ENTRY",
	"PI_FORK_POSITION",
	"PI_THINKING_LEVEL",
	"PI_MAX_TURNS",
	"PI_MAX_TOKENS",
	"PI_MAX_COST_MICROS",
	"PI_JOB_ID",
	"PLAYWRIGHT_BROWSERS_PATH",
	"PLAYWRIGHT_MCP_BROWSER",
	"PLAYWRIGHT_MCP_SANDBOX",
	"PI_GLOBAL_ALLOW_EXTENSIONS",
	"PI_PACKAGES",
	"PI_SESSION_FILE",
	"PI_FLOW",
	"PI_COMMAND",
	"PI_EXCLUDE_TOOLS",
	"PI_MCP_SERVERS",
	"PI_AWAIT_INPUT",
	// Approval env holds declared actions and decision identifiers only; human text stays in event.json.
	"PI_APPROVAL_GATES",
	"PI_APPROVAL_DECISION",
	"PI_REPORT_PROGRESS",
	"PI_RECOVER",
	"PI_RECOVERING",
	"PI_STEER",
	"PI_ALLOWED_MODELS",
	"PI_OFFLINE",
	"PI_EXIT_AUTH",
	// Issue #686: names the transcript channel (`stderr`), never a secret; on openshell it must ride the exec's --env.
	"PI_TRANSCRIPT",
	// Issue #704 part 3: `1`, the bundle env file's flag, never a secret; on openshell it must ride the exec's --env.
	"PI_BUNDLE_ENV",
	// Issue #683: the runner's layout name, `sandbox` on the openshell venue.
	"PI_JOB_LAYOUT",
	// Issue #730: `1`, the readable runner's flag, never a secret; on openshell it must ride the exec's --env.
	"PI_RUNNER_OBSERVABLE",
	"HOME",
	KEYLESS_ENV_NAME,
	...FORGE_HOST_VARS,
]);

/** The variables the worker writes when the egress policy is armed, by name: what `workerSet` may vouch for. */
export const EGRESS_ENV_KEYS = Object.freeze(Object.keys(egressEnv({ armed: true })));

/**
 * The secret values of one job: every container env value whose key is not in `NON_SECRET_ENV_KEYS`, plus
 * `extra` (the minted token and the exit-line key, which `runContainer` holds outside the env: the key never
 * enters it at all). `workerSet` is the env the worker itself wrote for this job's egress (`egressEnv`, empty when
 * the policy is off): a key in it counts as structural only while its value is exactly the one written there.
 * Strings only; the length floor is the redactor's.
 */
export function secretValuesOf(env = {}, extra = [], { workerSet = {} } = {}) {
	const values = [];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (NON_SECRET_ENV_KEYS.has(key)) continue;
		if (EGRESS_ENV_KEYS.includes(key) && Object.hasOwn(workerSet ?? {}, key) && workerSet[key] === value) continue;
		if (typeof value === "string" && value !== "") values.push(value);
	}
	for (const value of extra) if (typeof value === "string" && value !== "") values.push(value);
	// The password inside a URL-shaped value (a forwarded proxy, a database URL) is a secret on its own: a tool can
	// print it without its URL (`curl -U user:password`, "the password is ..."). Added raw and percent-decoded.
	for (const value of [...values]) {
		const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@\s]+)@/.exec(value);
		if (!m) continue;
		const colon = m[1].indexOf(":");
		if (colon < 0) continue;
		const password = m[1].slice(colon + 1);
		if (password !== "") values.push(password);
		try {
			const decoded = decodeURIComponent(password);
			if (decoded !== password && decoded !== "") values.push(decoded);
		} catch {
			// not valid percent-encoding: the raw form is already listed
		}
	}
	return values;
}
