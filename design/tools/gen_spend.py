"""Spend (1440 and 390), Models (planned #716/#717/#693) and Watch (planned #735) on the Pulse kit."""
import os
from pulse import *
from common2 import ICONS, S as _S

# ============================================================ fixture runs (Runs page, first page)
# (day, end, id, project, flow, model, tokens, cost or None)
RUNS = [
    ("08", "15:30", "gh-e9a0", "billing", "fix", "sonnet", 0, None),
    ("08", "15:25", "gh-a91e", "web", "fix", "sonnet", 85577, .17), ("08", "15:13", "gh-2f6a", "api", "triage", "sonnet", 125448, .21),
    ("08", "15:12", "gh-9575", "web", "fix", "sonnet", 150126, .24), ("08", "15:10", "gh-f0c2", "web", "fix", "sonnet", 85577, .17),
    ("08", "14:48", "gh-ebd7", "billing", "fix", "sonnet", 186938, .36), ("08", "14:39", "gh-4add", "web", "fix", "sonnet", 139830, .21),
    ("08", "14:34", "gh-a3ac", "web", "fix", "sonnet", 98910, .17), ("08", "14:17", "gh-8251-r2", "web", "frontend-fix", "sonnet", 212921, .36),
    ("08", "14:09", "gh-bd09", "web", "fix", "sonnet", 86371, .17), ("08", "14:06", "gh-e12d", "web", "fix", "sonnet", 196050, .30),
    ("08", "13:55", "gh-8251-r1", "web", "frontend-fix", "sonnet", 167330, .29), ("08", "13:49", "gl-9a2c", "billing", "review", "sonnet", 116750, .18),
    ("08", "12:43", "gh-03a9", "api", "fix", "sonnet", 120476, .25), ("08", "12:39", "gh-7cdf", "billing", "fix", "sonnet", 254648, .40),
    ("08", "12:23", "gh-98f4", "web", "fix", "sonnet", 196085, .30), ("08", "11:05", "gh-985d", "api", "fix", "sonnet", 104203, .16),
    ("08", "10:59", "gh-4a7e", "billing", "fix", "sonnet", 0, None), ("08", "10:44", "gl-021a", "billing", "review", "sonnet", 74575, .14),
    ("08", "10:43", "gh-7813", "billing", "fix", "sonnet", 204342, .32), ("08", "09:45", "gh-444c", "api", "fix", "sonnet", 152220, .30),
    ("08", "09:29", "gh-52a8", "billing", "fix", "sonnet", 255452, .43), ("08", "08:58", "gh-b0bd", "web", "fix", "sonnet", 53389, .10),
    ("08", "03:11", "nightly-tidy", "ops", "tidy", "kimi", 185186, None),
    ("07", "17:41", "gh-476b", "billing", "fix", "sonnet", 207067, .41), ("07", "17:15", "gh-c3f8", "billing", "fix", "sonnet", 117130, .31),
    ("07", "16:52", "gl-af91", "billing", "review", "sonnet", 104321, .18), ("07", "15:06", "gh-889c", "web", "fix", "sonnet", 96970, .21),
    ("07", "14:59", "gh-2579", "web", "fix", "sonnet", 137194, .25), ("07", "14:43", "gh-6e32", "web", "fix", "sonnet", 100634, .23),
    ("07", "14:29", "gh-decd", "web", "fix", "sonnet", 59058, .14), ("07", "14:25", "gh-c047", "web", "fix", "sonnet", 90206, .20),
    ("07", "14:11", "gh-70e2-r1", "web", "frontend-fix", "sonnet", 162916, .29), ("07", "14:07", "gh-071f", "web", "fix", "sonnet", 193191, .28),
    ("07", "14:05", "gh-3b78", "billing", "fix", "sonnet", 252407, .38), ("07", "13:58", "gh-70e2-r2", "web", "frontend-fix", "sonnet", 88168, .23),
    ("07", "13:42", "gl-0d47", "billing", "review", "sonnet", 117367, .19), ("07", "13:10", "gh-e198", "api", "fix", "sonnet", 59095, .13),
    ("07", "13:07", "gh-24a2", "billing", "fix", "sonnet", 152526, .26), ("07", "12:22", "gh-da47", "web", "fix", "sonnet", 69846, .12),
    ("07", "11:17", "gh-3052", "api", "fix", "sonnet", 111132, .23), ("07", "11:15", "gh-975e", "billing", "fix", "sonnet", 219575, .40),
    ("07", "10:45", "gl-04af", "billing", "review", "sonnet", 118560, .20), ("07", "08:45", "gh-31f7", "web", "fix", "sonnet", 104553, .19),
    ("07", "08:41", "gh-dc3f", "api", "fix", "sonnet", 77965, .18), ("07", "07:54", "gh-01db", "billing", "fix", "sonnet", 108624, .24),
    ("07", "03:07", "nightly-tidy", "ops", "tidy", "kimi", 186469, None),
    ("06", "16:59", "gh-1f43", "billing", "fix", "sonnet", 310155, .48), ("06", "16:57", "gl-cf40", "billing", "review", "sonnet", 104566, .15),
    ("06", "15:11", "gh-efed", "web", "fix", "sonnet", 127934, .20),
]
METERED = [r for r in RUNS if r[7] is not None]
def in24h(r):
    return (r[0] == "08") or (r[0] == "07" and r[1] >= "15:39")
M24 = [r for r in METERED if in24h(r)]
COST24 = round(sum(r[7] for r in M24), 2)                      # 6.13
TOK24_METERED = sum(r[6] for r in M24)                          # metered tokens in 24h
AVG24 = COST24 / len(M24)
TODAY_METERED = round(sum(r[7] for r in METERED if r[0] == "08"), 2)   # 5.23
OCT7 = round(sum(r[7] for r in METERED if r[0] == "07"), 2)           # 5.25
RUNNING_HOLDS = [2.00, 2.00, 2.00, 3.81]  # sample actual reservations, not a counter difference
HELD = round(sum(RUNNING_HOLDS), 2)
MONTUE = round(33.07 - 15.04 - OCT7, 2)

def money(v): return f"${v:,.2f}"
def by(key):
    out = {}
    for r in METERED:
        out[key(r)] = out.get(key(r), 0) + r[7]
    return sorted(out.items(), key=lambda kv: -kv[1])
BY_FLOW = by(lambda r: r[4])
BY_PROJECT = by(lambda r: r[3])
SONNET = round(sum(r[7] for r in METERED), 2)
KIMI_TOK = sum(r[6] for r in RUNS if r[5] == "kimi")
NRUNS = len(METERED)

# ============================================================ shared bits
PROJ = [("All", ""), ("web", ""), ("api", ""), ("billing", ""), ("ops", "")]
def projseg():
    return ('<div class="projseg" role="group" aria-label="Project"><span class="projseg__l">Project</span>'
            + "".join(f'<button type="button" aria-pressed="{"true" if p == "All" else "false"}">{p if p == "All" else tag(p)}</button>' for p, _ in PROJ) + "</div>")
SPEND_TABS = [("spend", "Spend", "/insights"), ("pie", "Budget split", "/insights/budget-split"), ("slot", "Capacity", "/insights/capacity"),
              ("runs", "Breakdown", "/insights/breakdown"), ("flows", "Flows map", "/insights/flows")]
def spend_tabs(cur="Spend"):
    """The Spend page's views. Server-rendered links; the current one carries aria-current."""
    return ('<nav class="tabs sp-tabs" aria-label="Spend views">' + "".join(
        f'<a href="{h}"{" aria-current=" + chr(34) + "page" + chr(34) if n == cur else ""}>{ic(i, "ic ic--sm")}{n}</a>' for i, n, h in SPEND_TABS) + "</nav>")
RANGE = '<div class="seg sp-range" role="group" aria-label="Range"><button aria-pressed="true">7 days</button><button aria-pressed="false">30 days</button><button aria-pressed="false">Month to date</button></div>'

def hbars(rows, unit=money, maxv=None, note=""):
    """rows: (label_html, value, sub). One hue, labels written out."""
    maxv = maxv or max(v for _, v, _ in rows)
    out = []
    for lab, v, sub in rows:
        w = max(v / maxv * 100, 1.5)
        out.append(f'<li class="sp-hb"><span class="sp-hb__l">{lab}{f"<small>{sub}</small>" if sub else ""}</span>'
                   f'<svg class="sp-hb__bar" height="12" role="img" aria-label="{E(str(v))}"><rect class="sp-hb__bed" width="100%" height="12" rx="6"/><rect class="sp-hb__fill" width="{w:.1f}%" height="12" rx="6"/></svg>'
                   f'<b class="sp-hb__v">{unit(v)}</b></li>')
    return f'<ul class="sp-hbars">{"".join(out)}</ul>{f"<p class=sp-note>{note}</p>" if note else ""}'

# ============================================================ SPEND
DAYS = [("Fri 2", 4.88, 0, True), ("Sat 3", 0.31, 0, True), ("Sun 4", 0.00, 0, True), ("Mon 5", round(MONTUE - 6.16, 2), 0, True),
        ("Tue 6", 6.16, 0, True), ("Wed 7", OCT7, 0, False), ("Thu 8", TODAY_METERED, HELD, False)]
def spend_chart():
    H, top, plot = 230, 22, 170  # plot from y=top to y=top+plot
    cap = 25.0
    def y(v): return top + plot - v / cap * plot
    s = [f'<svg class="sp-chart" height="{H}" role="img" aria-label="Spend per day for 7 days against the $25.00 daily cap: today $15.04 spent and held">']
    s.append(f'<line class="sp-cap" x1="0" x2="100%" y1="{y(cap):.1f}" y2="{y(cap):.1f}"/><text class="sp-ll" x="100%" y="{y(cap)-6:.1f}" text-anchor="end">daily cap $25.00</text>')
    s.append(f'<line class="sp-base" x1="0" x2="100%" y1="{top+plot}" y2="{top+plot}"/>')
    n = len(DAYS)
    for i, (d, v, held, sample) in enumerate(DAYS):
        cx = (i + .5) / n * 100; w = 7.5
        x = cx - w / 2
        if v > 0:
            s.append(f'<rect class="sp-bar{" sp-bar--today" if held else ""}" x="{x:.2f}%" y="{y(v):.1f}" width="{w}%" height="{v/cap*plot:.1f}" rx="8"><title>{d}: {money(v)} metered</title></rect>')
        if held:
            s.append(f'<rect class="sp-held" x="{x:.2f}%" y="{y(v+held):.1f}" width="{w}%" height="{held/cap*plot:.1f}" rx="8"><title>{d}: {money(held)} held for running jobs</title></rect>')
        tot = v + held
        s.append(f'<text class="sp-v" x="{cx:.2f}%" y="{y(tot)-7:.1f}" text-anchor="middle">{money(tot)}</text>')
        s.append(f'<text class="sp-d{" sp-d--now" if held else ""}" x="{cx:.2f}%" y="{H-6}" text-anchor="middle">{d}</text>')
    s.append("</svg>")
    key = ('<p class="keyrow"><span><i class="sp-k sp-k--bar"></i>Metered</span><span><i class="sp-k sp-k--held"></i>Held for running jobs, released when they settle</span>'
           '</p>')
    return "".join(s) + key

def hist():
    costs = [r[7] for r in METERED]
    bins = [0] * 10  # $0.00 .. $0.50 in $0.05 steps
    for c in costs:
        bins[min(int(c / 0.05), 9)] += 1
    mx = max(bins)
    H, top, plot = 150, 16, 104
    s = [f'<svg class="sp-hist" height="{H}" role="img" aria-label="Cost per run for {len(costs)} runs: most between $0.15 and $0.30, largest $0.48; the job cap is $2.00">']
    span = 78  # percent of width used by $0.00-$0.50
    for i, n in enumerate(bins):
        if not n: continue
        x = i / 10 * span + .6; w = span / 10 - 1.2
        h = n / mx * plot
        s.append(f'<rect class="sp-hbin" x="{x:.2f}%" y="{top+plot-h:.1f}" width="{w:.2f}%" height="{h:.1f}" rx="5"><title>${i*0.05:.2f} to ${(i+1)*0.05:.2f}: {n} runs</title></rect>')
        s.append(f'<text class="sp-v" x="{x + w/2:.2f}%" y="{top+plot-h-5:.1f}" text-anchor="middle">{n}</text>')
    s.append(f'<line class="sp-base" x1="0" x2="{span}%" y1="{top+plot}" y2="{top+plot}"/>')
    for i, lab in [(0, "$0.00"), (4, "$0.20"), (8, "$0.40")]:
        s.append(f'<text class="sp-d" x="{i/10*span:.2f}%" y="{top+plot+18}">{lab}</text>')
    s.append(f'<text class="sp-gap" x="{span+5:.1f}%" y="{top+plot+4}" text-anchor="middle">…</text>')
    s.append(f'<line class="sp-capline" x1="95%" x2="95%" y1="{top}" y2="{top+plot}"/>')
    s.append(f'<text class="sp-ll sp-ll--cap" x="95%" dx="-6" y="{top+10}" text-anchor="end">job cap</text><text class="sp-d" x="95%" y="{top+plot+18}" text-anchor="middle">$2.00</text>')
    s.append("</svg>")
    return "".join(s)

def split():
    parts = [("web", 40, 11.78, 45.00, False), ("billing", 35, 14.20, 42.00, True), ("api", 20, 6.65, 24.00, True), ("ops", 5, 0.44, 6.00, True)]
    x = 0; segs = []
    for i, (p, pct, used, share, s) in enumerate(parts):
        lab = f'<text class="sp-seg__t" x="{x}%" dx="12" y="22">{p} {pct}%</text>' if pct >= 15 else ""
        segs.append(f'<rect class="sp-seg sp-seg--{i%2}" x="{x}%" y="0" width="{pct}%" height="34" rx="10"><title>{p} {pct}%</title></rect>{lab}')
        x += pct
    rows = "".join(meterrow(p, f"{pct}% share", used / share, money(used), money(share)) for p, pct, used, share, s in parts)
    return (f'<svg class="sp-split" height="34" role="img" aria-label="Budget split this week: web 40, billing 35, api 20, ops 5 percent">{"".join(segs)}</svg>'
            f'<p class="sp-note">Written by <span class="code">pm-weekly</span> on Mon 5 Oct, 06:00 UTC, on claude-haiku-5-5.</p>'
            f'<div class="sp-rows">{rows}</div>')

def whatif():
    cur, est = COST24, 1.90
    bars = (f'<div class="sp-wi">'
            f'<span class="sp-wi__l">claude-sonnet-5-5<small>what it cost</small></span>{pbar(1.0, "idle", f"{money(cur)} actual", 12)}<b>{money(cur)}</b>'
            f'<span class="sp-wi__l">claude-haiku-5-5<small>estimate</small></span>{pbar(est / cur, "ok", f"about {money(est)} estimated", 12)}<b>about {money(est)}</b></div>')
    return f"""<div class="sp-wiform"><div class="field"><label for="wi-m">Run the same work on</label>
      <select id="wi-m" class="select"><option>claude-haiku-5-5</option><option>kimi-for-coding (plan)</option><option>claude-sonnet-5-5 (current)</option></select></div>
      <div class="field"><label for="wi-r">Runs</label><select id="wi-r" class="select"><option>Last 24 hours, {len(M24)} runs</option><option>This week</option></select></div></div>
  <p class="sp-wi__s">The same {len(M24)} runs on <b>claude-haiku-5-5</b> would have cost about <b>{money(est)}</b> instead of <b>{money(cur)}</b>.</p>
  {bars}
  <p class="sp-note sp-note--ic">{ic('doctor', 'ic ic--sm')}<span>An estimate from token counts and list prices. Outcomes may differ: a cheaper model can take more turns or fail more often.</span></p>"""

def metered_plan():
    return f"""<ul class="sp-mp">
  <li><span class="sp-mp__k">metered</span><span class="sp-mp__t"><b>claude-sonnet-5-5</b><small>{len(M24)} runs in 24 hours, {TOK24_METERED/1e6:.2f}M tokens</small></span><b class="sp-mp__v">{money(COST24)}</b></li>
  <li><span class="sp-mp__k">plan</span><span class="sp-mp__t"><b>kimi-for-coding</b><small>1 run in 24 hours (nightly-tidy), 185,186 tokens. Billed by plan:kimi, not per run.</small></span><b class="sp-mp__v">plan:kimi</b></li>
</ul>"""

def caps_card():
    rows = [("Jobs", "today", 25/40, "25", "40"), ("Jobs", "this week", 99/200, "99", "200"), ("Jobs", "this month", 166/600, "166", "600"),
            ("Tokens", "today", 3081250/8e6, "3.08M", "8.00M"), ("Deployment", "today, spent and held", 15.04/25, "$15.04", "$25.00"),
            ("Deployment", "this week", 33.07/120, "$33.07", "$120.00"), ("project:web", "this week", 11.78/45, "$11.78", "$45.00"),
            ("claude-sonnet-5-5", "this week", 32.46/80, "$32.46", "$80.00")]
    body = "".join(meterrow(*r) if r[0] == "Jobs" else meterrow(*r, tone="ok" if r[2] < 1 else "failed").replace('<line class="pbar__hold" x1="80%" x2="80%" y1="-3" y2="13"/>', "") for r in rows)
    body += '<p class="keyrow"><span><i class="k tone-ok"></i>Open</span><span><i class="k tone-attention"></i>From the job soft hold new starts are refused; nothing is spent.</span><span><i class="k tone-failed"></i>Full: another job at its cap would not fit</span></p>'
    return card("Caps", f'<div class="sp-caps">{body}</div>', sub="the tick on job windows is the 80% soft hold", end=btn("Edit caps", "", "config"), id_="p-caps")

def spend_body():
    kpis = f"""<div class="cards-4">
  {card("Spent this week", f'<p class="kpi"><b>$33.07</b><span>of $120.00, Mon to Thu</span></p>{pbar(33.07/120, "ok", "Week: 28 percent of cap", 10)}<p class="sp-kf">28% of the weekly cap. $86.93 left.</p>', id_="p-week")}
  {card("Today", f'<p class="kpi"><b>$15.04</b><span>of $25.00</span></p>{pbar(15.04/25, "ok", "Today: 60 percent of cap", 10)}<p class="sp-kf"><b>{money(TODAY_METERED)}</b> metered, <b>{money(HELD)}</b> held for 4 running jobs.</p>', end=chip("60%", "ok"), id_="p-today")}
  {card("Tokens today", f'<p class="kpi"><b>3.08M</b><span>of 8.00M</span></p>{pbar(3081250/8e6, "ok", "Tokens: 39 percent of cap", 10)}<p class="sp-kf">3,081,250 tokens, 39% of the daily token cap.</p>', id_="p-tokens")}
  {card("Average per run", f'<p class="kpi"><b>{money(AVG24)}</b><span>last 24 hours</span></p>{pbar(AVG24/2, "ok", "Average run against the $2.00 job cap", 10)}<p class="sp-kf">{len(M24)} metered runs. The job cap is <b>$2.00</b>; the largest run used <b>$0.48</b>.</p>', id_="p-avg")}
</div>"""
    over = card("Spend over time", spend_chart(), sub="per day, against the daily cap", id_="p-over")
    cost3 = f"""<div class="cards-3">
  {card("By flow", hbars([(f'<b>{f}</b>', v, '') for f, v in BY_FLOW]), sub="metered", id_="p-byflow")}
  {card("By model", hbars([('<b>claude-sonnet-5-5</b>', SONNET, f'{NRUNS} runs, metered'), ('<b>claude-haiku-5-5</b>', 0.06, '1 run, pm-weekly'), ('<b>kimi-for-coding</b>', 0.0, '2 runs on plan:kimi')], unit=lambda v: money(v) if v else 'plan'), id_="p-bymodel")}
  {card("By project", hbars([(tag(p), v, '') for p, v in BY_PROJECT] + [(tag('ops'), 0.0, 'tidy, on plan')], unit=lambda v: money(v) if v else 'plan'), id_="p-byproject")}
</div>
<p class="sp-note sp-note--wide">Cost by flow, model and project counts the {NRUNS} metered runs listed since Tue 6 Oct, 15:11 UTC: the first page of Runs.</p>"""
    sizes = card("Job sizes", hist() + f'<p class="sp-note">While a dollar window is set, each non-zero-rated run reserves its job cap; the largest of these {len(METERED)} runs used <b>$0.48</b>.</p>',
                 sub="cost per run", id_="p-sizes", end=btn("Change job cap", "", "config"))
    left = f'<div class="stack">{over}{cost3}{sizes}{card("Budget split", split(), sub="this week", id_="p-split")}</div>'
    right = f'<div class="stack">{caps_card()}{card("What if", whatif(), sub="another model, the same runs", id_="p-whatif")}{card("Metered and plan", metered_plan(), sub="last 24 hours", id_="p-plan")}</div>'
    return kpis + f'<div class="cols">{left}{right}</div>'

SPEND_CSS = """
.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}
"""

def spend_page():
    return shell("Spend", spend_tabs("Spend") + spend_body(), "Spend", sub="Money and tokens against every cap, and where they went.", end=RANGE + projseg())

# ============================================================ MODELS (#773)
def models_page():
    problems = '<section id="p-model-problems" data-panel>' + banner("attention", "attention", "A capped Radius model cannot start",
        "Doctor on mini1 says Radius cannot be bounded by a per-job dollar cap. Choose a priced, boundable model for this capped role or trigger.") + '</section>'
    rows = [
        ("default", "planner", "anthropic/claude-sonnet-5-5", "openai/gpt-5", "Row 1, fix; row 3, triage"),
        ("default", "editor", "anthropic/claude-sonnet-5-5", "None", "Row 2, frontend-fix"),
        ("web", "planner", "anthropic/claude-haiku-5-5", "openai/gpt-5", "Row 4, review"),
    ]
    roles_tbl = '<div class="tbl-wrap"><table class="tbl tbl--stack"><caption class="sr">Model roles by scope</caption><thead><tr><th>Scope and role</th><th>Model</th><th>Fallbacks, in order</th><th>Triggers and flows</th><th>Actions</th></tr></thead><tbody>'
    for scope, role, model, fallback, used in rows:
        roles_tbl += f'<tr><td data-l="Role and scope"><b>{role}</b><small>{scope}</small></td><td data-l="Model"><span class="code">{model}</span></td><td data-l="Fallbacks, in order"><span class="code">{fallback}</span></td><td data-l="Triggers and flows">{used}</td><td data-l="Actions">{btn("Edit", "ghost")}</td></tr>'
    roles_tbl += '</tbody></table></div>'
    edit = f"""<details class="md-edit" open><summary class="link">Edit default / editor</summary><div class="formrow">
      <div class="field md-grow"><label for="md-m">Model</label><input id="md-m" class="input input--code" value="anthropic/claude-sonnet-5-5"></div>
      <div class="field md-grow"><label for="md-f">Fallbacks, in order</label><input id="md-f" class="input input--code" value="openai/gpt-5"></div>{btn("Preview the change", "primary")}</div>
      {diff("triggers.json, modelRoles", [("ctx", '"modelRoles": { "default": {'), ("del", '  "editor": "anthropic/claude-sonnet-5-5"'), ("add", '  "editor": { "model": "anthropic/claude-sonnet-5-5", "fallbackModels": ["openai/gpt-5"] }'), ("ctx", '} }')])}
      {confirm("safe", "Map default / editor to claude-sonnet-5-5", ["Trigger row 2 moves on its next delivery. Nothing runs now.", "Recovery keeps the model of the lost attempt."], "Map editor back to its previous model", "Save role map")}</details>"""
    roles = card("Model roles", roles_tbl + edit + '<p class="md-foot">Repository agents may name roles, but their declarations are not readable here. The map is modelRoles in the triggers file.</p>', sub="default, then project overrides", id_="p-roles")
    cool = f"""<div class="md-cool"><span class="tile tone-attention">{ic('clock')}</span><div><p class="md-cool__t"><span class="code">anthropic/claude-sonnet-5-5</span></p><p class="md-cool__s">Rate limited. Cooling until <b>15:52 UTC</b>.</p></div></div>
      <ul class="rows md-next"><li class="rowpill"><b>default / planner</b><span>First candidate by price and cooldown: openai/gpt-5, subject to host credentials, egress, windows and endpoint room.</span></li><li class="rowpill"><b>default / editor</b><span>No fallback: its jobs start on anthropic/claude-sonnet-5-5.</span></li></ul>
      <p class="md-foot"><a class="link" href="/#p-waitlists">2 jobs wait on model cooldown or model window</a>: <a class="link code" href="/#p-waitlists">gh-77c1</a>, <a class="link code" href="/#p-waitlists">gh-80e1</a>.</p><p class="md-note"><a class="link code" href="/run?id=gh-c41f">gh-c41f</a> ran on fallback openai/gpt-5 because the primary was cooling down.</p>"""
    cooling = card("Cooling down", cool, sub="configured models only", id_="p-cooldowns")
    inuse = '<ul class="md-ms"><li class="md-m"><span class="md-m__t"><span class="code">anthropic/claude-sonnet-5-5</span><small>anthropic, priced. $32.46 of $80.00 this week</small></span>' + badge('attention', 'Cooling down') + '</li><li class="md-m"><span class="md-m__t"><span class="code">openai/gpt-5</span><small>openai, priced. Deployment windows also apply</small></span>' + badge('ok', 'Configured') + '</li></ul>'
    models = card("Models in use", inuse, sub="unpriced fallbacks are skipped", id_="p-models")
    canary = f"""<div class="md-prop"><p class="md-prop__t">Doctor on <b>mini1</b>: a newer model is available for planner.</p><p class="card__sub">Retained canary for planner, fix flow. Partial history is labelled; these are observations, not a recommendation.</p>
      <div class="tbl-wrap"><table class="tbl tbl--stack md-can"><caption class="sr">Retained canary against source runs</caption><thead><tr><th>Observed metric</th><th>Source models</th><th>Candidate</th></tr></thead><tbody><tr><td data-l="Observed metric">Cost per run</td><td data-l="Source runs">$0.19</td><td data-l="Candidate">$0.06</td></tr><tr><td data-l="Observed metric">Completed</td><td data-l="Source runs">3 of 3</td><td data-l="Candidate">2 of 3</td></tr><tr><td data-l="Observed metric">Turns, average</td><td data-l="Source runs">9.4</td><td data-l="Candidate">11.2</td></tr><tr><td data-l="Observed metric">Tokens, average</td><td data-l="Source runs">118,400</td><td data-l="Candidate">131,900</td></tr></tbody></table></div>
      <p class="md-foot">Source and candidate rows link to their run pages. <a class="link" href="/insights/breakdown?whatif=anthropic%2Fclaude-haiku-5-5&flow=fix">What if</a></p><p>{btn("Adopt for planner", "primary")}</p><p class="md-foot">Adopt fills the role form. Choose its scope explicitly, review the exact diff and confirm. Nothing runs now.</p>
      <div class="cmd"><code>pi-dispatch canary --role planner --model anthropic/claude-haiku-5-5 --flow fix --cap-usd &lt;cap-usd&gt; --count 1</code></div><p class="md-foot">Replace &lt;cap-usd&gt; with the new experiment total dollar cap. Run on the host with a first-party Anthropic or OpenAI model on local Docker. Its deployment lease holds every other start. One flow, at most 10 runs.</p></div>"""
    proposals = card("Proposals and canaries", canary, sub="doctor checks per host, retained run comparisons", id_="p-proposals")
    inner = problems + '<div class="cols models-layout"><div class="stack">' + roles + '</div><div class="stack">' + cooling + models + '</div></div>' + proposals
    return shell("Models", inner, "Models", sub="Which model each role runs, what it falls back to, and what is cooling down.", end='<span class="card__sub">Drawn at 15:39 UTC, not live</span>' + btn("Reload", "ghost", "rerun", sm=False), live="off").replace("\n  \n", "\n\n")

MODELS_CSS = """
.md-edit { min-width: 0; display: block; gap: var(--space-3); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.md-edit > * { min-width: 0; max-width: 100%; margin-top: 12px; }
.md-edit .input { width: 100%; min-width: 0; }
.md-grow { flex: 1; min-width: min(220px, 100%); }
.models-layout { grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); }
.md-foot { margin-top: 12px; color: var(--ink-muted); font-size: 13px; }
#p-roles .code, #p-cooldowns .code, #p-models .code { white-space: normal; overflow-wrap: anywhere; }
#p-roles td small { display: block; color: var(--ink-muted); }
@media (max-width: 1100px) { .models-layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .md-cool { align-items: flex-start; } .md-m { align-items: flex-start; flex-wrap: wrap; } }
@media (max-width: 760px) {
  #p-roles .tbl--stack tr, #p-proposals .tbl--stack tr { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  #p-roles .tbl--stack td, #p-proposals .tbl--stack td { width: 100%; min-width: 0; }
  #p-roles .tbl--stack td[data-l]::before, #p-proposals .tbl--stack td[data-l]::before { display: block; margin-bottom: 5px; line-height: 16px; }
}
.md-remove .btn { max-width: 100%; min-width: 0; height: auto; min-height: 30px; padding: 6px 13px; white-space: normal; overflow-wrap: anywhere; line-height: 18px; }
.md-editing td { background: var(--running-tint); }
.md-ms { display: grid; gap: 6px; }
.md-m { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.md-m__t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.md-m__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.md-m--radius { background: var(--attention-tint); }
.md-cool { display: flex; align-items: center; gap: var(--space-4); }
.md-cool__t { font-size: 16px; font-weight: 700; }
.md-cool__s { margin-top: 4px; font-size: 13px; color: var(--ink-muted); }
.md-cool__s b { color: var(--ink); }
.md-next { margin-top: var(--space-4); }
.md-next .rowpill span:not(.code) { color: var(--ink-muted); }
.md-note { display: grid; gap: 8px; margin-top: var(--space-4); padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.md-note .badge { justify-self: start; }
.md-prop { display: grid; gap: var(--space-4); }
.md-prop__h { display: flex; gap: 12px; align-items: flex-start; }
.md-prop__t { font-size: 16px; font-weight: 650; line-height: 22px; }
.md-prop__act { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.md-can td:first-child { font-weight: 600; }
"""

# ============================================================ WATCH (planned)
SAMPLES = [
    "15:36:02Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=31 req=[redacted]",
    "15:35:47Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=29 req=[redacted]",
    "15:34:10Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=27 user=[redacted]",
    "15:31:55Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=24 req=[redacted]",
    "15:22:13Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=22 req=[redacted]",
    "15:14:40Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=18 ua=\"<script>[redacted]\"",
    "15:03:08Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=14 req=[redacted]",
    "14:58:31Z checkout ERROR TimeoutError: acquire timed out after 5000ms pool=orders size=20 waiting=11 req=[redacted]",
]
def watch_page():
    sources = card("Sources", '<ul><li class="tx__b">prod-alerts: hmac-sha256, daily cap 1000; last delivery 2026-10-08 15:39 UTC; 24 suppressed, 2 capped. Credential health is unknown here; doctor checks on the receiver host.</li></ul>')
    rules = card("Watch rules", '<p>Sources and rules are written by hand in triggers.json. Findings cannot choose a job permission.</p><ul><li><a href="#">shop-5xx</a>: prod-alerts, at most 4 findings per day, flow triage-incident, investigate</li></ul>')
    findings = card("Findings for shop-5xx", '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Finding</th><th>Severity</th><th>Count</th><th>Outcome</th><th>Cooldown</th><th>Job</th></tr></thead><tbody><tr><td><a href="#">finding-1</a></td><td>error</td><td>37</td><td>queued</td><td>360m</td><td><a href="#">local-7f21</a></td></tr></tbody></table></div>')
    return shell("Configuration", '<div class="stack">' + sources + rules + findings + '</div>', "Watch", sub="Drawn at 2026-10-08 15:39 UTC, not live. Reload to read the current retained data.", live="off", end=btn("Reload"))


WATCH_CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
@media (max-width: 760px) { .tr-tabs { flex-wrap: nowrap; overflow-x: auto; } }
.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.wt-k { font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.wt-k2 { margin-left: 10px; }
.wt-f { display: grid; gap: var(--space-4); }
.wt-f__h { display: flex; align-items: flex-start; gap: 12px; }
.wt-f__t { font-size: 18px; line-height: 24px; font-weight: 700; }
.wt-f__n { margin-left: auto; font-size: 34px; line-height: 38px; font-weight: 800; letter-spacing: -0.02em; color: var(--failed-ink); }
.wt-s { display: grid; gap: 8px; }
.wt-s__h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wt-s__l { display: grid; gap: 2px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-family: var(--font-mono); font-size: 12px; line-height: 18px; color: var(--ink-muted); overflow-wrap: anywhere; }
.wt-started { display: grid; gap: 6px; }
.wt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.wt-row > span:not(.badge):not(.ptag):not(.code) { flex: 1; min-width: 200px; color: var(--ink-muted); }
.wt-row .btn { margin-left: auto; }
.wt-cd { display: grid; grid-template-columns: 90px auto; align-items: center; gap: 8px; font-size: 12px; font-weight: 650; white-space: nowrap; }
.wt-src { display: grid; gap: 6px; }
.wt-src li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wt-src li > .dot { margin-top: 6px; }
.wt-src li p:first-child { display: flex; align-items: center; gap: 8px; }
.wt-src li.tone-attention { background: var(--attention-tint); }
.wt-src__w { margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--attention-ink); }
.wt-src__w .ic { vertical-align: -2px; margin-right: 4px; }
.wt-src__r { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; }
.wt-src__r small { font-size: 11px; color: var(--ink-muted); }
.wt-trig { display: grid; gap: 10px; }
.wt-trig__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wt-trig__h .btn { margin-left: auto; }
"""

# ============================================================ READMEs
READMES = {
"SpendScreen": f"""Spend shows money and tokens against every cap, where they went, and what the same work would cost on another model.

**How a person uses it.**
- **Views.** A tab row under the title switches between Spend (this view), Budget split, Capacity, Breakdown and the Flows map. They are links, and the current one is filled.
- **Range and project.** The range (7 days, 30 days, month to date) and the project chips scope everything below.
- **Four big numbers:** this week against its cap; today against its cap, split into metered and held; tokens today; and the average cost per run.
- **Spend over time.** Daily settled bars against the $25.00 daily cap. Today's bar shows the money held for running jobs as a dashed top: it is released when they settle.
- **Where it went.** Cost by flow, by model and by project, in one hue with values written out.
- **Job sizes.** A histogram of cost per run against the $2.00 job cap, with how much the largest run used.
- **Right column:**
  - *Caps*: every window, with the 80% tick on job windows only;
  - *What if*: pick another model and see the same runs' estimated cost;
  - *Metered and plan*: claude-sonnet-5-5 per run, kimi-for-coding on plan:kimi;
  - *Budget split*: written weekly by pm-weekly, with who wrote it and when.

**Panels.** `p-week`, `p-today`, `p-tokens`, `p-avg`, `p-over`, `p-byflow`, `p-bymodel`, `p-byproject`, `p-sizes`, `p-caps`, `p-whatif`, `p-plan`, `p-split`.

**The server provides.**
- Per-day metered and held totals.
- The cap windows with spent and held amounts.
- Cost and tokens per run, with flow, model and project.
- The budget split file.
- For the what-if: the runs' token counts and the chosen model's list price. Charts are inline SVG with percent widths, so they stretch from 390 to 1440.

**Why it works this way.**
- Every run reserves the whole job cap before it starts, so a lower `maxCostUsd` holds less money while jobs run. The job sizes chart is there to show how far below the cap runs really land.
- The budget split is weights only: it never changes a cap.
- The what-if is an estimate from token counts and list prices. Outcomes may differ, because a cheaper model can take more turns or fail more often, so the screen names that uncertainty.
- Plan runs count against every cap, the dollar windows at their API-equivalent price.

**Fixture note.**
- **From the fixture:** the caps, today's $15.04 and the week's $33.07. Today's {money(TODAY_METERED)} metered and Wednesday's {money(OCT7)} are sums of the Runs list; the held {money(HELD)} is the sum of four sample running-job reservations.
- **Computed from the Runs list:** cost by flow, model and project, and the job sizes, over the {NRUNS} metered runs listed since Tue 6 Oct, 15:11 UTC.
- **Sample:**
  - the daily bars for Fri 2 to Tue 6 (Mon and Tue add up to the week total);
  - the claude-haiku-5-5 run, the budget-split percentages and the other projects' used amounts;
  - the what-if estimate of $1.90.
""",
"SpendPhone": """At 390px, Spend becomes a single column: the four big numbers, then spend over time, cost by flow, model and project, job sizes, caps, the what-if, metered and plan, and the budget split.

**How a person uses it.** The range control spans the width, and the project chips and the row of Spend views (Spend, Budget split, Capacity, Breakdown, Flows map) each scroll inside themselves. Every chart is inline SVG with percent widths, so it fits the screen instead of scrolling the page. The what-if form stacks its two selects.

**Panels.** The same as Spend.

**Fixture note.** The same as Spend.
""",
"ModelsScreen": """Models shows scoped model roles, ordered fallbacks, configured cooldowns, prices, dollar windows, doctor proposals and retained canaries. A person reviews every role edit; the page starts no run.

**How a person uses it.**
- **Banners first.** Doctor's capped Radius warning and pickup conflicts name their fix before the role map.
- **Model roles.** Default roles, then project overrides, with the primary, ordered fallbacks, skipped unpriced fallbacks, linked trigger row numbers and flows. Role names are free, with at most sixteen per scope. Phone tables stack each field across the full card width with its label on a separate line. Repository-agent declarations are not readable here.
- **Edit a role.** An operator reviews modelRoles in the triggers file, the exact diff, affected trigger rows, a confirm and an inverse undo. Nothing runs now; recovery keeps its model. Removing an override reveals a default where one exists.
- **Cooling down.** Configured models show kind and UTC end only. Roles with no fallback still start on their primary. The first candidate is ordered by price and cooldown only; credentials, egress, dollar windows and endpoint availability still decide pickup; waiters and recent fallback runs are linked.
- **Models in use.** Primary, fallback and trigger models show provider, failover price status, applicable dollar windows, spend, cap and state, including a trigger-policy refusal. Unknown amounts are not zero.
- **Proposals and canaries.** Doctor labels per host and comparisons rebuilt from retained candidate and source records show cost per run, completion, turns and tokens with coverage. Adopt fills the form with explicit scope selection. Run more is a host command for one flow and at most ten runs, warning that its deployment lease holds every other start.

**Panels.** `p-model-problems`, `p-roles`, `p-cooldowns`, `p-models`, `p-proposals`.

**The server provides.**
- The triggers-file role map and effective trigger associations, with source availability.
- Configured cooldowns, current waiters and retained fallback records, never provider text or a start time.
- Per-model failover price status and applicable dollar window counters.
- Doctor proposal labels per host and bounded retained canary/source metrics, including partial coverage and the exclusion of incomplete or unmetered costs from exact averages.

**Who sees what.** Viewers and agents read every factual panel. Only an operator on a writable console sees Edit, role forms, Adopt or a command. The page is drawn once; Reload refreshes it. JavaScript is required for preview and confirm, never for facts and navigation.

**Why it works this way.** Models change only after a person reviews the triggers-file diff. A read tool exposes the same facts and cannot mutate roles. Canary observations are not adoption or a new run, and missing history is not a zero-cost success.

**Fixture note.** Models, counts and money are sample data. This card preserves the Pulse components while using the contracts implemented by #773; it does not claim a Radius gateway or a subscription bypass.
""",
"WatchScreen": """Watch shows configured sources and rules before the first finding, retained finding outcomes, cooldown left, and suppressed or capped counts. Built by #735.

**How a person uses it.** Open Watch from Configuration's Triggers section when a watch rule is configured. The compact static screen lists source signatures, latest delivery, refusal counters and explicitly unknown credential health. Doctor checks source credentials on their owning host. Rules show source, reviewed flow, mode and daily cap. Select a rule's board for retained findings and operator-only evidence. The terminal panel's z key opens Watch findings and outcome counters.

**Panels.** The delivered console has `p-watch`, containing Sources, Watch rules and Findings.

**Who sees what.** Both roles see counts and outcomes. Samples are operator only on the board's evidence section and never enter run history or application logs. Watch configuration is hand-written; the generic trigger editor does not author it.

**Why it works this way.** Signature verification precedes parsing. Deterministic rules, cooldown and source and rule caps precede spend. Each investigation is a fresh read-only container, and a person with write access authorizes a code-change follow-up. A finding cannot choose the flow, model, folder, permissions, secrets or image.

**Future design, not delivered.** The earlier multi-panel live Watch dashboard is a future presentation option. This card describes the compact retained-data screen, not live widgets or receiver credential-health telemetry.

**Fixture note.** Counts and timestamps are illustrative and match the board's shared finding and local-7f21 job.
""",
}

if __name__ == "__main__":
    write("SpendScreen", card_marker("Screens", 1900, 1440, "Spend: caps, spend over time, where it went, job sizes and a what-if"), "Spend", spend_page(), SPEND_CSS)
    write("SpendPhone", card_marker("Screens, phone", 4680, 390, "Spend at 390px, one column"), "Spend on a phone", spend_page(), SPEND_CSS)
    write("ModelsScreen", card_marker("Screens", 1500, 1440, "Models: role map, fallbacks, cooldowns, canary proposals and the Radius flag"), "Models", models_page(), MODELS_CSS)
    write("WatchScreen", card_marker("Planned for 5.0.0", 1500, 1440, "Watch: sources, triggers, fingerprints and a finding with what it started"), "Watch", watch_page(), WATCH_CSS)
    for name, text in READMES.items():
        open(f"{ROOT}/{name}/README.md", "w").write(text)
    print("cost24", COST24, "today", TODAY_METERED, "oct7", OCT7, "held", HELD, "montue", MONTUE, "avg", round(AVG24, 3), "n24", len(M24), "nruns", NRUNS)
    print("flow", [(k, round(v, 2)) for k, v in BY_FLOW]); print("proj", [(k, round(v, 2)) for k, v in BY_PROJECT]); print("sonnet", SONNET)
