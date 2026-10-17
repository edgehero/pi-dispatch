import assert from "node:assert/strict";
import { test } from "node:test";
import { EGRESS_ENV_KEYS, MIN_SECRET_LENGTH, NON_SECRET_ENV_KEYS, REDACTED, makeRedactor, secretValuesOf } from "../src/redact-secrets.mjs";
import { egressEnv } from "../src/egress.mjs";

// Issue #643: the live transcript's redaction. Built from this job's secret values and known token shapes; a match is
// `[redacted]`. Every rule below has a case that fails when the rule is removed.

test("a secret value is redacted in its literal, JSON-escaped and URL-encoded spellings", () => {
	const secret = 'p@ss/w"rd+\\x\nend=1';
	const redact = makeRedactor({ values: [secret] });
	assert.equal(redact(`echo ${secret} done`), `echo ${REDACTED} done`, "literal");
	const asJson = JSON.stringify({ cmd: `curl -u me:${secret}` });
	assert.equal(redact(asJson), `{"cmd":"curl -u me:${REDACTED}"}`, "JSON-escaped, as a tool call's arguments reach the stream");
	assert.equal(redact(`https://h/x?token=${encodeURIComponent(secret)}&a=1`), `https://h/x?token=${REDACTED}&a=1`, "URL-encoded");
	const lower = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (p) => p.toLowerCase());
	assert.equal(redact(`?t=${lower}`), `?t=${REDACTED}`, "URL-encoded with lowercase hex");
});

test("values under the floor, non-strings and empty lists leave text untouched", () => {
	assert.equal(MIN_SECRET_LENGTH, 8);
	const redact = makeRedactor({ values: ["1234567", "", null, 42, undefined] });
	const text = "port 1234567 and 42 apples";
	assert.equal(redact(text), text);
	assert.equal(makeRedactor()(text), text);
	assert.equal(makeRedactor({ values: ["12345678"] })(text.replace("1234567", "12345678")), `port ${REDACTED} and 42 apples`, "eight is enough");
	assert.equal(makeRedactor()(undefined), "", "never throws on a non-string");
});

test("overlapping values: the longest is taken whole, whichever order they were given", () => {
	for (const values of [["abcdefgh", "abcdefghijkl"], ["abcdefghijkl", "abcdefgh"]]) {
		const redact = makeRedactor({ values });
		assert.equal(redact("x abcdefghijkl y abcdefgh z"), `x ${REDACTED} y ${REDACTED} z`, JSON.stringify(values));
	}
	const inner = makeRedactor({ values: ["CRETSECR", "SECRETSECRETXY"] });
	assert.equal(inner("SECRETSECRETXY"), REDACTED, "a value inside another leaves no head or tail");
});

test("every known token shape is redacted, and look-alikes are not", () => {
	const shapes = [
		"ghp_" + "a".repeat(36),
		"gho_" + "B1".repeat(18),
		"ghu_" + "c".repeat(20),
		"ghs_" + "D".repeat(30),
		"github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
		"glpat-" + "x1y2".repeat(5),
		"sk-ant-api03-" + "k".repeat(40),
		"sk-proj-" + "Q".repeat(32),
		"xoxb-123456789012-abcdefghij",
		"xoxp-123456789012-abcdefghij",
		"pdc_" + "Zm9vYmFyYmF6cXV4cXV1eGNvcmdl",
		"AKIAABCDEFGHIJKLMNOP",
	];
	const redact = makeRedactor();
	for (const token of shapes) assert.equal(redact(`found ${token} here`), `found ${REDACTED} here`, token.slice(0, 12));
	for (const text of ["task-0123456789abcdefghij", "disk-sk-0123456789abcdefg", "ghp_short", "sk-learn", "AKIAABCDEFGHIJKLMNOPQ", "my_ghp_" + "a".repeat(36)]) {
		assert.equal(redact(text), text, `not a token: ${text}`);
	}
});

test("bearer and Authorization headers keep their scheme and lose the credential", () => {
	const redact = makeRedactor();
	assert.equal(redact("Authorization: Bearer eyJhbGciOi.payload.sig"), `Authorization: Bearer ${REDACTED}`);
	assert.equal(redact("authorization: token abc123def456"), `authorization: token ${REDACTED}`);
	assert.equal(redact("-H 'Authorization: Basic dXNlcjpwYXNz'"), `-H 'Authorization: Basic ${REDACTED}'`);
	assert.equal(redact('{"Authorization":"Bearer abcdefgh12345"}'), `{"Authorization":"Bearer ${REDACTED}"}`);
	assert.equal(redact("got bearer abcdefgh.ijk_lmn from the api"), `got bearer ${REDACTED} from the api`);
	assert.equal(redact("a bearer of bad news"), "a bearer of bad news", "a short word after bearer is prose");
});

test("extra patterns are applied as whole-match redactions; a non-global one is ignored rather than looping", () => {
	const redact = makeRedactor({ extraPatterns: [/CORP-\d{6}/g, /NOPE-\d+/] });
	assert.equal(redact("id CORP-123456 and NOPE-1"), `id ${REDACTED} and NOPE-1`);
});

test("secretValuesOf takes every env value but the structural keys, plus the extras held outside the env", () => {
	const env = {
		PI_PROVIDER: "anthropic",
		PI_MODEL: "claude-opus-4-1-20250805",
		PI_SESSION_FILE: "/session/current.jsonl",
		PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
		HOME: "/home/pi",
		HTTPS_PROXY: "http://pi-dispatch-egress:3128",
		GITLAB_HOST: "https://gitlab.example.com",
		ANTHROPIC_API_KEY: "sk-ant-provider",
		GITHUB_TOKEN: "ghs_minted",
		CUSTOM_FORWARDED: "forwarded-value",
		MY_SECRET: "resolved-secret",
		EMPTY: "",
	};
	const workerSet = { HTTPS_PROXY: "http://pi-dispatch-egress:3128" };
	assert.deepEqual(secretValuesOf(env, ["exit-key-hex", null, ""], { workerSet }), ["sk-ant-provider", "ghs_minted", "forwarded-value", "resolved-secret", "exit-key-hex"]);
	for (const key of ["PI_PROVIDER", "PI_MODEL", "PI_SESSION_FILE", "HOME", "GITLAB_HOST", "GITEA_INSTANCE_URL", "PI_DISPATCH_KEYLESS"]) {
		assert.ok(NON_SECRET_ENV_KEYS.has(key), key);
	}
	for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]) assert.ok(!NON_SECRET_ENV_KEYS.has(key) && EGRESS_ENV_KEYS.includes(key), `${key}: structural per job only`);
	for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "AZURE_DEVOPS_EXT_PAT"]) assert.ok(!NON_SECRET_ENV_KEYS.has(key), key);
});

// The structural list held to `buildContainerEnv`: an env with every structural option set holds no key outside it
// but the provider's credential and the minted token's names, so a key added there is redacted until it is listed.
let envMod;
try {
	envMod = await import("../src/env-allowlist.mjs");
} catch {}
if (!envMod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("redact-secrets: env-allowlist is REQUIRED here but could not import");
test("NON_SECRET_ENV_KEYS covers every structural key buildContainerEnv writes", { skip: envMod ? false : "pi-ai not installed" }, () => {
	const env = envMod.buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		maxTokens: 100,
		maxCostMicros: 5,
		jobId: "j",
		githubToken: "ghs_minted_value",
		forgeKind: "gitlab",
		forgeHosts: { gitlab: "https://gitlab.example.com" },
		hostEnv: { ANTHROPIC_API_KEY: "sk-ant-x" },
		allowGlobalExtensions: false,
		packagePaths: ["/opt/pi-global/packages/a"],
		sessionFile: "/session/current.jsonl",
		flow: "fix",
		excludeTools: ["bash"],
		mcpServers: ["docs"],
		awaitInput: true,
		reportProgress: true,
		recover: true,
		recovering: true,
		allowedModels: ["anthropic/m"],
		egress: true,
		home: "/home/pi",
		exitAuth: true,
	});
	const workerSet = egressEnv({ armed: true });
	const outside = Object.keys(env).filter((k) => env[k] !== undefined && !NON_SECRET_ENV_KEYS.has(k) && workerSet[k] !== env[k]).sort();
	assert.deepEqual(outside, ["ANTHROPIC_API_KEY", "GITLAB_TOKEN", "GL_TOKEN"]);
	assert.deepEqual(secretValuesOf(env, [], { workerSet }).sort(), [env.ANTHROPIC_API_KEY, env.GITLAB_TOKEN, env.GL_TOKEN].sort(), "the worker's own proxy values are not secrets");
});

test("a proxy URL is structural only with the value the worker wrote: a forwarded one with a password is redacted (#643)", () => {
	const own = egressEnv({ armed: true });
	const forwarded = "http://bob:Hunter2Proxy@corp-proxy.example:3128";
	// PI_EGRESS=0: the worker wrote nothing, so every proxy variable in the env came from PI_FORWARD_ENV.
	const off = makeRedactor({ values: secretValuesOf({ HTTPS_PROXY: forwarded, NO_PROXY: "internal.example,10.0.0.0/8" }, [], { workerSet: egressEnv({ armed: false }) }) });
	assert.equal(off(`proxy is ${forwarded} now`), `proxy is ${REDACTED} now`, "literal");
	assert.equal(off(`?p=${encodeURIComponent(forwarded)}`), `?p=${REDACTED}`, "URL-encoded");
	assert.equal(off("no_proxy=internal.example,10.0.0.0/8"), `no_proxy=${REDACTED}`, "a forwarded NO_PROXY is the operator's, so it is redacted too");
	// Armed, but the value differs from the worker's own (a forwarded name the egress assign did not overwrite): secret.
	assert.deepEqual(secretValuesOf({ HTTPS_PROXY: forwarded }, [], { workerSet: own }), [forwarded, "Hunter2Proxy"], "the URL and, on its own, its password");
	// Armed, the worker's own value: structural, and the URL (no userinfo) is unchanged in a transcript.
	const armed = makeRedactor({ values: secretValuesOf({ ...own }, [], { workerSet: own }) });
	assert.equal(armed(`via ${own.HTTPS_PROXY} ok`), `via ${own.HTTPS_PROXY} ok`);
});

test("the userinfo of any URL is redacted with its scheme kept; addresses, paths and queries holding @ are not (#643)", () => {
	const redact = makeRedactor();
	assert.equal(redact("git clone https://x-access-token:abc123@github.com/o/r.git"), `git clone https://${REDACTED}@github.com/o/r.git`);
	assert.equal(redact("proxy http://bob:p@ss@corp:3128 set"), `proxy http://${REDACTED}@corp:3128 set`, "a raw @ in the password goes whole");
	assert.equal(redact("HTTPS_PROXY=socks5h://only-a-token@h:1"), `HTTPS_PROXY=socks5h://${REDACTED}@h:1`);
	for (const text of ["mail me at dev@example.com", "https://host/path/@scope/pkg", "https://host/x?email=a@b.c", "https://host#frag@x"]) assert.equal(redact(text), text, text);
});

test("the minted token is redacted by value, whatever its shape, and a ghr_ token and a quoted authorization by shape (#643)", () => {
	// A token value no shape rule knows: only the value list can catch it.
	const minted = "Zq81-plainMintedValue-77";
	const redact = makeRedactor({ values: secretValuesOf({}, [minted]) });
	assert.equal(redact(`token=${minted};`), `token=${REDACTED};`);
	assert.equal(makeRedactor()(`token=${minted};`), `token=${minted};`, "and without the value list it stands: no shape covers it");
	assert.equal(makeRedactor()(`found ghr_${"R".repeat(36)} here`), `found ${REDACTED} here`);
	assert.equal(makeRedactor()(`{"authorization": "token abcdefghij123"}`), `{"authorization": "token ${REDACTED}"}`);
	assert.equal(makeRedactor()("authorization='Basic dXNlcjpwYXNzd29yZA=='"), `authorization='Basic ${REDACTED}'`);
});

test("a URL value's password is a secret on its own, raw and decoded, so a tool printing it without the URL is caught (#643)", () => {
	const values = secretValuesOf({ HTTPS_PROXY: "http://alice:Tr0ub4dor%26x@proxy.corp.example:3128" }, [], { workerSet: {} });
	const redact = makeRedactor({ values });
	for (const text of ["password is Tr0ub4dor&x", "curl -U alice:Tr0ub4dor&x -x proxy.corp.example:3128", "curl -x alice:Tr0ub4dor%26x@proxy.corp.example:3128"]) {
		const out = redact(text);
		assert.ok(!out.includes("Tr0ub4dor"), `${text} -> ${out}`);
	}
	assert.equal(redact("alice reads the docs"), "alice reads the docs", "the user name alone is not a secret");
});

test("an Authorization header with a quoted credential after its scheme, or with no scheme at all, loses the credential (#643)", () => {
	const redact = makeRedactor({ values: [] });
	assert.equal(redact('Authorization: Token "c4f3d00dc4f3d00d"'), 'Authorization: Token "[redacted]"');
	assert.equal(redact("Authorization: c4f3d00dc4f3d00d"), "Authorization: [redacted]");
	assert.equal(redact('"authorization": "c4f3d00dc4f3d00d",'), '"authorization": "[redacted]",');
	assert.equal(redact("Authorization: Bearer abcdefgh12345678"), "Authorization: Bearer [redacted]", "the scheme form is unchanged");
	assert.equal(redact("authorization is required"), "authorization is required", "prose is not a header");
});
