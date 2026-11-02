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
<section id="gateway-terminal-card" class="card gw-terminal-card" aria-labelledby="gateway-terminal-title" hidden><div class="gw-terminal-head"><div><h2 id="gateway-terminal-title">Sandbox</h2><p id="gateway-identity" class="gw-identity"></p></div><span id="gateway-connection" class="badge tone-running">Connecting</span></div><div class="gw-terminal-toolbar"><label class="gw-focus-control"><input id="gateway-tab-focus" type="checkbox" checked> Tab moves focus</label><span id="gateway-idle" class="gw-idle"></span><button id="gateway-disconnect" class="btn btn--danger btn--sm" type="button" disabled>Disconnect</button></div><p id="gateway-keyboard-help" class="gw-keyboard">Turn off “Tab moves focus” for shell completion. Ctrl+Shift+M switches it back. Escape and Ctrl+C keep their shell meaning.</p><div id="gateway-terminal" class="gw-terminal" aria-describedby="gateway-keyboard-help"></div><div class="gw-terminal-foot"><span>Only new output is shown; the original terminal may already hold the prompt. What you type is not recorded. Disconnect leaves the original shell running.</span><button id="gateway-after-terminal" class="btn btn--ghost btn--sm" type="button">Leave terminal focus</button></div></section>
<p class="gw-foot">Only a running sandbox explicitly authorized by an operator can open here. Kept workspaces open first in your own terminal.</p>
</main></body></html>`;
}
