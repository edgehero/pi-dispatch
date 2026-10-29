"""Triggers as their own page: every rule read as 'when this happens, run that', with its status, a week of schedules,
and a check that says which rule a given event would start. Pulse kit."""
from pulse import *

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{t}</span>'
def flow(f): return f'<span class="tr-flow">{ic("skill", "ic ic--sm")}{f}</span>'

# chip categories: the panel's badge colours, now with a glyph and a word each
CAT = {"cost": ("attention", "spend"), "reach": ("attention", "globe"), "writes": ("attention", "edit"),
       "asks": ("parked", "parked"), "narrows": ("running", "fit"), "done": ("idle", "done"), "plain": ("", "info")}
def tc(cat, text):
    tone, icon = CAT[cat]
    return chip(text, tone, icon)

KIND = {"cron": ("clock", "Schedule"), "label": ("tag", "Label"), "comment": ("comment", "Comment"),
        "pull_request": ("pr", "Pull request"), "issue": ("issue", "Issue closed")}

def tabs(cur):
    items = [("Rules", "runs", "7"), ("Watch", "eye", "planned"), ("Dispatchers", "flows", "planned")]
    return '<nav class="tabs tr-tabs" aria-label="Triggers views">' + "".join(
        f'<a href="#"{" aria-current=" + chr(34) + "page" + chr(34) if n == cur else ""}>{ic(i, "ic ic--sm")}{n}<span class="count">{c}</span></a>'
        for n, i, c in items) + "</nav>"

def rule(n, kind, when, where, then_sub, fl, chips, status, note="", spent=False):
    icon, word = KIND[kind]
    return f"""<li class="tr{' tr--spent' if spent else ''}">
  <span class="tr-n" aria-label="Trigger {n}">{n}</span>
  <div class="tr-when">
    <span class="tile tile--sm tr-kind">{ic(icon)}</span>
    <div><p class="tr-k">{word}</p><p class="tr-s">{when}</p><p class="tr-sub">{where}</p></div>
  </div>
  <span class="tr-arrow" aria-hidden="true">{ic('chev-r')}</span>
  <div class="tr-then"><p class="tr-s">runs {flow(fl)}</p><p class="tr-sub">{then_sub}</p>{f'<p class="tr-chips">{"".join(chips)}</p>' if chips else ''}</div>
  <div class="tr-status">{status}</div>
  <div class="tr-act"><a class="btn btn--sm btn--ghost" href="#" aria-label="Open trigger {n}">{ic('chev-r', 'ic ic--sm')}</a></div>
  {f'<p class="tr-note">{ic("info", "ic ic--sm")}<span>{note}</span></p>' if note else ''}
</li>"""

def st(kind, when, line2, line3=""):
    return f'<p>{badge(kind)}<span class="tr-t">{when}</span></p><p class="tr-sub">{line2}</p>' + (f'<p class="tr-sub">{line3}</p>' if line3 else "")

# The seven rules, one source for the desktop page, the phone card and the viewer card.
# group: where the rule comes from. next: the next fire, schedules only.
RULES = [
    dict(group="schedule", n=1, kind="cron", when="Every day at 03:00 UTC", where=f"in the folder {code('site')} on mini1 · {code('0 3 * * *')}",
         then_sub="kimi-for-coding on plan:kimi · local venue", fl="tidy", chips=[tc("writes", "edits site in place")],
         last=("completed", "today 03:11"), next=("03:00 tomorrow", "in 11h 21m"), ontime=True, count="30 runs in 30 days · plan:kimi"),
    dict(group="schedule", n=6, kind="cron", when="Every Monday at 06:00 UTC", where=f"in the folder {code('pm')} on mini1 · {code('0 6 * * 1')}",
         then_sub="claude-haiku-5-5 · local venue", fl="portfolio-manager", chips=[tc("writes", "may write the budget split")],
         last=("completed", "Mon 5 Oct, 06:02"), next=("Mon 12 Oct 06:00", "in 3d 14h"), count="4 runs in 30 days · $0.06 this week"),
    dict(group="github", n=2, kind="label", when=f"The label {code('pi:frontend')} is added to an issue",
         where="by someone with write access, in any repository wired to this deployment",
         then_sub="deployment default model · skills from pi-skills", fl="frontend-fix", chips=[tc("cost", "2 runs per label: 2 replicas")],
         last=("completed", "7 Oct, 17:41"), line2="12 runs in 30 days", count="$2.89 this week",
         note="GitHub matches the issue's whole label set, so re-labelling or reopening the issue fires it again: a paid run each time, times two."),
    dict(group="github", n=3, kind="comment", when=f"A comment contains {code('@pi')}",
         where="on an issue or pull request, by someone with write access · GitHub's one comment rule",
         then_sub="deployment default model · standing instructions above the issue text", fl="fix", chips=[tc("writes", "keeps a session")],
         last=("refused", "today 15:30"), line2=f'{code("gh-e9a0")} on acme/billing#260', count="104 runs in 30 days · $21.85 this week",
         note=f"A comment can pick another rule's flow: {code('@pi triage')} runs flow triage (rule 7's), {code('@pi frontend-fix')} runs rule 2's. Everything else still comes from this rule."),
    dict(group="github", n=7, kind="label", when=f"The label {code('pi:triage')} is added to an issue",
         where="by someone with write access, in any repository wired to this deployment",
         then_sub="deployment default model", fl="triage",
         chips=[tc("writes", "keeps a session"), tc("asks", "may ask you a question"), tc("reach", "reaches Linear through MCP")],
         last=("awaiting", "today 15:13"), line2=f'{code("gh-2f6a")} asked a question on acme/api#131', count="4 runs in 30 days · $0.65 this week"),
    dict(group="github", n=5, kind="issue", when=f"Issue {code('#40')} is closed", where="by someone with write access · once, then it is spent",
         then_sub="deployment default model", fl="deploy", chips=[tc("narrows", "only issue #40"), tc("done", "spent by gh-40a1")],
         last=("completed", "2 Oct, 11:20"), line2="Matches nothing now", count="1 run, ever", spent=True,
         note=f"It ran once ({code('gh-40a1')}) and is kept so history keeps its number. Delete {code('on.disarmed')} in the file to arm it again."),
    dict(group="gitlab", n=4, kind="pull_request", when="A merge request is opened or updated", where="by someone with write access, in any project wired to this deployment",
         then_sub="deployment default model", fl="review", chips=[tc("cost", "a run on every push")],
         last=("completed", "today 13:49"), line2=f'{code("gl-9a2c")} on acme/billing-ui!405', count="13 runs in 30 days · $2.26 this week",
         note="On GitLab, adding a label to a merge request counts as an update and fires this rule. A merge does not fire a close."),
]

def status_of(r):
    if r.get("next"):
        when, left = r["next"]
        ontime = f' · {chip("on time", "ok", "done")}' if r.get("ontime") else ""
        line2 = f"Next: {when}, {left}{ontime}" if r["n"] == 1 else f"Next: {when}, {left}"
    else:
        line2 = r["line2"]
    return st(r["last"][0], r["last"][1], line2, r["count"])

def rules_in(group):
    return "\n".join(rule(r["n"], r["kind"], r["when"], r["where"], r["then_sub"], r["fl"], r["chips"], status_of(r),
                          note=r.get("note", ""), spent=r.get("spent", False)) for r in RULES if r["group"] == group)

SCHED = card("On a schedule", f"""<ol class="tr-list">
{rules_in("schedule")}
</ol>""", sub="each runs in a folder, on the host that has it", id_="p-tr-schedule", flush=True)

GITHUB = card("From GitHub", f"""<ol class="tr-list">
{rules_in("github")}
</ol>""", sub="4 rules · webhooks from acme/web, acme/api and acme/billing", id_="p-tr-github", flush=True)

GITLAB = card("From GitLab", f"""<ol class="tr-list">
{rules_in("gitlab")}
</ol>""", sub="1 rule", id_="p-tr-gitlab", flush=True)

# ---- a week of schedules: Thu 8 Oct to Wed 14 Oct, now Thu 15:39 ----
DAYS = ["Thu 8", "Fri 9", "Sat 10", "Sun 11", "Mon 12", "Tue 13", "Wed 14"]
def wx(day, hh, mm=0): return (day + (hh + mm / 60) / 24) / 7 * 100
NOWX = wx(0, 15, 39)
def week():
    rows = [("1", "nightly-tidy", "daily 03:00"), ("6", "pm-weekly", "Mon 06:00"), ("", "Quiet hours", "github:acme/web")]
    RH = 36; H = RH * len(rows)
    g = []
    for i in range(len(rows)):
        g.append(f'<rect class="wk-band" x="0" y="{i * RH + 5}" width="100%" height="{RH - 10}" rx="13"/>')
    for d in range(1, 7):
        g.append(f'<line class="wk-day" x1="{d / 7 * 100:.3f}%" x2="{d / 7 * 100:.3f}%" y1="0" y2="{H}"/>')
    # quiet hours (Mon to Fri, 22:00 to 06:00 Amsterdam = 20:00 to 04:00 UTC); the Wednesday night spills into today
    qs = [(-1, 20)] + [(d, 20) for d in (0, 1, 4, 5, 6)]  # start days: Wed 7 (prev), Thu, Fri, Mon, Tue, Wed
    for d, h in qs:
        a = max(0, wx(d, h)); b = min(100, wx(d, h) + 8 / 24 / 7 * 100)
        if b > a:
            g.append(f'<rect class="wk-quiet" x="{a:.3f}%" y="{2 * RH + 8}" width="{b - a:.3f}%" height="{RH - 16}" rx="10"/>')
    # nightly-tidy at 03:00 each day: today's has run, the rest will
    for d in range(7):
        x = wx(d, 3); cls = "wk-ran" if x < NOWX else "wk-next"
        g.append(f'<circle class="{cls}" cx="{x:.3f}%" cy="{RH / 2}" r="6"/>')
    g.append(f'<circle class="wk-next" cx="{wx(4, 6):.3f}%" cy="{RH * 1.5}" r="6"/>')
    g.append(f'<text class="wk-l" x="{wx(4, 6) + 1.2:.3f}%" y="{RH * 1.5 + 4}">Mon 06:00</text>')
    g.append(f'<line class="wk-now" x1="{NOWX:.3f}%" x2="{NOWX:.3f}%" y1="-4" y2="{H + 2}"/>')
    days = "".join(f'<text class="wk-ax" x="{(d + .5) / 7 * 100:.3f}%" y="{H + 16}" text-anchor="middle">{n}</text>' for d, n in enumerate(DAYS))
    labels = "".join(f'<p><b>{(n + " · ") if n else ""}{t}</b><span>{s}</span></p>' for n, t, s in rows)
    return f"""<div class="wk-scroll"><div class="wk">
  <div class="wk-labels">{labels}</div>
  <div class="wk-track"><span class="wk-cap">now</span>
    <svg class="wk-svg" height="{H + 20}" role="img" aria-label="This week: nightly-tidy fires every day at 03:00 UTC, today's run is done; pm-weekly fires Monday at 06:00 UTC; quiet hours for github:acme/web run 20:00 to 04:00 UTC on weekday nights.">{''.join(g)}{days}</svg>
  </div>
</div></div>
<p class="keyrow"><span><i class="wk-k wk-k--ran"></i>ran</span><span><i class="wk-k wk-k--next"></i>will fire</span><span><i class="wk-k wk-k--quiet"></i>quiet hours: forge jobs for acme/web wait, schedules are not affected</span></p>"""

WEEK = card("When schedules fire", week(), sub="this week, UTC", id_="p-tr-week")

KPIS = f"""<div class="cards-3">
{card('Set up', f'<p class="kpi"><b>7</b><span>2 on a schedule, 5 from forges</span></p><p class="tr-kp"><span>{ic("done", "ic ic--sm")}1 spent one-shot</span><span>{ic("parked", "ic ic--sm")}1 waiting for an answer</span></p>', id_="p-tr-count")}
{card('Next to fire', f'<p class="kpi"><b>11h 21m</b><span>until nightly-tidy</span></p><p class="tr-kp">03:00 UTC tomorrow, in {code("site")} on mini1</p>', id_="p-tr-next")}
{card('Started this week', f'<p class="kpi"><b>$27.71</b><span>by these rules</span></p><p class="tr-kp">plus nightly-tidy on plan:kimi · $33.07 for the whole deployment</p>', id_="p-tr-spend")}
</div>"""

FILTERS = f"""<div class="tr-filters" role="group" aria-label="Show rules">
  <button class="fpill fpill--on" type="button" aria-pressed="true">All <b>7</b></button>
  <button class="fpill" type="button" aria-pressed="false">{ic('clock', 'ic ic--sm')}Schedules <b>2</b></button>
  <button class="fpill" type="button" aria-pressed="false">{ic('tag', 'ic ic--sm')}Labels <b>2</b></button>
  <button class="fpill" type="button" aria-pressed="false">{ic('comment', 'ic ic--sm')}Comments <b>1</b></button>
  <button class="fpill" type="button" aria-pressed="false">{ic('pr', 'ic ic--sm')}Pull requests <b>1</b></button>
  <button class="fpill" type="button" aria-pressed="false">{ic('issue', 'ic ic--sm')}Issues <b>1</b></button>
</div>"""

def why_not(n, text):
    return f'<li><span class="tr-n tr-n--sm">{n}</span><span>{text}</span></li>'

GATES = [("shield", "Signature", "the delivery is from the forge"), ("cancel", "Bot loop", "not one of our own comments"),
         ("slot-held", "Write access", "the person who acted has it"), ("queue", "Duplicates", "same target and flow within 10 minutes"),
         ("clock", "Quiet hours", "acme/web: 20:00 to 04:00 UTC, weekdays"), ("box", "Job image", "present on the host"),
         ("spend", "Spend caps", "today $15.04 of $25.00")]

CHECK = card("Which rule would run?", f"""<p class="muted tr-p">Describe an event and see which rule starts a job, and why the others do not. Nothing is sent or spent.</p>
<div class="tr-form">
  <div class="field"><label for="tc-f">Forge</label><select id="tc-f" class="select"><option>GitHub</option></select></div>
  <div class="field"><label for="tc-r">Repository</label><input id="tc-r" class="input input--code" value="acme/web"></div>
  <div class="field tr-span"><label for="tc-e">What happens</label><select id="tc-e" class="select"><option>A comment on an issue</option></select></div>
  <div class="field tr-span"><label for="tc-t">Comment</label><input id="tc-t" class="input" value="@pi triage the flaky checkout test"></div>
  <div class="field tr-span"><label for="tc-w">From</label><select id="tc-w" class="select"><option>a collaborator with write access</option></select></div>
</div>
<div class="tr-btnrow">{btn('Check', 'primary', 'search', sm=False)}</div>
<div class="tr-result" role="region" aria-live="polite" aria-label="Result">
  <p class="tr-res__h">{ic('done')}Rule 3 starts a job with flow <b>triage</b></p>
  <p class="tr-res__s">The comment contains {code('@pi')}, so rule 3 matches. Its next word, <b>triage</b>, is rule 7's flow, so the job runs triage. Everything else comes from rule 3: it keeps a session, and its instructions go above the issue text.</p>
  <p class="tr-res__k">The other rules</p>
  <ul class="tr-why">
    {why_not("1", "a schedule, not an event")}{why_not("6", "a schedule, not an event")}
    {why_not("2", "adding a label, and this is a comment")}{why_not("7", "adding a label; only its flow is borrowed")}
    {why_not("5", "spent, and only for closing #40")}{why_not("4", "GitLab only")}
  </ul>
  <p class="tr-res__k">Checks it still passes when it arrives</p>
  <ul class="tr-gates">{''.join(f'<li>{ic("done", "ic ic--sm")}<b>{h}</b><span>{s}</span></li>' for i, h, s in GATES)}</ul>
</div>""", sub="reads the triggers file and the gates as they are now", id_="p-tr-check")


def page(role="operator"):
    if role == "viewer":
        return viewer_page()
    inner = (tabs("Rules") + KPIS +
             f'<div class="cols"><div class="stack">{FILTERS}{WEEK}{SCHED}{GITHUB}{GITLAB}</div><div class="stack">{CHECK}</div></div>')
    return shell("Triggers", inner, "Triggers",
                 sub=f"What starts a job, in plain words. 7 rules in {code('…/deploy/triggers.json')}.",
                 end=btn("Add a trigger", "primary", "plus", sm=False))

# ---------------- the viewer's page: the same rules, runs and check, and nothing that writes ----------------
VIEWER_NOTE = (f'<p class="collapsed" id="p-tr-viewer" data-panel>{ic("eye", "ic ic--sm")}<b>Viewer.</b> '
               'You see every rule, its last run and next fire, and the check. Adding and editing a rule are for operators.</p>')

def viewer_page():
    inner = (tabs("Rules") + VIEWER_NOTE + KPIS +
             f'<div class="cols"><div class="stack">{FILTERS}{WEEK}{SCHED}{GITHUB}{GITLAB}</div><div class="stack">{CHECK}</div></div>')
    return shell("Triggers", inner, "Triggers", sub="What starts a job, in plain words. 7 rules in the triggers file.", role="viewer")

# ---------------- the phone card: each rule as when this, run that; a short list of next fires; one action ----------------
GROUP_TITLE = {"schedule": ("On a schedule", "each runs in a folder, on the host that has it"),
               "github": ("From GitHub", "4 rules"), "gitlab": ("From GitLab", "1 rule")}

def rule_phone(r):
    icon, word = KIND[r["kind"]]
    kind, when = r["last"]
    last = r.get("line2") if not r.get("next") else r["count"]
    nxt = (f'<p class="tp-next">{ic("clock", "ic ic--sm")}<span>Next {r["next"][0]}, {r["next"][1]}</span></p>'
           if r.get("next") else "")
    note = (f'<details class="tp-note"><summary>{ic("info", "ic ic--sm")}Good to know</summary><p>{r["note"]}</p></details>'
            if r.get("note") else "")
    chips = f'<p class="tr-chips">{"".join(r["chips"])}</p>' if r["chips"] else ""
    return f"""<li class="tp{' tp--spent' if r.get('spent') else ''}">
  <div class="tp-h"><span class="tr-n" aria-label="Trigger {r['n']}">{r['n']}</span><span class="tp-k">{ic(icon, 'ic ic--sm')}{word}</span><a class="tp-open" href="#" aria-label="Open trigger {r['n']}">{ic('chev-r', 'ic ic--sm')}</a></div>
  <p class="tp-when">{r['when']}</p>
  <p class="tp-then">runs {flow(r['fl'])}</p>
  {chips}
  <p class="tp-last">{badge(kind)}<span class="tp-t">{when}</span></p>
  <p class="tr-sub">{last}</p>
  {nxt}{note}
</li>"""

def phone_rules(group):
    title, sub = GROUP_TITLE[group]
    lis = "".join(rule_phone(r) for r in RULES if r["group"] == group)
    return card(title, f'<ol class="tp-list">{lis}</ol>', sub=sub, id_=f"p-tr-{group}", flush=True)

PHONE_KPIS = f"""<section class="card tp-kpis" id="p-tr-count" data-panel aria-label="Rules at a glance">
  <p><b>7</b><span>rules</span></p><p><b>11h 21m</b><span>to the next fire</span></p><p><b>$27.71</b><span>this week</span></p>
</section>"""

NEXT_FIRES = card("Next fires", f"""<ul class="tp-fires">
  <li><span class="tp-fires__w"><b>03:00 tomorrow</b><span>in 11h 21m</span></span><span class="tp-fires__r"><span class="tr-n tr-n--sm">1</span>nightly-tidy, in {code('site')} on mini1</span>{chip("on time", "ok", "done")}</li>
  <li><span class="tp-fires__w"><b>Mon 12 Oct 06:00</b><span>in 3d 14h</span></span><span class="tp-fires__r"><span class="tr-n tr-n--sm">6</span>pm-weekly, in {code('pm')} on mini1</span></li>
  <li class="tp-fires--quiet"><span class="tp-fires__w"><b>Tonight 20:00</b><span>to 04:00 UTC</span></span><span class="tp-fires__r">{ic('clock', 'ic ic--sm')}Quiet hours: forge jobs for acme/web wait. Schedules still fire.</span></li>
</ul>""", sub="UTC", id_="p-tr-week")

PHONE_CHECK = card("Which rule would run?", f"""<p class="muted tr-p">Describe an event and see which rule starts a job. Nothing is sent or spent.</p>
{btn('Check an event', 'primary', 'search', sm=False)}""", id_="p-tr-check")

def phone_page():
    inner = (tabs("Rules") + PHONE_KPIS + PHONE_CHECK + NEXT_FIRES +
             phone_rules("schedule") + phone_rules("github") + phone_rules("gitlab"))
    return shell("Triggers", inner, "Triggers", sub="What starts a job, in plain words.")

PHONE_CSS = """
.tp-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: var(--space-4); }
.tp-kpis p { display: grid; gap: 2px; }
.tp-kpis b { font-size: 20px; line-height: 24px; font-weight: 800; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.tp-kpis span { font-size: 12px; color: var(--ink-muted); }
.tp-list { display: grid; }
.tp { display: grid; gap: 6px; padding: var(--space-4); border-top: 1px solid var(--line); }
.tp-list .tp:first-child { border-top: 0; }
.tp-h { display: flex; align-items: center; gap: 10px; }
.tp-k { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.tp-open { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; color: var(--ink-muted); }
.tp-when { font-size: 15px; line-height: 22px; font-weight: 650; color: var(--ink); }
.tp-then { font-size: 14px; color: var(--ink); }
.tp-last { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tp-t { font-size: 13px; font-weight: 600; color: var(--ink); }
.tp-next { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); font-weight: 600; }
.tp-note summary { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); cursor: pointer; }
.tp-note p { margin-top: 6px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tp--spent { background: repeating-linear-gradient(135deg, transparent 0 10px, var(--surface-2) 10px 11px); }
.tp--spent .tr-flow { background: var(--surface-3); color: var(--ink); }
.tp-fires { display: grid; gap: 8px; }
.tp-fires li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.tp-fires__w { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; }
.tp-fires__w b { color: var(--ink); font-variant-numeric: tabular-nums; }
.tp-fires__w span { font-size: 12px; color: var(--ink-muted); }
.tp-fires__r { grid-column: 1; display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tp-fires li > .chip { grid-column: 2; grid-row: 1 / span 2; }
.tp-fires li.tp-fires--quiet { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
#p-tr-check .btn { width: 100%; justify-content: center; }
"""

CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.tr-kp { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: var(--ink-muted); }
.tr-kp > span { display: inline-flex; align-items: center; gap: 5px; }
.tr-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.tr-filters .fpill b { margin-left: 2px; }
.tr-list { display: grid; }
.tr { display: grid; grid-template-columns: 28px minmax(0, 1.25fr) 20px minmax(0, 1fr) 230px 40px; gap: 6px var(--space-3); align-items: start;
      padding: var(--space-4) var(--space-5); border-top: 1px solid var(--line); }
.tr-list .tr:first-child { border-top: 0; }
.tr-n { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--surface-2); color: var(--ink); font-size: 13px; font-weight: 750; font-variant-numeric: tabular-nums; }
.tr-n--sm { width: 22px; height: 22px; font-size: 11px; flex: none; }
.tr-when { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.tr-kind { background: var(--surface-2); color: var(--ink); }
.tr-k { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.tr-s { font-size: 15px; line-height: 22px; font-weight: 650; color: var(--ink); }
.tr-sub { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tr-arrow { color: var(--ink-faint); padding-top: 22px; }
.tr-then { display: grid; gap: 4px; padding-top: 18px; }
.tr-flow { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); background: var(--primary); color: var(--on-primary); font-size: 13px; font-weight: 700; vertical-align: 1px; }
.tr-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.tr-status { display: grid; gap: 3px; padding-top: 2px; }
.tr-status > p:first-child { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tr-t { font-size: 13px; font-weight: 600; color: var(--ink); }
.tr-status .chip { height: 22px; vertical-align: middle; }
.tr-act { padding-top: 2px; }
.tr-note { grid-column: 2 / -1; display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tr-note .ic { flex: none; margin-top: 2px; color: var(--ink); }
.tr--spent { background: repeating-linear-gradient(135deg, transparent 0 10px, var(--surface-2) 10px 11px); }
.tr--spent .tr-flow { background: var(--surface-3); color: var(--ink); }
.wk { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; margin-top: 34px; }
.wk-labels { display: grid; grid-template-rows: repeat(3, 36px); align-items: center; }
.wk-labels p { display: grid; font-size: 12px; line-height: 15px; }
.wk-labels b { color: var(--ink); font-weight: 700; }
.wk-labels span { color: var(--ink-muted); }
.wk-track { position: relative; min-width: 0; }
.wk-svg { width: 100%; display: block; overflow: visible; }
.wk-band { fill: var(--surface-2); }
.wk-day { stroke: var(--line); stroke-width: 1; }
.wk-quiet { fill: var(--surface-3); }
.wk-ran { fill: var(--ink-faint); }
.wk-next { fill: var(--surface); stroke: var(--running); stroke-width: 2; }
.wk-l { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.wk-now { stroke: var(--ink); stroke-width: 2; }
.wk-ax { font-size: 11px; fill: var(--ink-faint); }
.wk-cap { position: absolute; top: -24px; left: NOWPCT; transform: translateX(-50%); height: 20px; padding: 0 8px; border-radius: 10px; background: var(--primary); color: var(--on-primary); font-size: 11px; font-weight: 700; line-height: 20px; }
.wk-k { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.wk-k--ran { background: var(--ink-faint); }
.wk-k--next { box-shadow: inset 0 0 0 2px var(--running); }
.wk-k--quiet { width: 18px; border-radius: 5px; background: var(--surface-3); }
.tr-p { font-size: 13px; margin-bottom: var(--space-3); }
.tr-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.tr-span { grid-column: 1 / -1; }
.tr-btnrow { margin: var(--space-3) 0; }
.tr-result { display: grid; gap: 8px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--ok-tint); }
.tr-res__h { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: var(--ink); }
.tr-res__h .ic { color: var(--ok-ink); }
.tr-res__s { font-size: 13px; line-height: 20px; color: var(--ink); }
.tr-res__k { font-size: 12px; font-weight: 700; color: var(--ink); margin-top: 4px; }
.tr-why { display: grid; gap: 6px; }
.tr-why li { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.tr-why .tr-n { background: var(--surface); }
.tr-gates { display: grid; gap: 4px; }
.tr-gates li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 6px; align-items: baseline; font-size: 12px; color: var(--ink); }
.tr-gates .ic { color: var(--ok-ink); align-self: center; }
.tr-gates span { color: var(--ink); }
@media (max-width: 1200px) { .tr { grid-template-columns: 28px minmax(0, 1fr) 20px minmax(0, 1fr) 40px; } .tr-status { grid-column: 2 / -2; } }
@media (max-width: 760px) {
  .tr { grid-template-columns: 28px minmax(0, 1fr) 36px; padding: var(--space-4); }
  .tr-when { grid-column: 2; } .tr-act { grid-column: 3; grid-row: 1; }
  .tr-arrow { display: none; }
  .tr-then, .tr-status, .tr-note { grid-column: 2 / -1; padding-top: 0; }
  .wk-scroll { overflow-x: auto; margin: 0 calc(-1 * var(--space-5)); padding: 0 var(--space-5); }
  .wk { grid-template-columns: 110px minmax(0, 1fr); min-width: 600px; }
  .tr-form { grid-template-columns: minmax(0, 1fr); }
  .tr-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .tr-filters { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
}
"""

VIEWER_README = """
Triggers as a viewer sees them. The rules, their runs and the check are the same as an operator's page; nothing on it writes.

**How a person uses it.**
- **The numbers**, the week strip and every rule, read as on the operator's page: when, runs, what it adds, the last run and the next fire.
- **Which rule would run?** stays. It reads the triggers file and the gates and writes nothing, so a viewer may run it.
- A row still opens the trigger's own page, which a viewer reads without its Edit, Delete or Fire now.
- One line under the tabs says what is the operator's.

**Panels.** `p-tr-viewer`, `p-tr-count`, `p-tr-next`, `p-tr-spend`, `p-tr-week`, `p-tr-schedule`, `p-tr-github`, `p-tr-gitlab`, `p-tr-check`.

**Who sees what.** Left out for a viewer: *Add a trigger*, any edit, *Fire now* (on a trigger's page), and dispatcher proposals (on the Dispatchers tab, proposed). The subtitle names the triggers file without its folder.

**Fixture note.** The same fixture as TriggersScreen: the seven rules and their last runs, from one list in `gen_triggers.py`.
"""

PHONE_README = """
Triggers on a phone. Each rule is a short block that reads as a sentence, the week strip becomes a list of next fires, and the check is the one action.

**How a person uses it.**
- **Tabs** scroll in their own row: Rules, Watch (planned) and Dispatchers (proposed).
- **At a glance**: 7 rules, the time to the next fire, and what the rules started this week.
- **Which rule would run?** One button, *Check an event*, opens the check on its own page.
- **Next fires**: nightly-tidy at 03:00 tomorrow (on time), pm-weekly on Monday at 06:00, and tonight's quiet hours for acme/web forge jobs.
- **Rules**, grouped by where they come from. Each block has the rule's number and kind, the event as a sentence, the flow as a dark pill, what it adds, the last run's outcome and time, a run or spend line, the next fire for a schedule, and *Good to know* folded under it where the forge surprises people. The arrow opens the trigger's page.

**Panels.** `p-tr-count`, `p-tr-check`, `p-tr-week`, `p-tr-schedule`, `p-tr-github`, `p-tr-gitlab`.

**Who sees what.** As on desktop: a viewer gets the same card, and the check, without editing on the trigger's page.

**Fixture note.** The same fixture as TriggersScreen, from the same rule list.
"""

if __name__ == "__main__":
    CSS = CSS.replace("NOWPCT", f"{NOWX:.2f}%")
    write("TriggersScreen", card_marker("Triggers", 2400, 1440, "Triggers in plain words: when this happens, run that, with each rule's status, a week of schedules and a check for which rule an event starts"),
          "Triggers", page(), CSS)
    readme("TriggersScreen", """
Triggers get their own page, and every rule reads as a sentence: when this happens, run that flow. Each rule shows its status, and the page can say which rule a given event would start.

**How a person uses it.**
- **The numbers.** How many rules there are and of which kind, which fires next and when, and what the rules started this week.
- **When schedules fire.** A week strip in UTC with a dot for each time a schedule fires (filled when it ran, outlined when it will) and the quiet hours that hold forge jobs. The quiet hours do not hold schedules, and the key says so.
- **Rules, grouped by where they come from.** On a schedule, then one card per forge. Every rule is one row:
  - **Its number.** The same number is used in the editor, in previews and in the audit log.
  - **When.** The kind's glyph and word, then the event as a sentence ("The label `pi:frontend` is added to an issue"), with who may make it happen and where under it ("by someone with write access, in any repository wired to this deployment").
  - **Runs.** The flow as a dark pill, with the model and venue under it.
  - **Chips.** A chip says what the rule adds, with a glyph and a word: *costs more*, *reaches*, *writes*, *asks* or *narrows*. Spent rules get a *spent* chip.
  - **Status.** The last run's outcome and when it happened, the next fire for a schedule (with on time, overdue or stalled), and runs in 30 days with spend this week.
  - **Good to know.** A grey line under a rule, for the forge rules that surprise people. On GitHub, re-labelling fires a label rule again. A comment can pick another rule's flow. On GitLab, a label counts as an update.
  - **Spent one-shots.** The row is struck through with a light hatch and says how to arm the rule again.
- **Which rule would run?** The person describes an event (forge, repository, what happens, the comment text, who did it). The check names the rule that starts a job and the flow it runs, says in one line why each other rule does not match, and lists the checks the event must still pass when it arrives. It sends nothing and spends nothing.
- A row opens the trigger's own page. *Add a trigger* opens the editor. The compact *Watch* screen (#735) is reached from Configuration today. Its second tab here belongs to this planned Triggers screen (#750), because a watch rule is a trigger too.

**Panels.** `p-tr-count`, `p-tr-next`, `p-tr-spend`, `p-tr-week`, `p-tr-schedule`, `p-tr-github`, `p-tr-gitlab`, `p-tr-check`.

**The server provides.**
- Per rule: kind, selectors, forge, folder and host, flow, model, venue, the options behind each chip, and the one-shot state.
- The last run's outcome and time, runs in 30 days, spend this week, and the next fire and health of each schedule.
- The pause windows.
- For the check: a read-only match of a described event against the triggers file, the same match the receiver makes, plus each always-on gate's current state. The check is new: the console has no such route today.

A viewer sees the same rules, statuses and the check, without *Add a trigger* or edits.

**Why it works this way.**
- **One number everywhere.** A rule's number is the same here, in the editor, in previews and in the audit log.
- **When, then Runs.** *When* says what happens and who may make it happen; *Runs* says which flow, with which model and where.
- **The chips.** *Costs more* raises the bill. *Reaches* goes further than the repository. *Writes* writes something down: a session, a folder, the budget split. *Asks* may stop and wait for a person. *Narrows* does less than the kind would. *Spent* is finished and matches nothing. Each carries a glyph and a word, so the page needs no key.
- **Good to know** lines are the forge's own rules that surprise people.

**Fixture note.** The seven rules, their numbering, flows, forges, folders and models come from the fixture's triggers file. These are sample values:
- run counts and spend, which follow the flows map;
- the last runs (gh-e9a0, gh-2f6a and gl-9a2c are fixture runs; the times of the others are sample);
- the spent one-shot gh-40a1;
- the comment in the check.
""")
    write("TriggersViewer", card_marker("Triggers", 2400, 1440, "Triggers as a viewer sees them: every rule, its last run and next fire, and the check; no adding or editing"),
          "Triggers, as a viewer", page("viewer"), CSS)
    readme("TriggersViewer", VIEWER_README)
    write("TriggersPhone", card_marker("Phone", 2600, 390, "Triggers on a phone: each rule as when this, run that, the next fires, and the check as the one action"),
          "Triggers on a phone", phone_page(), CSS + PHONE_CSS)
    readme("TriggersPhone", PHONE_README)
    print("triggers written")
