"""What a trigger's jobs get, and changing it from the trigger page (proposed, #800 part 2).

Today the trigger page lists each run field as the triggers file writes it, next to the deployment default, and most
of them are changed by hand in the file. Nothing resolves them: which staged packages "packages: load" means on each
host, whether the flow is found and where, which MCP servers the overlay defines, which tools stay on.

One card shows all of it as a job would get it, on every host the trigger runs on, and every row is changed in
place: a switch for each extension, MCP server and tool, a picker for the model and the flow. Nothing is written
until one preview and one Confirm, made by a person: a trigger's spend and reach fields stay out of every tool's reach
(`TOOL_PROOF_FIELDS`), as today.

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
.te-host { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; }
.te-host b { font-weight: 650; font-family: var(--font-mono); }
.te-host .ic { flex: none; color: var(--ink-muted); }
.te-host--ok .ic { color: var(--ok-ink); }
.te-host--att { background: var(--attention-tint); }
.te-host--att .ic { color: var(--attention-ink); }
.te-sec { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 18px; padding: var(--space-4) 0; border-top: 1px solid var(--line); }
.te-sec__k { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; font-weight: 700; color: var(--ink); line-height: 20px; }
.te-sec__k .ic { flex: none; margin-top: 2px; color: var(--ink-muted); }
.te-sec__k small { display: block; font-weight: 500; font-size: 12px; color: var(--ink-muted); }
.te-sec__v { display: grid; gap: 10px; min-width: 0; }
.te-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.te-grid .field { margin: 0; }
.te-last { font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.te-last .ic { vertical-align: -2px; margin-right: 4px; }
.te-items { display: grid; gap: 6px; }
.te-item { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 2px 10px; align-items: start; padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13.5px; line-height: 20px; }
.te-item input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--ink); }
.te-item b { font-weight: 650; }
.te-item small { display: block; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.te-item .te-tag { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 6px; font-size: 12px; color: var(--ink-muted); max-width: 230px; }
.te-item .te-tag--att { display: inline-flex; align-items: flex-start; gap: 4px; color: var(--attention-ink); font-weight: 650; }
.te-item .te-tag--att .ic { flex: none; margin-top: 2px; color: var(--attention-ink); }
.te-item--locked { background: transparent; border: 1px dashed var(--line); }
.te-item--locked .ic { margin-top: 2px; color: var(--ink-muted); }
.te-changed { box-shadow: inset 3px 0 0 var(--running); }
.te-pend { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--radius-pill); background: var(--running-tint); color: var(--running-ink); font-size: 11.5px; font-weight: 700; white-space: nowrap; }
.te-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.te-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); border: 1px solid var(--line); font-size: 12.5px; font-family: var(--font-mono); cursor: pointer; }
.te-chip input { margin: 0; width: 14px; height: 14px; accent-color: var(--ink); }
.te-chip:has(input:checked) { background: var(--surface-2); border-color: transparent; }
.te-chip:has(input:not(:checked)) { color: var(--ink-muted); text-decoration: line-through; }
.te-chip:has(input:disabled) { cursor: not-allowed; border-style: dashed; }
.te-sub { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.te-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-top: var(--space-2); padding: 12px 14px; border-radius: var(--radius-md); background: var(--running-tint); font-size: 13.5px; }
.te-bar b { font-weight: 700; }
.te-bar .te-bar__t { flex: 1 1 260px; min-width: 0; }
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
    hosts = (f'<div class="te-hosts" aria-label="Where its jobs run">'
             f'<span class="te-host te-host--ok">{ic("done", "ic ic--sm")}<b>mini1</b> the same</span>'
             f'<span class="te-host">{ic("minus", "ic ic--sm")}<b>mini2</b> unknown</span>'
             f'<span class="te-host te-host--att">{ic("attention", "ic ic--sm")}<b>build3</b> also git-guard, from its overlay</span></div>'
             f'<p class="te-note">{ic("doctor", "ic ic--sm")}<span>What each host’s last doctor run published: mini1 1h ago, build3 3 days ago. mini2 has published none, so it reads unknown, never the same. The repository’s part is decided at its base commit.</span></p>'
             f'<p class="te-note">{ic("chain", "ic ic--sm")}<span>Under each row is gh-9575, its last run on mini1 that loaded anything. The last it started, gh-e9a0, was refused before its container started.</span></p>')

    model = sec("bolt", "Model", "what its jobs call", f"""<div class="te-grid">
  <div class="field"><label for="te-m">Model</label><select id="te-m" class="select"><option>claude-sonnet-5-5 (default)</option><option>claude-opus-5-5</option><option>kimi-for-coding</option></select></div>
  <div class="field"><label for="te-cap">Job cap</label><input id="te-cap" class="input" value="$2.00" aria-describedby="te-cap-h"><span class="field__hint" id="te-cap-h">the deployment’s; a trigger can only lower it</span></div>
</div>
<div><p class="te-sub">Allowed models</p><div class="te-chips"><span class="te-chip">any model</span>{btn("Limit to a list", "", "plus")}</div></div>
<div><p class="te-sub">If it is rate limited</p><div class="te-chips"><span class="te-chip">no fallback</span>{btn("Add a fallback", "", "plus")}</div></div>""",
        "Last run on mini1, gh-9575: claude-sonnet-5-5, 14 calls, $0.24.")

    flow = sec("skill", "Flow and skills", "what it is told to do", f"""<div class="field"><label for="te-f">Flow</label><select id="te-f" class="select"><option>fix, from the repository</option><option>review, from the overlay</option><option>run-tests, from pi-test-runner</option><option>A skill in the repository…</option></select></div>
<p>{state_line("attention", "attention", "acme/api has no fix skill. Its runs go without one, as gh-03a9 did.")} <a class="link" href="#">Choose a skill mini1 and build3 have</a> <span class="muted">(mini2 has published nothing)</span></p>
<p class="te-note">{ic("doctor", "ic ic--sm")}<span><b>Doctor’s answer:</b> mini1 and build3 warn that fix resolves in no tier they can see: trigger 3 names no skills folder, and neither the overlay nor a staged package has it. mini2 has published none. A forge’s repository is not on a host, so for that tier read the last run.</span></p>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Also loaded: run-tests from pi-test-runner, and each repository’s own skills. Skills folder (<span class="code">run.skillsDir</span>): none, a folder on each host, set in the file.</span></p>""",
        "Last run on mini1, gh-9575: fix from acme/web’s .pi/skills, and 3 more.")

    ext = sec("layers", "Extensions", "code its jobs load", f"""<div class="te-items">
  {item(True, "Staged packages", 'all of them, as <span class="code">run.packages</span> reads now. Off writes <span class="code">"packages": false</span>, and none load, nor their tools, skills, prompt templates or themes.')}
  {item(True, "pi-lint 1.4.2", "staged on mini1 and build3, unknown on mini2 · 2 tools, 1 prompt template")}
  {item(True, "pi-test-runner 0.9.0", "staged on mini1 and build3, unknown on mini2 · 3 tools, 2 skills")}
  {item(False, "git-guard", "build3’s overlay · 1 tool", tag="build3", changed=True)}
  {item(True, "The repository’s own", ".pi/extensions at the base commit, merge-gated. Changed in the repository, not here.", locked=True)}
</div>
<p class="te-note">{ic("plus", "ic ic--sm")}<span>A new extension, or another version, is staged first: <a class="link" href="#">Open Updates</a>. Here you only turn on and off what is staged.</span></p>""",
        "Last run on mini1, gh-9575: pi-lint and pi-test-runner.")

    mcp = sec("plug", "MCP servers", "outside systems it reaches", f"""<div class="te-items">
  {item(True, "linear", "http · mcp.example.com · codemode on · uses LINEAR_API_KEY by name", tag="mini1, build3; unknown on mini2", changed=True)}
  {item(False, "docs", "stdio · npx docs-mcp · deferred · off in mini1’s overlay", tag="off on mini1; not on build3; unknown on mini2", lacks=True)}
</div>""", "Last run on mini1, gh-9575: none.")

    tools = sec("flows", "Tools", "what the agent may use", f"""<div><p class="te-sub">pi’s own</p><div class="te-chips">{"".join(chip(t) for t in ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"])}</div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>On means not removed. powershell, grep, find and ls stay off unless an extension turns them on, so a trigger can remove them too.</span></p>
<div><p class="te-sub">From pi-lint and pi-test-runner, as gh-9575 loaded them</p><div class="te-chips">{"".join(chip(t, disabled=True) for t in ["lint_file", "lint_fix", "run_tests", "test_report", "test_coverage"])}</div></div>
<div><p class="te-sub">From git-guard, as gh-ebd7 loaded it on build3</p><div class="te-chips">{chip("guard_push", on=False, disabled=True)}</div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Locked while a host is unknown or does not load them: a name nothing loaded stops the job on that host as <span class="code">exclude-tool-not-loaded</span>. mini2 is unknown, and only build3 loads git-guard, whose tool is off with it above. Turn off the extension instead.</span></p>
<div><p class="te-sub">From linear</p><div class="te-chips">{chip("all of linear’s tools")}{"".join(chip(t) for t in ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])}</div></div>
<p class="te-note tone-attention">{ic("attention", "ic ic--sm")}<span>linear’s tools are reached through <span class="code">codemode</span>. Unticking it with linear on leaves no way to reach the server, so every job of trigger 3 is refused as <span class="code">mcp-excluded</span>, before it spends.</span></p>
<div><p class="te-sub">The job’s own</p><div class="te-chips">{chip("report_progress", disabled=True)}</div></div>
<p class="te-note">{ic("info", "ic ic--sm")}<span><span class="code">report_progress</span> comes with <span class="code">run.progress</span>, in the Edit form: no list removes it. A repository’s tools stay a count, so they have no chip. An extension’s tool is written to <span class="code">run.excludeExtensionTools</span>, the others to <span class="code">run.excludeTools</span>.</span></p>""",
        "Last run on mini1, gh-9575: 10 active, none removed: pi’s 4, the extensions’ 5, and report_progress.")

    rest = sec("box", "Image and secrets", "set elsewhere", f"""<p>pi-job:4.3.1 with pi 1.5.0 on mini1, mini2 and build3 <span class="muted">(each host’s own <span class="code">PI_JOB_IMAGE</span>, from what it publishes, unless <span class="code">run.image</span> in the file names one)</span></p>
<p>The target’s project bundle, names only: billing gets <span class="code">billing</span>, web has none. <a class="link" href="#">Open Secrets</a></p>""",
        "Last run on mini1, gh-9575: pi 1.5.0 in pi-job:4.3.1 on mini1; web has no bundle, so no secrets.")

    bar = (f'<div class="te-bar" role="status"><span class="te-bar__t"><b>2 changes, not written yet:</b> linear on, git-guard off.</span>'
           f'<span class="te-bar__a">{btn("Preview the change", "primary", sm=False)}{btn("Discard", "", sm=False)}</span></div>')
    body = hosts + model + flow + ext + mcp + tools + rest + bar
    return card("What its jobs get", body, sub="as a job of trigger 3 would start, from each host’s last doctor run", id_="p-trigger-gets")


def how_card():
    body = f"""<ul class="te-list">
  <li>{ic('edit')}<span><b>Change it in place.</b> A switch for each extension, MCP server and tool; a picker for the model and the flow.</span></li>
  <li>{ic('eye')}<span><b>Nothing is written</b> until you preview the change and confirm it.</span></li>
  <li>{ic('shield')}<span><b>A person, at the console.</b> No tool reaches this action; <span class="code">dispatch_trigger_edit</span> keeps today’s scope.</span></li>
  <li>{ic('rerun')}<span><b>Undo</b> puts the trigger back as it was.</span></li>
</ul>"""
    return card("How a change applies", body, id_="p-trigger-gets-how")


def states_card():
    """The rows in the states trigger 3 is not in today."""
    body = f"""<div class="te-sec__v">
  <div><p class="te-sub">Allowed models, as a list</p><div class="te-chips">{chip("anthropic / claude-sonnet-5-5")}{chip("kimi-coding / kimi-for-coding")}{btn("Add a model", "", "plus")}</div></div>
  <div><p class="te-sub">A fallback, if it is rate limited</p><div class="te-chips">{chip("kimi-coding / kimi-for-coding")}{btn("Add a fallback", "", "plus")}</div></div>
  <div class="te-ro"><div class="te-items">
    <div class="te-item"><span><b>Staged packages off</b><small>The file says <span class="code">"packages": false</span>. pi-lint and pi-test-runner read off, and their tools, skills and prompt templates go with them.</small></span></div>
    <div class="te-item"><span><b>No run yet</b><small>A new trigger has no record to quote. Under each row: No run yet. The hosts and each row’s control read the same.</small></span></div>
  </div></div>
</div>"""
    return card("The same rows, in other states", body, id_="p-trigger-gets-states")


def environment_page():
    lead = (f'<p class="te-lead">{ic("info", "ic ic--sm")}<span>A new card on the trigger page, above What it runs. '
            f'What it runs loses the fields this card sets from “In the triggers file, never from the console”, and the Edit form stops offering flow, provider and model, so no key has two editors. The rest of TriggerDetail is unchanged.</span></p>')
    side = f'<div class="stack">{how_card()}{states_card()}</div>'
    inner = lead + f'<div class="cols"><div class="stack">{gets_card()}</div>{side}</div>'
    end = btn("Open in Runs", "", "runs", sm=False)
    return shell("Triggers", inner, "Trigger 3", sub=TRIGGER_SUB, end=end, back="Triggers")


# ---------------------------------------------------------------- TriggerEnvironmentChange: preview, refusals, viewer
def preview_card():
    # The planner spreads a new key after the row's own (`{ ...tr.run, ...fields }` in planTriggerEdit), so these two land
    # at the end of `run`, and the line before them gains a comma, which a line diff shows as changed. An array is three
    # lines: the writer and the console's diff both go through JSON.stringify(..., 2) (triggers-file.mjs, confirm-view.mjs).
    d = diff(FILE + ", its version and row 3", [("add", '"version": 2,'), ("ctx", '"triggers": ['), ("gap", "…"),
                                                ("ctx", '  "run": {'), ("ctx", '    "kind": "github",'), ("ctx", '    "flow": "fix",'),
                                                ("ctx", '    "resume": true,'), ("ctx", '    "progress": true,'), ("ctx", '    "statusComment": true,'),
                                                ("del", '    "instructions": "This repo uses pnpm. Run pnpm test before you push."'),
                                                ("add", '    "instructions": "This repo uses pnpm. Run pnpm test before you push.",'),
                                                ("add", '    "mcp": ['), ("add", '      "linear"'), ("add", '    ],'),
                                                ("add", '    "excludeExtensions": ['), ("add", '      "git-guard"'), ("add", '    ]'),
                                                ("ctx", '  }')])
    # The console has no ring for a widening. `previewBarHtml` draws plain, paid or destructive, and a widening with an
    # Undo is plain today (setting-set raising a cap, trigger-add); limit-delete widens too and is danger, for having no
    # way back. Paid would promise a reservation this does not make and this change has its Undo, so the plain ring
    # stays and the line says it.
    c = confirm("safe", "Change trigger 3",
                [f"<span class=\"te-widen\">{ic('attention', 'ic ic--sm')}</span><b>MCP: linear on.</b> This widens what its jobs reach: those that start after this connect to mcp.example.com, with LINEAR_API_KEY by name.",
                 "<b>Extensions: git-guard off.</b> build3’s overlay has it; trigger 3’s runs there start without it.",
                 f"Adding <span class=\"code\">run.mcp</span> refuses this trigger’s 1 job in line, <a class=\"link code\" href=\"#\">gh-c9e1</a>, as <span class=\"code\">trigger-skew</span>. Re-run it from its page.",
                 "Stamps the file version 2: a host reading less waits on every trigger’s jobs, not only this one’s.",
                 "mini1, mini2 and build3 each run a release that reads version 2 and both fields.",
                 "A job on a host without linear is refused as <span class=\"code\">mcp-server-unknown</span>, before it spends. mini1 and build3 have it; mini2 has published nothing.",
                 f"Written to {code(FILE)} and audited as <b>trigger-edit</b>, by ops at the console."],
                "Put trigger 3 back as it was", "Confirm: change trigger 3")
    return card("Preview", f'<div class="te-diff">{d}</div><div class="te-gap2">{c}</div>', sub="2 changes to trigger 3", id_="p-trigger-gets-preview")


def refuses_card():
    body = f"""<ul class="te-list">
  <li class="tone-attention">{ic('attention')}<span><b>docs is off in mini1’s overlay, build3’s has no docs server, and mini2 is unknown.</b> Turning it on would refuse trigger 3’s jobs on a host without it, or with it off, as <span class="code">mcp-server-unknown</span>, and on a host with no overlay or no <span class="code">mcp.json</span> as <span class="code">mcp-config-invalid</span>, before they spend. The switch says so before you preview.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A model that cannot make one call under the cap.</b> anthropic / claude-opus-5-5 needs at least $2.62 a call, above this deployment’s $2.00 cap, which a trigger can only lower: choose another model, or raise the deployment’s cap in its settings.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A job cap above the deployment’s.</b> A trigger can only lower it, and a value above <span class="code">PI_MAX_COST_USD</span> refuses the whole file when a worker loads it.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>The triggers file changed since you opened the page.</b> Preview again; nothing is written over an edit you have not seen.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A host on an older release.</b> 4.3.1 reads no file version and drops a key it does not know, so its jobs would start with git-guard still on, on a clean record. The preview reads the versions each live host publishes and refuses while one is lower, absent or unreadable: upgrade that host first.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>Every way to a server removed.</b> Unticking <span class="code">codemode</span> with linear on refuses every job of trigger 3 as <span class="code">mcp-excluded</span>, before it spends. The preview says so first.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>An extension tool that nothing loaded.</b> A name in <span class="code">run.excludeExtensionTools</span> that no loaded extension registered stops the job as <span class="code">exclude-tool-not-loaded</span>. Refused before its prompt is sent, so the task spends no tokens. An extension that called a model while loading may already have spent, and that stays metered. The chips cannot make a typo, and a tool not every host is known to load has no live chip; a name typed in the file can.</span></li>
  <li>{ic('key')}<span><b>Not here, by design:</b> the repository’s own extensions (change the repository), a new extension or version (Updates), secrets (Secrets), the image (each host’s env, or the file) and the skills folder (the file).</span></li>
</ul>"""
    return card("What it refuses, and why", body, id_="p-trigger-gets-refuses")


def viewer_card():
    body = f"""<div class="te-ro"><div class="te-items">
  <div class="te-item"><span><b>Model</b><small>anthropic / claude-sonnet-5-5 · any model allowed · no fallback · $2.00 cap</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Flow and skills</b><small>fix, from the repository; also run-tests from pi-test-runner, and each repository’s own</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Extensions</b><small>pi-lint 1.4.2, pi-test-runner 0.9.0; git-guard on build3</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>MCP servers</b><small>none</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Tools</b><small>10 active, none removed: pi’s 4, the extensions’ 5, and report_progress, the job’s own</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Image and secrets</b><small>pi-job:4.3.1 with pi 1.5.0 on mini1, mini2 and build3; the target’s project bundle, names only</small></span><span class="te-tag"></span></div>
</div></div>
<p class="te-note te-gap2">{ic("eye", "ic ic--sm")}<span>A viewer sees the same six rows, with no switches or pickers.</span></p>"""
    return card("As a viewer sees it", body, id_="p-trigger-gets-viewer")


def change_page():
    inner = f'<div class="cols"><div class="stack">{preview_card()}</div><div class="stack">{refuses_card()}{viewer_card()}</div></div>'
    return shell("Triggers", inner, "Trigger 3, the change", sub=TRIGGER_SUB, back="Trigger 3")


# ---------------------------------------------------------------- READMEs
README = {
"TriggerEnvironment": """
The trigger page's **What its jobs get**: what a job of this trigger would start with on each host it runs on, as each host's last doctor run published it, and every part of it changed in place. Today the page lists each run field as written, beside the deployment default, and most are changed by hand in the triggers file.

**How a person uses it.**
- **The hosts** come first: one pill per host the trigger runs on, saying whether its jobs get the same there. Here build3's overlay adds git-guard, and mini2 has published no doctor run, so it reads unknown, never the same.
- **One row per kind,** each with its control and, under it, what its last run on one host that loaded anything had (part 1's record), naming the host because hosts differ. Here that is mini1, the first pill. Triggers names gh-e9a0 as trigger 3's last, and it was refused before its container started, so the card says why it quotes gh-9575:
  - **Model:** a picker of the catalog's models, the job cap (which a trigger can only lower: `effectiveCostCapMicros` takes the smaller, and a value above `PI_MAX_COST_USD` refuses the file), the allowed models and the fallbacks.
  - **Flow and skills:** a picker of the skills a job can find (the repository's, the overlay's, a staged package's, the skills folder's), with a warning when a repository lacks the flow, and doctor's answer on each host. A forge's repository is not on a host, so doctor cannot answer for that tier, and the card says so. The other skills it loads are listed.
  - **Extensions:** the all-off switch for staged packages (`"packages": false`), a switch per staged package and per overlay extension, saying where each is and what it brings. The repository's own are shown, locked: they are merge-gated content, changed in the repository.
  - **MCP servers:** a switch per server the overlay's `mcp.json` defines, with its transport, host, codemode and the key it uses by name, and each host: which have it, which do not, in warning tone, and which are unknown.
  - **Tools:** a chip per tool: pi's own, each extension's, `mcp__<server>__*` for a server's as a whole, and the five `MCP_EXCLUDABLE_TOOL_NAMES`. Names each staged or overlay extension's tools; a repository's stay a count. An extension's chip is live only while every host is known to load the tool, because a name a host did not load stops the job there. `report_progress` is shown locked: it comes with `run.progress`, and no list removes it.
  - **Image and secrets:** shown, each host's image and pi with the `PI_JOB_IMAGE` they come from, and changed where they are today (the host's env or `run.image` in the file, the Secrets page).
- **The same rows, in other states** (`p-trigger-gets-states`): allowed models and a fallback set, staged packages off, and a trigger with no run yet.
- **Changes collect** in one bar (*2 changes, not written yet*) with **Preview the change** and **Discard**. TriggerEnvironmentChange draws the preview.

**Panels.** `p-trigger-gets`, `p-trigger-gets-how`, `p-trigger-gets-states`, beside TriggerDetail's panels.

**The server provides.**
- **Today:** the trigger's fields and the deployment defaults; the overlay's MCP servers (Connections); the catalog (Models). Only doctor computes a model's first-call bound today (`firstCallFloorMicros`), so the bound moves to where a preview can read it.
- **From part 1:** the last run's record, for what loaded and the names of each extension's tools.
- **For each host:** What the host's last doctor run published, with its time, or unknown. The repository's part is decided at its base commit. The publication is a new key, `doctor:loads:<name>`, holding overlay extensions and skills, staged packages, each trigger's flow tier, and each MCP server with its `enabled` state, which is what *off* reads: today an ok doctor check publishes only its id and level, so the answer is not there to read. Each host's image and pi's version are not in it: they come from what every live host already publishes, `host:h:<name>` (`image`, `imageDigest`, `piVersion`, `INT-HOST-REGISTRY-CONTRACT`), so that row knows mini2 while the publication's rows do not, and a host whose row has expired reads unknown there too.
- **New fields, each a narrowing:** `run.excludeExtensions` (staged packages and overlay extensions by name; `"packages": false` stays the all-off switch) and `run.excludeExtensionTools`, a key of its own beside `run.excludeTools`, which stays closed so a typo there is still refused for free at load. The runner checks an extension tool's name against what loaded, and a name that matches nothing stops the job as `exclude-tool-not-loaded`. Refused before its prompt is sent, so the task spends no tokens. An extension that called a model while loading may already have spent, and that stays metered.
- **A person-only write** through the trigger edit's planner: a trigger's spend and reach fields (`run.models`, `run.fallbackModels`, `run.mcp`, `run.maxCostUsd`) stay out of every tool's reach. That is what "no tool" means here: `dispatch_trigger_edit` still sets flow, provider and model, and `dispatch_set` can still raise the deployment's own dollar caps, each behind a Confirm (`admin/src/action-policy.mjs`).
- **On TriggerDetail,** the card's fields leave *In the triggers file, never from the console* and the Edit form stops offering flow, provider and model, so no key has two editors. Image, secrets, the skills folder and the rest stay where they are.

**Who sees what.** An operator changes it. A viewer sees the rows without controls (TriggerEnvironmentChange). No tool reaches this action; `dispatch_trigger_edit` keeps today's scope.

**Why it works this way.**
- **What a job gets, not what the file says.** "packages: load" means different things on different hosts; the card says which.
- **Unknown, never the same.** A host with no publication, or one too old or too new to read, proves nothing, so its pill does not say it matches. The same goes for each row the publication answers: a staged package or a server reads unknown on mini2, never "every host", and a link offers a skill mini1 and build3 have, not one every host has.
- **A switch off narrows; a switch on picks from what is staged or defined. A row says why when something cannot go off.** The pickers choose from the catalog and what exists. New code arrives through Updates, never through a trigger.
- **One preview for every change,** so a widening (an MCP server and its key) and its side effects (a job in line refused as `trigger-skew`) are read before anything is written.
- **The last run under each row,** so a setting and what it did sit together.

**Fixture note.** Trigger 3, its hosts, gh-9575, gh-e9a0, gh-ebd7, gh-03a9 and the model are the fixture, with gh-9575's tools counted as on RunLoaded. gh-a91e is trigger 3's too and ended later, at 15:25, on mini2: the card quotes mini1's last run, and TriggerDetail's list leaves gh-a91e out. mini1's doctor run 1h ago, build3's 3 days ago and none from mini2 are as on Fleet. linear and docs are Connections' MCP servers, docs off there as it is here, and pi-lint and pi-test-runner its staged packages. Sample: git-guard in build3's overlay and review in the overlay (as on ProjectLoads), the extension tools' names, guard_push among them, docs off in mini1's overlay and absent from build3's, the model choices and the listed models and fallback, and pi 1.5.0 in pi-job:4.3.1, a pairing that is sample only: tag 4.3.1 pins pi 1.2.0. Fleet draws mini1 with one warning and build3 with one, and neither is doctor's warning for a flow in no tier, which this card's answer implies, and HostDetail's registry row draws an older sample of the image and pi: the sample does not join those.
""",
"TriggerEnvironmentChange": """
The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, and the `version` line a versioned field stamps on the file, then the Confirm:
  - each change in words, never an arrow, a widening said as one (*connect to mcp.example.com, with LINEAR_API_KEY by name*);
  - the jobs it affects: here adding `run.mcp` refuses gh-c9e1, waiting in line, as `trigger-skew`;
  - what the stamp does: *Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's.*
  - that every host's release reads the new fields;
  - what a host without the server does: refuses the job as `mcp-server-unknown`, before it spends. A host with no overlay, or no `mcp.json`, refuses it as `mcp-config-invalid`;
  - where it is written and how it is audited (`trigger-edit`, by the person).
  - **Undo** puts the trigger back as it was.
- **What it refuses, and why:** a server some hosts lack (said on the switch, before the preview), a model that cannot make one call under the cap, a cap above the deployment's, a file that changed since the page opened, a host on an older release, an exclusion that leaves no way to a server (`mcp-excluded`), an extension tool that matches nothing loaded (`exclude-tool-not-loaded`), and what belongs elsewhere.
- **As a viewer sees it:** the same six rows as the operator's, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's planner and Confirm, widened to the card's fields for a person only. A digest of the file as the page read it is sent back and compared at preview, because the Confirm's own snapshot covers only preview to Confirm, and that is what refuses a stale page. The versions each live host publishes (#761, `INT-HOST-REGISTRY-CONTRACT`), since the first version row must not reach a host older than #761: such a host reads no version and drops a key it does not know, which for a narrowing runs the job wider on a clean record (`DES-STORE-VERSION-WHEN-NEEDED`). Each model's first-call bound, which only doctor computes today.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` exist because which systems a job reaches and what it spends is the operator's to write. A person at the console is the operator; a model's call is not.
- **Refuse what would fail later, now.** A server missing on a host refuses at pickup, for free (`worker/src/processor.mjs`). A package that did not mount and a first call above the cap refuse later, inside the container (`image/runner/run-job.mjs`, `image/runner/src/usage-meter.mjs`). The preview says so first.
- **The cap's refusal says who can move it.** A trigger's `run.maxCostUsd` only lowers the deployment's cap, so "raise the cap" is not something this page can do: the sentence names the deployment's settings. It says *needs at least*, because the bound is a lower one.
- **The plain ring on a widening.** The console's Confirm is plain, paid or destructive (`previewBarHtml`), and it has no ring for a widening: raising a cap is plain today, and deleting a limit is destructive for having no way back. This change has its Undo, so the widening is said in words, with an attention glyph on its line.
- **An extension tool cannot be refused at load.** It registers at container start, so the worker's loader cannot know the name. Refused before its prompt is sent, so the task spends no tokens. An extension that called a model while loading may already have spent, and that stays metered.
- **The stamp is said out loud.** A versioned field raises the version of the whole file, so its reach is wider than the one trigger being changed.

**Fixture note.** Trigger 3, gh-c9e1 (its one job in line, as on TriggerDetail), the hosts and the cap are the fixture. $2.62 is `firstCallFloorMicros` at the pinned pi 1.5.0 for anthropic / claude-opus-5-5: 2,621,440 micro-dollars, 128,000 output tokens at $20 a million and 12,288 tokens of input at $5 a million. The Confirm draws the state where the preview passes, which assumes every host runs a release that reads version 2. Fleet draws them on 4.3.1, where the older-host refusal stands instead. The diff draws each array as three lines, as `JSON.stringify` writes them. Sample: the instructions line's place in the row, and the rest as on TriggerEnvironment.
""",
}


if __name__ == "__main__":
    write("TriggerEnvironment", card_marker("Triggers", 2000, 1440, "What a trigger’s jobs get on each host, changed in place: model, flow and skills, extensions, MCP servers and tools"),
          "Trigger 3, what its jobs get", environment_page(), CSS)
    write("TriggerEnvironmentChange", card_marker("Triggers", 1200, 1440, "The preview and Confirm of that change, what it refuses and why, and the viewer’s read-only rows"),
          "Trigger 3, the change", change_page(), CSS)
    for name, text in README.items():
        readme(name, text)
    print("trigger environment cards written")
