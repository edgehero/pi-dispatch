"""A run's kept workspace on its own run page, and the run in the terminal's own tab (proposed, after #754).

Three cards:
- RunWorkspace: a completed run with a shell open on its workspace. Who is in it, how to open it, and where what you
  found goes, so the next run benefits and not only this person.
- RunWorkspaceStates: the same panel for every outcome, from "try it before you merge" to "nothing to open", and
  "prepare from this run" when the workspace cannot reopen.
- SandboxTerminalRun: the gateway's terminal tab when it knows its run: the run's facts above the shell, and the way
  back to the run.

Nothing here starts a container from the browser: the gateway stays attach-only (#754). Starting a shell from the run
page is a separate decision, and these cards do not assume it."""
from pulse import *
from gen_runs import RUN_STYLE, run_title, ended_facts, ended_tokens, ended_resources, ended_session
from gen_sandboxes import command
from gen_gateway import CSS as GW_CSS


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


def code(t):
    return f'<span class="code">{E(t)}</span>'


CSS = """
/* Ids and commands wrap inside a card on a phone rather than widening it. */
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.ws { display: grid; gap: var(--space-4); }
.ws-state { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.ws-state__t { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; }
.ws-state__s { margin-top: 4px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-who { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px var(--space-3); align-items: start; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); box-shadow: inset 0 0 0 1.5px var(--running); background: var(--running-tint); }
.ws-who .dot { margin-top: 6px; }
.ws-who__t { font-size: 14px; line-height: 20px; }
.ws-who__s { margin-top: 2px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-who__a { grid-column: 2; display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-2); }
.ws-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ws-acts details { flex: 1 1 100%; min-width: 0; }
.ws-acts details summary { cursor: pointer; font-size: 13px; color: var(--ink-muted); }
.ws-acts details .cmd { margin-top: 8px; }
.ws-note { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-note .ic { flex: none; margin-top: 2px; }
.ws-note b { color: var(--ink); font-weight: 650; }
.ws-none { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-none .ic { flex: none; margin-top: 2px; }
.ws-routes { display: grid; gap: var(--space-3); }
.ws-route { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px var(--space-3); padding: var(--space-4); border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); }
.ws-route > .tile { grid-row: span 2; }
.ws-route__t { font-size: 14px; font-weight: 650; line-height: 20px; }
.ws-route__s { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-route__b { grid-column: 2; display: grid; gap: var(--space-3); margin-top: var(--space-2); }
.ws-route__b .btn { justify-self: start; }
.ws-route--plain { box-shadow: none; background: var(--surface-2); }
.ws-kind { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.ws-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
.ws-grid > .card { min-width: 0; }
.ws-mini .card__head { flex-wrap: wrap; row-gap: 6px; margin-bottom: 4px; }
.ws-mini__run { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-bottom: var(--space-4); font-size: 13px; color: var(--ink-muted); }
.ws-mini__run .code { font-weight: 700; color: var(--ink); }
.ws-acts--gap { margin-top: var(--space-3); }
.ws-lead { margin-bottom: var(--space-4); }
.ws-reason { font-size: 13px; line-height: 20px; }
@media (max-width: 1100px) { .ws-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) { .sandbox-opener, .sandbox-browser { display: none !important; } .ws-who__a { grid-column: 1 / -1; } }
"""


def copy_details(job="gh-9575", host="mini1"):
    return f'<details><summary>Copy the command</summary>{command(job, host)}</details>'


def kept_line(where, until, extra=""):
    return (f'<div class="ws-state"><span class="tile tone-ok">{ic("box")}</span><div>'
            f'<p class="ws-state__t">Kept on {where}</p><p class="ws-state__s">{until}{extra}</p></div></div>')


SAME = " The same image and files as the run, a job’s isolation and network, no credentials."


def presence(who="ops", how="in a terminal", since="15:20 UTC"):
    return (f'<div class="ws-who" role="status"><span class="dot tone-running"></span><div>'
            f'<p class="ws-who__t"><b>{who}</b> has a shell open {how}</p>'
            f'<p class="ws-who__s">Since {since}. Opening it again, in a browser or a terminal, joins that same shell: you would both type into one prompt.</p></div>'
            f'<div class="ws-who__a"><span class="sandbox-browser">{btn("Open in browser", "", "globe")}</span>'
            f'<span class="sandbox-opener">{btn("Open in Terminal", "", "terminal")}</span>'
            f'{btn("Preview End", "danger", "cancel")}</div></div>')


def routes_closed(job, host, browser_note=True):
    """How a kept workspace with no shell open is opened from the run page."""
    acts = (f'<div class="ws-acts"><span class="sandbox-opener">{btn("Open in Terminal", "primary", "terminal", sm=False)}</span>'
            f'{copy_details(job, host)}</div>')
    note = (f'<p class="ws-note sandbox-browser">{ic("globe", "ic ic--sm")}<span><b>In a browser:</b> once a shell is open, Open in browser '
            f'appears here. The browser attaches to a shell; it never starts one.</span></p>') if browser_note else ""
    return acts + note


# ---------------------------------------------------------------- RunWorkspace (gh-9575, completed, a shell open)
def workspace_open():
    body = f"""<div class="ws">
  {kept_line('mini1 ' + venue('local'), 'Until 15:12 UTC tomorrow, 23h left.', SAME)}
  {presence()}
  <div class="ws-acts">{copy_details()}</div>
  <p class="ws-note">{ic("info", "ic ic--sm")}<span>One browser attaches at a time; a terminal can always join. End stops the shell and keeps the workspace.</span></p>
</div>"""
    return card("Workspace", body, sub="try it before you merge", end=badge("running", "1 open"), id_="p-workspace")


INSTRUCTION = "Run the test suite with npm test -- --runInBand before opening a pull request: the checkout tests share a port."


def found():
    tell_next = f"""<li class="ws-route"><span class="tile tone-ok">{ic("edit")}</span>
  <p class="ws-route__t">Tell the next runs</p>
  <p class="ws-route__s">Add a sentence to trigger 3’s instructions. Every run trigger 3 starts reads it.</p>
  <div class="ws-route__b"><div class="field"><label for="ws-instr">Sentence to add</label><textarea id="ws-instr" class="textarea" rows="2">{E(INSTRUCTION)}</textarea></div>
  {btn("Preview the edit", "", "edit", sm=False)}</div></li>"""
    tell_run = f"""<li class="ws-route"><span class="tile tone-running">{ic("git")}</span>
  <p class="ws-route__t">Tell this run’s agent</p>
  <p class="ws-route__s">Fork from its last saved point with a message. A separate branch and pull request; the original stays as it is.</p>
  <div class="ws-route__b">{btn("Preview a fork", "paid", "rerun", sm=False)}</div></li>"""
    push = f"""<li class="ws-route ws-route--plain"><span class="tile">{ic("pr")}</span>
  <p class="ws-route__t">Push it yourself</p>
  <p class="ws-route__s">From the shell, after <span class="code">gh auth login</span>. The commit is yours, and so is the merge.</p></li>"""
    body = (f'<div class="ws"><ul class="ws-routes">{tell_next}{tell_run}{push}</ul>'
            f'<p class="ws-note">{ic("info", "ic ic--sm")}<span><b>Nothing you type in the shell reaches this run or the next one.</b> '
            f'Only what you write here does.</span></p></div>')
    return card("What you found", body, sub="after a look in its workspace", id_="p-found")


def actions():
    body = f"""<div class="run-acts">
  <div class="run-act"><div class="run-act__h"><p><b>Run it again.</b> Same issue, flow and model. You see the cost before it starts.</p>{btn("Preview a re-run", "paid", "rerun", sm=False)}</div></div>
  <div class="run-act"><div class="run-act__h"><p><b>Continue in a terminal</b> as a fork of its session. The session’s transcript goes to your pi’s provider, unredacted.</p></div>{cmd("pi-dispatch chat gh-9575")}</div>
</div>"""
    return card("Actions", body, id_="p-actions")


def run_workspace_page():
    sub = f'{tag("web")} <a class="link" href="#">acme/web#490</a> <span class="muted">fix on mini1, ended 15:12 UTC</span>'
    oc = outcome("completed", "Completed", "Finished in 22m on mini1",
                 "Merges are never automatic: try it in its workspace, then review the pull request on the forge.",
                 btn("Open acme/web#490", "primary", sm=False) + btn("Try it in its workspace", "", "terminal", sm=False, href="#p-workspace"))
    main = f'<div class="stack">{workspace_open()}{found()}{ended_facts()}{actions()}</div>'
    side = f"""<div class="stack">{ended_tokens()}{ended_resources()}{ended_session()}
  <p class="collapsed" id="p-chain" data-panel>{ic('chain', 'ic ic--sm')}<b>Chain:</b> no parent and no child runs.</p></div>"""
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("gh-9575"), sub=sub, end=badge("completed"), back="Runs")


# ---------------------------------------------------------------- RunWorkspaceStates: the panel, outcome by outcome
def mini(job, kind, word, title, body, sub=""):
    """One run's Workspace panel: what to do is the title, the run it belongs to the line under it."""
    who = f'<p class="ws-mini__run">{code(job)}<span>{sub}</span></p>'
    return card(title, who + body, end=badge(kind, word), cls="ws-mini")


def states_page():
    completed = mini("gh-4add", "completed", "Completed", "Try it before you merge",
        '<div class="ws">' + kept_line('mini1 ' + venue('local'), 'Until 14:39 UTC tomorrow, 23h left.', SAME)
        + routes_closed("gh-4add", "mini1") + '</div>',
        sub="acme/web#489, flow fix")
    failed_kept = mini("gh-d40e", "failed", "Failed", "Reproduce it in its workspace",
        '<div class="ws"><p class="ws-reason">Stopped: the job’s container ran out of memory and was stopped. Partial work may exist.</p>'
        + kept_line('mini1 ' + venue('local'), 'Until 09:12 UTC tomorrow, 17h left.',
                    ' The shell gets the run’s 2,048 MiB limit, so the same command stops the same way.')
        + routes_closed("gh-d40e", "mini1", browser_note=False) + '</div>',
        sub="acme/web#484, flow fix")
    failed_none = mini("gh-f0c2", "failed", "Failed", "Nothing to open",
        f'<p class="ws-none">{ic("info", "ic ic--sm")}<span>The container runtime never handed control to the job, so nothing ran and no workspace was kept. The outcome above offers a re-run.</span></p>',
        sub="acme/web#491, flow fix")
    parked = mini("gh-2f6a", "awaiting", "Awaiting input", "Look before you answer",
        '<div class="ws">' + kept_line('mini1 ' + venue('local'), 'Until 15:13 UTC tomorrow, 23h left.', SAME)
        + routes_closed("gh-2f6a", "mini1", browser_note=False)
        + f'<p class="ws-note">{ic("parked", "ic ic--sm")}<span><b>Your answer starts a new job from the saved transcript.</b> Nothing you change here reaches it unless you push it, so say what you found in your answer.</span></p>'
        + f'<p><a class="link" href="#">Back to the answer</a></p></div>',
        sub="acme/api#131, flow triage")
    refused = mini("gh-e9a0", "refused", "Refused", "Nothing to open",
        f'<p class="ws-none">{ic("info", "ic ic--sm")}<span>It was refused before it started, so nothing ran and there is no workspace.</span></p>',
        sub="acme/billing#260, flow fix")
    running = mini("gh-b3d7", "running", "Running", "Steer it instead",
        f'<p class="ws-none">{ic("steer", "ic ic--sm")}<span>Its workspace opens once it ends. To change what it does now, steer it: a shell in a running job would act outside its cap and its record.</span></p>'
        + f'<div class="ws-acts ws-acts--gap">{btn("Steer this run", "", "steer")}</div>',
        sub="acme/web#415, flow fix")
    prepare = mini("gh-a91e", "completed", "Completed", "Prepare from this run",
        f'<div class="ws"><p class="ws-none">{ic("info", "ic ic--sm")}<span>Its venue, {venue("openshell")} on mini2, has no sandbox shell, so it cannot reopen. The same holds once a workspace is swept or past its window.</span></p>'
        + facts([("Repository", "acme/web"), ("Start from", "its pull request, " + code("pr:526")),
                 ("As the jobs of", "trigger 3, comment, flow fix"), ("Host", "mini1, " + venue("local"))], 1)
        + f'<p class="ws-note">{ic("info", "ic ic--sm")}<span>A fresh clone of what the run pushed, not its own files. No container starts, no money is spent and no run slot is taken.</span></p>'
        + f'<div class="ws-acts">{btn("Preview preparation", "primary", "plus", sm=False)}</div>'
        + cmd("pi-dispatch sandbox --new acme/web --ref pr:526 --as 3") + '</div>',
        sub="acme/web#422, flow fix")
    grid = (f'<div class="ws-grid" id="p-workspace" data-panel><div class="stack">{completed}{parked}{failed_none}{running}</div>'
            f'<div class="stack">{failed_kept}{prepare}{refused}</div></div>')
    lead = f'<p class="ws-note ws-lead">{ic("info", "ic ic--sm")}<span>The Workspace panel as each run page draws it. Operator only: a viewer’s run page has no Workspace panel.</span></p>'
    return shell("Runs", lead + grid, "The workspace, run by run",
                 sub="Where a run’s kept workspace opens, and what the page says when there is nothing to open.", back="Runs")


# ---------------------------------------------------------------- SandboxTerminalRun: the gateway tab, with its run
RUN_CSS = """
.gwr-run { display: grid; gap: var(--space-3); }
.gwr-run__h { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.gwr-run__h .code { font-size: 15px; font-weight: 700; }
.gwr-run__s { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.gwr-next { display: grid; gap: var(--space-3); }
.gwr-next p { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.gwr-next p b { color: var(--ink); font-weight: 650; }
.gwr-next__a { display: flex; flex-wrap: wrap; gap: 8px; }
.gw-head .btn .ic { margin-right: 2px; }
"""

TERM_OUT = ('<pre class="gw-reference-output"><span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> git log --oneline -1\n'
            '3f2a9c1 Fix acme/web#490\n'
            '<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> npm test -- --runInBand\n'
            'tests 48, passed 48, failed 0\n'
            '<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> <span class="gw-reference-cursor"></span></pre>')


def terminal_run_page():
    head = ('<header class="gw-head"><span class="brandpill"><span class="brandpill__m">pi</span>pi-dispatch</span>' + chip('Sandbox gateway')
            + '<div class="gw-head__end">' + btn('Theme: follows the system', 'ghost') + btn('Back to gh-9575', 'ghost', 'chev-l') + '</div></header>')
    title = '<div class="gw-title"><h1>gh-9575 on mini1</h1><p>The workspace of a completed run, in its own tab. Nothing you type here reaches the run.</p></div>'
    run = card("The run", f"""<div class="gwr-run">
  <p class="gwr-run__h">{code("gh-9575")}{badge("completed")}{tag("web")}<a class="link" href="#">acme/web#490</a></p>
  {facts([("Flow", "fix, from trigger 3"), ("Ended", "15:12 UTC, after 22m"), ("Host", "mini1, " + venue("local")),
          ("Kept", "until 15:12 UTC tomorrow"), ("Pull request", "opened for acme/web#490; merging is yours")], 3)}
</div>""", sub="from its record, shown after you were let in", id_="p-gateway-run")
    term = (f'<section class="card gw-terminal-card gw-reference-desktop" id="p-gateway-terminal" data-panel><div class="gw-terminal-head"><div><h2>gh-9575</h2>'
            f'<p class="gw-identity">mini1 · ops · existing sandbox shell</p></div>{badge("running", "Connected")}</div>'
            f'<div class="gw-terminal-toolbar"><label class="gw-focus-control"><input type="checkbox" checked> Tab moves focus</label>'
            f'<span class="gw-idle">Idle logout after 30 minutes without input here</span>{btn("Disconnect", "danger")}</div>'
            f'<div class="gw-terminal">{TERM_OUT}</div>'
            f'<div class="gw-terminal-foot"><span>Only new output is shown. What you type is not recorded. Disconnect leaves the shell running.</span>{btn("Leave terminal focus", "ghost")}</div></section>')
    phone = '<section class="card gw-reference-phone"><div class="card__head"><h2>Use your own terminal</h2></div><p class="gw-foot">Browser terminals require a window wider than 760 pixels. Go back to gh-9575 and copy the command.</p></section>'
    nxt = card("When you are done", f"""<div class="gwr-next">
  <p><b>Found something?</b> Go back to the run and write it where the next run sees it: a sentence in trigger 3’s instructions, or a fork of this run with a message.</p>
  <div class="gwr-next__a">{btn("Back to gh-9575", "primary", "chev-l", sm=False)}</div>
  <p>Disconnect leaves the shell open for End, or for your own terminal.</p>
</div>""", id_="p-gateway-next")
    return ('<a class="skip" href="#main">Skip to content</a><main id="main" class="gw-page">' + head + title + run + term + phone + nxt
            + '<p class="gw-foot">The gateway attaches to this existing shell. It starts no container.</p></main>')


# ---------------------------------------------------------------- READMEs
README = {
"RunWorkspace": """
A completed run's page with a shell open on its kept workspace. The run page says who is in the workspace, how to open it, and where a finding goes, so what one person learns in the shell reaches the next run.

**How a person uses it.**
- **The outcome** says merges are never automatic, and offers *Try it in its workspace* beside the pull request. Trying a change before merging it is the main reason to open a run's workspace.
- **Workspace** (`p-workspace`):
  - where it is kept and for how long, and what opens: the run's image and files, a job's isolation and network, no credentials;
  - **who is in it now**: ops opened a shell in a terminal at 15:20 UTC. Opening it again, in a browser or a terminal, joins that same shell, so two people would type into one prompt;
  - Open in browser (#754's, offered because a shell is open), Open in Terminal, Copy the command, and Preview End. With no shell open, the panel offers Open in Terminal first (RunWorkspaceStates draws that).
- **What you found** (`p-found`), shown once a shell has been opened on this run. Three ways to keep a finding:
  - *Tell the next runs*: add a sentence to trigger 3's instructions, through the usual preview and Confirm;
  - *Tell this run's agent*: fork from its last saved point with a message (paid, #648);
  - *Push it yourself*: from the shell after `gh auth login`.
  - Then one line: nothing typed in the shell reaches this run or the next one, only what is written here.
- The run's facts, Actions (re-run, terminal chat) and the side column (tokens and dollars, resources, session, chain) are RunEnded's.

**Panels.** `p-outcome`, `p-workspace`, `p-found`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.**
- **Today:** whether the workspace was kept, until when, and why not where it was not (the run page's sandbox check); the shells open now, with who opened each and when (the sandbox registry, #771); whether a browser holds the one attachment (the gateway's exclusive window, #754); the gateway's enrollment per host.
- **New:** whether a shell was ever opened on this run, so *What you found* shows only then. The instructions edit is the existing trigger edit with its preview and Confirm; the fork is #648's.

**Who sees what.** Operator only, like the Sandboxes tab: a viewer's run page has no Workspace or What you found panel.

**Why it works this way.**
- **The terminal is for checking a result and finding a cause,** not for finishing the agent's work by hand. A finding that stays in one person's shell helps once; a sentence in the trigger's instructions helps every later run, which is how runs come to need nobody (Zero touch).
- **Who is in it, on the run page.** A native terminal and the browser can attach to the same shell at once, so a second person would type into the first one's prompt. The page says so before anyone opens it.
- **No new authority.** Every control here exists today: Open in Terminal, copy, End, the trigger edit and the fork. The browser still only attaches to a shell that is open.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, local, ended 15:12 UTC, trigger 3 and the tokens are the fixture, as on RunEnded. Sample: the shell ops opened at 15:20 UTC (as on SandboxesScreen) and the sentence in the instructions box.
""",
"RunWorkspaceStates": """
The run page's Workspace panel for each kind of run: where a kept workspace opens, what the page says when there is nothing to open, and *Prepare from this run* when the workspace cannot reopen.

**How a person uses it.**
- **Completed** (gh-4add): *Try it before you merge*. Open in Terminal first, with the command to copy. Open in browser appears only once a shell is open, because the browser attaches and never starts one.
- **Failed, workspace kept** (gh-d40e, out of memory): *Reproduce it in its workspace*. The reason leads, and the panel says the shell gets the run's memory limit, so the same command stops the same way.
- **Awaiting input** (gh-2f6a): *Look before you answer*. The answer starts a new job from the saved transcript, so the panel says that nothing changed in the shell reaches it, and to put the finding in the answer. A link goes back to the answer box.
- **Cannot reopen** (gh-a91e, on openshell): *Prepare from this run*. #771's preparation filled in from the run: the repository, its pull request as the starting point, the trigger it ran as, and a host where that trigger's runs go. It says it is a fresh clone of what the run pushed, not the run's own files. The same panel shows once a workspace is swept or past its window.
- **Failed before it started** (gh-f0c2) and **refused** (gh-e9a0): *Nothing to open*, with the reason in one line.
- **Running** (gh-b3d7): *Steer it instead*. Its workspace opens once it ends.

**Panels.** `p-workspace`, once per run page.

**The server provides.** The run page's sandbox check (kept, until when, or why not), the run's venue and whether it can reopen, the open shells, and for *Prepare from this run* the run's repository, its trigger and the pull request it opened where the record holds one. Without a pull request the preparation starts from the default branch.

**Who sees what.** Operator only. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **One panel, one place.** The workspace sits on the run page because that is where a person decides what to do next, as CI tools put their debug shell on the job page.
- **Parked runs say what the shell cannot do.** The answer resumes from the transcript in a new job, so an edit in the shell would be lost without a word.
- **No terminal in a running job.** Its container holds the job's own token and spends from its reservation. Steering is the way to change a running run.
- **Prepare from this run** keeps a pull request reviewable after its workspace is gone. Workspaces are kept 24 hours by default; a review often takes longer.

**Fixture note.** From the fixture: gh-4add, gh-2f6a, gh-a91e, gh-f0c2, gh-e9a0 and gh-b3d7 with their targets, flows, hosts and venues, and the catalog sentences for the out-of-memory stop and a container that never started. Sample: gh-d40e (an out-of-memory stop on acme/web#484 at 09:12 UTC, added to `fixture.py` as a proposed run), the 2,048 MiB limit, the times left, and gh-a91e's pull request `pr:526`.
""",
"SandboxTerminalRun": """
The gateway's terminal tab when it knows its run: the run's facts above the shell, and the way back to the run instead of a generic return page.

**How a person uses it.**
- **The run** (`p-gateway-run`) says what the shell belongs to: gh-9575, Completed, acme/web#490 in `web`, flow fix from trigger 3, ended 15:12 UTC after 22m, mini1 local, kept until 15:12 UTC tomorrow, and that the pull request was opened and merging is the person's.
- **The terminal** is SandboxTerminal's: one attachment, idle logout, Disconnect, nothing recorded, only new output.
- **When you are done** (`p-gateway-next`): one line on where a finding goes, and **Back to gh-9575**, which opens the run page with its *What you found* panel. The header's return link goes to the run too.
- On a phone, no terminal opens, as on SandboxTerminal; the tab sends the person back to gh-9575 to copy the command.

**Panels.** `p-gateway-run`, `p-gateway-terminal`, `p-gateway-next`.

**The server provides.** The console adds the run's id, outcome, target, project, flow, trigger, host, venue, end time and keep-until to the one-use server-side grant, and the gateway shows them only after authorization. They are run record facts: no transcript text, question or issue text crosses.

**Who sees what.** The operator who opened it, as on SandboxTerminal.

**Why it works this way.**
- **Know what you type into.** A shell prompt says only `gh-9575`. The run's target and outcome say whether this is the change about to be merged or a run that failed.
- **Back to the run, not to the console.** The next useful thing after a look is on the run page: the finding, a fork or End.
- **Record facts only.** The gateway stays a separate origin with a narrow job. It gets no new read of its own: the facts ride in the grant the console already makes.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: the terminal output and the commit line.
""",
}


if __name__ == "__main__":
    write("RunWorkspace", card_marker("Runs", 1900, 1440, "A completed run with a shell open on its workspace: who is in it, how to open it, and where what you found goes"),
          "Run gh-9575, its workspace", run_workspace_page(), RUN_STYLE + CSS)
    write("RunWorkspaceStates", card_marker("Runs", 1700, 1440, "The run page’s Workspace panel by outcome: try it, reproduce it, look before you answer, prepare from the run, or nothing to open"),
          "The workspace, run by run", states_page(), RUN_STYLE + CSS)
    write("SandboxTerminalRun", card_marker("Runs", 1200, 1440, "The gateway’s terminal tab with its run: the run’s facts above the shell and the way back to the run"),
          "Sandbox terminal for gh-9575", terminal_run_page(), GW_CSS + RUN_CSS)
    for name, text in README.items():
        readme(name, text)
    print("workspace cards written")
