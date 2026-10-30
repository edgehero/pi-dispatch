/**
 * The console stylesheet (#750): shared tokens and the pinned Pulse bundle, then shell and page rules.
 * Served as an external same-origin resource under the console CSP. Every screen now uses the kit.
 */
import { TRIGGERS_CSS } from "./triggers-css.mjs";
import { CONFIG_CSS } from "./config-css.mjs";
import { SHELL_CSS, pageCss } from "./page-css.mjs";
import { PULSE_CSS } from "./pulse-css.mjs";
import { tokenCss } from "./pulse-tokens.mjs";

export const CONSOLE_CSS = [tokenCss(), PULSE_CSS, SHELL_CSS, pageCss(), CONFIG_CSS, TRIGGERS_CSS].join("\n");
