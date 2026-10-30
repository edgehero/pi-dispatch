"""Start here: three guide cards that are not console screens. ConceptMap (how the pieces connect and where a person
steps in), Glossary (the words the cards use) and SampleStory (the one deployment every card draws, read from
fixture.py). Pulse kit, no top bar."""
from pulse import *
from fixture import DAY, NOW, PEOPLE, HOSTS, PROJECTS, TRIGGERS, RUNS, OTHER_RUNS

GROUP = "Start here"

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'

def page(title, sub, inner):
    return f"""<a class="skip" href="#main">Skip to content</a>
<main id="main" class="page guide">
{titlebar(title, sub)}
{inner}
</main>"""

# ======================================================================== ConceptMap
def node(x, y, w, h, title, subs, cls="", icon="", tag=None):
    """One box: an icon, a title, one or two lines under it, and a planned or proposed tag as a word."""
    kinds = " ".join(f"cm-n--{c}" for c in cls.split()) if cls else ""
    out = [f'<g class="cm-n {kinds}">', f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12"/>']
    if icon:
        out.append(f'<use href="#i-{icon}" x="{x + 12}" y="{y + 10}" width="16" height="16" class="cm-ic"/>')
    out.append(f'<text class="cm-t" x="{x + 36}" y="{y + 23}">{E(title)}</text>')
    ty = y + 39
    for s in subs:
        out.append(f'<text class="cm-s" x="{x + 36}" y="{ty}">{E(s)}</text>')
        ty += 15
    if tag:
        word, kind = tag
        out.append(f'<text class="cm-tag cm-tag--{kind}" x="{x + 36}" y="{ty}">{E(word)}</text>')
    out.append("</g>")
    return "".join(out)

def edge(d, dashed=False, arrow=True):
    return f'<path class="cm-e{" cm-e--d" if dashed else ""}" d="{d}"{" marker-end=" + chr(34) + "url(#arrow)" + chr(34) if arrow else ""}/>'

def label(x, y, text):
    return f'<text class="cm-el" x="{x}" y="{y}">{E(text)}</text>'

def concept_svg():
    C1, C2, C3, C4 = 16, 372, 718, 1054
    n = []
    # headers
    for x, t in [(C1, "What starts work"), (C2, "Queue and host"), (C3, "The run"), (C4, "Where a person steps in")]:
        n.append(f'<text class="cm-h" x="{x}" y="20">{t}</text>')
    n.append(f'<text class="cm-h" x="{C2}" y="490">What is counted</text>')
    # column 1: what starts work
    n.append(node(C1, 36, 280, 64, "Triggers", ["cron, label, comment, issue,", "pull request: written by hand"], "", "bolt"))
    n.append(node(C1, 116, 280, 50, "The CLI", ["pi-dispatch run, from a shell"], "", "terminal"))
    n.append(node(C1, 182, 280, 64, "Watch rules", ["a finding in logs or alerts"], "", "eye"))
    n.append(node(C1, 262, 280, 64, "Dispatchers", ["start listed jobs, propose triggers"], "proposed", "flows",
                  ("proposed, #776", "proposed")))
    # column 2: queue and host
    n.append(node(C2, 36, 270, 50, "The queue", ["waits for a slot, a time or a check"], "", "queue"))
    n.append(node(C2, 126, 270, 50, "A worker on a host", ["caps checked before anything spends"], "", "fleet"))
    n.append(node(C2, 216, 270, 62, "A venue runs it", ["local, podman or openshell:", "one job, one container"], "", "box"))
    # column 3: the run and how it ends
    n.append(node(C3, 36, 260, 50, "A run and its record", ["outcome, reason, tokens, cost"], "", "runs"))
    OX, OW = 750, 228
    n.append(node(OX, 106, OW, 50, "Completed", ["opens a pull request"], "ok", "done"))
    n.append(node(OX, 166, OW, 50, "Failed", ["the infrastructure gave out"], "failed", "failed"))
    n.append(node(OX, 226, OW, 50, "Refused", ["a rule said no; nothing spent"], "refused", "refused"))
    n.append(node(OX, 286, OW, 50, "Parked", ["awaiting input"], "parked", "parked"))
    n.append(node(OX, 346, OW, 64, "Waiting for approval", ["a named action, then parked"], "parked", "shield"))
    # column 4: where a person steps in
    n.append(node(C4, 36, 290, 50, "Steer or cancel", ["while it runs"], "you", "steer"))
    n.append(node(C4, 92, 290, 50, "Merge the pull request", ["always yours, never automatic"], "you", "git"))
    n.append(node(C4, 146, 290, 50, "Open its sandbox", ["the kept workspace, no credentials"], "you", "terminal"))
    n.append(node(C4, 204, 290, 50, "Re-run", ["its cost is previewed first"], "you", "rerun"))
    n.append(node(C4, 262, 290, 50, "Answer the question", ["the run resumes from its session"], "you", "parked"))
    n.append(node(C4, 320, 290, 64, "Send a drafted answer", ["from an answer rule; you send it"], "you proposed", "edit",
                  ("proposed, #772", "proposed")))
    n.append(node(C4, 394, 290, 64, "Decide the approval", ["approve, or decline with a reason"], "you", "shield"))
    # what is counted
    n.append(node(C2, 502, 606, 50, "Spend against caps", ["every job reserves before it calls a model"], "", "spend"))
    n.append(node(C4, 502, 290, 64, "Touches", ["each run a person acted on"], "proposed", "pie", ("Zero touch, proposed, #770", "proposed")))

    e = []
    # starts -> queue, through one bus: solid for what exists, dashed for planned and proposed
    e.append(edge("M296,68 H334", arrow=False)); e.append(edge("M296,141 H334", arrow=False))
    e.append(edge("M296,214 H334", dashed=False, arrow=False)); e.append(edge("M296,294 H334", dashed=True, arrow=False))
    e.append(edge("M334,68 V141", arrow=False)); e.append(edge("M334,141 V214", arrow=False)); e.append(edge("M334,214 V294", dashed=True, arrow=False))
    e.append(edge("M334,68 H368")); e.append(label(338, 61, "jobs"))
    # queue -> worker -> venue
    e.append(edge("M507,86 V122")); e.append(label(515, 108, "a free slot"))
    e.append(edge("M507,176 V212")); e.append(label(515, 198, "starts it"))
    # venue -> run
    e.append(edge("M642,247 H680 V61 H714")); e.append(label(686, 160, "a run"))
    # run -> how it ends
    e.append(edge("M734,86 V378", arrow=False)); e.append(label(744, 100, "ends as"))
    for cy in (131, 191, 251, 311, 378):
        e.append(edge(f"M734,{cy} H746"))
    # how it ends -> where a person steps in
    e.append(edge("M978,61 H1050")); e.append(label(986, 54, "running"))
    e.append(edge("M978,131 H1012", arrow=False)); e.append(edge("M1012,117 V171", arrow=False))
    e.append(edge("M1012,117 H1050")); e.append(edge("M1012,171 H1050"))
    e.append(edge("M978,191 H1012 V251 H978", arrow=False)); e.append(edge("M1012,229 H1050"))
    e.append(edge("M978,311 H1012", arrow=False)); e.append(edge("M1012,287 V311", arrow=False))
    e.append(edge("M1012,311 V352", dashed=True, arrow=False))
    e.append(edge("M1012,287 H1050")); e.append(edge("M1012,352 H1050", dashed=True))
    e.append(edge("M978,378 H1012 V426 H1050"))
    # counted
    e.append(edge("M507,278 V498")); e.append(label(515, 400, "reserved first"))
    e.append(edge("M1199,458 V498", dashed=True)); e.append(label(1207, 482, "each one counted"))

    desc = ("Triggers, the CLI, watch rules and proposed dispatchers put jobs on the queue. A worker on a host takes "
            "one when a slot is free, and a venue runs it in one container. It becomes a run with a record, which ends "
            "completed, failed, refused or parked, or waits for approval. A person steers or cancels a running run, "
            "merges the pull request, opens the sandbox, re-runs, answers the question or sends a drafted answer, and "
            "decides approvals. Every job reserves spend against caps first, and the runs a person acted on are counted as "
            "touches.")
    return (f'<svg class="cm-svg" viewBox="0 0 1360 580" role="img" aria-labelledby="cm-title cm-desc">'
            f'<title id="cm-title">How pi-dispatch fits together</title><desc id="cm-desc">{E(desc)}</desc>'
            f'{"".join(e)}{"".join(n)}</svg>')

def swatch(cls):
    kinds = " ".join(f"cm-n--{c}" for c in cls.split()) if cls else ""
    return f'<svg class="cm-sw" width="30" height="18" viewBox="0 0 30 18" aria-hidden="true"><g class="cm-n {kinds}"><rect x="1" y="1" width="28" height="16" rx="5"/></g></svg>'

LEGEND = [("", "Solid: in pi-dispatch today"), ("planned", "Dashed blue: planned, with its issue"),
          ("proposed", "Dashed grey: proposed, nothing decided"), ("you", "Violet edge: a person acts here"),
          ("ok", "Tinted: how a run ends, always with its word")]

LIST = [
    ("What starts work", [("bolt", "Triggers: cron, label, comment, issue and pull request rules, written by hand.", ""),
                          ("terminal", "The CLI: pi-dispatch run, from a shell.", ""),
                          ("eye", "Watch rules: a finding in logs or alerts starts a read-only job.", ""),
                          ("flows", "Dispatchers: start listed jobs and propose triggers.", "proposed")]),
    ("Queue and host", [("queue", "The queue holds each job until a slot, a time or a check is free.", ""),
                        ("fleet", "A worker on a host takes it, after the caps are checked.", ""),
                        ("box", "A venue (local, podman or openshell) runs one job in one container.", "")]),
    ("The run", [("runs", "It becomes a run with a record: outcome, reason, tokens and cost.", ""),
                 ("done", "Completed, failed or refused, always with its word.", ""),
                 ("parked", "Parked: it ended to wait for an answer.", ""),
                 ("shield", "Waiting for approval of a named action.", "")]),
    ("Where a person steps in", [("steer", "Steer or cancel while it runs.", ""),
                                 ("git", "Merge the pull request: always yours, never automatic.", ""),
                                 ("terminal", "Open its sandbox: the kept workspace, no credentials.", ""),
                                 ("rerun", "Re-run, with the cost previewed first.", ""),
                                 ("parked", "Answer the question; the run resumes.", ""),
                                 ("edit", "Send a drafted answer from an answer rule.", "proposed, #772"),
                                 ("shield", "Decide the approval.", "")]),
    ("What is counted", [("spend", "Spend against caps: every job reserves before it calls a model.", ""),
                         ("pie", "Touches: each run a person acted on, in Zero touch.", "proposed, #770")]),
]

def concept_list():
    secs = []
    for head, items in LIST:
        lis = "".join(f'<li>{ic(i, "ic ic--sm")}<span>{E(t)}{f" <span class={chr(34)}cm-li__st cm-li__st--{st.split(',')[0]}{chr(34)}>{E(st)}</span>" if st else ""}</span></li>'
                      for i, t, st in items)
        secs.append(f'<div class="cm-sec"><h3>{head}</h3><ul>{lis}</ul></div>')
    return f'<div class="cm-list">{"".join(secs)}</div>'

def concept_page():
    legend = '<ul class="cm-legend">' + "".join(f"<li>{swatch(c)}<span>{w}</span></li>" for c, w in LEGEND) + "</ul>"
    body = f"""<div class="cm-box">{concept_svg()}</div>
  {concept_list()}
  {legend}"""
    inner = card("The map", body, sub="left to right: what starts work, how it runs, how it ends, and where you come in", id_="p-cm-map")
    return page("How pi-dispatch fits together", "One picture of the pieces the cards draw, and where a person steps in.", inner)

CM_CSS = """
.guide .titlebar { margin-top: 0; }
.cm-box { min-width: 0; }
.cm-svg { display: block; width: 100%; height: auto; overflow: visible; }
.cm-h { font-family: var(--font-sans); font-size: 13px; font-weight: 750; fill: var(--ink); }
.cm-n rect { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1; }
.cm-n--you rect { fill: var(--surface); stroke: var(--parked); stroke-width: 1.5; }
.cm-n--ok rect { fill: var(--ok-tint); stroke: var(--ok); }
.cm-n--failed rect { fill: var(--failed-tint); stroke: var(--failed); }
.cm-n--refused rect { fill: var(--refused-tint); stroke: var(--refused); }
.cm-n--parked rect { fill: var(--parked-tint); stroke: var(--parked); }
.cm-n--planned rect { fill: var(--surface); stroke: var(--running); stroke-width: 1.5; stroke-dasharray: 6 4; }
.cm-n--proposed rect { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 3 4; }
.cm-t { font-family: var(--font-sans); font-size: 14px; font-weight: 700; fill: var(--ink); }
.cm-s { font-family: var(--font-sans); font-size: 12px; font-weight: 500; fill: var(--ink-muted); }
.cm-tag { font-family: var(--font-sans); font-size: 11px; font-weight: 750; }
.cm-tag--planned { fill: var(--running-ink); }
.cm-tag--proposed { fill: var(--ink-muted); }
.cm-ic { color: var(--ink-muted); }
.cm-n--ok .cm-ic { color: var(--ok-ink); } .cm-n--failed .cm-ic { color: var(--failed-ink); }
.cm-n--refused .cm-ic { color: var(--refused-ink); } .cm-n--parked .cm-ic, .cm-n--you .cm-ic { color: var(--parked-ink); }
.cm-n--planned .cm-ic { color: var(--running-ink); }
.cm-e { fill: none; stroke: var(--ink-muted); stroke-width: 1.4; }
.cm-e--d { stroke-dasharray: 5 4; }
.cm-el { font-family: var(--font-sans); font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cm-legend { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-muted); }
.cm-legend li { display: inline-flex; align-items: center; gap: 8px; }
.cm-sw { flex: none; }
.cm-list { display: none; }
.cm-sec h3 { font-size: 13px; font-weight: 750; margin: var(--space-4) 0 var(--space-2); }
.cm-sec:first-child h3 { margin-top: 0; }
.cm-sec ul { display: grid; gap: 8px; }
.cm-sec li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; font-size: 13px; line-height: 19px; }
.cm-sec li .ic { margin-top: 2px; color: var(--ink-muted); }
.cm-li__st { font-size: 12px; font-weight: 700; color: var(--ink-muted); }
.cm-li__st--planned { color: var(--running-ink); }
@media (max-width: 760px) {
  .cm-box { display: none; }
  .cm-list { display: block; }
  .cm-legend li:last-child { display: none; }
}
"""

# ======================================================================== Glossary
G = [
    ("Starting work", [
        ("trigger", "A rule in triggers.json that says when work starts (cron, label, comment, issue or pull request) and which flow it runs.", "Triggers, Rules tab", ""),
        ("flow", "The named steps a job follows, such as fix, triage or review.", "Triggers, Runs, Spend", ""),
        ("job", "One piece of work on the queue, made by a trigger, the CLI or a dispatcher. It becomes a run when its container starts.", "Overview, Fleet", ""),
        ("queue", "Where jobs wait in Valkey until a host has a free slot: the shared pi-jobs queue and one per host.", "Overview (Waitlists), Fleet", ""),
        ("in line", "A job that has not started, with the one thing it waits for: a slot, another run, a time or check, or retry backoff.", "Overview", ""),
        ("host", "A machine running a worker (mini1, mini2, build3), with its slots and budget.", "Fleet, Host detail", ""),
        ("slot", "Room for one running job on a host.", "Overview, Fleet", ""),
        ("venue", "How a host runs a job's container: local, podman, openshell or openshell-bind.", "Fleet, Venue detail, Runs", ""),
    ]),
    ("Running", [
        ("run", "A job whose container started, from its start to its outcome.", "Runs, the run page", ""),
        ("run record", "What a run leaves behind: outcome, reason, tokens, cost and times. It holds no issue text.", "Runs, the run page", ""),
        ("re-run", "Start the same issue, flow and model again. A paid action, previewed first.", "The run page", ""),
        ("fork", "Start again from an earlier point in a run's session, optionally with another model.", "Fork a run", ""),
        ("steer", "A message that reaches a running agent at its next turn.", "The run page", ""),
        ("follow up", "A message that waits until the agent would stop, then reaches it.", "The run page", ""),
    ]),
    ("Waiting for a person", [
        ("parked", "A run that ended to wait for a person's answer. Nothing waits in a container meanwhile.", "Parked, Overview", ""),
        ("awaiting input", "The record's reason for a parked run, and its outcome word on the Runs page.", "Runs", ""),
        ("approval", "A run asks permission for a named action and waits until a person approves or declines.", "Parked, with the questions", ""),
    ]),
    ("Sandboxes", [
        ("sandbox", "A fresh container over a run's workspace, with the job's isolation, no credentials and no agent.", "The run page, Sandboxes", ""),
        ("kept workspace", "A run's workspace kept after it ends: 24 hours by default, 7 days when pinned.", "Sandboxes", ""),
        ("prepared sandbox", "A kept workspace with no run behind it, cloned as one trigger's jobs would see it.", "Sandboxes", "proposed, #771"),
    ]),
    ("Zero touch and answers", [
        ("touch", "A run a person had to act on: an answer, an approval, a re-run, a config fix after a refusal, a steer or a cancel.", "Zero touch", "proposed, #770"),
        ("touch rate", "Touched runs out of the runs that ended, per project and repository.", "Zero touch", "proposed, #770"),
        ("zero touch", "A project whose runs needed no person over the window. Merging never counts.", "Zero touch", "proposed, #770"),
        ("answer rule", "A hand-written rule that starts a draft job when a run parks. Current word: earlier cards said \"answerer\".", "Parked with an answer rule", "proposed, #772"),
        ("draft job", "The job an answer rule starts: it classifies the question and drafts an answer from cited sources. A person sends it.", "Parked with an answer rule", "proposed, #772"),
        ("standing answer", "An answer an operator wrote once, which a draft may cite.", "Parked with an answer rule", "proposed, #772"),
    ]),
    ("Watch and dispatchers", [
        ("watch rule", "A trigger that turns a finding in logs or alerts into a read-only job.", "Configuration, Watch", ""),
        ("finding", "One thing a watch rule matched in a stream, with its evidence.", "Watch", ""),
        ("board", "A page a watch rule's jobs propose changes to, and a person adopts.", "Watch board", ""),
        ("dispatcher", "A trigger that reads git changes and infra streams, and may only start listed jobs and propose triggers.", "Triggers, Dispatchers tab", "proposed"),
        ("decision model (Jev)", "A model that answers choice questions with probabilities and no reasons, used to classify.", "Watch board, Parked with an answer rule", ""),
    ]),
    ("Money", [
        ("cap", "A limit on jobs, tokens or dollars per window. A job reserves against it before it calls a model.", "Spend, Overview", ""),
        ("soft hold", "A mark on the job caps (softHoldPct) from which the worker refuses new starts, before the cap itself.", "Spend, Overview", ""),
        ("envelope", "The outer limit you set once: a dollar total for one window and a floor per project.", "Budget split", ""),
        ("allocation", "A project's share inside the envelope, moved by a plan of weights. A job over its share is refused before it spends.", "Budget split", ""),
    ]),
    ("Projects and people", [
        ("project", "A named group of repositories and folders: web, api, billing, ops. Drawn as a tag.", "Every page", ""),
        ("member", "A repository or local folder that belongs to a project.", "Project detail", ""),
        ("operator", "Signed in with an operator token: may write and act.", "Sign-in, Access states", ""),
        ("viewer", "Signed in with a viewer token: sees numbers and states, never run text or controls.", "Run as a viewer", ""),
    ]),
    ("These designs", [
        ("built", "Design status: the screen is in main, with the pull request that shipped it.", "The ribbon on each card", ""),
        ("planned", "Design status: an open issue will build it.", "The ribbon on each card", ""),
        ("proposed", "Design status: drawn so it can be discussed. Nothing is decided.", "The ribbon on each card", ""),
        ("needs a decision", "Design status: it reverses or extends a recorded decision and waits for that issue first.", "The ribbon on each card", ""),
    ]),
]

def glossary_page():
    rows = []
    for sec, items in G:
        rows.append(f'<tr class="gl-sec"><th colspan="3" scope="colgroup">{sec}</th></tr>')
        for term, means, where, st in items:
            stx = f'<span class="gl-st gl-st--{st.split(",")[0]}">{E(st)}</span>' if st else ""
            rows.append(f'<tr><th scope="row" class="gl-term">{E(term)}{stx}</th><td class="wide" data-l="">{E(means)}</td>'
                        f'<td class="gl-where" data-l="Shows on">{E(where)}</td></tr>')
    n = sum(len(i) for _, i in G)
    table = (f'<div class="tbl-wrap"><table class="tbl tbl--stack gl-tbl"><thead><tr><th scope="col">Term</th>'
             f'<th scope="col">What it means</th><th scope="col">Where it shows</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>')
    inner = card("Glossary", table, sub=f"{n} words, grouped by where you meet them", flush=True, id_="p-gl")
    return page("Words used in these designs", "Each word means one thing, on every card.", inner)

GL_CSS = """
.guide .titlebar { margin-top: 0; }
.gl-tbl th.gl-term { position: static; width: 220px; padding: 11px 12px 11px var(--space-5); background: none; color: var(--ink); font-size: 13px; font-weight: 700; white-space: normal; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
.gl-tbl td { vertical-align: top; line-height: 19px; }
.gl-st { display: block; margin-top: 2px; font-size: 11px; font-weight: 700; color: var(--ink-muted); }
.gl-st--planned { color: var(--running-ink); }
.gl-where { width: 240px; color: var(--ink-muted); }
.gl-sec th { position: static; padding: 18px var(--space-5) 8px !important; background: var(--surface-2); color: var(--ink); font-size: 12px; font-weight: 750; border-bottom: 1px solid var(--line); }
@media (max-width: 760px) {
  .gl-tbl tr { grid-template-columns: minmax(0, 1fr); }
  .gl-tbl th.gl-term { display: block; width: auto; padding: 0 !important; border: 0; }
  .gl-where { width: auto; }
  .gl-sec { display: block !important; padding: 0 !important; background: var(--surface-2); }
  .gl-sec th { display: block; padding: 14px var(--space-4) 8px !important; }
}
"""

# ======================================================================== SampleStory
def project_of(target):
    if not target:
        return None
    repo = target.split("#")[0].split("!")[0]
    for p, members in PROJECTS.items():
        if repo in members:
            return p
    return None

STATE = {"sandbox": ("idle", "box", "Open sandbox")}

def outcome_badge(kind):
    if kind in STATE:
        tone, glyph, word = STATE[kind]
        return f'<span class="badge tone-{tone}">{ic(glyph)}{word}</span>'
    return badge(kind)

def run_rows(rows):
    out = []
    for jid, (ended, target, flow, host, ven, kind) in rows:
        p = project_of(target)
        out.append(f'<tr><td class="when" data-l="">{E(ended or "")}</td><td class="id" data-l=""><a href="#">{E(jid)}</a></td>'
                   f'<td class="tgt wide" data-l="">{E(target) if target else "<span class=muted>none</span>"}</td>'
                   f'<td data-l="">{tag(p) if p else ""}</td><td data-l="">{E(flow or "")}</td>'
                   f'<td data-l="">{E(host or "")}</td><td data-l="">{venue(ven) if ven else ""}</td><td data-l="">{outcome_badge(kind)}</td></tr>')
    return "".join(out)

def story_page():
    today = [(k, v) for k, v in RUNS.items() if v[0] != "yesterday"]
    earlier = [(k, v) for k, v in RUNS.items() if v[0] == "yesterday"]
    other = [(k, v) for k, v in OTHER_RUNS.items() if v[0]]
    counts = {}
    for _, v in today:
        counts[v[5]] = counts.get(v[5], 0) + 1
    head = "<thead><tr><th>Ended</th><th>Job</th><th>Target</th><th>Project</th><th>Flow</th><th>Host</th><th>Venue</th><th>Outcome</th></tr></thead>"
    def tbl(rows):
        return f'<div class="tbl-wrap"><table class="tbl tbl--stack ss-tbl">{head}<tbody>{run_rows(rows)}</tbody></table></div>'
    runs = card("The day's runs", tbl(today), sub=f"{len(today)} ended today, newest first", flush=True, id_="p-ss-runs")
    rest = card("Not ended, and from earlier", tbl(other) + tbl(earlier),
                sub="running, waiting and the planned screens' runs; then yesterday's, which some cards still draw", flush=True, id_="p-ss-other")
    hosts = card("Hosts", "<ul class=ss-list>" + "".join(
        f'<li><b class="code">{h}</b><span class="ss-v">{"".join(venue(v) for v in vs)}</span><span class="ss-n">{E(what)}</span></li>'
        for h, (vs, what) in HOSTS.items()) + "</ul>", sub="the first venue is the default", id_="p-ss-hosts")
    projects = card("Projects", "<ul class=ss-list>" + "".join(
        f'<li>{tag(p)}<span class="ss-m">{", ".join(code(m) for m in ms) if ms else "<span class=muted>watch jobs only (#735)</span>"}</span></li>'
        for p, ms in PROJECTS.items()) + "</ul>", id_="p-ss-projects")
    trig = card("Triggers", "<ol class=ss-trig>" + "".join(
        f'<li><span class="ss-tn">{n}</span><span><b>{E(kind)}</b> {E(when)}</span><span class="code">{E(flow)}</span></li>'
        for n, (kind, when, flow) in TRIGGERS.items()) + "</ol>", sub="the number is the same on every card", id_="p-ss-trig")
    people = card("People", "<ul class=ss-list>" + "".join(
        f'<li><b class="code">{p}</b><span class="ss-n">{E(w)}</span></li>' for p, w in PEOPLE.items()) + "</ul>", id_="p-ss-people")
    kpis = f"""<div class="cards-4 ss-kpis">
  {card("The day", f'<p class="kpi"><b>{NOW}</b><span>UTC, {E(DAY)}</span></p>', id_="p-ss-day")}
  {card("Hosts", f'<p class="kpi"><b>{len(HOSTS)}</b><span>{", ".join(HOSTS)}</span></p>', id_="p-ss-nhosts")}
  {card("Projects", f'<p class="kpi"><b>{sum(1 for m in PROJECTS.values() if m)}</b><span>plus shop, planned</span></p>', id_="p-ss-nproj")}
  {card("Runs ended today", f'<p class="kpi"><b>{len(today)}</b><span>{counts.get("completed", 0)} completed, {counts.get("failed", 0)} failed, {counts.get("refused", 0)} refused, {counts.get("awaiting", 0)} parked, {counts.get("cancelled", 0)} cancelled</span></p>', id_="p-ss-nruns")}
</div>"""
    note = (f'<p class="ss-note">{ic("info", "ic ic--sm")}<span>Every card draws this deployment. '
            f'<span class="code">tools/check_fixture.py</span> names any card that draws a run differently.</span></p>')
    inner = f"""{kpis}{note}
<div class="cols"><div class="stack">{runs}{rest}</div><div class="stack">{hosts}{projects}{trig}{people}</div></div>"""
    return page("The sample deployment", "One day at acme, which every card draws. Read from tools/fixture.py.", inner)

SS_CSS = """
.guide .titlebar { margin-top: 0; }
.ss-note { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.ss-note .ic { flex: none; margin-top: 2px; }
.ss-list { display: grid; gap: 10px; }
.ss-list li { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 10px; align-items: start; font-size: 13px; line-height: 19px; }
.ss-v { display: flex; flex-wrap: wrap; gap: 4px 6px; min-width: 0; }
.ss-list li > .ptag { justify-self: start; }
.ss-m { min-width: 0; }
.ss-m .code { white-space: normal; overflow-wrap: anywhere; }
.ss-n { grid-column: 2; color: var(--ink-muted); }
.ss-trig { display: grid; gap: 10px; }
.ss-trig li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 2px 10px; font-size: 13px; line-height: 19px; }
.ss-trig .code { grid-column: 2; color: var(--ink-muted); }
.ss-tn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--surface-2); font-size: 12px; font-weight: 750; font-variant-numeric: tabular-nums; }
.ss-tbl .id a { white-space: nowrap; }
.ss-tbl + .tbl-wrap, .tbl-wrap + .tbl-wrap { border-top: 1px solid var(--line); }
"""

if __name__ == "__main__":
    write("ConceptMap", card_marker(GROUP, 1000, 1440, "How pi-dispatch fits together: what starts work, how a job runs and ends, where a person steps in, and what is counted"),
          "How pi-dispatch fits together", concept_page(), CM_CSS)
    write("Glossary", card_marker(GROUP, 2200, 1440, "The words these designs use, each in one sentence, with where it shows and whether it is planned or proposed"),
          "Words used in these designs", glossary_page(), GL_CSS)
    write("SampleStory", card_marker(GROUP, 1800, 1440, "The one deployment every card draws: the day, hosts, projects, triggers, people and the day's runs, read from tools/fixture.py"),
          "The sample deployment", story_page(), SS_CSS)
    readme("ConceptMap", """
A guide card, not a console screen: one picture of how the pieces fit, read left to right.

**How a person uses it.**
- **What starts work.** Triggers (cron, label, comment, issue and pull request rules, written by hand), the CLI, and the watch rules (#735) and proposed dispatchers (only the latter are drawn dashed).
- **Queue and host.** The queue holds a job until a slot is free. A worker on a host takes it after the caps are checked, and a venue runs it in one container.
- **The run.** It becomes a run with a record, and ends completed, failed, refused or parked, or waits for approval of a named action (#649).
- **Where a person steps in.** Each outcome points at what a person does next: steer or cancel while it runs, merge the pull request (always theirs), open the sandbox, re-run, answer the question, send a drafted answer (#772, proposed), decide an approval (#649).
- **What is counted.** Spend against caps, reserved before any model call, and touches (Zero touch, #770, proposed).
- **The legend** says what solid, dashed blue, dashed grey, a violet edge and a tint mean. Every planned or proposed box also says so in words, with its issue.
- **On a phone** the map becomes the same content as a list, in the same five groups.

**Panels.** `p-cm-map`.

**Fixture note.** No sample data: the map names kinds of things, not runs.
""")
    readme("Glossary", """
A guide card: the words the design cards use, each in one sentence, with where it shows.

**How a person uses it.**
- **Grouped by where you meet a word:** starting work, running, waiting for a person, sandboxes, Zero touch and answers, watch and dispatchers, money, projects and people, and the design status words.
- **Planned and proposed words say so** under the term, with their issue, so nobody mistakes them for shipped behaviour.
- **One word, one meaning.** Where a word changed, the current one is used and the old one named once: "answer rule" was "answerer".
- **On a phone** each row stacks: the term, its meaning, then where it shows.

**Panels.** `p-gl`.

**Fixture note.** No sample data. The definitions follow the repo's docs where they define a word (soft hold, envelope, allocation, steer, follow up) and the cards for the rest.
""")
    readme("SampleStory", """
A guide card: the one deployment every card draws, read from `tools/fixture.py` rather than written by hand.

**How a person uses it.**
- **The numbers.** The day and time (15:39 UTC on Thursday 8 October 2026), the hosts, the projects, and the day's runs by outcome.
- **The day's runs.** Every run that ended today, newest first: when it ended, its id, target, project, flow, host, venue and outcome, each outcome a glyph and a word.
- **Not ended, and from earlier.** Runs that are running or waiting, the planned screens' own runs, and yesterday's runs that some cards still draw.
- **Hosts, projects, triggers and people.** The three hosts with their venues (the first is the default), the projects and their members, the seven triggers and the planned answer rule by number, and the two people, ops (operator) and watcher (viewer).
- **The check.** `tools/check_fixture.py` names any card that draws a run with another target, host or venue than this file.

**Panels.** `p-ss-day`, `p-ss-nhosts`, `p-ss-nproj`, `p-ss-nruns`, `p-ss-runs`, `p-ss-other`, `p-ss-hosts`, `p-ss-projects`, `p-ss-trig`, `p-ss-people`.

**Fixture note.** All of it is the fixture, by construction. Runs the fixture registers without details (drawn by one card only so far) are not listed.
""")
    print("guide written")
