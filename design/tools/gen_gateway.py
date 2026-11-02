"""Separate sandbox gateway, fresh sign-in and truthful terminal states (#754). No console shell channel."""
from pulse import *

# FitAddon measures the parent box and subtracts xterm's own padding, so the inset belongs
# on xterm. Its pinned legacy viewport also needs an explicit token background below the new scroller.
CSS = """
[hidden] { display: none !important; }
.gw-page { width: 100%; max-width: 1440px; margin: 0 auto; padding: var(--space-6); display: grid; gap: var(--space-5); }
.gw-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); min-width: 0; }
.gw-head__end { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-left: auto; }
.gw-title h1 { font-size: 28px; line-height: 36px; font-weight: 750; letter-spacing: -.025em; }
.gw-title p { margin-top: var(--space-2); color: var(--ink-muted); font-size: 14px; line-height: 22px; }
.gw-state { max-width: 760px; }
.gw-state p { color: var(--ink-muted); line-height: 22px; overflow-wrap: anywhere; }
.gw-state:focus { outline: 2px solid var(--focus); outline-offset: 4px; }
.gw-terminal-card { min-width: 0; padding: 0; overflow: hidden; }
.gw-terminal-head { padding: var(--space-4) var(--space-5); display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); border-bottom: 1px solid var(--line); }
.gw-terminal-head h2 { font-family: var(--font-mono); font-size: 18px; line-height: 26px; font-weight: 700; overflow-wrap: anywhere; }
.gw-identity { margin-top: 4px; color: var(--ink-muted); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.gw-terminal-toolbar { padding: var(--space-3) var(--space-5); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); background: var(--surface); }
.gw-focus-control { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); font-size: 13px; cursor: pointer; }
.gw-focus-control input { width: 16px; height: 16px; accent-color: var(--primary); }
.gw-focus-control input:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
.gw-idle { color: var(--ink-muted); font-size: 12px; margin-left: auto; }
.gw-keyboard { padding: 0 var(--space-5) var(--space-3); color: var(--ink-muted); font-size: 12px; line-height: 20px; }
.gw-terminal { min-width: 0; width: 100%; height: min(64vh, 720px); min-height: 360px; background: var(--surface-2); }
.gw-terminal .xterm { height: 100%; padding: var(--space-4); }
.gw-terminal .xterm .xterm-viewport { background: var(--surface-2); }
.gw-terminal:focus-within .xterm-viewport { box-shadow: inset 0 0 0 2px var(--focus); }
.gw-terminal-foot { padding: var(--space-3) var(--space-5); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border-top: 1px solid var(--line); color: var(--ink-muted); font-size: 12px; line-height: 20px; }
.gw-terminal-foot > span { flex: 1 1 300px; }
.gw-foot { color: var(--ink-muted); font-size: 12px; line-height: 20px; }
.gw-reference-output { margin: 0; padding: var(--space-4); font-family: var(--font-mono); font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
.gw-reference-prompt { color: var(--ok-ink); }
.gw-reference-cursor { display: inline-block; height: 17px; width: 8px; vertical-align: -3px; background: var(--ink); }
.gw-state-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.gw-state-grid .card { min-width: 0; }
.gw-stepup { max-width: 680px; }
.gw-stepup form { display: grid; gap: var(--space-3); }
.gw-stepup .input { max-width: 100%; }
.gw-stepup-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.gw-stepup .facts { margin-bottom: var(--space-4); }
@media (max-width: 760px) {
  .gw-page { padding: var(--space-4); gap: var(--space-4); }
  .gw-title h1 { font-size: 24px; line-height: 32px; }
  .gw-head__end { margin-left: 0; }
  .gw-state-grid { grid-template-columns: minmax(0, 1fr); }
  .gw-reference-desktop { display: none; }
  .gw-terminal { min-height: 280px; }
}
@media (min-width: 761px) { .gw-reference-phone { display: none; } }
"""

CONSOLE_CSS = """
.gw-stepup { max-width: 680px; min-width: 0; }
.gw-stepup > .card { display: grid; gap: var(--space-4); }
.gw-stepup .card__head { margin-bottom: 0; }
.gw-stepup p { color: var(--ink-muted); font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.gw-stepup #gateway-target { font-family: var(--font-mono); font-size: 18px; line-height: 26px; overflow-wrap: anywhere; }
.gw-stepup #gateway-details { display: grid; gap: var(--space-2); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.gw-stepup form { display: grid; gap: var(--space-4); }
.gw-stepup form .btn { justify-self: start; }
"""

def frame(title, sub, body):
    head = '<header class="gw-head"><span class="brandpill"><span class="brandpill__m">pi</span>pi-dispatch</span>' + chip('Sandbox gateway') + '<div class="gw-head__end">' + btn('Theme: follows the system', 'ghost') + btn('Return to console', 'ghost') + '</div></header>'
    return '<a class="skip" href="#main">Skip to content</a><main id="main" class="gw-page">' + head + f'<div class="gw-title"><h1>{title}</h1><p>{sub}</p></div>' + body + '</main>'

def terminal():
    output = '<pre class="gw-reference-output"><span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> pwd\n/workspace\n<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> git status --short\n M src/routes.mjs\n<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> <span class="gw-reference-cursor"></span></pre>'
    content = f'<section class="card gw-terminal-card gw-reference-desktop" id="p-gateway-terminal" data-panel><div class="gw-terminal-head"><div><h2>gh-9575</h2><p class="gw-identity">mini1 · ops · existing sandbox shell</p></div>{badge("running", "Connected")}</div><div class="gw-terminal-toolbar"><label class="gw-focus-control"><input type="checkbox" checked> Tab moves focus</label><span class="gw-idle">Idle logout after 30 minutes without input here</span>{btn("Disconnect", "danger")}</div><p class="gw-keyboard">Turn off “Tab moves focus” for shell completion. Ctrl+Shift+M switches it back. Escape and Ctrl+C keep their shell meaning.</p><div class="gw-terminal">{output}</div><div class="gw-terminal-foot"><span>Only new output is shown; the original terminal may already hold the prompt. What you type is not recorded. Disconnect leaves the original shell running.</span>{btn("Leave terminal focus", "ghost")}</div></section>'
    phone = '<section class="card gw-reference-phone"><div class="card__head"><h2>Use your own terminal</h2></div><p class="gw-foot">Browser terminals require a window wider than 760 pixels. Return to Sandboxes and copy the command.</p></section>'
    return frame('Sandbox terminal', 'An existing sandbox, in its own tab. The gateway starts no container.', content + phone + '<p class="gw-foot">Only a running sandbox explicitly authorized by an operator can open here. Kept workspaces open first in your own terminal.</p>')

def signin():
    body = '<p role="status">Enter this sign-in’s current operator token. The one-use attachment grant lasts 60 seconds.</p><div id="gateway-details"><h2 id="gateway-target">gh-9575 on mini1</h2><p>Verify as ops before attaching through https://sandbox.example.test.</p><p>The gateway attaches to this existing shell. It cannot start a sandbox. Closing its tab disconnects and keeps the shell; End remains a separate confirmed action.</p></div>'
    body += '<form><div class="field"><label class="field__l" for="gateway-token">Your current operator token</label><input id="gateway-token" class="input" type="password" autocomplete="off"><p class="field__hint">Enter the token used for this sign-in. It stays on the console origin and is not saved.</p></div>' + btn('Verify and open terminal', 'primary', sm=False) + '</form><p><a class="link" href="#">Return to Sandboxes</a></p>'
    top = '<header class="top"><a class="brandpill" href="#"><span class="brandpill__m">pi</span>pi-dispatch</a><div class="top__end"><button class="roundbtn" type="button" aria-label="Theme: follows the system">' + ic('theme') + '</button></div></header>'
    lead = '\n'.join(line.rstrip() for line in titlebar('Confirm browser access').splitlines())
    return '<a class="skip" href="#main">Skip to content</a><div class="page">' + top + '<main id="main">' + lead + '<section class="gw-stepup">' + card('Verify this terminal opening', body, sub='a separate gateway, attached to an already-open sandbox', id_='p-gateway-signin') + '</section></main></div>'

STATES = [
    ('Off on this host', 'Browser access is off unless the operator enrolls a separate gateway. Open in Terminal and copy remain available.'),
    ('Start the shell first', 'A kept or prepared workspace has no running shell. Open it from your own terminal, then choose it under Open now.'),
    ('Use your own terminal', 'Browser terminals require a window wider than 760 pixels. Shrinking into the phone layout disconnects the browser.'),
    ('This launch has ended', 'The one-use authorization expired or was already used. Return to Sandboxes and start a new browser launch.'),
    ('Already open', 'One browser terminal may attach to a sandbox at a time. Use its existing tab, or disconnect it before starting a fresh launch.'),
    ('Session ended', 'The operator session ended or its authority changed. The browser disconnected and its terminal buffer was cleared.'),
    ('Idle logout', 'The browser disconnected after the configured interval without input. The original shell and kept workspace are unchanged.'),
    ('Connection lost', 'The gateway could not keep the connection. Nothing is replayed. Inspect the host, then authorize a new browser launch.'),
    ('Sandbox ended', 'The existing container stopped. The gateway starts no replacement container.'),
    ('JavaScript is required', 'Reading this explanation works without JavaScript. Return to Sandboxes and copy the command for your own terminal.'),
    ('Browser coordination unavailable', 'Secure browser launch needs Web Locks to keep concurrent cookie binding safe. Use Open in Terminal or copy when this browser cannot provide them.'),
]

def states():
    cards = ''.join(card(title, '<p class="gw-foot">' + text + '</p>', end=chip('Needs a look', 'attention', 'attention')) for title, text in STATES)
    return frame('Sandbox terminal states', 'The same truthful states in both themes. A refusal never opens a shell.', '<div class="gw-state-grid" id="p-gateway-states" data-panel>' + cards + '</div>')

README = {
    'SandboxTerminal': '''The sandbox gateway’s own tab, on a different hostname from the console. It attaches to an existing shell after fresh operator authorization. The console keeps its current CSP, assets and one-way SSE channel.

**How a person uses it.**
- Read the sandbox id, host and signed-in operator before typing. Connected means this browser has the one active gateway attachment to that exact container.
- Type and read new output in the terminal; earlier screen contents are not replayed and no Enter is injected to redraw them. Ordinary Escape, Ctrl+C, arrow keys, Unicode and shell completion work. “Tab moves focus” starts on; turn it off for completion, or use Ctrl+Shift+M to switch it back.
- Disconnect closes the browser attachment and clears its terminal buffer. It leaves the original shell running; Ctrl+D can end that shell normally.
- Return to console goes through its generic return page so a cross-site navigation does not discard the original Strict-cookie session.
- On a phone, no terminal opens. Copy the command from Sandboxes instead. Shrinking a connected window into that layout disconnects it.
- Use a current browser with Web Locks. Without secure launch coordination, the gateway refuses before cookie binding and keeps the native terminal fallback.

**Panels.** `p-gateway-terminal`.

**The server provides.**
- A one-use authorization for the current operator session, browser launch and exact live container, after fresh sign-in with the same token.
- The host, sandbox id, operator and configured idle timeout only after authorization. Terminal input and output never enter a run record or audit payload.
- Existing-container output and bounded input/resize messages. There is no container creation, exec, command choice, image choice, terminal history or automatic reconnect.

**Why it works this way.** The gateway is off by default and explicitly enrolled. Its own hostname isolates host cookies. Its self-hosted xterm renderer needs generated styles, so its own CSP allows inline styles; the console’s CSP remains unchanged. OSC title, link and clipboard commands have no browser side effects.

**Fixture note.** gh-9575, mini1, ops and the terminal output are sample. The static reference illustrates xterm’s rendered surface; the application uses the real terminal renderer and transport, verified by behavioral and browser tests.
''',
    'SandboxGatewaySignIn': '''Fresh sign-in for one sandbox attachment, drawn in the console before returning to the separate gateway tab. The original console session and launch tab must both survive the rendezvous.

**How a person uses it.**
- Check the sandbox, host, operator identity and enrolled gateway destination. Enter the same operator token used by the current session, then authorize this terminal or cancel.
- The console validates the token without replacing the session. A different operator token, changed session, missing launch proof or expired intent refuses with a reason.
- Authorization lasts 60 seconds, works once, and remains server side. Public request ids in navigation confer no authority. Browser and console proofs never become URLs.
- With JavaScript unavailable, token submission is disabled and the page explains how to return to Sandboxes and copy the command.

**Panels.** `p-gateway-signin`.

**The server provides.** The original live session’s closed identity and the exact shell/gateway context, only after same-origin initialization. A generic cross-site arrival contains no private metadata.

**Fixture note.** ops, mini1, gh-9575 and sandbox.example.test are sample. No real token is shown or embedded.
''',
    'SandboxGatewayStates': '''Exceptional states of the standalone sandbox gateway and the console’s attachment controls. A blocked or disconnected state never silently retries, replays input or starts a replacement container.

**How a person uses it.**
- Read the state and follow its specific next step: enable an enrolled gateway, start a native shell, use the existing browser window, sign in again or inspect the host.
- Phone and no-JavaScript states keep the native terminal/copy route. A stale public id or replayed authorization requires a fresh launch.
- Session loss, idle timeout, connection loss and sandbox exit disconnect the browser and clear its terminal buffer. What was typed is not recorded.

**Panels.** `p-gateway-states`.

**The server provides.** Closed reason words mapped to actionable, fixed sentences. Raw runtime errors, terminal output and credentials never become a banner.

**Fixture note.** Every card is an illustrative state, not a claim that a gateway is currently connected.
''',
}

if __name__ == '__main__':
    for name, title, body, height in [('SandboxTerminal', 'Sandbox terminal', terminal(), 1000), ('SandboxGatewaySignIn', 'Sign in again', signin(), 900), ('SandboxGatewayStates', 'Sandbox terminal states', states(), 1300)]:
        write(name, card_marker('Runs', height, 1440, title + ', separate gateway, #754'), title, body, CSS + (CONSOLE_CSS if name == 'SandboxGatewaySignIn' else ''))
        open(f'{ROOT}/{name}/README.md', 'w').write(README[name].strip() + '\n')
    print('sandbox gateway cards written')
