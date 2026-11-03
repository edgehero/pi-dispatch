import { workbenchMarkup } from "./workbench-markup.mjs";
/** Public gateway shell. A cross-site arrival carries no assumed session, sandbox facts or grant. */
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Only an enrolled origin can supply the return destination; never a URL from the arriving request. */
export function gatewayConsoleOrigin(value) {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value ? value : null;
	} catch { return null; }
}

export function gatewayPage({ theme = null, consoleOrigin = null } = {}) {
	const origin = gatewayConsoleOrigin(consoleOrigin);
	const selected = ["light", "dark"].includes(theme) ? theme : null;
	const back = origin ? `${origin}/sandbox/gateway/return` : null;
	return `<!doctype html>
<html lang="en"${selected ? ` data-theme="${selected}"` : ""}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${selected ?? "light dark"}"><meta name="gateway-console-origin" content="${escape(origin ?? "")}"><title>Sandbox terminal · pi-dispatch</title><link rel="stylesheet" href="/static/gateway.css"><script src="/static/gateway.js" defer></script></head>
<body><a class="skip" href="#main">Skip to content</a><main id="main" class="gw-page" tabindex="-1">
<header class="gw-head"><span class="brandpill"><span class="brandpill__m">pi</span>pi-dispatch</span><span class="chip">Sandbox gateway</span><div class="gw-head__end"><button id="gateway-theme" class="btn btn--ghost btn--sm" type="button" hidden>Theme: follows the system</button>${back ? `<a id="gateway-return" class="btn btn--ghost btn--sm" href="${escape(back)}" rel="noreferrer">Return to console</a>` : ""}</div></header>
<div class="gw-title"><h1>Sandbox terminal</h1><p>An existing sandbox, in its own tab. The gateway starts no container.</p></div>
<section id="gateway-state" class="card gw-state" role="status" aria-live="polite" tabindex="-1"><div class="card__head"><h2 id="gateway-state-title">Checking this launch</h2></div><p id="gateway-state-text">The console must authorize this browser before a terminal opens.</p><noscript><p>JavaScript is required for a browser terminal. Return to the console and copy the command for your own terminal.</p></noscript></section>

<p class="gw-foot">Only a running sandbox explicitly authorized by an operator can open here. Kept workspaces open first in your own terminal.</p>
</main>${workbenchMarkup(back ? escape(back) : null)}</body></html>`;
}
