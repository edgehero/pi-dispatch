from config_controls import CONFIG_CONTROLS_CSS
"""Configuration, package D: TriggerDetail, TriggerEditor, SecretsScreen, ConnectionsScreen, ProjectDetail on the Pulse kit.
gen_fleet.py writes its screens at import, so its helpers are copied here, not imported."""
from pulse import *

from common2 import ICONS, S

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def table(headers, rows, cls="tbl", caption="", stack=False):
    """headers: [(label, cls)]; rows: list of [(html, cls)] or (rowcls, [...]). stack adds data-l labels for tbl--stack."""
    th = "".join(f'<th scope="col"{(" class=" + chr(34) + c + chr(34)) if c else ""}>{h}</th>' for h, c in headers)
    trs = []
    for r in rows:
        rcls = ""
        if isinstance(r, tuple):
            rcls, r = r
        tds = []
        for i, (v, c) in enumerate(r):
            lab = headers[i][0] if stack and i < len(headers) and headers[i][0] and i > 0 else ""
            dl = f' data-l="{E(lab)}"' if lab and "act" not in c and "c2-span" not in c else ""
            cs = f' colspan="{len(headers) - i}"' if "c2-span" in c else ""
            tds.append(f'<td{(" class=" + chr(34) + c + chr(34)) if c else ""}{dl}{cs}>{v}</td>')
            if cs:
                break
        trs.append(f'<tr{(" class=" + chr(34) + rcls + chr(34)) if rcls else ""}>{"".join(tds)}</tr>')
    cap = f'<caption class="sr">{caption}</caption>' if caption else ""
    if stack:
        cls += " tbl--stack"
    return f'<div class="tbl-wrap"><table class="{cls}">{cap}<thead><tr>{th}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>'

def code(t):
    return f'<span class="code">{E(t)}</span>'

def runlink(jid):
    return f'<a class="link code" href="#">{E(jid)}</a>'

def where(kind):
    """Where a trigger field changes: here (the edit form), add (the add form), file (by hand)."""
    return {"here": f'<span class="c2-where c2-where--here">{ic("edit", "ic ic--sm")}Edit here</span>',
            "add": f'<span class="c2-where">{ic("plus", "ic ic--sm")}When adding</span>',
            "file": f'<span class="c2-where">{ic("slot-held", "ic ic--sm")}By hand</span>'}[kind]

def yesno(on, yes="yes", no="no"):
    return f'<span class="c2-yes">{ic("done", "ic ic--sm")}{yes}</span>' if on else f'<span class="c2-no">{no}</span>'

def state_line(tone, icon, text):
    return f'<span class="c2-st tone-{tone}">{ic(icon, "ic ic--sm")}<span>{text}</span></span>'

FILE = "…/deploy/triggers.json"

COMMON_CSS = """
.c2-yes { display: inline-flex; align-items: flex-start; gap: 5px; font-weight: 650; color: var(--ok-ink); }
.c2-no { color: var(--ink-muted); }
.c2-st { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--tone-ink); font-weight: 600; line-height: 18px; }
.c2-st .ic { margin-top: 2px; }
.c2-st > span { min-width: 0; }
.c2-lead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.c2-kind, .c2-where { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 650; color: var(--ink-muted); white-space: nowrap; }
.c2-where--here { color: var(--ink); }
.c2-kind { color: var(--ink); font-weight: 700; }
.c2-lead .ptag { height: 26px; padding: 0 10px; font-size: 13px; }
.c2-quote { padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 20px; color: var(--ink); overflow-wrap: anywhere; }
.c2-list { display: grid; gap: 8px; }
.c2-list > li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.c2-list > li > .ic { margin-top: 1px; color: var(--tone-ink, var(--ink-muted)); }
.c2-list b { color: var(--ink); font-weight: 650; }
.c2-sub { margin: var(--space-4) 0 var(--space-2); font-size: 12px; font-weight: 700; color: var(--ink-muted); }
.c2-sub:first-child { margin-top: 0; }
.c2-form { display: grid; gap: var(--space-4); }
.c2-form fieldset { margin: 0; padding: var(--space-4) 0 0; border: 0; border-top: 1px solid var(--line); display: grid; gap: var(--space-3); min-width: 0; }
.c2-form fieldset:first-child { border-top: 0; padding-top: 0; }
.c2-form legend { padding: 0; font-size: 13px; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 8px; }
.c2-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.c2-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.c2-grid > .field { align-content: start; }
.c2-pick { display: flex; flex-wrap: wrap; gap: 6px; }
.c2-pick button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border: 0; border-radius: var(--radius-pill); background: var(--surface-2); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); font-family: var(--font-mono); font-size: 12px; font-weight: 600; cursor: pointer; }
.c2-pick button[aria-pressed="true"] { background: var(--primary); box-shadow: none; color: var(--on-primary); }
.c2-act { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.c2-gap { margin-top: var(--space-4); }
.c2-gap2 { margin-top: var(--space-3); }
details.c2-more { border-radius: var(--radius-md); background: var(--surface-2); }
details.c2-more > summary { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 14px; cursor: pointer; font-size: 13px; font-weight: 650; color: var(--ink-muted); list-style: none; }
details.c2-more > summary::-webkit-details-marker { display: none; }
details.c2-more > div { padding: 0 14px 14px; display: grid; gap: var(--space-3); }
.tbl td .c2-st { font-weight: 550; }
.c2-cell { display: grid; gap: 3px; min-width: 0; }
.c2-cell small { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.c2-cell > .ptag, .c2-cell > .c2-st { justify-self: start; }
.c2-names { display: flex; flex-wrap: wrap; gap: 4px; }
.c2-names .code { padding: 1px 6px; border-radius: 6px; background: var(--surface-2); font-size: 12px; }
.c2-kv { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.c2-kv b { font-size: 32px; line-height: 36px; font-weight: 800; letter-spacing: -0.02em; }
.c2-kv span { color: var(--ink-muted); font-size: 13px; }
.confirm__list .code, .c2-list .code, .c2-st .code { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .c2-grid, .c2-grid--3 { grid-template-columns: minmax(0, 1fr); }
  .tbl--stack td.c2-actc { grid-column: 2; grid-row: 1; text-align: right; }
  .tbl--stack td.c2-first { grid-column: 1; grid-row: 1; }
  .tbl--stack tr.row--failed { background: var(--failed-tint); }
  .tbl--stack tr.row--attention { background: var(--attention-tint); }
  .tbl--stack tr.row--failed td, .tbl--stack tr.row--attention td, .tbl--stack tbody tr:hover td { background: transparent; }
}
"""

# =====================================================================================
# 1. TRIGGER DETAIL: trigger 3, comment "@pi" -> fix on github
# =====================================================================================
def trigger_detail():
    on = facts([
        ("Kind", f'<span class="c2-where c2-where--here">{ic("comment", "ic ic--sm")}comment</span> on github'),
        ("Phrase", f'{code(chr(34) + "@pi" + chr(34))} anywhere in a comment on an issue or a pull request'),
        ("Picks a flow", f'{code("@pi triage")} or {code("@pi review")} runs that trigger\'s flow instead, when the word is another trigger\'s flow'),
        ("One per forge", "This is github's comment trigger; a second one on github does not load"),
        ("Who may fire it", "A collaborator with write access. The worker checks the commenter's permission on every delivery"),
        ("Row", f'3 of 7 in {code(FILE)}'),
    ], 1)
    p_on = card("What starts it", on, id_="p-trigger-on", sub="comment trigger")

    F = [  # key, label, value, where
        ("flow", "Flow", "<b>fix</b>", "here"),
        ("backend", "Venue", 'deployment default <span class="muted">(local)</span>', "here"),
        ("provider / model", "Model", 'deployment default <span class="muted">(anthropic / claude-sonnet-5-5)</span>', "here"),
        ("maxTurns", "Turn budget", 'deployment default <span class="muted">(30)</span>', "here"),
        ("resume", "Keeps a session", yesno(True, "yes: the next run on the issue continues it"), "file"),
        ("awaitInput", "May stop to ask", yesno(False), "file"),
        ("progress", "Reports phases", yesno(True), "here"),
        ("statusComment", "Status comment", yesno(True, "yes: one comment, edited as it runs"), "here"),
        ("steer", "Takes messages", yesno(False, no="no: Steer and Follow up are off for its runs"), "here"),
        ("recover", "Recovers", yesno(False, no="no: an infrastructure loss retries from the start"), "here"),
        ("replicas", "Replicas", '<span class="muted">one run per comment</span>', "file"),
        ("waitFor", "Waits for", '<span class="muted">nothing</span>', "file"),
        ("instructions", "Instructions", "2 lines, above the issue text", "file"),
        ("mcp", "MCP servers", '<span class="muted">none</span>', "file"),
        ("excludeTools", "Tools removed", '<span class="muted">none</span>', "file"),
        ("image", "Job image", 'deployment default <span class="muted">(pi-job:latest)</span>', "file"),
        ("packages", "Staged packages", 'load <span class="muted">(none staged)</span>', "file"),
        ("secrets", "Secrets", '<span class="muted">none</span>', "file"),
        ("secretBundle", "Project bundle", 'the target\'s project bundle <span class="muted">(billing gets <span class="code">billing</span>; web has none)</span>', "file"),
        ("models", "Allowed models", '<span class="muted">any model</span>', "file"),
        ("maxCostUsd", "Job cap", 'the deployment\'s <span class="muted">($2.00)</span>', "file"),
    ]
    groups = [("here", "The Edit form below changes these."), ("file", "In the triggers file, never from the console.")]
    body = ""
    for g, note in groups:
        pairs = [(f'<span class="c2-cell"><b>{lab}</b><small class="code">run.{E(k)}</small></span>', v) for k, lab, v, w in F if w == g]
        body += f'<div class="c2-grp"><p class="c2-grp__h">{where(g)}<span class="muted">{note}</span></p>{facts(pairs, 2)}</div>'
    body += '<h3>Its runs’ sandbox</h3><p>Local (deployment default): live transcript yes, steering yes, recovery yes, sandbox shell yes. Retained workspaces can be reopened for 24 hours. Each event starts one sandbox. Secret profile and bundle names only.</p>'
    p_run = card("What it runs", body, sub="every field, set or not", id_="p-trigger-run")

    edit = f"""<form class="c2-form" aria-label="Edit trigger 3">
  <div class="c2-grid c2-grid--3">
    <div class="field"><label for="te-flow">Flow</label><input id="te-flow" class="input input--code" value="fix"></div>
    <div class="field"><label for="te-venue">Venue</label><select id="te-venue" class="select"><option>podman</option></select></div>
    <div class="field"><label for="te-model">Model (optional)</label><input id="te-model" class="input input--code" placeholder="deployment default"></div>
  </div>
  <div class="c2-act"><button class="btn btn--primary" type="button">Preview the edit</button><span class="field__hint">Only flow, venue, provider and model change here. Everything marked By hand stays as the file says.</span></div>
</form>
<div class="c2-gap">{diff(FILE + ", row 3", [("ctx", '{'), ("ctx", '  "on": { "type": "comment", "phrase": "@pi" },'), ("ctx", '  "run": {'),
                                          ("ctx", '    "kind": "github",'), ("ctx", '    "flow": "fix",'), ("add", '    "backend": "podman",'),
                                          ("ctx", '    "resume": true,'), ("ctx", '    "progress": true,')])}</div>
<div class="c2-gap2">{confirm("safe", "Edit trigger 3",
    ["<b>Venue: deployment default (local) → podman</b>, for runs this trigger starts after you confirm.",
     f"The plan says: {code('trigger #3 (comment) flow: fix -> fix, backend: (none) -> podman')}",
     "podman is blessed on build3 only, so these runs wait for build3. A run already in line keeps local.",
     f"Written to {code(FILE)} and audited as <b>trigger-edit</b>."],
    "Set trigger 3's venue back to the deployment default", "Confirm: edit trigger 3")}</div>"""
    p_edit = card("Edit", edit, id_="p-trigger-edit", sub="preview open")

    R = [("gh-e9a0", "billing", "acme/billing#260", "refused", "15:30", "not metered", "Refused: the egress proxy is not running on build3."),
         ("gh-9575", "web", "acme/web#490", "completed", "15:12", "$0.24", ""),
         ("gh-ebd7", "billing", "acme/billing#259", "completed", "14:48", "$0.36", ""),
         ("gh-7cdf", "billing", "acme/billing#258", "completed", "12:39", "$0.40", ""),
         ("gh-4a7e", "billing", "acme/billing#290", "cancelled", "10:59", "not metered", "Cancelled before the job spent anything.")]
    rrows = []
    for jid, p, tgt, oc, at, cost, why in R:
        rrows.append([(runlink(jid), "id c2-first"), (f'{tag(p)} <a class="link" href="#">{E(tgt)}</a>' + (f'<span class="reason">{why}</span>' if why else ""), "wide"),
                      (badge(oc), "c2-actc"), (f'{at} UTC', "when"), (cost, "num")])
    runs = f"""<div class="c2-kv c2-pad"><b>9</b><span>runs in the last 24 hours</span><b class="c2-kv2">$2.47</b><span>metered; 2 spent nothing</span></div>
{table([("Run", ""), ("Target", ""), ("Outcome", ""), ("Ended", ""), ("Cost", "num")], rrows, caption="Recent runs of trigger 3", stack=True)}
<p class="tbl-foot">7 completed, 1 refused, 1 cancelled. <a class="link" href="#">All 9 in Runs</a></p>"""
    p_runs = card("Runs it started", runs, id_="p-trigger-runs", flush=True, sub="last 24 hours")

    p_instr = card("Instructions", '<p class="c2-quote">This repo uses pnpm. Run pnpm test before you push.</p>',
                   id_="p-trigger-trust", sub="above the issue text, 2 lines")

    kinds = f"""<ul class="c2-list">
  <li class="tone-ok">{ic('clock')}<span><b>1 · cron {code('nightly-tidy')}</b> {code('0 3 * * *')}<br>Next 03:00 UTC tomorrow, in 11h 21m. {state_line('ok', 'done', 'On time')}</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>If a schedule slips</b><br>{state_line('attention', 'attention', 'Overdue 4m: due 03:00 UTC, not started. Stalls 1 of 3.')}</span></li>
  <li class="tone-idle">{ic('issue')}<span><b>An armed one-shot</b><br>Fires once, when its issue is closed by someone with write access.</span></li>
  <li class="tone-idle">{ic('done')}<span><b>5 · issue closed, #40, once</b><br>Spent by {runlink('gh-40a1')} on 2 Oct, 11:20 UTC. It matches nothing now; delete {code('on.disarmed')} in the file to arm it again.</span></li>
</ul>
<div class="c2-gap c2-act">{btn("Fire nightly-tidy now", "paid", "play", sm=False)}</div>
<div class="c2-gap2">{confirm("paid", "Fire trigger 1 once, now",
    [f"Runs flow <b>tidy</b> in {code('…/site')} on mini1, the host with the folder, as job {code('manual:nightly-tidy:2026-10-08T15:39')}.",
     "It runs as the triggers file says now: model kimi-coding / kimi-for-coding, the deployment's per-job cap.",
     "It holds 1 job slot and <b>$2.00</b> (the per-job cap) in each dollar window that applies, until it settles.",
     "Tonight's 03:00 run still fires."],
    "cancel the job from Fleet before it starts", "Fire now for up to $2.00")}</div>"""
    p_kinds = card("Other kinds read like this", kinds, id_="p-trigger-kinds", sub="schedules and one-shots")

    change = f"""<ul class="c2-list">
  <li class="tone-attention">{ic('attention')}<span><b>Adding a field the queue does not know</b> (steer, recover, progress, statusComment, awaitInput, mcp, models, maxCostUsd) refuses this trigger's jobs already in line as <span class="code">trigger-skew</span>. 1 waits now: {runlink('gh-c9e1')}.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>Inserting a trigger above row 3</b> renumbers it, and jobs in line refer to rows by number.</span></li>
  <li class="tone-failed">{ic('failed')}<span><b>If the file does not load</b>, no trigger fires. The page says why, quoting doctor: <span class="muted">"The triggers file does not load. pi-dispatch doctor on this host (mini1, 2h ago) says: trigger 5: once needs number."</span></span></li>
</ul>"""
    p_change = card("Before you change it", change, id_="p-trigger-change")

    side = f'<div class="stack">{p_instr}{p_kinds}{p_change}</div>'
    end = btn("Open in Runs", "", "runs", sm=False) + btn("Delete", "danger", sm=False)
    sub = f'<span class="c2-lead"><span class="c2-kind">{ic("comment", "ic ic--sm")}comment</span><span class="code">"@pi"</span><span class="muted">→ flow</span><b>fix</b><span class="muted">on github · row 3</span></span>'
    inner = f'<div class="cols config-layout"><div class="stack">{p_on}{p_runs}{p_run}{p_edit}</div>{side}</div>'
    return shell("Triggers", inner, "Trigger 3", sub=sub, end=end, back="Triggers")

COMMON_CSS += CONFIG_CONTROLS_CSS

TD_CSS = COMMON_CSS + """
.c2-pad { padding: 0 var(--space-5) var(--space-3); }
.c2-kv2 { margin-left: var(--space-4); }
#p-trigger-run .fact { grid-template-columns: 150px minmax(0, 1fr); }
.c2-grp + .c2-grp { margin-top: var(--space-5); }
.c2-grp__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; font-size: 13px; }
@media (max-width: 760px) { .c2-pad { padding: 0 var(--space-4) var(--space-3); } .c2-kv2 { margin-left: 0; } }
"""

# =====================================================================================
# 2. TRIGGER EDITOR: add a trigger, all five kinds
# =====================================================================================
def trigger_editor():
    kinds = [("clock", "cron", False), ("tag", "label", False), ("comment", "comment", False), ("pr", "pull request", True), ("issue", "issue", False)]
    seg = '<div class="seg c2-kinds" role="group" aria-label="Kind">' + "".join(
        f'<button type="button" aria-pressed="{"true" if on else "false"}">{ic(i, "ic ic--sm")}{k}</button>' for i, k, on in kinds) + "</div>"
    acts = [("labeled", False), ("opened", False), ("synchronize", False), ("reopened", False), ("review_submitted", True), ("closed", False)]
    pick = lambda items, lab: f'<div class="c2-pick" role="group" aria-label="{lab}">' + "".join(
        f'<button type="button" aria-pressed="{"true" if on else "false"}">{a}</button>' for a, on in items) + "</div>"
    opts = [("progress", "Report phases", "The agent declares phases; the run page shows them. Needs an image with reportProgress.", True),
            ("statusComment", "Status comment", "One comment on the pull request, edited as the run goes. Numbers only.", True),
            ("steer", "Take messages", "Operators and commenters can steer the running agent. Needs a venue that delivers them.", False),
            ("recover", "Recover", "After an infrastructure loss, continue from the last checkpoint, at most twice.", False)]
    optrows = "".join(f'<li><label class="c2-opt"><input type="checkbox"{" checked" if on else ""}><span><b>{t}</b> <span class="code">run.{k}</span><small>{h}</small></span></label></li>' for k, t, h, on in opts)
    form = f"""<form class="c2-form" aria-label="New trigger">
  <fieldset><legend>{ic('bolt', 'ic ic--sm')}1. What starts it</legend>
    <div class="c2-scroll">{seg}</div>
    <div class="c2-grid">
      <div class="field"><label for="ta-forge">Forge</label><select id="ta-forge" class="select"><option>github</option></select></div>
      <div class="field"><label for="ta-labels">Labels, any of (optional)</label><input id="ta-labels" class="input input--code" placeholder="required when labeled is picked"></div>
    </div>
    <div class="field"><span class="field__l">Actions, in github's words</span>{pick(acts, "Actions")}</div>
    <div class="field"><span class="field__l">Review state, for review_submitted</span>{pick([("approved", False), ("changes_requested", True), ("commented", False)], "Review state")}
      <span class="field__hint">A review trigger fires on every verdict unless you narrow it. A comment-only review with an empty summary starts nothing.</span></div>
  </fieldset>
  <fieldset><legend>{ic('terminal', 'ic ic--sm')}2. What it runs</legend>
    <div class="c2-grid">
      <div class="field"><label for="ta-flow">Flow</label><input id="ta-flow" class="input input--code" value="address-review"><span class="field__hint">A skill at <span class="code">.pi/skills/address-review/SKILL.md</span> on the default branch.</span></div>
      <div class="field"><label for="ta-venue">Venue</label><select id="ta-venue" class="select"><option>deployment default (local)</option></select><span class="field__hint">Only venues this deployment blesses: local, podman.</span></div>
      <div class="field"><label for="ta-model">Provider / model (optional)</label><input id="ta-model" class="input input--code" placeholder="anthropic/claude-sonnet-5-5"></div>
      <div class="field"><label for="ta-turns">Turn budget (optional)</label><input id="ta-turns" class="input" placeholder="30, the deployment's"></div>
    </div>
  </fieldset>
  <fieldset><legend>{ic('config', 'ic ic--sm')}3. Run options</legend>
    <ul class="c2-opts">{optrows}</ul>
    <p class="c2-hand">{ic('slot-held', 'ic ic--sm')}<span><b>Set by hand in the triggers file:</b> the job cap, allowed models, MCP servers and 7 more fields. <a class="link" href="#">Which ones</a></span></p>
  </fieldset>
  <div class="c2-act"><button class="btn btn--primary" type="button">Preview the add</button><button class="btn btn--ghost" type="button">Clear</button></div>
  <details class="c2-more"><summary>{ic('terminal', 'ic ic--sm')}Or paste the add tool's fields as JSON</summary>
    <div><label class="sr" for="ta-json">New trigger, as the add tool's fields (JSON)</label><textarea id="ta-json" class="textarea input--code" placeholder='{{"kind": "label", "labels": ["pi"], "flow": "triage"}}'></textarea></div></details>
</form>"""
    prev = f"""{diff(FILE + ", after row 7", [("ctx", '  },'), ("add", '  {'), ("add", '    "on": {'), ("add", '      "type": "pull_request",'),
        ("add", '      "action": ["review_submitted"],'), ("add", '      "reviewState": ["changes_requested"]'), ("add", '    },'),
        ("add", '    "run": {'), ("add", '      "kind": "github",'), ("add", '      "flow": "address-review",'), ("add", '      "progress": true,'),
        ("add", '      "statusComment": true'), ("add", '    }'), ("add", '  }'), ("ctx", ']')])}
<div class="c2-gap2">{confirm("safe", "Add trigger 8",
    ["<b>Trigger 8: a github review that asks for changes → flow address-review.</b>",
     "It fires for a reviewer with write access. A comment-only review with an empty summary starts nothing.",
     "Each run it starts is paid: it holds 1 job slot and up to <b>$2.00</b> (the per-job cap) until it settles.",
     f"Written to {code(FILE)} and audited as <b>trigger-add</b>. It opts out of project secret bundles (run.secretBundle: false), just as the add tool does; change that field by hand."],
    "Delete trigger 8", "Confirm: add trigger 8")}</div>"""
    p_form = card("New trigger", form, id_="p-trigger-add")
    p_prev = card("Preview", prev, id_="c-trigger-preview", sub="the lines it adds, then Confirm")


    inner = f'<div class="cols cols--wide-side config-layout"><div class="stack">{p_form}</div><div class="stack">{p_prev}{card('The five kinds', '<p>Cron, label, comment, pull request and issue. The selected kind sets its fields.</p>', id_='p-kinds')}{card('Pull request words per forge', '<p>Each forge has its own action vocabulary. Review states narrow submitted verdicts.</p>', id_='p-forge-words')}{card('Refusals', '<p>A refusal names its field and the loader’s reason. Nothing was changed.</p>', id_='p-refusals')}</div></div>'
    return shell("Triggers", inner, "Add a trigger", sub=f'Rows 1 to 7 exist; this one becomes row 8 of <span class="code">{FILE}</span>.', back="Triggers")

TE_CSS = COMMON_CSS + """
.c2-scroll { overflow-x: auto; scrollbar-width: none; }
.c2-kinds { display: flex; width: max-content; }
.c2-kinds button { height: 36px; padding: 0 16px; font-size: 14px; }
.c2-opts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.c2-opt { display: flex; align-items: flex-start; gap: 10px; height: 100%; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); cursor: pointer; }
.c2-opt input { width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--primary); flex: none; }
.c2-opt b { font-weight: 650; }
.c2-opt .code { font-size: 11px; color: var(--ink-muted); }
.c2-opt small { display: block; margin-top: 3px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.c2-hand { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; padding: 10px 14px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.c2-hand > .ic { margin-top: 2px; }
#p-trigger-preview .diff { margin-bottom: var(--space-3); }
.c2-hand b { color: var(--ink); }
@media (max-width: 760px) { .c2-opts { grid-template-columns: minmax(0, 1fr); } .c2-scroll { overflow: visible; } .c2-kinds { width: auto; flex-wrap: wrap; border-radius: var(--radius-md); } }
"""

# =====================================================================================
# 3. SECRETS: profiles and bundles, names only
# =====================================================================================
def secrets():
    top = banner("failed", "refused", "Refused: stripe is declared twice",
                 'It is in <span class="code">PI_SECRET_PROFILES</span> and in the settings overlay, so the worker refuses every job that uses secrets until one goes. Remove it from one of them.',
                 act=btn("Remove from the overlay", "danger"))

    P = [
        ("default", ("idle", "info", "declared in PI_SECRET_PROFILES"), ("idle", "info", "not bounded (an env resolver)"), "#1", tag("ops"),
         f'{state_line("ok", "done", "resolved")}<small>03:00 UTC · {runlink("repeat:nightly-tidy:…")}</small>', "mini1, mini2, build3", ""),
        ("vault", ("idle", "info", "declared in the settings overlay"), ("ok", "done", "inside PI_SECRET_RESOLVER_ROOTS"), "#7", '<span class="muted">any (a webhook trigger)</span>',
         f'{state_line("ok", "done", "resolved")}<small>15:13 UTC · {runlink("gh-2f6a")}</small>', 'mini1, mini2<small>build3 publishes no capabilities</small>', ""),
        ("ops-1p", ("idle", "info", "declared in the settings overlay"), ("failed", "failed", "outside PI_SECRET_RESOLVER_ROOTS, so the worker refuses every job naming it"), "#6", tag("ops"),
         f'<span class="muted">no run since it was declared, Tue 6 Oct</span>{state_line("failed", "failed", "the next run, Mon 06:00 UTC, will be refused")}', "mini1", "row--failed"),
        ("stripe", ("failed", "failed", "ambiguous: also in PI_SECRET_PROFILES, so the worker refuses every secrets job"), ("idle", "info", "not bounded (an env resolver)"), "#5",
         '<span class="muted">any (a webhook trigger)</span>', '<span class="muted">no run in view</span>', '<span class="c2-st tone-attention">' + ic("attention", "ic ic--sm") + '<span>no live host advertises it</span></span>', "row--failed"),
    ]
    rows = []
    for name, src, roots, trg, proj, last, served, rc in P:
        act = btn("Remove", "danger") if name != "default" else '<span class="faint">in the .env</span>'
        rows.append((rc, [(f'<b class="code">{name}</b>', "id c2-first"), (state_line(*src), "wide"), (state_line(*roots), "wide"), (trg, ""), (proj, ""),
                          (f'<span class="c2-cell">{last}</span>', "wide"), (f'<span class="c2-cell">{served}</span>', "wide"), (act, "act c2-actc")]))
    prof_tbl = table([("Profile", ""), ("Source", ""), ("Resolver roots", ""), ("Triggers", ""), ("Projects", ""), ("Last resolve", ""), ("Served by", ""), ("", "act")],
                     rows, caption="Secret profiles", stack=True)
    remove = f"""<div class="c2-pad2">{diff("~/.pi-dispatch/settings.json", [("ctx", '"secretProfiles": {'), ("del", '  "ops-1p": "…/1p-read",'),
                                                                     ("ctx", '  "stripe": "…/stripe-read",'), ("ctx", '  "vault": "…/vault-read"'), ("ctx", '},')])}
<div class="c2-gap2">{confirm("danger", "Remove a secret resolver",
    [f"<b>{code('ops-1p')} → {code('…/1p-read')}</b> leaves the settings overlay.",
     "Every trigger naming it is refused before spend after this, rather than running without its secrets: <b>trigger 6</b> (pm-weekly).",
     "The resolver script stays on disk; only the declaration goes. Audited as <b>secret-profile-remove</b>."],
    "Declare ops-1p again with the same resolver", "Remove ops-1p")}</div></div>"""
    p_prof = card("Secret profiles", prof_tbl + remove, id_="p-secret-profiles", flush=True, sub="4 in use · names only",
                  end='<span class="card__sub">A profile\'s resolver and its references stay in the settings file or the .env</span>')

    B = [
        ("billing", tag("billing"), ("ok", "done", "vault-bundle: settings overlay, inside the roots"), "no", '<span class="muted">none</span>', "#4",
         f'<span class="c2-names">{code("STRIPE_KEY")}{code("DB_URL")}{code("SENTRY_DSN")}</span><small>{runlink("gh-ebd7")} · 14:48 UTC</small>', ""),
        ("web", tag("web"), ("ok", "done", "web-env: PI_SECRET_BUNDLES"), f'{ic("done", "ic ic--sm")} yes', f'{code("API_TOKEN")} at {code("api.acme.dev")}', '<span class="muted">none</span>',
         f'<span class="c2-names">{code("NPM_TOKEN")}{code("API_TOKEN")}</span><small>{runlink("gh-9575")} · 15:12 UTC</small>', ""),
        ("legacy", f'{tag("shop")}<small>not in projects.json</small>', ("attention", "attention", "shop-env: missing, declared in no source"), "no", '<span class="muted">none</span>', '<span class="muted">none</span>',
         '<span class="muted">no run in view</span>', "row--attention"),
    ]
    brows = [(rc, [(f'<b class="code">{n}</b>', "id c2-first"), (f'<span class="c2-cell">{p}</span>', ""), (state_line(*prof), "wide"), (fr, ""), (ep, "wide"), (oo, ""),
                   (f'<span class="c2-cell">{last}</span>', "wide")]) for n, p, prof, fr, ep, oo, last, rc in B]
    bund_tbl = table([("Bundle", ""), ("Project", ""), ("Resolver", ""), ("Fork reviews", ""), ("Endpoints", ""), ("Opted out", ""), ("Last received", "")],
                     brows, caption="Secret bundles", stack=True)
    p_bund = card("Secret bundles", f'<p class="c2-res">Bundle resolvers: {code("vault-bundle")} <span class="muted">(dotenv, settings overlay)</span>, {code("web-env")} <span class="muted">(json, PI_SECRET_BUNDLES)</span>.</p>' + bund_tbl,
                  id_="p-secret-bundles", flush=True, sub="3 bound in the triggers file",
                  end='<span class="card__sub">Variable names only, from the newest run of each project</span>')

    add = f"""<form class="c2-form" aria-label="Declare a resolver">
  <div class="seg" role="group" aria-label="What to declare"><button type="button" aria-pressed="true">Profile</button><button type="button" aria-pressed="false">Bundle resolver</button></div>
  <div class="field"><label for="sp-name">Name</label><input id="sp-name" class="input input--code" value="vault-ci"></div>
  <div class="field field--err"><label for="sp-path">Resolver (absolute path)</label><input id="sp-path" class="input input--code" value="resolvers/vault-ci" aria-invalid="true" aria-describedby="sp-err">
    <p id="sp-err" class="field__err" role="alert">{ic('failed', 'ic ic--sm')}The resolver needs an absolute path: a service manager's working directory is not your shell's.</p></div>
  <p class="field__hint">Must sit inside <span class="code">PI_SECRET_RESOLVER_ROOTS</span> (2 roots on this host).</p>
  <div class="c2-act"><button class="btn" type="button" aria-disabled="true">Preview the profile</button></div>
</form>"""
    p_add = card("Declare a resolver", add, id_="p-secret-add", sub="writes the settings overlay")


    inner = top + p_prof + p_bund + p_add
    return shell("Configuration", inner, "Secrets", sub="Names and states only. 2 problems: one profile declared twice, one outside the resolver roots.", back="Configuration")

SE_CSS = COMMON_CSS + """
.c2-pad2 { padding: var(--space-4) var(--space-5) var(--space-5); border-top: 1px solid var(--line); }
.c2-res { padding: 0 var(--space-5) var(--space-3); font-size: 13px; color: var(--ink); }
#p-secret-add .c2-form { max-width: 640px; }
#p-secret-profiles .tbl td, #p-secret-bundles .tbl td { vertical-align: top; }
#p-secret-profiles .tbl .c2-st, #p-secret-bundles .tbl .c2-st { max-width: 260px; }
.c2-pad2 > .diff, .c2-pad2 .confirm { max-width: 900px; }
#p-secret-profiles .card__head .end, #p-secret-bundles .card__head .end { max-width: 360px; text-align: right; }
@media (max-width: 760px) {
  .c2-pad2 { padding: var(--space-4); }
  .c2-res { padding: 0 var(--space-4) var(--space-3); }
  #p-secret-profiles .card__head .end, #p-secret-bundles .card__head .end { margin-left: 0; max-width: none; text-align: left; }
  #p-secret-profiles .tbl .c2-st, #p-secret-bundles .tbl .c2-st { max-width: none; }
}
"""

# =====================================================================================
# 4. CONNECTIONS: forges, egress, model endpoints, MCP, packages, notifications, environment
# =====================================================================================
def connections():
    top = banner("refused", "refused", "Refused on build3: its egress proxy is not running",
                 'Every job that lands on build3 is refused before spend as <span class="code">egress-proxy-missing</span>, as gh-e9a0 was at 15:30 UTC. Run <span class="code">pi-dispatch up</span> on build3.',
                 act=btn("Open build3", "") + btn("Open gh-e9a0", "ghost"))

    FG = [
        ("github", True, "triggers 2, 3, 5, 7", "GitHub App", "per-job token: 1 hour, one repository",
         f'HMAC, {code("WEBHOOK_SECRET")} set', f'path {code("/")} · duplicates by {code("X-GitHub-Delivery")}', "off", "a collaborator with write access"),
        ("gitlab", True, "trigger 4", "token", f'{code("GITLAB_TOKEN")}, one shared token (Developer, api)',
         f'signature (19.0 and later), {code("GITLAB_WEBHOOK_SECRET")} set', f'path {code("/gitlab")} · duplicates by {code("webhook-id")}', "not offered", "Developer or above"),
        ("forgejo", False, "", "", "", "", "", "", ""),
        ("azure", False, "", "", "", "", "", "", ""),
    ]
    frows = []
    for f, armed, by, auth, tok, ver, path, poll, who in FG:
        if armed:
            frows.append([(f'<b>{f}</b>', "c2-first"), (state_line("ok", "done", f"armed by {by}"), "c2-actc"),
                          (f'<span class="c2-cell"><span>{auth}</span><small>{tok}</small></span>', "wide"),
                          (f'<span class="c2-cell"><span>{ver}</span><small>{path}</small></span>', "wide"), (poll, ""), (who, "")])
        else:
            frows.append(("c2-off", [(f'<b>{f}</b>', "c2-first"), (state_line("idle", "minus", "not configured"), "c2-actc"),
                          (f'<span class="muted">No trigger names {f}, so its webhook path answers 404 ("{f} webhooks are not configured").</span>', "wide c2-span"),
                          ("", "hide-phone"), ("", "hide-phone"), ("", "hide-phone")]))
    forges = table([("Forge", ""), ("State", ""), ("Auth", ""), ("Webhook", ""), ("Polling", ""), ("Who may fire", "")], frows, caption="Forges", stack=True)
    forges += f"""<div class="c2-pad2">
  <p class="c2-st tone-idle">{ic('info', 'ic ic--sm')}<span><b>Delivery health is not published.</b> Check the forge's delivery history or the receiver's log on mini1.</span></p>
</div>"""
    p_forges = card("Forges", forges, id_="p-forges", flush=True, sub="where jobs come from",
                    end='<span class="card__sub">Receiver: a host service on mini1, port 8787</span>')

    E_ = [("mini1", "ok", "done", "running", "denies unlisted hosts (doctor, 2h ago)"),
          ("mini2", "ok", "done", "running", "denies unlisted hosts (doctor, 3h ago)"),
          ("build3", "failed", "failed", "missing", "every job here is refused before spend")]
    erows = [[(f'<b>{h}</b>', "c2-first"), (state_line(t, i, s), "c2-actc"), (f'<span class="muted">{n}</span>', "wide")] for h, t, i, s, n in E_]
    allow = ["api.github.com", ".githubusercontent.com", "gitlab.acme.dev", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "mcp.example.com", "api.acme.dev"]
    egress = f"""<div class="c2-pad3">{facts([("Posture", f'on: jobs reach out only through the proxy ({code("PI_EGRESS")} unset)')], 1)}
  <p class="c2-sub">Allowlist, {code('egress-allowlist.conf')}</p>
  <p class="c2-names">{''.join(code(h) for h in allow)}<span class="muted">and 6 more</span></p></div>
{table([("Host", ""), ("Proxy", ""), ("Checked", "")], erows, caption="Egress proxy per host", stack=True)}"""
    p_egress = card("Egress", egress, id_="p-egress", flush=True, sub="what jobs may reach")

    ep_rows = [[(f'<b class="code">ollama-mini2</b>', "id c2-first"), (code("mini2.lan:11434"), ""), ("keyless", ""), (f'<svg class="c2-slots" viewBox="0 0 40 10" role="img" aria-label="1 of 2 slots in use"><circle class="c2-on" cx="5" cy="5" r="4.5"/><circle class="c2-offs" cx="17" cy="5" r="4"/></svg> 1 of 2', "c2-actc")],
               [(f'<b class="code">vllm-build3</b>', "id c2-first"), (code("10.0.0.5:8000"), ""), ("keyless", ""), (f'<svg class="c2-slots" viewBox="0 0 40 10" role="img" aria-label="0 of 4 slots in use"><circle class="c2-offs" cx="5" cy="5" r="4"/><circle class="c2-offs" cx="17" cy="5" r="4"/><circle class="c2-offs" cx="29" cy="5" r="4"/></svg> 0 of 4', "c2-actc")]]
    endpoints = f"""{table([("Endpoint", ""), ("Host and port", ""), ("Key", ""), ("Slots in use", "act")], ep_rows, caption="Model endpoints", stack=True)}
<div class="c2-pad2">
  {banner("attention", "attention", "mini2 reads its own copy of the file, and it does not load",
          'pi-dispatch doctor on mini2 (its own copy of the file, 3h ago) says: <b>endpoint 2: port must be 1 to 65535.</b> Fix: correct the port in model-endpoints.json on mini2, then run <span class="code">pi-dispatch egress render</span>.', small=True)}
  <p class="c2-sub">Provider keys, by name</p>
  <ul class="rows">
    <li class="rowpill">{ic('key', 'ic ic--sm')}<b>anthropic</b><span class="code">ANTHROPIC_API_KEY</span><span class="end"><span class="muted">from .env</span></span></li>
    <li class="rowpill">{ic('key', 'ic ic--sm')}<b>kimi-coding</b><span>from the pi login on each host</span></li>
  </ul>
</div>"""
    p_ep = card("Model endpoints", endpoints, id_="p-endpoints", flush=True, sub=f'{code("model-endpoints.json")} · slots shared by the fleet')

    mcp = f"""<ul class="rows">
  <li class="rowpill">{ic('plug', 'ic ic--sm')}<b class="code">linear</b><span>http · {code('mcp.example.com')}</span><span class="end"><span class="muted">codemode</span>{chip('on', 'ok', 'done')}</span></li>
  <li class="rowpill">{ic('plug', 'ic ic--sm')}<b class="code">docs</b><span>stdio · {code('npx docs-mcp')}</span><span class="end"><span class="muted">deferred</span>{chip('off', '', 'minus')}</span></li>
  <li class="rowpill tone-failed">{ic('failed', 'ic ic--sm')}<b class="code">dispatch-notes</b><span class="tinted">refused: names starting with dispatch are reserved</span></li>
  <li class="rowpill">{ic('git', 'ic ic--sm')}<b class="code">forge</b><span>github-mcp-server 2.0.2; merge and approve tools withheld</span></li>
</ul>
<p class="c2-gap2 card__sub">References {code('LINEAR_API_KEY')}. Changed with {code('pi-dispatch import-pi')}.</p>"""
    p_mcp = card("MCP servers", mcp, id_="p-mcp", sub="from the overlay's mcp.json")

    notify = f"""<ul class="c2-list">
  <li>{ic('comment')}<span><b>Forge comments:</b> on. Trigger 3 also keeps a <b>status comment</b> up to date while it runs.</span></li>
  <li>{ic('bell')}<span><b>Failure hook:</b> {code('PI_ON_FAILURE')} → {code('…/ntfy-page')}, once per paid failure.</span></li>
</ul>
<p class="c2-gap2 c2-st c2-quiet tone-ok">{ic('done', 'ic ic--sm')}<span>Last ran 15:10 UTC for {code('gh-f0c2')}, failed ({code('container-never-started')}) on mini1; it answered in 0.4 s.</span></p>"""
    p_notify = card("Notifications", notify, id_="p-notify")

    env = facts([
        (code("PI_MAX_COST_USD"), "$2.00 per job <span class=\"muted\">· .env</span>"),
        (code("PI_CONCURRENCY"), '<span class="muted">unknown (worker env or default): each host reads its own</span>'),
        (code("PI_BACKENDS"), "local, podman <span class=\"muted\">· .env</span>"),
        (code("PI_WORKER_NAME"), "set on mini1, mini2, build3"),
        (code("VALKEY_URL"), f'<span class="c2-st tone-attention">{ic("attention", "ic ic--sm")}<span>this shell and the .env disagree; the service reads the .env</span></span>'),
    ], 1)
    p_env = card("Deployment environment", env + '<p class="c2-gap2 card__sub">Read from the deployment\'s .env. Edit the file and restart the service; nothing here writes it.</p>', id_="p-env")

    pkgs = f"""<p class="muted">Staged 1 Oct, 09:12 UTC, by pi setup.</p>
<ul class="rows c2-gap2"><li class="rowpill">{ic('queue', 'ic ic--sm')}<b class="code">pi-lint@1.4.2</b></li><li class="rowpill">{ic('queue', 'ic ic--sm')}<b class="code">pi-test-runner@0.9.0</b></li></ul>
<p class="c2-gap2 card__sub">They load into every job except triggers that set {code('"packages": false')} (1 does). Staged with {code('pi-dispatch import-pi --with-packages')}.</p>"""
    p_pkgs = card("Staged pi packages", pkgs, id_="p-packages", sub="2")

    inner = top + f'<div class="cols"><div class="stack">{p_forges}{p_egress}{p_ep}</div><div class="stack">{p_notify}{p_mcp}{p_env}{p_pkgs}</div></div>'
    return shell("Configuration", inner, "Connections", sub="Where jobs come from, what they may reach, and who hears about failures. Names and hosts only.", back="Configuration")

CO_CSS = COMMON_CSS + """
.c2-pad2 { padding: var(--space-4) var(--space-5) var(--space-5); border-top: 1px solid var(--line); display: grid; gap: var(--space-3); }
.c2-pad2 .c2-sub { margin: var(--space-2) 0 0; }
.c2-pad3 { padding: 0 var(--space-5) var(--space-4); }
.c2-pad2 > .c2-st { font-weight: 500; color: var(--ink-muted); }
.c2-pad2 > .c2-st b { color: var(--ink); }
#p-forges .tbl td, #p-egress .tbl td { vertical-align: top; }
#p-forges tr.c2-off td { background: var(--surface-2); }
.c2-st.c2-quiet { color: var(--ink-muted); font-weight: 500; }
.c2-st.c2-quiet .ic { color: var(--tone-ink); }
#p-env .fact { grid-template-columns: 150px minmax(0, 1fr); }
#p-env .fact dt .code { font-size: 12px; }
.c2-slots { width: 40px; height: 10px; vertical-align: -1px; margin-right: 4px; }
.c2-on { fill: var(--running); }
.c2-offs { fill: none; stroke: var(--line-strong); stroke-width: 1.5; }
.c2-names .muted { font-size: 12px; align-self: center; }
#p-mcp .rowpill { min-height: 36px; padding-top: 5px; padding-bottom: 5px; border-radius: var(--radius-md); line-height: 17px; }
@media (min-width: 761px) { #p-forges td.c2-span { white-space: normal; } }
@media (max-width: 760px) {
  .c2-pad2 { padding: var(--space-4); }
  .c2-pad3 { padding: 0 var(--space-4) var(--space-3); }
  #p-forges .card__head .end { margin-left: 0; }
  #p-mcp .rowpill, #p-endpoints .rowpill { flex-wrap: wrap; }
  .tbl--stack tr.c2-off { background: var(--surface-2); }
  #p-forges .tbl--stack tr.c2-off td { background: transparent; }
  #p-env .fact { grid-template-columns: 132px minmax(0, 1fr); }
}
"""

# =====================================================================================
# 5. PROJECT DETAIL: billing
# =====================================================================================
def size_chart():
    """Peak memory of 23 runs (dots) against the size given (8 GiB line) and the suggestion (4 GiB, dashed). y: 0..9 GiB."""
    peaks = [1.4, 1.9, 1.2, 2.0, 1.6, 1.8, 2.3, 1.1, 1.5, 1.7, 2.1, 1.3, 1.9, 1.6, 2.2, 1.0, 1.8, 1.5, 2.0, 1.7, 1.4, 1.9, 1.6]
    H = 9.0
    y = lambda g: 100 - g / H * 100
    dots = "".join(f'<circle class="c2-pk" cx="{3 + i * 94 / (len(peaks) - 1):.1f}%" cy="{y(p):.1f}%" r="4"/>' for i, p in enumerate(peaks))
    return f"""<svg class="c2-chart" role="img" aria-label="Peak memory of the last 23 runs, 1.0 to 2.3 GiB, against a size of 8 GiB; the suggestion is 4 GiB">
  <line class="c2-grid0" x1="0" x2="100%" y1="{y(0):.1f}%" y2="{y(0):.1f}%"/>
  <line class="c2-size" x1="0" x2="100%" y1="{y(8):.1f}%" y2="{y(8):.1f}%"/>
  <line class="c2-sugg" x1="0" x2="100%" y1="{y(4):.1f}%" y2="{y(4):.1f}%"/>
  <text class="c2-ct" x="0" y="{y(8) - 4:.1f}%">size 8 GiB</text>
  <text class="c2-ct c2-ct--s" x="0" y="{y(4) - 4:.1f}%">suggested 4 GiB</text>
  {dots}
</svg>
<div class="keyrow"><span><i class="c2-k c2-k--pk"></i>peak of one run</span><span><i class="c2-k c2-k--size"></i>size given</span><span><i class="c2-k c2-k--sugg"></i>suggestion</span><span>a red dot would be an out-of-memory kill; there are none</span></div>"""

def project():
    kpis = f"""<div class="cards-3">
  <section class="card" id="p-proj-spend" data-panel><div class="card__head"><h2>Spend this week</h2></div>
    <div class="c2-kv"><b>$6.10</b><span>+ $2.00 held, of a $25.00 share</span></div>
    {meterrow("Allocation share", "this week", 8.10 / 25, "$8.10", "$25.00")}</section>
  <section class="card" id="p-proj-runs" data-panel><div class="card__head"><h2>Runs, last 24 hours</h2></div>
    <div class="c2-kv"><b>11</b><span>8 completed, 1 refused, 1 cancelled, 1 in line</span></div>
    <p class="c2-st tone-refused">{ic('refused', 'ic ic--sm')}<span>gh-e9a0 refused on build3: the egress proxy is not running.</span></p></section>
  <section class="card" id="p-proj-size" data-panel><div class="card__head"><h2>Job size</h2></div>
    <div class="c2-kv"><b>8 GiB</b><span>and 4 CPUs per job, from the project row</span></div>
    <p class="c2-st tone-attention">{ic('attention', 'ic ic--sm')}<span>Larger than its runs use: p95 peak 2.1 GiB. A smaller size is suggested.</span></p></section>
</div>"""

    M = [("github:acme/billing", "git", "repository", "18 runs this week", "15:30 UTC"),
         ("gitlab:acme/billing-ui", "git", "repository", "6 runs this week", "13:49 UTC")]
    mrows = "".join(f'<li class="rowpill">{ic(i, "ic ic--sm")}<b class="code">{E(n)}</b><span>{k}</span><span class="end">{r} · last {l}</span></li>' for n, i, k, r, l in M)
    members = f"""<ul class="rows">{mrows}</ul>
<form class="c2-form c2-gap" aria-label="Edit the members of billing">
  <div class="field"><label for="pm-members">Members, one repository or folder per line</label>
    <textarea id="pm-members" class="textarea input--code">github:acme/billing
github:acme/billing-worker</textarea></div>
  <div class="c2-act"><button class="btn btn--primary" type="button">Preview the edit</button><span class="field__hint">Name a repository with its forge (github:owner/name) or a folder by its absolute path.</span></div>
</form>
<div class="c2-gap">{diff("…/deploy/projects.json", [("ctx", '{ "id": "billing",'), ("ctx", '  "members": ['), ("ctx", '    "github:acme/billing",'),
                                                    ("del", '    "gitlab:acme/billing-ui"'), ("add", '    "github:acme/billing-worker"'), ("ctx", '  ] }')])}</div>
<div class="c2-gap2">{confirm("safe", "Edit project billing",
    ["<b>github:acme/billing-worker joins</b>: its runs record billing from their next pickup, and count against billing's rows.",
     "<b>gitlab:acme/billing-ui leaves the project</b>: a project:billing row no longer counts it, which widens what it may spend.",
     "Records already written keep billing. Audited as <b>project-edit</b>."],
    "Put gitlab:acme/billing-ui back and remove billing-worker", "Confirm: edit billing")}</div>"""
    p_members = card("Members", members, id_="p-proj-members", sub="2 repositories")

    size = f"""{size_chart()}
<ul class="c2-list c2-gap">
  <li class="tone-attention">{ic('attention')}<span><b>Memory: suggest 4 GiB.</b> The p95 peak is 2.1 GiB over the last 23 runs, and none reached the limit.</span></li>
  <li class="tone-attention">{ic('attention')}<span><b>CPUs: suggest 2.</b> The median run used 0.9 cores. It was held back 4% of its time by its host's CPU ceiling, which a job's CPUs do not change.</span></li>
</ul>
<p class="c2-sub">The exact call</p>
{cmd('dispatch_limit_edit {"index": 2, "memory": "4g", "cpus": 2}')}
<div class="c2-gap2 c2-act">{btn("Preview this size", "primary", sm=False)}<span class="field__hint">Applies to scoped limits row 2, project:billing.</span></div>"""
    p_size = card("Job size", size, id_="p-proj-sizing", sub="peak memory per run, last 30 days")

    R = [("gh-e9a0", "acme/billing#260", "refused", "15:30", "not metered"), ("gh-ebd7", "acme/billing#259", "completed", "14:48", "$0.36"),
         ("gl-9a2c", "acme/billing-ui!405", "completed", "13:49", "$0.18"), ("gh-7cdf", "acme/billing#258", "completed", "12:39", "$0.40"),
         ("gh-4a7e", "acme/billing#290", "cancelled", "10:59", "not metered")]
    rrows = [[(runlink(j), "id c2-first"), (f'<a class="link" href="#">{E(t)}</a>', "wide"), (badge(o), "c2-actc"), (f"{a} UTC", "when"), (c, "num")] for j, t, o, a, c in R]
    p_runs = card("Recent runs", table([("Run", ""), ("Target", ""), ("Outcome", ""), ("Ended", ""), ("Cost", "num")], rrows, caption="Recent runs of billing", stack=True)
                  + '<p class="tbl-foot"><a class="link" href="#">All 11 in Runs, filtered to billing</a></p>', id_="p-proj-recent", flush=True, sub="last 24 hours")

    alloc = f"""{facts([("Weight", "3 of 7 <span class=\"muted\">(web 2, api 1, ops 1)</span>"), ("Floor", "$10.00 a week"),
                     ("Share", "$25.00 of the $100.00 weekly envelope"), ("Plan", f'{code("3f9a1c…")} by portfolio-job, applied Mon 06:04 UTC, until Mon 12 Oct'),
                     ("Refused by the split", "none this week")], 1)}
<p class="c2-gap2"><a class="link" href="#">Open the budget split</a></p>"""
    p_alloc = card("Allocation", alloc, id_="p-proj-alloc")

    lim = f"""{facts([("Row 2", f'{code("project:billing")} 8 GiB memory, 4 CPUs'), ("Jobs a day", '<span class="muted">no cap on this project</span>'),
                     ("At once", '<span class="muted">not set; one job per folder always</span>')], 1)}
<p class="c2-gap2"><a class="link" href="#">Open scoped limits</a></p>"""
    p_lim = card("Limits", lim, id_="p-proj-limits")

    bund = f"""{facts([("Bundle", f'{code("billing")} via {code("vault-bundle")} <span class="muted">(dotenv)</span>'),
                      ("Last received", f'<span class="c2-names">{code("STRIPE_KEY")}{code("DB_URL")}{code("SENTRY_DSN")}</span>'),
                      ("Opted out", "trigger 4"), ("Fork reviews", "no")], 1)}
<p class="c2-gap2"><a class="link" href="#">Open secrets</a></p>"""
    p_bund = card("Secret bundle", bund, id_="p-proj-bundle", sub="names only")

    trg = f"""<ul class="rows">
  <li class="rowpill">{ic('comment', 'ic ic--sm')}<b>3</b><span>comment {code('"@pi"')} → fix</span><span class="end">9 runs</span></li>
  <li class="rowpill">{ic('pr', 'ic ic--sm')}<b>4</b><span>pull request on gitlab → review</span><span class="end">2 runs</span></li>
</ul>"""
    p_trg = card("Triggers that ran here", trg, id_="p-proj-triggers", sub="last 24 hours")

    delete = f"""<p class="muted">Delete project billing: refused while scoped limits row 2 ({code('project:billing')}) or the secret bundle {code('billing')} names it. Remove those first.</p>
<div class="c2-gap2 c2-act"><button class="btn btn--danger" type="button" aria-disabled="true">Delete billing</button></div>"""
    p_del = card("Delete", delete, id_="p-proj-delete")

    inner = kpis + f'<div class="cols"><div class="stack">{p_members}{p_size}{p_runs}</div><div class="stack">{p_alloc}{p_lim}{p_bund}{p_trg}{p_del}</div></div>'
    title = 'billing'
    sub = f'<span class="c2-lead">{tag("billing")}<span class="muted">2 members · id</span><span class="code">billing</span><span class="muted">in</span><span class="code">…/deploy/projects.json</span></span>'
    return shell("Configuration", inner, title, sub=sub, end=btn("Open in Runs", "", "runs", sm=False), back="Configuration")

PR_CSS = COMMON_CSS + """
.c2-chart { display: block; width: 100%; height: 150px; overflow: visible; }
.c2-grid0 { stroke: var(--line); }
.c2-size { stroke: var(--ink-muted); stroke-width: 2; }
.c2-sugg { stroke: var(--attention); stroke-width: 2; stroke-dasharray: 6 5; }
.c2-pk { fill: var(--running); }
.c2-ct { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.c2-ct--s { fill: var(--attention-ink); }
.c2-k { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--ink-muted); }
.c2-k--pk { width: 9px; height: 9px; border: 0; border-radius: 50%; background: var(--running); }
.c2-k--sugg { border-top: 2px dashed var(--attention); }
.cards-3 .card .c2-kv { margin-bottom: var(--space-3); }
.cards-3 .card .c2-st { font-weight: 550; }
#p-proj-members .rowpill .end { font-size: 12px; }
@media (max-width: 760px) { #p-proj-members .rowpill { flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); } #p-proj-members .rowpill .end { margin-left: 26px; } }
"""

# =====================================================================================
# write
# =====================================================================================
if __name__ == "__main__":
    write("TriggerDetail", card_marker("Configuration", 2700, 1440, "One trigger: what starts it, every run field and where it changes, its runs, its instructions, an edit preview, and how schedules and one-shots read"),
          "Trigger 3", trigger_detail(), TD_CSS)
    write("TriggerEditor", card_marker("Configuration", 2030, 1440, "Add a trigger: the kinds, the forge's own words, run options, and the preview beside the form"),
          "Add a trigger", trigger_editor(), TE_CSS)
    write("SecretsScreen", card_marker("Configuration", 1970, 1440, "Secret profiles and bundles, names only: source, resolver roots, users, last resolve, hosts, a removal preview and a refused path"),
          "Secrets", secrets(), SE_CSS)
    write("ConnectionsScreen", card_marker("Configuration", 1710, 1440, "Forges, egress per host, model endpoints, MCP servers, notifications, the deployment environment and staged packages"),
          "Connections", connections(), CO_CSS)
    write("ProjectDetail", card_marker("Configuration", 2160, 1440, "One project: spend against its share, members with an edit preview, the size suggestion and its exact call, allocation, limits, bundle"),
          "billing", project(), PR_CSS)

README = {
"TriggerDetail": """One trigger on its own page: what starts it, every run field with where it can change, the runs it started, its instructions, and an edit that previews as a diff.

**How a person uses it.**
- **Start.** The title says the trigger in one line: kind, phrase, flow, forge and row number (rows are numbered 1 to 7 everywhere). Open in Runs filters the Runs page to it. Delete is outlined red until its confirm step.
- **What starts it.** Kind, phrase, how a comment can pick another flow, the one-comment-trigger-per-forge rule, and who may fire it.
- **Runs it started.** The count and metered spend for 24 hours, then the last five runs with project, outcome and reason sentence.
- **What it runs.** Every `run` field, set or not, in two groups:
  - *Edit here*: flow, venue, provider, model, maxTurns, progress, statusComment, steer and recover, which the Edit form changes;
  - *By hand*: everything else, including the job cap, allowed models, MCP servers, secrets and the bundle opt-out, which only the triggers file sets.
- **Edit.** Changing the venue previews the triggers file as a diff, then a confirm bar with the plan's own line, what it means for runs in line, the undo and the ticket.
- **Instructions.** The trigger's instructions, quoted and escaped.
- **Other kinds.** A cron trigger shows its next fire and health (on time, overdue, stalls N of 3). A one-shot shows armed or "spent by" a run, and how to re-arm it. Fire now is a paid action with its reserve sentence.
- **Before you change it.** The trigger-skew rule with the jobs it would refuse now, renumbering, and the file-trouble sentence that quotes doctor.

A viewer sees the same facts and runs, and no Edit, Delete or Fire now.

**Panels.** `p-trigger-on`, `p-trigger-runs`, `p-trigger-run`, `p-trigger-edit`, `p-trigger-trust`, `p-trigger-kinds`, `p-trigger-change`.

**The server provides.**
- The trigger's display record, including the fields the current record leaves out: `task`, `repository`, `reviewState`, `waitFor`, `awaitInput`, `github`, `progress`, `statusComment`, `recover` and `steer`.
- The deployment defaults it falls back to.
- Its runs in the window, and the jobs from it now in line.
- For cron: the next fire, overdue time and stall count. For one-shots: `on.disarmed` with its time and job.
- The newest named doctor check when the file does not load.
- For the edit: the diff, the plan line, the undo plan and a 5-minute ticket.

**Why it works this way.**
- **Who may start it.** A collaborator with write access who comments. A comment from anyone else, or from a bot, starts nothing.
- **Checked on every delivery:** the signature (HMAC with `WEBHOOK_SECRET`), the bot-loop guard, the commenter's permission, duplicates (by `X-GitHub-Delivery`, 31 days), quiet hours, the job image, default-branch protection and the spend caps.
- **Keeps a session.** The transcript stays in the session store on the host that ran it for 14 days, and the next run on the same issue continues it.
- **Never merges.** A run opens or updates a pull request; a person merges it.
- These hold for every comment trigger, so the page shows the trigger's own facts and leaves the rules here.

**Fixture note.**
- **From the fixture:** trigger 3 (comment "@pi", flow fix, github, keeps a session, has instructions) and the runs gh-e9a0, gh-9575, gh-ebd7, gh-7cdf and gh-4a7e. Every card numbers triggers from 1, as this page does.
- **Sample values:** progress and statusComment on trigger 3, the instructions text, the 24-hour totals, gh-c9e1 as a job from it, the cron timings, the slip example, the spent one-shot gh-40a1, and the doctor quote.
- **Proposed, not in the console today:** Fire now (the CLI has `pi-dispatch run --trigger`).""",

"TriggerEditor": """Add a trigger with a form that knows the five kinds and each forge's own words, then preview it as the lines it adds to the triggers file.

**How a person uses it.**
1. **What starts it.** Pick a kind (cron, label, comment, pull request, issue). The fields change with it.
   - For a pull request: the forge, its actions in that forge's words, the review states, and labels when `labeled` is picked.
   - The hint says what the forge does with them: a review trigger fires on every verdict unless narrowed.
2. **What it runs.** Flow (with where the skill must live), venue (only blessed venues), provider and model, and the turn budget. Blank fields say the default they fall back to.
3. **Run options.** Report phases, status comment, take messages and recover. Each names its `run.` key and what it needs.
4. **Set by hand.** One line says that some fields are set by hand in the triggers file only, with a link to which ones.
5. **Preview the add.** The preview sits beside the form: the new entry as added lines, then a confirm bar with the trigger in one sentence, who can fire it, the per-run reserve, where it is written, and the undo (delete row 8).

For people who know the file, *Or paste the add tool's fields as JSON* keeps the old textarea.

A refusal shows under the field it is about, in the loader's words, ending "Nothing was changed."

A viewer never sees this page.

**Panels.** `p-trigger-add`, `p-kinds`, `p-forge-words`, `p-refusals`. The preview is the shared confirm slot.

**The server provides.**
- The blessed venues and the deployment defaults.
- The forges that have webhooks configured.
- The flows found in the repository skill tiers, for suggestions.
- For a preview: the entry as JSON, the diff against the file, the plan summary, the undo plan and the ticket.
- For a refusal: the field and the loader's sentence.

**Why it works this way.**
- **The five kinds.** Cron: a schedule, in a local folder (needs an id, a pattern of 5 or 6 fields, a folder and a task). Label: a label on an issue, never a pull request (any or all labels; none only narrows). Comment: a phrase in a comment, one comment trigger per forge. Pull request: a pull request event, a submitted review, or a close (actions in the forge's words). Issue: an issue closing (the close word; a number and `once` for a one-shot).
- **Pull request words per forge.** The form offers only these. GitHub: `labeled opened synchronize reopened review_submitted closed` (labels with labeled; closed counts a merge). GitLab: `open update reopen approved close` (a label is an update; a merge does not fire close). Forgejo: `label_updated opened synchronized reopened closed`. Azure: `created updated` (no label rule, no issue or close-only rule).
- **Set by hand, never by a tool:** `run.maxCostUsd`, `run.models`, `run.mcp`, `run.secretBundle`, `run.resume`, `run.awaitInput`, `run.image`, `run.secrets`, `run.waitFor` and `run.replicas`. A per-job dollar cap, allowed models and MCP servers decide what a trigger can spend or reach.
- **What the form refuses**, each by name and ending "Nothing was changed.":
  - backend 'openshell' is not blessed by this deployment (PI_BACKENDS: local, podman);
  - unknown trigger kind 'push';
  - the console cannot set run.maxCostUsd: a trigger's per-job dollar cap is set by hand in the triggers file, never by a tool;
  - a pull request trigger on github that names labeled needs a label predicate (any or all);
  - once needs number: a one-shot names the issue or pull request it waits for;
  - github already has a comment trigger (row 3), so a second one does not load.

**Fixture note.**
- **From the repo:** the per-forge action words, the five kinds and what each needs, and the first three refusals (the unblessed backend, the unknown kind, the cannot-set-maxCostUsd sentence).
- **Sample:** the other three refusals, which are worded for this design from the loader's rules, and trigger 8, address-review.""",

"SecretsScreen": """Secret profiles and project bundles as names and states, never values: where each is declared, whether its resolver may run, who uses it, when it last resolved, and which hosts can serve it.

**How a person uses it.**
- **Problems first.** A red banner names the worst one in a sentence (here a profile declared in two places, which refuses every secrets job) with its fix.
- **Secret profiles.** One row per profile:
  - Source: the .env or the settings overlay, or ambiguous;
  - Resolver roots: inside, outside, not bounded;
  - Triggers and Projects that use it;
  - Last resolve, with its run;
  - Served by: the live hosts that advertise it.
  Rows that refuse jobs are tinted, and each says so in words. Remove opens a red confirm under the table with the settings diff (paths by last folder only) and what it refuses after: "Every trigger naming it is refused before spend after this, rather than running without its secrets."
- **Secret bundles.** Each bundle's project, resolver and its declared state, fork reviews, OpenShell endpoints, the triggers that opted out, and the variable names the newest run received.
- **Declare a resolver.** One form for a profile or a bundle resolver. It refuses a relative path in the console's words, and its hint names the resolver roots.

A viewer sees the tables, with no Remove or forms.

**Panels.** `p-secret-profiles`, `p-secret-bundles`, `p-secret-add`.

**The server provides.**
- Per profile: source, roots judgement, triggers and projects using it, the last resolve with its run, and the hosts advertising `s:<name>`.
- Per bundle: project, resolver and declared state, format, fork reviews, endpoints by name and host, opted-out triggers, and the newest received variable names.
- For writes: the settings diff with resolver paths shortened to their last folder, the effect sentence and the ticket.

**Why it works this way.**
- **A profile** resolves a trigger's own `run.secrets`: one reference per variable, at most 16.
- **A bundle** hands every variable its resolver prints to each trigger-made job of the project: at most 64 variables, 256 KiB of output, 64 KiB per value.
- **A run goes without its bundle** when it is a hand run, a chained run, opted out, a fork's pull request (unless fork reviews is on), or its head could not be verified. Its run page says which.
- **The resolver runs** as the worker's account, once per reference, and only from inside `PI_SECRET_RESOLVER_ROOTS`.
- **Never shown:** a reference, a value, or a resolver's full path. Viewers see names and states.

**Fixture note.** The fixture declares no secret profile or bundle, so everything here is sample: the profiles default, vault, ops-1p and stripe; the bundles billing, web and legacy; and their variables, hosts and runs. The sentences follow the console's own (`read-model.mjs`, `write-plans.mjs`). The all-caps words there (AMBIGUOUS, OUTSIDE, PRE-SPEND, EXECUTES) are written in sentence case.""",

"ConnectionsScreen": """Where jobs come from and what they may reach: forges and their webhooks, egress per host, model endpoints and provider keys, MCP servers, staged packages, the deployment environment, and how failures reach people.

**How a person uses it.**
- **Problems first.** A banner names the host whose egress proxy is missing and the run it refused, with the command that fixes it.
- **Forges.**
  - For each armed forge: which triggers arm it, the auth source and per-job token, how deliveries are verified and de-duplicated, polling, and who may fire.
  - Forges no trigger names collapse to one line saying their path answers 404.
  - One line says delivery health is not published and where to look instead.
- **Egress.** The posture, the allowlist (first hosts, then "and N more"), and each host's proxy with its last doctor check.
- **Model endpoints.** Each endpoint's host and port, whether it is keyless, and its slots in use. A banner covers the case where a host's own copy of the file does not load, quoting doctor. Provider keys are listed by variable name and where they come from.
- **Notifications.** Forge comments and the `PI_ON_FAILURE` hook, and when the hook last ran.
- **MCP servers, Deployment environment, Staged pi packages.** All read-only, each with the command or file that changes it. Caps set only in the .env read "unknown (worker env or default)".

Viewers see the same page; nothing on it writes.

**Panels.** `p-forges`, `p-egress`, `p-endpoints`, `p-notify`, `p-mcp`, `p-env`, `p-packages`.

**The server provides.**
- Per forge: the triggers naming it, the auth source, whether verification secrets are set (names only), the webhook mode and path, and the polling settings.
- Per host: the egress proxy state and the newest egress doctor lines.
- The model endpoints file and live slot leases, and the provider key sources.
- The overlay MCP servers with their refusals, and the staged packages receipt.
- The `PI_ON_FAILURE` hook path and its last `on_failure` log line.
- The .env keys the console reads, and any shell-versus-.env disagreement.

**Why it works this way.**
- **Delivery health.** The receiver has no health check of its own, so the console cannot say whether deliveries arrive. The forge's delivery history (401, 404 and 503 answers) and the receiver's log can.
- **Egress.** With egress on, each job gets its own internal network and reaches out only through the proxy: HTTPS (443) and plain HTTP (80) to listed hosts, plus the declared model endpoints. A leading dot covers subdomains.
- **Notifications.** pi-dispatch sends none of its own. Forge comments are always on: one fixed sentence on the issue for a paid failure, and one when a run stops to ask. The failure hook runs once per paid failure with "job, outcome, reason, host" and has 10 s to answer; it never runs for completions, free refusals, recovered retries or a cancel.
- **MCP servers** are named by reference only; values never reach the page, and there is no form for them here.

**Fixture note.**
- **From the fixture:** build3's missing proxy, gh-e9a0, the linear MCP server, and the forges named by triggers 1 to 7.
- **Sample:** the receiver port, the allowlist hosts, both model endpoints and mini2's broken copy, the docs and dispatch-notes servers, the two staged packages, the hook path, and its last run for gh-f0c2.
- **Known repo gaps:** webhook health is not published, and there is no notification setting beyond the hook.""",

"ProjectDetail": """One project on its own page: what it spent against its share, its members, its job size against what its runs use, and the rows that govern it.

**How a person uses it.**
- **Big numbers.** Three cards answer the first questions:
  - this week's spend against the allocation share;
  - the last 24 hours of runs, with the worst one named;
  - the job size, flagged when the runs use far less.
- **Members.** Each member repository or folder, with its runs and last run. Editing the list previews the projects file as a diff. The confirm bar says what joining and leaving mean: a member that leaves widens what it may spend.
- **Job size.** Each run's peak memory as a dot against the size given (solid) and the suggestion (dashed); an out-of-memory kill would be a red dot. Under the chart:
  - the memory and CPU verdicts in words;
  - the exact `dispatch_limit_edit` call, with Copy;
  - Preview this size, which goes through the normal confirm.
- **Recent runs.** The last five runs of the project, linked to Runs filtered to it.
- **Side.**
  - Allocation: weight, floor, share and the plan in force.
  - Limits: its scoped rows.
  - Secret bundle: variable names only.
  - The triggers that ran here.
  - Delete, which says why it is refused while a limits row or a bundle names the project.

A viewer sees the numbers, chart and facts, with no forms or Delete.

**Panels.** `p-proj-spend`, `p-proj-runs`, `p-proj-size`, `p-proj-members`, `p-proj-sizing`, `p-proj-recent`, `p-proj-alloc`, `p-proj-limits`, `p-proj-bundle`, `p-proj-triggers`, `p-proj-delete`.

**The server provides.**
- The project's members and runs.
- Spend and held amounts for the window, and the allocation share, weight, floor and plan.
- The scoped-limit rows that name it.
- Per-run peak memory and OOM kills for the last 30 days (at most 50), the size suggestion with its reason and call, and the CPU-ceiling figure.
- The bundle facts, and the reasons a delete would be refused.

**Why it works this way.**
- **Members.** Runs of a member record the project when a worker picks them up, and a record keeps the project it was written with.
- **Sizes are advisory.** Peaks are measured inside the jobs, and nothing changes until a person confirms the call.
- **Triggers.** Forge triggers fire on any member that sends events. A cron trigger runs here when its folder is a member.

**Fixture note.**
- **From the fixture:** the billing members, scoped limits row 2 (8 GiB, 4 CPUs) and the runs gh-e9a0, gh-ebd7, gl-9a2c, gh-7cdf and gh-4a7e.
- **Sample:** the spend and share, the weights and plan, the peaks and suggestion, github:acme/billing-worker, the bundle, and the run counts per member.""",
}

if __name__ == "__main__":
    for k, v in README.items():
        readme(k, v)
