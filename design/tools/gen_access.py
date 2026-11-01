"""Setup, access and system states on the Pulse kit: SetupScreen, AccessStates, ConfirmStates, LiveStates."""
from pulse import *

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

# =====================================================================================
# 1. SETUP (first run, in the browser)
# =====================================================================================
def term(*cmds):
    return ('<details class="su-term"><summary>' + ic("terminal", "ic ic--sm") + 'In a terminal instead</summary>' +
            "".join(cmd(c) for c in cmds) + "</details>")

DONE = [("Deployment found", "the console reads its files from <span class='code'>pi-dispatch</span>"),
        ("Queue reachable", "Valkey answers; its address stays private"),
        ("Your operator token", "you are signed in as <b>an operator</b>")]

def done_rows():
    return '<ul class="su-done">' + "".join(
        f'<li><span class="tile tile--sm tone-ok">{ic("done")}</span><b>{t}</b><span>{d}</span></li>' for t, d in DONE) + \
        f'<li class="su-done__act">{btn("Add a viewer", "", "plus")}<span>preview a name, then Confirm; its private link works once, for 60 seconds</span></li></ul>'

def step(n, tone, glyph, word, title, sentence, body):
    return f"""<li class="su-step">
  <span class="tile tone-{tone}">{ic(glyph)}</span>
  <div class="su-step__b">
    <p class="su-step__t"><span class="su-n">{n}</span>{title}{f'<span class="su-opt">optional</span>' if word == "Optional" else f'<span class="chip tone-{tone}">{word}</span>'}</p>
    <p class="su-step__s">{sentence}</p>
    {body}
  </div>
</li>"""

WORKER = step(4, "running", "running", "Starting", "Start the worker",
    "The preview names its local service, current queue exposure and reserve estimates.",
    f"""<ol class="su-prog2" aria-live="polite" aria-label="Starting the worker">
  <li class="is-done">{ic('done', 'ic ic--sm')}<span>Wrote the service unit <span class="code">pi-dispatch-worker.service</span></span></li>
  <li class="is-done">{ic('done', 'ic ic--sm')}<span>Started it with the service manager</span></li>
  <li class="is-now">{ic('hourglass', 'ic ic--sm')}<span>Waiting for its first heartbeat, 8 s</span></li>
</ol>
<p class="su-small">The start is recorded in the audit log. Stopping requires a fresh preview and may interrupt work.</p>
<p class="su-small">A worker consumes manual jobs already in line and future matching events. Starting it can spend money.</p>
{term('pi-dispatch service install')}""")

EGRESS = step(5, "failed", "failed", "Not yet", "Start the egress proxy",
    "Jobs reach only the 12 hosts on the allowlist. Until the proxy runs, every job is refused before it spends.",
    f"""<div class="su-act">{btn('Start the egress proxy', 'primary', 'play', sm=False)}{btn('Review the allowlist', 'ghost', 'shield', sm=False)}</div>
{term('pi-dispatch up')}""")

def choice(on, icon, title, text, extra=""):
    return f"""<label class="su-ch{' su-ch--on' if on else ''}"><input type="radio" name="su-key"{' checked' if on else ''}>
  <span class="su-ch__h">{ic(icon, 'ic ic--sm')}<b>{title}</b></span><span class="su-ch__s">{text}</span>{extra}</label>"""

KEY = step(6, "failed", "failed", "Not yet", "Provider key",
    "Doctor found no usable API key or explicitly bound host-owned managed subscription.",
    f"""<p class="su-small">An ordinary pi OAuth login is not unattended service authentication. No fake Use action changes a published credential.</p>
<div class="su-ch"><span class="su-ch__h">{ic('key', 'ic ic--sm')}<b>Keys for several providers</b></span>
<span class="su-ch__s">Add or replace a write-only API key on Connections. Choose the provider explicitly; its default stays the same.</span>
<div class="su-act"><a class="btn btn--primary" href="#p-provider-keys">Manage provider API keys</a></div></div>
<p class="su-small">Provider guides show where to find or create keys at Anthropic, OpenAI, Google Gemini, OpenRouter and DeepSeek.</p>
<p class="su-small"><a class="link" href="#">Review subscription authentication</a> for host-owned subscription sign-in instead.</p>""")

RECIPES = [("tag", "Fix issues labelled pi:fix", "a label on GitHub runs flow fix"),
           ("clock", "Tidy a folder every night", "a schedule runs flow tidy in a folder"),
           ("comment", "Answer @pi in comments", "a comment phrase runs flow fix")]
TRIG = step(7, "idle", "plus", "To do", "Add a first trigger",
    "Start from a recipe; you see the triggers.json diff before anything is saved.",
    '<div class="su-rec">' + "".join(f'<a class="su-r" href="#"><span class="tile tile--sm">{ic(i)}</span><b>{t}</b><span>{d}</span></a>' for i, t, d in RECIPES) +
    f'</div><p class="su-small"><a class="link" href="#">Start from scratch</a> in the trigger editor.</p>')

GH = step(8, "idle", "git", "Optional", "Connect GitHub",
    "Only forge triggers need it; schedules on local folders run without.",
    f"""<p class="su-small">GitHub App creation and forge credentials stay in the terminal. Choose a webhook URL, or --no-webhook when using the poller.</p>
<p><a class="link" href="#">Review Connections</a></p>
{term('pi-dispatch setup github --webhook-url <receiver URL>')}
<p class="su-small">Replace the receiver URL, or pass --no-webhook instead. Browser App creation remains open in OQ-054.</p>""")

def su_bar():
    tones = ["ok", "ok", "ok", "running", "failed", "failed", "idle", "idle"]
    n = len(tones); gap = 0.8; w = (100 - gap * (n - 1)) / n
    segs = "".join(f'<rect class="su-seg tone-{t}{" su-seg--todo" if t == "idle" else ""}" x="{i * (w + gap):.2f}%" y="0" width="{w:.2f}%" height="10" rx="5"/>' for i, t in enumerate(tones))
    return f'<svg class="su-bar" height="10" role="img" aria-label="3 of 8 ready, 1 starting, 2 not yet, 1 to do, 1 optional">{segs}</svg>'

SETUP_MAIN = card("Getting ready",
    f'<div class="su-prog"><p><b class="su-big">3</b> of 8 ready · 1 starting</p>{su_bar()}</div>'
    f'<ol class="su-steps">{WORKER}{EGRESS}{KEY}{TRIG}{GH}</ol>',
    id_="p-setup", sub="live · from doctor on build3, a minute ago")

SETUP_SIDE = f"""<div class="stack">
{card('Ready', done_rows(), sub='3 of 8', id_="p-setup-ready")}
{card('The one command', '<p class="muted su-p">After the exact durable installation in the Quickstart.</p>' + cmd('pi-dispatch up --console') + '<p class="muted su-p su-p2">Or from pi, which opens this page for you:</p>' + cmd('/dispatch setup') + '<p class="su-small"><a class="link" href="#p-provider-keys">Manage provider API keys</a>, also after setup is ready.</p>', id_="p-setup-start")}
</div>"""

SETUP_CSS = """
.su-prog { display: grid; gap: 10px; padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-prog p { font-size: 14px; color: var(--ink-muted); }
.su-prog p b { color: var(--ink); }
.su-big { font-size: 40px; line-height: 44px; font-weight: 800; letter-spacing: -0.02em; margin-right: 4px; font-variant-numeric: tabular-nums; }
.su-bar { width: 100%; display: block; overflow: visible; }
.su-seg { fill: var(--tone); }
.su-seg--todo { fill: var(--surface-3); }
.su-done { display: grid; gap: 6px; margin-bottom: var(--space-4); }
.su-done li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.su-done b { color: var(--ink); }
.su-done__act { grid-template-columns: auto minmax(0, 1fr) !important; padding-left: 38px; }
.su-steps { display: grid; gap: 8px; }
.su-step { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-step__b { display: grid; gap: 10px; min-width: 0; }
.su-step__t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 15px; font-weight: 700; }
.su-step__t .chip, .su-step__t .su-opt { margin-left: auto; }
.su-opt { font-size: 12px; font-weight: 600; color: var(--ink-muted); }
.su-n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); color: var(--ink-muted); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.su-step__s { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.su-step__s b { color: var(--ink); }
.su-act { display: flex; gap: 8px; flex-wrap: wrap; }
.su-small { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.su-small .ic { flex: none; margin-top: 2px; }
.su-prog2 { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface); }
.su-prog2 li { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.su-prog2 li .code { white-space: normal; overflow-wrap: anywhere; }
.su-prog2 .is-done .ic { color: var(--ok-ink); }
.su-prog2 .is-now { color: var(--running-ink); font-weight: 650; }
.su-term summary { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); cursor: pointer; }
.su-term .cmd { margin-top: 8px; background: var(--surface); }
.su-chs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.su-chs--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.su-ch { position: relative; display: grid; align-content: start; gap: 6px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); text-decoration: none; color: inherit; cursor: pointer; }
.su-ch input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.su-ch--on { box-shadow: inset 0 0 0 2px var(--primary); }
.su-ch:focus-within, .su-ch--link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.su-ch__h { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.su-ch__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.su-ch__f .input { width: 100%; margin-top: 4px; }
.su-rec { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.su-r { display: grid; align-content: start; gap: 6px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); text-decoration: none; color: var(--ink); }
.su-r .tile { background: var(--surface-2); color: var(--ink); }
.su-r b { font-size: 13px; }
.su-r span:last-child { font-size: 12px; color: var(--ink-muted); }
.su-p { font-size: 13px; margin-bottom: var(--space-3); }
.su-p2 { margin-top: var(--space-3); }
#p-setup-ready .su-done { margin-bottom: 0; }
@media (max-width: 760px) { .su-step { grid-template-columns: minmax(0, 1fr); gap: 10px; } .su-step__t .chip, .su-step__t .su-opt { margin-left: 0; } .su-chs, .su-chs--3, .su-rec { grid-template-columns: minmax(0, 1fr); } .su-done li { grid-template-columns: auto minmax(0, 1fr); } .su-done li > span:last-child { grid-column: 2; } .su-done__act { padding-left: 0; } }
.setup-layout .su-step__s .code,.setup-layout .su-done .code{white-space:normal;overflow-wrap:anywhere}
.setup-layout .su-step__b,.setup-layout .su-done li{min-width:0}
.setup-layout .su-done li>details{grid-column:2 / -1}
.setup-layout .su-act .act{max-width:100%}
.setup-layout .su-step__t .chip{max-width:100%;height:auto;white-space:normal}
.setup-layout .config-form fieldset{min-width:0}
.setup-layout .su-step__s,.setup-layout .su-done span{overflow-wrap:anywhere}
.setup-layout .su-r:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

"""

write("SetupScreen", card_marker("Overview", 1600, 1440, "First run in the browser: supported host steps have an individual preview and Confirm"),
      "Set up pi-dispatch",
      shell("Overview", f'<div class="cols">{SETUP_MAIN}{SETUP_SIDE}</div>', "Set up pi-dispatch",
            sub="Finish supported steps here. The terminal way remains available for every step.", parked=0), SETUP_CSS)
readme("SetupScreen", """
First-run setup in the browser. A durable host bootstrap starts the console and prints a one-time link. Supported remaining steps each have a preview and Confirm. Terminal alternatives remain available.

**How a person uses it.**
- **The one command.** After the exact durable installation in the Quickstart, `pi-dispatch up --console` starts the console, creates or preserves an operator entry and prints a one-use 60-second setup link. It never starts a worker. `/dispatch setup` offers the same handoff.
- **Progress.** A big "3 of 8 ready", a segment for each step and real Starting progress. Published heartbeat and doctor facts decide readiness; a completed process alone does not. Missing, stale, partial and timed-out observations stay explicit.
- **Ready** (side). Ready steps fold to a row each. The deployment is shown by its last folder, Valkey without its address and sign-in by role alone. Add a viewer previews a name and returns a private viewer-only link after Confirm, usable once within 60 seconds.
- **Start the worker.** The preview names the service manager, local account, exact units and dependencies, queued manual jobs, armed schedules and reserve estimates. A start permits future consumption too. Stop and restart have a new preview; they can interrupt jobs and cannot undo spending.
- **Start the egress proxy.** Only start a deployment-owned missing/stopped local Docker or native-Podman proxy. Review the allowlist links to Connections with its actual count. Unsafe replacement, shared ownership and OpenShell gateway changes remain terminal steps.
- **Provider key.** Doctor judges existing API-key auth or a bound managed subscription. An ordinary pi OAuth login is not offered as service auth. Connections permanently lists provider key sources and offers explicit Add or Replace with a new write-only value through private 60-second state. Provider guides link to the official place to find or create a key. The default provider never changes with a key write; a running worker needs a separate restart. The management link remains available after this step is Ready.
- **Add a first trigger.** Three editable recipes: a GitHub label fix, nightly local-folder tidy and comment answer. The ordinary trigger planner previews the exact added lines; missing folder, skill or forge prerequisites stay actionable. Start from scratch remains available.
- **Connect GitHub (optional).** Published status, Connections and the complete `setup github --webhook-url <receiver URL>` or `--no-webhook` terminal path. Browser App creation remains open under OQ-054; no placeholder claims that credentials or a host login change in the browser.
- **In a terminal instead.** Native disclosures show the valid command, its placeholders and recovery instructions. Doctor is a separately previewed ordinary non-live, non-fixing action.

**Panels.** `p-setup`, `p-setup-ready`, `p-setup-start`.

**The server provides.**
- The deployment's last folder, queue reachability and the session role, never a shared sign-in name or Valkey address.
- Published host heartbeats and sanitized doctor checks for egress, provider and forge readiness, with freshness and partial-read status.
- A process-owned host grant's safe operation availability and bounded actual action progress, never authority inferred from fleet rows.
- The trigger count, Connections allowlist count and closed trigger-recipe defaults.

**Who sees what.** A viewer sees states without forms or terminal commands. An agent receives safe machine facts without person-only controls. A read-only operator sees terminal alternatives only. Missing host grant, unsupported manager, unsafe environment or remote runtime gives actionable host recovery. Private keys and invitation results never enter shared panels, role caches or live events.

**Why it works this way.**
- Each supported mutation is a person-only preview, Confirm, audit row and honest Undo line. The default-off host grant admits a closed local worker child, never arbitrary shell commands.
- A worker may immediately consume manual jobs without any trigger. The start preview describes present exposure and future arrivals retain ordinary admission and budget gates.
- Provider keys are create-only; invitation links bind the created viewer entry and stay private to the initiating session. Cancellation, expiry and sign-in changes dispose private state.
- Both themes, phone/intermediate/desktop layouts, keyboard focus through live swaps, native no-script reads and real-CSP interactions are verified. Mutation controls stay disabled without JavaScript.

**Fixture note.** This card is a sample deployment on build3. The worker is starting, three steps are ready and doctor still needs refreshing. Counts, host names and progress are illustrative, never runtime defaults. The published-source card is the reference when the remote artifact cannot be accessed.
""")

# =====================================================================================
# 2. ACCESS STATES: one-time link, roles, read-only
# =====================================================================================
def link_card(tone, glyph, title, body, cid):
    return f"""<section class="ac-link" id="{cid}" data-panel aria-labelledby="{cid}-h">
  <span class="brandpill__m ac-mark">pi</span>
  <span class="tile tone-{tone}">{ic(glyph)}</span>
  <h3 id="{cid}-h">{title}</h3>
  {body}
</section>"""

TOKEN_LINK = '<a class="link ac-tok" href="#">Sign in with a token instead</a>'
LINKS = f"""<div class="cards-3 ac-links">
{link_card('running', 'hourglass', 'Signing in with a one-time link', '<p class="muted">This takes a moment. The link is taken out of your browser history first, so it cannot be used again from there.</p>' + TOKEN_LINK, 'p-link-wait')}
{link_card('failed', 'failed', 'This sign-in link is used, expired or unknown', '<p class="muted">A link works once, for 60 seconds. Ask for a new one:</p>' + cmd('pi-dispatch-console link --name <you>') + TOKEN_LINK, 'p-link-used')}
{link_card('attention', 'attention', 'This link carries no code', '<p class="muted">Copy the whole link, or ask for a new one with <span class="code">pi-dispatch-console link</span>. In pi, <span class="code">/dispatch console --link</span> opens one for you.</p>' + TOKEN_LINK, 'p-link-nocode')}
</div>
<p class="ac-noscript">{ic('info', 'ic ic--sm')}Without JavaScript the sign-in page says only: <b>The console needs JavaScript to sign in.</b></p>"""

# roles board
ROLES = [("Operator", "ops", "Operator", ""), ("Viewer", "watcher", "Viewer", ""), ("Read-only console", "ops", "Operator", "ro")]

def who(n, r, ro):
    rochip = chip("Read-only console", "attention", "shield") if ro else ""
    return f'<div class="ac-who">{rochip}<span class="who"><span><b>{n}</b><small>{r}</small></span><span class="avatar">{n[:2]}</span></span></div>'

def nav(role):
    names = ["Overview", "Runs", "Parked", "Triggers", "Fleet", "Spend", "Configuration", "Models"] + (["Audit"] if role != "Viewer" else [])
    return '<p class="ac-nav">' + " · ".join(names) + "</p>"

FAIL_ID = '<span class="code">gh-f0c2</span> on <span class="code">pi-jobs@mini1</span>, 2 attempts'
def failrow(role):
    if role == "Operator":
        return f"""<div class="ac-row"><p>{badge('failed')} <span>{FAIL_ID}</span></p>
<details class="ac-why" open><summary>Why it failed</summary><p class="code">container exited 1 before the runner started: docker: Error response from daemon…</p></details>
<div class="ac-btns">{btn('Retry', 'paid', 'rerun')}{btn('Remove', 'danger', 'cancel')}</div></div>"""
    if role == "Viewer":
        return f'<div class="ac-row"><p>{badge("failed")} <span>{FAIL_ID}</span></p><p class="ac-hide">{ic("shield", "ic ic--sm")}Failure reasons are shown to operators only.</p></div>'
    return f"""<div class="ac-row"><p>{badge('failed')} <span>{FAIL_ID}</span></p>
<details class="ac-why"><summary>Why it failed</summary><p class="code">container exited 1 before the runner started…</p></details>
<p class="ac-hide">{ic('shield', 'ic ic--sm')}Every change is refused here, so there is no Retry or Remove.</p></div>"""

def chatrow(role):
    if role == "Operator":
        return f"""<div class="ac-row"><p>{badge('running')} <span><span class="code">gh-b3d7</span> · phase 2 of 4, <b>migrate the schema</b></span></p>
<div class="field"><label for="ac-steer">Steer</label><textarea id="ac-steer" class="textarea ac-ta" placeholder="Tell the agent what to change"></textarea></div>
<div class="ac-btns">{btn('Preview the steer', 'primary', 'steer')}</div></div>"""
    if role == "Viewer":
        return f"""<div class="ac-row"><p>{badge('running')} <span><span class="code">gh-b3d7</span> · phase 2 of 4</span></p>
<p class="ac-hide">{ic('shield', 'ic ic--sm')}Phase names and the run's note are shown to operators only.</p>
<p class="ac-hide">{ic('shield', 'ic ic--sm')}Transcripts are shown to operators only.</p>
<p class="ac-hide">{ic('shield', 'ic ic--sm')}Chat is for operators; a viewer sees the run's status only.</p></div>"""
    return f"""<div class="ac-row"><p>{badge('running')} <span><span class="code">gh-b3d7</span> · phase 2 of 4, <b>migrate the schema</b></span></p>
<p class="muted ac-small">The live transcript shows. To talk to the run, use a console that takes changes, or the terminal:</p>{cmd('pi-dispatch chat gh-b3d7')}</div>"""

def role_col(role, n, r, ro):
    return f"""<section class="card ac-col" id="p-role-{role.split()[0].lower()}" data-panel aria-labelledby="ac-{role.split()[0].lower()}">
  <div class="card__head"><h2 id="ac-{role.split()[0].lower()}">{role}</h2></div>
  <p class="cmp-l">Top bar</p>{who(n, r, ro)}
  <p class="cmp-l">Navigation</p>{nav(role)}
  <p class="cmp-l">A failed job on Fleet</p>{failrow(role)}
  <p class="cmp-l">A live run</p>{chatrow(role)}
</section>"""

ROLEBOARD = f'<div class="cards-3 ac-roles">{"".join(role_col(*r) for r in ROLES)}</div>'

ACCESS = f"""<a class="skip" href="#main">Skip to content</a>
<main id="main" class="page">
{titlebar('Access states', 'The one-time sign-in link, and what each role sees on the same page')}
<div class="sect"><h2>One-time link</h2><span class="card__sub">/login/code, opened from pi or from pi-dispatch-console link</span></div>
{LINKS}
<div class="sect"><h2>What each role sees</h2><span class="card__sub">the same failed job and the same live run</span></div>
{ROLEBOARD}
{banner('attention', 'shield', 'This console is read-only', 'It was started with <span class="code">PI_CONSOLE_READ_ONLY=1</span>, so every change is refused and no page shows a form. Operators still see reasons, transcripts and the audit log.', small=True)}
</main>"""

ACCESS_CSS = """
.cmp-l { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: 10px 0 6px; }
.ac-links { align-items: stretch; }
.ac-link { display: grid; align-content: start; gap: 10px; padding: var(--space-6); border-radius: var(--radius-xl); background: var(--surface); min-width: 0; }
.ac-link > * { min-width: 0; }
.ac-mark { width: 40px; height: 40px; font-size: 15px; }
.ac-link .tile { position: absolute; }
.ac-link { position: relative; }
.ac-link .tile { top: var(--space-6); right: var(--space-6); }
.ac-link h3 { font-size: 20px; line-height: 26px; font-weight: 800; letter-spacing: -0.01em; }
.ac-link .muted { font-size: 13px; line-height: 20px; }
.ac-tok { font-size: 13px; font-weight: 650; }
.ac-noscript { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-muted); margin: 0 4px; }
.ac-noscript b { color: var(--ink); }
.ac-roles { align-items: start; }
.ac-col .card__head { margin-bottom: 0; }
.ac-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-nav { font-size: 13px; color: var(--ink-muted); line-height: 20px; }
.ac-row { display: grid; gap: 8px; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.ac-row > p:first-child { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-why summary { cursor: pointer; font-weight: 650; }
.ac-why p { margin-top: 6px; color: var(--ink-muted); white-space: normal; overflow-wrap: anywhere; }
.ac-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.ac-hide { display: flex; align-items: flex-start; gap: 8px; color: var(--ink-muted); }
.ac-hide .ic { margin-top: 2px; flex: none; }
.ac-ta { min-height: 64px; }
.ac-small { font-size: 12px; }
.ac-row .cmd { background: var(--surface); }
@media (max-width: 760px) { .ac-link { padding: var(--space-5); } .ac-link .tile { top: var(--space-5); right: var(--space-5); } }
"""

write("AccessStates", card_marker("Access", 1280, 1440, "The one-time link page in its three states, and operator, viewer and read-only side by side"),
      "Access states", ACCESS, ACCESS_CSS)
readme("AccessStates", """
The access states that are not the sign-in form itself: the one-time link page, and what an operator, a viewer and a read-only console each see on the same page.

**How a person uses it.**
- **One-time link.** `/login/code#<code>` shows "Signing in with a one-time link" while it posts the code, after taking the code out of the browser history. If the link was used, has expired or is unknown, it says so, gives the command for a new link, and offers "Sign in with a token instead". A link with no code says so too. Without JavaScript the page says only "The console needs JavaScript to sign in."
- **Operator.** Sees reasons, transcripts, phase names, chat, Audit and every action, each as preview then Confirm.
- **Viewer.** Sees the same rows and numbers. In place of a hidden detail, the viewer gets the repo's sentence, such as "Failure reasons are shown to operators only.", "Phase names and the run's note are shown to operators only.", "Transcripts are shown to operators only." or "Chat is for operators; a viewer sees the run's status only." There are no action buttons, and no Audit in the nav.
- **Read-only console.** A console started with `PI_CONSOLE_READ_ONLY=1` shows a "Read-only console" chip in the top bar and a banner. Operators keep every detail, but no page has a form, and talking to a run points to the terminal command.

**Panels.** `p-link-wait`, `p-link-used`, `p-link-nocode`, `p-role-operator`, `p-role-viewer`, `p-role-read-only`.

**The server provides.** The signed-in token's name and role, the read-only flag, and for the link page a closed answer: signing in, used/expired/unknown, or no code. A role decides on the server which panels and fields are sent at all. A viewer's page never carries the hidden text.

**Fixture note.** gh-f0c2 (failed on mini1) and gh-b3d7 (running, phase 2 of 4) are fixture runs. The failure text and the phase name are sample copy.
""")

# =====================================================================================
# 3. CONFIRM STATES (component)
# =====================================================================================
G = "Components"
def comp(name, height, title, body, style="", width=1100, subtitle=""):
    return write(name, card_marker(G, height, width, subtitle or title), title,
                 f'<main class="page cmp">{body}</main>',
                 ".cmp { padding: var(--space-4); } .cmp-l { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: 6px 0 -4px; }" + style)

def L(t): return f'<p class="cmp-l">{t}</p>'

PREVIEWING = f"""<div class="confirm cs-busy" role="region" aria-live="polite" aria-busy="true" aria-label="Preview">
  <p class="confirm__h">{ic('hourglass')}Previewing the retry of gh-f0c2</p>
  <ul class="confirm__list cs-ghost"><li><span></span></li><li><span></span></li></ul>
  <div class="confirm__act"><button class="btn btn--confirm-paid" type="button" disabled>Retry for up to $2.00</button><button class="btn btn--ghost" type="button">Cancel</button></div>
</div>"""

NOCHANGE = f"""<div class="confirm cs-none" role="region" aria-live="polite" aria-label="Preview">
  <p class="confirm__h">{ic('done')}No change</p>
  <p class="cs-s">The file already says this: <span class="code">maxTurns</span> is 40.</p>
  <div class="confirm__act"><button class="btn" type="button">Close</button></div>
</div>"""

RESERVES = [
    ("spend", "A per-job cap", "It holds 1 job slot and <b>$2.00</b> (the per-job cap) in each dollar window that applies, until it settles."),
    ("done", "Zero-rated", "It holds 1 job slot and <b>$0.00</b>: every model it may call is zero-rated."),
    ("slot", "No per-job cap", "It holds 1 job slot. No per-job dollar cap is set, so no dollar window can hold anything for it."),
    ("info", "Unknown", "Reserve unknown: the job's data could not be read, so what the worker will hold for it cannot be said."),
    ("failed", "Setting does not parse", "The deployment's dollar setting does not parse (<span class='code'>2,00</span>), so the worker refuses every job until it is fixed."),
]
RESERVE_CARD = card("What a paid preview says it holds",
    '<ul class="cs-res">' + "".join(f'<li><span class="tile tile--sm tone-{"failed" if i == "failed" else "attention" if i == "spend" else "idle"}">{ic(i)}</span><div><b>{h}</b><p>{s}</p></div></li>' for i, h, s in RESERVES) + "</ul>",
    sub="one of these, under the paid preview's list")

BULK = confirm("paid", "Retry 3 failed jobs in pi-jobs@mini1",
    ["Each is re-checked and retried alone.",
     '<span class="code">gh-f0c2</span> on pi-jobs@mini1, 2 attempts, acme/web#491, reserve $2.00',
     '<span class="code">gh-9d14</span> on pi-jobs@mini1, 2 attempts, acme/web#488, reserve $2.00',
     '<span class="code">local-71c0</span> on pi-jobs@mini1, 1 attempt, local:site, reserve $0.00 (zero-rated)',
     "2 more match and are <b>not in this action</b> (at most 100 per action)."],
    "Cancel the 3 new runs", "Retry 3 for up to $4.00",
    extra='<p class="cs-s">Together they hold <b>3 job slots and $4.00</b> in each dollar window that applies.</p>')

BULK_DONE = f"""<div class="banner tone-attention cs-bulk" role="status">
  <span class="tile">{ic('attention')}</span>
  <div><p class="banner__t">2 of 3 retried</p>
  <ul class="cs-list">
    <li>{ic('done', 'ic ic--sm')}<span><span class="code">gh-f0c2</span>: done</span></li>
    <li>{ic('done', 'ic ic--sm')}<span><span class="code">gh-9d14</span>: done</span></li>
    <li>{ic('failed', 'ic ic--sm')}<span><span class="code">local-71c0</span>: not done, job local-71c0 is waiting now, not failed: it changed since the preview. Nothing was done</span></li>
  </ul><p class="banner__s">Audit rows 41 to 43.</p></div>
  <div class="banner__act">{btn('Reload', 'primary')}</div>
</div>"""

PREVIEW_REFUSED = [
    ("refused", "config", "This deployment does not name the file this change writes", "Set <span class='code'>PI_TRIGGERS_FILE</span> in the deployment's .env, then preview again. Nothing was changed."),
    ("refused", "terminal", "This console was started without what the re-run action needs", "It needs <span class='code'>PI_TRIGGERS_FILE</span>; see its log. Nothing was changed."),
    ("refused", "doctor", "The preview failed", "The console's log has the reason. Nothing was changed."),
]
CONFIRM_REFUSED = [
    ("attention", "clock", "This confirmation has expired", "A preview holds for 5 minutes. Preview the change again and confirm the new preview.", btn("Preview again", "primary")),
    ("attention", "rerun", "It changed since the preview", "Job <span class='code'>gh-f0c2</span> failed again since the preview. Nothing was done; look again.", btn("Look again")),
    ("attention", "shield", "This confirmation belongs to another sign-in", "Preview the change again in this tab and confirm the new preview.", btn("Preview again")),
    ("failed", "queue", "The deployment's Valkey could not be reached", "So nothing was changed. Try again.", btn("Try again")),
    ("failed", "audit", "The audit log could not be written", "So nothing was changed. Check the console's log directory.", ""),
]

CONFIRM_BODY = f"""
{L('1. Asking: the preview is being built; Confirm waits')}
<div class="cards-2">{PREVIEWING}{NOCHANGE}</div>
{L('2. Paid: a single job, and many at once')}
<div class="cards-2">{RESERVE_CARD}<div class="stack">{BULK}</div></div>
{L('3. After a bulk confirm: one line per job, and Reload when any was refused')}
{BULK_DONE}
{L('4. Refused at preview: nothing was changed, and the sentence says what to set')}
<div class="cards-3">{''.join(banner(t, i, h, s, small=True) for t, i, h, s in PREVIEW_REFUSED)}</div>
<div class="cards-2"><div class="field field--err"><label for="cs-f">Max turns</label><input id="cs-f" class="input" value="-3"><p class="field__err">{ic('failed', 'ic ic--sm')}maxTurns must be a whole number, 0 or more; nothing was changed.</p></div>
<div class="field field--err"><label for="cs-g">Your answer</label><textarea id="cs-g" class="textarea">…</textarea><p class="field__err">{ic('failed', 'ic ic--sm')}The answer is 9,214 bytes, above the 8,192-byte limit; shorten it. Nothing was queued.</p></div></div>
{L('5. Refused at confirm: the write did not happen')}
<div class="stack cs-cr">{''.join(banner(t, i, h, s, a, small=True) for t, i, h, s, a in CONFIRM_REFUSED)}</div>
{L('6. Done: what changed, its audit row, and Undo')}
{banner('ok', 'done', 'Cancel acknowledged by mini1', 'Running job <span class="code">gh-b3d7</span> stopped within 4 seconds. Audit row 44.', '')}
"""
CONFIRM_CSS = """
.cs-busy .confirm__h .ic { color: var(--ink-muted); }
.cs-ghost li { list-style: none; margin-left: -18px; }
.cs-ghost span { display: block; height: 12px; border-radius: 6px; background: var(--surface-3); width: 80%; }
.cs-ghost li + li span { width: 55%; }
.cs-none { box-shadow: inset 0 0 0 1px var(--line-strong); }
.cs-s { font-size: 13px; color: var(--ink-muted); }
.cs-s b { color: var(--ink); }
.cs-res { display: grid; gap: 10px; }
.cs-res li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.cs-res b { font-size: 13px; }
.cs-res p { font-size: 13px; color: var(--ink-muted); }
.cs-res p b { color: var(--ink); }
.cs-list { display: grid; gap: 4px; margin: 6px 0; font-size: 13px; }
.cs-list li { display: flex; gap: 8px; align-items: flex-start; }
.cs-list .ic { margin-top: 2px; flex: none; }
.cs-bulk { align-items: start; }
.cs-cr { gap: 8px; }
.cmp .field { background: var(--surface); padding: var(--space-4); border-radius: var(--radius-lg); align-content: start; align-self: start; }
"""
comp("ConfirmStates", 1810, "Confirm states", CONFIRM_BODY + '<p class="collapsed">' + ic("shield", "ic ic--sm") + '<b>Agent capability</b> Every action names whether an agent may act alone, needs a person to confirm, or only a person may act. An inverse follows its current permission too.</p>', CONFIRM_CSS,
     subtitle="The write flow in every state: previewing, no change, paid reserves, bulk, refusals before and at confirm, done")

# =====================================================================================
# 4. LIVE STATES (component)
# =====================================================================================
PILLS = f"""<div class="ls-row">
  <span class="live" role="status"><span class="dot"></span>Live</span>
  <span class="live live--retry" role="status"><span class="dot"></span>Reconnecting</span>
  <span class="live live--off" role="status"><span class="dot"></span>Not live</span>
  <span class="live live--off ls-out" role="status">{ic('logout', 'ic ic--sm')}Signed out</span>
  <span class="ls-drawn">{ic('clock', 'ic ic--sm')}Drawn at 15:39 UTC · not live {btn('Reload', 'ghost', 'rerun')}</span>
</div>
<ul class="ls-legend">
  <li><b>Live</b> panels redraw when what they show changes. Overview, Runs, a run, Parked and Fleet are live.</li>
  <li><b>Reconnecting</b> keeps the page as it was and tries again every 2 seconds.</li>
  <li><b>Not live</b> means the console refused the stream or closed it: reload after closing another console tab.</li>
  <li><b>Signed out</b> ends every stream at once and goes to sign-in, which says why.</li>
  <li>Spend, Configuration and Audit are drawn once per load and say when.</li>
</ul>"""

HOLD = f"""<section class="card ls-held" aria-labelledby="ls-h1">
  <div class="card__head"><h2 id="ls-h1">Failed jobs</h2><span class="end"><span class="chip">{ic('pause', 'ic ic--sm')}Updates paused while you edit</span></span></div>
  <p class="ls-s">Newer data is waiting. It shows when you close the preview or leave the field, so nothing moves under your cursor.</p>
  {confirm('paid', 'Retry gh-f0c2 on pi-jobs@mini1', ['It goes back to waiting and runs again through every check before spend.', 'It holds 1 job slot and <b>$2.00</b> (the per-job cap) in each dollar window that applies, until it settles.'], 'Cancel the new run', 'Retry for up to $2.00')}
</section>"""

READFAIL = card("Active jobs", f'<div class="empty"><span class="tile tone-attention">{ic("queue")}</span><b>Nothing to show right now</b><span>The deployment\'s Valkey could not be read, so this panel has nothing to show. The next refresh tries again.</span></div>', id_="p-ls-fail")

STALE = card("Hosts", banner('attention', 'clock', 'Shown as last seen, at 15:37 UTC', 'The host registry could not be read; this shows the fleet as it was last seen.', small=True) +
    '<ul class="hosts ls-dim">' + hostrow("build3", "ok", venue("podman"), "4s", "", "rrf", '<span class="reason">2 of 3 slots</span>', pause=False) + hostrow("mini1", "ok", venue("local"), "9s", "", "rhf", '<span class="reason">1 held</span>', pause=False) + "</ul>",
    id_="p-ls-stale")

TXS = f"""<section class="card" aria-labelledby="ls-tx">
  <div class="card__head"><h2 id="ls-tx">Live transcript</h2><span class="end ls-row ls-row--sm">{chip('live', 'running', 'running')}{chip('reconnecting', 'attention', 'beat')}{chip('ended (completed)', 'ok', 'done')}{chip('not live', '', 'cancel')}</span></div>
  <ol class="tx ls-tx">
    {tx('call', '15:36:58', '<span class="muted">npm test -- checkout</span>', label='bash')}
    {tx('result', '15:37:20', '<span class="muted">42 passed</span>', label='bash')}
  </ol>
  <div class="ls-jump"><a class="btn btn--primary btn--sm" href="#">{ic('chev', 'ic ic--sm')}12 new entries below</a><span class="muted">You scrolled up, so the transcript stopped following the newest entry.</span></div>
  {banner('attention', 'beat', 'Stale: no update for 4 min; the worker may be gone.', 'Progress and the transcript stopped at 15:35 UTC. Fleet shows whether mini1 still beats.', btn('Open Fleet'), small=True)}
</section>"""

LIMIT = banner('attention', 'slot', 'Not live: this token has 4 live tabs open', 'That is the most one token may have. This tab stays as it is; close another console tab, then reload. A run page with its transcript open counts as two.', btn('Reload', 'primary'), small=True)
SIGNEDOUT = banner('idle', 'logout', 'Signed out', 'Your session ended, so the live panels stopped. Going to sign-in, which says why.', '', small=True)

LIVE_BODY = f"""
{L('The live pill and pages drawn once')}
{card('Live state', PILLS)}
{L('A panel in use is not swapped')}
<div class="cards-2">{HOLD}{TXS}</div>
{L('When a read fails: nothing to show, or shown as last seen')}
<div class="cards-2">{READFAIL}{STALE}</div>
{L('Stream limits and the end of a session')}
<div class="stack ls-stack">{LIMIT}{SIGNEDOUT}</div>
"""
LIVE_CSS = """
.ls-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ls-row--sm { gap: 6px; }
.ls-out .ic { color: var(--ink-muted); }
.ls-drawn { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-muted); margin-left: auto; }
.ls-legend { display: grid; gap: 4px; margin-top: var(--space-4); padding-left: 18px; list-style: disc; font-size: 13px; color: var(--ink-muted); }
.ls-legend b { color: var(--ink); }
.ls-s { font-size: 13px; color: var(--ink-muted); margin-bottom: var(--space-3); }
.ls-held { box-shadow: inset 0 0 0 1px var(--line); }
.ls-dim { margin-top: var(--space-3); }
.ls-dim .hostrow { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.ls-tx { margin-bottom: var(--space-3); }
.ls-jump { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; margin-bottom: var(--space-3); }
.ls-stack { gap: 8px; }
@media (max-width: 760px) { .ls-drawn { margin-left: 0; } }
"""
comp("LiveStates", 1330, "Live states", LIVE_BODY, LIVE_CSS,
     subtitle="The live pill, panels paused while in use, read failures, stale data, the transcript stream and stream limits")

READMES = {
 "ConfirmStates": """Every state of the two-step write, from asking for a preview to the audit row.

- **Agent capability.** Every preview names whether an agent may act alone, needs a person to confirm, or only a person may act, with the evaluated reason. Undo uses its inverse action under current permissions.
- **Previewing.** The confirm bar opens at once with its title and grey lines; Confirm stays disabled until the preview arrives.
- **No change.** When the change would write what is already there, the bar says so and offers only Close.
- **Paid.** Under the list, the preview says what the job will hold, in one of the repo's sentences: a per-job cap, zero-rated, no per-job cap, unknown, or a dollar setting that does not parse. Bulk previews list each job with its own reserve, say how many more match but are not in this action (at most 100), and total what they hold.
- **After a bulk confirm.** One line per job, "done" or "not done" with the reason. Reload is the primary action when any job was refused.
- **Refused at preview.** Field errors name the field and the rule. Whole-action refusals say what to set. Every one ends "nothing was changed".
- **Refused at confirm.** The repo's sentences: the ticket expired (5 minutes), was used, or belongs to another sign-in or action; it changed since the preview; Valkey unreachable; the audit log could not be written. Each says nothing was changed and offers the next step.
- **Done.** A banner names what changed and its audit row, with Undo where one exists.

Viewers never see this bar: they get no action buttons.""",
 "LiveStates": """How live data looks when it is live, paused, failing or over.

- **Live pill.** Live; Reconnecting (the page stays, retrying every 2 seconds); Not live (refused or closed: reload after closing another console tab); Signed out (every stream ends, then sign-in says why).
- **Pages drawn once.** Spend, Configuration and Audit say when they were drawn and offer Reload.
- **A panel in use is not swapped.** While a preview is open, a form has focus or a field has changed, the panel keeps still and says newer data is waiting.
- **Read failures.**
  - A snapshot panel with nothing to show says the Valkey could not be read, and that the next refresh tries again.
  - A panel that has older data shows it dimmed, under the time it was last seen.
- **Transcript stream.**
  - Status chips: live, reconnecting, ended (with the outcome), not live.
  - A jump pill counts new entries when the person has scrolled up.
  - Progress with no update for 3 minutes or more says the worker may be gone, and points to Fleet.
- **Stream limits.** One token may hold 4 live tabs (a run with its transcript counts as two). Past that, the tab stays still and says why.""",
}
for k, v in READMES.items():
    open(f"{ROOT}/{k}/README.md", "w").write(v + "\n")
print("setup, access, confirm states, live states written")
