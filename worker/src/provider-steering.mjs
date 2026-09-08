/**
 * The environment variables pi and its provider SDKs read to CONFIGURE a provider: where the request goes,
 * and which credentials it carries (issue #314).
 *
 * WHY THIS IS A REFUSAL. `run.secrets` lets a trigger name an environment variable, and the existing gates
 * refuse the names the worker writes and the ones pi reads the resolved provider's KEY from. They refuse
 * nothing that says where the request goes, and that is the worse of the two: substitution spends the
 * trigger author's money, redirection sends the OPERATOR'S credential to a host the trigger chose.
 *
 * Measured against the 0.80.7 pin with a stubbed fetch and no real key, three providers, three routes:
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
 * four of pi's thirty-one key variables happen to appear as literals in a scanned artifact, so
 * `OPENAI_API_KEY` would refuse while `GROQ_API_KEY` and `HF_TOKEN` stayed bindable, and the documented
 * rule would be false for reasons no operator could predict. They are subtracted, and the bolt subtracts
 * them the same way rather than by hand.
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
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_LOG",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
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
	"GEMINI_NEXT_GEN_API_BASE_URL",
	"GEMINI_NEXT_GEN_API_LOG",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_GEMINI_BASE_URL",
	"GOOGLE_GENAI_USE_ENTERPRISE",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_VERTEX_BASE_URL",
	"OPENAI_API_VERSION",
	"OPENAI_BASE_URL",
	"OPENAI_LOG",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
	"OPENAI_WEBHOOK_SECRET",
	"PI_CACHE_RETENTION",
	"PI_GATEWAY",
	"PI_OAUTH_CALLBACK_HOST",
	...UNREACHABLE_BY_SCAN,
]);
