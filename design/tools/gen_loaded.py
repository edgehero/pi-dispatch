"""What a run loaded: pi and its image, the model, extensions, skills, MCP servers and tools, as the run had them.

Today a run page shows the model and the flow's name. What else the job loaded is in no record: the configuration pages
say what should load (a trigger's fields, Connections, Updates), but what loads depends on the host's overlay and
staged packages, the repository at its base commit, the trigger and the image, and each of those changes on its own.
A flow that is found nowhere, or an extension that fails to load, still runs and can exit 0.

One rule keeps it simple, as on the Workspace row: one line per kind, and the details fold.

Three cards:
- RunLoaded: a completed run's Loaded card (pi and image, model, extensions, skills, MCP, tools).
- LoadedStates: that card's one line, run by run, and the two places it is repeated (a sandbox, a trigger).
- ProjectLoads: the project page's What its runs load, which says when runs of one project differ by host."""
from pulse import *
from gen_runs import RUN_STYLE, run_title, ended_facts, ended_tokens, ended_resources, ended_session
from gen_config2 import table, code, state_line, COMMON_CSS


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


CSS = COMMON_CSS + """
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.ld-top { display: block; margin-bottom: var(--space-4); font-size: 14px; }
.ld-list { display: grid; gap: 12px; }
.ld-row { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 2px 14px; align-items: baseline; font-size: 14px; line-height: 20px; }
.ld-k { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; color: var(--ink-muted); }
.ld-k .ic { flex: none; }
.ld-v { min-width: 0; color: var(--ink); }
.ld-v b { font-weight: 650; }
.ld-v small { display: block; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.ld-v .c2-st { font-weight: 600; }
.ld-more { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); }
.ld-more summary { cursor: pointer; font-size: 13px; color: var(--ink-muted); }
.ld-more .tbl-wrap { margin-top: var(--space-3); }
.ld-foot { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-4); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.ld-foot .ic { flex: none; margin-top: 2px; }
.ld-tbl td { vertical-align: middle; }
.ld-tbl .ld-line { min-width: 280px; font-size: 13px; line-height: 20px; }
.ld-tbl .ld-line .c2-st { font-weight: 550; }
.ld-tbl .ld-act { text-align: right; white-space: nowrap; }
.ld-tbl .muted { font-size: 13px; }
.ld-lead { display: flex; gap: 8px; align-items: flex-start; margin-bottom: var(--space-4); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.ld-lead .ic { flex: none; margin-top: 2px; }
.ld-h3 { margin: var(--space-6) 0 var(--space-3); font-size: 15px; font-weight: 700; }
.ld-new { box-shadow: inset 3px 0 0 var(--running); padding-left: 10px; }
.ld-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.ld-host td { vertical-align: top; }
.ld-host .ld-names { display: flex; flex-wrap: wrap; gap: 4px 8px; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .ld-row { grid-template-columns: minmax(0, 1fr); }
  .ld-pair { grid-template-columns: minmax(0, 1fr); }
  .ld-tbl .ld-line { min-width: 0; }
  .ld-tbl .ld-act { text-align: left; }
  .ld-tbl .ld-act:has(> .muted:only-child) { display: none; }
}
"""


def row(icon, label, value, more=""):
    small = f"<small>{more}</small>" if more else ""
    return f'<li class="ld-row"><span class="ld-k">{ic(icon, "ic ic--sm")}{label}</span><span class="ld-v">{value}{small}</span></li>'


# ---------------------------------------------------------------- RunLoaded (gh-9575, everything loaded)
def loaded_panel():
    top = f'<p class="ld-top">{state_line("ok", "done", "Everything trigger 3 asks for loaded.")}</p>'
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', f'image {code("sha256:7c1e0b4…")}, as mini1 ran it'),
        row("bolt", "Model", "anthropic / claude-sonnet-5-5", "14 calls; trigger 3 allows any model"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0", "staged on mini1"),
        row("skill", "Skills", "<b>fix</b>, the flow, from the repository", "and 3 more: 2 from the repository, 1 from pi-test-runner"),
        row("plug", "MCP", "none", "trigger 3 names no server"),
        row("flows", "Tools", "9 active", "read, bash, edit and write, and 5 from the extensions; none removed"),
    ])
    rows = [
        [("Extension", ""), (code("pi-lint"), ""), ("1.4.2", ""), ("staged on mini1", "wide")],
        [("Extension", ""), (code("pi-test-runner"), ""), ("0.9.0", ""), ("staged on mini1", "wide")],
        [("Skill", ""), (f'{code("fix")} <span class="muted">(the flow)</span>', ""), ("", ""), ("the repository’s .pi/skills at a41c0d2", "wide")],
        [("Skill", ""), ("2 more", ""), ("", ""), ('the repository at a41c0d2. <a class="link" href="#">Read them there</a>; a record keeps no names from a repository.', "wide")],
        [("Skill", ""), (code("run-tests"), ""), ("0.9.0", ""), ("pi-test-runner", "wide")],
        [("Prompt template", ""), ("1", ""), ("", ""), ("pi-lint", "wide")],
        [("Tools", ""), ("read, bash, edit, write", ""), ("", ""), ("pi", "wide")],
        [("Tools", ""), ("5", ""), ("", ""), ("2 from pi-lint, 3 from pi-test-runner", "wide")],
    ]
    more = (f'<details class="ld-more"><summary>Each item, and where it came from</summary>'
            f'{table([("Kind", ""), ("Name", ""), ("Version", ""), ("From", "")], rows, cls="tbl", caption="What gh-9575 loaded", stack=True)}</details>')
    foot = (f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>What pi loaded when this run started, from its record: names and versions from what the '
            f'deployment staged and configured, and counts for what the repository holds.</span></p>')
    return card("Loaded", top + f'<ul class="ld-list">{lines}</ul>' + more + foot, sub="what this run had", id_="p-loaded")


def run_loaded_page():
    sub = f'{tag("web")} <a class="link" href="#">acme/web#490</a> <span class="muted">fix on mini1, ended 15:12 UTC</span>'
    oc = outcome("completed", "Completed", "Finished in 22m on mini1",
                 "Merges are never automatic: review the pull request on the forge.",
                 btn("Open acme/web#490", "primary", sm=False))
    main = f'<div class="stack">{ended_facts()}{loaded_panel()}</div>'
    side = f'<div class="stack">{ended_tokens()}{ended_resources()}{ended_session()}</div>'
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("gh-9575"), sub=sub, end=badge("completed"), back="Runs")


# ---------------------------------------------------------------- LoadedStates: the one line, run by run
NONE = '<span class="muted">none</span>'
STATES = [  # (job, outcome kind, the line, where it is fixed)
    ("gh-9575", "completed", state_line("ok", "done", "Everything trigger 3 asks for loaded."), NONE),
    ("gh-8251-r2", "completed", state_line("ok", "done", "Everything trigger 2 asks for loaded. <b>Left out, as it asks:</b> bash, and the staged packages."), NONE),
    ("gh-03a9", "completed", state_line("attention", "attention", "<b>Ran without its flow.</b> acme/api has no fix skill at its base commit, and no skills folder or staged package ships one."),
     btn("Open trigger 3", "", "config")),
    ("gh-444c", "completed", state_line("failed", "failed", "<b>1 of acme/api’s 2 extensions failed to load.</b> The run went on without it."),
     btn("Open the base commit", "", "git")),
    ("gh-2f6a", "awaiting", state_line("attention", "attention", "<b>linear did not connect</b> (no answer in 30 s). The run went on without its tools."),
     btn("Open Connections", "", "plug")),
    ("gh-ebd7", "completed", state_line("attention", "info", "<b>Also loaded git-guard</b> from build3’s overlay. Runs of trigger 3 on mini1 and mini2 do not have it."),
     btn("Open build3", "", "fleet")),
    ("gh-b3d7", "running", '<span class="muted">Shown when it ends, from its record. Trigger 3 says what it asks for.</span>', btn("Open trigger 3", "", "config")),
    ("gh-c3f8", "completed", '<span class="muted">Not recorded: an older release wrote this run’s record.</span>', NONE),
    ("gh-e9a0", "refused", '<span class="muted">Nothing loaded: it was refused before its container started.</span>', NONE),
]


def states_page():
    rows = "".join(f'<tr><td><span class="code">{j}</span></td><td>{badge(k)}</td>'
                   f'<td class="ld-line wide">{line}</td><td class="ld-act wide">{act}</td></tr>' for j, k, line, act in STATES)
    tbl = (f'<section class="card card--flush" id="p-loaded" data-panel aria-labelledby="ld-h"><div class="card__head"><h2 id="ld-h">Loaded, by run</h2>'
           f'<span class="card__sub">the line at the top of each run’s Loaded card</span></div>'
           f'<div class="tbl-wrap"><table class="tbl tbl--stack ld-tbl"><thead><tr><th>Run</th><th>Outcome</th><th>What the card says</th><th class="ld-act">Where it is fixed</th></tr></thead>'
           f'<tbody>{rows}</tbody></table></div></section>')
    lead = (f'<p class="ld-lead">{ic("info", "ic ic--sm")}<span>A problem line also goes in the outcome, as “Completed, without its flow”, '
            f'so a run that exits 0 without what it needed does not read as fine.</span></p>')
    sandbox = card("What opens", facts([
        ("Image", "pi-job:4.3.1, as its manifest records it"),
        ("/workspace", "its retained clone"),
        (f'<span class="ld-new">pi and what it loads</span>', f'<span class="ld-new">As <a class="link code" href="#">gh-9575</a> loaded: pi 1.5.0, pi-lint 1.4.2, pi-test-runner 0.9.0, and the workspace’s own .pi/</span>'),
        ("Processes", "none until you start them"),
    ], 1) + f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>A fresh sandbox says what its trigger would load on that host now. Nothing loads until you start pi in the shell.</span></p>',
        sub="Sandboxes, from gh-9575", id_="p-loaded-sandbox")
    trigger = card("MCP servers", facts([
        (code("run.mcp"), "linear"),
        (f'<span class="ld-new">Its last run</span>', f'<span class="ld-new"><a class="link code" href="#">gh-2f6a</a> connected none: linear did not answer.</span>'),
    ], 1) + f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>Each run field the record covers gets this line: what the trigger asks for, beside what its last run had.</span></p>',
        sub="trigger 7, a run field", id_="p-loaded-trigger")
    rest = f'<h3 class="ld-h3">The same record, in two more places</h3><div class="ld-pair">{sandbox}{trigger}</div>'
    return shell("Runs", lead + tbl + rest, "What each run loaded",
                 sub="The top line of each run’s Loaded card, and where it is fixed.", back="Runs")


# ---------------------------------------------------------------- ProjectLoads: the project page's What its runs load
def loads_card():
    top = (f'<p class="ld-top">{state_line("attention", "attention", "Runs differ by host: build3 also loads git-guard from its overlay.")} '
           f'<a class="link" href="#">Open build3</a></p>')
    lines = "".join([
        row("box", "pi", f'pi 1.5.0 in {code("pi-job:4.3.1")}', "every run"),
        row("bolt", "Models", "anthropic / claude-sonnet-5-5", "every run"),
        row("layers", "Extensions", "pi-lint 1.4.2, pi-test-runner 0.9.0", "every run, and git-guard in the 18 on build3"),
        row("skill", "Flows", f'{code("fix")} in 18, {code("review")} in 6', "fix from acme/billing’s .pi/skills; review from trigger 4’s skills folder"),
        row("plug", "MCP", "none", "no trigger of this project names a server"),
        row("refused", "Missing", "nothing", "every run that started found its flow and loaded every extension"),
    ])
    hosts = [
        [(f'<b class="code">build3</b> {venue("podman")}', ""), ("18", "num"),
         ('pi-lint 1.4.2, pi-test-runner 0.9.0, git-guard <span class="muted">(overlay)</span>', "wide"),
         (code("fix"), "")],
        [(f'<b class="code">mini2</b> {venue("local")}', ""), ("6", "num"),
         ("pi-lint 1.4.2, pi-test-runner 0.9.0", "wide"),
         (code("review"), "")],
    ]
    tbl = table([("Host", ""), ("Runs", "num"), ("Extensions", ""), ("Flow", "")], hosts, cls="tbl ld-host", caption="What billing’s runs load, by host", stack=True)
    foot = (f'<p class="ld-foot">{ic("info", "ic ic--sm")}<span>From the records of its runs, last 7 days. The overlay and staged packages are each host’s own, '
            f'so runs of one project can load different things on different hosts.</span></p>')
    return card("What its runs load", top + f'<ul class="ld-list">{lines}</ul>' + f'<div class="ld-more">{tbl}</div>' + foot,
                sub="24 runs, last 7 days", id_="p-proj-loads")


def project_page():
    M = [("github:acme/billing", "git", "repository", "18 runs this week", "15:30 UTC"),
         ("gitlab:acme/billing-ui", "git", "repository", "6 runs this week", "13:49 UTC")]
    members = card("Members", '<ul class="rows">' + "".join(
        f'<li class="rowpill">{ic(i, "ic ic--sm")}<b class="code">{E(n)}</b><span>{k}</span><span class="end">{r} · last {l}</span></li>' for n, i, k, r, l in M) + "</ul>",
        id_="p-proj-members", sub="2 repositories")
    trg = card("Triggers that ran here", f"""<ul class="rows">
  <li class="rowpill">{ic('comment', 'ic ic--sm')}<b>3</b><span>comment {code('"@pi"')} → fix</span><span class="end">18 runs</span></li>
  <li class="rowpill">{ic('pr', 'ic ic--sm')}<b>4</b><span>pull request on gitlab → review</span><span class="end">6 runs</span></li>
</ul>""", id_="p-proj-triggers", sub="last 7 days")
    lead = (f'<p class="ld-lead">{ic("info", "ic ic--sm")}<span>A new card on the project page, beside the ones ProjectDetail draws. '
            f'The rest of the page is unchanged.</span></p>')
    inner = lead + f'<div class="cols"><div class="stack">{loads_card()}</div><div class="stack">{members}{trg}</div></div>'
    sub = f'<span class="c2-lead">{tag("billing")}<span class="muted">2 members · id</span><span class="code">billing</span><span class="muted">in</span><span class="code">…/deploy/projects.json</span></span>'
    return shell("Configuration", inner, "billing", sub=sub, end=btn("Open in Runs", "", "runs", sm=False), back="Configuration")


PROJECT_CSS = """
#p-proj-members .rowpill { min-width: 0; flex-wrap: wrap; }
#p-proj-members .rowpill .end { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 760px) { #p-proj-members .rowpill { flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); } #p-proj-members .rowpill .end { margin-left: 26px; } }
"""


# ---------------------------------------------------------------- READMEs
README = {
"RunLoaded": """
A completed run's **Loaded** card: what the job had when it started, one line per kind. Today a run page names the model and the flow; nothing says which extensions, skills, MCP servers or tools the job loaded, or which pi and image it ran on. Those depend on the host, the repository at its base commit, the trigger and the image, and the configuration pages show only what should load.

**How a person uses it.**
- **The top line** says whether everything the trigger asks for loaded. When something did not (LoadedStates draws each case), it names what, and the outcome says it too.
- **One line per kind:**
  - **pi:** the version and image the job ran, with the image digest.
  - **Model:** the model, its calls and what the trigger allows.
  - **Extensions:** each staged package with its exact version, and how many came from the overlay and the repository.
  - **Skills:** the flow and where it was found (repository, the trigger's skills folder, the overlay or a staged package), and how many more loaded.
  - **MCP:** each server and whether it connected.
  - **Tools:** how many were active, pi's own by name, and which the trigger removed.
- **What was left out on purpose** is said as such, never as missing: tools a trigger removes (`run.excludeTools`), staged packages a trigger withholds (`"packages": false`) and a host's overlay extensions turned off (`PI_GLOBAL_ALLOW_EXTENSIONS=0`).
- **Each item, and where it came from** folds a table with every item, its version and its source.

**Panels.** `p-outcome`, `p-run`, `p-loaded`, `p-cost`, `p-resources`, `p-session`.

**The server provides.**
- **Today:** the model, the flow's name, the per-model usage, the trigger row and the host. The runner already computes most of the rest but only writes it to the job's log: each staged package's resources, a flow found nowhere (`flow_not_loaded`), a package skill shadowed, an extension that failed or was dropped, the active tools when some are removed, and how many MCP servers came up.
- **New:** one bounded `loaded` field on the runner's signed exit line, kept in the run record: pi's version; each extension and skill with its name, version and source tier; whether the flow was found and where; each MCP server's state; the active tools by count and pi's own by name; and every load failure. The worker adds the image and its digest. Older records have none, and say so.

**Who sees what.** Operators and viewers alike: the card holds names, versions, counts and states, never content, as the tool names a viewer sees today.

**Why it works this way.**
- **What ran, not what is configured.** Each host has its own overlay and staged packages, the repository changes with every merge, and an Adopt can miss a host. Only the run's own record says what it had.
- **A clean exit is not proof.** A flow found nowhere, or an extension that throws while loading, still runs and can exit 0. Fail loudly: the run page says so.
- **No repository names in the record.** The run record holds no string a repository chose, so skills and extensions from the repository are counts with a link to the base commit. Names come only from what the deployment staged and configured.
- **One line per kind,** as on the Workspace row. The table folds.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, trigger 3 and the model are the fixture, as on RunEnded. pi 1.5.0, pi-job:4.3.1 and the staged packages pi-lint 1.4.2 and pi-test-runner 0.9.0 are as on Updates, Sandboxes and Connections. Sample: the digest, the base commit a41c0d2, the skill run-tests, the counts and the tool split.
""",
"LoadedStates": """
The top line of each run's Loaded card, run by run, and the two places the same record is repeated: a sandbox and a trigger.

**How a person uses it.**
- **Everything loaded** (gh-9575): one green line, nothing to do.
- **Left out, as the trigger asks** (gh-8251-r2): trigger 2 removes bash and withholds the staged packages. Still green: what a trigger turns off is not a problem.
- **Ran without its flow** (gh-03a9): the trigger names fix, and neither the repository at its base commit nor a skills folder nor a staged package ships it. *Open trigger 3*. The outcome says *Completed, without its flow*.
- **An extension failed to load** (gh-444c): one of the repository's own extensions threw while loading. *Open the base commit*, where it is fixed.
- **An MCP server did not connect** (gh-2f6a): *Open Connections*.
- **A host differs** (gh-ebd7): build3's overlay adds an extension the other hosts lack. *Open build3*.
- **Running** (gh-b3d7): shown when it ends, from its record.
- **No record** (gh-c3f8): an older release wrote it. **Refused** (gh-e9a0): nothing loaded.
- **In a sandbox,** What opens gains one row: what the run loaded, linked to it. A fresh sandbox says what its trigger would load on that host now.
- **On a trigger,** each run field the record covers gains *Its last run*: what the trigger asks for, beside what its last run had.

**Panels.** `p-loaded`, `p-loaded-sandbox`, `p-loaded-trigger`.

**The server provides.** The run record's new `loaded` field (RunLoaded). For a fresh sandbox, what the host's overlay and staged packages hold now, which the doctor record already carries. For a trigger, its last run's record.

**Who sees what.** As RunLoaded: viewers see the lines; the buttons are operator actions.

**Why it works this way.**
- **The problem goes where the next step is.** A missing flow is fixed on the trigger or in the repository, an MCP server in Connections, a host's overlay on its host page.
- **The outcome says it too,** so a run list read at a glance does not show a run that lacked its flow as plainly completed.
- **Shown when it ends.** The record is written from the exit line; a live line would need the worker to trust a second line during the run.

**Fixture note.** From the fixture: every run with its outcome and host (gh-8251-r2, gh-03a9 and gh-444c on mini2, gh-2f6a and gh-b3d7 on mini1, gh-ebd7 and gh-c3f8 on build3). Sample: trigger 2's removed bash and withheld packages, acme/api's missing fix skill and failed extension, linear as trigger 7's MCP server and its timeout, and build3's overlay extension git-guard (as on ProjectLoads).
""",
"ProjectLoads": """
The project page's **What its runs load**: what its runs had over the last 7 days, one line per kind, and a warning when runs of one project load different things on different hosts.

**How a person uses it.**
- **The top line** says what differs. Here build3's overlay adds git-guard, so the 18 runs of acme/billing on build3 load an extension the 6 on mini2 do not. *Open build3*.
- **One line per kind:** pi and image, models, extensions, flows and where each was found, MCP servers, and what was missing.
- **By host:** a table of each host's runs, the extensions they loaded and the flow.

**Panels.** `p-proj-loads`, beside ProjectDetail's panels.

**The server provides.** Nothing new beyond RunLoaded's `loaded` field: the page groups its runs' records by host.

**Who sees what.** As the rest of the project page.

**Why it works this way.**
- **A project spans hosts,** and each host has its own overlay and staged packages. A difference by host is the one thing no single run page shows.
- **From records, not configuration,** so it shows what happened, including after an Adopt that one host missed.

**Fixture note.** billing, its two repositories with 18 and 6 runs this week, build3 for acme/billing and mini2 for acme/billing-ui, and triggers 3 and 4 are as on ProjectDetail and in the fixture. Sample: git-guard in build3's overlay, and trigger 4's skills folder.
""",
}


if __name__ == "__main__":
    write("RunLoaded", card_marker("Runs", 1700, 1440, "A completed run’s Loaded card: pi and its image, the model, extensions, skills, MCP and tools, one line each"),
          "Run gh-9575, what it loaded", run_loaded_page(), RUN_STYLE + CSS)
    write("LoadedStates", card_marker("Runs", 1300, 1440, "The Loaded card’s top line run by run, and the same record in a sandbox and on a trigger"),
          "What each run loaded", states_page(), RUN_STYLE + CSS)
    write("ProjectLoads", card_marker("Configuration", 1100, 1440, "The project page’s What its runs load: one line per kind, and a warning when runs differ by host"),
          "billing, what its runs load", project_page(), CSS + PROJECT_CSS)
    for name, text in README.items():
        readme(name, text)
    print("loaded cards written")
