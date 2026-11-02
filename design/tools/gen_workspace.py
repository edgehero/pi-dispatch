"""A run's kept workspace on its own run page, and the run in the terminal's own tab (#793, after #754).

One rule keeps it simple: a run page says one line about its workspace and offers one thing to do. Why it works that
way is in each card's README, not on the screen.

Three cards:
- RunWorkspace: a completed run with a shell open. One Workspace row (where it is kept, who has a shell open, the open
  buttons) and one line for a finding.
- RunWorkspaceStates: that row for every outcome, as one table: the outcome, the line, the one button.
- SandboxTerminalRun: the gateway's terminal tab, with its run in one line under the title and the way back to it.

Nothing here starts a container from the browser: the gateway stays attach-only (#754). Starting a shell from the run
page is a separate decision, and these cards do not assume it."""
from pulse import *
from gen_runs import RUN_STYLE, run_title, ended_facts, ended_tokens, ended_resources, ended_session
from gen_sandboxes import command
from gen_gateway import CSS as GW_CSS
from gen_gateway_workbench import CSS as WORKBENCH_CSS, run_reference


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


CSS = """
/* Ids and commands wrap inside a card on a phone rather than widening it. */
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.ws-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px var(--space-4); }
.ws-row__t { display: flex; align-items: center; gap: 10px; flex: 1 1 320px; min-width: 0; font-size: 14px; line-height: 20px; }
.ws-row__t .dot { flex: none; }
.ws-row__t span { color: var(--ink-muted); }
.ws-row__t b { color: var(--ink); font-weight: 650; }
.ws-row__a { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ws-more { margin-top: var(--space-3); }
.ws-more summary { cursor: pointer; font-size: 13px; color: var(--ink-muted); }
.ws-more__b { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.ws-more__b .btn { justify-self: start; }
.ws-found { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-found b { color: var(--ink); font-weight: 650; }
.ws-tbl td { vertical-align: middle; }
.ws-tbl .ws-line { min-width: 260px; font-size: 13px; line-height: 20px; }
.ws-tbl .ws-line b { font-weight: 650; }
.ws-tbl .ws-act { text-align: right; white-space: nowrap; }
.ws-tbl .muted { font-size: 13px; }
.ws-lead { display: flex; gap: 8px; align-items: flex-start; margin-bottom: var(--space-4); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ws-lead .ic { flex: none; margin-top: 2px; }
@media (max-width: 760px) {
  .sandbox-opener, .sandbox-browser { display: none !important; }
  .ws-tbl .ws-line { min-width: 0; }
  .ws-tbl .ws-act { text-align: left; }
  .ws-tbl .ws-act:has(> .sandbox-opener:only-child), .ws-tbl .ws-act:has(> .muted:only-child) { display: none; }
}
"""


# ---------------------------------------------------------------- RunWorkspace (gh-9575, completed, a shell open)
def workspace_panel():
    row = (f'<div class="ws-row"><p class="ws-row__t"><span class="dot tone-running"></span><span><b>ops</b> opened the shell, since 15:20 UTC. '
           f'Opening it joins that shell.</span></p>'
           f'<div class="ws-row__a"><span class="sandbox-browser">{btn("Open in browser", "", "globe")}</span>'
           f'<span class="sandbox-opener">{btn("Open in Terminal", "", "terminal")}</span></div></div>')
    more = (f'<details class="ws-more"><summary>Copy the command, or end the shell</summary><div class="ws-more__b">'
            f'{command()}{btn("Preview End", "danger", "cancel")}</div></details>')
    found = (f'<p class="ws-found"><b>Found something?</b><a class="link" href="#">Add it to a trigger’s instructions</a>'
             f'<a class="link" href="#">Fork it with a message</a></p>')
    return card("Workspace", row + more + found, sub="kept on mini1 until 15:12 UTC tomorrow", id_="p-workspace")


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
    main = f'<div class="stack">{workspace_panel()}{ended_facts()}{actions()}</div>'
    side = f"""<div class="stack">{ended_tokens()}{ended_resources()}{ended_session()}
  <p class="collapsed" id="p-chain" data-panel>{ic('chain', 'ic ic--sm')}<b>Chain:</b> no parent and no child runs.</p></div>"""
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("gh-9575"), sub=sub, end=badge("completed"), back="Runs")


# ---------------------------------------------------------------- RunWorkspaceStates: the row, outcome by outcome
OPEN = f'<span class="sandbox-opener">{btn("Open in Terminal", "", "terminal")}</span>'
ROWS = [  # (job, outcome kind, line, the one action)
    ("gh-4add", "completed", "<b>Try it before you merge.</b> Kept until 14:39 UTC tomorrow.", OPEN),
    ("gh-9575", "completed", "<b>lee is driving, and lets operators watch.</b> ops opened the native shell. You see new output and cannot type.", f'<span class="sandbox-browser">{btn("Watch", "", "eye")}</span>'),
    ("gh-d40e", "failed", "<b>Reproduce it.</b> It ran out of memory; the shell has the same limit.", OPEN),
    ("gh-2f6a", "awaiting", "<b>Look before you answer.</b> Your answer starts a new job, so put what you find in it.", OPEN),
    ("gh-a91e", "completed", "<b>Cannot reopen</b> on openshell. Prepare a fresh copy of its pull request.", btn("Prepare from this run", "", "plus")),
    ("gh-b3d7", "running", "<b>Opens when it ends.</b> To change it now, steer it.", btn("Steer this run", "", "steer")),
    ("gh-f0c2", "failed", "<b>Nothing to open:</b> its container never started.", '<span class="muted">none</span>'),
    ("gh-e9a0", "refused", "<b>Nothing to open:</b> it was refused before it started.", '<span class="muted">none</span>'),
]


def states_page():
    # On a phone the table stacks: the run and its outcome share a row, then the line and the button take a row each.
    rows = "".join(f'<tr><td><span class="code">{j}</span></td><td>{badge(k)}</td>'
                   f'<td class="ws-line wide">{line}</td><td class="ws-act wide">{act}</td></tr>' for j, k, line, act in ROWS)
    table = (f'<section class="card card--flush" id="p-workspace" data-panel aria-labelledby="ws-h"><div class="card__head"><h2 id="ws-h">Workspace, by outcome</h2>'
             f'<span class="card__sub">one line and one button on each run page</span></div>'
             f'<div class="tbl-wrap"><table class="tbl tbl--stack ws-tbl"><thead><tr><th>Run</th><th>Outcome</th><th>What the run page says</th><th class="ws-act">The one button</th></tr></thead>'
             f'<tbody>{rows}</tbody></table></div></section>')
    lead = f'<p class="ws-lead">{ic("info", "ic ic--sm")}<span>Operator only: a viewer’s run page has no Workspace panel.</span></p>'
    return shell("Runs", lead + table, "The workspace, run by run",
                 sub="What each run page says about its kept workspace, and the one thing to do.", back="Runs")


# ---------------------------------------------------------------- SandboxTerminalRun: the gateway tab, with its run
RUN_CSS = """
.gwr-watchers { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px var(--space-5); border-top: 1px solid var(--line); background: var(--running-tint); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.gwr-watchers b { color: var(--ink); font-weight: 650; }
.gwr-watchers .ic { flex: none; color: var(--running-ink); }
.gwr-ro { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 13px; color: var(--ink-muted); }
.gwr-ro b { color: var(--ink); font-weight: 650; }
.gwr-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: var(--space-2); font-size: 14px; line-height: 22px; color: var(--ink-muted); }
.gw-head .btn .ic { margin-right: 2px; }
"""

TERM_OUT = ('<pre class="gw-reference-output"><span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> git log --oneline -1\n'
            '3f2a9c1 Fix acme/web#490\n'
            '<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> npm test -- --runInBand\n'
            'tests 48, passed 48, failed 0\n'
            '<span class="gw-reference-prompt">pi@gh-9575:/workspace$</span> <span class="gw-reference-cursor"></span></pre>')


def terminal_run_page():
    return run_reference()


def watch_page():
    return run_reference(watch=True)


# ---------------------------------------------------------------- READMEs
README = {
"RunWorkspace": """
A completed run's page with a shell open on its kept workspace. One rule keeps it simple: the run page says one line about its workspace and offers one thing to do.

**How a person uses it.**
- **The outcome** offers *Try it in its workspace* beside the pull request, since trying a change before merging it is the main reason to open a run's workspace.
- **Workspace** (`p-workspace`) is one row: where it is kept and until when, who has a shell open (opening it joins that shell), and Open in browser or Open in Terminal. Copying the command and End fold under one line.
- **Found something?** One line with two links: choose its trigger and add it to the instructions (the usual trigger edit, with its preview and Confirm; a historical index never silently selects a current rule), or fork it with a message (#648).
- The run's facts, Actions and the side column are RunEnded's.

With no shell open, the row offers Open in Terminal; RunWorkspaceStates draws each outcome's row. On a phone the open buttons hide and the command is there to copy.

**Panels.** `p-outcome`, `p-workspace`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.** All of it today: whether the workspace was kept and until when (the run page's sandbox check), the shells open now with who opened each and when (#771's registry), and the gateway's enrollment (#754).

**Who sees what.** Operator only, like the Sandboxes tab. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **One line, one button.** The run page is for deciding what to do next; the details of what a sandbox is live in Sandboxes and in this README.
- **Who has a shell open.** A terminal and the browser can attach to the same shell at once, so a second person would type into the first one's prompt. The row says so before anyone opens it.
- **Found something?** Nothing typed in the shell reaches this run or the next one. A sentence in the trigger's instructions does, which is how runs come to need nobody (Zero touch).
- **No new authority.** Every control exists today. The browser only attaches to a shell that is open; starting one from here is a separate decision.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, local, ended 15:12 UTC and trigger 3 are the fixture, as on RunEnded. Sample: the shell ops opened at 15:20 UTC, as on SandboxesScreen.
""",
"RunWorkspaceStates": """
The run page's Workspace row for each kind of run, as one table: the outcome, the one line the page says, and the one button.

**How a person uses it.**
- **Completed** (gh-4add): *Try it before you merge*, with Open in Terminal.
- **Shared** (gh-9575, as another operator sees it): *lee is driving, and lets operators watch*, with **Watch** (observer mode, #792). Watching is read only; SandboxWatch draws the watcher's tab.
- **Failed, kept** (gh-d40e, out of memory): *Reproduce it*. The shell uses the run's recorded memory limit; reproduction is not guaranteed.
- **Awaiting input** (gh-2f6a): *Look before you answer*. The answer starts a new job from the saved transcript, so a change in the shell does not reach it; the finding goes in the answer.
- **Cannot reopen** (gh-a91e, on openshell): *Prepare from this run*, which opens #771's preparation filled in from the run: its verified repository, HEAD and an explicitly chosen compatible trigger and host. The same row shows once the host confirms a workspace is swept or past its window. Unreadable remote retention remains unknown, never inferred as swept.
- **Running** (gh-b3d7): *Opens when it ends*, with Steer this run.
- **Nothing to open** for a run whose container never started (gh-f0c2) or that was refused (gh-e9a0): no button.

Open in browser joins these buttons only once a shell is open, as on RunWorkspace.

**Panels.** `p-workspace`, once per run page.

**The server provides.** The run page's sandbox check (kept, until when, or why not) and the run's venue. *Prepare from this run* also needs the verified repository. It starts from HEAD and requires an explicit compatible trigger and host; a historical trigger index or issue target is not pull-request attribution.

**Who sees what.** Operator only. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **The run page is where the next step is decided,** as CI tools put their debug shell on the job page.
- **A parked run says what the shell cannot do,** or an edit made there would be lost without a word.
- **No terminal in a running job.** Its container holds the job's own token and spends from its reservation; steering is the way to change a running run.
- **Prepare from this run** keeps a pull request checkable after its workspace is gone: workspaces are kept 24 hours by default, and a review often takes longer.

**Fixture note.** From the fixture: gh-4add, gh-9575, gh-2f6a, gh-a91e, gh-b3d7, gh-f0c2 and gh-e9a0 with their outcomes and venues. Sample: gh-d40e, an out-of-memory stop on acme/web#484 at 09:12 UTC, added to `fixture.py`.
""",
"SandboxTerminalRun": """
The gateway's terminal tab when it knows its run: the run in one line under the title, and the way back to it.

**How a person uses it.**
- **The title** names the sandbox and its host; the line under it says the run's outcome, project, target, flow and when it ended.
- **The terminal** uses the shared workbench: tabs and splits preserve the same attachment, driver idle logout, Disconnect, nothing recorded and only new output.
- **Back to gh-9575** in the header replaces the generic return, and the line under the terminal says where a finding goes: the run's page, where the next run sees it.
- **Let operators watch** (observer mode, #792), off by default. On, other operators can watch from the run page or Sandboxes. A line under the toolbar names each watcher with **Remove**, and says they see what is typed. Turning it off ends every watch at once.
- On a phone, no terminal opens. The console provides the native command; a generic arrival exposes no private run context.

**Panels.** `p-gateway-run`, `p-gateway-terminal`.

**The server provides.** The console adds the run's id, outcome, project, target, flow and end time to the one-use grant it already makes, and the gateway shows them only after authorization. They are run record facts: no transcript, question or issue text crosses.

**Who sees what.** The operator who opened it, as on SandboxTerminal.

**Why it works this way.**
- **Know what you type into.** A prompt says only `gh-9575`; the run's target and outcome say whether this is the change about to be merged or a run that failed. The way back goes to the run, because the next useful step after a look is there.
- **Watching is the driver's choice, and always on their screen.** A watcher sees everything the shell prints, including what is typed, such as a pasted token. So it is off until the person typing turns it on, and they see who watches.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: the terminal output and the commit line, and lee watching.
""",
"SandboxWatch": """
Observer mode (#792): another operator watches a browser shell, read only, when the person typing allows it. For pairing, review and teaching.

**How a person uses it.**
- On the run page or in Sandboxes, an operator sees *lee is driving, and lets operators watch* and **Watch**. It asks for their own token again, as opening does, and opens this tab.
- **The title** says whose shell and which run: Watching gh-9575, with the run's line under it.
- **The terminal** shows the same new output as the driver's, at the driver's size (120 × 36 here), with an internal scroll viewport when it does not fit. The toolbar says *Read only: you cannot type*. There is no Tab-focus switch and no Disconnect; **Stop watching** closes the tab's watch.
- Watching ends when the driver disconnects, turns watching off or removes the watcher, when the shell ends, or when the watcher's own session ends.
- On a phone, no terminal opens.

**Panels.** `p-gateway-run`, `p-gateway-watch`.

**The server provides.**
- A `watch` grant: one use, 60 seconds, after the watcher's fresh sign-in with their own token, for that exact sandbox, only while its driver allows watching.
- The driver's terminal size as it changes, and new output. No history, input or resize from a watcher.

**Who sees what.** Operators only, at most three at a time. A viewer, an agent and a read-only console cannot watch: terminal output can hold issue text and anything typed.

**Why it works this way.**
- **Read only by construction.** The watcher's attach has no input stream, and the gateway drops any input or resize a watcher sends before it reaches the runtime. The tab's read-only look is not what stops typing.
- **The driver decides.** A watcher sees what is typed, a pasted token included, so watching is off by default, turned on by the person typing, and every watcher is listed on their screen with Remove.
- **Audited, not recorded.** Each watch's start and end are audited with who watched whom. What is shown is not kept, as for the driver.
- **One driver.** A watcher never types. Two people typing into one prompt is what a native terminal joining a shell already allows; the browser does not add a second way.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: lee as a second operator (added to `fixture.py`), the terminal output and the 120 × 36 size.
""",
}


if __name__ == "__main__":
    write("RunWorkspace", card_marker("Runs", 1700, 1440, "A completed run with a shell open: one Workspace row (where it is kept, who has a shell open, how to open it) and one line for a finding"),
          "Run gh-9575, its workspace", run_workspace_page(), RUN_STYLE + CSS)
    write("RunWorkspaceStates", card_marker("Runs", 900, 1440, "The run page’s Workspace row by outcome, as one table: the line it says and the one button"),
          "The workspace, run by run", states_page(), RUN_STYLE + CSS)
    write("SandboxTerminalRun", card_marker("Runs", 1100, 1440, "The gateway’s terminal tab with its run: one line under the title and the way back to the run"),
          "Sandbox terminal for gh-9575", terminal_run_page(), GW_CSS + RUN_CSS + WORKBENCH_CSS)
    write("SandboxWatch", card_marker("Runs", 1000, 1440, "Observer mode: another operator watches a browser shell, read only, when the person typing allows it"),
          "Watching gh-9575", watch_page(), GW_CSS + RUN_CSS + WORKBENCH_CSS)
    for name, text in README.items():
        readme(name, text)
    print("workspace cards written")
