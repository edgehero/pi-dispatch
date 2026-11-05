"""What a trigger's jobs get, and changing it from the trigger page (#800 part 2).

The trigger page used to list each run field as the triggers file writes it, next to the deployment default, and most
of them were changed by hand in the file. Nothing resolved them: which staged packages "packages: load" means on each
host, whether the flow is found and where, which MCP servers the overlay defines, which tools stay on.

One card shows all of it as a job would get it, on every host the trigger runs on, and what a person can change is changed
in place: a switch for the staged packages, each extension and each MCP server, a chip for each tool, a picker for the model
and the flow. Nothing is written until one preview and one Confirm, made by a person: eight of those fields stay out of every
`dispatch_*` tool's reach (`TOOL_PROOF_FIELDS`), as today.

Two cards:
- TriggerEnvironment: the trigger page's What its jobs get, with two changes made and not yet written.
- TriggerEnvironmentChange: the preview and Confirm of those changes, what it refuses, and what a viewer sees."""
from pulse import *
from gen_config2 import code, COMMON_CSS, FILE


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


def state_line(tone, icon, text):
    return f'<span class="te-st tone-{tone}">{ic(icon, "ic ic--sm")}<span>{text}</span></span>'


# The console never reads this folder at runtime, so the rules it will paste must stand apart from the rules only the
# card's sample page needs. TRIGGER_GETS_CSS is what the console ships for these panels, and it names no c2- class:
# those rules live in gen_config2's COMMON_CSS and the console ships none of them, so a pasted panel would lose its
# layout on a page that looks fine here. TRIGGER_GETS_CARD_CSS is the sample page around the panels.
TRIGGER_GETS_CSS = """
.te-st { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--tone-ink); font-weight: 600; line-height: 18px; }
.te-st .ic { margin-top: 2px; }
.te-st > span { min-width: 0; }
.te-st .code, .te-sec .code, .te-list .code, .te-note .code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.te-list { display: grid; gap: 8px; }
.te-list > li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.te-list > li > .ic { margin-top: 1px; color: var(--tone-ink, var(--ink-muted)); }
.te-list b { color: var(--ink); font-weight: 650; }
.te-gap2 { margin-top: var(--space-3); }
.te-hosts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: var(--space-4); }
.te-hosts ~ .te-note { margin-bottom: var(--space-3); }
.te-host { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; min-height: 30px; max-width: 100%; padding: 4px 12px; border-radius: 15px; background: var(--surface-2); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.te-host b { font-weight: 650; font-family: var(--font-mono); min-width: 0; overflow-wrap: anywhere; }
.te-host .ic { flex: none; color: var(--ink-muted); }
.te-host--ok .ic { color: var(--ok-ink); }
.te-host--att { background: var(--attention-tint); }
.te-host--att .ic { color: var(--attention-ink); }
.te-sec { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 18px; padding: var(--space-4) 0; border-top: 1px solid var(--line); }
.te-sec__k { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; font-weight: 700; color: var(--ink); line-height: 20px; }
.te-sec__k .ic { flex: none; margin-top: 2px; color: var(--ink-muted); }
.te-sec__k small { display: block; font-weight: 500; font-size: 12px; color: var(--ink-muted); }
.te-sec__v { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
.te-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.te-grid .field { margin: 0; }
.te-last { font-size: 12.5px; line-height: 18px; color: var(--ink-muted); overflow-wrap: anywhere; }
/* A way to where a problem is fixed can name a host of 64 characters, and a button holds its label on one line. */
.te-last .btn { height: auto; min-height: 28px; max-width: 100%; margin-top: 6px; padding-top: 4px; padding-bottom: 4px; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.te-last .ic { vertical-align: -2px; margin-right: 4px; }
.te-items { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.te-item { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 2px 10px; align-items: start; padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13.5px; line-height: 20px; }
.te-item input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--ink); }
.te-item > span { min-width: 0; }
.te-item b { font-weight: 650; overflow-wrap: anywhere; }
.te-item small { display: block; font-size: 12px; line-height: 18px; color: var(--ink-muted); overflow-wrap: anywhere; }
.te-item .te-tag { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 6px; font-size: 12px; color: var(--ink-muted); max-width: 230px; }
.te-item .te-tag--att { display: inline-flex; align-items: flex-start; gap: 4px; color: var(--attention-ink); font-weight: 650; }
.te-item .te-tag--att .ic { flex: none; margin-top: 2px; color: var(--attention-ink); }
.te-item--locked { background: transparent; border: 1px dashed var(--line); }
.te-item--locked .ic { margin-top: 2px; color: var(--ink-muted); }
/* A read-only row draws no box, so it has no first column to leave empty. */
.te-item--ro { grid-template-columns: minmax(0, 1fr) auto; background: transparent; border: 1px dashed var(--line); }
.te-changed { box-shadow: inset 3px 0 0 var(--running); }
.te-pend { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--radius-pill); background: var(--running-tint); color: var(--running-ink); font-size: 11.5px; font-weight: 700; white-space: nowrap; }
.te-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.te-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; max-width: 100%; padding: 3px 10px 3px 8px; border-radius: var(--radius-pill); border: 1px solid var(--line); font-size: 12.5px; line-height: 18px; font-family: var(--font-mono); cursor: pointer; overflow-wrap: anywhere; }
.te-chip > span { min-width: 0; }
.te-chip--ro { padding-left: 10px; cursor: default; border-style: dashed; }
.te-chip--off { color: var(--ink-muted); text-decoration: line-through; }
.te-chip input { margin: 0; width: 14px; height: 14px; accent-color: var(--ink); }
.te-chip:has(input:checked) { background: var(--surface-2); border-color: transparent; }
.te-chip:has(input:not(:checked)) { color: var(--ink-muted); text-decoration: line-through; }
.te-chip:has(input:disabled) { cursor: not-allowed; border-style: dashed; }
.te-sub { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin-bottom: 4px; }
.te-read { font-size: 13.5px; line-height: 20px; overflow-wrap: anywhere; }
/* Its fieldset wraps every row, and a fieldset's default minimum width would hold the card wider than a phone. */
.te-form fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.te-sec__v > div { min-width: 0; }
.te-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-top: var(--space-2); padding: 12px 14px; border-radius: var(--radius-md); background: var(--running-tint); font-size: 13.5px; }
.te-bar b { font-weight: 700; }
.te-bar .te-bar__t { flex: 1 1 260px; min-width: 0; }
.te-bar .te-bar__t small { display: block; margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.te-bar .te-bar__a { display: flex; gap: 8px; flex-wrap: wrap; }
.te-note { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.te-note .ic { flex: none; margin-top: 2px; }
.te-note b { color: var(--ink); font-weight: 650; }
.te-note.tone-attention .ic { color: var(--attention-ink); }
/* The bundle keeps a diff on one line and scrolls it inside its box, so on a phone a key this card adds leaves the view. */
.te-diff .diff__b > span { white-space: pre-wrap; overflow-wrap: anywhere; }
.te-widen { display: inline-flex; vertical-align: -2px; margin-right: 4px; color: var(--attention-ink); }
.te-ro .te-item { grid-template-columns: minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .te-sec { grid-template-columns: minmax(0, 1fr); }
  .te-grid { grid-template-columns: minmax(0, 1fr); }
  .te-item { grid-template-columns: 20px minmax(0, 1fr); }
  .te-item .te-tag { grid-column: 2; justify-content: flex-start; max-width: none; }
  .te-item--ro { grid-template-columns: minmax(0, 1fr); }
  .te-item--ro .te-tag { grid-column: 1; }
}
"""

TRIGGER_GETS_CARD_CSS = """
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.te-lead { display: flex; gap: 8px; align-items: flex-start; margin-bottom: var(--space-4); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.te-lead .ic { flex: none; margin-top: 2px; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
"""

CSS = COMMON_CSS + TRIGGER_GETS_CSS + TRIGGER_GETS_CARD_CSS

TRIGGER_SUB = (f'<span class="c2-lead"><span class="c2-kind">{ic("comment", "ic ic--sm")}comment</span><span class="code">"@pi"</span>'
               f'<span class="muted">→ flow</span><b>fix</b><span class="muted">on github · row 3</span></span>')


def sec(icon, title, hint, body, last=""):
    lst = f'<p class="te-last">{ic("chain", "ic ic--sm")}{last}</p>' if last else ""
    return (f'<div class="te-sec"><p class="te-sec__k">{ic(icon, "ic ic--sm")}<span>{title}<small>{hint}</small></span></p>'
            f'<div class="te-sec__v">{body}{lst}</div></div>')


def item(on, name, sub, tag="", changed=False, locked=False, lacks=False):
    """`lacks`: a host this server is missing from, so the tag warns before anyone reaches the preview."""
    cls = "te-item" + (" te-item--locked" if locked else "") + (" te-changed" if changed else "")
    box = ic("key", "ic ic--sm") if locked else f'<input type="checkbox"{" checked" if on else ""} aria-label="{E(name)}">'
    pend = '<span class="te-pend">changed</span>' if changed else ""
    where = f'<span class="te-tag--att">{ic("attention", "ic ic--sm")}<span>{tag}</span></span>' if lacks else tag
    return f'<label class="{cls}">{box}<span><b>{name}</b><small>{sub}</small></span><span class="te-tag">{pend}{where}</span></label>'


def chip(name, on=True, disabled=False):
    return f'<label class="te-chip"><input type="checkbox"{" checked" if on else ""}{" disabled" if disabled else ""}>{E(name)}</label>'


# ---------------------------------------------------------------- TriggerEnvironment: the card, two changes made
def gets_card():
    # mini2 is the sample deployment's host with no doctor result (Fleet, Overview), so it draws the state a host with no
    # publication must read. "The same" would claim a host matches on the strength of nothing.
    # "The same" needs two hosts that can say and agree. mini1 goes without what build3 has, so it says that, and not "the same".
    hosts = (f'<div class="te-hosts" aria-label="Where its jobs run">'
             f'<span class="te-host te-host--att">{ic("attention", "ic ic--sm")}<b>mini1</b> without git-guard</span>'
             f'<span class="te-host">{ic("minus", "ic ic--sm")}<b>mini2</b> unknown</span>'
             f'<span class="te-host te-host--att">{ic("attention", "ic ic--sm")}<b>build3</b> also git-guard, from its overlay</span></div>'
             f'<p class="te-note">{ic("doctor", "ic ic--sm")}<span>What each host’s last doctor run published: build3 at 2026-10-05 15:39 UTC, mini1 at 2026-10-08 14:39 UTC. mini2 has published none, so it reads unknown, never the same. The repository’s part is decided at its base commit.</span></p>'
             f'<p class="te-note">{ic("chain", "ic ic--sm")}<span>The rows say what the next job gets, from the triggers file. Under each is what gh-9575, its newest run that says what it loaded, had on mini1. The last it started, gh-e9a0: Nothing loaded: it was refused before its container started.</span></p>')

    # Each field is typed or picked from a list, because a forge's repository is not on a host and a model the overlay declares is not in
    # the catalog: the preview judges what is typed, and a blank field that held a value removes the key.
    model = sec("bolt", "Model", "what its jobs call", f"""<div class="te-grid">
  <div class="field"><label for="te-provider">Provider</label><input id="te-provider" class="input" value=""><p class="field__hint">Blank uses the deployment’s, anthropic.</p></div>
  <div class="field"><label for="te-m">Model</label><input id="te-m" class="input" value=""><p class="field__hint">Blank uses the deployment’s, claude-sonnet-5-5.</p></div>
  <div class="field"><label for="te-cap">Job cap, in dollars</label><input id="te-cap" class="input" value=""><p class="field__hint">Blank uses the deployment’s $2; a trigger can only lower it.</p></div>
</div>
<div><p class="te-sub">Allowed models</p><p class="te-note">Any model is allowed.</p><div class="field"><label for="te-ma">Limit to a list</label><input id="te-ma" class="input" placeholder="provider/model, separated by spaces"></div></div>
<div><p class="te-sub">If it is rate limited</p><p class="te-note">No fallback.</p><div class="field"><label for="te-fa">Add a fallback</label><input id="te-fa" class="input" placeholder="provider/model, separated by spaces"></div></div>""",
        "Last run on mini1, gh-9575: anthropic / claude-sonnet-5-5; 14 calls.")

    flow = sec("skill", "Flow and skills", "what it is told to do", f"""<div class="field"><label for="te-f">Flow</label><input id="te-f" class="input" value="fix"><p class="field__hint">Pick a skill a job can find, or name one the repository holds.</p></div>
<p class="te-note">{ic("doctor", "ic ic--sm")}<span><b>Doctor’s answer:</b> build3 and mini1 find fix in no tier a host can see; mini2 has no answer to read. A forge’s repository is not on a host, so for that tier read the last run.</span></p>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Skills folder (<span class="code">run.skillsDir</span>): none, a folder on each host, set in the file.</span></p>""",
        "Last run on mini1, gh-9575: fix, the flow, from the repository; and 3 more: 2 from the repository, 1 from pi-test-runner.")

    ext = sec("layers", "Extensions", "code its jobs load", f"""<div class="te-items">
  {item(True, "Staged packages", 'Off writes "packages": false, and none load, nor their tools, skills, prompt templates or themes.')}
  {item(True, "pi-lint 1.4.2", "staged on build3 and mini1, unknown on mini2 · 2 tools, 1 prompt template, as gh-9575 loaded it")}
  {item(True, "pi-test-runner 0.9.0", "staged on build3 and mini1, unknown on mini2 · 3 tools, 1 skill, as gh-9575 loaded it")}
  {item(True, "git-guard", "in the overlay on build3, not on mini1, unknown on mini2")}
  {item(True, "The repository’s own", ".pi/extensions at the base commit, merge-gated. Changed in the repository, not here.", locked=True)}
</div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Off leaves it out of these jobs by name: a staged package with its tools, skills, prompt templates and themes, an overlay extension before its code runs. A host without that name loads nothing for it. A new extension, or another version, is staged first, for every trigger. <a class="link" href="#">Open Updates</a></span></p>""",
        "Last run on mini1, gh-9575: pi-lint 1.4.2, pi-test-runner 0.9.0; staged on mini1.")

    mcp = sec("plug", "MCP servers", "outside systems it reaches", f"""<div class="te-items">
  {item(True, "linear", "http · mcp.example.com · codemode · uses LINEAR_API_KEY by name", tag="build3 and mini1; unknown on mini2", changed=True)}
  {item(False, "docs", "stdio · docs-mcp · deferred", tag="off on mini1; not on build3; unknown on mini2", lacks=True)}
</div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>A job on a host without a server it names, or with it off, is refused as <span class="code">mcp-server-unknown</span>, before it spends; a host with no overlay or no <span class="code">mcp.json</span> refuses it as <span class="code">mcp-config-invalid</span>. A key a server uses must reach the job, through <span class="code">run.secrets</span> in the file or a host’s <span class="code">PI_FORWARD_ENV</span>, or the job is refused as <span class="code">mcp-secret-unmapped</span>. <a class="link" href="#">Open Connections</a></span></p>""", "Last run on mini1, gh-9575: none; it named no server.")

    # The bar's second change is drawn here: bash off, so the chip reads as a person just left it.
    own = "".join(chip(t, on=(t != "bash")) for t in ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"])
    tools = sec("flows", "Tools", "what the agent may use", f"""<div><p class="te-sub">pi’s own</p><div class="te-chips">{own}</div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>On means not removed. powershell, grep, find and ls stay off unless an extension turns them on, so a trigger can remove them too.</span></p>
<div><p class="te-sub">From pi-lint, as gh-9575 loaded it on mini1</p><div class="te-chips">{chip("lint_file")}{chip("lint_fix")}</div></div>
<div><p class="te-sub">From pi-test-runner, as gh-9575 loaded it on mini1</p><div class="te-chips">{chip("run_tests")}{chip("test_report")}{chip("test_coverage")}</div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Off removes that tool from these jobs by name, on whichever host brings it. A chip comes from what a run recorded or what the file names, since no host publishes a tool’s name. A repository’s tools stay a count, so they have no chip here.</span></p>
<p class="te-note">{ic("info", "ic ic--sm")}<span>A server’s tools are offered once this trigger names it: turn it on and confirm first.</span></p>
<div><p class="te-sub">The job’s own</p><div class="te-chips"><span class="te-chip te-chip--ro">report_progress</span></div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>report_progress comes with run.progress, in the Edit form: no list removes it.</span></p>""",
        "Last run on mini1, gh-9575: 10 active; read, bash, edit and write, 5 from the extensions, and report_progress, the job’s own; none removed.")

    rest = sec("box", "Image and secrets", "set elsewhere", f"""<p class="te-read"><span class="code">pi-job:4.3.1 with pi 1.5.0</span> on mini1, mini2 and build3</p>
<p class="te-read">Secrets: none named on this trigger; a job also gets its project’s bundle, if it has one. <a class="link" href="#">Open Secrets</a></p>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Set elsewhere: the image in each host’s environment or run.image in the file, secrets on the Secrets page, and the skills folder (run.skillsDir) in the file.</span></p>""",
        "Last run on mini1, gh-9575: pi 1.5.0 in pi-job:4.3.1; image sha256:7c1e0b4…, as mini1 ran it.")

    bar = (f'<div class="te-bar" role="status"><span class="te-bar__t"><b>2 changes, not written yet:</b> linear on, bash off.<small>A Confirm elsewhere on this page reloads it, and drops any change not yet written in What its jobs get.</small></span>'
           f'<span class="te-bar__a">{btn("Preview the change", "primary", sm=False)}{btn("Discard", "", sm=False)}</span></div>')
    body = hosts + model + flow + ext + mcp + tools + rest + bar
    return card("What its jobs get", body, sub="as a job of trigger 3 would start, from each host’s last doctor run", id_="p-trigger-gets")


def how_card():
    body = f"""<ul class="te-list">
  <li>{ic('edit')}<span><b>Change it in place.</b> A switch for the staged packages, each extension and each MCP server, a chip for each tool, a picker for the model and the flow.</span></li>
  <li>{ic('skill')}<span><b>The flow picker is not the whole list.</b> It leaves out what is in a skills folder, or in a repository not on this host, and any other name can be typed.</span></li>
  <li>{ic('eye')}<span><b>Nothing is written</b> until you preview the change and confirm it.</span></li>
  <li>{ic('shield')}<span><b>A person, at the console.</b> No tool reaches this action; <span class="code">dispatch_trigger_edit</span> keeps today’s scope.</span></li>
  <li>{ic('rerun')}<span><b>Undo</b> puts back the keys the change touched, as they were. Where this page could not write them, the preview says so.</span></li>
</ul>"""
    return card("How a change applies", body, id_="p-trigger-gets-how")


def states_card():
    """The rows in the states trigger 3 is not in today."""
    body = f"""<div class="te-sec__v">
  <div><p class="te-sub">Allowed models, as a list</p><div class="te-chips">{chip("anthropic/claude-sonnet-5-5")}{chip("kimi-coding/kimi-for-coding")}</div></div>
  <div><p class="te-sub">A fallback, if it is rate limited</p><div class="te-chips">{chip("kimi-coding/kimi-for-coding")}</div></div>
  <div class="te-ro"><div class="te-items">
    <div class="te-item"><span><b>Staged packages off</b><small>The file says "packages": false, so these jobs load none of them, nor their tools, skills, prompt templates or themes. Each staged package is off with them, so it has no switch of its own: turn them on and confirm first.</small></span></div>
    <div class="te-item"><span><b>One extension left out</b><small>Its switch off, and in the bar as pi-lint left out. Its tools leave the Tools row, and on the pills it is no difference between hosts.</small></span></div>
    <div class="te-item"><span><b>A name in the file no host shows</b><small>It keeps a row and a switch, off, so it can be turned back on: named in the file; not on build3 and mini1, unknown on mini2.</small></span></div>
    <div class="te-item"><span><b>A tool the file removes</b><small>No later run names it, so it stays a chip under Also in the file, off, and can be turned back on.</small></span></div>
    <div class="te-item"><span><b>No run in the history</b><small>A new trigger, or one whose runs have aged out, has no record to quote. Under each row: No run in the available history. The hosts and each row’s control read the same.</small></span></div>
    <div class="te-item"><span><b>Its flow found nowhere</b><small>Last run on mini2, gh-03a9: Ran without its flow. pi found no skill named fix: not in acme/api at its base commit, nor in a skills folder, the overlay or a staged package.</small></span></div>
    <div class="te-item"><span><b>A schedule whose repository lacks its flow</b><small>Before any run: its pill says its flow in no tier, and under the flow, As doctor last read it, a job on mini1 would not find fix: it is not at the repository’s HEAD, nor in any other tier this trigger loads from.</small></span></div>
  </div></div>
</div>"""
    return card("The same rows, in other states", body, id_="p-trigger-gets-states")


def environment_page():
    lead = (f'<p class="te-lead">{ic("info", "ic ic--sm")}<span>A new card on the trigger page, above What it runs. '
            f'What it runs loses the fields this card sets from By hand, and the Edit form stops offering flow, provider and model, so no key has two editors. The rest of TriggerDetail is unchanged.</span></p>')
    side = f'<div class="stack">{how_card()}{states_card()}</div>'
    inner = lead + f'<div class="cols"><div class="stack">{gets_card()}</div>{side}</div>'
    end = btn("Open in Runs", "", "runs", sm=False)
    return shell("Triggers", inner, "Trigger 3", sub=TRIGGER_SUB, end=end, back="Triggers")


# ---------------------------------------------------------------- TriggerEnvironmentChange: preview, refusals, viewer
def preview_card():
    # The planner spreads a new key after the row's own (`{ ...tr.run, ...fields }`), so these land at the end of `run`, and the line before
    # them gains a comma, which a line diff shows as changed. An array is three lines: the writer and the console's diff both go through
    # JSON.stringify(..., 2) (triggers-file.mjs, confirm-view.mjs). A file at version 1 stays there: neither key needs another.
    d = diff("triggers.json", [("gap", "…"), ("ctx", '        "progress": true,'), ("ctx", '        "statusComment": true,'),
                               ("del", '        "resume": true'),
                               ("add", '        "resume": true,'),
                               ("add", '        "mcp": ['), ("add", '          "linear"'), ("add", '        ],'),
                               ("add", '        "excludeTools": ['), ("add", '          "bash"'), ("add", '        ]'),
                               ("ctx", '      }'), ("ctx", '    }'), ("gap", "…")])
    # The console has no ring for a widening. `previewBarHtml` draws plain, paid or destructive, and a widening with an
    # Undo is plain today (a setting on a cap, trigger-add); limit-delete widens too and is danger, for having no way back. Paid
    # would promise a reservation this does not make and this change has its Undo, so the plain ring stays and the line says it.
    c = confirm("safe", "Change trigger row 3",
                ["<b>MCP: linear on.</b>",
                 f"This widens what its jobs reach: a job that reaches its container connects to mcp.example.com, with LINEAR_API_KEY by name.",
                 "<b>Tools: bash off.</b>",
                 "The services reading this file use it from their next reload, for the jobs they queue after that.",
                 "A job already in line keeps what it was queued with and runs without this change, unless it is named below as refused. A running job is not touched.",
                 "A host with its own copy of this file keeps what it has until that copy changes.",
                 f"With this change, a host reading this file refuses 1 of this trigger’s jobs in line, before it spends: <a class=\"link code\" href=\"#\">gh-c9e1</a> as <span class=\"code\">trigger-skew</span> (run.mcp).",
                 "A job on a host without linear, or with it off, is refused as <span class=\"code\">mcp-server-unknown</span>, before it spends; a host with no overlay or no <span class=\"code\">mcp.json</span> refuses it as <span class=\"code\">mcp-config-invalid</span>. build3 and mini1 have it; mini2 reads unknown.",
                 f"Written to triggers.json on this host and audited as <b>trigger-edit</b>, by ops at the console."],
                "Put trigger row 3 back as it was", "Confirm: change trigger row 3")
    return card("Preview", f'<div class="te-diff">{d}</div><div class="te-gap2">{c}</div>', sub="2 changes to trigger row 3", id_="p-trigger-gets-preview")


def refuses_card():
    body = f"""<ul class="te-list">
  <li class="tone-attention">{ic('attention')}<span><b>docs is off on mini1, not on build3, and mini2 is unknown.</b> Turning it on would refuse trigger 3’s jobs on a host without it, or with it off, as <span class="code">mcp-server-unknown</span>, and on a host with no overlay or no <span class="code">mcp.json</span> as <span class="code">mcp-config-invalid</span>, before they spend. The switch says so before you preview.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A main model that cannot make one call under the cap.</b> anthropic/claude-opus-5-5 needs at least $2.654295 for a short task’s first call, above the deployment’s $2.00 job cap, so the runner would refuse every call to it before it is sent. A trigger can only lower the deployment’s job cap: choose another model. The deployment’s own cap belongs to its settings, not to this page.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>A cap that clears the floor but not a short task.</b> It previews, and says so: anthropic/claude-opus-5-5 clears this $2.62144 job cap only for the smallest first call: a short task’s needs $2.654295, so most jobs that call it would be refused before they spend. Choose another model, or a job cap of at least $2.654295; a repository’s context files and a longer task need more.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>A server whose key this host does not hold.</b> It previews, warns, and can still be confirmed, since another host may hold it: On this host this trigger’s jobs would be refused as <span class="code">mcp-secret-unmapped</span>, before they spend. <span class="code">run.secrets</span> is set in the triggers file, not on this page. This reads this host’s .env and overlay; what the worker’s own service environment sets cannot be seen from here.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>A hand-written file.</b> It previews, and says so: This file is not in the writer’s layout, so this write also rewrites all of it: spacing and line breaks move in lines this change does not touch, and what each key says does not. Undo puts the values back, not that layout.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A job cap above the deployment’s.</b> A trigger’s job cap can only lower the deployment’s, and a value above <span class="code">PI_MAX_COST_USD</span> refuses the whole file when a worker loads it.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>This trigger changed since the page drew it.</b> Nothing was changed. Reload the page and make the change again: nothing is written over an edit you have not seen.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A host on an older release.</b> Either exclusion needs the file at version 2 and job data at version 3, so it is refused while a live host reads less, publishes no version, or cannot be read. One that reads less would hold every job this file touches. One that publishes no version drops a key it does not know, which for a narrowing runs its jobs wider on a clean record. The preview says when it stamps the file, and when a change takes the stamp off.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A name on no host.</b> No live host holds pi-linter, as each one’s last doctor run published it, so leaving it out would keep nothing out. Check the name, or run pi-dispatch doctor on the host that has it. Where a host cannot say, the preview warns instead.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>A tool chip off.</b> It previews, and says what a job does if no staged package or overlay extension brought the name: A job that reaches its container with nothing held back from it, no parent job and every extension loaded stops before its prompt as <span class="code">exclude-tool-not-loaded</span> if no staged package or overlay extension registered lint_file when it loaded. On a trigger that holds extensions back it says instead that the job runs, and its log and record name it.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>A package a job needs.</b> It previews, and says so: a flow doctor found only in that package, a subscription connection’s adapter (<span class="code">auth-adapter-disabled</span>), a schedule’s canary of that package (<span class="code">package-canary-excluded</span>).</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>Every way to a server removed.</b> On every host this trigger’s jobs would be refused as <span class="code">mcp-excluded</span>, before they spend. Remove the server from <span class="code">run.mcp</span>, or keep a tool that reaches it out of <span class="code">run.excludeTools</span>. Where only this host’s overlay leaves it no way in, the preview warns instead: another host’s overlay may route it another way.</span></li>
  <li>{ic('key')}<span><b>Not here, by design:</b> the repository’s own extensions (change the repository), a new extension or version (Updates), secrets (Secrets), the image (each host’s env, or the file) and the skills folder (the file).</span></li>
</ul>"""
    return card("What it refuses, and why", body, id_="p-trigger-gets-refuses")


def viewer_card():
    body = f"""<div class="te-ro"><div class="te-items">
  <div class="te-item"><span><b>Model</b><small>the deployment’s model, anthropic / claude-sonnet-5-5 · any model allowed · no fallback · the deployment’s $2 cap</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Flow and skills</b><small>fix</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Extensions</b><small>Staged packages: on; pi-lint 1.4.2: on, pi-test-runner 0.9.0: on; git-guard: on, in the overlay on build3</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>MCP servers</b><small>linear: off; docs: off</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Tools</b><small>each chip as a word, a removed one struck through</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Image and secrets</b><small>pi-job:4.3.1 with pi 1.5.0 on mini1, mini2 and build3; none named on this trigger</small></span><span class="te-tag"></span></div>
</div></div>
<p class="te-note te-gap2">{ic("eye", "ic ic--sm")}<span>A viewer reads the same six rows and the last run under each, with no switches or pickers, and the page holds no digest of the entry.</span></p>"""
    return card("As a viewer sees it", body, id_="p-trigger-gets-viewer")


def change_page():
    inner = f'<div class="cols"><div class="stack">{preview_card()}</div><div class="stack">{refuses_card()}{viewer_card()}</div></div>'
    return shell("Triggers", inner, "Trigger row 3, the change", sub=TRIGGER_SUB, back="Trigger 3")


# ---------------------------------------------------------------- READMEs
README = {
"TriggerEnvironment": f"""
The trigger page's **What its jobs get**: what a job of this trigger would start with on each host it runs on, as each host's last doctor run published it, and each part a person can change, changed in place. Before it, the page listed each run field as written, beside the deployment default, and most were changed by hand in the triggers file.

**How a person uses it.**
- **The hosts** come first: one pill per host the trigger runs on, saying whether its jobs get the same there. Here build3's overlay adds git-guard, mini1 goes without it, and mini2 has published no doctor run, so it reads unknown, never the same. "The same" needs two hosts that can say and agree on everything the rows beneath say: what `hostsAgree` compares of what reaches this trigger, and the image and its pi. A host alone on the live list reads *the only host*, or *the only one known* beside silent ones or where no live host is listed, and one with no answer for the flow says so. A host whose doctor found the flow nowhere says so too, however many hosts agree with it.
- **One row per kind,** each with its control and, under it, what its last run on one host that said what it loaded had (part 1's record), naming the host because hosts differ. Here that is mini1. Triggers names gh-e9a0 as trigger 3's last, and it was refused before its container started, so the card says why it quotes gh-9575:
  - **Model:** the provider and the model, each typed or picked from the catalog's priced models for the providers in use, because a model the overlay declares is not in the catalog and the preview judges what is typed; the job cap, which a trigger can only lower: `effectiveCostCapMicros` takes the smaller, and a value above `PI_MAX_COST_USD` refuses the file; the allowed models and the fallbacks.
  - **Flow and skills:** a skill typed or picked from what a job can find (the repository's where it is on this host, the overlay's, a staged package's; a skills folder is on each host and no read lists it, so the picker says it is not the whole list), and doctor's answer on each host. A forge's repository is not on a host, so doctor cannot answer for that tier, and the card says so. Where doctor found the flow nowhere, at the repository's HEAD or in any other tier the trigger loads from, the row warns before any run has paid to show it. A run that went without its flow says so under the row, from its record, and a record cut short says that at the top.
  - **Extensions:** the all-off switch for staged packages (`"packages": false`), then a switch per name for each staged package and overlay extension (`run.excludeExtensions`), saying where each is and what the last run had of it, read from what the hosts published. One a host lacks says so, and a name in the file no host shows keeps its row, so it can be turned back on. Two names in the file that mean one entry (`git-guard` and `git-guard.ts`) are a row each, and each says the file also names the other. Under `"packages": false` a package's switch is moot, and the row says so. The repository's own are shown too, as a count: they are merge-gated content, changed in the repository.
  - **MCP servers:** a switch per server a host publishes or the trigger names, with its transport, where it is, its exposure and the key it uses by name, and each host: which have it, which do not, in warning tone, and which are unknown. The pills compare what these jobs get, so a server the trigger does not name is on no pill, and its row says when turning it on would differ by host.
  - **Tools:** a chip per tool of pi's own, and for a server the trigger names, `mcp__<server>__*` as a whole and the five `MCP_EXCLUDABLE_TOOL_NAMES`. On means not removed. No host publishes a tool's name, so each staged or overlay extension's tools are chips as a run loaded them, by its id and host (`run.excludeExtensionTools`), and not there once the file withholds what they came with; a name the file holds that no chip offers stays under Also in the file. A repository's stay a count. `report_progress` is shown where the file sets `run.progress`, which brings it, and no list removes it.
  - **Image and secrets:** shown, each host's image and pi with the `PI_JOB_IMAGE` they come from, and changed where they are today (the host's env or `run.image` in the file, the Secrets page).
- **The same rows, in other states** (`p-trigger-gets-states`): allowed models and a fallback set, staged packages off, one extension left out, a name in the file no host shows, a tool the file removes, a trigger with no run in the history, a run that went without its flow, and a schedule whose repository lacks its flow, before any run has paid to show it.
- **Changes collect** in one bar (*2 changes, not written yet*) with **Preview the change** and **Discard**, a form's own reset. TriggerEnvironmentChange draws the preview, and any move of a control closes it, because its Confirm no longer says what the form says. The bar says a Confirm elsewhere on the page reloads it and drops these.

**Panels.** `p-trigger-gets`, `p-trigger-gets-how`, `p-trigger-gets-states`, beside TriggerDetail's panels.

**The server provides.**
- **The file:** the trigger's fields, read once with the digest of that entry, so what the person saw and what the stale check compares are one read; and the deployment defaults; the overlay's MCP servers (Connections); the catalog's priced models.
- **From part 1:** the last run's record, for what loaded and the names of each extension's tools.
- **For each host:** What the host's last doctor run published, with its time, or unknown. The repository's part is decided at its base commit. The publication is a new key, `doctor:loads:<name>`, holding overlay extensions and skills, staged packages, each trigger's flow tier, and each MCP server with its `enabled` state, which is what *off* reads: an ok doctor check publishes only its id and level, so the answer is not there to read. Each host's image and pi's version are not in it: they come from what every live host already publishes, `host:h:<name>` (`image`, `imageDigest`, `piVersion`, `INT-HOST-REGISTRY-CONTRACT`), so that row knows mini2 while the publication's rows do not, and a host whose row has expired reads unknown there too.
- **A person-only write** through the trigger edit's planner: eight of a trigger's fields (`run.maxCostUsd`, `run.models`, `run.fallbackModels`, `run.mcp`, `run.excludeTools`, `run.packages`, `run.excludeExtensions`, `run.excludeExtensionTools`) stay out of every `dispatch_*` tool's reach. That is what "no tool" means here: `dispatch_trigger_edit` still sets flow, provider and model, and `dispatch_set` can still set the deployment's own dollar caps, each behind a Confirm (`admin/src/action-policy.mjs`).
- **On TriggerDetail,** the card's fields leave *By hand* and the Edit form stops offering flow, provider and model, so no key has two editors. Image, secrets, the skills folder and the rest stay where they are.

**Who sees what.** An operator changes it. A viewer reads the rows without controls, and the page holds no digest of the entry (TriggerEnvironmentChange). A watch rule's job loads nothing a host publishes and takes no form, so its card reads less: no pills, its model and flow, one sentence for what it can use, and its image. A rule that only files an issue starts no agent and no container, and says that. A file the worker's own parser refuses keeps the form, so the row can be fixed, and every pill reads unknown. No tool reaches this action; `dispatch_trigger_edit` keeps today's scope. An agent's page draws no card, so it keeps these fields as read-only facts in What it runs, each as its read holds it: a name that read withholds, a server's among them, is said to be withheld and never shown.

**Why it works this way.**
- **What a job gets, not what the file says.** "packages: load" means different things on different hosts, and a package the file leaves out by name is no part of what a job gets on any; the card says which.
- **The file says what the next job gets, and a record says what that run had.** A word from one never reads as the other: under a row the record's words are past, by its id and host.
- **Unknown, never the same.** A host with no publication, one too old or too new to read, or one whose list of what matters here is cut, proves nothing, so its pill does not say it matches. A host whose worker publishes that it reads less of the triggers file than the file says holds this file's jobs, and its pill and the note under the pills say so; on such a file, one that publishes no version reads unknown. The same goes for each row the publication answers: a staged package or a server reads unknown on mini2, never "every host".
- **A blank field removes a key; an untouched one is not sent.** Keys that are not sent keep their values and their places. On a hand-written file a first write also puts the whole file in the writer's layout, and the preview says so.
- **One preview for every change,** so a widening (an MCP server and its key) and its side effects (a job in line refused as `trigger-skew`) are read before anything is written. No money or policy is worked out in the browser.
- **The last run under each row,** so a setting and what it did sit together.

**Fixture note.** Trigger 3, its hosts, gh-9575, gh-e9a0, gh-03a9 and the model are the fixture, with gh-9575's tools counted as on RunLoaded. gh-a91e is trigger 3's too and ended later, at 15:25, on mini2: the card quotes mini1's last run, and TriggerDetail's list leaves gh-a91e out. mini1's doctor run 1h ago, build3's 3 days ago and none from mini2 are as on Fleet. linear and docs are Connections' MCP servers, docs off there as it is here, and pi-lint and pi-test-runner its staged packages. Sample: git-guard in build3's overlay (as on ProjectLoads), the extension tools' names, pi-linter, docs off on mini1 and absent from build3, the listed models and fallback, and pi 1.5.0 in pi-job:4.3.1, a pairing that is sample only: tag 4.3.1 pins pi 1.2.0. Fleet draws mini1 with one warning and build3 with one, and neither is doctor's warning for a flow in no tier, which this card's answer implies, and HostDetail's registry row draws an older sample of the image and pi: the sample does not join those.
""",
"TriggerEnvironmentChange": f"""
The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, then the Confirm:
  - each change in words, never an arrow, a widening said as one (*a job that reaches its container connects to mcp.example.com, with LINEAR_API_KEY by name*);
  - when it takes effect, each only as far as is true of this file on this host: the services reading this file use it from their next reload, for the jobs they queue after that; a job in line keeps what it was queued with and runs without this change, unless it is named as refused; a host with its own copy keeps what it has until that copy changes. On a schedule: *While hosts' copies differ on a schedule, no host installs a change to one, so this one moves when they agree.*
  - the jobs it affects: *With this change, a host reading this file refuses 1 of this trigger's jobs in line, before it spends: gh-c9e1 as trigger-skew (run.mcp)*;
  - what a host without the server does: refuses the job as `mcp-server-unknown`, before it spends. A host with no overlay, or no `mcp.json`, refuses it as `mcp-config-invalid`;
  - where it is written and how it is audited (`trigger-edit`, by the person): *on this host*, because that file is all this page writes.
  - **Undo** puts back the keys the change touched, as they were, or says what to edit by hand where this page could not write them. It says "as it was" only where it writes the very bytes it found: the writer owns a file's layout and its stamp, and a hand-placed stamp comes back first.
- **What it refuses, and why:** a main model that cannot make one call under the cap, a cap above the deployment's, a trigger that changed since the page drew it, every way in to a server removed by the file alone (`mcp-excluded`), a live host that cannot read the file's version, a name in `run.excludeExtensions` every live host answers for and none holds, and what belongs elsewhere. A name a host cannot say of, a name in `run.excludeExtensionTools`, and a package a flow, a subscription or a canary needs, each preview and warn. So does the first list a job would carry: an image that does not declare `loadExclusions` refuses it, free, and no host publishes that label here, so it is said of no host in particular. A server some hosts lack is said on the switch, and previews. A listed or fallback model that cannot make one call under the cap previews and warns. A server this host's pickup check would refuse (its key not passed as `mcp-secret-unmapped`, a route only this host's overlay cuts) previews, warns, and can still be confirmed. A cap that clears the floor and not a short task's first call previews, and says so.
- **As a viewer sees it:** the same six rows as the operator's, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's body and Confirm, widened to the card's fields for a person only. A digest of the trigger's entry as the page read it is sent back and compared at preview, because the Confirm's own snapshot covers only preview to Confirm, and that is what refuses a stale page. Of the entry and not the file, so an edit of another trigger sends nobody back. The versions each live host publishes (#761, `INT-HOST-REGISTRY-CONTRACT`), read only when the file would need more than version 1. What each live host published of its packages and overlay (`doctor:loads:<name>`), and the tool names a past run of this trigger recorded. Each model's first-call bound.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` are the operator's to write. A person at the console is the operator; a model's call is not. This holds of those eight and this action: `dispatch_set` and `dispatch_trigger_edit` still move a job's spend behind a confirm.
- **Refuse what the file decides and what would cost more later, and warn of the rest.** A first call above the cap refuses later, inside a paid container (`image/runner/src/usage-meter.mjs`), and a cap above the deployment's refuses the whole file at the loader, so the preview refuses both first. For an edit of the servers or the exclusions it runs the worker's own pickup check, with what this host holds (`makeMcpCheck`), and speaks only of what the edit touches. What depends on this host is a warning, in the worker's own reason, and the person can still Confirm: another host may run the job, and pickup's own refusal is free and names its reason. What a job connects to is said of a job that reaches its container, so it holds beside any warning.
- **The cap's refusal says who can move it.** A trigger's `run.maxCostUsd` only lowers the deployment's cap, so the sentence names the deployment's settings as the place, and offers no way to do it here. It says *needs at least*, because the bound is a lower one.
- **The plain ring on a widening.** The console's Confirm is plain, paid or destructive (`previewBarHtml`), and it has no ring for a widening: a setting on a cap is plain today, and deleting a limit is destructive for having no way back. This change has its Undo, so the widening is said in words, on a line of its own.

**Fixture note.** Trigger 3, gh-c9e1 (its one job in line, as on TriggerDetail), the hosts and the cap are the fixture. $2.654295 is `firstCallBoundMicros` at `FIRST_CALL_SHORT_TASK_BYTES` for anthropic / claude-opus-5-5 at the pinned pi 1.5.0, the amount a refusal offers. $2.62144 is `firstCallFloorMicros` for the same model, which decides a refusal: a cap at it admits a request no job sends. The diff draws each array as three lines, as `JSON.stringify` writes them, and its lines are the golden's. The rest as on TriggerEnvironment.
""",
}


if __name__ == "__main__":
    write("TriggerEnvironment", card_marker("Triggers", 2000, 1440, "What a trigger’s jobs get on each host, changed in place: model, flow and skills, staged packages, MCP servers and tools"),
          "Trigger 3, what its jobs get", environment_page(), CSS)
    write("TriggerEnvironmentChange", card_marker("Triggers", 1200, 1440, "The preview and Confirm of that change, what it refuses and why, and the viewer’s read-only rows"),
          "Trigger 3, the change", change_page(), CSS)
    for name, text in README.items():
        readme(name, text)
    print("trigger environment cards written")
