import { SUBSCRIPTION_AUTH_CSS } from "./subscription-auth-css.mjs";
import { PROVIDER_KEYS_CSS } from "./provider-keys-css.mjs";
import { MODELS_CSS } from "./models-css.mjs";
import { AGENT_POLICY_CSS } from "./agent-policy-css.mjs";
/**
 * The console stylesheet (#750): shared tokens and the pinned Pulse bundle, then shell and page rules.
 * Served as an external same-origin resource under the console CSP. Every screen now uses the kit.
 */
import { TRIGGERS_CSS } from "./triggers-css.mjs";
import { SECRETS_CSS } from "./secrets-css.mjs";
import { CONNECTIONS_CSS } from "./connections-css.mjs";
import { PROJECT_CSS } from "./project-css.mjs";
import { CONFIG_CSS } from "./config-css.mjs";
import { SHELL_CSS, pageCss } from "./page-css.mjs";
import { PULSE_CSS } from "./pulse-css.mjs";
import { tokenCss } from "./pulse-tokens.mjs";

export const CONSOLE_CSS = [tokenCss(), PULSE_CSS, SHELL_CSS, AGENT_POLICY_CSS, pageCss(), CONFIG_CSS, TRIGGERS_CSS, SECRETS_CSS, CONNECTIONS_CSS, PROJECT_CSS, MODELS_CSS, SUBSCRIPTION_AUTH_CSS, PROVIDER_KEYS_CSS].join("\n");
