"""What a trigger's jobs get, and changing it from the trigger page (proposed, after #800).

Today the trigger page lists each run field as the triggers file writes it, next to the deployment default, and most
of them are changed by hand in the file. Nothing resolves them: which staged packages "packages: load" means on each
host, whether the flow is found and where, which MCP servers the overlay defines, which tools stay on.

One card shows all of it as a job would get it, on every host the trigger runs on, and every row is changed in
place: a switch for each extension, MCP server and tool, a picker for the model and the flow. Nothing is written
until one preview and one Confirm, made by a person: the fields that decide what jobs can spend or reach stay out of
every tool's reach (`TOOL_PROOF_FIELDS`), as today.

Two cards:
- TriggerEnvironment: the trigger page's What its jobs get, with two changes made and not yet written.
- TriggerEnvironmentChange: the preview and Confirm of those changes, what it refuses, and what a viewer sees."""
from pulse import *
from gen_config2 import code, state_line, COMMON_CSS, FILE


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


CSS = COMMON_CSS + """
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.te-lead { display: flex; gap: 8px; align-items: flex-start; margin-bottom: var(--space-4); font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.te-lead .ic { flex: none; margin-top: 2px; }
.te-hosts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: var(--space-4); }
.te-host { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; }
.te-host b { font-weight: 650; font-family: var(--font-mono); }
.te-host .ic { flex: none; }
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
.te-item .te-tag { font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
.te-item--locked { background: transparent; border: 1px dashed var(--line); }
.te-item--locked .ic { margin-top: 2px; color: var(--ink-muted); }
.te-changed { box-shadow: inset 3px 0 0 var(--running); }
.te-pend { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--radius-pill); background: var(--running-tint); color: var(--running-ink); font-size: 11.5px; font-weight: 700; white-space: nowrap; }
.te-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.te-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); border: 1px solid var(--line); font-size: 12.5px; font-family: var(--font-mono); cursor: pointer; }
.te-chip input { margin: 0; width: 14px; height: 14px; accent-color: var(--ink); }
.te-chip:has(input:checked) { background: var(--surface-2); border-color: transparent; }
.te-chip:has(input:not(:checked)) { color: var(--ink-muted); text-decoration: line-through; }
.te-sub { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.te-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-top: var(--space-2); padding: 12px 14px; border-radius: var(--radius-md); background: var(--running-tint); font-size: 13.5px; }
.te-bar b { font-weight: 700; }
.te-bar .te-bar__t { flex: 1 1 260px; min-width: 0; }
.te-bar .te-bar__a { display: flex; gap: 8px; flex-wrap: wrap; }
.te-note { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 18px; color: var(--ink-muted); }
.te-note .ic { flex: none; margin-top: 2px; }
.te-ro .te-item { grid-template-columns: minmax(0, 1fr) auto; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .te-sec { grid-template-columns: minmax(0, 1fr); }
  .te-grid { grid-template-columns: minmax(0, 1fr); }
  .te-item { grid-template-columns: 20px minmax(0, 1fr); }
  .te-item .te-tag { grid-column: 2; white-space: normal; }
}
"""

TRIGGER_SUB = (f'<span class="c2-lead"><span class="c2-kind">{ic("comment", "ic ic--sm")}comment</span><span class="code">"@pi"</span>'
               f'<span class="muted">→ flow</span><b>fix</b><span class="muted">on github · row 3</span></span>')


def sec(icon, title, hint, body, last=""):
    lst = f'<p class="te-last">{ic("chain", "ic ic--sm")}{last}</p>' if last else ""
    return (f'<div class="te-sec"><p class="te-sec__k">{ic(icon, "ic ic--sm")}<span>{title}<small>{hint}</small></span></p>'
            f'<div class="te-sec__v">{body}{lst}</div></div>')


def item(on, name, sub, tag="", changed=False, locked=False):
    cls = "te-item" + (" te-item--locked" if locked else "") + (" te-changed" if changed else "")
    box = ic("key", "ic ic--sm") if locked else f'<input type="checkbox"{" checked" if on else ""} aria-label="{E(name)}">'
    pend = '<span class="te-pend">changed</span>' if changed else ""
    return f'<label class="{cls}">{box}<span><b>{name}</b><small>{sub}</small></span><span class="te-tag">{pend}{tag}</span></label>'


def chip(name, on=True):
    return f'<label class="te-chip"><input type="checkbox"{" checked" if on else ""}>{E(name)}</label>'


# ---------------------------------------------------------------- TriggerEnvironment: the card, two changes made
def gets_card():
    hosts = (f'<div class="te-hosts" aria-label="Where its jobs run">'
             f'<span class="te-host te-host--ok">{ic("done", "ic ic--sm")}<b>mini1</b> the same</span>'
             f'<span class="te-host te-host--ok">{ic("done", "ic ic--sm")}<b>mini2</b> the same</span>'
             f'<span class="te-host te-host--att">{ic("attention", "ic ic--sm")}<b>build3</b> also git-guard, from its overlay</span></div>')

    model = sec("bolt", "Model", "what its jobs call", f"""<div class="te-grid">
  <div class="field"><label for="te-m">Model</label><select id="te-m" class="select"><option>claude-sonnet-5-5 (default)</option><option>claude-opus-5-5</option><option>kimi-for-coding</option></select></div>
  <div class="field"><label for="te-cap">Job cap</label><input id="te-cap" class="input" value="$2.00" aria-describedby="te-cap-h"><span class="field__hint" id="te-cap-h">the deployment’s; a first call above it is refused</span></div>
</div>
<div><p class="te-sub">Allowed models</p><div class="te-chips"><span class="te-chip">any model</span>{btn("Limit to a list", "", "plus")}</div></div>
<div><p class="te-sub">If it is rate limited</p><div class="te-chips"><span class="te-chip">no fallback</span>{btn("Add a fallback", "", "plus")}</div></div>""",
        "Last run gh-9575: claude-sonnet-5-5, 14 calls, $0.24.")

    flow = sec("skill", "Flow and skills", "what it is told to do", f"""<div class="field"><label for="te-f">Flow</label><select id="te-f" class="select"><option>fix, from the repository</option><option>review, from the overlay</option><option>run-tests, from pi-test-runner</option><option>A skill in the repository…</option></select></div>
<p>{state_line("attention", "attention", "acme/api has no fix skill. Its runs go without one, as gh-03a9 did.")} <a class="link" href="#">Choose a skill every host has</a></p>
<p class="te-note">{ic("info", "ic ic--sm")}<span>Also loaded: run-tests from pi-test-runner, and each repository’s own skills. Skills folder (<span class="code">run.skillsDir</span>): none, a folder on each host, set in the file.</span></p>""",
        "Last run gh-9575: fix from acme/web’s .pi/skills, and 3 more.")

    ext = sec("layers", "Extensions", "code its jobs load", f"""<div class="te-items">
  {item(True, "pi-lint 1.4.2", "staged on every host · 2 tools, 1 prompt template")}
  {item(True, "pi-test-runner 0.9.0", "staged on every host · 3 tools, the skill run-tests")}
  {item(False, "git-guard", "build3’s overlay only · 1 tool", tag="build3", changed=True)}
  {item(True, "The repository’s own", ".pi/extensions at the base commit, merge-gated. Changed in the repository, not here.", locked=True)}
</div>
<p class="te-note">{ic("plus", "ic ic--sm")}<span>A new extension, or another version, is staged first: <a class="link" href="#">Open Updates</a>. Here you only turn on and off what is staged.</span></p>""",
        "Last run gh-9575: pi-lint and pi-test-runner.")

    mcp = sec("plug", "MCP servers", "outside systems it reaches", f"""<div class="te-items">
  {item(True, "linear", "http · mcp.example.com · codemode on · uses LINEAR_API_KEY by name", tag="every host", changed=True)}
  {item(False, "docs", "stdio · npx docs-mcp · deferred", tag="mini1 only")}
</div>""", "Last run gh-9575: none.")

    tools = sec("flows", "Tools", "what the agent may use", f"""<div><p class="te-sub">pi’s own</p><div class="te-chips">{"".join(chip(t) for t in ["read", "edit", "write", "bash", "grep", "find", "ls"])}</div></div>
<div><p class="te-sub">From pi-lint and pi-test-runner, as gh-9575 loaded them</p><div class="te-chips">{"".join(chip(t) for t in ["lint_file", "lint_fix", "run_tests", "test_report", "test_coverage"])}</div></div>
<div><p class="te-sub">From linear</p><div class="te-chips">{chip("all of linear’s tools")}{chip("codemode")}</div></div>""",
        "Last run gh-9575: 9 active, none removed.")

    rest = sec("box", "Image and secrets", "set elsewhere", f"""<p>pi-job:4.3.1 with pi 1.5.0 on every host <span class="muted">(deployment default, set in the file)</span></p>
<p>The target’s project bundle, names only: billing gets <span class="code">billing</span>, web has none. <a class="link" href="#">Open Secrets</a></p>""")

    bar = (f'<div class="te-bar" role="status"><span class="te-bar__t"><b>2 changes, not written yet:</b> linear on, git-guard off.</span>'
           f'<span class="te-bar__a">{btn("Preview the change", "primary", sm=False)}{btn("Discard", "", sm=False)}</span></div>')
    body = hosts + model + flow + ext + mcp + tools + rest + bar
    return card("What its jobs get", body, sub="as a job of trigger 3 would start now, on each host it runs on", id_="p-trigger-gets")


def how_card():
    body = f"""<ul class="c2-list">
  <li>{ic('edit')}<span><b>Change it in place.</b> A switch for each extension, MCP server and tool; a picker for the model and the flow.</span></li>
  <li>{ic('eye')}<span><b>Nothing is written</b> until you preview the change and confirm it.</span></li>
  <li>{ic('shield')}<span><b>A person, at the console.</b> No tool can make this change, as no tool can widen what jobs spend or reach today.</span></li>
  <li>{ic('rerun')}<span><b>Undo</b> puts the trigger back as it was.</span></li>
</ul>"""
    return card("How a change applies", body, id_="p-trigger-gets-how")


def environment_page():
    lead = (f'<p class="te-lead">{ic("info", "ic ic--sm")}<span>A new card on the trigger page, above What it runs. '
            f'The rest of TriggerDetail is unchanged.</span></p>')
    side = f'<div class="stack">{how_card()}</div>'
    inner = lead + f'<div class="cols"><div class="stack">{gets_card()}</div>{side}</div>'
    end = btn("Open in Runs", "", "runs", sm=False)
    return shell("Triggers", inner, "Trigger 3", sub=TRIGGER_SUB, end=end, back="Triggers")


# ---------------------------------------------------------------- TriggerEnvironmentChange: preview, refusals, viewer
def preview_card():
    d = diff(FILE + ", row 3", [("ctx", '  "run": {'), ("ctx", '    "kind": "github",'), ("ctx", '    "flow": "fix",'),
                                 ("add", '    "mcp": ["linear"],'), ("add", '    "excludeExtensions": ["git-guard"],'),
                                 ("ctx", '    "resume": true,'), ("ctx", '    "progress": true,')])
    c = confirm("safe", "Change trigger 3",
                ["<b>MCP: none → linear.</b> Jobs that start after this connect to mcp.example.com, with LINEAR_API_KEY by name.",
                 "<b>Extensions: git-guard off.</b> Only build3’s overlay has it; trigger 3’s runs there start without it.",
                 f"Adding <span class=\"code\">run.mcp</span> refuses this trigger’s 1 job in line, <a class=\"link code\" href=\"#\">gh-77c1</a>, as <span class=\"code\">trigger-skew</span>. Re-run it from its page.",
                 "mini1, mini2 and build3 each run a release that reads both fields.",
                 f"Written to {code(FILE)} and audited as <b>trigger-edit</b>, by ops at the console."],
                "Put trigger 3 back as it was", "Confirm: change trigger 3")
    return card("Preview", f'{d}<div class="c2-gap2">{c}</div>', sub="2 changes to trigger 3", id_="p-trigger-gets-preview")


def refuses_card():
    body = f"""<ul class="c2-list">
  <li class="tone-attention">{ic('attention')}<span><b>docs is in mini1’s overlay only.</b> Turning it on would refuse trigger 3’s jobs on mini2 and build3 before they spend. The switch says so before you preview.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>A model whose first call costs more than the job cap.</b> openai / gpt-5.6-cyber can cost $19.46 on its first call, above the $2.00 cap: raise the cap or choose another.</span></li>
  <li class="tone-refused">{ic('refused')}<span><b>The triggers file changed since you opened the page.</b> Preview again; nothing is written over an edit you have not seen.</span></li>
  <li>{ic('key')}<span><b>Not here, by design:</b> the repository’s own extensions (change the repository), a new extension or version (Updates), secrets (Secrets), the image and the skills folder (the file).</span></li>
</ul>"""
    return card("What it refuses, and why", body, id_="p-trigger-gets-refuses")


def viewer_card():
    body = f"""<div class="te-ro"><div class="te-items">
  <div class="te-item"><span><b>Model</b><small>anthropic / claude-sonnet-5-5 · any model allowed · $2.00 cap</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Extensions</b><small>pi-lint 1.4.2, pi-test-runner 0.9.0; git-guard on build3</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>MCP servers</b><small>none</small></span><span class="te-tag"></span></div>
  <div class="te-item"><span><b>Tools</b><small>9 active, none removed</small></span><span class="te-tag"></span></div>
</div></div>
<p class="te-note c2-gap2">{ic("eye", "ic ic--sm")}<span>A viewer sees the same rows, with no switches or pickers.</span></p>"""
    return card("As a viewer sees it", body, id_="p-trigger-gets-viewer")


def change_page():
    inner = f'<div class="cols"><div class="stack">{preview_card()}</div><div class="stack">{refuses_card()}{viewer_card()}</div></div>'
    return shell("Triggers", inner, "Trigger 3, the change", sub=TRIGGER_SUB, back="Trigger 3")


# ---------------------------------------------------------------- READMEs
README = {
"TriggerEnvironment": """
The trigger page's **What its jobs get**: what a job of this trigger would start with now, on each host it runs on, and every part of it changed in place. Today the page lists each run field as written, beside the deployment default, and most are changed by hand in the triggers file.

**How a person uses it.**
- **The hosts** come first: one pill per host the trigger runs on, saying whether its jobs get the same there. Here build3's overlay adds git-guard.
- **One row per kind,** each with its control and, under it, what the last run had (#800's record):
  - **Model:** a picker of the catalog's models, the job cap, the allowed models and the fallbacks.
  - **Flow and skills:** a picker of the skills a job can find (the repository's, the overlay's, a staged package's, the skills folder's), with a warning when a repository lacks the flow. The other skills it loads are listed.
  - **Extensions:** a switch per staged package and per overlay extension, saying where each is and what it brings. The repository's own are shown, locked: they are merge-gated content, changed in the repository.
  - **MCP servers:** a switch per server the overlay's `mcp.json` defines, with its transport, host, codemode and the key it uses by name, and which hosts have it.
  - **Tools:** a chip per tool: pi's own, each extension's (named from the last run's record), and each server's.
  - **Image and secrets:** shown, and changed where they are today (the file, the Secrets page).
- **Changes collect** in one bar (*2 changes, not written yet*) with **Preview the change** and **Discard**. TriggerEnvironmentChange draws the preview.

**Panels.** `p-trigger-gets`, `p-trigger-gets-how`, beside TriggerDetail's panels.

**The server provides.**
- **Today:** the trigger's fields and the deployment defaults; each host's staged packages and overlay (the doctor record and Updates' host records); the overlay's MCP servers (Connections); doctor's per-host flow check (`REQ-PER-TRIGGER-SKILLS`); the catalog and each model's first-call bound (Models).
- **From #800:** the last run's record, for what loaded and the names of each extension's tools.
- **New fields, each a narrowing:** `run.excludeExtensions` (staged packages and overlay extensions by name; `"packages": false` stays the all-off switch) and extension tools in the exclusions, checked by the runner against what loaded, so a name that matches nothing refuses the job before its first model call rather than doing nothing.
- **A person-only write** through the trigger edit's planner: the fields that decide what jobs spend or reach (`run.models`, `run.fallbackModels`, `run.mcp`, `run.maxCostUsd`) stay out of every tool's reach.

**Who sees what.** An operator changes it. A viewer sees the rows without controls (TriggerEnvironmentChange). No tool or agent can make the change.

**Why it works this way.**
- **What a job gets, not what the file says.** "packages: load" means different things on different hosts; the card says which.
- **Switches that only narrow, plus pickers from what exists.** Turning something off is always available; turning something on picks from what is staged, defined or in the catalog. New code arrives through Updates, never through a trigger.
- **One preview for every change,** so a widening (an MCP server and its key) and its side effects (a job in line refused as `trigger-skew`) are read before anything is written.
- **The last run under each row,** so a setting and what it did sit together.

**Fixture note.** Trigger 3, its hosts, gh-9575, gh-03a9, gh-77c1 and the model are the fixture. linear and docs are Connections' MCP servers, and pi-lint and pi-test-runner its staged packages. Sample: git-guard in build3's overlay (as on ProjectLoads), the extension tools' names, docs on mini1 only, and the model choices.
""",
"TriggerEnvironmentChange": """
The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, then the Confirm:
  - each change in words, a widening said as one (*connect to mcp.example.com, with LINEAR_API_KEY by name*);
  - the jobs it affects: here adding `run.mcp` refuses gh-77c1, waiting in line, as `trigger-skew`;
  - that every host's release reads the new fields;
  - where it is written and how it is audited (`trigger-edit`, by the person).
  - **Undo** puts the trigger back as it was.
- **What it refuses, and why:** a server some hosts lack (said on the switch, before the preview), a model whose first call costs more than the cap, a file that changed since the page opened, and what belongs elsewhere.
- **As a viewer sees it:** the same rows, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's planner and Confirm, widened to the card's fields for a person only, with the file's digest to refuse a stale write; the store version check (#761) for a field an older host would refuse; each model's first-call bound.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` exist because which systems a job reaches and what it spends is the operator's to write. A person at the console is the operator; a model's call is not.
- **Refuse what would fail later, now.** A server or package missing on a host, or a first call above the cap, would refuse jobs at pickup; the preview says so first.

**Fixture note.** Trigger 3, gh-77c1, the hosts and the cap are the fixture. Sample: the first-call bound for openai / gpt-5.6-cyber is the bump report's reference figure, and the rest is as on TriggerEnvironment.
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
