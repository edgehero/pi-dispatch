/**
 * The environment variables pi and its provider SDKs read to CONFIGURE a provider: where the request goes,
 * and which credentials it carries (issue #314).
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
 * five of pi's thirty-eight key variables (at the 0.99.1 pin) happen to appear as literals in a scanned
 * artifact, so `OPENAI_API_KEY` would refuse while `GROQ_API_KEY` and `HF_TOKEN` stayed bindable, and the
 * documented rule would be false for reasons no operator could predict. They are subtracted, and the bolt
 * subtracts them the same way rather than by hand. ONE is kept, by name and for a stated reason, in
 * `RETAINED_KEY_VARIABLES` below.
 * The AWS credential variables STAY, and they are not an exception: pi's key table has no entry for
 * `amazon-bedrock` at all (`providerKeyCandidates("amazon-bedrock")` is empty), so nothing else reserves
 * them and they are read by the SDK as provider configuration, which is exactly what this set is.
 *
 * DERIVED, AND THE DERIVATION IS BOLTED IN BOTH DIRECTIONS by `worker/test/provider-steering.test.mjs`,
 * from the pinned artifacts rather than from a second copy of them: pi's own `dist`, plus every package pi
 * imports a client from, discovered from pi's own import statements rather than from a list here -- so a
 * pi bump that adds an SDK fails the bolt too. Four accessor spellings are matched, because the SDKs do
 * not agree on one: `getProviderEnvValue`, `readEnv`, `getEnv` and `process.env["NAME"]`, the last of
 * which is the only way `AZURE_OPENAI_ENDPOINT` is read.
 *
 * That derivation is why the set holds names nobody would have written down.
 * `AWS_CONTAINER_CREDENTIALS_FULL_URI` makes the AWS SDK fetch credentials from a URL of the trigger's
 * choosing, `AWS_WEB_IDENTITY_TOKEN_FILE` and `GOOGLE_APPLICATION_CREDENTIALS` are paths to credential
 * files, `AWS_BEDROCK_SKIP_AUTH` is an auth bypass, and `GOOGLE_GENAI_USE_VERTEXAI` moves the request to a
 * different Google product.
 *
 * THREE LIMITS, stated because a set like this is only worth what its boundary is honest about.
 *
 * The scan is ONE `node_modules` HOP DEEP: pi's own dist and the packages pi imports directly. It does not
 * follow those packages' dependencies, and the AWS variables are read one level further in, inside
 * `@smithy/core`. The names measured to matter from that layer are in the residual list below; the rest of
 * that closure (`AWS_EC2_METADATA_SERVICE_ENDPOINT`, `AWS_ROLE_ARN`, `GCE_METADATA_HOST` and some forty
 * more) is NOT covered. Recursing the whole closure would reserve most of the AWS and Google SDK surface
 * and take a large bite out of what an operator may legitimately bind, so the boundary is deliberate.
 *
 * `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `NODE_TLS_REJECT_UNAUTHORIZED` are NOT here.
 * They subvert any provider call, but they are properties of the RUNTIME rather than of a provider, they
 * predate this gate, and `NODE_OPTIONS` additionally needs a file the attacker can place. They belong to
 * whatever closes the runtime-hijack question, not to a set derived from what pi reads about providers.
 * The same holds for `HOME`, `PATH`, `APPDATA`, `USERPROFILE` and `XDG_CONFIG_HOME`, which the scan DOES
 * reach from the 0.99.1 pin on (issue #509): the Anthropic SDK reads the four directory variables only to
 * locate its default config directory (`core/credentials`), and `PATH` inside its agent toolset, which pi
 * does not use. The bolt subtracts them by name, with that reason, and asserts the scan still finds each,
 * so a subtraction that stopped being needed is removed rather than carried. `HOME` is reserved anyway,
 * by `reserved-env.mjs`, because the worker writes it (issue #341). The Anthropic-specific switch for the
 * same directory, `ANTHROPIC_CONFIG_DIR`, IS in the set: it names a credential location outright.
 *
 * And a bound on the whole family, which no document here stated before: a trigger author picks the
 * variable NAME and a vault REFERENCE, never a value. Exploiting any of these needs the operator's own
 * vault to hold a useful string at a reference the author is allowed to name. That is equally true of
 * `AZURE_OPENAI_BASE_URL`, the variable this issue was filed about, so it bounds the severity of the whole
 * set rather than distinguishing parts of it.
 *
 * IMPORT-FREE, like `reserved-env.mjs` and `provider-key.mjs` beside it: `triggers.mjs` is the shared
 * validator, the receiver loads it, and `admin/build.mjs` inlines it into the published console.
 */


/**
 * The steering variables a literal scan of the packages pi imports cannot reach.
 *
 * Named rather than quietly absent, because "derived, never curated" would otherwise be a claim the bolt
 * cannot keep. Two reasons they are unreachable, and the test asserts BOTH still hold.
 *
 * The AWS four are read inside `@smithy/core`, one dependency hop past this scan's boundary, and two of
 * them are additionally read through a key the resolver builds at runtime
 * (`AWS_ENDPOINT_URL_<SERVICEID>`). They matter because pi stops pinning the Bedrock endpoint itself as
 * soon as `AWS_REGION` or `AWS_PROFILE` is present, which is the ordinary way to configure Bedrock. Both
 * measured: `AWS_ENDPOINT_URL` redirects the call, and `AWS_SHARED_CREDENTIALS_FILE` replaces the
 * credential it is signed with. `AWS_CONFIG_FILE` does both, and can also name a `credential_process`
 * shell command.
 *
 * The proxy spellings are read by pi's own `getProxyEnv`, which lowercases and uppercases the key it is
 * given and asks for both. `EGRESS_ENV_VARS` owns `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` and keeps
 * them; what is added here is the spellings it does not have. pi reads the LOWERCASE form FIRST, so
 * `https_proxy` outranks the egress policy's own variable in pi's reader. Only the schemes a provider call
 * can use are listed: `ws_proxy` and the rest are reachable in `getProxyEnv` but not from an HTTPS request.
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

const UNREACHABLE_BY_SCAN = [
	"AWS_CONFIG_FILE",
	"AWS_ENDPOINT_URL",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_SHARED_CREDENTIALS_FILE",
	"ALL_PROXY",
	"all_proxy",
	"http_proxy",
	"https_proxy",
	"no_proxy",
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
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_BASE_URL",
	"AWS_BEDROCK_FORCE_CACHE",
	"AWS_BEDROCK_FORCE_HTTP1",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_DEFAULT_REGION",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_ENDPOINT",
	"AZURE_OPENAI_RESOURCE_NAME",
	"GCLOUD_PROJECT",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_GEMINI_BASE_URL",
	"GOOGLE_GENAI_USE_ENTERPRISE",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_VERTEX_BASE_URL",
	"KIMI_CODE_OAUTH_HOST",
	"KIMI_OAUTH_HOST",
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
	...RETAINED_KEY_VARIABLES,
	...UNREACHABLE_BY_SCAN,
]);
