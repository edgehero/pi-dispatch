/**
 * The environment variables pi and the packages it runs read to CONFIGURE a provider or pi itself: where the
 * request goes, which credentials it carries, and where pi reads its own configuration (issues #314, #511).
 *
 * WHY THIS IS A REFUSAL. `run.secrets` lets a trigger name an environment variable, and the existing gates
 * refuse the names the worker writes and the ones pi reads the resolved provider's KEY from. They refuse
 * nothing that says where the request goes, and that is the worse of the two: substitution spends the
 * trigger author's money, redirection sends the OPERATOR'S credential to a host the trigger chose.
 *
 * Measured against the 0.80.7 pin with a stubbed fetch and no real key, three providers, three routes (the
 * derivation below was re-run at the 0.99.1 pin, issue #509):
 *   AZURE_OPENAI_BASE_URL   -> the request goes to the named host carrying `api-key`
 *   GOOGLE_GEMINI_BASE_URL  -> ... carrying `x-goog-api-key`
 *   AWS_ENDPOINT_URL        -> ... carrying a SigV4 signature over the operator's Bedrock credential
 *
 * The azure case is not even a shadowed default: every azure model ships `baseUrl: ""`, so there the
 * environment is the PRIMARY source, ahead of the resource name and ahead of the model.
 *
 * WHAT THIS SET DOES NOT CONTAIN, and the reason is the whole shape of the design: **a provider's KEY
 * variables**. Those are `providerKeyCandidates`' business, refused PRE-SPEND against the job's own
 * resolved provider, and the bound that gate keeps is deliberate and documented -- an `anthropic` job may
 * bind `OPENAI_API_KEY` for a flow that talks to OpenAI itself, because refusing it would be this project
 * claiming a namespace it does not own. Including them here would have broken that bound ARBITRARILY: only
 * six of pi's thirty-eight key variables (at the 0.99.1 pin) happen to be read by name in a scanned
 * artifact, so `OPENAI_API_KEY` would refuse while `GROQ_API_KEY` and `HF_TOKEN` stayed bindable, and the
 * documented rule would be false for reasons no operator could predict. They are subtracted, and the bolt
 * subtracts them the same way rather than by hand. ONE is kept, by name and for a stated reason, in
 * `RETAINED_KEY_VARIABLES` below.
 * The AWS credential variables STAY, and they are not an exception: pi's key table has no entry for
 * `amazon-bedrock` at all (`providerKeyCandidates("amazon-bedrock")` is empty), so nothing else reserves
 * them and they are read by the SDK as provider configuration, which is exactly what this set is.
 *
 * DERIVED, AND THE DERIVATION IS BOLTED IN BOTH DIRECTIONS by `worker/test/provider-steering.test.mjs`,
 * from the pinned artifacts rather than from a second copy of them. Every name the scan finds is in, with
 * no judgement about which ones matter; the only subtractions are named and asserted there.
 *
 * TWO HOPS, THROUGH DECLARED DEPENDENCIES. Hop 1 is every package pi-ai's own dist imports, discovered
 * from its import statements rather than listed, so a pi bump that adds an SDK fails the bolt. Hop 2 is,
 * for each of those, the packages its sources import AND its package.json declares in `dependencies`,
 * which is where google-auth-library, `@smithy/core` and the AWS credential chain are. The declared-
 * dependency filter keeps out an optional peer that resolves only by an accident of layout (`openai`
 * imports `undici` without declaring it).
 *
 * EVERY OCCURRENCE COUNTED, not a list of accessor spellings (a list kept missing the next one). After
 * stripping comments, the bolt counts every occurrence that can reach the environment in every scanned
 * file: each `env` token (so `process.env`, `ctx.env`, a parameter named `env`, `{ env: e } = process`),
 * each `process["env"]`, each use of an alias of one (`const v = env()`, `const e = process.env`), and
 * each call of a helper. Helpers are DERIVED: any named function one of whose own parameters is the key of
 * an environment read (`resolveEnvConfigValue(name, env)`), so a new call of an existing helper counts. An occurrence either NAMES a variable (`.X`, `["X"]`, a key
 * resolved through a string constant, a call `("X")`, `"X" in env`, `{ X } = env`, a selector argument
 * beside its key) or it is a SITE, and the bolt pins every file's sites with a COUNT
 * (`worker/test/fixtures/provider-steering-sites.json`). So a new occurrence anywhere either names
 * something the equality sees or changes a count: a new helper reading `process.env[name]`, a key built
 * at runtime, a new alias. A write is a site, not a read.
 * The rule starts from an `env` token, so a form with none is NOT seen: `process["e" + "nv"]`,
 * `const E = "env"; process[E]`, `{ ["env"]: e } = process`, `Reflect.get(process, "env")`,
 * `require("process")["env"]`. None occurs in the pinned sources.
 *
 * BOTH COPIES. The hoisted pi-ai this workspace resolves, and the one the runner dispatches through,
 * nested under pi-coding-agent with its own google-auth-library (10.6.2 there, 10.9.1 hoisted). The union
 * of the two is reserved.
 *
 * LOWERCASE TWINS ARE LITERAL MEMBERS, and matching stays EXACT. google-auth-library reads
 * `google_application_credentials`, `gcloud_project` and `google_cloud_project` beside the uppercase
 * forms, so the scan finds them as reads and they are in. Folding case instead would refuse names no
 * pinned source reads (`openai_base_url`, `anthropic_api_key`), which is the other half of the rule: an
 * operator's own name stays bindable unless something pinned reads it.
 *
 * PI'S OWN NAMESPACE, in `PI_OWN_READS` below. Every `PI_*` name pi-coding-agent's dist and the pi
 * packages it declares read (pi-tui runs in the same process). The agent and session directory keys are
 * built at runtime from pi's app name, so the bolt imports pi's `config.js` to evaluate them. Two sets are
 * subtracted: the names the worker writes into the container (`CONTAINER_ENV_NAMES`, reserved already),
 * and the ones the runner assigns before pi runs, derived from `image/runner/src` (`PI_OFFLINE`,
 * `PI_TELEMETRY`). `dist/bundle/`, the vendored single-file build, is not the code the runner loads and is
 * not scanned.
 *
 * THE LIMITS, stated because a set like this is only worth what its boundary is honest about.
 *
 * Hop 3 is not followed, and these are read there and NOT reserved: in gcp-metadata (under
 * google-auth-library) `GCE_METADATA_HOST`, `GCE_METADATA_IP`, `METADATA_SERVER_DETECTION` and `K_SERVICE`;
 * in the AWS credential providers (under `@aws-sdk/credential-provider-node`) `AWS_ROLE_ARN` and
 * `AWS_ROLE_SESSION_NAME` (web identity), `AWS_CONTAINER_AUTHORIZATION_TOKEN` and its `_FILE` form (http,
 * useless without the reserved `AWS_CONTAINER_CREDENTIALS_FULL_URI`), and `AWS_ACCOUNT_ID`,
 * `AWS_CREDENTIAL_SCOPE` and `AWS_CREDENTIAL_EXPIRATION` (env). The metadata host is the sharpest of them:
 * it moves where google-auth-library asks for a token when no other credential is configured.
 *
 * pi-coding-agent's own third-party dependencies are not scanned either (undici, jiti, yaml, semver,
 * cross-spawn, chalk and the rest). At the 0.99.1 pin they read the proxy variables (reserved by the egress
 * policy or listed below) and tooling switches: jiti's `NODE_DEBUG` and Babel flags, chalk's
 * `FORCE_COLOR`, yaml's `LOG_TOKENS`.
 *
 * Names pi reads outside its `PI_*` namespace are found and left out, and the bolt pins the list: the
 * terminal, the OS, the editor, and the `llama.cpp` extension's `LLAMA_BASE_URL`, which pi reads both
 * through `ctx.env` and through `process.env`. The worker cannot dispatch to that provider, and the bolt
 * asserts it still cannot.
 *
 * `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `NODE_TLS_REJECT_UNAUTHORIZED` are NOT here.
 * They subvert any provider call, but they are properties of the RUNTIME rather than of a provider, they
 * predate this gate, and `NODE_OPTIONS` additionally needs a file the attacker can place. They belong to
 * whatever closes the runtime-hijack question, not to a set derived from what pi reads about providers.
 * The same holds for `HOME`, `PATH`, `APPDATA`, `USERPROFILE` and `XDG_CONFIG_HOME`, which the scan DOES
 * reach: the Anthropic SDK reads the four directory variables only to locate its default config directory
 * (`core/credentials`), and `PATH` inside its agent toolset, which pi does not use. `HOMEDRIVE` and
 * `HOMEPATH` join them (issue #511): `@smithy/core` reads them in the same home-directory helper. The bolt subtracts them
 * by name, with that reason, and asserts the scan still finds each, so a subtraction that stopped being
 * needed is removed rather than carried. `HOME` is reserved anyway, by `reserved-env.mjs`, because the
 * worker writes it (issue #341). The Anthropic-specific switch for the same directory,
 * `ANTHROPIC_CONFIG_DIR`, IS in the set: it names a credential location outright.
 *
 * And a bound on the whole family: a trigger author picks the variable NAME and a vault REFERENCE, never a
 * value. Exploiting any of these needs the operator's own vault to hold a useful string at a reference the
 * author is allowed to name. That is equally true of `AZURE_OPENAI_BASE_URL`, the variable #314 was filed
 * about, so it bounds the severity of the whole set rather than distinguishing parts of it. An operator
 * who needs one of these names in a job puts it on `PI_FORWARD_ENV`, the operator's own list.
 *
 * IMPORT-FREE, like `reserved-env.mjs` and `provider-key.mjs` beside it: `triggers.mjs` is the shared
 * validator, the receiver loads it, and `admin/build.mjs` inlines it into the published console.
 */


/**
 * Provider KEY variables that stay reserved here although the bolt subtracts key variables in general.
 *
 * `ANTHROPIC_AUTH_TOKEN` was in this set from issue #314 on, because at 0.80.7 it was read only by the
 * Anthropic SDK and was no key variable of pi's. At the 0.99.1 pin pi lists it FIRST among anthropic's key
 * variables and sends it as `Authorization: Bearer` ahead of the API key (issue #509), which would move it
 * to the per-provider pre-spend gate and make it bindable again for every non-anthropic job. Kept instead,
 * because a version bump must not widen what a trigger may bind without an operator deciding it, and no
 * deployment can be relying on binding a name that has been refused at load since #314. The bolt asserts it
 * is still both a key variable pi reads and a name the scan finds, so the day either stops holding this
 * list is revisited rather than carried.
 */
const RETAINED_KEY_VARIABLES = ["ANTHROPIC_AUTH_TOKEN"];

/**
 * The steering variables the scan cannot reach.
 *
 * Named rather than quietly absent, because "derived, never curated" would otherwise be a claim the bolt
 * cannot keep. Four of them, each read through a key built at runtime, and the bolt pins the key that
 * builds it among the unresolved ones.
 *
 * `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` is `@smithy/core`'s `AWS_ENDPOINT_URL_<SERVICE>`. It matters because pi
 * stops pinning the Bedrock endpoint itself as soon as `AWS_REGION` or `AWS_PROFILE` is present, which is
 * the ordinary way to configure Bedrock. (`AWS_ENDPOINT_URL`, `AWS_CONFIG_FILE` and
 * `AWS_SHARED_CREDENTIALS_FILE` were here until issue #511; the scan now names them.)
 *
 * The proxy spellings are read by pi's own `getProxyEnv`, which lowercases and uppercases the key it is
 * given and asks for both, and builds `${protocol}_proxy`. `all_proxy` and `no_proxy` it names literally,
 * so the scan finds those. `EGRESS_ENV_VARS` owns `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`; what is left
 * is here. pi reads the LOWERCASE form FIRST, so `https_proxy` outranks the egress policy's own variable in
 * pi's reader. Only the schemes a provider call can use are listed.
 */
const UNREACHABLE_BY_SCAN = ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "ALL_PROXY", "http_proxy", "https_proxy"];

/**
 * pi's own reads in its `PI_*` namespace (issue #511), minus what the worker and the runner write.
 *
 * `PI_CODING_AGENT_DIR` points pi at another agent directory, and with it another `auth.json`, settings
 * and models file; `PI_RADIUS_GATEWAY`, `PI_SHARE_VIEWER_URL` and `PI_INSTALLER_API_BASE` are URLs pi
 * calls. The rest are here because the scan finds them and the rule has no judgement in it: a name the
 * pinned pi reads for its own configuration is not a name a trigger author picks.
 */
const PI_OWN_READS = [
	"PI_CLEAR_ON_SHRINK",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_EXPERIMENTAL",
	"PI_HARDWARE_CURSOR",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_INSTALLER_API_BASE",
	"PI_MANAGED_INSTALL_ROOT",
	"PI_PACKAGE_DIR",
	"PI_PROGRAM_STATUS",
	"PI_RADIUS_GATEWAY",
	"PI_SHARE_VIEWER_URL",
	"PI_SKIP_VERSION_CHECK",
	"PI_STARTUP_BENCHMARK",
	"PI_TIMING",
	"PI_TRUE_COLOR",
	"PI_TUI_DEBUG",
	"PI_TUI_DEBUG_REDRAW",
	"PI_TUI_ESC_TIMEOUT",
	"PI_TUI_WRITE_LOG",
];

export const PROVIDER_STEERING_VARS = new Set([
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CONFIG_DIR",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_ENVIRONMENT_ID",
	"ANTHROPIC_ENVIRONMENT_KEY",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_LOG",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_SCOPE",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_SESSION_ID",
	"ANTHROPIC_WEBHOOK_SIGNING_KEY",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_WORK_ID",
	"ANTHROPIC_WORK_SECRET",
	"AWS_ACCESS_KEY_ID",
	"AWS_ACCOUNT_ID_ENDPOINT_MODE",
	"AWS_AUTH_SCHEME_PREFERENCE",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_BASE_URL",
	"AWS_BEDROCK_FORCE_CACHE",
	"AWS_BEDROCK_FORCE_HTTP1",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_CONFIG_FILE",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_DEFAULTS_MODE",
	"AWS_DEFAULT_REGION",
	"AWS_DISABLE_CLOCK_SKEW_CORRECTION",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
	"AWS_ENDPOINT_URL",
	"AWS_EXECUTION_ENV",
	"AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
	"AWS_LAMBDA_FUNCTION_NAME",
	"AWS_MAX_ATTEMPTS",
	"AWS_NEW_RETRIES_2026",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_RETRY_MODE",
	"AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED",
	"AWS_SDK_UA_APP_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_SIGV4A_SIGNING_REGION_SET",
	"AWS_USE_DUALSTACK_ENDPOINT",
	"AWS_USE_FIPS_ENDPOINT",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_ENDPOINT",
	"AZURE_OPENAI_RESOURCE_NAME",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"CLOUDSDK_CONFIG",
	"CLOUD_RUN_JOB",
	"DEBUG",
	"FUNCTION_NAME",
	"FUNCTION_TARGET",
	"GAE_MODULE_NAME",
	"GAE_SERVICE",
	"GCLOUD_PROJECT",
	"GOOGLE_API_CERTIFICATE_CONFIG",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
	"GOOGLE_GEMINI_BASE_URL",
	"GOOGLE_GENAI_ACCESS_TOKEN",
	"GOOGLE_GENAI_API_KEY",
	"GOOGLE_GENAI_API_VERSION",
	"GOOGLE_GENAI_DEBUG",
	"GOOGLE_GENAI_USER_PROJECT",
	"GOOGLE_GENAI_USE_ENTERPRISE",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_VERTEX_BASE_URL",
	"HOSTNAME",
	"KIMI_CODE_OAUTH_HOST",
	"KIMI_OAUTH_HOST",
	"K_CONFIGURATION",
	"OPENAI_ADMIN_KEY",
	"OPENAI_API_VERSION",
	"OPENAI_BASE_URL",
	"OPENAI_CUSTOM_HEADERS",
	"OPENAI_LOG",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
	"OPENAI_WEBHOOK_SECRET",
	"PI_CACHE_RETENTION",
	"PI_OAUTH_CALLBACK_HOST",
	"SMITHY_NEW_RETRIES_2026",
	"WS_NO_BUFFER_UTIL",
	"WS_NO_UTF_8_VALIDATE",
	"_X_AMZN_TRACE_ID",
	// The lowercase twins google-auth-library reads beside the uppercase forms, and the two proxy spellings
	// pi's getProxyEnv names literally (issue #511).
	"all_proxy",
	"gcloud_project",
	"google_application_credentials",
	"google_cloud_project",
	"no_proxy",
	...PI_OWN_READS,
	...RETAINED_KEY_VARIABLES,
	...UNREACHABLE_BY_SCAN,
]);
