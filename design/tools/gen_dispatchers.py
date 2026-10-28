"""The Dispatchers tab: many trigger sandboxes at once, each with its own purpose, inputs, list and caps; what each did
today, where they read the same input, and how they stay bounded together. Pulse kit."""
from pulse import *
from gen_triggers import tabs as trigger_tabs

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'
def flow(f): return f'<span class="ds-flow">{ic("skill", "ic ic--sm")}{E(f)}</span>'

# name, engine, state, where, purpose, reads, may start, jobs (n, cap), dollars (n, cap), proposals, last
DISP = [
    ("infra-dispatch", "jev", "running", "on mini1 for 3d 4h", "Turn infra alarms and log findings into read-only triage.",
     ["aws-cloudwatch", "prod-logs", "deploys", "merged commits"], ["triage-incident", "db-health"], (3, 10), (0.42, 3.00), 2, "15:35 started triage-incident"),
    ("review-router", "jev", "running", "on mini2 for 9d", "Pick which pull requests get a review, and on which model.",
     ["pull requests"], ["review"], (8, 20), (1.96, 4.00), 1, "15:38 started review on acme/api#540"),
    ("repo-onboarding", "jev", "running", "on mini1 for 9d", "When a repository joins or adds a skill, propose the triggers it needs.",
     ["the acme org", "merged commits"], [], (0, 0), (0, 0), 1, "15:31 proposed a label trigger, pi:migrate"),
    ("release-watch", "llm", "idle", "for 30 minutes after each deploy", "After a deploy, watch error rates and ask for a rollback check if they rise.",
     ["deploys", "prod-logs"], ["rollback-check"], (1, 4), (0.18, 1.00), 0, "14:40 to 15:10 after 4a1f: no rollback needed"),
    ("deps-keeper", "llm", "paused", "every 6 hours on mini2", "Keep dependencies current across the projects.",
     ["merged commits", "advisories"], ["deps-check"], (0, 6), (0, 2.00), 0, "paused by ops at 10:02: waiting for the lockfile fix"),
]
STATE = {"running": ("running", "running", "Running"), "idle": ("ok", "done", "Idle, ready"), "paused": ("attention", "pause", "Paused")}
ENGINE = {"jev": ("spend", "Jev loop"), "llm": ("runs", "LLM flow")}

def meter(label, n, cap, money=False):
    if not cap:
        return f'<p class="ds-m"><span>{label}</span><span class="faint">none: it proposes only</span></p>'
    pct = n / cap
    tone = "ok" if pct < .8 else ("attention" if pct < 1 else "failed")
    val = f"${n:.2f} of ${cap:.2f}" if money else f"{n} of {cap}"
    return (f'<p class="ds-m"><span>{label}</span><svg class="pbar tone-{tone}" height="8" role="meter" aria-valuenow="{int(pct * 100)}" aria-valuemax="100" aria-label="{label}: {val}">'
            f'<rect class="pbar__bed" width="100%" height="8" rx="4"/><rect class="pbar__fill" width="{max(pct * 100, 1.5):.1f}%" height="8" rx="4"/></svg><b>{val}</b></p>')

def dcard(name, eng, state, where, purpose, reads, may, jobs, dollars, props, last):
    tone, sic, sword = STATE[state]
    eic, eword = ENGINE[eng]
    mays = "".join(flow(f) for f in may) if may else '<span class="ds-none">nothing: it proposes only</span>'
    propchip = chip(f"{props} proposal{'s' if props != 1 else ''} waiting", "parked", "edit") if props else ""
    return f"""<section class="card ds-card{' ds-card--paused' if state == 'paused' else ''}" aria-labelledby="ds-{name}">
  <div class="ds-head"><h2 id="ds-{name}" class="code">{name}</h2><span class="badge tone-{tone}">{ic(sic)}{sword}</span></div>
  <p class="ds-purpose">{E(purpose)}</p>
  <p class="ds-eng">{ic(eic, 'ic ic--sm')}<b>{eword}</b><span>{E(where)}</span></p>
  <div class="ds-rows">
    <p class="ds-row"><span class="ds-rk">Reads</span><span class="ds-v">{''.join(f'<span class="vtag">{E(r)}</span>' for r in reads)}</span></p>
    <p class="ds-row"><span class="ds-rk">May start</span><span class="ds-v">{mays}</span></p>
  </div>
  {meter("Jobs today", *jobs)}{meter("Spend today", *dollars, money=True)}
  <p class="ds-last">{propchip}<span>{ic('clock', 'ic ic--sm')}{E(last)}</span></p>
  <div class="ds-act">{btn('Open', '', 'chev-r')}{btn('Resume', 'paid', 'play') if state == 'paused' else btn('Pause', 'ghost', 'pause')}</div>
</section>"""

# ---- activity today: one lane per dispatcher ----
def lanes():
    H0, RH = 0, 34
    def x(h, m=0): return (h + m / 60) / 24 * 100
    now = x(15, 39)
    rows = []
    marks = {
        "infra-dispatch": [("s", 9, 2), ("s", 15, 14), ("s", 15, 35), ("p", 9, 40), ("p", 15, 24)],
        "review-router": [("s", h, m) for h, m in [(8, 12), (9, 5), (10, 40), (11, 2), (13, 30), (14, 8), (15, 2), (15, 38)]] + [("p", 9, 41)],
        "repo-onboarding": [("p", 15, 31)],
        "release-watch": [("s", 14, 41)],
        "deps-keeper": [],
    }
    bands = {"release-watch": [(x(14, 40), x(15, 10))], "deps-keeper": [(x(10, 2), now)]}
    noise = {"infra-dispatch": 40, "review-router": 14, "repo-onboarding": 3, "release-watch": 0, "deps-keeper": 0}
    names = [d[0] for d in DISP]
    g = []
    for i, n in enumerate(names):
        y = i * RH
        g.append(f'<rect class="ds-band" x="0" y="{y + 4}" width="100%" height="{RH - 8}" rx="13"/>')
        for a, b in bands.get(n, []):
            cls = "ds-run" if n == "release-watch" else "ds-pause"
            g.append(f'<rect class="{cls}" x="{a:.2f}%" y="{y + 8}" width="{b - a:.2f}%" height="{RH - 16}" rx="9"/>')
        for k in range(noise[n]):
            xx = (k * 37 % 97) / 97 * now
            g.append(f'<line class="ds-tick" x1="{xx:.2f}%" x2="{xx:.2f}%" y1="{y + 12}" y2="{y + RH - 12}"/>')
        for kind, h, m in marks[n]:
            g.append(f'<circle class="ds-mk ds-mk--{kind}" cx="{x(h, m):.2f}%" cy="{y + RH / 2}" r="6"/>')
    H = RH * len(names)
    g.append(f'<rect class="ds-future" x="{now:.2f}%" y="0" width="{100 - now:.2f}%" height="{H}"/>')
    g.append(f'<line class="ds-now" x1="{now:.2f}%" x2="{now:.2f}%" y1="-4" y2="{H + 2}"/>')
    ax = "".join(f'<text class="ds-ax" x="{x(h):.2f}%" y="{H + 16}" text-anchor="middle">{h:02d}:00</text>' for h in (0, 6, 12, 18))
    labels = "".join(f'<p class="code">{n}</p>' for n in names)
    return f"""<div class="ds-lanes">
  <div class="ds-ll">{labels}</div>
  <div class="ds-lt"><svg class="ds-lsvg" height="{H + 20}" role="img" aria-label="Today per dispatcher: infra-dispatch started 3 jobs and made 2 proposals; review-router started 8 reviews and made 1 proposal; repo-onboarding made 1 proposal; release-watch ran for 30 minutes after the 14:40 deploy; deps-keeper is paused since 10:02.">{''.join(g)}{ax}</svg></div>
</div>
<p class="keyrow"><span><i class="ds-k ds-k--s"></i>started a job</span><span><i class="ds-k ds-k--p"></i>proposed a trigger</span><span><i class="ds-k ds-k--t"></i>decided nothing to do</span><span><i class="ds-k ds-k--r"></i>an LLM flow running</span><span><i class="ds-k ds-k--z"></i>paused</span></p>"""

ACTIVITY = card("Today", lanes(), sub="one lane each, UTC", id_="p-ds-today")

# ---- where they meet ----
INPUTS = ["aws-cloudwatch", "prod-logs", "deploys", "pull requests", "merged commits", "the acme org", "advisories"]
READS = {d[0]: set(d[5]) for d in DISP}
def matrix():
    head = "".join(f'<th scope="col"><span class="code">{d[0]}</span></th>' for d in DISP)
    body = []
    for inp in INPUTS:
        n = sum(1 for d in DISP if inp in READS[d[0]])
        cells = "".join(f'<td>{"<span class=" + chr(34) + "ds-dot" + chr(34) + " aria-label=" + chr(34) + "reads" + chr(34) + ">" + ic("done", "ic ic--sm") + "</span>" if inp in READS[d[0]] else ""}</td>' for d in DISP)
        body.append(f'<tr><th scope="row"><span class="vtag">{inp}</span>{f"<small>{n} read it</small>" if n > 1 else ""}</th>{cells}</tr>')
    return f'<div class="tbl-wrap"><table class="tbl ds-mx"><caption class="sr">Which dispatcher reads which input</caption><thead><tr><th scope="col">Input</th>{head}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'

MEET = card("Where they meet", f"""{matrix()}
<p class="ds-sh">Today, events more than one dispatcher acted on</p>
<ul class="ds-meet">
  <li><span class="ds-mt">14:40</span><div><b>deploys · acme/web {code('4a1f')} to production</b>
    <p>{ic('runs', 'ic ic--sm')}<span><span class="code">release-watch</span> started its 30-minute watch, and asked for no rollback.</span></p>
    <p>{ic('minus', 'ic ic--sm')}<span><span class="code">infra-dispatch</span> kept it as a fact; 55 minutes later it tied the latency alarm to it.</span></p></div></li>
  <li><span class="ds-mt">13:58</span><div><b>merged commits · acme/api, 3 dependency bumps</b>
    <p>{ic('minus', 'ic ic--sm')}<span><span class="code">infra-dispatch</span> read them for context: nothing touches infra.</span></p>
    <p>{ic('minus', 'ic ic--sm')}<span><span class="code">repo-onboarding</span> found no new skill.</span></p>
    <p>{ic('pause', 'ic ic--sm')}<span><span class="code">deps-keeper</span> is paused, so the bumps wait for its next run.</span></p></div></li>
  <li><span class="ds-mt">09:40</span><div><b>One trigger, two proposals</b>
    <p>{ic('edit', 'ic ic--sm')}<span><span class="code">infra-dispatch</span> proposed raising shop-5xx's threshold; <span class="code">release-watch</span> had proposed the same change after last night's deploy. They are one proposal with both reasons, listed under infra-dispatch.</span></p></div></li>
</ul>""", sub="different purposes may read the same input", id_="p-ds-meet")

KPIS = f"""<div class="cards-4">
{card('Dispatchers', '<p class="kpi"><b>5</b><span>each with its own purpose</span></p><p class="ds-kp">3 Jev loops, 2 LLM flows</p>', id_="p-ds-count")}
{card('Running', f'<p class="kpi"><b>3</b><span>now</span></p><p class="ds-kp">{chip("1 idle until a deploy", "ok", "done")} {chip("1 paused", "attention", "pause")}</p>', id_="p-ds-running")}
{card('Jobs started today', f'<p class="kpi"><b>12</b><span>of 40 across their caps</span></p>{pbar(12 / 40, "ok", "12 of 40 jobs a day across all dispatchers", 8)}<p class="ds-kp ds-kp--m"><b>$2.56</b> of the deployment\'s $25.00 today</p>{pbar(2.56 / 25, "ok", "$2.56 of the deployment\'s $25.00 today", 8)}', id_="p-ds-jobs")}
{card('Proposals waiting', '<p class="kpi"><b>4</b><span>for you</span></p><p class="ds-kp">from 3 dispatchers</p>', id_="p-ds-props")}
</div>"""

def page():
    cards = "".join(dcard(*d) for d in DISP) + f"""<section class="card ds-add" aria-labelledby="ds-add-h">
  <span class="tile tone-idle">{ic('plus')}</span>
  <h2 id="ds-add-h">Add a dispatcher</h2>
  <p>Written by hand in triggers.json, with its purpose, inputs, list and caps.</p>
  {btn('How to add one', '', 'info')}
</section>"""
    inner = (trigger_tabs("Dispatchers") + KPIS + ACTIVITY + f'<div class="ds-grid">{cards}</div>' +
             MEET)
    end = btn("How to add one", "", "info", sm=False)
    return shell("Triggers", inner, "Dispatchers",
                 sub="Sandboxes that read git and infra, each for its own purpose. They only start jobs from their own lists and propose triggers.",
                 end=end)

CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.ds-kp { display: flex; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.ds-kp--m { margin-top: var(--space-3); }
.ds-add { display: grid; align-content: center; justify-items: center; gap: 10px; text-align: center; background: transparent; box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.ds-add h2 { font-size: 15px; }
.ds-add p { max-width: 280px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.ds-kp--m b { color: var(--ink); font-variant-numeric: tabular-nums; }
#p-ds-jobs .pbar { width: 100%; display: block; margin-top: 6px; }
.ds-flow { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); background: var(--primary); color: var(--on-primary); font-size: 12px; font-weight: 700; white-space: nowrap; }
.ds-lanes { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; margin-top: 4px; }
.ds-ll { display: grid; grid-template-rows: repeat(5, 34px); align-items: center; font-size: 12px; font-weight: 700; color: var(--ink); }
.ds-lt { min-width: 0; }
.ds-lsvg { width: 100%; display: block; overflow: visible; }
.ds-band { fill: var(--surface-2); }
.ds-future { fill: var(--surface-2); opacity: .5; }
.ds-tick { stroke: var(--ink-faint); stroke-width: 1; opacity: .55; }
.ds-run { fill: var(--running-tint); stroke: var(--running); stroke-width: 1.5; }
.ds-pause { fill: url(#hatch); }
.ds-mk--s { fill: var(--ok); stroke: var(--surface); stroke-width: 2; }
.ds-mk--p { fill: var(--parked); stroke: var(--surface); stroke-width: 2; }
.ds-now { stroke: var(--ink); stroke-width: 2; }
.ds-ax { font-size: 11px; fill: var(--ink-faint); }
.ds-k { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.ds-k--s { background: var(--ok); } .ds-k--p { background: var(--parked); }
.ds-k--t { width: 2px; height: 12px; border-radius: 0; background: var(--ink-faint); }
.ds-k--r { width: 18px; border-radius: 5px; background: var(--running-tint); box-shadow: inset 0 0 0 1.5px var(--running); }
.ds-k--z { width: 18px; border-radius: 5px; background: var(--attention-tint); box-shadow: inset 0 0 0 1.5px var(--attention); }
.ds-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); }
.ds-card { display: grid; align-content: start; gap: 10px; }
.ds-card--paused { box-shadow: inset 0 0 0 1.5px var(--attention); }
.ds-head { display: flex; align-items: center; gap: 10px; }
.ds-head h2 { font-size: 16px; font-weight: 700; }
.ds-head .badge { margin-left: auto; }
.ds-purpose { font-size: 16px; line-height: 23px; font-weight: 650; color: var(--ink); }
.ds-eng { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--ink-muted); }
.ds-eng b { color: var(--ink); }
.ds-rows { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.ds-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; align-items: start; font-size: 12px; }
.ds-rk { color: var(--ink-muted); font-weight: 650; padding-top: 2px; }
.ds-v { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.ds-none { color: var(--ink-muted); }
.ds-m { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 12px; color: var(--ink-muted); }
.ds-m .pbar { width: 100%; display: block; }
.ds-m b { color: var(--ink); font-variant-numeric: tabular-nums; }
.ds-last { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-muted); }
.ds-last > span:last-child { display: inline-flex; align-items: center; gap: 6px; }
.ds-act { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.ds-mx th[scope="row"] { display: flex; align-items: center; gap: 8px; }
.ds-mx th[scope="row"] small { font-size: 11px; font-weight: 600; color: var(--ink-muted); }
.ds-mx td { text-align: center; }
.ds-mx thead th { font-size: 11px; }
.ds-dot { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--ok-tint); color: var(--ok-ink); }
.ds-sh { font-size: 13px; font-weight: 700; color: var(--ink); margin: var(--space-4) 0 var(--space-2); }
.ds-meet { display: grid; gap: 10px; }
.ds-meet > li { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.ds-mt { font-size: 12px; font-weight: 650; color: var(--ink-muted); font-variant-numeric: tabular-nums; padding-top: 1px; }
.ds-meet b { font-size: 13px; color: var(--ink); }
.ds-meet p { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 18px; color: var(--ink-muted); margin-top: 4px; }
.ds-meet p .ic { flex: none; margin-top: 2px; color: var(--ink); }
@media (max-width: 1200px) { .ds-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .tr-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .ds-grid { grid-template-columns: minmax(0, 1fr); }
  .ds-lanes { grid-template-columns: 110px minmax(0, 1fr); }
  .ds-ll { font-size: 11px; }
}
"""

if __name__ == "__main__":
    write("DispatchersScreen", card_marker("Planned for 5.0.0", 2200, 1440, "Many dispatchers at once, each with its own purpose: what each did today, its inputs, list and caps, where they read the same input, and how they stay bounded together"),
          "Dispatchers", page(), CSS)
    readme("DispatchersScreen", """
The Dispatchers tab on Triggers. Many dispatchers can run at once, and most do different jobs, so the page leads with each one's purpose and shows how they share inputs and limits.

**How a person uses it.**
- **The numbers.** How many dispatchers there are and by engine, how many run now (and which are idle or paused), the jobs and spend they started today against their combined caps and the deployment's $25.00, and the trigger proposals waiting.
- **Today.** One lane per dispatcher over the day in UTC:
  - a green dot for each job started;
  - a violet dot for each trigger proposal;
  - thin ticks for decisions that did nothing;
  - a blue band while an LLM flow runs;
  - a hatched band while a dispatcher is paused.

  The person sees at a glance which dispatcher is busy and which is quiet.
- **One card per dispatcher**, and a last card to add one, which opens the format. Each card shows:
  - its name, state, and its purpose in one sentence;
  - its engine and where it runs (a Jev loop on a host, or an LLM flow on a schedule or after an event);
  - what it reads, and what it may start (or "nothing: it proposes only");
  - jobs and spend today against its own caps;
  - proposals waiting, and its last action;
  - *Open*, and *Pause* or *Resume*. Resume is a paid act, because it starts spending again.
- **Where they meet.**
  - A table of which dispatcher reads which input, with a note where several read the same one.
  - Today's events that more than one dispatcher acted on, with what each did: a deploy that one watched and another kept as a fact, and merged commits that two read and a paused one will pick up later.
  - Two proposals for one trigger merged into one.

**Panels.** `p-ds-count`, `p-ds-running`, `p-ds-jobs`, `p-ds-props`, `p-ds-today`, `p-ds-meet`, and one card per dispatcher.

**The server provides.**
- Per dispatcher: name, purpose, engine, host or schedule, state with who paused it and why, inputs, allowed flows, caps, today's jobs and spend, proposals waiting and the last action.
- Per input: which dispatchers read it.
- Events acted on by several dispatchers, with each action, plus merged proposals and requests the queue took as duplicates.
- The deployment's dollar window.

**Who sees what.** A viewer sees purposes, states, counts and actions, without *Pause*, *Resume* or proposals. Dispatchers are written by hand in triggers.json; *How to add one* shows the format.

**Why it works this way.** Five rules keep the dispatchers bounded as a group:
- **Each has its own caps**, and every job it starts also counts against the deployment's windows and its project's scoped limits, which still bind.
- **Two requests for the same target and flow** within 10 minutes become one job, whichever dispatcher sent them.
- **Two proposals for one trigger** become one proposal with both reasons.
- **None can change another**, start a flow outside its own list, or edit its own rules. Adopting a proposal is a reviewed edit.
- **Each Jev loop runs in its own container**, reaching only its own inputs and the decision API. LLM flows run as ordinary jobs.

**Fixture note.** This is a planned screen, and all of it is sample:
- the five dispatchers, their purposes, hosts, caps and today's activity;
- `gh-5c21`, `4a1f` and the shop-5xx proposal follow the Dispatcher and Watch fixtures.
""")
    print("dispatchers written")
