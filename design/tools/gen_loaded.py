"""What a run loaded: pi and its image, the model, extensions, skills, MCP servers and tools, as the run had them.

Today a run page shows the model and the flow's name. What else the job loaded is in no record: the configuration pages
say what should load (a trigger's fields, Connections, Updates), but what loads depends on the host's overlay and
staged packages, the repository at its base commit, the trigger and the image, and each of those changes on its own.
A flow that is found nowhere, or an extension that fails to load, still runs and can exit 0.

One rule keeps it simple, as on the Workspace row: one line per kind, and the details fold.

Three cards:
- RunLoaded: a completed run's Loaded card (pi and image, model, extensions, skills, MCP, tools).
- LoadedStates: that card's one line, run by run, and where it is repeated (a sandbox and a trigger).
- ProjectLoads: the project page's What its runs load, which says when runs of one project differ by host."""
from pulse import *
from gen_runs import RUN_STYLE, RUNS_STYLE, RUNS, run_title, ended_facts, ended_tokens, ended_resources, ended_session, row as runs_row
from gen_config2 import table, code, COMMON_CSS


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


def state_line(tone, icon, text):
    return f'<span class="ld-st tone-{tone}">{ic(icon, "ic ic--sm")}<span>{text}</span></span>'


# The console never reads this folder at runtime, so the rules it will paste must stand apart from the rules only the
# card's sample pages need. LOADED_CSS is what the console ships for these panels, and it names no c2- class: those
# rules live in gen_config2's COMMON_CSS and the console ships none of them, so a pasted panel would lose its layout on
# a page that looks fine here. LOADED_CARD_CSS is the state catalogue and the rest of the sample page.
LOADED_CSS = """
.ld-st { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--tone-ink); font-weight: 600; line-height: 18px; }
.ld-st .ic { margin-top: 2px; }
.ld-st > span { min-width: 0; overflow-wrap: anywhere; }
.ld-st .code, .ld-v .code, .ld-more .code, .ld-foot .code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.ld-top { display: block; margin-bottom: var(--space-4); font-size: 14px; }
.ld-top small { display: block; margin-top: 2px; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
/* A way to where a problem is fixed can name a host or a commit, and a button's own rule keeps it on one line whatever its width.
   Here it wraps, in a corner a second line fits. The banner's is the same button. */
.ld-top .btn, #p-outcome .btn--sm { height: auto; min-height: 30px; max-width: 100%; padding-block: 4px; border-radius: var(--radius-md); white-space: normal; overflow-wrap: anywhere; }
.ld-top .btn { margin: 2px 6px 2px 0; }
/* The record's names stand in two more places on a run's page: the banner's sentences and the headline's target and flow. */
#p-outcome .banner > div { min-width: 0; }
#p-outcome .banner__t, #p-outcome .banner__s, #p-headline { overflow-wrap: anywhere; }
/* "Completed, without its flow and with 2 failed extensions" is wider than a phone, and a badge's own rule holds it on one line. */
#p-headline .badge, #p-proj-recent .badge { height: auto; min-height: 24px; padding-block: 2px; white-space: normal; }
.ld-list { display: grid; gap: 12px; }
.ld-row { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 2px 14px; align-items: baseline; font-size: 14px; line-height: 20px; }
.ld-k { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; color: var(--ink-muted); }
.ld-k .ic { flex: none; }
.ld-v { min-width: 0; color: var(--ink); overflow-wrap: anywhere; }
.ld-v b { font-weight: 650; overflow-wrap: anywhere; }
.ld-v small { display: block; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.ld-more { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); }
.ld-more summary { cursor: pointer; font-size: 13px; color: var(--ink-muted); }
.ld-more .tbl-wrap { margin-top: var(--space-3); }
.ld-foot { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-4); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.ld-foot .ic { flex: none; margin-top: 2px; }
.ld-host td { vertical-align: top; }
.ld-top .link, .ld-fold td, .ld-host td { overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .ld-row { grid-template-columns: minmax(0, 1fr); }
  /* The bundle's stacked row is a shrinking column beside an auto one. A long name in the auto column takes the whole
     width and leaves the kind laid over it, so the kind gets its own line and the name the shrinking column. These
     select on .tbl--stack and name no card rule, because the console pastes this block beside the bundle alone. */
  .tbl--stack.ld-fold td:first-child { grid-column: 1 / -1; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
  .tbl--stack.ld-fold .ld-fold__n { grid-column: 1; min-width: 0; overflow-wrap: anywhere; }
  .tbl--stack.ld-fold td:empty { display: none; }
}
"""

LOADED_CARD_CSS = """
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.ld-tbl td { vertical-align: middle; }
.ld-tbl td:first-child .code { white-space: nowrap; }
.ld-tbl .ld-line { min-width: 280px; font-size: 13px; line-height: 20px; }
.ld-tbl .ld-line .ld-st { font-weight: 550; }
.ld-tbl .ld-line small { display: block; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.ld-tbl .ld-act { text-align: right; white-space: nowrap; }
.ld-tbl .muted { font-size: 13px; }
.ld-lead { display: flex; gap: 8px; align-items: flex-start; margin-bottom: var(--space-4); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ld-lead .ic { flex: none; margin-top: 2px; }
.ld-h3 { margin: var(--space-6) 0 var(--space-3); font-size: 15px; font-weight: 700; }
.ld-new { box-shadow: inset 3px 0 0 var(--running); padding-left: 10px; }
.ld-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.ld-pair + .ld-pair { margin-top: var(--space-5); }
.ld-foot--flush { margin: 0; padding: var(--space-3) var(--space-5) var(--space-4); }
.ld-banners { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .ld-pair { grid-template-columns: minmax(0, 1fr); }
  .ld-tbl .ld-line { min-width: 0; }
  .ld-tbl .ld-act { text-align: left; }
  .ld-tbl .ld-act:has(> .muted:only-child) { display: none; }
}
"""

CSS = COMMON_CSS + LOADED_CSS + LOADED_CARD_CSS


def row(icon, label, value, more=""):
    small = f"<small>{more}</small>" if more else ""
    return f'<li class="ld-row"><span class="ld-k">{ic(icon, "ic ic--sm")}{label}</span><span class="ld-v">{value}{small}</span></li>'


def fold_table(rows):
    """The fold's table, written here because gen_config2's table() labels every cell on a phone. A label on an empty
    Version cell, or "Name" beside a count, reads as a field with no value, so only a version says what it is."""
    trs = "".join(
        f'<tr><td>{k}</td><td class="ld-fold__n">{n}</td><td{" data-l=" + chr(34) + "Version" + chr(34) if v else ""}>{v}</td><td class="wide">{f}</td></tr>'
        for k, n, v, f in rows)
    return (f'<div class="tbl-wrap"><table class="tbl tbl--stack ld-fold"><caption class="sr">What gh-9575 loaded</caption>'
            f'<thead><tr><th scope="col">Kind</th><th scope="col">Name or count</th><th scope="col">Version</th><th scope="col">From</th></tr></thead>'
            f'<tbody>{trs}</tbody></table></div>')


MERGES = "Merges are never automatic: a person merges the pull request on the forge."


def run_actions(first=""):
    """What the outcome offers on a completed run, as the console draws it, after any way to where a problem is fixed."""
    return (first + btn("Open target on the forge", "primary", sm=False) + btn("Try it in its workspace", "", "terminal", sm=False)
            + btn("Preview a re-run", "", "rerun", sm=False))


# ---------------------------------------------------------------- RunLoaded (gh-9575, everything loaded)
def loaded_panel():
    top = f'<p class="ld-top">{state_line("ok", "done", "Everything trigger 3 asks for loaded.")}</p>'
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', f'image {code("sha256:7c1e0b4…")}, as mini1 ran it'),
        row("bolt", "Model", "anthropic / claude-sonnet-5-5", "14 calls"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0", "staged on mini1"),
        row("skill", "Skills", "<b>fix</b>, the flow, from the repository", "and 3 more: 2 from the repository, 1 from pi-test-runner"),
        row("plug", "MCP", "none", "trigger 3 names no server"),
        row("flows", "Tools", "10 active", "read, bash, edit and write, 5 from the extensions, and report_progress, the job’s own; none removed"),
    ])
    rows = [
        ("Image", code("sha256:7c1e0b4…"), "", "The image id on this host; two local builds of one tag differ, so it never counts as a host difference."),
        ("Extension", code("pi-lint"), "1.4.2", "staged on mini1"),
        ("Extension", code("pi-test-runner"), "0.9.0", "staged on mini1"),
        ("Extension failed", "0", "", "to load, in any tier; a path and its kind stay in the job’s log"),
        ("Extension dropped", "0", "", "by the recursion guard, per tier; names stay in the job’s log"),
        ("Repository extensions", "0", "", "the repository’s .pi/extensions at its base commit"),
        ("Overlay", "none", "", "no extension from mini1’s overlay"),
        ("Skill", f'{code("fix")} <span class="muted">(the flow)</span>', "", "the repository’s .pi/skills at its base commit"),
        ("Skill", "1", "", "pi-test-runner"),
        ("Skill", "2 more", "", 'the repository at its base commit. <a class="link" href="#">Read them there</a>; a record keeps no names from a repository.'),
        ("Skill replaced", "1", "", "one of pi-test-runner’s, by a skill of that name from the repository, the skills folder or the overlay; the name stays in the job’s log"),
        ("Prompt template", "1", "", "pi-lint"),
        ("Theme", "0", "", "in any tier"),
        ("Tools", "read, bash, edit, write", "", "pi"),
        ("Tools", "lint_file, lint_fix", "", "pi-lint"),
        ("Tools", "run_tests, test_coverage, test_report", "", "pi-test-runner"),
        ("Tools", code("report_progress"), "", "the job’s own, because trigger 3 sets run.progress"),
    ]
    more = f'<details class="ld-more"><summary>Each item, and where it came from</summary>{fold_table(rows)}</details>'
    foot = (f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>What pi loaded when this run started, from its record: names and versions from what the '
            f'deployment staged and configured, and counts for what the repository holds.</span></p>')
    return card("Loaded", top + f'<ul class="ld-list">{lines}</ul>' + more + foot, sub="what this run had", id_="p-loaded")


def run_loaded_page():
    sub = f'{tag("web")} <a class="link" href="#">acme/web#490</a> <span class="muted">fix on mini1, ended 15:12 UTC</span>'
    oc = outcome("completed", "Completed", "Finished in 22m on mini1",
                 f"The run finished, and its record names no reason to say more. {MERGES}",
                 run_actions())
    main = f'<div class="stack">{ended_facts()}{loaded_panel()}</div>'
    side = f'<div class="stack">{ended_tokens()}{ended_resources()}{ended_session()}</div>'
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("gh-9575"), sub=sub, end=badge("completed"), back="Runs")


# ---------------------------------------------------------------- LoadedStates: the one line, run by run
NONE = '<span class="muted">none</span>'
ALL_LOADED = state_line("ok", "done", "Everything trigger 3 asks for loaded.")
NO_FLOW, EXT_FAILED = "Completed, without its flow", "Completed, with a failed extension"
BASE_BUTTON = "Open the base commit a41c0d2"
NO_SKILL = "pi found no skill named fix: not in acme/api at its base commit, nor in a skills folder, the overlay or a staged package."
STATES = [  # (job, its outcome, the line, where it is fixed)
    ("gh-9575", badge("completed"), ALL_LOADED, NONE),
    ("gh-8251-r2", badge("completed"), state_line("ok", "done", "Everything trigger 2 asks for loaded. <b>Left out, as it asks:</b> bash, and the staged packages."), NONE),
    ("gl-af91", badge("completed"), state_line("ok", "done", "Everything trigger 4 asks for loaded. <b>Left out for this job:</b> the overlay’s extensions."), NONE),
    ("gh-2f6a", badge("awaiting"), state_line("ok", "done", "Everything trigger 7 asks for loaded.") + "<small>MCP: linear connected, with 12 tools.</small>", NONE),
    ("gh-4add", badge("completed"), ALL_LOADED + "<small>In the fold, and nowhere else: Extension dropped, 1, acme/web, by the recursion guard; names stay in the job’s log.</small>", NONE),
    ("gh-a3ac", badge("completed"), ALL_LOADED + "<small>Cut to fit: this record keeps the counts and leaves out package, overlay and tool names.</small>", NONE),
    ("gh-03a9", badge("attention", NO_FLOW), state_line("attention", "attention", f"<b>Ran without its flow.</b> {NO_SKILL}"),
     btn("Open trigger 3", "", "config") + " " + btn(BASE_BUTTON, "", "git")),
    ("gh-444c", badge("attention", EXT_FAILED), state_line("failed", "failed", "<b>1 of acme/api’s extensions failed to load.</b> The run went on."),
     btn(BASE_BUTTON, "", "git")),
    ("gh-5e1d", badge("attention", EXT_FAILED), state_line("failed", "failed", "<b>The extension from acme/api failed to load.</b> The run went on without it."),
     btn(BASE_BUTTON, "", "git")),
    ("gh-6b0d", badge("refused"), state_line("refused", "refused", "<b>linear could not be used.</b> The run stopped before the agent started, after its extensions and skills had loaded.")
     + "<small>Not retried: the next attempt would find it the same.</small>", btn("Open Connections", "", "plug")),
    ("gh-4b12", badge("failed"), state_line("failed", "failed", "<b>linear did not answer in time.</b> The run stopped before the agent started.")
     + "<small>Retried, as any infrastructure failure; the queue has stopped retrying this job.</small>", btn("Open Connections", "", "plug")),
    ("gh-ebd7", badge("completed"), state_line("attention", "info", "<b>Also loaded git-guard</b> from build3’s overlay. mini1 does not have it; mini2 has published nothing."),
     btn("Open build3", "", "fleet") + " " + btn("Open mini1", "", "fleet")),
    ("gh-b3d7", badge("running"), '<span class="muted">Shown when it ends, from its record. Trigger 3 says what it asks for.</span>', btn("Open trigger 3", "", "config")),
    ("gh-c3f8", badge("completed"), '<span class="muted">Not recorded: an older release wrote this run’s record.</span>', NONE),
    ("gh-e9a0", badge("refused"), '<span class="muted">Nothing loaded: it was refused before its container started.</span>', NONE),
]


def list_row(job, word):
    """RunsScreen's own row for a run, with the one word that changes. Asserted, because a row that kept "Completed" here
    would draw the very thing this state exists to stop."""
    plain = '<span class="badge tone-idle">' + ic("done") + "Completed</span>"
    drawn = runs_row(next(r for r in RUNS if r[1] == job))
    assert plain in drawn, job
    return drawn.replace(plain, badge("attention", word)).replace(" runs-quiet", "")


def outcome_state(id_, *args):
    """pulse.outcome() names its panel p-outcome, and this page draws it twice."""
    return outcome(*args).replace('id="p-outcome"', f'id="{id_}"').replace('"oc-t"', f'"{id_}-t"')


def in_the_list():
    head = "".join(f"<th{(' class=num' if h in ('Tokens', 'Cost', 'Job cap') else '')}>{h}</th>" for h in
                   ["Ended", "Job", "Target", "Project", "Flow", "Host", "Venue", "Outcome", "Model", "Tokens", "Cost", "Job cap"])
    table_ = (f'<section class="card card--flush" id="p-loaded-runs" data-panel aria-labelledby="ld-rh"><div class="card__head"><h2 id="ld-rh">Runs</h2>'
              f'<span class="card__sub">the two rows that change</span></div>'
              f'<div class="tbl-wrap"><table class="tbl tbl--stack runs-tbl"><caption class="sr">The Runs list’s rows for a run that lacked what it needed</caption>'
              f'<thead><tr>{head}</tr></thead><tbody>{list_row("gh-03a9", NO_FLOW)}{list_row("gh-444c", EXT_FAILED)}</tbody></table></div></section>')
    no_flow = outcome_state("p-outcome-no-flow", "attention", NO_FLOW, "Finished in 22m on mini2",
                            f"{NO_SKILL} Read what it did before you trust it. {MERGES}",
                            run_actions(btn("Open trigger 3", "", "config", sm=False) + btn(BASE_BUTTON, "", "git", sm=False)))
    ext_failed = outcome_state("p-outcome-extension-failed", "attention", EXT_FAILED, "Finished in 22m on mini2",
                               f"1 of acme/api’s extensions failed to load. The extension failed while it loaded and the run went on. Read what it did before you trust it. {MERGES}",
                               run_actions(btn(BASE_BUTTON, "", "git", sm=False)))
    return (f'<h3 class="ld-h3">In the Runs list and the outcome banner</h3>{table_}'
            f'<div class="ld-banners">{no_flow}{ext_failed}</div>')


def viewer_card():
    """The lines that carry a button for an operator, read by a viewer. The other lines never had one."""
    rows = "".join(f'<tr><td><span class="code">{j}</span></td><td>{out}</td><td class="ld-line wide">{line}</td></tr>'
                   for j, out, line, act in STATES if act != NONE)
    tbl = (f'<div class="tbl-wrap"><table class="tbl tbl--stack ld-tbl"><caption class="sr">The same lines, as a viewer reads them</caption>'
           f'<thead><tr><th>Run</th><th>Outcome</th><th>What the card says</th></tr></thead><tbody>{rows}</tbody></table></div>')
    foot = (f'<p class="ld-foot ld-foot--flush">{ic("eye", "ic ic--sm")}<span>The same words, with no button: a viewer reads the top line, the card and its fold. '
            f'The project page’s top line loses Open build3 the same way.</span></p>')
    return card("As a viewer sees it", tbl + foot, sub="the lines that carry a button for an operator", id_="p-loaded-viewer", flush=True)


# A sandbox mounts no /opt/pi-global (worker/src/sandbox.mjs), so what pi would load in it is only ever the workspace's own
# .pi/, whatever the run it came from loaded or a job on that host would load. Saying "as gh-9575 loaded" would promise
# tools the shell does not have.
NO_OVERLAY = "pi 1.5.0 in the image. No overlay is mounted, so pi started here loads only the workspace’s own .pi/."


def states_page():
    rows = "".join(f'<tr><td><span class="code">{j}</span></td><td>{out}</td>'
                   f'<td class="ld-line wide">{line}</td><td class="ld-act wide">{act}</td></tr>' for j, out, line, act in STATES)
    tbl = (f'<section class="card card--flush" id="p-loaded" data-panel aria-labelledby="ld-h"><div class="card__head"><h2 id="ld-h">Loaded, by run</h2>'
           f'<span class="card__sub">the line at the top of each run’s Loaded card</span></div>'
           f'<div class="tbl-wrap"><table class="tbl tbl--stack ld-tbl"><thead><tr><th>Run</th><th>Outcome</th><th>What the card says</th><th class="ld-act">Where it is fixed</th></tr></thead>'
           f'<tbody>{rows}</tbody></table></div></section>')
    lead = (f'<p class="ld-lead">{ic("info", "ic ic--sm")}<span>A problem line also goes in the outcome, as “Completed, without its flow” or “Completed, with a failed extension”, '
            f'so a run that exits 0 without what it needed does not read as fine. A server that cannot be used, or does not answer, stops the run instead, so it never reads as completed.</span></p>')
    sandbox = card("What opens", facts([
        ("Image", "pi-job:4.3.1"),
        ("/workspace", "Its retained clone"),
        ("/job", "Read only, with the retained job inputs"),
        (f'<span class="ld-new">pi and what it loads</span>', f'<span class="ld-new">{NO_OVERLAY} <a class="link code" href="#">gh-9575</a> itself also loaded pi-lint 1.4.2 and pi-test-runner 0.9.0.</span>'),
        ("Processes", "None until you start them"),
        ("Credentials", "None, on purpose"),
        ("Network", "The host's current job egress policy"),
    ], 1) + f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>Nothing loads until you start pi in the shell.</span></p>',
        sub="Sandboxes, from gh-9575", id_="p-loaded-sandbox")
    fresh = card("What opens", facts([
        (f'<span class="ld-new">On mini1</span>', f'<span class="ld-new">{NO_OVERLAY} A job of trigger 3 on this host would load pi-lint 1.4.2 and pi-test-runner 0.9.0, from its last doctor run at 2026-10-08 14:39 UTC.</span>'),
        # Issue #847: where the host published a doctor run, the flow and the MCP servers the trigger names, in the trigger page's words.
        (f'<span class="ld-new">Flow</span>', f'<span class="ld-new">A job of trigger 3 on this host would find fix from the overlay, unless the repository holds it at its base commit, which comes first.</span>'),
        (f'<span class="ld-new">MCP servers</span>', f'<span class="ld-new">linear on this host; docs not on this host, so a job there is refused before it spends.</span>'),
        (f'<span class="ld-new">On mini2</span>', f'<span class="ld-new">{NO_OVERLAY} What a job of trigger 3 would load on this host is unknown: it has published no doctor run.</span>'),
    ], 1) + f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>A fresh sandbox has no run to quote, so it says what a job would load there, from the host’s last doctor run, or unknown. The repository’s part is decided at its base commit.</span></p>',
        sub="Sandboxes, a fresh one", id_="p-loaded-sandbox-fresh")
    # Under a row of What its jobs get, the row's control from the file and the record's words beneath it, past, by the run's id and host.
    trigger = card("MCP servers", facts([
        (code("run.mcp"), "linear, as the file says now"),
        (f'<span class="ld-new">Last run</span>', f'<span class="ld-new">Last run on mini1, <a class="link code" href="#">gh-2f6a</a>: linear connected, with 12 tools.</span>'),
    ], 1) + f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>Each row of What its jobs get has this line: what the file says the next job gets, and under it what its last run had.</span></p>',
        sub="trigger 7, under a row of What its jobs get", id_="p-loaded-trigger")
    rest = (f'<h3 class="ld-h3">The same record, in two more places</h3><div class="ld-pair">{sandbox}{fresh}</div>'
            f'<div class="ld-pair">{trigger}</div>')
    viewer = f'<h3 class="ld-h3">For a viewer</h3>{viewer_card()}'
    return shell("Runs", lead + tbl + in_the_list() + rest + viewer, "What each run loaded",
                 sub="The top line of each run’s Loaded card, and where it is fixed.", back="Runs")


# ---------------------------------------------------------------- ProjectLoads: the project page's What its runs load
def run_link(job):
    return f'<a class="link code" href="#">{job}</a>'


def loads_card():
    top = (f'<p class="ld-top">{state_line("attention", "attention", "Runs differ by host: build3 also loads git-guard from its overlay.")} '
           f'<a class="link" href="#">Open build3</a></p>')
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', "all 21 recorded runs"),
        row("bolt", "Models", "anthropic / claude-sonnet-5-5", "all 21 recorded runs"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0", "from each host’s newest run able to show them, and git-guard on build3; 3 did not load or were not recorded"),
        row("skill", "Flows", f'{code("fix")} in 15, {code("review")} in 6', "fix from acme/billing’s .pi/skills; review from the overlay"),
        row("plug", "MCP", "none", "no recorded run names a server"),
        row("refused", "Missing", "nothing", "no record says a run lacked its flow or an extension, or was stopped by an MCP server"),
        row("minus", "Not read", "3 of 24 runs", f"{run_link('gh-e9a0')} was refused before its container started; {run_link('gh-4a7e')}’s runner did not say what it loaded; an older release wrote {run_link('gh-c3f8')}’s record"),
    ])
    hosts = [
        [(f'<b class="code">build3</b> {venue("podman")}', ""), ("18", "num"), ("15", "num"),
         ('pi-lint 1.4.2, pi-test-runner 0.9.0, git-guard <span class="muted">(overlay)</span>', "wide"),
         (code("fix"), "")],
        [(f'<b class="code">mini2</b> {venue("local")}', ""), ("6", "num"), ("6", "num"),
         ("pi-lint 1.4.2, pi-test-runner 0.9.0", "wide"),
         (code("review"), "")],
    ]
    tbl = table([("Host", ""), ("Runs", "num"), ("Recorded", "num"), ("Extensions", ""), ("Flow", "")], hosts, cls="tbl ld-host", caption="What billing’s runs load, by host", stack=True)
    foot = (f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>From the records of its runs in the last 7 days. A host’s pi, packages and overlay are from its newest run able to show each, and are that host’s own, '
            f'so runs of one project can load different things on different hosts.</span></p>')
    return card("What its runs load", top + f'<ul class="ld-list">{lines}</ul>' + f'<div class="ld-more">{tbl}</div>' + foot,
                sub="24 runs in the last 7 days", id_="p-proj-loads")


def loads_incomplete_card():
    top = (f'<p class="ld-top">{state_line("attention", "attention", "Read from 9 of its 24 runs in the last 7 days, so runs may differ in ways this does not show.")}'
           f'<small>15 did not load or were not recorded: 12 from an older release, 2 refused, 1 whose runner did not say.</small></p>')
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', "the 9 recorded"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0, git-guard", "from its newest run able to show them; 15 did not load or were not recorded"),
        row("refused", "Missing", "nothing in the 9 recorded", "a run with no record cannot say"),
    ])
    return card("What its runs load", top + f'<ul class="ld-list">{lines}</ul>', sub="24 runs in the last 7 days", id_="p-proj-loads-incomplete")


def loads_same_card():
    top = f'<p class="ld-top">{state_line("ok", "done", "Runs load the same on each host: mini1 and mini2.")}</p>'
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', "every recorded run"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0", "from each host’s newest run able to show them"),
    ])
    foot = f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>A host’s pi, packages and overlay are from its newest run able to show each, so an update every host took is no difference.</span></p>'
    return card("What its runs load", top + f'<ul class="ld-list">{lines}</ul>' + foot, sub="8 runs in the last 7 days", id_="p-proj-loads-same")


def loads_none_card():
    top = f'<p class="ld-top">{state_line("idle", "minus", "Nothing to read: no run of this project recorded what it loaded in the last 7 days.")}<small>Either none ran, or an older release wrote their records.</small></p>'
    return card("What its runs load", top, sub="0 runs in the last 7 days", id_="p-proj-loads-none")


def project_page():
    M = [("github:acme/billing", "git", "repository", "18 runs this week", "15:30 UTC"),
         ("gitlab:acme/billing-ui", "git", "repository", "6 runs this week", "13:49 UTC")]
    members = card("Members", '<ul class="rows">' + "".join(
        f'<li class="rowpill">{ic(i, "ic ic--sm")}<b class="code">{E(n)}</b><span>{k}</span><span class="end">{r} · last {l}</span></li>' for n, i, k, r, l in M) + "</ul>",
        id_="p-proj-members", sub="2 repositories")
    trg = card("Triggers that ran here", f"""<ul class="rows">
  <li class="rowpill">{ic('comment', 'ic ic--sm')}<b>3</b><span>comment {code('"@pi"')} → fix</span><span class="end">9 runs</span></li>
  <li class="rowpill">{ic('pr', 'ic ic--sm')}<b>4</b><span>pull request on gitlab → review</span><span class="end">2 runs</span></li>
</ul>""", id_="p-proj-triggers", sub="last 24 hours")
    lead = (f'<p class="ld-lead">{ic("info", "ic ic--sm")}<span>A new card on the project page, beside the ones ProjectDetail draws. '
            f'The rest of the page is unchanged.</span></p>')
    # The other three states carry the console's own sub, as runs in the last 7 days, so what tells them apart is said above each.
    states = (f'<h3 class="ld-h3">While most runs have no record</h3>{loads_incomplete_card()}'
              f'<h3 class="ld-h3">On web, when no host differs</h3>{loads_same_card()}'
              f'<h3 class="ld-h3">On shop, with no record</h3>{loads_none_card()}')
    inner = lead + f'<div class="cols"><div class="stack">{loads_card()}{states}</div><div class="stack">{members}{trg}</div></div>'
    sub = f'<span class="c2-lead">{tag("billing")}<span class="muted">2 members · id</span><span class="code">billing</span><span class="muted">in</span><span class="code">…/deploy/projects.json</span></span>'
    return shell("Configuration", inner, "billing", sub=sub, end=btn("Open in Runs", "", "runs", sm=False), back="Configuration")


# The Members rows wrap beside this card at 1440 as well as on a phone, and a pill's curve only holds one line: wrapped
# text sits in its corner. So the radius and padding hold at every width.
PROJECT_CSS = """
#p-proj-members .rowpill { min-width: 0; flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); }
#p-proj-members .rowpill .end { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 760px) { #p-proj-members .rowpill .end { margin-left: 26px; } }
"""


# ---------------------------------------------------------------- READMEs
README = {
"RunLoaded": """
A completed run's **Loaded** card: what the job had when it started, one line per kind. Today a run page names the model and the flow; nothing says which extensions, skills, MCP servers or tools the job loaded, or which pi and image it ran on. Those depend on the host, the repository at its base commit, the trigger and the image, and the configuration pages show only what should load.

**How a person uses it.**
- **The top line** says whether everything the trigger asks for loaded. When something did not (LoadedStates draws each case), it names what, and the outcome says it too.
- **One line per kind:**
  - **pi:** the version and image the job ran, with the image id.
  - **Model:** the model and its calls.
  - **Extensions:** each staged package with its exact version, overlay extensions by name, and how many came from the repository.
  - **Skills:** the flow and where it was found (repository, the trigger's skills folder, the overlay or a staged package), and how many more loaded, by tier.
  - **MCP:** each server the trigger names, its state and how many tools it brought.
  - **Tools:** how many were active, pi's own and the job's own by name, and which the trigger removed. A run's `report_progress` counts here: `run.progress` registers it (`image/runner/run-job.mjs`), so gh-9575's 10 are pi's 4, the extensions' 5 and that one.
- **What was left out on purpose** is said as such, never as missing: tools a trigger removes (`run.excludeTools`), staged packages a trigger withholds (`"packages": false`) and the overlay's extensions where this job's switch is off (`PI_GLOBAL_ALLOW_EXTENSIONS=0` on its host, or a model canary's replay).
- **Each item, and where it came from** folds a table with every name and count, its version and its source. That includes what no top line mentions: the skills a package had replaced, the themes and the extensions the guard dropped. On a phone a row reads kind, then name or count, with *Version* only where there is one.

**Panels.** `p-outcome`, `p-run`, `p-loaded`, `p-cost`, `p-resources`, `p-session`.

**The server provides.**
- **Today:** the model, the flow's name, the per-model usage, the trigger row and the host. The runner already computes most of the rest but only writes it to the job's log: each staged package's resources, a flow found nowhere (`flow_not_loaded`), a package skill shadowed, an extension that failed or was dropped, the active tools when some are removed, and how many MCP servers came up.
- **New:** one bounded `loaded` field on the runner's signed exit line, kept in the run record:
  - pi's version, and whether the flow was found and where.
  - Each staged package with its name and version; overlay extensions by name, since overlay files have no version; repository extensions and other skills as counts by tier.
  - Prompt templates and themes as counts by tier.
  - How many of each package's skills were replaced, and how many extensions the guard dropped per tier; names stay in the job's log.
  - Each MCP server's state and how many tools it brought. The record holds a state, not a duration.
  - The active tools by count, and pi's own and the job's own by name. Names each staged or overlay extension's tools; a repository's stay a count.
  - Every load failure, as a count by tier. Its path and a fixed kind stay in the job's log, and pi's error text is kept nowhere, because it can quote the module's source.
- **The worker adds** the image and its id. The image id on this host; two local builds of one tag differ, so it never counts as a host difference. It adds the commit the workspace was prepared at too, so the fold's *Read them there* and a repository extension's problem open the code that ran.
- **Past its bound** the record says it was cut (LoadedStates draws it) and never drops an entry silently. Older records have no `loaded` field, and say so.

**Who sees what.** Operators and viewers alike: the card holds names, versions, counts and states, never content, as the tool names a viewer sees today.

**Why it works this way.**
- **What ran, not what is configured.** Each host has its own overlay and staged packages, the repository changes with every merge, and an Adopt can miss a host. Only the run's own record says what it had.
- **A clean exit is not proof.** A flow found nowhere, or an extension that fails while loading, still runs and can exit 0. Fail loudly: the run page says so.
- **No repository names in the record.** The run record holds no string a repository chose, so skills and extensions from the repository are counts with a link to the base commit. Names come only from what the deployment staged and configured.
- **One line per kind,** as on the Workspace row. The table folds.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, trigger 3 and the model are the fixture, as on RunEnded. pi 1.5.0, pi-job:4.3.1 and the staged packages pi-lint 1.4.2 and pi-test-runner 0.9.0 are as on Updates, Sandboxes and Connections. That pairing is sample only: tag 4.3.1 pins pi 1.2.0, and these cards cite 4.3.1 for its behaviour alone. Sample: the image id, the counts, the replaced skill, and the tool names and split (as on TriggerEnvironment).
""",
"LoadedStates": """
The top line of each run's Loaded card, run by run, what the outcome says in the Runs list and on the run page, where the same record is repeated (a sandbox and a trigger), and what a viewer reads.

**How a person uses it.**
- **Everything loaded** (gh-9575): one green line, nothing to do.
- **Left out, as the trigger asks** (gh-8251-r2): trigger 2 removes bash and withholds the staged packages. Still green: what a trigger turns off is not a problem.
- **Left out for this job** (gl-af91): *Left out for this job: the overlay's extensions*. That switch is the job's: `PI_GLOBAL_ALLOW_EXTENSIONS=0` on its host closes it and so does a model canary's replay, so no line says the host asked, and the fold names both. Still green, for the same reason.
- **An MCP server connected** (gh-2f6a): each server the trigger names, with its state and how many tools it brought.
- **An extension was dropped** (gh-4add): the recursion guard dropped one of the repository's extensions. A count in the fold, with no sentence and no warning.
- **A record was cut** (gh-a3ac): the record ran past its bound, so it says what it left out. *Cut to fit: this record keeps the counts and leaves out package, overlay and tool names.* It says nothing about whether the run was fine, so it sits under the line that does.
- **Ran without its flow** (gh-03a9): the trigger names fix, and pi found no skill of that name in the repository at its base commit, a skills folder, the overlay or a staged package. That is what the record knows: at pi 1.5.0 a skill with no description is not loaded and `frontmatter.name` renames one, so the line never says the repository has none. *Open trigger 3*, or *Open the base commit a41c0d2* to read what it held. A scheduled run keeps no row, only its id, so it offers *Find nightly-report in Triggers*, the list that trigger is on. The outcome says *Completed, without its flow*.
- **An extension failed to load** (gh-444c): one of the repository's own extensions failed while loading. The line gives no total, because a conflicted extension counts as both loaded and failed and the record keeps no kind, and says *went on without it* only when none of that tier's loaded (gh-5e1d). *Open the base commit a41c0d2*, the code that ran. A record that names no commit says *Open the repository*, and a forge with no address leaves the words with no button. Failures in two tiers name each, with one way per tier. A run says it went on only where the record shows it did, by completing or taking a turn, whatever stage its list reached; one that did neither says only what failed to load. The outcome says *Completed, with a failed extension*.
- **An MCP server could not be used** (gh-6b0d): it failed at start, so the run stopped before the agent started, after its extensions and skills had loaded, and its outcome is refused. It is not retried. *Open Connections*.
- **An MCP server did not answer** (gh-4b12): the wait ran out, so the run stopped before the agent started. It is retried as any infrastructure failure, so its outcome is failed. *The queue has stopped retrying this job* is said only when the queue reports the job failed, as here; neither the queue nor the record gives the total, so no attempt is called the last. *Retried* is said only where the queue holds the job again or the record is a later attempt; a first attempt with neither says what the queue does and nothing of this run. *Open Connections*.
- **A host differs** (gh-ebd7): build3's overlay adds an extension mini1 does not have, and mini2 has published nothing. *Open build3* and *Open mini1*: the fix is on whichever is behind, so the host that has the name and up to 3 of the hosts that lack it get a button, and the sentence names the rest. A host that published nothing gets words.
- **Running** (gh-b3d7): shown when it ends, from its record.
- **Stopped** (no row here; its goldens are `run-loaded-stopped` and `run-loaded-stopped-after-loading`): a run that neither completed nor went on is never *Everything loaded*, whatever stage its list reached, because the runner can note `ready` and then refuse a command no extension registers or skip the prompt, and a provider can refuse the first prompt with the turn already counted. It says how far it got, and the outcome says what can stop a run this way. A run that went on with a list stuck at an earlier stage, because a repository's extension broke the report, says so under the line.
- **No record** (gh-c3f8): an older release wrote it. **Refused** (gh-e9a0): nothing loaded.
- **In the Runs list and the banner** (`p-loaded-runs`, and `p-outcome` drawn twice): the record's outcome stays completed, and the word a person reads is *Completed, without its flow* or *Completed, with a failed extension*.
- **In a sandbox,** What opens gains one row. A shell has no overlay, so pi started there loads only the workspace's own `.pi/`, whatever the run loaded; the row says that first, then what the run itself had, linked to it. A fresh sandbox has no run to quote, so it says what a job of the trigger would load on that host, from its last doctor run with the time, or that this is unknown. Its Flow row says where a job there would find the trigger's flow, in the trigger page's words, and reads unknown where that run answered for the triggers file as it was.
- **On a trigger,** under each row of *What its jobs get* (TriggerEnvironment): what the file says the next job gets, and beneath it what its last run that said what it loaded had, by its id and host. When a newer run could not say, the card names it and why.
- **As a viewer sees it:** the same words with no button.

**Panels.** `p-loaded`, `p-loaded-runs`, `p-outcome-no-flow`, `p-outcome-extension-failed`, `p-loaded-sandbox`, `p-loaded-sandbox-fresh`, `p-loaded-trigger`, `p-loaded-viewer`. On a run page the two outcome panels are `p-outcome`.

**The server provides.** The run record's new `loaded` field (RunLoaded). For a trigger, its last run's record. For a fresh sandbox: What the host's last doctor run published, with its time, or unknown. The repository's part is decided at its base commit. The publication is a new key, `doctor:loads:<name>`, and it is also what the gh-ebd7 line reads for mini1 and mini2. pi's version and the image come from what every live host already publishes, `host:h:<name>` (`image`, `imageDigest`, `piVersion`, `INT-HOST-REGISTRY-CONTRACT`), so mini2's fresh row still has them. Its version is said only where the sandbox's image is the one that host booted on: a kept older image and a trigger's own `run.image` hold their own pi. For a shell, nothing about the overlay: `worker/src/sandbox.mjs` mounts no `/opt/pi-global`, and `worker/src/sandbox-store.mjs` says a reopened workspace loads neither the candidate nor the overlay.

**Who sees what.** As RunLoaded: viewers read the same words, and the buttons are operator actions, so a viewer has none (`p-loaded-viewer`).

**Why it works this way.**
- **The problem goes where the next step is.** A missing flow is fixed on the trigger or in the repository, a repository extension at the commit that ran, an MCP server in Connections, a host's overlay on its host page.
- **The outcome says it too,** so a run list read at a glance does not show a run that lacked its flow, or lost an extension, as plainly completed.
- **An MCP server that fails stops the job.** One that failed at start is `mcp-unavailable` (exit 2, not retried, so the outcome is refused), and one still pending after the wait is `mcp-unreachable` (exit 1, retried). Both come from `lifecycle.start`, which runs after the session is created, so what loaded is still in the record. The wait is 15 seconds by default, longer for a server whose own `timeout` is longer, so the line says *in time* and names no duration.
- **A dropped extension is quiet on purpose.** This repository ships `dispatch.ts` in `.pi/extensions`, so a warning would fire on every run on itself.
- **A host's publication proves that host, and only one that published.** The gh-ebd7 line says what build3's run had, that mini1's publication lacks the extension, and that mini2 has published nothing, which is not the same as lacking it. It does not say other runs went without it. The other hosts are read as they are now, so a name is a difference only while the run's own host still lists it: a package every host has moved past is no difference between any of them.
- **Shown when it ends.** The record is written from the exit line; a live line would need the worker to trust a second line during the run.

**Fixture note.** From the fixture: every run with its outcome and host (gh-8251-r2, gl-af91, gh-03a9 and gh-444c on mini2; gh-2f6a, gh-4add, gh-a3ac, gh-6b0d, gh-4b12 and gh-b3d7 on mini1; gh-ebd7 and gh-c3f8 on build3). The cut record is on mini1 because every recorded run on build3 reads the git-guard line. gh-2f6a's 24 active tools are pi's 4, the extensions' 5, the job's 3 and linear's 12. A merge between gh-444c at 09:45 and gh-03a9 at 12:43 removed acme/api's fix skill, so the earlier run has no flow warning. gh-2f6a is the fixture's parked job, so it connected, and it ended after gh-4b12, which did not; gh-6b0d is earlier still. mini1's doctor run at 14:39 UTC is Fleet's "1h ago" against the fixture's 15:39. Sample: trigger 2's removed bash and withheld packages, gl-af91's overlay off (yesterday, so today's mini2 runs do not carry the line), that merge, acme/api's failed extension and gh-5e1d, the base commit a41c0d2, linear as trigger 7's MCP server with its 12 tools, build3's overlay extension git-guard (as on ProjectLoads), the extension dropped on gh-4add, the record cut on gh-a3ac, the two banners' sentences, and pi 1.5.0 in pi-job:4.3.1 (RunLoaded's note says why).
""",
"ProjectLoads": """
The project page's **What its runs load**: what its runs had in the last 7 days, one line per kind, and a warning when runs of one project load different things on different hosts.

**How a person uses it.**
- **The top line** says what differs. Here build3's overlay adds git-guard, so the 15 recorded runs of acme/billing on build3 load an extension the 6 on mini2 do not. *Open build3*. A host's fact comes from the newest of its runs able to show that fact: pi and its image from its newest run on the host's own image, its packages from its newest run that did not withhold them, was no canary and kept their whole list, and its overlay from its newest run with the overlay open and its whole list kept. So a host that ran 1.4.2 and then 1.4.3 has 1.4.3 whichever trigger ran last, and a routine Adopt is no difference.
- **One line per kind:** pi and image, models, extensions, flows and where each was found, MCP servers, what was missing, and the runs it could not read. Extensions says what each host's newest run able to show them had, and the rest count recorded runs: of the 18 on build3, gh-e9a0 was refused before its container started, gh-4a7e's runner did not say what it loaded, and an older release wrote gh-c3f8's record. A record cannot tell why a runner did not say (an older image, a runner that died), so none is claimed; a cancel with a live runner does write its line, on SIGTERM, so cancelled alone does not mean not recorded.
- **By host:** a table of each host's runs, how many of them are recorded, the extensions its newest runs able to show them had, and the flows.
- **While most runs have no record** (`p-proj-loads-incomplete`): the same card, whose top line says how few it read and why, and that runs may differ in ways it does not show. It claims no sameness on what it cannot read, and says why for each host it cannot. A difference between two hosts it did read stands, however few runs that was: the card above then says how few under its top line. A run with no agent loads nothing, so the card leaves it out and says how many it left out.
- **When no host differs** (`p-proj-loads-same`): one green line naming the hosts, on web, whose 8 runs in the last 7 days are all it counts. It is green only with nothing missing: when a run lacked its flow or an extension, or an MCP server stopped it, Missing says so and the line takes the attention tone, however well the hosts agree.
- **When nothing has a record** (`p-proj-loads-none`): one muted line, on shop, saying so, with no rows to read.

**Panels.** `p-proj-loads`, and `p-proj-loads-incomplete`, `p-proj-loads-same` and `p-proj-loads-none` (the same panel in those states), beside ProjectDetail's panels.

**The server provides.** Nothing new beyond RunLoaded's `loaded` field: the page groups its runs' records by host.

**Who sees what.** As the rest of the project page. A viewer reads the same words, and the top line has no *Open build3* (LoadedStates draws the same rule).

**Why it works this way.**
- **A project spans hosts,** and each host has its own overlay and staged packages. A difference by host is the one thing no single run page shows.
- **From records, not configuration,** so it shows what happened, including after an Adopt that one host missed.
- **The last 7 days, rolling.** A calendar week would empty this card every Monday, when a person is most likely to ask what ran over the weekend. Members, under it, stays this week from Monday 00:00 UTC (`costsSinceMs("week")`) and says so, so the two can differ; here 18 and 6 add up to this card's 24 because nothing of billing's ran earlier.
- **A model canary and a restricted run say nothing of a host's overlay,** which they have shut by their kind. A package canary is an ordinary job on its host's switch, fired by hand from a cron trigger, so its overlay is its host's; only its candidate stays out.
- **The image id is not a difference.** The image id on this host; two local builds of one tag differ, so it never counts as a host difference.

**Fixture note.** billing, its two repositories with 18 and 6 runs this week, its triggers' 9 and 2 runs in the last 24 hours, build3 for acme/billing, mini2 for acme/billing-ui, and gh-e9a0, gh-4a7e and gh-c3f8 are as on ProjectDetail, LoadedStates and in the fixture. Sample: git-guard in build3's overlay, review in the overlay (as on TriggerEnvironment), the incomplete card's 9 of 24 and its split, which are all build3's and so hold git-guard, the same and none states on web and shop, and pi 1.5.0 in pi-job:4.3.1 (RunLoaded's note says why).
""",
}


if __name__ == "__main__":
    write("RunLoaded", card_marker("Runs", 1700, 1440, "A completed run’s Loaded card: pi and its image, the model, extensions, skills, MCP and tools, one line each"),
          "Run gh-9575, what it loaded", run_loaded_page(), RUN_STYLE + CSS)
    write("LoadedStates", card_marker("Runs", 1300, 1440, "The Loaded card’s top line run by run, and the same record in a sandbox and on a trigger"),
          "What each run loaded", states_page(), RUN_STYLE + RUNS_STYLE + CSS)
    write("ProjectLoads", card_marker("Configuration", 1100, 1440, "The project page’s What its runs load: one line per kind, and a warning when runs differ by host"),
          "billing, what its runs load", project_page(), CSS + PROJECT_CSS)
    for name, text in README.items():
        readme(name, text)
    print("loaded cards written")
