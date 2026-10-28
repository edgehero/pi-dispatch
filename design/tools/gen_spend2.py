"""Spend views on the Pulse kit: Budget split, Capacity, Breakdown and the Flows map.
They share the Spend page's title, range, project chips and tab row (gen_spend.py)."""
import math, random
import gen_spend as GS          # adds the Spend icons to ICONS on import
from pulse import *

money = GS.money
RANGE, projseg, spend_tabs = GS.RANGE, GS.projseg, GS.spend_tabs

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def page(tab, inner, sub, end=None):
    end = (RANGE + projseg()) if end is None else end
    return shell("Spend", spend_tabs(tab) + inner, "Spend", sub=sub, end=end)

def small_banners(rows):
    return '<div class="sx-states">' + "".join(banner(t, i, h, s, small=True) for t, i, h, s in rows) + "</div>"

def winline(text):
    return f'<p class="sx-win">{ic("clock", "ic ic--sm")}<span>{text}</span></p>'

# =====================================================================================
# 1. BUDGET SPLIT
# =====================================================================================
# (project, weight, allocation, floor, spent this week incl. held)  -- spent matches SpendScreen's split rows
ALLOC = [("web", 40, 45.00, 10.00, 11.78), ("billing", 35, 42.00, 10.00, 14.20), ("api", 20, 24.00, 5.00, 6.65), ("ops", 5, 6.00, 2.00, 0.44)]
TOTAL = 120.00
ALLOCATED = sum(a for _, _, a, _, _ in ALLOC)
SPENT_WEEK = round(sum(s for *_, s in ALLOC), 2)          # 33.07

def alloc_rows():
    mx = max(a for _, _, a, _, _ in ALLOC)
    out = []
    for p, w, a, f, s in ALLOC:
        over = s > a
        pa, ps, pf = a / mx * 100, min(s, a * 1.2) / mx * 100, f / mx * 100
        state = (f'<span class="tinted tone-failed">{ic("failed", "ic ic--sm")}over</span>' if over else "")
        out.append(f"""<li class="al-row">
  <span class="al-row__l">{tag(p)}<small>weight {w}</small></span>
  <svg class="al-bar" height="22" role="img" aria-label="{p}: {money(s)} spent of {money(a)} allocated, floor {money(f)}">
    <rect class="al-bar__track" x="0" y="3" width="100%" height="16" rx="8"/>
    <rect class="al-bar__alloc" x="0.5" y="3" width="{pa:.1f}%" height="16" rx="8"/>
    <rect class="al-bar__spent{' al-bar__spent--over' if over else ''}" x="0" y="3" width="{max(ps, 1.2):.1f}%" height="16" rx="8"/>
    <line class="al-bar__floor" x1="{pf:.1f}%" x2="{pf:.1f}%" y1="0" y2="22"/>
  </svg>
  <span class="al-row__v"><span><b>{money(s)}</b> spent of <b>{money(a)}</b></span><small>floor {money(f)}{state}</small></span>
</li>""")
    return '<ul class="al-rows">' + "".join(out) + "</ul>"

def split_card():
    plan = facts([("Plan", '<span class="code">3f9a2c71d04e8b55</span>'),
                  ("Written by", '<span class="code">portfolio-job</span>, the <span class="code">pm-weekly</span> run'),
                  ("Applied", "Mon 5 Oct, 06:00 UTC"), ("Valid until", "Mon 19 Oct, 06:00 UTC, 11 days left"),
                  ("Step", 'clamped by the 25% step'), ("Envelope", f'{chip("all 3 hosts agree", "ok", "done")}')], cols=2)
    legend = ('<p class="keyrow"><span><i class="al-k al-k--alloc"></i>Allocation</span><span><i class="al-k al-k--spent"></i>Spend, held included</span>'
              '<span><i class="al-k al-k--floor"></i>Floor</span><span><i class="al-k al-k--over"></i>Over the allocation</span></p>')
    head = (f'<p class="al-env">{ic("pie", "ic")}<span><b>$120.00 per week</b> · delegation on</span>'
            f'<span class="al-env__h">Unallocated <b>{money(TOTAL - ALLOCATED)}</b> · deployment spent <b>{money(SPENT_WEEK)}</b> of <b>{money(TOTAL)}</b></span></p>')
    body = head + plan + alloc_rows() + legend + \
        '<p class="sx-note">Amounts are this week\'s window.</p>'
    return card("Budget split", body, sub="this week, every host", id_="p-split",
                end=btn("Set priorities", "primary", "edit", sm=True, href="#p-priorities"))

HIST = [  # (at, writer, outcome, reason, plan, revertable)
    ("Mon 5 Oct, 06:00", "portfolio-job", "applied", "", "3f9a2c71", "current"),
    ("Sun 4 Oct, 21:10", "operator-session", "duplicate", "", "51c7d0e2", ""),
    ("Mon 28 Sep, 14:20", "operator-session", "refused", "plan-too-soon", "9b01e4aa", ""),
    ("Mon 28 Sep, 06:00", "portfolio-job", "applied", "", "51c7d0e2", "yes"),
    ("Mon 21 Sep, 06:00", "portfolio-job", "applied", "", "0e44b9f3", "yes"),
    ("Fri 18 Sep, 12:00", "envelope-change", "rebased", "", "", "yes"),
]
OUTC = {"applied": ("ok", "done", "applied"), "duplicate": ("idle", "chain", "duplicate"), "refused": ("refused", "refused", "refused"),
        "rebased": ("idle", "rerun", "rebased"), "reverted": ("idle", "rerun", "reverted")}

def history_card():
    rows = []
    for i, (at, wr, oc, rs, pl, rv) in enumerate(HIST):
        t, g, w = OUTC[oc]
        reason = (f'<span class="code">{rs}</span><span class="reason">less than 24 hours after the last plan</span>' if rs else '<span class="faint">none</span>')
        plan = f'<span class="code">{pl}</span>' if pl else '<span class="muted">neutral split</span>'
        act = (chip("in force", "ok", "done") if rv == "current" else
               (btn("Revert", "", "rerun") if rv == "yes" else '<span class="faint">carries no split</span>' if oc == "refused" else '<span class="faint">same as row 4</span>'))
        cls = ' class="al-sel"' if i == 3 else ""
        rows.append(f'<tr{cls}><td class="num"><b>{i+1}</b></td><td class="when">{at}</td><td><span class="code">{wr}</span></td>'
                    f'<td><span class="badge tone-{t}">{ic(g)}{w}</span></td><td>{reason}</td><td>{plan}</td><td class="act">{act}</td></tr>')
    tbl = ('<div class="tbl-wrap"><table class="tbl"><caption class="sr">Budget split history, newest first</caption><thead><tr>'
           '<th class="num">#</th><th>At, UTC</th><th>Writer</th><th>Outcome</th><th>Reason</th><th>Plan</th><th class="act"><span class="sr">Actions</span></th>'
           f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')
    prev = confirm("safe", "Revert the allocation to history row 4",
                   ["Writer <b>operator-revert</b>. Row 4: Mon 28 Sep, 06:00 UTC, applied, plan <span class='code'>51c7d0e2</span>.",
                    "web: weight 35 · billing: weight 30 · api: weight 25 · ops: weight 10.",
                    "Every host uses it from its next pickup. The envelope's rules still bound it, and a refusal changes nothing.",
                    "Audited as <b>allocation-revert</b>."],
                   "Revert to row 1 again", "Revert to row 4")
    return card("History", f'<div class="sx-pad">{tbl}</div>' + f'<div class="sx-pad sx-pad--b">{prev}</div>', sub="newest first, from every host",
                id_="p-split-history", flush=True)

def priorities_card():
    rows = "".join(f"""<div class="pr-row">{tag(p)}
      <div class="field"><label class="sr" for="pr-{p}">Weight for {p}</label><input id="pr-{p}" class="input pr-in" inputmode="numeric" value="{w}"></div>
      <span class="pr-share">about {round(w / 100 * 100)}%</span></div>""" for p, w, *_ in ALLOC)
    form = f"""<div class="pr-grid">{rows}</div>
  <div class="formrow pr-foot">
    <div class="field"><label for="pr-days">Valid for, days</label><input id="pr-days" class="input pr-in" inputmode="numeric" value="14"><p class="field__hint">At most 14, the envelope's limit.</p></div>
    <button class="btn btn--primary" type="button">Preview the plan</button>
  </div>
  <p class="sx-note">Writer <span class="code">operator-session</span>. Weights are whole numbers from 0 to 1000.</p>"""
    return card("Set priorities", form, sub="a plan of weights, previewed first", id_="p-priorities")

def envelope_card():
    f = facts([("Window", "week"), ("Total", "$120.00"),
               ("Floors", "web $10.00 · billing $10.00 · api $5.00 · ops $2.00 · other $0.00"),
               ("Default weights", "1 for every project"), ("Delegation", f'on, writers <span class="code">operator-session</span>, <span class="code">portfolio-job</span>'),
               ("Max step", "25% per plan"), ("Min interval", "24 hours"), ("Longest plan", "14 days"),
               ("File", '<span class="code">…/deploy/envelope.json</span>'), ("Digest", '<span class="code">3a90c1e2</span> on build3, mini1, mini2')], cols=1)
    return card("Envelope", f,
                id_="p-envelope", end=btn("Edit envelope", "", "config"))

def counts_card():
    ref = [("allocation-cap", 0), ("envelope-mismatch", 0), ("portfolio-no-envelope", 0), ("portfolio-snapshot-oversize", 0)]
    plans = [("applied", 1), ("duplicate", 0), ("refused", 0)]
    def lst(rows):
        return '<ul class="cn-l">' + "".join(f'<li><span class="code">{k}</span><b class="{"faint" if not v else ""}">{v}</b></li>' for k, v in rows) + "</ul>"
    body = (f'<p class="cn-h">{ic("refused", "ic ic--sm")}Refusals in runs on this host, this week: <b>none</b></p>{lst(ref)}'
            f'<p class="cn-h">{ic("done", "ic ic--sm")}Plans collected in runs on this host, this week</p>{lst(plans)}')
    return card("Refusals and plans", body, sub="from run records", id_="p-split-counts")

def reasons_card():
    rs = [("web", "Two releases this sprint, and most open issues are frontend."),
          ("billing", "Invoice migration backlog; keep it steady."),
          ("api", "Fewer issues opened this week."),
          ("ops", "Nightly tidy runs on plan:kimi and needs little dollar spend.")]
    li = "".join(f'<li>{tag(p)}<q>{E(t)}</q></li>' for p, t in rs)
    return card("Why the plan says so", f'<p class="sx-note sx-note--top">Written by the portfolio job.</p><ul class="rs-l">{li}</ul>',
                sub="operators only", id_="p-plan-reasons")

def split_states():
    return card("Other states", small_banners([
        ("attention", "attention", "The envelope changed outside the console", "A host reported envelope <span class='code'>7d1c04b2</span> at 14:02 UTC, not the one the split was made for (<span class='code'>3a90c1e2</span>). A host still on it refuses governed jobs as <span class='code'>envelope-mismatch</span>."),
        ("failed", "failed", "The split was made for another envelope", "Governed jobs on this host refuse as <span class='code'>envelope-mismatch</span>. This host's file says total $100.00; the totals shown are the split's."),
        ("idle", "info", "No envelope", "<span class='code'>PI_ENVELOPE_FILE</span> is unset, so there is no split and delegation is off."),
        ("idle", "hourglass", "No split applied yet", "The first host to look writes the neutral split."),
        ("attention", "attention", "Written by a newer pi-dispatch", "The applied split was written by a newer pi-dispatch: upgrade this console."),
        ("failed", "failed", "The split could not be read", "The queue did not answer, so no number is shown. Nothing was changed."),
    ]), sub="what this view says instead", id_="p-split-states")

def split_page():
    kpis = f"""<div class="cards-4">
  {card("Envelope", '<p class="kpi"><b>$120.00</b><span>per week</span></p><p class="sx-k">Delegation on: you and the portfolio job may write plans.</p>', id_="p-env-kpi")}
  {card("Allocated", f'<p class="kpi"><b>{money(ALLOCATED)}</b><span>to 4 projects</span></p><p class="sx-k">{money(TOTAL - ALLOCATED)} unallocated. Floors add up to $27.00.</p>', id_="p-alloc-kpi")}
  {card("Spent this week", f'<p class="kpi"><b>{money(SPENT_WEEK)}</b><span>of {money(TOTAL)}</span></p>{pbar(SPENT_WEEK / TOTAL, "ok", "Week: 28 percent of the envelope", 10)}<p class="sx-k">No project is over its allocation.</p>', id_="p-spent-kpi")}
  {card("Plan in force", '<p class="kpi"><b>11 days</b><span>left</span></p><p class="sx-k">Applied Mon 5 Oct by <span class="code">pm-weekly</span>, until Mon 19 Oct.</p>', end=badge("ok", "Applied"), id_="p-plan-kpi")}
</div>"""
    left = f'<div class="stack">{split_card()}{history_card()}{priorities_card()}</div>'
    right = f'<div class="stack">{envelope_card()}{reasons_card()}{counts_card()}{split_states()}</div>'
    end = projseg()
    return page("Budget split", kpis + f'<div class="cols">{left}{right}</div>',
                "How the weekly envelope is shared between projects, who wrote the plan, and how to change or revert it.", end=end)

# =====================================================================================
# 2. CAPACITY
# =====================================================================================
DAYN = ["Thu 1", "Fri 2", "Sat 3", "Sun 4", "Mon 5", "Tue 6", "Wed 7", "Thu 8"]
START_H = 16      # buckets start Thu 1 Oct 16:00 UTC; 168 one-hour buckets end Thu 8 15:00
NB = 168
# (host, venue, slots, weekday load, seed, no-data ranges [(from, to, why)])
HOSTS = [
    ("build3", "podman", 3, 1.45, 3, [(38, 50, "history not shared: the run mirror was off on this host")]),
    ("mini1", "local", 4, 2.55, 7, []),
    ("mini2", "local, openshell", 2, 0.55, 11, [(0, 41, "before this host's history starts")]),
]
def bucket_time(i):
    h = START_H + i
    d = h // 24; hh = h % 24
    return d, hh   # d: 0 = Thu 1

def gen_buckets(slots, load, seed, nodata, host):
    rnd = random.Random(seed)
    out = []
    for i in range(NB):
        d, hh = bucket_time(i)
        nd = next((why for a, b, why in nodata if a <= i < b), None)
        if nd:
            out.append(None); continue
        weekend = DAYN[d] in ("Sat 3", "Sun 4")
        v = 0.0
        if 7 <= hh <= 18 and not weekend:
            shape = math.sin((hh - 6.5) / 12.5 * math.pi)
            v = load * (0.55 + 0.75 * shape) + rnd.uniform(-0.45, 0.45)
        elif weekend and 10 <= hh <= 16 and rnd.random() < 0.35:
            v = rnd.uniform(0.2, 0.9)
        if host == "mini2" and hh == 3:
            v = max(v, 0.62)            # nightly-tidy
        if host == "build3" and DAYN[d] == "Tue 6" and 13 <= hh <= 15:
            v = slots - 0.15            # a full stretch
        v = max(0.0, min(slots, v))
        if v < 0.12:
            v = 0.0
        pk = 0 if v == 0 else min(slots, max(1, math.ceil(v + rnd.uniform(0.0, 0.55))))
        out.append((round(v, 2), pk))
    return out

def host_stats(b, slots):
    cov = [x for x in b if x is not None]
    n = len(b); c = len(cov)
    busy = sum(min(1.0, v) for v, _ in cov) / c
    full = sum(max(0.0, v - (slots - 1)) for v, _ in cov) / c
    avg = sum(v for v, _ in cov) / c
    peak = max(p for _, p in cov)
    nd = (n - c) / n
    return dict(busy=busy * (1 - nd), idle=(1 - busy) * (1 - nd), nodata=nd, full=full, avg=avg, peak=peak)

def cap_chart(b, slots, host, nodata):
    H, top, base = 132, 14, 104
    plot = base - top
    def y(v): return base - v / slots * plot
    w = 100 / NB
    s = [f'<svg class="cp-chart" height="{H}" role="img" aria-label="{host}: jobs at once per hour for 7 days, against {slots} slots">']
    for d in range(1, 8):  # midnight grid lines
        i = d * 24 - START_H
        x = i * w
        s.append(f'<line class="cp-grid" x1="{x:.3f}%" x2="{x:.3f}%" y1="{top - 6}" y2="{base}"/>')
        s.append(f'<text class="cp-d" x="{x:.3f}%" dx="4" y="{H - 8}">{DAYN[d]}</text>')
    for a, bb, why in nodata:
        s.append(f'<rect class="cp-nd" x="{a * w:.3f}%" y="{top}" width="{(bb - a) * w:.3f}%" height="{plot}" fill="url(#nodata)"><title>{E(why)}</title></rect>')
    for i, x in enumerate(b):
        if x is None or x[0] == 0:
            continue
        v, pk = x
        d, hh = bucket_time(i)
        xx = i * w + w * 0.12
        s.append(f'<rect class="cp-bar" x="{xx:.3f}%" y="{y(v):.1f}" width="{w * 0.76:.3f}%" height="{base - y(v):.1f}" rx="1.5">'
                 f'<title>{DAYN[d]} {hh:02d}:00 UTC · busy, avg {v:.1f} of {slots}, peak {pk}</title></rect>')
        s.append(f'<rect class="cp-peak" x="{xx:.3f}%" y="{y(pk) - 1:.1f}" width="{w * 0.76:.3f}%" height="2"/>')
    s.append(f'<line class="cp-slots" x1="0" x2="100%" y1="{y(slots):.1f}" y2="{y(slots):.1f}"/>')
    s.append(f'<text class="cp-ll" x="0" y="{y(slots) - 4:.1f}">{slots} slots</text>')
    s.append(f'<line class="cp-base" x1="0" x2="100%" y1="{base}" y2="{base}"/>')
    s.append(f'<line class="cp-now" x1="99.8%" x2="99.8%" y1="{top - 8}" y2="{base}"/><text class="cp-ll cp-ll--now" x="99.8%" dx="-4" y="{top - 1}" text-anchor="end">now</text>')
    s.append("</svg>")
    return "".join(s)

HOST_FACTS = {
    "build3": dict(promised="memory 38%, CPU 33%", cpu="14% of 16 cores", wait="p50 40s · p95 6m", projects=[("billing", 58), ("web", 30), ("api", 12)],
                   note="History truncated: Sat 3, 06:00 to 18:00 UTC is drawn as no data, never as idle."),
    "mini1": dict(promised="memory 48%, CPU 40%", cpu="18% of 8 cores", wait="p50 40s · p95 6m", projects=[("web", 71), ("api", 21), ("billing", 8)], note=""),
    "mini2": dict(promised="memory 20%, CPU 25%", cpu="6% of 4 cores", wait="no run recorded one", projects=[("ops", 62), ("api", 38)],
                  note="History truncated: it starts at Sat 3 Oct, 09:00 UTC."),
}
HOSTDATA = []
for hname, ven, sl, load, seed, nd in HOSTS:
    bb = gen_buckets(sl, load, seed, nd, hname)
    HOSTDATA.append((hname, ven, sl, bb, host_stats(bb, sl), nd))

def pct(x): return f"{round(x * 100)}%"

def host_card(hname, ven, sl, bb, st, nd):
    hf = HOST_FACTS[hname]
    trio = (f'<div class="cp-trio"><span><b>{pct(st["busy"])}</b>busy</span><span><b>{pct(st["idle"])}</b>idle</span>'
            f'<span class="{"" if st["nodata"] else "cp-trio__0"}"><b>{pct(st["nodata"])}</b>no data</span></div>')
    f = facts([("Jobs at once", f'average <b>{st["avg"]:.1f}</b>, peak <b>{st["peak"]}</b> of {sl}'), ("Full", f'{pct(st["full"])} of the time'),
               ("Promised", hf["promised"]), ("CPU used", hf["cpu"]), ("Wait for a slot", hf["wait"]),
               ("Projects", '<span class="cp-proj">' + "".join(f'<span>{tag(p)}{v}%</span>' for p, v in hf["projects"]) + '</span>')], cols=2)
    note = f'<p class="sx-note sx-note--ic tone-attention">{ic("attention", "ic ic--sm")}<span>{hf["note"]}</span></p>' if hf["note"] else ""
    return card(f'{hname}', trio + cap_chart(bb, sl, hname, nd) + f + note, sub=f'{venue(ven)} · {sl} slots', id_=f"p-cap-{hname}")

def cap_page():
    tot_slots = sum(h[2] for h in HOSTDATA)
    covered = [(h[4], h[2]) for h in HOSTDATA]
    fleet_busy = sum(st["busy"] * sl for st, sl in covered) / tot_slots
    hosts = "".join(host_card(*h) for h in HOSTDATA)
    fpk, fi = max((sum((h[3][i] or (0, 0))[1] for h in HOSTDATA), i) for i in range(NB))
    d, hh = bucket_time(fi)
    fpk_when = f"{['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'][d]} {DAYN[d].split()[1]} Oct, {hh:02d}:00"
    intro = '<p class="sx-lead">Last 7 days, from Thu 1 Oct 15:39 to Thu 8 Oct 15:39 UTC.</p>'
    jobs_only = banner("attention", "info", "Jobs only", "A machine busy with other work reads as idle. These numbers count pi-dispatch jobs, not the machine.", small=True)
    kpis = f"""<div class="cards-4">
  {card("Busy", f'<p class="kpi"><b>{pct(fleet_busy)}</b><span>of slot time, 3 hosts</span></p><p class="sx-k">Weighted by slots: {tot_slots} in all.</p>', id_="p-cap-busy")}
  {card("Peak", f'<p class="kpi"><b>{fpk} of {tot_slots}</b><span>slots</span></p><p class="sx-k">{fpk_when} UTC, every host added up.</p>', id_="p-cap-peak")}
  {card("Wait for a slot", '<p class="kpi"><b>6m</b><span>p95</span></p><p class="sx-k">Median 40s.</p>', id_="p-cap-wait")}
  {card("Promised memory", '<p class="kpi"><b>41%</b><span>at the busiest hour</span></p><p class="sx-k">Of every host\'s memory budget.</p>', id_="p-cap-mem")}
</div>"""
    legend = f"""<ul class="cp-key">
  <li><svg width="26" height="18" aria-hidden="true"><rect class="cp-bar" x="7" y="4" width="12" height="14" rx="2"/></svg><span><b>Bar</b> jobs at once, average for the hour</span></li>
  <li><svg width="26" height="18" aria-hidden="true"><rect class="cp-peak" x="4" y="3" width="18" height="2.5"/></svg><span><b>Tick</b> the most at once in that hour</span></li>
  <li><svg width="26" height="18" aria-hidden="true"><line class="cp-slots" x1="1" x2="25" y1="9" y2="9"/></svg><span><b>Dashed line</b> the host's slots</span></li>
  <li><svg width="26" height="18" aria-hidden="true"><rect x="3" y="1" width="20" height="16" rx="3" fill="url(#nodata)"/></svg><span><b>Hatched</b> no data: neither busy nor idle</span></li>
  <li><svg width="26" height="18" aria-hidden="true"><line class="cp-base" x1="1" x2="25" y1="16" y2="16"/></svg><span><b>Empty</b> idle: no job held a slot</span></li>
</ul>"""
    coverage = f"""<ul class="sx-lines">
  <li><b>412</b> runs counted. <b>3</b> refused before a slot, <b>1</b> retried, <b>2</b> without a size.</li>
  <li><b>4</b> running now; <b>1</b> live run is not counted yet.</li>
</ul>"""
    states = small_banners([
        ("idle", "hourglass", "No time in this window yet", "Month to date starts at Thu 1 Oct, 00:00 UTC."),
        ("failed", "failed", "Capacity not read", "The run mirror did not answer, so nothing is drawn. The other Spend views still work."),
        ("idle", "info", "Hosts not drawn", "At most 20 hosts are drawn; the rest are named under the last chart."),
    ])
    left = f'<div class="stack">{hosts}</div>'
    right = (f'<div class="stack">{card("How to read it", legend, id_="p-cap-key")}'
             f'{card("Coverage", coverage, id_="p-cap-coverage")}'
             f'{card("Other states", states, sub="what this view says instead", id_="p-cap-states")}</div>')
    pat = ('<svg class="sprite" aria-hidden="true"><defs><pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
           '<rect class="cp-nd-bg" width="6" height="6"/><rect class="cp-nd-ln" width="2" height="6"/></pattern></defs></svg>')
    return pat + page("Capacity", kpis + intro + jobs_only + f'<div class="cols">{left}{right}</div>',
                      "How busy each host was, how full, and how long jobs waited for a slot.",
                      end='<div class="seg sp-range" role="group" aria-label="Window"><button aria-pressed="false">24 hours</button><button aria-pressed="true">7 days</button><button aria-pressed="false">30 days</button></div>')

# =====================================================================================
# 3. BREAKDOWN
# =====================================================================================
WEEKDAYS = ["Fri 2", "Sat 3", "Sun 4", "Mon 5", "Tue 6", "Wed 7", "Thu 8"]
FLOWS7 = [("fix", [3.90, .31, 0, 5.20, 4.85, 4.12, 4.21]), ("frontend-fix", [.52, 0, 0, .58, .62, .52, .65]),
          ("review", [.31, 0, 0, .52, .54, .57, .32]), ("triage", [.15, 0, 0, .26, .15, .04, .05])]
OTHER7 = [0, 0, 0, .06, 0, 0, 0]
DAYTOT = [round(sum(f[1][i] for f in FLOWS7) + OTHER7[i], 2) for i in range(7)]   # 4.88 .31 0 6.62 6.16 5.25 5.23
WTOT = round(sum(DAYTOT), 2)                                                      # 28.45
EST = {3: .40}      # Mon 5: $0.40 of it estimated
FLOOR = {4}         # Tue 6: a floor

def daily_chart():
    H, top, base = 210, 26, 168
    mx = 7.0
    def y(v): return base - v / mx * (base - top)
    n = 7
    s = [f'<svg class="bk-chart" height="{H}" role="img" aria-label="Spend settled per day for 7 days: {money(WTOT)} in all, Monday partly estimated, Tuesday a floor">']
    for gv in (2, 4, 6):
        s.append(f'<line class="bk-grid" x1="0" x2="100%" y1="{y(gv):.1f}" y2="{y(gv):.1f}"/><text class="bk-ax" x="0" y="{y(gv) - 4:.1f}">${gv}</text>')
    for i, v in enumerate(DAYTOT):
        cx = (i + .5) / n * 100 + 2; w = 7.5; x = cx - w / 2
        e = EST.get(i, 0)
        lab = ("~" if e else "") + ("≥" if i in FLOOR else "") + money(v)
        if v == 0:
            s.append(f'<rect class="bk-zero" x="{x:.2f}%" y="{base - 1}" width="{w}%" height="1.5"><title>{WEEKDAYS[i]} · $0.00 · 0 runs</title></rect>')
        else:
            s.append(f'<rect class="bk-bar" x="{x:.2f}%" y="{y(v - e):.1f}" width="{w}%" height="{base - y(v - e):.1f}" rx="6"><title>{WEEKDAYS[i]} · {lab}</title></rect>')
            if e:
                s.append(f'<rect class="bk-est" x="{x:.2f}%" y="{y(v):.1f}" width="{w}%" height="{y(v - e) - y(v):.1f}" rx="6"><title>{WEEKDAYS[i]} · ~{money(e)} estimated</title></rect>')
            if i in FLOOR:
                s.append(f'<line class="bk-floor" x1="{x - .6:.2f}%" x2="{x + w + .6:.2f}%" y1="{y(v):.1f}" y2="{y(v):.1f}"/>')
        s.append(f'<text class="bk-v" x="{cx:.2f}%" y="{y(v) - 8:.1f}" text-anchor="middle">{lab}</text>')
        s.append(f'<text class="bk-d{" bk-d--now" if i == 6 else ""}" x="{cx:.2f}%" y="{H - 14}" text-anchor="middle">{WEEKDAYS[i]}</text>')
    s.append(f'<line class="bk-base" x1="0" x2="100%" y1="{base}" y2="{base}"/></svg>')
    # cumulative line
    cum = []; t = 0
    for v in DAYTOT:
        t += v; cum.append(round(t, 2))
    H2, top2, base2 = 96, 16, 78
    def y2(v): return base2 - v / 30 * (base2 - top2)
    pts = [((i + .5) / n * 100 + 2, y2(v)) for i, v in enumerate(cum)]
    c = [f'<svg class="bk-cum" height="{H2}" role="img" aria-label="Cumulative spend, {money(WTOT)} by Thursday, dashed from the first estimated day">']
    c.append(f'<line class="bk-base" x1="0" x2="100%" y1="{base2}" y2="{base2}"/>')
    for i in range(1, n):
        (x1, y1), (x2_, yy2) = pts[i - 1], pts[i]
        dashed = i >= 3
        c.append(f'<line class="bk-cl{" bk-cl--est" if dashed else ""}" x1="{x1:.2f}%" x2="{x2_:.2f}%" y1="{y1:.1f}" y2="{yy2:.1f}"/>')
    for i, (x, yy) in enumerate(pts):
        c.append(f'<circle class="bk-cd" cx="{x:.2f}%" cy="{yy:.1f}" r="3.5"><title>{WEEKDAYS[i]} · cumulative {money(cum[i])}</title></circle>')
    c.append(f'<text class="bk-v" x="{pts[-1][0]:.2f}%" dx="-8" y="{pts[-1][1] - 9:.1f}" text-anchor="end">≥~{money(WTOT)}</text>')
    c.append('<text class="bk-ax" x="0" y="12">cumulative</text></svg>')
    key = ('<p class="keyrow"><span><i class="bk-k bk-k--bar"></i>Metered</span><span><i class="bk-k bk-k--est"></i>~ estimated: partly measured</span>'
           '<span><i class="bk-k bk-k--floor"></i>≥ floor: the meter could not price all of it</span><span><i class="bk-k bk-k--zero"></i>A day with no runs</span></p>')
    return "".join(s) + "".join(c) + key

def multiples():
    mx = max(max(v) for _, v in FLOWS7)
    out = []
    for f, vals in FLOWS7:
        H, top, base = 92, 6, 76
        def y(v): return base - v / mx * (base - top)
        bars = "".join(
            (f'<rect class="bk-sm" x="{i / 7 * 100 + 1.5:.2f}%" y="{y(v):.1f}" width="{100 / 7 - 3:.2f}%" height="{base - y(v):.1f}" rx="3"><title>{WEEKDAYS[i]} · {f} · {money(v)}</title></rect>'
             if v else f'<rect class="bk-zero" x="{i / 7 * 100 + 1.5:.2f}%" y="{base - 1}" width="{100 / 7 - 3:.2f}%" height="1.5"/>') for i, v in enumerate(vals))
        out.append(f"""<figure class="bk-mf"><figcaption><b>{f}</b><span>{money(sum(vals))}</span></figcaption>
  <svg class="bk-mchart" height="{H}" role="img" aria-label="{f}: {money(sum(vals))} over 7 days">{bars}<line class="bk-base" x1="0" x2="100%" y1="{base}" y2="{base}"/>
  <text class="bk-ax" x="1.5%" y="{H - 2}">Fri</text><text class="bk-ax" x="98.5%" y="{H - 2}" text-anchor="end">Thu</text></svg></figure>""")
    return f'<div class="bk-mult">{"".join(out)}</div><p class="sx-note">+1 more flow: <b>portfolio-manager</b> $0.06.</p>'

def bk_list(rows, mx):
    """rows: (label_html, value or None, sub, extra) ; extra: ('plan', id, api) or ('api', v)"""
    out = []
    for lab, v, sub, extra in rows:
        if extra and extra[0] == "plan":
            bar = f'<svg class="bk-hb" height="14" role="img" aria-label="on plan {extra[1]}, {money(extra[2])} at API rates"><rect class="bk-hb__bed" width="100%" height="12" y="1" rx="6"/><rect class="bk-hb__api" x="0.5" y="1.5" width="{extra[2] / mx * 100:.1f}%" height="11" rx="5.5"/><line class="bk-hb__zero" x1="1" x2="1" y1="0" y2="14"/></svg>'
            val = f'<span class="code">plan:{extra[1]}</span>'
            sub = sub + f' · {money(extra[2])} @ API'
        else:
            bar = f'<svg class="bk-hb" height="14" role="img" aria-label="{money(v)}"><rect class="bk-hb__bed" width="100%" height="12" y="1" rx="6"/><rect class="bk-hb__fill" width="{max(v / mx * 100, 1.2):.1f}%" height="12" y="1" rx="6"/></svg>'
            val = f'<b>{money(v)}</b>'
        out.append(f'<li class="bk-row"><span class="bk-row__l">{lab}<small>{sub}</small></span>{bar}<span class="bk-row__v">{val}</span></li>')
    return '<ul class="bk-rows">' + "".join(out) + "</ul>"

def breakdown_card():
    mx = 21.85
    trig = bk_list([
        ('<span class="code">#3</span> comment <span class="code">"@pi"</span>', 21.85, "fix · 104 runs · 2 failed ($0.31)", None),
        ('<span class="code">#2</span> label <span class="code">pi:frontend</span>', 2.89, "frontend-fix ×2 · 12 runs", None),
        ('<span class="code">#4</span> pull request', 2.26, "review on gitlab · 13 runs", None),
        ('<span class="code">#7</span> label <span class="code">pi:triage</span>', 0.65, "triage · 4 runs", None),
        ('<span class="code">#6</span> cron <span class="code">pm-weekly</span>', 0.06, "portfolio-manager · 1 run", None),
        ('<span class="code">#1</span> cron <span class="code">nightly-tidy</span>', None, "tidy · 7 runs", ("plan", "kimi", 6.51)),
        ('<span class="bk-tail">chained</span>', None, "tidy-report · 2 runs", ("plan", "kimi", 0.88)),
        ('<span class="bk-tail">manual</span>', 0.62, "re-runs from the console · 2 runs", None),
        ('<span class="bk-tail">unattributed</span>', 0.12, "a record without a trigger · 1 run", None),
    ], mx)
    repo = bk_list([
        (f'<span class="code">acme/billing</span>{tag("billing")}', 11.40, "github · 41 runs", None),
        (f'<span class="code">acme/web</span>{tag("web")}', 10.10, "github · 52 runs", None),
        (f'<span class="code">acme/api</span>{tag("api")}', 4.91, "github · 19 runs", None),
        (f'<span class="code">acme/billing-ui</span>{tag("billing")}', 1.76, "gitlab · 13 runs", None),
        (f'<span class="code">acme/docs</span><span class="bk-tail">no project</span>', 0.22, "github · 1 run", None),
        (f'<span class="code">pm</span>{tag("ops")}', 0.06, "local folder · 1 run", None),
        (f'<span class="code">site</span>{tag("ops")}', None, "local folder · 9 runs", ("plan", "kimi", 7.39)),
    ], mx)
    model = bk_list([
        ('<span class="code">anthropic/claude-sonnet-5-5</span>', 28.39, "136 runs, metered", None),
        ('<span class="code">anthropic/claude-haiku-5-5</span>', 0.06, "1 run, metered", None),
        ('<span class="code">kimi-coding/kimi-for-coding</span>', None, "9 runs", ("plan", "kimi", 7.39)),
    ], mx)
    paths = ('<div class="seg" role="group" aria-label="Local paths"><button aria-pressed="true">Last folder</button><button aria-pressed="false">Full paths</button></div>')
    body = (f'<div class="bk-cols"><div><h3 class="bk-h">By trigger</h3>{trig}</div>'
            f'<div><h3 class="bk-h">By repository</h3>{repo}<h3 class="bk-h bk-h--2">By model</h3>{model}</div></div>')
    return card("Breakdown", body, sub=f"{money(WTOT)} settled, last 7 days",
                end=paths, id_="p-breakdown")

def plans_card():
    kimi_amort = round(19.00 * 7 / 31, 2); kimi_api = 7.39
    max_amort = round(200.00 * 7 / 31, 2); max_api = 28.39
    def plan(title, sub, verdict, rows):
        return f'<div class="pl"><div class="pl__h"><div><p class="pl__t">{title}</p><p class="card__sub">{sub}</p></div>{verdict}</div>{facts(rows, cols=1)}</div>'
    a = plan('<span class="code">kimi</span> · kimi-coding', "$19.00 a month · kimi-for-coding",
             f'<span class="badge tone-ok">{ic("done")}Saving {money(kimi_api - kimi_amort)}</span>',
             [("Attributed", "9 runs · 1.67M tokens"), ("Per run", f"{money(kimi_amort / 9)} amortized · {money(kimi_api / 9)} at API rates"),
              ("Peak, 5h rolling", "1 run · 186,469 tokens · limit undisclosed by vendor")])
    b = plan('<span class="code">claude-max</span> · anthropic', "$200.00 a month · hypothetical: you are considering it",
             f'<span class="badge tone-attention">{ic("attention")}Would lose {money(max_amort - max_api)}</span>',
             [("Attributed", "136 runs · 21.4M tokens"), ("Per run", f"{money(max_amort / 136)} amortized · {money(max_api / 136)} at API rates"),
              ("Peak, 5h rolling", "31 runs · 4.92M tokens · limit 200 to 800 prompts")])
    c = plan('<span class="code">zai</span> · zai-coding', "$15.00 a month",
             f'<span class="badge tone-idle">{ic("info")}No baseline</span>',
             [("Verdict", "No API-rate baseline declared: set <span class='code'>counterfactualModel</span> to compare."), ("Attributed", "0 runs")])
    return card("Plans", a + b + c + '<p class="sx-note">From <span class="code">subscriptions.json</span>.</p>',
                sub="subscriptions against API rates, this window", id_="p-plans")

def whatif_card():
    form = """<div class="wf-form">
  <div class="field"><label for="wf-m">Model, provider/model</label><input id="wf-m" class="input input--code" value="anthropic/claude-haiku-5-5" list="wf-models"></div>
  <div class="field"><label for="wf-f">Flow</label><select id="wf-f" class="select"><option>fix</option><option>frontend-fix</option><option>review</option><option>triage</option></select></div>
  <button class="btn btn--primary" type="button">Estimate</button>
</div>"""
    ans = f"""<div class="wf-ans" aria-live="polite">
  <p class="wf-ans__h">fix on <span class="code">anthropic/claude-haiku-5-5</span></p>
  <p class="wf-ans__n"><b>~$0.07</b> a run · <b>~$7.42</b> for the window's 104 runs</p>
  <ul class="sx-lines"><li>Coverage: 96% of observed runs ledgered. 4 excluded: no ledger.</li><li>Rates: pi-ai 1.0.3.</li></ul>
</div>"""
    other = f"""<div class="wf-other">
  <p class="wf-other__h">Other answers</p>
  <div class="wf-o">{badge("refused", "Unknown model")}<div><p><span class="code">anthropic/claude-haku-5</span>: the pricing tables cannot price it.</p><p class="wf-o__s">Closest priced ids: <a class="link" href="#">anthropic/claude-haiku-5-5</a>, <a class="link" href="#">anthropic/claude-haiku-4-5</a>, <a class="link" href="#">anthropic/claude-sonnet-5-5</a></p></div></div>
  <div class="wf-o">{badge("delayed", "Unmeasured")}<div><p><b>deploy</b> has no ledgered runs: <b>~~$0.50 to $5.00</b> a run, seeded.</p></div></div>
</div>"""
    return card("What if, per flow", form + ans + other, sub="one flow on another model, from its own runs", id_="p-whatif-flow")

def bk_states():
    return card("Other states", small_banners([
        ("failed", "failed", "Costs could not be read", "The run records did not answer, so nothing on this view is drawn."),
        ("idle", "info", "No runs in the spend window", "Nothing ran in the last 7 days. Try 30 days."),
        ("attention", "attention", "Plans not scored", "<span class='code'>subscriptions.json</span> is missing or invalid, so plan runs are not compared with API rates."),
    ]), sub="what this view says instead", id_="p-bk-states")

def bk_page():
    kpis = f"""<div class="cards-4">
  {card("Window spend", f'<p class="kpi"><b>≥{money(WTOT)}</b><span>settled</span></p><p class="sx-k">One run on Tue 6 could not be fully priced.</p>', id_="p-bk-spend")}
  {card("Runs", '<p class="kpi"><b>146</b><span>in 7 days</span></p><p class="sx-k"><b>142</b> of 146 fully ledgered.</p>', id_="p-bk-runs")}
  {card("Plans declared", '<p class="kpi"><b>3</b><span>1 hypothetical</span></p><p class="sx-k">kimi is saving money; claude-max would not.</p>', id_="p-bk-plans")}
  {card("Top flow", f'<p class="kpi"><b>fix</b><span>$22.59</span></p><p class="sx-k">79% of the window. Then frontend-fix $2.89.</p>', id_="p-bk-top")}
</div>"""
    left = (f'<div class="stack">{card("Daily spend", daily_chart(), sub="settled per day, from run records", id_="p-daily")}'
            f'{card("Daily spend by flow", multiples(), sub="top 4 flows", id_="p-daily-flow")}{breakdown_card()}</div>')
    right = f'<div class="stack">{plans_card()}{whatif_card()}{bk_states()}</div>'
    return page("Breakdown", winline("Spend window: Thu 1 Oct 15:39 to Thu 8 Oct 15:39 UTC. Unmetered 1 · not re-priceable 3 · rates drifted 0 · ledgers truncated 0.") + kpis + f'<div class="cols">{left}{right}</div>',
                "Settled spend by day, flow, trigger, repository and model.")

# =====================================================================================
# 4. FLOWS MAP
# =====================================================================================
TRIG_ICON = {"cron": "clock", "label": "tag", "comment": "comment", "pr": "git", "issue": "issue"}

def chip_node(x, y, w, kind, text, sub, cls="", badges="", label=""):
    i = TRIG_ICON[kind]
    return f"""<a href="#" class="fm-n fm-trig {cls}" aria-label="{E(label or text)}">
  <rect class="fm-trig__b" x="{x}" y="{y}" width="{w}" height="34" rx="17"/>
  <use href="#i-{i}" x="{x + 11}" y="{y + 8}" width="18" height="18" class="fm-ic"/>
  <text class="fm-t" x="{x + 36}" y="{y + 22}">{text}</text>
  <text class="fm-s" x="{x + 14}" y="{y + 52}">{sub}</text>{badges}
</a>"""

def flow_node(x, y, w, text, state="ok", sub="", cls="", badges=""):
    st = {"ok": "", "unverified": " fm-flow--unv", "missing": " fm-flow--miss", "head": " fm-flow--head", "orphan": " fm-flow--orphan", "spent": " fm-flow--unv fm-flow--orphan"}[state]
    return f"""<a href="#" class="fm-n fm-flow{st} {cls}" aria-label="flow {E(text)}">
  <rect class="fm-flow__b" x="{x}" y="{y}" width="{w}" height="34" rx="10"/>
  <use href="#i-skill" x="{x + 10}" y="{y + 8}" width="18" height="18" class="fm-ic"/>
  <text class="fm-t" x="{x + 34}" y="{y + 22}">{text}</text>
  {f'<text class="fm-s" x="{x + 12}" y="{y + 52}">{sub}</text>' if sub else ''}{badges}
</a>"""

def edge(d, kind="config", cls="", label=None):
    lab = ""
    if label:
        lx, ly, t = label
        lab = f'<text class="fm-el" x="{lx}" y="{ly}" text-anchor="middle">{t}</text>'
    return f'<g class="fm-e fm-e--{kind} {cls}"><path d="{d}" marker-end="url(#arrow)"/>{lab}</g>'

def group(x, y, w, h, title, sub, cls=""):
    return (f'<g class="fm-g {cls}"><rect class="fm-g__b" x="{x}" y="{y}" width="{w}" height="{h}" rx="18"/>'
            f'<text class="fm-g__t" x="{x + 18}" y="{y + 28}">{title}</text><text class="fm-g__s" x="{x + 18}" y="{y + 46}">{sub}</text></g>')

def dot_badge(cx, cy, kind):
    if kind == "risk":
        return f'<circle class="fm-bd fm-bd--risk" cx="{cx}" cy="{cy}" r="5.5"><title>PR spend-loop risk: fires on opened and synchronize; a flow that pushes can loop with another bot</title></circle>'
    return f'<circle class="fm-bd fm-bd--chain" cx="{cx}" cy="{cy}" r="6"><title>chainable: ai-trigger allow</title></circle>'

def flows_svg():
    D = "is-dim"
    TX, FX, TW, FW = 532, 798, 196, 168  # forge groups (right): trigger x, flow x
    LX, LFX = 34, 300                    # local groups (left), so the selected chip is seen first on a phone
    s = ['<svg class="fm-svg" viewBox="0 0 1000 560" role="group" aria-label="Flows map: 7 triggers in 4 groups, the flows they run, and the chains between them. nightly-tidy is selected.">',
         '<defs><marker id="arrow-thick" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker></defs>']
    s.append(group(514, 16, 470, 362, "github · forge", "unverifiable from this host · ran against acme/web, acme/api, acme/billing", D))
    s.append(group(514, 394, 470, 150, "gitlab · forge", "unverifiable from this host · ran against acme/billing-ui", D))
    s.append(group(16, 16, 470, 362, "site · HEAD 4c1e9a0", "local folder · 4 skills", ""))
    s.append(group(16, 394, 470, 150, "pm · HEAD 9d02b7c", "local folder · 1 skill", D))
    # github triggers and flows
    rows = [(78, "label", "pi:frontend", "12 runs · $2.89", "frontend-fix", "×2 replicas", "unverified", ""),
            (154, "comment", '"@pi"', "104 runs · $21.85", "fix", "", "unverified", ""),
            (230, "label", "pi:triage", "4 runs · $0.65", "triage", "", "unverified", ""),
            (306, "issue", "closed #40 · once", "spent by gh-40a1", "deploy", "", "spent", "fm-trig--spent")]
    for y, k, t, sub, f, fs, st, ccls in rows:
        s.append(edge(f"M{TX + TW} {y + 17} L{FX - 4} {y + 17}", "config", D))
        s.append(chip_node(TX, y, TW, k, t, sub, f"{D} {ccls}", label=f"{k} trigger {t}"))
        s.append(flow_node(FX, y, FW, f + (" ×2" if fs else ""), st, "", D))
    # gitlab
    s.append(edge(f"M{TX + TW} 473 L{FX - 4} 473", "config", D))
    s.append(chip_node(TX, 456, TW, "pr", "open, update", "13 runs · $2.26", D, dot_badge(TX + TW - 8, 460, "risk"), label="pull request trigger open, update"))
    s.append(flow_node(FX, 456, FW, "review", "unverified", "", D))
    # site (selected: nightly-tidy)
    s.append(f'<g class="fm-e fm-e--rearm is-sel"><path d="M{LX + 44} 128 C {LX + 22} 76, {LX + 146} 76, {LX + 124} 126" marker-end="url(#arrow)"/>'
             f'<text class="fm-el" x="{LX + 150}" y="104">re-arms 0 3 * * *</text></g>')
    s.append(edge(f"M{LX + TW} 145 L{LFX - 4} 145", "config", "is-sel"))
    s.append(chip_node(LX, 128, TW, "cron", "nightly-tidy", "30 runs · plan:kimi", "is-sel", label="cron trigger nightly-tidy, selected"))
    s.append(flow_node(LFX, 128, FW - 4, "tidy", "ok", "", "is-near", dot_badge(LFX + FW - 8, 132, "chain")))
    s.append(edge(f"M{LFX + 80} 164 L{LFX + 80} 222", "observed", D, (LFX + 80 - 50, 198, "6× · 12h ago")).replace("url(#arrow)", "url(#arrow-thick)"))
    s.append(flow_node(LFX, 226, FW - 4, "tidy-report", "ok", "", D))
    s.append(edge(f"M{LFX + 80} 262 L{LFX + 80} 312", "potential", D, (LFX + 80 - 40, 291, "mention")))
    s.append(flow_node(LFX, 316, FW - 4, "deps-bump", "ok", "", D))
    s.append(flow_node(LX, 316, 170, "old-migrate", "orphan", "orphan: nothing reaches it", D))
    # pm
    s.append(edge(f"M{LX + TW} 473 L{LFX - 4} 473", "config", D))
    s.append(chip_node(LX, 456, TW, "cron", "pm-weekly", "4 runs · $0.06", D, label="cron trigger pm-weekly"))
    s.append(flow_node(LFX - 4, 456, FW + 14, "portfolio-manager", "ok", "writes the budget split", D))
    s.append("</svg>")
    return "".join(s)

def flows_map_card():
    zoom = (f'<div class="fm-zoom"><button class="roundbtn" type="button" aria-label="Zoom out">{ic("minus")}</button>'
            f'<button class="roundbtn" type="button" aria-label="Zoom in">{ic("plus")}</button>'
            f'<button class="roundbtn" type="button" aria-label="Fit the map">{ic("fit")}</button></div>')
    view = '<div class="seg" role="group" aria-label="View"><button aria-pressed="true">Map</button><button aria-pressed="false">List</button></div>'
    body = f'<div class="fm-wrap" tabindex="0" aria-label="Flows map, scrolls sideways on a small screen">{flows_svg()}</div>'
    return card("Flows map", body, sub="what starts what, from the triggers file and run records", end=view + zoom, id_="p-flows")

def sel_card():
    f = facts([("Trigger", 'cron <span class="code">nightly-tidy</span>, <span class="code">0 3 * * *</span> UTC'),
               ("Flow", "<b>tidy</b>, found at HEAD"), ("Folder", '<span class="code">site</span> · HEAD 4c1e9a0'),
               ("Runs", f"30 in 30 days · last {badge('completed')} 12h ago"), ("Next", "Fri 9 Oct, 03:00 UTC, in 11h 21m"),
               ("Spend", '<span class="code">plan:kimi</span> this window'), ("Chainable", "yes: ai-trigger allow"),
               ("Chains to", "<b>tidy-report</b>, 6 times in 30 days"), ("Loops in the skill", "none")], cols=1)
    acts = f'<p class="fm-acts">{btn("Open trigger", "", "config")}{btn("Runs from it", "", "runs")}</p>'
    return card("nightly-tidy", f + acts, sub="selected", id_="p-flows-selected", cls="fm-selcard",
                end=f'<span class="tile tile--sm tone-running">{ic("clock")}</span>')

def legend_flows():
    def sw(svg): return f'<svg class="fm-sw" viewBox="0 0 60 24" width="60" height="24" aria-hidden="true">{svg}</svg>'
    wires = [
        (sw('<g class="fm-e fm-e--config"><path d="M2 12 L52 12" marker-end="url(#arrow)"/></g>'), "config", "the trigger names this flow"),
        (sw('<g class="fm-e fm-e--observed"><path d="M2 12 L52 12" marker-end="url(#arrow-thick)"/></g>'), "observed ×n", "chained in run records"),
        (sw('<g class="fm-e fm-e--potential"><path d="M2 12 L52 12" marker-end="url(#arrow)"/></g>'), "potential", "a text mention, not a promise"),
        (sw('<g class="fm-e fm-e--rearm"><path d="M10 20 C 2 0, 50 0, 42 20" marker-end="url(#arrow)"/></g>'), "cron re-arm", "the schedule itself"),
    ]
    nodes = [
        (sw('<g class="fm-flow"><rect class="fm-flow__b" x="2" y="3" width="56" height="18" rx="6"/></g>'), "skill", "found at HEAD"),
        (sw('<g class="fm-flow fm-flow--unv"><rect class="fm-flow__b" x="2" y="3" width="56" height="18" rx="6"/></g>'), "unverified", "repo not readable from this host"),
        (sw('<g class="fm-flow fm-flow--head"><rect class="fm-flow__b" x="2" y="3" width="56" height="18" rx="6"/></g>'), "not at HEAD", "not committed, or a tier not checkable"),
        (sw('<g class="fm-flow fm-flow--miss"><rect class="fm-flow__b" x="2" y="3" width="56" height="18" rx="6"/></g>'), "missing", "absent in every checkable tier"),
        (sw('<g class="fm-flow fm-flow--orphan"><rect class="fm-flow__b" x="2" y="3" width="56" height="18" rx="6"/></g>'), "orphan or spent", "nothing reaches it, or a one-shot that fired"),
    ]
    badges = [
        (sw('<circle class="fm-bd fm-bd--risk" cx="30" cy="12" r="6"/>'), "dot", "unread, injected ai-trigger, or PR spend-loop risk"),
        (sw('<circle class="fm-bd fm-bd--chain" cx="30" cy="12" r="6.5"/>'), "ring", "chainable: ai-trigger allow"),
    ]
    def grp(h, rows):
        return f'<div class="fm-lg"><p class="fm-lg__h">{h}</p><ul>' + "".join(f'<li>{a}<span><b>{b}</b> {c}</span></li>' for a, b, c in rows) + "</ul></div>"
    return card("Key", f'<div class="fm-lgs">{grp("Wires", wires)}{grp("Flows", nodes)}{grp("Badges", badges)}</div>', id_="p-flows-key")

def honesty_card():
    lines = """<ul class="sx-lines">
  <li><b>1</b> run unattributed: its record names no trigger.</li>
  <li><b>2</b> chain requests refused, by the caps or the gate.</li>
  <li><b>1</b> wire label in its tooltip only: there was no clear spot on the map.</li>
</ul>"""
    states = small_banners([("failed", "failed", "No triggers file found", "The map has nothing to draw. Configuration says where the file should be."),
                            ("failed", "failed", "Triggers file invalid", "The loader's words are shown here, and nothing is drawn until it loads.")])
    return card("Not on the map", lines + '<p class="fm-lg__h fm-lg__h--gap">Instead of the map, when the triggers file will not load</p>' + states, id_="p-flows-honesty")

def flows_page():
    top = f'<div class="cols">{flows_map_card()}{sel_card()}</div>'
    low = f'<div class="cols">{legend_flows()}{honesty_card()}</div>'
    return page("Flows map", winline("Map window: the last 30 days of run records. Spend window: last 7 days.") + top + low,
                "Which trigger starts which flow, what chains to what, and what nothing reaches.")

# =====================================================================================
# CSS
# =====================================================================================
CSS = GS.SPEND_CSS + """
.sx-win { display: flex; align-items: center; gap: 6px; margin: -6px 4px 0; font-size: 12px; color: var(--ink-muted); }
.sx-k { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-k b { color: var(--ink); }
.sx-lead { margin: 0 4px; font-size: 13px; line-height: 19px; color: var(--ink-muted); max-width: 980px; }
.sx-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-note b { color: var(--ink); }
.sx-note--top { margin: 0 0 var(--space-3); }
.sx-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sx-note--ic .ic { margin-top: 1px; flex: none; }
.sx-note.tone-attention { color: var(--attention-ink); font-weight: 600; }
.sx-pad { padding: 0 var(--space-5); }
.sx-pad--b { padding-bottom: var(--space-5); }
.sx-lines { display: grid; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.sx-lines li { padding-left: 14px; position: relative; }
.sx-lines li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint); }
.sx-lines b { color: var(--ink); }
.sx-states { display: grid; gap: 8px; }

/* budget split */
.al-env { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: var(--space-4); font-size: 15px; }
.al-env__h { margin-left: auto; font-size: 13px; color: var(--ink-muted); }
.al-env__h b { color: var(--ink); }
.al-rows { display: grid; gap: 4px; margin-top: var(--space-4); }
.al-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.al-row:last-child { border-bottom: 0; }
.al-row__l { display: flex; align-items: center; gap: 8px; }
.al-row__l small, .al-row__v small { font-size: 11px; color: var(--ink-muted); }
.al-row__v { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; color: var(--ink-muted); white-space: nowrap; }
.al-row__v b { color: var(--ink); }
.al-bar { display: block; width: 100%; overflow: visible; }
.al-bar__track { fill: var(--surface-2); }
.al-bar__alloc { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.al-bar__spent { fill: var(--ok); }
.al-bar__spent--over { fill: var(--failed); }
.al-bar__floor { stroke: var(--attention); stroke-width: 3; stroke-linecap: round; }
.al-k { display: inline-block; width: 18px; height: 10px; border-radius: 5px; }
.al-k--alloc { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.al-k--spent { background: var(--ok); }
.al-k--floor { width: 3px; height: 14px; border-radius: 2px; background: var(--attention); }
.al-k--over { background: var(--failed); }
.al-sel td { background: var(--surface-2); }
.pr-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.pr-row { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pr-row .ptag { justify-self: start; }
.pr-in { width: 100%; max-width: 120px; }
.pr-share { font-size: 12px; color: var(--ink-muted); }
.pr-foot { margin-top: var(--space-4); align-items: flex-end; }
.cn-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
.cn-h + .cn-l + .cn-h { margin-top: var(--space-4); }
.cn-l { display: grid; gap: 4px; }
.cn-l li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.rs-l { display: grid; gap: 8px; }
.rs-l li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.rs-l .ptag { justify-self: start; }
.rs-l q { font-size: 13px; line-height: 19px; color: var(--ink); quotes: "\\201C" "\\201D"; }

/* capacity */
.cp-trio { display: flex; gap: var(--space-5); margin: -6px 0 var(--space-3); }
.cp-trio span { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.cp-trio b { font-size: 28px; line-height: 32px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.cp-trio__0 b { color: var(--ink-faint); }
.cp-chart { display: block; width: 100%; overflow: visible; margin-bottom: var(--space-4); }
.cp-bar { fill: var(--running); }
.cp-peak { fill: var(--ink); }
.cp-slots { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.cp-base { stroke: var(--line-strong); }
.cp-grid { stroke: var(--line); }
.cp-now { stroke: var(--ink); stroke-width: 1.5; }
.cp-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.cp-ll--now { fill: var(--ink); }
.cp-nd-bg { fill: var(--surface-2); }
.cp-nd-ln { fill: var(--line-strong); opacity: .55; }
.cp-key { display: grid; gap: 10px; }
.cp-proj { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.cp-proj > span { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.cp-key li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-muted); }
.cp-key li b { color: var(--ink); margin-right: 4px; }
.cp-key svg { flex: none; overflow: visible; }

/* breakdown */
.bk-chart, .bk-cum, .bk-mchart { display: block; width: 100%; overflow: visible; }
.bk-bar { fill: var(--ok); }
.bk-est { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-floor { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.bk-zero { fill: var(--ink-faint); }
.bk-grid { stroke: var(--line); }
.bk-base { stroke: var(--line-strong); }
.bk-ax { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.bk-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.bk-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.bk-d--now { fill: var(--ink); font-weight: 750; }
.bk-cl { stroke: var(--ink-muted); stroke-width: 2; }
.bk-cl--est { stroke-dasharray: 5 4; }
.bk-cd { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 2; }
.bk-cum { margin-top: var(--space-2); }
.bk-k { display: inline-block; width: 16px; height: 10px; border-radius: 4px; }
.bk-k--bar { background: var(--ok); }
.bk-k--est { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.bk-k--floor { height: 3px; background: var(--ink); }
.bk-k--zero { height: 2px; background: var(--ink-faint); }
.bk-mult { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.bk-mf { padding: 12px 12px 6px; border-radius: var(--radius-md); background: var(--surface-2); }
.bk-mf figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.bk-mf figcaption span { font-weight: 700; }
.bk-sm { fill: var(--ink-muted); }
.bk-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.bk-h { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.bk-h--2 { margin-top: var(--space-5); }
.bk-rows { display: grid; gap: 12px; }
.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; font-size: 13px; }
.bk-row__l { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.bk-row__l small { font-size: 11px; color: var(--ink-muted); }
.bk-row__v { text-align: right; white-space: nowrap; }
.bk-hb { display: block; width: 100%; }
.bk-hb__bed { fill: var(--dot-off); }
.bk-hb__fill { fill: var(--ink-muted); }
.bk-hb__api { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-hb__zero { stroke: var(--ink); stroke-width: 2; }
.bk-tail { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); }
.pl { padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.pl + .pl { margin-top: 8px; }
.pl__h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pl__h > div { flex: 1; min-width: 0; }
.pl__t { font-size: 15px; font-weight: 700; }
.pl .facts { gap: 8px; }
.lg-l { display: grid; gap: 8px; }
.lg-l li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.lg-l li b { color: var(--ink); }
.lg-m { font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: end; }
.wf-form .field:first-child { grid-column: 1 / -1; }
.wf-ans { margin-top: var(--space-4); padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wf-ans__h { font-size: 13px; color: var(--ink-muted); }
.wf-ans__n { margin: 4px 0 10px; font-size: 18px; line-height: 26px; }
.wf-other { display: grid; gap: 8px; margin-top: var(--space-4); }
.wf-other__h { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wf-o { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; }
.wf-o__s { margin-top: 2px; font-size: 12px; color: var(--ink-muted); }

/* flows map */
.fm-wrap { overflow-x: auto; border-radius: var(--radius-md); background: var(--canvas); }
.fm-svg { display: block; width: 100%; height: auto; }
.fm-zoom { display: flex; gap: 6px; }
.fm-zoom .roundbtn { width: 38px; height: 38px; background: var(--surface-2); }
.fm-g__b { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.fm-g__t { font-size: 14px; font-weight: 750; fill: var(--ink); }
.fm-g__s { font-size: 11px; font-weight: 500; fill: var(--ink-muted); }
.fm-trig__b { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.fm-flow__b { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; }
.fm-flow--unv .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--line-strong); }
.fm-flow--head .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--attention); }
.fm-flow--miss .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--failed); }
.fm-flow--orphan { opacity: .55; }
.fm-flow--orphan .fm-flow__b { stroke-dasharray: 2 4; }
.fm-trig--spent .fm-trig__b { stroke-dasharray: 2 4; fill: var(--surface); }
.fm-ic { color: var(--ink-muted); }
.fm-t { font-size: 14px; font-weight: 700; fill: var(--ink); }
.fm-s { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.fm-e path { fill: none; stroke: var(--ink-faint); stroke-width: 1.6; }
.fm-e--observed path { stroke: var(--ink-muted); stroke-width: 3.5; }
.fm-e--potential path { stroke-dasharray: 6 5; }
.fm-e--rearm path { stroke-dasharray: 3 4; }
.fm-el { font-size: 11px; font-weight: 650; fill: var(--ink-muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.fm-e .arrowhead, .fm-sw .arrowhead { fill: var(--ink-faint); }
.fm-bd--risk { fill: var(--refused); stroke: var(--surface); stroke-width: 2; }
.fm-bd--chain { fill: var(--surface); stroke: var(--ok); stroke-width: 3; }
.fm-n:focus-visible { outline: none; }
.fm-n:focus-visible rect:first-child { stroke: var(--focus); stroke-width: 3; }
.is-dim { opacity: .45; }
.is-sel .fm-trig__b { fill: var(--primary); stroke: var(--primary); }
.is-sel .fm-t { fill: var(--on-primary); }
.is-sel .fm-ic { color: var(--on-primary); }
.is-sel.fm-e path { stroke: var(--ink); stroke-width: 2.2; }
.is-near .fm-flow__b { stroke: var(--ink); stroke-width: 2.5; }
.fm-lgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-5); }
.fm-lg__h { font-size: 12px; font-weight: 700; color: var(--ink-muted); margin-bottom: 8px; }
.fm-lg__h--gap { margin-top: var(--space-4); }
.fm-lg ul { display: grid; gap: 8px; }
.fm-lg li { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fm-lg li b { color: var(--ink); margin-right: 3px; }
.fm-sw { flex: none; overflow: visible; }
.fm-caps { margin: var(--space-4) 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; font-weight: 600; }
.fm-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-4); }
.fm-selcard { box-shadow: inset 0 0 0 2px var(--primary); }

@media (max-width: 760px) {
  .al-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .al-row .al-bar { grid-column: 1 / -1; grid-row: 2; }
  .al-env__h { margin-left: 0; }
  .pr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sx-pad { padding: 0 var(--space-4); } .sx-pad--b { padding-bottom: var(--space-4); }
  .cp-trio { gap: var(--space-4); }
  .cp-trio b { font-size: 22px; line-height: 26px; }
  .cp-d { font-size: 9px; }
  .bk-mult { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bk-cols { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
  .bk-chart .bk-v { font-size: 10px; }
  .bk-chart .bk-d { font-size: 10px; }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
  .fm-svg { min-width: 820px; }
  .fm-lgs { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .lg-l li { grid-template-columns: 84px minmax(0, 1fr); }
}
"""

# =====================================================================================
# READMEs
# =====================================================================================
TABS_NOTE = "The tab row under the title (Spend, Budget split, Capacity, Breakdown, Flows map) is shared by all five Spend views; the current one is filled. They are server-rendered links (`/insights`, `/insights/budget-split`, `/insights/capacity`, `/insights/breakdown`, `/insights/flows`, proposed routes) and on a phone the row scrolls inside itself."

READMES = {
"SpendBudgetSplit": f"""Budget split shows how the allocation envelope is shared between projects this week, which plan is in force and who wrote it, and lets an operator set priorities or go back to an earlier split.

**How a person uses it.**
- **Four big numbers:** the envelope ($120.00 per week, delegation on), what is allocated (with what is left unallocated), what was spent this week, and how long the plan in force has left.
- **Budget split.** One row per project: the allocation as an outlined bar, the spend (held included) as a solid bar, and the floor as a tick, with the amounts written out and "over" with a glyph when spend passes the allocation. Above the rows: the plan id, its writer, when it was applied, until when, whether the 25% step clamped it, and whether every host has the same envelope.
- **History.** Every plan any host recorded, newest first, numbered from 1 like every other list in the console. Each row has its writer (`operator-session`, `portfolio-job`, `operator-revert`, `envelope-change`), outcome with a glyph and word, refusal reason, and plan. **Revert** opens a safe confirm bar with what the old split was and that the envelope's rules still bound it.
- **Set priorities.** A weight per project (0 to 1000) and how many days the plan holds, previewed before anything is written.
- **Right column:** the *Envelope* (window, total, floors, default weights, delegation, step, interval, plan length, file by its last folder, digest per host), *Why the plan says so* (the portfolio job's reasons, agent text shown as written and escaped), *Refusals and plans* counted in this host's run records, and *Other states*.
- **Other states.** What the view says instead when the envelope changed outside the console, a host has another envelope, there is no envelope, no split exists yet, a newer pi-dispatch wrote it, or the queue did not answer.
- {TABS_NOTE}

**Viewers** see the numbers, the bars and the history, but not the plan reasons, Revert, Set priorities or Edit envelope.

**Panels.** `p-env-kpi`, `p-alloc-kpi`, `p-spent-kpi`, `p-plan-kpi`, `p-split`, `p-split-history`, `p-priorities`, `p-envelope`, `p-plan-reasons`, `p-split-counts`, `p-split-states`.

**The server provides.**
- The envelope file and its digest per host.
- The applied split (`alloc:plan`) and its history (`alloc:log`, every host).
- Spend and held per project in the envelope's window.
- Refusal and plan counts from this host's run records.
- Plan reasons from the allocations log, operator role only.

**Why it works this way.**
- A project may spend up to the smaller of its allocation and its own scoped limit. A job refused by the split says `allocation-cap`; one refused by the project's own limit says `dollar-cap`, so the two are never confused.
- Floors come first, the rest is split by weight, and a change moves each share by at most 25% per step. That is why the plan in force says it was clamped by the 25% step.
- A new envelope re-bases the split with no step. A host whose envelope differs refuses its governed jobs until it has the new one, which is why the card says whether every host agrees.
- The plan's reasons are agent text. They are shown as written and escaped, never as markup, and to operators only.

**Fixture note.** The spend per project ($11.78, $14.20, $6.65, $0.44, together this week's $33.07), the $120.00 weekly cap, the 40/35/20/5 weights and the pm-weekly writer on Mon 5 Oct match the Spend view. These are sample: the envelope floors, plan ids, history rows, plan reasons, digests and every state banner.
""",
"SpendCapacity": f"""Capacity shows how busy each host was, how full, how long jobs waited for a slot, and where there is no data, so a person can tell whether to add slots or move work.

**How a person uses it.**
- **Window.** 24 hours, 7 days or 30 days. At 7 days each bar is one hour.
- **Four big numbers:** busy share of slot time across the fleet, the peak, the wait for a slot (p95 and median), and promised memory at the busiest hour.
- **One card per host:**
  - busy, idle and no data as words with numbers;
  - a chart: the bar is jobs at once (average for the hour), the tick the most at once, the dashed line the slot count, hatching is no data and empty is idle;
  - facts: average and peak of the slots, how often full, promised memory and CPU, CPU used, wait for a slot, and projects by run time.
- **Always said:** "Jobs only: a machine busy with other work reads as idle."
- **Truncated history** is drawn hatched and named, never drawn as idle.
- **Right column:** how to read the chart, *Coverage* (runs counted, refused before a slot, retried, without a size, live runs not counted), and *Other states* (no time in this window yet, capacity not read, hosts not drawn past 20).
- {TABS_NOTE}

**Viewers** see the same view; it holds no reasons and no actions.

**Panels.** `p-cap-busy`, `p-cap-peak`, `p-cap-wait`, `p-cap-mem`, `p-cap-build3`, `p-cap-mini1`, `p-cap-mini2`, `p-cap-key`, `p-cap-coverage`, `p-cap-states`.

**The server provides.** The capacity report per host: slots and budget, covered, missing, busy, idle and full time, peak, average, promised memory and CPU, CPU used, wait p50 and p95, projects by run time, buckets, and coverage. Every chart is inline SVG with percent positions; the hatch is an SVG pattern.

**Why it works this way.**
- The numbers come from the run mirror and this host's run records, never from the machine: a machine busy with other work reads as idle. The *Jobs only* banner says so on the page because it is the one misreading that would change a decision.
- Missing history is never idle. Where the run mirror holds nothing older for a host, that time is hatched and counted as neither busy nor idle, and the card names the gap.
- The peak is the most jobs at once in one hour with every host added up.
- The wait for a slot is measured from when a job could start to when it held a slot.
- Promised memory is what the running jobs were promised, as a share of every host's budget.

**Fixture note.** The hosts, venues and slot counts (build3 3, mini1 4, mini2 2) match Fleet. The hourly bars are sample data from a fixed seed, and the busy, idle, no-data, average, peak and full figures are computed from them. The promised memory and CPU, CPU used, waits, projects by run time, coverage counts and the two truncated histories are sample.
""",
"SpendBreakdown": f"""Breakdown shows settled spend from run records: per day, per flow over time, per trigger, repository and model, how plans compare with API rates, the what-if per flow, and where the numbers come from.

**How a person uses it.**
- **Four big numbers:** window spend (≥ when a run could not be fully priced), runs and how many are fully ledgered, plans declared, and the top flow.
- **Daily spend.** Solid is metered, a dashed top is estimated (~), a bar line marks a floor (≥), and a day with no runs is a hairline. Every value is written with its marks. Below it is the cumulative line, dashed from the first estimated day.
- **Daily spend by flow.** The top four flows on one shared scale, and what the rest add up to.
- **Breakdown.** By trigger, with the tail rows *chained*, *manual* and *unattributed*; by repository, with a *no project* bucket and local folders by their last folder; by model. A plan row shows `plan:<id>` instead of a dollar and a dashed bar for what it would cost at API rates. The *Last folder / Full paths* switch is the operator's opt-in for full local paths. Choosing a trigger selects its chip on the Flows map.
- **What if, per flow** (right column). A model and a flow give an estimate per run and for the window, with coverage and the rates' version. The other answers: an unknown model with the closest priced ids as links, and a flow with no ledgered runs as a seeded band.
- **Right column:** *Plans* (each subscription saving, losing, would save or would lose, as a glyph and words, or no baseline), the *What if, per flow*, and *Other states*.
- **The line under the tabs** names the spend window and the counts that limit it: unmetered runs, runs with no ledger that cannot be re-priced, drifted rates and truncated ledgers.
- {TABS_NOTE}

**Viewers** see the same view with local paths always by last folder and no full-paths switch.

**Panels.** `p-bk-spend`, `p-bk-runs`, `p-bk-plans`, `p-bk-top`, `p-daily`, `p-daily-flow`, `p-breakdown`, `p-whatif-flow`, `p-plans`, `p-bk-states`.

**The server provides.** The cost fold for the window: daily totals with their money class, daily by flow, by flow, trigger, model, repository and project, plans with their verdicts, provenance (pi-ai pin, unmetered and unledgered counts), and the what-if answer. This view is drawn once per load; it is not live.

**Why it works this way.**
- **How money is shown.** Each amount carries its class, everywhere in the console:
  - `$4.12` metered: pi-ai computed the price;
  - `~$4.12` estimated: partly measured;
  - `plan:kimi`: covered by a subscription, never a dollar, so a plan is never shown as $0.00;
  - `$0 (unrated)`: a rate table priced it at zero;
  - `—`: unknown, not measured and not guessed;
  - `≥$4.12`: a floor, because the window holds spend the meter could not fully price;
  - `~~$4`: seeded, a band of $0.50 to $5.00 a run before any run of the flow is ledgered. The band narrows once one is.
- **Where the numbers come from.** Run records, re-priced with pi-ai's tables (1.0.3 here). Metered means pi-ai computed the price, not an invoice. Series are bounded by log retention and the 92-day scan cap. Money held for running jobs is not in run records yet; the Spend view shows it.
- **The what-if per flow** is the median of the flow's ledgered runs over the last 92 days, re-priced at the chosen model's rates.
- **Daily spend by flow** uses one scale for all four flows, so the bars compare.
- By flow and by project are on the Spend view, so this view does not repeat them.

**Fixture note.** The day totals for Fri 2 to Thu 8 and the flow names match the Spend view, and Thursday is today's metered $5.23 (held money is not in run records yet). The split by flow, trigger, repository and model, the run counts, the estimated and floor marks, the three plans and their verdicts, and the what-if answers are sample.
""",
"TopologyScreen": f"""The Flows map shows which trigger starts which flow, what chains to what, and what nothing reaches, so a person can find a dead flow, a risky trigger or a chain before it costs money.

**How a person uses it.**
- **Groups.** One box per local folder (its last folder name and HEAD) and one per forge ("unverifiable from this host", with the repositories its runs ran against).
- **Triggers** are pills with a glyph for their kind (cron, label, comment, pull request, issue), their run count in the 30-day map window and their spend in the spend window (or `plan:<id>`). A spent one-shot is faded and dashed and names the run that spent it.
- **Flows** are rounded boxes:
  - solid when the skill was found at HEAD;
  - dashed grey when it is unverified (a forge repository is not readable from this host);
  - dashed amber when it is not at HEAD;
  - dashed red when it is missing;
  - faded when it is an orphan.
- **Wires:** config (the trigger names this flow), observed (a thicker line with "6× · 12h ago", chained in run records), potential (dashed "mention"), and the cron re-arm loop with its schedule.
- **Badges:** a dot for unread, injected ai-trigger or PR spend-loop risk, and a ring for chainable. Each also says so in its tooltip and in the key.
- **Selecting a chip** fills it, outlines its flow and dims the rest. The side card shows the chip's details: schedule, flow, folder, runs and the last outcome, next fire, spend, whether it can chain, what it chains to, and loops in the skill.
- **Moving around.** Map or List view, zoom buttons, drag to pan. Tab reaches every chip and Enter selects it; Escape clears.
- **Not on the map** counts what is missing from it: unattributed runs, refused chain requests and labels moved into tooltips. When the triggers file is missing or invalid, a red banner says so and nothing is drawn.
- {TABS_NOTE}

**Viewers** see the same map; full local paths are an operator opt-in.

**Panels.** `p-flows`, `p-flows-key`, `p-flows-selected`, `p-flows-honesty`.

**The server provides.** The graph model: groups, nodes with their kind and flags, edges with kind and counts, run counts per trigger, the spend map, next fire and overdue per cron trigger, and the honesty counters. The map is inline SVG in a viewBox; at 390px it keeps its size and scrolls sideways inside its card.

**Why it works this way.**
- Skills of forge repositories cannot be read from this host, so their flows are drawn dashed as unverified, never as missing.
- Chains are bounded: depth at most 1, at most 2 requests per job, same folder only. A chain wire counts the last 30 days of run records.
- Run counts on the chips use the 30-day map window, and spend uses the 7-day spend window, as the line under the tabs says.
- The map works without a mouse: drag to pan, scroll or the buttons to zoom, Tab to a chip, Enter to select it and Escape to clear. The List view holds the same content as text.

**Fixture note.** The seven triggers, their flows, the folders `site` and `pm`, the forges and their repositories match Configuration. These are sample: the HEAD hashes, the skills tidy-report, deps-bump and old-migrate, the chain and mention wires, the run counts, the spend badges and the spent one-shot.
""",
}

if __name__ == "__main__":
    write("SpendBudgetSplit", card_marker("Spend", 2550, 1440, "Budget split: the envelope, the plan in force, allocation against spend, history with revert"),
          "Budget split", split_page(), CSS)
    write("SpendCapacity", card_marker("Spend", 1880, 1440, "Capacity: busy, idle and no data per host, slots, peaks and waits"),
          "Capacity", cap_page(), CSS)
    write("SpendBreakdown", card_marker("Spend", 2480, 1440, "Breakdown: daily spend with money classes, by flow, trigger, repository and model, plans and the what-if"),
          "Spend breakdown", bk_page(), CSS)
    write("TopologyScreen", card_marker("Spend", 1460, 1440, "Flows map: triggers, flows and chains by folder and forge, with a chip selected"),
          "Flows map", flows_page(), CSS)
    for n, t in READMES.items():
        readme(n, t)
    for h in HOSTDATA:
        st = h[4]
        print(h[0], {k: round(v, 3) if isinstance(v, float) else v for k, v in st.items()})
    print("daytot", DAYTOT, "wtot", WTOT)
