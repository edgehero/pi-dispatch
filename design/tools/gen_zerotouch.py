"""Zero touch: how often a run needed a person, per project and repository, why, and what took it down.
A tab on Runs. The goal is zero. Pulse kit."""
from pulse import *

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'

GOAL = 5          # percent
SCALE = 40        # the meter's full width, in percent

# ---- the sample, kept consistent: 214 runs ended in 30 days, 38 needed a person ----
# causes in display order: key, word, glyph, tone, what the record says
CAUSES = [
    ("q", "Questions", "parked", "parked", "the run asked and stopped: reason awaiting-input, then a person answered"),
    ("a", "Approvals", "shield", "attention", "a person decided an approval the run asked for"),
    ("f", "Failed, then re-run", "failed", "failed", "outcome failed, and a person started it again"),
    ("r", "Refused until config was fixed", "refused", "refused", "outcome policy, then a person changed the configuration and re-ran it"),
    ("s", "Steered", "steer", "running", "a person sent the run a message while it worked"),
    ("c", "Cancelled", "cancel", "idle", "reason operator-cancel"),
]
CW = {k: (w, g, t) for k, w, g, t, _ in CAUSES}
SHORT = {"q": "Questions", "a": "Approvals", "f": "Failed, re-run", "r": "Refused, fixed", "s": "Steered", "c": "Cancelled"}

# project, where, runs, touched, prev rate, streak, causes, repos
PROJECTS = [
    ("web", "acme/web", 58, 9, 24, "2 days", {"q": 5, "a": 1, "f": 2, "s": 1}, []),
    ("api", "acme/api and acme/api-docs", 64, 13, 33, "waiting now", {"q": 9, "a": 2, "f": 2},
     [("acme/api", 39, 12, 42, "waiting now", {"q": 9, "a": 2, "f": 1}),
      ("acme/api-docs", 25, 1, 9, "12 days", {"f": 1})]),
    ("billing", "acme/billing and acme/billing-ui", 41, 13, 28, "1 day", {"q": 2, "a": 2, "f": 3, "r": 5, "s": 1}, []),
    ("ops", "folders site and pm on mini1", 34, 1, 5, "9 days", {"c": 1}, []),
    ("shop", "jobs started by watch rules", 17, 2, 21, "4 days", {"q": 1, "s": 1}, []),
]
assert sum(p[2] for p in PROJECTS) == 214 and sum(p[3] for p in PROJECTS) == 38
for p in PROJECTS:
    assert sum(p[6].values()) == p[3], p[0]
TOTALS = {k: sum(p[6].get(k, 0) for p in PROJECTS) for k, *_ in CAUSES}
assert TOTALS == {"q": 17, "a": 5, "f": 7, "r": 5, "s": 3, "c": 1}, TOTALS

def rate(t, n): return round(100 * t / n)

def level(pct):
    if pct < GOAL: return ("ok", "done", "Under goal")
    if pct < 30: return ("attention", "attention", "Above goal")
    return ("failed", "attention", "High")

def trend(now, prev):
    d = now - prev
    if d == 0:
        return '<span class="zt-tr">no change</span>'
    up = d > 0
    arrow = ('<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" '
             'stroke-linecap="round" stroke-linejoin="round" d="' + ("M12 19V5M6 11l6-6 6 6" if up else "M12 5v14M6 13l6 6 6-6") + '"/></svg>')
    return (f'<span class="zt-tr {"tone-attention" if up else "tone-ok"}">{arrow}<b>{"up" if up else "down"} {abs(d)} point{"s" if abs(d) != 1 else ""}</b>'
            f'<small>from {prev}%</small></span>')

def meter(pct, label):
    tone, glyph, word = level(pct)
    w = max(min(pct / SCALE, 1) * 100, 1.2)
    g = GOAL / SCALE * 100
    return (f'<div class="zt-m"><svg class="pbar tone-{tone}" height="10" role="meter" aria-valuenow="{pct}" aria-valuemin="0" aria-valuemax="100" '
            f'aria-label="{E(label)}: {pct} percent of runs needed a person, goal under {GOAL} percent">'
            f'<rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="{w:.1f}%" height="10" rx="5"/>'
            f'<line class="zt-goal" x1="{g:.2f}%" x2="{g:.2f}%" y1="-4" y2="14"/></svg>'
            f'<p class="zt-mv"><b>{pct}%</b><span class="zt-lv tone-{tone}">{ic(glyph, "ic ic--sm")}{word}</span></p></div>')

def top_cause(cs):
    k = max(cs, key=lambda k: (cs[k], -[c[0] for c in CAUSES].index(k)))
    w, g, t = CW[k]
    return f'<span class="zt-cause tone-{t}">{ic(g, "ic ic--sm")}{SHORT[k]} <b>{cs[k]}</b></span>'

def streak(s):
    if s == "waiting now":
        return f'<span class="zt-st tone-parked">{ic("parked", "ic ic--sm")}waiting now</span>'
    return f'<span class="zt-st">{ic("flag", "ic ic--sm")}{s}</span>'

HEAD = """<div class="zt-row zt-row--head" aria-hidden="true"><span></span><span>Project</span><span>Touch rate, goal tick at 5%</span>
<span>Against the 30 days before</span><span>Needed a person</span><span>Since the last touch</span><span>Most often</span></div>"""

def prow(name, where, n, t, prev, st, cs, sub=False):
    pct = rate(t, n)
    return f"""<span class="zt-chev">{'' if sub else ic('chev-r', 'ic ic--sm')}</span>
  <span class="zt-name">{(code(name) if sub else f'<b>{E(name)}</b>')}<small>{E(where)}</small></span>
  {meter(pct, name)}
  {trend(pct, prev)}
  <span class="zt-n"><b>{t}</b> of {n} runs</span>
  {streak(st)}
  <span class="zt-c">{top_cause(cs)}</span>"""

def projects():
    out = []
    for name, where, n, t, prev, st, cs, repos in PROJECTS:
        nrepo = len(repos) or (2 if " and " in where else 1)
        if repos:
            subs = "".join(f'<li class="zt-row zt-row--sub">{prow(r, f"{rn} runs", rn, rt, rp, rs, rc, sub=True)}</li>'
                           for r, rn, rt, rp, rs, rc in repos)
            out.append(f"""<li><details class="zt-p" open><summary class="zt-row" aria-label="{E(name)}: {rate(t, n)} percent, show its {nrepo} repositories">{prow(name, where, n, t, prev, st, cs)}</summary>
<ul class="zt-subs">{subs}</ul></details></li>""")
        else:
            out.append(f"""<li><details class="zt-p"><summary class="zt-row" aria-label="{E(name)}: {rate(t, n)} percent, show where">{prow(name, where, n, t, prev, st, cs)}</summary></details></li>""")
    return f'<div class="zt-tbl">{HEAD}<ul class="zt-list">{"".join(out)}</ul></div>'

def by_project(role="operator"):
    """The By project card. A viewer gets no "Open as runs" link: it opens the Runs tab filtered to touched runs, an
    operator's way into the actions there."""
    end = '<a class="link" href="#">Open as runs</a>' if role == "operator" else ""
    return card("By project", projects() + f"""<p class="zt-foot">{ic('info', 'ic ic--sm')}<span>A row opens to its repositories or folders.</span></p>""",
                sub="38 of 214 runs needed a person", end=end, id_="p-zt-projects", flush=True)

BY_PROJECT = by_project()

# ---- causes: one stacked bar per project, every segment carries its glyph and count ----
def bar(cs, label):
    maxn = max(p[3] for p in PROJECTS)
    segs = []
    for k, w, g, t, _ in CAUSES:
        if cs.get(k):
            segs.append(f'<span class="zt-seg zt-w{cs[k]} tone-{t}" title="{E(w)}: {cs[k]}">{ic(g, "ic ic--sm")}<b>{cs[k]}</b><span class="sr">{E(w)}</span></span>')
    rest = maxn - sum(cs.values())
    if rest:
        segs.append(f'<span class="zt-seg zt-seg--rest zt-w{rest}" aria-hidden="true"></span>')
    return f'<div class="zt-bar" role="img" aria-label="{E(label)}: ' + ", ".join(f"{CW[k][0]} {v}" for k, v in cs.items()) + f'">{"".join(segs)}</div>'

def causes():
    def words(cs): return " · ".join(f"{SHORT[k]} {cs[k]}" for k, *_ in CAUSES if cs.get(k))
    rows = "".join(f'<li class="zt-cb"><span class="zt-cb__n"><b>{name}</b><small>{t} of {n}</small></span>{bar(cs, name)}<p class="zt-cb__t" aria-hidden="true">{words(cs)}</p></li>'
                   for name, where, n, t, prev, st, cs, repos in PROJECTS)
    legend = "".join(f"""<li class="zt-why"><span class="tile tile--sm tone-{t}">{ic(g)}</span>
  <span><b>{w}</b><small>{d}</small></span><span class="zt-why__n">{TOTALS[k]}</span></li>""" for k, w, g, t, d in CAUSES)
    return f"""<ul class="zt-bars">{rows}</ul>
<ul class="zt-whys">{legend}<li class="zt-why zt-why--sum"><span></span><span><b>Runs that needed a person</b></span><span class="zt-why__n">38</span></li></ul>
<p class="zt-merge">{ic('pr', 'ic ic--sm')}<span>Merging is never a touch. <a class="link" href="#">How touches are counted</a></span></p>"""

CAUSES_CARD = card("What needed a person", causes(), sub="last 30 days, by project", id_="p-zt-causes")

# ---- questions it keeps asking ----
DIFF = diff("…/deploy/triggers.json · trigger 3", [
    ("ctx", '{ "on": { "type": "comment", "phrase": "@pi" },'),
    ("ctx", '  "run": { "kind": "github", "flow": "fix", "resume": true,'),
    ("del", '    "instructions": "This repo uses pnpm, not npm. Run the type check before opening a PR." } }'),
    ("add", '    "instructions": "This repo uses pnpm, not npm. Run the type check before opening a PR. In acme/api, run pnpm test:unit; the e2e suite needs a database and runs in CI." } }'),
])
CONFIRM = confirm("safe", "Add one sentence to trigger 3's instructions", [
    f"Writes {code('…/deploy/triggers.json')}: trigger 3's {code('instructions')} gains 80 characters, 149 of 2000 used",
    "Every later run of trigger 3 reads it above the issue text, labelled as coming from you, in every repository the trigger serves",
    "Nothing runs now and nothing is spent",
], "remove the sentence; the audit log keeps both versions", "Add to trigger 3", extra=DIFF)

def theme(q, where, n, src, runs, status, acts, open_="", unnamed=False):
    links = ", ".join(f'<a class="link code" href="#">{E(r)}</a>' for r in runs)
    more = n - len(runs)
    title = f'<p class="zt-q__t{" zt-q__t--un" if unnamed else ""}">{q}</p>'
    return f"""<li class="zt-q">
  <div class="zt-q__h"><span class="zt-q__n" aria-label="asked {n} times">{n}×</span>
    <div>{title}<p class="zt-q__s">{" and ".join(code(w) for w in where.split(" and "))} · {src}</p></div>
    <span class="zt-q__st">{status}</span></div>
  <p class="zt-said">{ic('runs', 'ic ic--sm')}<span>Asked in {links}{f" and {more} more" if more > 0 else ""}.</span></p>
  <div class="zt-q__act">{acts}</div>
  {open_}
</li>"""

QUESTIONS = card("Questions it keeps asking", f"""<p class="zt-intro">Grouped by meaning. You name each group; read the questions on their run pages.</p>
<ol class="zt-qs">
{theme("Test command", "acme/api", 6, "named by ops · all from runs of trigger 3 · last on 6 Oct",
       ["gh-71c2", "gh-6a0e", "gh-5d19"],
       chip("Open", "parked", "parked"),
       btn("Add to instructions", "primary", "edit") + btn("Save standing answer", "", "comment"), open_=CONFIRM)}
{theme("Rate limit scope", "acme/api", 3, "named by ops · from triage runs of trigger 7 · one waiting now",
       ["gh-2f6a", "gh-48b0", "gh-3e77"],
       chip("Product decision", "idle", "flag"),
       btn("Draft it for me", "", "flows") + btn("Answer gh-2f6a", "ghost", "parked"))}
{theme("2 similar questions, not named yet", "acme/web", 2, "from runs of trigger 2 · last on 30 Sep",
       ["gh-1b9d", "gh-0c4e"],
       chip("Open", "parked", "parked"),
       btn("Name this group", "", "edit") + btn("Save standing answer", "ghost", "comment"), unnamed=True)}
{theme("Package manager", "acme/web and acme/billing", 5, "named by ops · from runs of trigger 3 · none since 24 Sep",
       ["gh-09fa", "gh-7f21"],
       chip("Fixed", "ok", "done") + '<span class="zt-q__d">24 Sep</span>',
       '<a class="link" href="#">See the fix</a>')}
</ol>
<p class="zt-foot zt-foot--in">{ic('info', 'ic ic--sm')}<span>16 of the 17 questions fall in a group; the 17th was asked once.</span></p>""",
             sub="operator only", id_="p-zt-questions")

# ---- side ----
def spark():
    vals = [31, 30, 28, 24, 23, 21, 19, 18]
    W, H, top = 200, 56, 32
    pts = " ".join(f"{i * W / (len(vals) - 1):.1f},{H - v / top * H:.1f}" for i, v in enumerate(vals))
    gy = H - GOAL / top * H
    last = f'{W:.1f},{H - vals[-1] / top * H:.1f}'
    return f"""<svg class="zt-spark" viewBox="-4 -4 {W + 8} {H + 8}" preserveAspectRatio="none" role="img" aria-label="Rolling 30-day touch rate, each week for 8 weeks: from 31 percent to 18 percent. Goal under 5 percent.">
  <line class="zt-spark__goal" x1="0" x2="{W}" y1="{gy:.1f}" y2="{gy:.1f}"/>
  <polyline class="zt-spark__l" points="{pts}"/>
  <circle class="zt-spark__d" cx="{last.split(',')[0]}" cy="{last.split(',')[1]}" r="3.5"/>
</svg>
<p class="zt-spark__ax"><span>8 weeks ago, 31%</span><span>goal, dashed</span><span>now</span></p>"""

def kpis(role="operator"):
    """The four numbers. A viewer reads the same counts; the draft card does not call the answers the viewer's."""
    k = KPIS
    if role != "operator":
        k = k.replace("<span>of 17 answers you sent</span>", "<span>of 17 answers sent</span>").replace(
            "drafted by an answer rule, sent by you.", "drafted by an answer rule, sent by an operator.")
    return k

KPIS = f"""<div class="cards-4">
{card('Touch rate, 30 days', f'<p class="kpi"><b>18%</b><span>38 of 214 runs needed a person</span></p>{spark()}<p class="zt-kp"><span class="zt-kt">{ic("flag", "ic ic--sm")}goal under 5%</span><span class="zt-kt zt-kt--ok">{ic("done", "ic ic--sm")}down 6 points</span></p>', id_="p-zt-rate")}
{card('Zero-touch streak', f'<p class="kpi"><b>9 days</b><span>ops, the longest now</span></p><p class="zt-kp"><span class="zt-kt">shop 4 days</span><span class="zt-kt">web 2 days</span>{chip("api waiting now", "parked", "parked")}</p>', id_="p-zt-streak")}
{card('Waiting for a person', f'<p class="kpi"><b>41h</b><span>runs waited on a person in 30 days</span></p><p class="zt-kps">Median wait for an answer <b>34m</b></p><p class="zt-kp">{chip("waiting: gh-2f6a, 26m", "parked", "parked")}</p>', id_="p-zt-wait")}
{card('Answered from a draft', f'<p class="kpi"><b>11</b><span>of 17 answers you sent</span></p><p class="zt-kps">drafted by an answer rule, sent by you. Median 2 minutes to answer.</p>', id_="p-zt-handled")}
</div>"""

def fix(date, who, what, metric, before, after, span):
    mx = max(before, after, 1)
    def mb(label, v):
        w = max(v / mx * 100, 0)
        fill = f'<rect class="pbar__fill" width="{w:.1f}%" height="8" rx="4"/>' if v else ""
        return (f'<p class="zt-ba"><span>{label}</span><svg class="pbar tone-{"attention" if label == "Before" else "ok"}" height="8" role="img" aria-label="{label}: {v}">'
                f'<rect class="pbar__bed" width="100%" height="8" rx="4"/>{fill}</svg><b>{v}</b></p>')
    return f"""<li class="zt-fx">
  <p class="zt-fx__d">{date} · {who}</p>
  <p class="zt-fx__w">{what}</p>
  <p class="zt-fx__m">{metric}, {span}</p>
  {mb("Before", before)}{mb("After", after)}
</li>"""

def fixes(role="operator"):
    """Fixes that worked. A viewer sees what changed and what it did, but not who made the change (that is the audit
    log's) nor the text of an instruction (operator configuration)."""
    if role == "operator":
        rows = (fix("24 Sep", "ops", f"Added “This repo uses pnpm, not npm” to trigger 3's instructions", "Package manager questions", 5, 0, "2 weeks before and after")
                + "\n" + fix("29 Sep", "ops", f"Fixed the vault reference for {code('STRIPE_KEY')}", f"{code('secret-unresolved')} refusals on acme/billing", 4, 0, "9 days before and after"))
    else:
        rows = (fix("24 Sep", "a person", "Trigger 3's instructions gained a sentence", "Package manager questions", 5, 0, "2 weeks before and after")
                + "\n" + fix("29 Sep", "a person", f"The vault reference for {code('STRIPE_KEY')} was fixed", f"{code('secret-unresolved')} refusals on acme/billing", 4, 0, "9 days before and after"))
    return card("Fixes that worked", f"""<ol class="zt-fxs">
{rows}
</ol>""", sub="what changed, and what it did", id_="p-zt-fixes")

FIXES = fixes()

def tabs(role="operator"):
    items = [("All runs", "runs", "", False), ("Zero touch", "flag", "18%", True), ("Sandboxes", "box", "2 open", False)]
    if role != "operator":
        items = items[:2]   # Sandboxes is an operator's tab: a kept workspace holds issue text
    return '<nav class="tabs zt-tabs" aria-label="Runs views">' + "".join(
        f'<a href="#"{" aria-current=" + chr(34) + "page" + chr(34) if cur else ""}>{ic(i, "ic ic--sm")}{n}{f"<span class=count>{c}</span>" if c else ""}</a>'
        for n, i, c, cur in items) + "</nav>"

WINDOW = """<div class="seg" role="group" aria-label="Window"><button type="button" aria-pressed="false">7 days</button><button type="button" aria-pressed="true">30 days</button><button type="button" aria-pressed="false">90 days</button></div>"""

VIEWER_QUESTIONS = (f'<p class="collapsed" id="p-zt-questions" data-panel>{ic("parked", "ic ic--sm")}<b>Questions it keeps asking</b> '
                    'are for operators: grouping and naming them, and the fixes, are actions.</p>')

def page(role="operator"):
    if role == "operator":
        inner = (tabs() + KPIS +
                 f'<div class="cols"><div class="stack">{BY_PROJECT}{QUESTIONS}</div><div class="stack">{CAUSES_CARD}{FIXES}</div></div>')
        return shell("Runs", inner, "Zero touch",
                     sub="How often a run needed a person, per project and repository. The goal is zero.", end=WINDOW)
    inner = (tabs(role) + kpis(role) +
             f'<div class="cols"><div class="stack">{by_project(role)}{VIEWER_QUESTIONS}{fixes(role)}</div><div class="stack">{CAUSES_CARD}</div></div>')
    return shell("Runs", inner, "Zero touch", role=role,
                 sub="How often a run needed a person, per project and repository. The goal is zero.", end=WINDOW)

# ---- the phone: rate first, then projects as a list, the causes, and the question groups collapsed ----
def phone_rate():
    return card("Touch rate, 30 days", f"""<p class="kpi"><b>18%</b><span>38 of 214 runs needed a person</span></p>{spark()}
<p class="zt-kp"><span class="zt-kt">{ic("flag", "ic ic--sm")}goal under 5%</span><span class="zt-kt zt-kt--ok">{ic("done", "ic ic--sm")}down 6 points</span></p>
<ul class="ztp-now">
  <li><span>{ic("flag", "ic ic--sm")}Longest streak</span><b>ops, 9 days</b></li>
  <li><span>{ic("clock", "ic ic--sm")}Waited on a person</span><b>41h, median 34m</b></li>
  <li><span>{ic("edit", "ic ic--sm")}Answered from a draft</span><b>11 of 17</b></li>
  <li class="ztp-now--wait"><span>{ic("parked", "ic ic--sm")}Waiting now</span>{chip("gh-2f6a, 26m", "parked", "parked")}</li>
</ul>""", id_="p-zt-rate")

def phone_projects():
    rows = []
    for name, where, n, t, prev, st, cs, repos in PROJECTS:
        pct = rate(t, n)
        tone, glyph, word = level(pct)
        rows.append(f"""<li><a class="ztp-p" href="#" aria-label="{E(name)}: {pct} percent, {word}">
  <span class="ztp-p__n"><b>{E(name)}</b><small>{t} of {n} runs</small></span>
  <span class="ztp-p__r"><b>{pct}%</b><span class="zt-lv tone-{tone}">{ic(glyph, "ic ic--sm")}{word}</span></span>
  <span class="ztp-p__c">{top_cause(cs)}{trend(pct, prev)}</span>
  <span class="ztp-p__go">{ic("chev-r", "ic ic--sm")}</span>
</a></li>""")
    return card("By project", f'<ul class="ztp-ps">{"".join(rows)}</ul>', sub="goal under 5%", id_="p-zt-projects", flush=True)

def phone_causes():
    segs = "".join(f'<span class="zt-seg zt-w{TOTALS[k]} tone-{t}" title="{E(w)}: {TOTALS[k]}"><b>{TOTALS[k]}</b><span class="sr">{E(w)}</span></span>'
                   for k, w, g, t, _ in CAUSES if TOTALS[k])
    legend = "".join(f"""<li class="zt-why"><span class="tile tile--sm tone-{t}">{ic(g)}</span>
  <span><b>{SHORT[k]}</b></span><span class="zt-why__n">{TOTALS[k]}</span></li>""" for k, w, g, t, d in CAUSES)
    bar = f'<div class="zt-bar" role="img" aria-label="All projects: ' + ", ".join(f"{CW[k][0]} {TOTALS[k]}" for k, *_ in CAUSES) + f'">{segs}</div>'
    return card("What needed a person", f"""{bar}
<ul class="zt-whys ztp-whys">{legend}<li class="zt-why zt-why--sum"><span></span><span><b>Runs that needed a person</b></span><span class="zt-why__n">38</span></li></ul>
<p class="zt-merge">{ic('pr', 'ic ic--sm')}<span>Merging is never a touch. <a class="link" href="#">How touches are counted</a></span></p>""",
                sub="30 days, all projects", id_="p-zt-causes")

def phone_questions():
    def g(n, name, where, state, act, un=False):
        return f"""<li class="ztp-q">
  <span class="zt-q__n" aria-label="asked {n} times">{n}×</span>
  <span class="ztp-q__t"><b class="{'zt-q__t--un' if un else ''}">{name}</b><small>{where}</small></span>
  <span class="ztp-q__st">{state}</span>
  <span class="ztp-q__a">{act}</span>
</li>"""
    rows = (g(6, "Test command", code("acme/api"), chip("Open", "parked", "parked"), btn("Add to instructions", "primary", "edit"))
            + g(3, "Rate limit scope", code("acme/api"), chip("Product decision", "idle", "flag"), btn("Answer gh-2f6a", "", "parked"))
            + g(2, "2 similar, not named yet", code("acme/web"), chip("Open", "parked", "parked"), btn("Name this group", "", "edit"), un=True)
            + g(5, "Package manager", f'{code("acme/web")} and {code("acme/billing")}', chip("Fixed", "ok", "done"), '<a class="link" href="#">See the fix</a>'))
    return card("Questions it keeps asking", f'<ol class="ztp-qs">{rows}</ol>', sub="operator only", id_="p-zt-questions")

def phone_page():
    fixes_line = (f'<p class="collapsed" id="p-zt-fixes" data-panel>{ic("done", "ic ic--sm")}<b>2 fixes worked</b> this month: '
                  'package manager questions 5 to 0, <span class="code">secret-unresolved</span> refusals 4 to 0. <a class="link" href="#">Open</a></p>')
    inner = tabs() + f'<div class="stack">{phone_rate()}{phone_projects()}{phone_causes()}{phone_questions()}{fixes_line}</div>'
    return shell("Runs", inner, "Zero touch", sub="How often a run needed a person. The goal is zero.", end=WINDOW)

CSS = """
.zt-tabs { margin: var(--space-2) 0; }
.zt-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.zt-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.zt-kp { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: var(--space-3); }
.zt-kt { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.zt-kt--ok { color: var(--ok-ink); }
.zt-cause { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; color: var(--ink); }
.zt-cause .ic { color: var(--tone-ink); }
.zt-q__d { font-size: 12px; color: var(--ink-muted); margin-left: 6px; }
.zt-kps { font-size: 13px; line-height: 19px; color: var(--ink-muted); margin-top: 6px; }
.zt-kps b { color: var(--ink); }
.zt-spark { display: block; width: 100%; height: 64px; overflow: visible; }
.zt-spark__goal { stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
.zt-spark__l { fill: none; stroke: var(--ink); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.zt-spark__d { fill: var(--ink); }
.zt-spark__ax { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--ink-faint); }

/* by project */
.zt-tbl { padding: 0 0 var(--space-2); }
.zt-row { display: grid; grid-template-columns: 18px minmax(0, 1.1fr) minmax(0, 1.4fr) 128px 104px 110px minmax(0, 1.25fr); gap: var(--space-3); align-items: center; padding: 12px var(--space-5); }
.zt-row--head { padding-top: 0; padding-bottom: 8px; font-size: 11px; line-height: 14px; font-weight: 650; color: var(--ink-faint); border-bottom: 1px solid var(--line); }
.zt-list > li { border-bottom: 1px solid var(--line); }
.zt-p > summary { list-style: none; cursor: pointer; }
.zt-p > summary::-webkit-details-marker { display: none; }
.zt-p > summary:hover { background: var(--surface-2); }
.zt-chev { color: var(--ink-faint); display: inline-flex; }
.zt-chev .ic { transition: transform .15s; }
.zt-p[open] > summary .zt-chev .ic { transform: rotate(90deg); }
.zt-name { display: grid; min-width: 0; }
.zt-name b { font-size: 15px; font-weight: 700; }
.zt-name small { font-size: 12px; line-height: 16px; color: var(--ink-muted); overflow-wrap: anywhere; }
.zt-m { display: grid; gap: 4px; min-width: 0; }
.zt-goal { stroke: var(--ink); stroke-width: 2; }
.zt-mv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zt-mv b { font-size: 15px; font-weight: 750; }
.zt-lv { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 650; color: var(--tone-ink); }
.zt-tr { display: inline-grid; grid-template-columns: auto auto; justify-content: start; gap: 0 5px; align-items: center; font-size: 13px; color: var(--tone-ink, var(--ink-muted)); }
.zt-tr b { font-weight: 650; }
.zt-tr small { grid-column: 2; font-size: 11px; color: var(--ink-muted); }
.zt-n { font-size: 13px; color: var(--ink-muted); }
.zt-n b { color: var(--ink); font-weight: 700; }
.zt-st { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--ink); }
.zt-st.tone-parked { color: var(--tone-ink); font-weight: 650; }
.zt-c { min-width: 0; }
.zt-c .chip b { color: inherit; }
.zt-subs { background: var(--surface-2); }
.zt-row--sub { padding-top: 10px; padding-bottom: 10px; border-top: 1px solid var(--line); }
.zt-row--sub .zt-name { padding-left: 4px; }
.zt-foot { display: flex; gap: 8px; align-items: flex-start; padding: var(--space-3) var(--space-5) var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.zt-foot .ic { flex: none; margin-top: 2px; }
.zt-foot--in { padding: var(--space-3) 0 0; }

/* causes */
.zt-bars { display: grid; gap: 10px; }
.zt-cb { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: var(--space-3); align-items: center; }
.zt-cb__n { display: grid; font-size: 13px; line-height: 16px; }
.zt-cb__n small { font-size: 11px; color: var(--ink-muted); }
.zt-cb__t { display: none; }
#p-zt-causes .zt-cb { grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
#p-zt-causes .zt-seg .ic { display: none; }
#p-zt-causes .zt-cb__t { display: block; grid-column: 2; margin-top: -4px; font-size: 11px; line-height: 15px; color: var(--ink-muted); }
#p-zt-causes .zt-whys { grid-template-columns: minmax(0, 1fr); }
#p-zt-causes .zt-why--sum { grid-column: 1; }
.zt-bar { display: flex; gap: 3px; height: 28px; }
.zt-seg { display: inline-flex; align-items: center; justify-content: center; gap: 3px; min-width: 0; border-radius: 8px; background: var(--tone); color: var(--on-tone); font-size: 12px; overflow: hidden; }
.zt-seg b { font-weight: 750; }
.zt-seg--rest { background: transparent; }
.zt-w1 { flex: 1 1 0; } .zt-w2 { flex: 2 1 0; } .zt-w3 { flex: 3 1 0; } .zt-w4 { flex: 4 1 0; } .zt-w5 { flex: 5 1 0; } .zt-w6 { flex: 6 1 0; }
.zt-w7 { flex: 7 1 0; } .zt-w8 { flex: 8 1 0; } .zt-w9 { flex: 9 1 0; } .zt-w10 { flex: 10 1 0; } .zt-w11 { flex: 11 1 0; } .zt-w12 { flex: 12 1 0; } .zt-w13 { flex: 13 1 0; }
.zt-whys { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px var(--space-5); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.zt-why { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; }
.zt-why > span:nth-child(2) { display: grid; font-size: 13px; line-height: 17px; }
.zt-why small { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.zt-why__n { font-size: 17px; font-weight: 750; min-width: 24px; text-align: right; }
.zt-why .tile { background: var(--tone); color: var(--on-tone); }
.zt-why--sum { grid-column: 2; border-top: 1px solid var(--line-strong); }
.zt-why--sum > span:first-child { width: 28px; }
.zt-merge { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-4); padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.zt-merge .ic { flex: none; margin-top: 3px; color: var(--ink); }
.zt-merge b { color: var(--ink); }

/* questions */
p.zt-intro { font-size: 13px; color: var(--ink-muted); margin-bottom: var(--space-3); }
.zt-qs { display: grid; }
.zt-q { display: grid; gap: 10px; padding: var(--space-4) 0; border-top: 1px solid var(--line); }
.zt-q__h { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; }
.zt-q__n { display: inline-flex; align-items: center; justify-content: center; height: 34px; border-radius: 12px; background: var(--surface-2); font-size: 15px; font-weight: 800; }
.zt-q__t { font-size: 15px; line-height: 21px; font-weight: 700; }
.zt-q__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.zt-q__s .code { font-size: 12px; color: var(--ink); }
.zt-said { display: flex; gap: 8px; align-items: flex-start; margin-left: calc(48px + var(--space-3)); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.zt-said .ic { flex: none; margin-top: 3px; }
.zt-said .link.code { font-size: 12px; }
.zt-q__t--un { color: var(--ink-muted); font-weight: 650; }
.zt-q__act { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-left: calc(48px + var(--space-3)); }
.zt-q .confirm { margin-left: calc(48px + var(--space-3)); }
.zt-q .diff__b > span { white-space: pre-wrap; overflow-wrap: anywhere; }

/* side */
.zt-fxs { display: grid; gap: var(--space-4); }
.zt-fx { display: grid; gap: 4px; padding-top: var(--space-4); border-top: 1px solid var(--line); }
.zt-fx:first-child { padding-top: 0; border-top: 0; }
.zt-fx__d { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.zt-fx__w { font-size: 14px; line-height: 20px; font-weight: 650; }
.zt-fx__m { font-size: 12px; line-height: 17px; color: var(--ink-muted); margin-bottom: 4px; }
.zt-fx__m .code { font-size: 12px; }
.zt-ba { display: grid; grid-template-columns: 52px minmax(0, 1fr) 24px; gap: 10px; align-items: center; font-size: 12px; color: var(--ink-muted); }
.zt-ba b { color: var(--ink); text-align: right; }

@media (max-width: 1200px) {
  .zt-row { grid-template-columns: 18px minmax(0, 1fr) minmax(0, 1.3fr) 120px minmax(0, 1fr); }
  .zt-row > .zt-st, .zt-row > .zt-c { grid-column: 3 / -1; }
  .zt-row--head > :nth-child(n+6) { display: none; }
}
@media (max-width: 760px) {
  .zt-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .zt-row--head { display: none; }
  .zt-row { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 6px 10px; padding: 12px var(--space-4); }
  .zt-row > .zt-m { grid-column: 2 / -1; }
  .zt-row > .zt-tr { grid-column: 2; }
  .zt-row > .zt-n { grid-column: 3; grid-row: 1; text-align: right; }
  .zt-row > .zt-st { grid-column: 3; grid-row: 3; justify-self: end; }
  .zt-row > .zt-c { grid-column: 2 / -1; }
  .zt-foot { padding: var(--space-3) var(--space-4); }
  .zt-cb { grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
  .zt-seg .ic { display: none; }
  .zt-cb__t { display: block; grid-column: 2; margin-top: -4px; font-size: 11px; line-height: 15px; color: var(--ink-muted); }
  .zt-whys { grid-template-columns: minmax(0, 1fr); }
  .zt-why--sum { grid-column: 1; }
  .zt-q__h { grid-template-columns: 40px minmax(0, 1fr); }
  .zt-q__st { grid-column: 2; }
  .zt-said, .zt-q__act, .zt-q .confirm { margin-left: 0; }
  .zt-q .confirm { padding: var(--space-4); }
}
"""

PHONE_CSS = """
/* the phone card */
.zt-w17 { flex: 17 1 0; }
.ztp-now { display: grid; gap: 0; margin-top: var(--space-4); border-top: 1px solid var(--line); }
.ztp-now li { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink-muted); }
.ztp-now li:last-child { border-bottom: 0; padding-bottom: 0; }
.ztp-now li > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
.ztp-now b { color: var(--ink); font-weight: 650; }
.ztp-ps > li { border-top: 1px solid var(--line); }
.ztp-ps > li:first-child { border-top: 0; }
.ztp-p { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; gap: 4px 10px; align-items: center; padding: 12px var(--space-4); color: inherit; text-decoration: none; }
.ztp-p:hover { background: var(--surface-2); }
.ztp-p__n { display: grid; min-width: 0; }
.ztp-p__n b { font-size: 15px; font-weight: 700; }
.ztp-p__n small { font-size: 12px; color: var(--ink-muted); }
.ztp-p__r { display: grid; justify-items: end; gap: 2px; }
.ztp-p__r b { font-size: 17px; font-weight: 750; font-variant-numeric: tabular-nums; }
.ztp-p__c { grid-column: 1 / 3; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.ztp-p__go { grid-column: 3; grid-row: 1 / 3; color: var(--ink-faint); display: inline-flex; }
.ztp-whys { grid-template-columns: minmax(0, 1fr) !important; margin-top: var(--space-4); }
.ztp-whys .zt-why--sum { grid-column: 1; }
.ztp-qs { display: grid; }
.ztp-q { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 6px 10px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.ztp-q:first-child { border-top: 0; padding-top: 0; }
.ztp-q .zt-q__n { height: 30px; font-size: 14px; }
.ztp-q__t { display: grid; min-width: 0; }
.ztp-q__t b { font-size: 14px; line-height: 20px; font-weight: 700; }
.ztp-q__t small { font-size: 12px; color: var(--ink-muted); }
.ztp-q__t small .code { font-size: 12px; }
.ztp-q__st, .ztp-q__a { grid-column: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

"""

if __name__ == "__main__":
    write("ZeroTouchScreen", card_marker("Planned and proposed", 3070, 1440, "Zero touch: how often a run needed a person, per project and repository, why, which questions keep coming back, and the fixes that brought the rate down"),
          "Zero touch", page(), CSS)
    readme("ZeroTouchScreen", """
A second tab on Runs that counts how often a run needed a person, per project and per repository, and helps the person drive that number to zero. A project nobody had to touch for 30 days is a zero-touch project.

**How a person uses it.**
- **The numbers.**
  - *Touch rate*: runs that needed a person out of runs that ended, over the window (7, 30 or 90 days), with a sparkline of the rolling rate each week, a dashed goal line, and the change against the window before in words.
  - *Zero-touch streak*: the project that has gone longest without a touch, and the others.
  - *Waiting for a person*: the hours runs waited on a person, the median wait for an answer, and what waits now.
  - *Answered from a draft*: answers the person sent from an answer rule's draft. They are touches, in the rate, shown apart only because they were quicker. Nothing answers a run without a person (OQ-051).
- **By project.** One row per project:
  - the rate as a meter, with the goal tick at 5% and a word beside it (*Under goal*, *Above goal*, *High* from 30%), so colour never carries it alone;
  - the change against the 30 days before, as an arrow and words ("down 8 points, from 24%");
  - how many runs needed a person out of how many ran;
  - the days since the last touch, or *waiting now*;
  - the most common cause.

  A row opens to its repositories or folders with the same columns (api is shown open: acme/api at 31%, acme/api-docs at 4%). *Open as runs* lists the touched runs on the Runs tab.
- **What needed a person** (side). One stacked bar per project on one scale, each with its counts in words under it. Under the bars, the six causes with what the record says for each and their counts (17, 5, 7, 5, 3 and 1, which make 38), and one line: merging is never a touch, with a link to how touches are counted.
- **Questions it keeps asking** (operator only). Questions with the same meaning, grouped by a decision model, per repository. A person names each group (an unnamed one says how many similar questions it holds and offers *Name this group*), and the page shows the name, the count and links to the runs, never the questions. Each group offers the fix that removes it:
  - *Add to instructions*: shown open, a preview with the diff of `triggers.json` and *Add to trigger 3*. The undo is to remove the sentence.
  - *Save standing answer*: later drafts for the group cite it; the person still sends each answer.
  - *Draft it for me*, or the *Product decision* state for questions only a person should answer.
  - A fixed group stays listed, with when it was fixed and *none since*.
- **Fixes that worked** (side). Each change a person made against a cause, with before and after bars over equal spans: the pnpm sentence on trigger 3 (package manager questions 5 to 0), and the vault reference fix (`secret-unresolved` refusals 4 to 0).

**Panels.** `p-zt-rate`, `p-zt-streak`, `p-zt-wait`, `p-zt-handled`, `p-zt-projects`, `p-zt-causes`, `p-zt-questions`, `p-zt-fixes`.

**The server provides.**
- From run records, today:
  - outcome and reason (`awaiting-input`, `operator-cancel`, policy refusals and failures);
  - steering messages received;
  - re-runs of the same target;
  - the project and repository each run recorded;
  - parked times and answer times.
- New:
  - approvals decided (with ApprovalRequest);
  - linking a configuration change to the refusal it answered;
  - question groups from a decision model over the question text, named by a person;
  - standing answers;
  - answers sent from an answer rule's draft (with REQ-PARKED-ANSWERER);
  - the fixes log, each change with the cause it targets and counts before and after.
- The rate is a read over records. The only write on the page is a trigger edit, through the usual preview and Confirm.

**Who sees what.** A viewer sees the rates, counts, causes, streaks and fixes. Question groups and every action are operator only. No role sees question text on this page.

**Why it works this way.**
- **What a touch is.** Answering a question the run asked, deciding an approval, re-running after a failure or a refusal, changing the configuration because a run was refused, steering a run while it works, or cancelling a run.
- **What is never a touch.** Merging a pull request, which is always the person's; reading a run, its transcript or this page; opening a sandbox; and a run that starts itself on a schedule, a label or a watch rule. That is the ask, not a touch.
- **A run counts once**, however often a person stepped in. The rate is runs that needed a person, divided by runs that ended in the window.
- **Answered from a draft is still a touch.** A person sent it. It is shown apart only because it was quicker. Nothing answers a run without a person (OQ-051).
- **Zero touch.** A project with no touch for 30 days is marked zero touch.
- **No question text here.** A group's name is written by a person, never by the model, because a question is the run's own text, which the console shows on the run page and nowhere else.
- **Standing answers do not reach zero.** A draft may cite one, but the person still sends the answer. The way to zero is an instruction that stops the question being asked.

**Fixture note.** This is a proposed screen (issue #753, REQ-ZERO-TOUCH-RATE), and all of it is sample:
- the 214 runs and 38 touches, and their split by project, repository and cause;
- the trend, the streaks and the waits;
- the question groups and their wording, the trigger 3 instructions line (from `triggers.example.json`) and the sentence added to it;
- the two fixes.

Projects, repositories, trigger 3 and `gh-2f6a` follow the fixture.
""")
    write("ZeroTouchViewer", card_marker("Planned and proposed", 1640, 1440, "Zero touch as a viewer sees it: rates, counts, causes, streaks and fixes, with no question groups and no actions"),
          "Zero touch, as a viewer", page("viewer"), CSS)
    readme("ZeroTouchViewer", """
The Zero touch tab as a viewer sees it. The same numbers as the operator's page, so a viewer can follow a project towards zero touch; nothing on it acts, and nothing on it quotes a run.

**How a person uses it.**
- **The numbers.** Touch rate, the zero-touch streak, the time runs waited for a person and the answers sent from a draft, as on the operator's page. The waiting run is named by its id.
- **By project.** The same rows and meters, opening to repositories. There is no *Open as runs* link: it leads to the Runs tab's actions.
- **What needed a person.** The same bars and the six causes with their counts.
- **Fixes that worked.** What changed and what it did, before and after. Who made the change is left out (that is the audit log's, which a viewer never sees), and so is the text of an instruction: "Trigger 3's instructions gained a sentence".
- **Questions it keeps asking** is one line saying it is for operators.

**Panels.** `p-zt-rate`, `p-zt-streak`, `p-zt-wait`, `p-zt-handled`, `p-zt-projects`, `p-zt-questions` (one line), `p-zt-causes`, `p-zt-fixes`.

**The server provides.** The operator page's reads, for a viewer's session: the rates, counts, causes, streaks and the fixes log, without the person on each fix, the instruction text, the question groups or any action.

**Who sees what.** This is the viewer's page. The Sandboxes tab is not in the tab row: it is an operator's tab, because a kept workspace holds issue text.

**Fixture note.** As ZeroTouchScreen: proposed (issue #753, REQ-ZERO-TOUCH-RATE), all of it sample, with gh-2f6a and the projects from the fixture.
""")
    write("ZeroTouchPhone", card_marker("Phone", 2620, 390, "Zero touch on a phone: the rate first, projects as a list, the causes, and the question groups with one action each"),
          "Zero touch on a phone", phone_page(), CSS + PHONE_CSS)
    readme("ZeroTouchPhone", """
The Zero touch tab laid out for a phone rather than stacked: what the rate is first, then where it comes from, then what to do about it.

**How a person uses it.**
- **Touch rate.** The big number, its 8-week trend, the goal and the change, then four short lines: the longest streak, the time runs waited, the answers sent from a draft, and the run waiting now.
- **By project.** One row per project, tappable: its rate with a word (*Under goal*, *Above goal*, *High*), how many runs needed a person, its most common cause and the change against the 30 days before. A row opens the project's own view.
- **What needed a person.** One bar for all projects, each segment with its count, and the six causes as a list. Merging is never a touch.
- **Questions it keeps asking** (operator only). Each group in one row: how often it was asked, its name, its state (*Open*, *Product decision*, *Fixed*) and one action: *Add to instructions*, *Answer gh-2f6a*, *Name this group*, or *See the fix*. The preview and diff of an instruction open on their own page.
- **Fixes that worked** is one line, with how far each fix brought its cause down.

**Panels.** `p-zt-rate`, `p-zt-projects`, `p-zt-causes`, `p-zt-questions`, `p-zt-fixes` (one line).

**The server provides.** The same reads as ZeroTouchScreen; the phone drops the per-project bars and the repository rows, which open from a project.

**Who sees what.** An operator's phone. A viewer's phone shows ZeroTouchViewer's content in this order, without the question groups.

**Fixture note.** As ZeroTouchScreen: proposed (issue #753, REQ-ZERO-TOUCH-RATE), all of it sample, with gh-2f6a and the projects from the fixture.
""")
    print("zero touch written")
