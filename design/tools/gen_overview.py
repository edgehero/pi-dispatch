"""Overview screens built on the Pulse kit: the problem state (fixture) and the all-clear state."""
from pulse import *

OVERVIEW_LOCAL_CSS = ".wl__l li > .btn { max-width: 100%; height: auto; min-height: 32px; white-space: normal; overflow-wrap: anywhere; }"

PROJECTS = [("All", "31"), ("web", "13"), ("api", "4"), ("billing", "12"), ("ops", "2")]
def projseg(counts=PROJECTS):
    return ('<div class="projseg" role="group" aria-label="Project"><span class="projseg__l">Project</span>'
            + "".join(f'<button type="button" aria-pressed="{"true" if p == "All" else "false"}">{p if p == "All" else tag(p)}<b>{n}</b></button>' for p, n in counts)
            + "</div>")
FILTERS = projseg() + f'<button class="fpill" type="button">Window: <b>24 hours</b>{ic("chev", "ic ic--sm")}</button><button class="fpill" type="button">Host: <b>All</b>{ic("chev", "ic ic--sm")}</button>'

# ---------------- timeline ----------------
W0, W1 = m("13:15"), m("16:45")
def pc(t): return max(0.0, min(100.0, (t - W0) / (W1 - W0) * 100))
PXW = 740
def ppx(minutes): return minutes / (W1 - W0) * PXW
NOWX = pc(NOW)
RH = 44; PY = 9; PH = 26

def done(a, b, jid, title):
    a0 = max(a, W0); x = pc(a0); w = pc(b) - x
    lab = f'<text class="tp-l" x="{x:.2f}%" dx="12" y="{PY+18}">{E(jid)}</text>' if len(jid) * 7.4 + 22 <= ppx(b - a0) else ""
    return f'<rect class="tp--ok" x="{x:.2f}%" y="{PY}" width="{w:.2f}%" height="{PH}" rx="13"><title>{E(jid)} {E(title)} completed</title></rect>{lab}'
def run(a, jid, host, title=""):
    x = pc(a); w = NOWX - x
    if len(f"{jid}  {host}") * 7 + 24 <= ppx(NOW - a):
        lab = f'<text class="tp-l tp-l--run" x="{x:.2f}%" dx="12" y="{PY+18}">{E(jid)}<tspan class="tp-sub" dx="8">{E(host)}</tspan></text>'
    else:
        lab = f'<text class="tp-l tp-l--out-run" x="{x:.2f}%" dx="-8" y="{PY+18}" text-anchor="end">{E(jid)}<tspan class="tp-sub2" dx="6">{E(host)}</tspan></text>'
    return f'<rect class="tp--run" x="{x:.2f}%" y="{PY}" width="{w:.2f}%" height="{PH}" rx="13"><title>{E(jid)} {E(title)} running on {E(host)}</title></rect>{lab}'
def parked(a, b, jid):
    x = pc(a); w = pc(b) - x
    return (f'<rect class="tp--parked" x="{x:.2f}%" y="{PY}" width="{w:.2f}%" height="{PH}" rx="13"><title>{E(jid)} parked at 15:13</title></rect>'
            f'<text class="tp-l tp-l--parked" x="{x:.2f}%" dx="12" y="{PY+18}">{E(jid)}</text>'
            f'<line class="tail" x1="{pc(b):.2f}%" x2="{NOWX:.2f}%" y1="{PY+19}" y2="{PY+19}"/>'
            f'<text class="tail-t" x="{pc(b):.2f}%" dx="6" y="{PY+11}">waiting for you</text>')
def failed(a, b, jid):
    x = pc(a); w = max(pc(b) - x, 1.2)
    return (f'<rect class="tp--failed" x="{x:.2f}%" y="{PY}" width="{w:.2f}%" height="{PH}" rx="13"><title>{E(jid)} failed at 15:10</title></rect>'
            f'<text class="tp-l tp-l--out-failed" x="{x:.2f}%" dx="-8" y="{PY+18}" text-anchor="end">{E(jid)} failed</text>')
def refused(t, jid):
    return (f'<circle class="tp-ref" cx="{pc(t):.2f}%" cy="{PY+13}" r="12"/>'
            f'<g transform="translate(-7 {PY+6})"><use class="tp-ref-g" href="#i-refused" x="{pc(t):.2f}%" width="14" height="14"/></g>'
            f'<text class="tp-l tp-l--ref" x="{pc(t):.2f}%" dx="-18" y="{PY+18}" text-anchor="end">{E(jid)} refused</text>')
def hold(jid, text):
    return (f'<rect class="tp--held" x="0" y="{PY}" width="{NOWX:.2f}%" height="{PH}" rx="13"><title>{E(jid)} cancelled at 10:59; still holds a build3 slot</title></rect>'
            f'<text class="tp-l tp-l--hold" x="0" dx="14" y="{PY+18}">{E(jid)}<tspan class="tp-sub3" dx="8">{E(text)}</tspan></text>')
def waiting(start_min, icon, jid, text, arrow=False, gap=False):
    x = pc(NOW + start_min); w = 100 - x; s = ""
    if arrow: s += f'<line class="dep" x1="{NOWX:.2f}%" x2="{x:.2f}%" y1="{PY+13}" y2="{PY+13}" marker-end="url(#arrow)"/>'
    if gap: s += f'<line class="gapline" x1="{NOWX:.2f}%" x2="{x:.2f}%" y1="{PY+13}" y2="{PY+13}"/>'
    s += f'<rect class="tp--wait" x="{x:.2f}%" y="{PY}" width="{w:.2f}%" height="{PH}" rx="13"><title>{E(jid)}: {E(text)}</title></rect>'
    s += f'<g transform="translate(9 {PY+6})"><use class="tp-wait-g" href="#i-{icon}" x="{x:.2f}%" width="14" height="14"/></g>'
    s += f'<text class="tp-l" x="{x:.2f}%" dx="28" y="{PY+18}">{E(jid)}<tspan class="tp-sub2" dx="6">{E(text)}</tspan></text>'
    return s

ROWS_PROBLEM = [
    ("web", "acme/web", [done(m("13:38"), m("13:55"), "gh-8251-r1", "acme/web#408"), done(m("14:21"), m("14:34"), "gh-a3ac", "acme/web#487"),
                         done(m("14:50"), m("15:12"), "gh-9575", "acme/web#490"), waiting(2, "clock", "gh-77c1", "07:00 + CI green")]),
    ("", "", [done(m("13:46"), m("14:06"), "gh-e12d", "acme/web#486"), done(m("14:22"), m("14:39"), "gh-4add", "acme/web#489"),
              run(m("14:58"), "gh-c41f", "mini1"), waiting(9, "rerun", "gh-38aa", "retry in 9m", gap=True)]),
    ("", "", [done(m("13:57"), m("14:09"), "gh-bd09", "acme/web#488"), run(m("15:27"), "gh-b3d7", "mini1", "acme/web#415"),
              waiting(3, "chain", "gh-d4f0", "after gh-b3d7", arrow=True)]),
    ("", "", [done(m("13:58"), m("14:17"), "gh-8251-r2", "acme/web#408"), failed(m("15:06"), m("15:10"), "gh-f0c2"),
              done(m("15:12"), m("15:25"), "gh-a91e", "acme/web#422")]),
    ("api", "acme/api", [parked(m("14:52"), m("15:13"), "gh-2f6a"), waiting(5, "rerun", "gh-71b2", "retry in 4m", gap=True)]),
    ("billing", "acme/billing, billing-ui", [done(m("13:36"), m("13:49"), "gl-9a2c", "acme/billing-ui#405"), done(m("14:22"), m("14:48"), "gh-ebd7", "acme/billing#259"),
                                             refused(m("15:30"), "gh-e9a0")]),
    ("", "", [run(m("14:19"), "gh-e802", "build3")]),
    ("", "", [hold("gh-4a7e", "cancelled 10:59, still holds a build3 slot"), waiting(3, "slot", "gh-c9e1", "needs this slot", arrow=True)]),
    ("ops", "…/site, …/pm", [run(m("15:33"), "local-9e20", "mini2")]),
]
ROWS_CLEAR = [
    ("web", "acme/web", [done(m("13:38"), m("13:55"), "gh-8251-r1", ""), done(m("14:21"), m("14:34"), "gh-a3ac", ""), done(m("14:50"), m("15:12"), "gh-9575", "")]),
    ("", "", [done(m("13:46"), m("14:06"), "gh-e12d", ""), done(m("14:22"), m("14:39"), "gh-4add", ""), run(m("14:58"), "gh-c41f", "mini1")]),
    ("", "", [done(m("13:57"), m("14:09"), "gh-bd09", ""), done(m("15:12"), m("15:25"), "gh-a91e", ""), run(m("15:27"), "gh-b3d7", "mini1")]),
    ("api", "acme/api", [done(m("14:30"), m("14:52"), "gh-03a9", ""), waiting(5, "rerun", "gh-71b2", "retry in 4m", gap=True)]),
    ("billing", "acme/billing, billing-ui", [done(m("13:36"), m("13:49"), "gl-9a2c", ""), done(m("14:22"), m("14:48"), "gh-ebd7", "")]),
    ("", "", [run(m("14:19"), "gh-e802", "build3")]),
    ("ops", "…/site, …/pm", [run(m("15:33"), "local-9e20", "mini2")]),
]

def timeline(rows):
    out = []
    band = (f'<rect class="tl-future" x="{NOWX:.2f}%" y="0" width="{100-NOWX:.2f}%" height="24"/>'
            f'<text class="tband" x="{NOWX:.2f}%" dx="-10" y="16" text-anchor="end">Ran and running</text>'
            f'<text class="tband tband--in" x="{NOWX:.2f}%" dx="10" y="16">In line</text>')
    out.append(f'<span></span><svg class="tl__r" height="24" aria-hidden="true">{band}</svg>')
    grid = "".join(f'<line class="tg" x1="{pc(m(t)):.2f}%" x2="{pc(m(t)):.2f}%" y1="0" y2="{RH}"/>' for t in ["13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"])
    for p, repo, items in rows:
        first = bool(p)
        head = f'<span class="tl__h tl__h--first">{tag(p)}<span class="tl__repo">{E(repo)}</span></span>' if p else '<span class="tl__h"></span>'
        fut = f'<rect class="tl-future" x="{NOWX:.2f}%" y="0" width="{100-NOWX:.2f}%" height="{RH}"/>'
        now = f'<line class="tnow" x1="{NOWX:.2f}%" x2="{NOWX:.2f}%" y1="0" y2="{RH}"/>'
        out.append(f'{head}<svg class="tl__r{" tl__r--first" if first else ""}" height="{RH}" role="img" aria-label="{E(p)} runs">{fut}{grid}{now}{"".join(items)}</svg>')
    axis = "".join(f'<text class="tax" x="{pc(m(t)):.2f}%" y="14" text-anchor="middle">{t}</text>' for t in ["13:30", "14:00", "14:30", "15:00", "16:00", "16:30"])
    axis += f'<rect class="tnowcap" x="{NOWX:.2f}%" y="2" width="46" height="18" rx="9" transform="translate(-23 0)"/><text class="tnowcap-t" x="{NOWX:.2f}%" y="15" text-anchor="middle">15:39</text>'
    out.append(f'<span></span><svg class="tl__r" height="24" aria-hidden="true">{axis}</svg>')
    return f'<div class="tl-wrap"><div class="tl">{"".join(out)}</div></div>'

KEY = f"""<p class="keyrow">
  <span><i class="lg lg--ok"></i>Completed</span><span><i class="lg lg--run"></i>Running</span><span><i class="lg lg--parked"></i>Awaiting input</span>
  <span><i class="lg lg--failed"></i>Failed</span><span><i class="lg lg--ref"></i>Refused</span><span><i class="lg lg--hold"></i>Slot held</span>
  <span><i class="lg lg--wait"></i>In line</span><span>{ic('chain', 'ic ic--sm')}waits for a run</span></p>"""

ZOOM = '<div class="seg" role="group" aria-label="Rows"><button aria-pressed="true">Project</button><button aria-pressed="false">Host</button></div><div class="seg" role="group" aria-label="Zoom"><button aria-pressed="false">1h</button><button aria-pressed="true">3h</button><button aria-pressed="false">24h</button></div>'

def tl_card(rows):
    return card("Runs by project", timeline(rows) + KEY, end=ZOOM, sub="left of now: what ran; right of now: what is in line", id_="p-timeline")

# ---------------- KPI cards ----------------
def needs_card(clear=False):
    if clear:
        body = f"""<p class="kpi"><b>0</b><span>nothing needs you</span></p>
  <div class="empty">{'<span class="tile tone-ok">' + ic('done') + '</span>'}<b>All clear</b><span>No questions, failures or refusals in the last 24 hours.</span></div>"""
        return card("Needs you", body, id_="p-needs")
    body = f"""<div class="bigpair">
    <a href="#" class="big tone-parked"><span class="big__n"><span class="tri"></span>1</span><span class="big__l">question</span></a>
    <a href="#" class="big tone-failed"><span class="big__n"><span class="tri tri--down"></span>3</span><span class="big__l">to fix</span></a>
  </div>
  <ul class="rows" style-note="">
    <li class="rowpill tone-parked">{ic('parked', 'ic ic--sm')}{tag('api')}<span class="code">gh-2f6a</span><a class="rowpill__act" href="#">Answer</a></li>
    <li class="rowpill tone-failed">{ic('failed', 'ic ic--sm')}{tag('web')}<span class="code">gh-f0c2</span><a class="rowpill__act" href="#">Re-run</a></li>
    <li class="rowpill tone-refused">{ic('refused', 'ic ic--sm')}{tag('billing')}<span class="code">gh-e9a0</span><a class="rowpill__act" href="#">Open</a></li>
    <li class="rowpill tone-failed">{ic('hourglass', 'ic ic--sm')}{tag('api')}<span class="code">gh-5d10</span><a class="rowpill__act" href="#">Retry</a></li>
  </ul>""".replace(' style-note=""', '')
    return card("Needs you", body, id_="p-needs", cls="kp")

REASONS = [("slot", "Free slot", 1), ("chain", "Another run", 1), ("clock", "Time or check", 1), ("rerun", "Retry backoff", 2)]
def inline_card(clear=False):
    rs = [("slot", "Free slot", 0), ("chain", "Another run", 0), ("clock", "Time or check", 0), ("rerun", "Retry backoff", 1)] if clear else REASONS
    n = sum(r[2] for r in rs)
    body = (f'<p class="kpi"><b>{n}</b><span>{"job" if n == 1 else "jobs"} waiting to start</span></p><ul class="rows">'
            + "".join(f'<li class="rowpill">{ic(i, "ic ic--sm")}<span>{t}</span><span class="end"><b>{c}</b></span></li>' for i, t, c in rs) + "</ul>")
    return card("In line", body, end=f'<span class="card__sub">{"longest 4m" if clear else "longest 2h 14m"}</span>', id_="p-waiting")

def running_card(clear=False):
    hold_note = '<span class="end faint">2 free</span>' if clear else '<span class="end tinted tone-attention"><b class="tinted">1 held</b></span>'
    body = f"""<p class="kpi"><b>4</b><span>in {"4" if clear else "5"} of 9 slots</span></p>
  <ul class="rows">
    <li class="rowpill"><b>build3</b><span class="sls">{slots('rff' if clear else 'rhf')}</span>{hold_note}</li>
    <li class="rowpill"><b>mini1</b><span class="sls">{slots('rrff')}</span><span class="end faint">2 free</span></li>
    <li class="rowpill"><b>mini2</b><span class="sls">{slots('rf')}</span><span class="end faint">1 free</span></li>
  </ul>"""
    return card("Running", body, end=chip("live", "running", "running"), id_="p-active")

def spend_card(clear=False):
    body = f'<p class="kpi"><b>$15.04</b><span>of $25.00</span></p>{spend_dots()}<p class="axis"><span>00:00</span><span>08:00</span><span>15:00</span></p>'
    return card("Spend today", body, end=chip("60% of cap", "ok"), id_="p-spend")

# ---------------- waitlists ----------------
def wrow(icon, title, n, items):
    lis = "".join(f'<li>{tag(p)}<span class="code">{jid}</span><span class="wl__t">{t}</span>{a}</li>' for p, jid, t, a in items)
    return f'<div class="wl__g"><p class="wl__h"><span class="tile tile--sm tone-idle">{ic(icon, "ic ic--sm")}</span><b>{title}</b><span class="count">{n}</span></p><ul class="wl__l">{lis}</ul></div>'

def seg_bar(reasons):
    total = sum(r[2] for r in reasons) or 1; x = 0; out = []
    for i, (icon, label, n) in enumerate(reasons):
        if not n: continue
        w = n / total * 100
        out.append(f'<rect class="wb wb--{i}" x="{x:.2f}%" y="0" width="{w:.2f}%" height="30" rx="8"/>'
                   f'<g transform="translate(10 8)"><use class="wb-g" href="#i-{icon}" x="{x:.2f}%" width="14" height="14"/></g>'
                   f'<text class="wb-t" x="{x:.2f}%" dx="30" y="20">{n}</text>')
        x += w
    return f'<svg class="wbar" height="30" role="img" aria-label="In line by reason">{"".join(out)}</svg>'

def waitlists(clear=False):
    if clear:
        body = (seg_bar([("rerun", "Retry backoff", 1)])
                + wrow("rerun", "Retry backoff", 1, [("api", "gh-71b2", "attempt 2 of 3 in 4m", "")])
                + '<p class="collapsed">' + ic('done', 'ic ic--sm') + '<b>No job waits for a slot, another run, or a time or check.</b></p>')
    else:
        body = (seg_bar(REASONS)
                + wrow("slot", "Waiting for a free slot", 1, [("billing", "gh-c9e1", "build3 is full: a slot is held by cancelled gh-4a7e", btn("Free slot", "danger"))])
                + wrow("chain", "Waiting for another run to finish", 1, [("web", "gh-d4f0", "review, starts when gh-b3d7 finishes", btn("Chain", "ghost"))])
                + wrow("clock", "Waiting on a time or a check", 1, [("web", "gh-77c1", "after 07:00 UTC, then CI green. Held 2h 14m", btn("Edit", "ghost"))])
                + wrow("rerun", "Retry backoff", 2, [("api", "gh-71b2", "attempt 2 of 3 in 4m", ""), ("web", "gh-38aa", "attempt 2 of 3 in 9m", "")]))
    body += f"""<div class="qrow"><span class="card__sub">Queues</span>
    <span class="qp"><b class="code">pi-jobs</b>{"0 waiting, 1 delayed" if clear else "1 waiting, 3 delayed, 1 chained"}</span>
    <span class="qp"><b class="code">@build3</b>0</span><span class="qp"><b class="code">@mini1</b>0</span><span class="qp"><b class="code">@mini2</b>0</span></div>
  <p class="card__sub">{ic('clock', 'ic ic--sm')} Scheduled: acme/web pauses 20:00, nightly-tidy 03:00, pm-weekly Mon 06:00</p>"""
    return card("Waitlists", f'<div class="wl">{body}</div>', end='<div class="seg" role="group" aria-label="Group by"><button aria-pressed="true">Reason</button><button aria-pressed="false">Queue</button></div>',
                id_="p-waitlists")

CAPS = [("Jobs", "today", 25/40), ("Jobs", "week", 99/200), ("Jobs", "month", 166/600), ("Tokens", "today", 3081250/8e6),
        ("Deploy $", "today", 15.04/25), ("Deploy $", "week", 33.07/120), ("web $", "week", 11.78/45), ("sonnet $", "week", 32.46/80)]
def caps_card():
    body = (f'<div class="capbars">{"".join(capsule(*c) for c in CAPS)}</div>'
            '<p class="keyrow"><span><i class="k tone-ok"></i>Open</span><span><i class="k tone-attention"></i>Soft hold: new jobs wait</span>'
            '<span><i class="k k--hold"></i>Soft hold line (80%)</span><span>web $ is project:web; sonnet $ is claude-sonnet-5-5</span></p>')
    return card("Caps", body, end=btn("Spend"), sub="percent used", id_="p-caps")

def hosts_card(clear=False):
    b3 = (hostrow("build3", "ok", "podman", "12s", "", "rff", f'<span class="tinted tone-ok">{ic("done", "ic ic--sm")}Doctor: 40 passing</span><span><span class="code">@build3</span> 0 waiting, 1 running</span>')
          if clear else hostrow("build3", "attention", "podman", "2m", "attention", "rhf", f'<span class="tinted tone-failed">{ic("failed", "ic ic--sm")}Doctor: Docker daemon unreachable, 3 days old</span><span><span class="code">@build3</span> 0 waiting, 1 running</span>'))
    rows = b3 + hostrow("mini1", "ok", "local", "22s", "", "rrff", f'<span class="tinted tone-attention">{ic("attention", "ic ic--sm")}1 doctor warning</span><span><span class="code">@mini1</span> 0 waiting, 2 running</span>') \
              + hostrow("mini2", "ok", "local, openshell", "22s", "", "rf", '<span class="faint">No doctor result yet</span><span><span class="code">@mini2</span> 0 waiting, 1 running</span>')
    return card("Hosts", f'<ul class="hosts">{rows}</ul>', end=btn("Pause fleet", "danger", "pause"), sub="3 beating", id_="p-hosts")

def overview(clear=False):
    kpis = f'<div class="cards-4">{needs_card(clear)}{inline_card(clear)}{running_card(clear)}{spend_card(clear)}</div>'
    body = f'<div class="cols"><div class="stack">{tl_card(ROWS_CLEAR if clear else ROWS_PROBLEM)}{caps_card()}</div><div class="stack">{waitlists(clear)}{hosts_card(clear)}</div></div>'
    title = "Overview"
    sub = "All clear. 4 jobs running, nothing needs you." if clear else ""
    agent_writes = card("Agent writes today", '<p class="kpi"><b>3</b><span>confirmed applied writes</span></p><p class="card__sub">mini1, UTC today; local audit only</p><a class="link" href="#">Open this host’s agent audit history</a><p class="card__sub">The history includes earlier days. Incomplete evidence is labelled partial; unavailable is never zero.</p>', id_="p-agent-writes")
    return shell("Overview", kpis + agent_writes + body, title, sub=sub, end=FILTERS, parked=0 if clear else 1)

if __name__ == "__main__":
    write("OverviewScreen", card_marker("Screens", 1520, 1440, "Overview with problems: what needs you, what is in line and on what it waits, runs by project"),
          "Overview", overview(False), OVERVIEW_LOCAL_CSS)
    write("OverviewAllClear", card_marker("Screens", 1400, 1440, "Overview when nothing needs you"), "Overview, all clear", overview(True), OVERVIEW_LOCAL_CSS)
    write("OverviewPhone", card_marker("Screens, phone", 2900, 390, "Overview at 390px: the same cards, one column"), "Overview on a phone", overview(False), OVERVIEW_LOCAL_CSS)
    print("overview written")
