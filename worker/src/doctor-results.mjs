/**
 * Doctor's results, per host, in Valkey (issue #712, `INT-DOCTOR-RESULTS-KEY`, `DES-DOCTOR-RESULTS-PUBLISHED`).
 *
 *   doctor:hosts        SET of host names that have published: an index the READER prunes, as `host:live` is
 *   doctor:h:<name>     STRING, one JSON record of that host's last doctor run, kept 7 days from its last publish
 *
 * Every `pi-dispatch doctor` run publishes (unless `--no-publish`), and the worker runs one itself at boot and once a
 * day (`doctor-spawner.mjs`). The console's Fleet page and the `/dispatch` panel read the records back, so a sentence
 * that used to say "run pi-dispatch doctor for the reason" can quote the reason, and a host nobody is looking at still
 * says what is wrong with it.
 *
 * A STRING HOLDING ONE JSON RECORD, NOT A HASH, and that is the choice the registry did not make. A doctor run is one
 * snapshot that replaces the last one whole: `SET ... PX` writes the value and its expiry in ONE command, so there is no
 * moment where the record exists without its TTL (the window `host-registry.write` has to argue about between its HSET
 * and its PEXPIRE), and no field left over from a previous run that published more checks. A HASH earns its keep for a
 * row whose fields are re-written on a beat; this record is written once a day and read whole.
 *
 * THE SAME TEST AS THE REGISTRY: delete every `doctor:*` key while the fleet runs, and every host behaves exactly as
 * before. Nothing reads these keys to decide anything: not the worker, not the receiver, and not doctor itself. They
 * are a display, and a reader that finds none says "no doctor results", never "healthy".
 *
 * THE CONTENT RULE, stricter than a terminal's. Doctor's own lines are written for the operator at the keyboard of
 * that host, and they name paths and print configured values; a published record is read by every console viewer, on
 * another machine. So what is published is:
 *   - each check's `id` (a stable name, `assignCheckIds`) and `level` (ok, warn or fail);
 *   - for a warn or a fail only, its label and its fix sentence, each REDACTED (`redactText`): an absolute path becomes
 *     `<path>`, a URL keeps its scheme and host only (never userinfo, path or query), every value of a secret-named
 *     variable in doctor's environment and every known token shape becomes `[redacted]`, control characters become
 *     spaces, and the result is capped at `DOCTOR_LABEL_MAX`;
 *   - integers, booleans, the worker version and the host name.
 * An ok check publishes its id and level and nothing else: the console shows what is wrong, and an ok line's label is
 * where doctor prints the most configuration ("Secret resolver profiles declared: a -> ..."), for nobody's benefit.
 *
 * NOT DEFENDED, and said: a secret held under a variable whose NAME does not look like one, and that has no known
 * token shape, is not recognised as a secret. Doctor's own lines do not print such values (it prints set or unset for
 * the secret service keys, and URLs through `urlShown`), so this is the second line of defence, not the first.
 */
import { DOCTOR_INTERVAL_HOURS, DOCTOR_INTERVAL_MAX_HOURS } from "./doctor-spawner.mjs";
import { makeRedactor } from "./redact-secrets.mjs";
import { WORKER_NAME_RE } from "./worker-name.mjs";

/** The index. A SET cannot expire its members, so the reader prunes, as `readLiveHosts` does for `host:live`. */
export const DOCTOR_HOSTS = "doctor:hosts";

/** One host's record. */
export const doctorKey = (name) => `doctor:h:${name}`;

/** How long a record outlives its last publish: seven days, the user's decision. Refreshed by every publish. */
export const DOCTOR_RESULTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The record's shape version. A reader refuses any other, so a later shape is "unreadable", never misread. */
export const DOCTOR_RECORD_VERSION = 1;

/** The longest published label or fix, after redaction (`scrubCredentials`'s cap, for the same reason). */
export const DOCTOR_LABEL_MAX = 300;

/** At most this many checks are listed; the rest are counted in `more`. A doctor run prints well under two hundred. */
export const DOCTOR_CHECKS_MAX = 400;

/** At most this many of them carry a label and a fix (warn and fail checks, in doctor's order). */
export const DOCTOR_DETAILED_MAX = 80;

/** At most this many hosts are read back, so a polluted index cannot make one panel tick an unbounded MGET. */
export const DOCTOR_HOSTS_MAX = 64;

/** How long any one command may take, `host-registry`'s bound and for its reason (`maxRetriesPerRequest: null`). */
const DOCTOR_OP_TIMEOUT_MS = 2_000;

/**
 * The sections a check's derived id is named by, in doctor's order. A check takes the section that was current when
 * it was added (`collectChecks` marks each boundary), and its derived id is `<section>.<n>`, its place in that section
 * on that run. Pinned by a test, so a section is never renamed or dropped in passing.
 *
 * A derived id is stable for one host's configuration and NOT across hosts: a check doctor skips on one host moves the
 * numbers after it in that section. It is a key for a list, not a contract. What a reader matches on is a NAMED id
 * (`NAMED_CHECK_IDS`), which a check carries by itself.
 */
export const DOCTOR_SECTIONS = Object.freeze([
	"node",
	"env",
	"image",
	"docker",
	"triggers",
	"dollars",
	"venues",
	"images",
	"egress",
	"backends",
	"sizing",
	"job-user",
	"podman",
	"openshell",
	"selinux",
	"forges",
	"github",
	"valkey",
	"fleet",
	"capacity",
	"provider",
	"overlay",
	"waits",
	"models",
	"secrets",
	"sessions",
	"files",
	"limits",
	"envelope",
	"console",
	"dirs",
	"state",
	"live",
]);

/**
 * The ids a reader matches on, each carried by its check in doctor.mjs (`id:`), pinned by a test against the source.
 * `<file>.file` is the SERVICE's verdict on a boot file (does the file the service reads load), `<file>.file-shell`
 * this shell's; the console quotes the first beside its own "does not load" sentence.
 */
export const NAMED_CHECK_IDS = Object.freeze([
	"triggers.file",
	"triggers.file-missing",
	"pause-windows.file",
	"pause-windows.file-shell",
	"scoped-limits.file",
	"scoped-limits.file-shell",
	"projects.file",
	"projects.file-shell",
	"model-endpoints.file",
	"model-endpoints.file-shell",
	"envelope.file",
	"envelope.file-shell",
	"settings.overlay",
	"settings.overlay-dollars",
]);

/** An id as published: a section, a dot, a name or a number, with a `-<n>` tail when a run repeated one. */
export const CHECK_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,39}$/;

/** The three levels, in doctor's own tiers (`render`): ok first, so a warning that passes is still ok. */
export const DOCTOR_LEVELS = Object.freeze(["ok", "warn", "fail"]);

/** A check's level, by `render`'s rule: `ok` is read first, then `warn`. */
export function checkLevel(check) {
	if (check?.ok) return "ok";
	return check?.warn ? "warn" : "fail";
}

/**
 * Each check's id: its own `id` where it names one, else `<section>.<n>`. A repeat (two checks naming one id, or a
 * check object added twice) gets `-2`, `-3` and so on, so no two published entries share an id; a test holds the
 * source's named ids free of repeats in the first place. `sectionOf(check)` is the section it was added in.
 */
export function assignCheckIds(checks, sectionOf = () => "env") {
	const counters = new Map();
	const seen = new Map();
	return checks.map((check) => {
		let base = typeof check?.id === "string" && CHECK_ID_RE.test(check.id) ? check.id : null;
		if (base === null) {
			const section = DOCTOR_SECTIONS.includes(sectionOf(check)) ? sectionOf(check) : "env";
			const n = (counters.get(section) ?? 0) + 1;
			counters.set(section, n);
			base = `${section}.${n}`;
		}
		const times = (seen.get(base) ?? 0) + 1;
		seen.set(base, times);
		return times === 1 ? base : `${base}-${times}`;
	});
}

/** A variable whose value is a secret by its name. The tail list keeps a path, a file, a mode or a pointer readable. */
const SECRET_NAME = /(TOKEN|SECRET|PASS|PRIVATE|API_KEY|ACCESS_KEY|_KEY$|^KEY$|_PAT$|^GITHUB_PAT|CRED|AUTH|COOKIE|SESSION|SIGNATURE)/i;
const NOT_A_SECRET = /(_PATH|_FILE|_DIR|_DIRS|_VAR|_SOURCE|_MODE|_HEADER|_URL|_ID|_TTL_DAYS|_MAX_AGE_DAYS|_MAX_CONTEXT_PCT|_MAX_RESUME_CHAIN|_MINUTES|_HOURS|_MAX_BYTES|_CAP|_TOKENS|_TIMEOUT_MS|_ROOTS|_PROFILES|_BUNDLES)$/i;
/**
 * A value that is a number or a short switch is a knob, never a credential (`PI_DAILY_TOKEN_CAP=40` matched the name
 * rule): taken as a secret, its digits would be redacted wherever they occur in a label, every count and size with them.
 */
const KNOB_VALUE = /^(?:\d+(?:\.\d+)?|true|false|on|off|yes|no)$/i;

/**
 * Every value in these environments that must never be published: each secret-named variable's value, the value of the
 * variable `GITHUB_PAT_VAR` names, and the password inside any URL-shaped value. Strings only; `makeRedactor` drops
 * anything under its eight-character floor (a port, a flag, a word).
 */
export function secretValuesIn(...envs) {
	const values = [];
	for (const env of envs) {
		for (const [key, value] of Object.entries(env ?? {})) {
			if (typeof value !== "string" || value === "") continue;
			if (SECRET_NAME.test(key) && !NOT_A_SECRET.test(key) && !KNOB_VALUE.test(value.trim())) values.push(value);
			const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@\s]+)@/.exec(value);
			if (m && m[1].includes(":")) {
				const password = m[1].slice(m[1].indexOf(":") + 1);
				if (password !== "") values.push(password);
				try {
					const decoded = decodeURIComponent(password);
					if (decoded !== password) values.push(decoded);
				} catch {
					// a malformed escape is kept as written, which is the raw form above
				}
			}
		}
		const patVar = env?.GITHUB_PAT_VAR;
		if (typeof patVar === "string" && typeof env?.[patVar] === "string" && env[patVar] !== "") values.push(env[patVar]);
	}
	return values;
}

/**
 * C0, DEL, C1, the bidi embeddings, overrides and isolates, the zero-width characters, the Arabic letter mark, the line
 * and paragraph separators and the byte-order mark: every character a terminal or a page would act on rather than show.
 * Written as escapes, so the class is readable and no invisible character sits in this source.
 */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/**
 * Characters that render as nothing (zero-width spaces and joiners, the marks, the word joiner and invisible operators,
 * the byte-order mark, the soft hyphen, the Mongolian vowel separator). DELETED rather than turned into spaces, and
 * before any other rule: one inside a token or a path (`ghp_<U+200B>...`, `/<U+200B>Users`) would otherwise split it
 * into pieces that no secret, shape or path rule recognises while a reader still sees the whole word.
 */
const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
/** A URL: a scheme, `//`, then a run up to whitespace or a delimiter. Its host part ends at the first `/`, `?` or `#`. */
const URL_RUN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'`<>()]*)/gi;
/**
 * JSON.parse's own message QUOTES the input around the bad token (measured, node 22 and 23):
 * `Unexpected token 'm', ..."prompt": mysecretpr"... is not valid JSON`. A file a loader refuses is the operator's,
 * and its text may hold a value, so the quoted run (and the token, which is one character of it) is cut to
 * `<content>`. The position forms ("in JSON at position 7 (line 1 column 8)") quote nothing and are kept.
 */
const JSON_SNIPPET = /Unexpected token '(?:[^'\\]|\\.){0,8}', (?:\.\.\.)?\\?"[\s\S]*?\\?"(?:\.\.\.)? is not valid JSON/g;
/**
 * The same quote without the token lead, anchored where a message starts (after `: ` or `(`), so a quoted value EARLIER
 * in the label (`envelope path "/a/b" must be ...`) is not swallowed from its leftmost quote.
 */
const JSON_SNIPPET_BARE = /(?<=(?:^|: |\())(?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/g;
/** The characters that end a path that is not quoted. */
const PATH_END = /[\s"'`<>()[\]{},;|]/;
/** A query parameter that carries a credential, in a URL or a bare `host/path?key=...`: its value is cut. */
const SECRET_QUERY = /([?&#;][A-Za-z0-9_.-]*(?:token|secret|key|password|passwd|pwd|sig|auth|credential)[A-Za-z0-9_.-]*=)[^&#\s"'`<>]+/gi;
/**
 * Credential forms outside a URL: `password=...` and `password: ...` (an assignment or a YAML line a parser quoted),
 * `--password <v>` and `--token=<v>` (a command a fix line names), `Basic <base64>` without its `Authorization` lead,
 * and a `*-api-key:`/`*-token:` header. Each keeps its name and loses its value.
 */
const SECRET_ASSIGN = /((?<![\w-])(?:[A-Za-z0-9]+_)*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?|(?<![\w-])secret\s*[=:]\s*["']?)[^\s"',;&]+/gi;
const SECRET_FLAG = /((?<![\w-])--(?:password|passwd|token|secret|api-key|auth-token)(?:=|\s+))[^\s"',;&]+/gi;
const BASIC_CREDENTIAL = /(\bbasic\s+)[A-Za-z0-9+/=]{8,}/gi;
const SECRET_HEADER = /(\b[\w-]*(?:api-key|-token|-secret)\s*:\s*)[^\s"',;]+/gi;
/** `user:password@host` with no scheme (an ssh or scp spelling): the userinfo is cut, the host kept. */
const BARE_USERINFO = /(?<![\w/:.@-])[A-Za-z0-9._-]+:[^\s@:/"'`<>]+@(?=[A-Za-z0-9])/g;
/** A character that, before a `/`, makes it part of a word, a ratio, a zone or a URL rather than the start of a path. */
const PATH_GLUE = /[A-Za-z0-9_.\-/\\~%+@]/;
/** Punctuation that ends a sentence rather than a path: kept after `<path>` instead of being swallowed by it. */
const TRAILING = /[.:,;!?]+$/;
const QUOTES = new Set(['"', "'", "`"]);

/** One URL as published: its scheme and host, never its userinfo, path, query or fragment. */
function urlShownForPublish(scheme, rest) {
	const end = rest.search(/[/?#]/);
	const authority = end < 0 ? rest : rest.slice(0, end);
	const host = authority.slice(authority.lastIndexOf("@") + 1);
	const tail = end < 0 ? "" : rest.slice(end);
	const trail = (tail.match(TRAILING) ?? [""])[0];
	if (host === "") return `${scheme}://${tail.replace(TRAILING, "") ? "<path>" : ""}${trail}`;
	return `${scheme}://${host}${trail}`;
}

/** Whether a path starts at `i`, and how long its start marker is (POSIX `/x`, `~/`, `C:\`, `C:/`, `\\server`). */
function pathStartAt(text, i) {
	const prev = i > 0 ? text[i - 1] : "";
	if (prev !== "" && PATH_GLUE.test(prev)) return false;
	const c = text[i];
	const next = text[i + 1] ?? "";
	if (c === "/") return next !== "" && next !== "/" && !/\s/.test(next);
	if (c === "~") return next === "/";
	if (/[A-Za-z]/.test(c) && next === ":" && /[\\/]/.test(text[i + 2] ?? "")) return !(text[i + 2] === "/" && text[i + 3] === "/");
	if (c === "\\") return next === "\\" && /[^\s\\]/.test(text[i + 2] ?? "");
	return false;
}

/**
 * Every absolute path in `text` as `<path>`. A scanner rather than one expression, because the shapes that leaked
 * through a lead-character expression were the ones a person writes: `path:/etc/x`, `name|/x`, an em dash before one,
 * `user@host:~/dev`, and a path with a space in it (`/Users/rob/My Projects/pi/.env`, `C:\Program Files\x`).
 *   - A path STARTS at a `/` (not doubled, not followed by a space), a `~/`, a drive letter or a UNC `\\`, wherever the
 *     character before it is not part of a word, a ratio or a URL (`PATH_GLUE`): so `Europe/Amsterdam`, `2/4`,
 *     `acme/web` and `ghcr.io/x/y` stay, and `:` or any other punctuation before it does not protect it.
 *   - A path that opens right after a quote runs to that quote's close, spaces and all.
 *   - Otherwise it runs to whitespace or a delimiter, and then over a space into the next word as long as that word
 *     holds a separator too (`My Projects/pi/.env`): a word with no separator after a space is prose. The residual,
 *     said rather than hidden: the last segment of a spaced path that holds no separator (`/a/My Projects`) is kept.
 */
function cutPaths(text) {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (!pathStartAt(text, i)) {
			out += text[i];
			i += 1;
			continue;
		}
		const quote = i > 0 && QUOTES.has(text[i - 1]) ? text[i - 1] : null;
		let j = i + 1;
		if (quote) {
			const close = text.indexOf(quote, j);
			j = close < 0 ? text.length : close;
		} else {
			while (j < text.length && !PATH_END.test(text[j])) j += 1;
			for (;;) {
				const gap = text.slice(j).match(/^[ \u00a0]([^\s"'`<>()[\]{},;|]+)/);
				if (!gap || !/[\\/]/.test(gap[1])) break;
				j += gap[0].length;
			}
		}
		const path = text.slice(i, j);
		const trail = quote ? "" : (path.match(TRAILING) ?? [""])[0];
		out += `<path>${trail}`;
		i = j;
	}
	return out;
}

/**
 * Token shapes beyond `redact-secrets.mjs`'s, for text a console viewer reads: a JWT (three base64url parts, the first
 * `eyJ`), a Google API key (`AIza` and 35), a Hugging Face token (`hf_`) and an npm token (`npm_`).
 */
export const PUBLISH_TOKEN_SHAPES = Object.freeze([
	/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{28,}/g,
	/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{20,}/g,
	/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,}/g,
]);

/** The redactor a publish uses: this run's secret values, `redact-secrets.mjs`'s shapes and the shapes above. */
export function publishRedactor(secrets = []) {
	return makeRedactor({ values: secrets, extraPatterns: [...PUBLISH_TOKEN_SHAPES] });
}

/**
 * `text` as it may be published. The ORDER is the design: controls first (a separator inside a value would split what
 * the rules below match), then secrets (a token inside a URL or a path is taken whole before either rule cuts around
 * it), then JSON.parse's quoted snippet, then URLs (so a URL's own path is not mistaken for a filesystem path), then
 * paths, then the cap, which comes LAST so a cut can never leave the prefix of something the rules above would take.
 */
export function redactText(text, { redact = publishRedactor() } = {}) {
	if (typeof text !== "string" || text === "") return "";
	let out = text.replace(INVISIBLE, "").replace(CONTROLS, " ");
	out = redact(out);
	out = out.replace(SECRET_QUERY, "$1[redacted]");
	out = out.replace(SECRET_FLAG, "$1[redacted]");
	out = out.replace(SECRET_ASSIGN, "$1[redacted]");
	out = out.replace(BASIC_CREDENTIAL, "$1[redacted]");
	out = out.replace(SECRET_HEADER, "$1[redacted]");
	out = out.replace(BARE_USERINFO, "[redacted]@");
	out = out.replace(JSON_SNIPPET, "<content> is not valid JSON");
	out = out.replace(JSON_SNIPPET_BARE, "<content> is not valid JSON");
	out = out.replace(URL_RUN, (_, scheme, rest) => urlShownForPublish(scheme.toLowerCase(), rest));
	out = cutPaths(out);
	out = out.replace(/\s+/g, " ").trim();
	return out.length > DOCTOR_LABEL_MAX ? `${out.slice(0, DOCTOR_LABEL_MAX - 1)}\u2026` : out;
}

/** A safe integer at least 0, or null. */
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The record one run publishes. `checks` are doctor's own objects in its order and `ids` their ids
 * (`assignCheckIds`); `secrets` the values `secretValuesIn` found; `every` the worker's doctor interval in hours as the
 * service reads it (null when it does not parse), which is what a reader judges a record's age against.
 */
export function buildDoctorRecord({ checks, ids, at, version, openshell = false, every = null, secrets = [], by = null }) {
	const redact = publishRedactor(secrets);
	const counts = { ok: 0, warn: 0, fail: 0 };
	const listed = [];
	let detailed = 0;
	checks.forEach((check, i) => {
		const level = checkLevel(check);
		counts[level] += 1;
		if (listed.length >= DOCTOR_CHECKS_MAX) return;
		const entry = { id: ids[i], level };
		if (level !== "ok" && detailed < DOCTOR_DETAILED_MAX) {
			detailed += 1;
			entry.label = redactText(String(check?.label ?? ""), { redact });
			const fix = typeof check?.fix === "string" ? redactText(check.fix, { redact }) : "";
			if (fix !== "") entry.fix = fix;
		}
		listed.push(entry);
	});
	return {
		v: DOCTOR_RECORD_VERSION,
		at,
		version: typeof version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : "",
		openshell: openshell === true,
		every: count(every),
		by: byOf(by),
		counts,
		checks: listed,
		more: checks.length - listed.length,
	};
}

/**
 * Who ran it: `{ uid, worker }`, the effective uid (null where the platform has none) and whether the worker's own spawn
 * ran it (`--by-worker`). An operator's run, under sudo or another account, publishes over the worker's record like any
 * run; this is what lets a reader SAY so rather than show a root's view of the host as the worker's.
 */
function byOf(by) {
	return { uid: count(by?.uid), worker: by?.worker === true };
}

/** The worker's doctor interval as the service reads it (`config.mjs`'s rule), or null when it does not parse. */
export function doctorIntervalHours(env) {
	const raw = env?.PI_DOCTOR_INTERVAL_HOURS;
	if (raw === undefined || raw === "") return DOCTOR_INTERVAL_HOURS;
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) && n >= 0 && n <= DOCTOR_INTERVAL_MAX_HOURS && String(n) === String(raw).trim() ? n : null;
}

/** Reject rather than wait forever (`host-registry`'s `bounded`, and for its reason). Not unref'd, for that reason too. */
function bounded(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		Promise.resolve(promise).then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}

/**
 * Write one host's record and index it. Throws on a fault; the CALLER is best effort (doctor says one line and keeps
 * its exit code). The name must be a worker name, which is what lets it be a key segment unescaped.
 */
export async function publishDoctorRecord(redis, name, record, { ttlMs = DOCTOR_RESULTS_TTL_MS, timeoutMs = DOCTOR_OP_TIMEOUT_MS } = {}) {
	if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) throw new Error("not a worker name");
	// An operator's run over the worker's: the worker's last run is named in the new record, so a reader can say whose
	// view it shows (review round 1). Read best effort: a GET that fails costs the note, never the publish.
	let written = record;
	if (record?.by?.worker !== true) {
		const before = await bounded(redis.get(doctorKey(name)), timeoutMs).then(
			(v) => (typeof v === "string" ? parseDoctorRecord(v) : null),
			() => null,
		);
		const worker = before?.by?.worker ? { uid: before.by.uid, at: before.at } : (before?.workerRun ?? null);
		if (worker && worker.uid !== record?.by?.uid) written = { ...record, workerRun: worker };
	}
	// The value and its expiry in one command: see the header for why this is a STRING.
	await bounded(redis.set(doctorKey(name), JSON.stringify(written), "PX", ttlMs), timeoutMs);
	await bounded(redis.sadd(DOCTOR_HOSTS, name), timeoutMs);
	// The writer prunes too (review round 1): a reader that promises no write (the console) never does, so on a
	// deployment watched only from the console, members whose records expired would pile up and crowd the read's cap.
	// At most PRUNE_MAX members are looked at, in one MGET, and a fault here is not the publish's.
	try {
		const members = (await bounded(redis.smembers(DOCTOR_HOSTS), timeoutMs)) ?? [];
		const look = (Array.isArray(members) ? members : []).filter((m) => typeof m === "string" && m !== name).slice(0, PRUNE_MAX);
		if (look.length > 0) {
			const values = await bounded(redis.mget(...look.map(doctorKey)), timeoutMs);
			for (const [i, m] of look.entries()) if (Array.isArray(values) && (values[i] === null || values[i] === undefined)) await bounded(redis.srem(DOCTOR_HOSTS, m), timeoutMs);
		}
	} catch {
		// the reader's own prune and the next publish try again
	}
	return written;
}

/** How many index members one publish looks at to prune. */
const PRUNE_MAX = 256;

/** A string field back through the content rule: control characters out and the cap kept, or null. */
function textBack(v) {
	if (typeof v !== "string") return null;
	const out = v.replace(INVISIBLE, "").replace(CONTROLS, " ");
	return out.length > DOCTOR_LABEL_MAX ? `${out.slice(0, DOCTOR_LABEL_MAX - 1)}…` : out;
}

/**
 * A record read back through an ALLOWLIST, or null where it does not read. Another host wrote it, so nothing in it is
 * trusted: every field is re-checked against the shape this module writes and anything else is dropped.
 */
export function parseDoctorRecord(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return null;
	}
	if (!doc || typeof doc !== "object" || doc.v !== DOCTOR_RECORD_VERSION || !Number.isSafeInteger(doc.at) || doc.at < 0) return null;
	const counts = { ok: count(doc.counts?.ok) ?? 0, warn: count(doc.counts?.warn) ?? 0, fail: count(doc.counts?.fail) ?? 0 };
	const checks = [];
	for (const c of Array.isArray(doc.checks) ? doc.checks.slice(0, DOCTOR_CHECKS_MAX) : []) {
		if (!c || typeof c.id !== "string" || !CHECK_ID_RE.test(c.id) || !DOCTOR_LEVELS.includes(c.level)) continue;
		const entry = { id: c.id, level: c.level };
		if (c.level !== "ok") {
			const label = textBack(c.label);
			const fix = textBack(c.fix);
			if (label) entry.label = label;
			if (fix) entry.fix = fix;
		}
		checks.push(entry);
	}
	return {
		at: doc.at,
		version: typeof doc.version === "string" && /^[0-9A-Za-z.+-]{0,32}$/.test(doc.version) ? doc.version : "",
		openshell: doc.openshell === true,
		every: count(doc.every),
		by: byOf(doc.by),
		workerRun: doc.workerRun && Number.isSafeInteger(doc.workerRun.at) ? { uid: count(doc.workerRun.uid), at: doc.workerRun.at } : null,
		counts,
		checks,
		more: count(doc.more) ?? 0,
	};
}

/**
 * Every published record: the index's names plus `names` (the live hosts a caller already read, so a host whose index
 * entry was lost is still found), worker names only, at most `DOCTOR_HOSTS_MAX`, read in ONE MGET.
 *
 * `{ unreachable }` and `{ hosts: [] }` are different answers, `readLiveHosts`'s rule: "nobody published" is not "I
 * could not find out". A member whose record has expired is pruned when `prune` (a reader that promises to write
 * nothing, the console, passes false). Each row is `{ name, ageMs, ...record }` or `{ name, unreadable: true }`.
 */
export async function readDoctorResults(redis, { names = [], prune = true, now = () => Date.now(), timeoutMs = DOCTOR_OP_TIMEOUT_MS } = {}) {
	let indexed;
	try {
		indexed = await bounded(redis.smembers(DOCTOR_HOSTS), timeoutMs);
		if (indexed !== null && indexed !== undefined && !Array.isArray(indexed)) throw new Error("smembers did not return a list");
	} catch (err) {
		return { unreachable: err?.message ?? "doctor results unreadable" };
	}
	const inIndex = new Set((indexed ?? []).filter((n) => typeof n === "string"));
	// The LIVE names first, then the index (review round 1): with the cap applied to one sorted list, seventy expired
	// index members that sort before a live host pushed it past the cap, and the panel then said it never published.
	const live = [...new Set(names.filter((n) => typeof n === "string" && WORKER_NAME_RE.test(n)))].sort();
	const rest = [...inIndex].filter((n) => WORKER_NAME_RE.test(n) && !live.includes(n)).sort();
	const all = [...live, ...rest];
	const wanted = all.slice(0, DOCTOR_HOSTS_MAX);
	if (wanted.length === 0) return { hosts: [], more: 0 };
	let values;
	try {
		values = await bounded(redis.mget(...wanted.map(doctorKey)), timeoutMs);
		if (!Array.isArray(values)) throw new Error("mget did not return a list");
	} catch (err) {
		return { unreachable: err?.message ?? "doctor results unreadable" };
	}
	const hosts = [];
	for (const [i, name] of wanted.entries()) {
		const value = values[i];
		if (value === null || value === undefined) {
			if (prune && inIndex.has(name)) await bounded(redis.srem(DOCTOR_HOSTS, name), timeoutMs).catch(() => {});
			continue;
		}
		const record = typeof value === "string" ? parseDoctorRecord(value) : null;
		if (record === null) {
			hosts.push({ name, unreadable: true });
			continue;
		}
		// A record whose clock is AHEAD of ours reads as 0, the registry's posture on skew.
		hosts.push({ name, ageMs: Math.max(0, now() - record.at), ...record });
	}
	hosts.sort((a, b) => a.name.localeCompare(b.name));
	return { hosts, more: all.length - wanted.length };
}
