"""A watch rule's board (#735 extended): why each finding did what it did, every stream, query and decision the pipeline
made, the decision models (Jev and others), and a board the triage jobs keep up to date themselves, as data. Pulse kit."""
from pulse import *
from gen_triggers import tabs as trigger_tabs

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'

def probs(rows, chosen):
    """rows: [(option, p)]; a bar per option, the chosen one in the running tone, glyph on the chosen row."""
    out = []
    for o, p in rows:
        on = o == chosen
        out.append(f'<li class="wb-p{" wb-p--on" if on else ""}"><span class="wb-p__o">{ic("done", "ic ic--sm") if on else ""}{E(o)}</span>'
                   f'<svg class="wb-p__b" height="8" role="img" aria-label="{E(o)}: {p:.2f}"><rect class="wb-p__bed" width="100%" height="8" rx="4"/>'
                   f'<rect class="wb-p__fill" width="{max(p * 100, 1.5):.1f}%" height="8" rx="4"/></svg><b>{p:.2f}</b></li>')
    return f'<ul class="wb-probs">{"".join(out)}</ul>'

def stage(n, tone, icon, word, title, body, meta=""):
    return f"""<li class="wb-st">
  <p class="wb-st__k"><span class="wb-st__n">{n}</span>{word}</p>
  <div class="wb-st__c tone-{tone}">
    <p class="wb-st__t"><span class="tile tile--sm">{ic(icon)}</span><span>{title}</span></p>
    {body}
    {f'<p class="wb-st__m">{meta}</p>' if meta else ''}
  </div>
</li>"""

def checks(items):
    return '<ul class="wb-checks">' + "".join(f'<li>{ic("done", "ic ic--sm")}<span>{t}</span></li>' for t in items) + "</ul>"

ARROW = f'<li class="wb-arrow" aria-hidden="true">{ic("chev-r")}</li>'

CHAIN = card("Why this finding started a job", f"""<ol class="wb-chain">
{stage(1, "ok", "shield", "Stream", "A signed finding from prod-alerts",
       checks(["37 events from 14:58 to 15:13 UTC", f"fingerprint {code('checkout/TimeoutError/db.pool.acquire')}", "8 samples kept, redacted on the host"]),
       "Vector · hmac-sha256 checked before any field was read · 15:13:52")}
{ARROW}
{stage(2, "ok", "fit", "Rules", "Passed all four rules",
       checks(["severity error, service checkout", "37 is 5 or more in 10m", "no cooldown: last job 2 days ago", "1 of 4 jobs today"]),
       "no model, no cost")}
{ARROW}
{stage(3, "ok", "terminal", "Job", "Triage ran 15m on mini2",
       checks([f"{code('local-7f21')} triage-incident, read-only", "3 log queries to loki.internal", "2 decisions with Jev's decide tool", "3 board proposals, made while it ran"]),
       "claude-haiku-5-5 · edit and write excluded · $0.11 of its $0.40 cap")}
{ARROW}
{stage(4, "parked", "parked", "Outcome", "Waits for a person",
       f'<p class="wb-st__s">It asked for {code("fix-db-pool")}, which changes code, so a person decides. Issue {code("acme/shop#88")} carries the evidence.</p>'
       f'<p class="wb-st__a">{btn("Review", "answer", "parked")}</p>',
       "review by someone with write access")}
</ol>
<div class="wb-shadow">
  <p class="wb-shadow__h"><span class="chip">{ic('eye')}shadow</span><b>Jev at the gate would have chosen investigate</b><span class="wb-shadow__ok">{ic('done', 'ic ic--sm')}agrees with what happened</span></p>
  <div class="wb-shadow__b">{probs([("investigate", .82), ("file_issue", .14), ("ignore", .04)], "investigate")}
    <p class="wb-st__s">Over 30 days it agreed with what happened 9 times out of 11.</p></div>
</div>""", sub="checkout TimeoutError at db.pool.acquire, 37 times · the newest finding", id_="p-wb-chain",
    end=f'<div class="seg" role="group" aria-label="Finding"><button aria-pressed="true">15:13 checkout</button><button aria-pressed="false">09:12 search</button></div>')

# ---- every stream, query and decision, newest first ----
BY = {"collector": ("idle", "queue", "collector"), "rules": ("idle", "fit", "rules"), "shadow": ("idle", "eye", "Jev, shadow"),
      "job": ("ok", "terminal", "local-7f21")}
KINDS = {"decide": ("Decision", "spend"), "logql": ("Log query", "search"), "turn": ("Model turn", "runs"), "rule": ("Rule", "fit"),
         "board": ("Board proposal", "edit"), "stream": ("Stream", "queue")}
TRACE = [
    ("15:28:40", "job", "board", "run notes: three hypotheses and a note, kept with this run only", "not adoptable", "", "the run"),
    ("15:27:12", "job", "decide", "jev-1.13 · regression_from_deploy (yes or no) on {deploy: 4a1f, deployed: 14:40, pool waits by pod, retries per request}", "yes 0.77", "$0.00008 · 0.12 s", "hypothesis 1"),
    ("15:24:20", "job", "board", "add a chart: Pool waits by pod, from the query below", "waiting for you", "", "the board"),
    ("15:24:05", "job", "logql", 'sum by (pod) (count_over_time({service="checkout"} |= "pool timeout" [5m]))', "3 series", "0.31 s", "chart: pool waits"),
    ("15:21:30", "job", "logql", 'quantile_over_time(0.95, {service="checkout-db"} | json | unwrap duration_ms [5m])', "flat at 41 ms", "0.28 s", "hypothesis 2"),
    ("15:19:48", "job", "turn", "claude-haiku-5-5 · turn 6 of 20", "planned two queries", "$0.009", "the transcript"),
    ("15:19:30", "job", "board", "remove a block: Error rate by region, one region in 30 days", "waiting for you", "", "the board"),
    ("15:17:02", "job", "logql", '{service="checkout", level="error"} | json | error_type="TimeoutError"', "412 lines, 8 kept", "0.22 s", "evidence"),
    ("15:16:20", "job", "decide", "jev-1.13 · next_step (choice: query_logs, check_deploys, propose_fix, stop)", "query_logs 0.69", "$0.00006 · 0.11 s", "the next query"),
    ("15:14:01", "job", "stream", "job started with findings.json (37 events, 8 samples) and the adopted board v3", "read-only", "", "the job"),
    ("15:13:55", "shadow", "decide", "jev-1.13 · act (choice), customer_impact (yes or no), severity (low to critical) on the fingerprint fields and counts", "would have: investigate 0.82", "$0.00002 · 0.13 s", "nothing: shadow"),
    ("15:13:52", "rules", "rule", "severity in [error, critical], service = checkout; 5 in 10m; cooldown 6h; 4 a day", "4 of 4 passed", "", "starting the job"),
    ("15:13:52", "collector", "stream", "prod-alerts: Vector dedupe on service, error.type, frame.top; throttle 5 in 10m", "37 events", "", "the finding"),
]
def trace_rows():
    rows = []
    for t, by, kind, q, res, cost, used in TRACE:
        tone, bic, bword = BY[by]
        kword, kic = KINDS[kind]
        qcls = "wb-q wb-q--code" if kind in ("logql", "decide") else "wb-q"
        meta = " · ".join(x for x in [f"<b>{E(res)}</b>", E(cost), f"used for {E(used)}"] if x)
        rows.append(f"""<li class="wb-e wb-e--{kind}">
  <span class="wb-e__t">{t}</span>
  <div class="wb-e__b">
    <p class="wb-e__h"><span class="wb-by{(' tone-' + tone) if tone != 'idle' else ''}">{ic(bic, 'ic ic--sm')}{bword}</span><span class="wb-kind">{ic(kic, 'ic ic--sm')}{kword}</span></p>
    <p class="{qcls}">{E(q)}</p>
    <p class="wb-e__m">{meta}</p>
  </div>
</li>""")
    return "".join(rows)

TRACECARD = card("Every stream, query and decision", f"""<div class="wb-filt" role="group" aria-label="Show">
  <button class="fpill fpill--sm fpill--on" type="button" aria-pressed="true">All <b>13</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('spend', 'ic ic--sm')}Decisions <b>3</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('search', 'ic ic--sm')}Log queries <b>3</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('edit', 'ic ic--sm')}Board proposals <b>3</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('runs', 'ic ic--sm')}Model turns <b>1</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('queue', 'ic ic--sm')}Streams and rules <b>3</b></button>
</div>
<ol class="wb-log" aria-label="Everything the pipeline read and decided for this finding, newest first">{trace_rows()}</ol>
""",
    sub="for this finding, newest first, UTC", id_="p-wb-trace")

# ---- the board: what you adopted, and what this run proposes ----
def line_chart(series, labels, aria, dep=True, hi=1, M=48):
    W, H = 300, 110
    def pts(s): return " ".join(f"{i * W / (len(s) - 1):.1f},{H - v / M * H:.1f}" for i, v in enumerate(s))
    lines = "".join(f'<polyline class="wb-ch__l{" wb-ch__l--hi" if i == hi else ""}" points="{pts(s)}"/>' for i, s in enumerate(series) if i != hi)
    lines += f'<polyline class="wb-ch__l wb-ch__l--hi" points="{pts(series[hi])}"/>'
    d = 2 * W / 12
    return f"""<div class="wb-chart">
  <svg class="wb-chart__s" viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="{E(aria)}">
    <line class="wb-ch__g" x1="0" x2="{W}" y1="{H / 2}" y2="{H / 2}"/>
    {f'<line class="wb-ch__dep" x1="{d:.1f}" x2="{d:.1f}" y1="0" y2="{H}"/>' if dep else ''}
    {lines}
  </svg>
  <div class="wb-chart__lab"><span class="wb-ch__k wb-ch__k--hi">{labels[0]}</span><span class="wb-ch__k">{labels[1]}</span>{'<span class="wb-ch__k wb-ch__k--dep">deploy 4a1f, 14:40</span>' if dep else ''}</div>
  <div class="wb-chart__ax"><span>14:30</span><span>15:00</span><span>15:30</span></div>
</div>"""

POOL = line_chart([[2, 3, 2, 3, 4, 3, 4, 3, 4, 3, 3, 4, 3], [2, 3, 3, 9, 16, 22, 30, 34, 38, 41, 44, 40, 43], [1, 2, 2, 4, 5, 6, 6, 7, 8, 7, 8, 9, 8]],
                  ("checkout-2", "checkout-1, checkout-3"), "Pool waits by pod: checkout-2 climbs from 3 to 43 per 5 minutes after the 14:40 deploy; the other pods stay low")
ERRS = line_chart([[1, 1, 2, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1], [0, 1, 1, 3, 6, 8, 9, 11, 12, 10, 12, 11, 12], [0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1]],
                  ("checkout", "search, payments"), "Errors by service: checkout rises from 1 to 12 per 5 minutes after the 14:40 deploy; search and payments stay near 0", M=16)

HYP = [("supported", "ok", "done", "The retry change in 4a1f drains the pool", "Jev: regression from the deploy, yes 0.77 · the pool-waits query"),
       ("ruled out", "idle", "cancel", "The database got slow", "p95 query time flat at 41 ms"),
       ("open", "attention", "attention", "A traffic spike", "not checked yet: no traffic source in the bundle")]

def proposal(t, title, why, body, open_confirm=False):
    act = f'<div class="wb-prop__act">{btn("Adopt", "", "done")}{btn("Dismiss", "ghost", "cancel")}</div>'
    conf = confirm("safe", "Adopt “Pool waits by pod” into shop-5xx's board",
                   [f"Adds the query {code('sum by (pod) (count_over_time(…pool timeout… [5m]))')} as a chart. Every later triage job runs it on fresh data.",
                    "It reaches only loki.internal, through the shop bundle.",
                    "The board becomes v4. Audited as <b>board-adopt</b>."],
                   "Remove the block again (v3)", "Adopt into v4") if open_confirm else ""
    return f"""<li class="wb-prop">
  <p class="wb-prop__h"><span class="chip tone-parked">{ic('edit')}Proposed</span><span class="wb-by">{t}</span><b>{title}</b></p>
  <p class="wb-prop__why">{why}</p>
  {body}
  {act}
  {conf}
</li>"""

BOARD = card("The board", f"""<div class="wb-sec">
  <div class="wb-sec__h"><p><b>Adopted</b><span>v3 · adopted by ops on 6 Oct · refreshed by {code('local-7f21')} at 15:20 UTC</span></p>
    <div class="wb-ver" role="group" aria-label="Version"><button class="fpill fpill--sm fpill--on" type="button" aria-pressed="true">v3 · now</button><button class="fpill fpill--sm" type="button" aria-pressed="false">v2</button><button class="fpill fpill--sm" type="button" aria-pressed="false">v1</button></div></div>
  <div class="wb-board">
    <div class="cards-3 wb-stats">
      <div class="wb-stat"><b>37</b><span>timeouts in the window</span><small>from: findings</small></div>
      <div class="wb-stat"><b>2</b><span>deploys in the last day</span><small>from: the deploys query</small></div>
      <div class="wb-stat"><b>41 ms</b><span>p95 database time</span><small>from: query 2</small></div>
    </div>
    <div class="wb-block"><p class="wb-block__h">Errors by service, per 5 minutes<small>adopted query, run fresh at 15:20</small></p>{ERRS}</div>
    <p class="collapsed wb-col">{ic('chev-r', 'ic ic--sm')}<b>Error rate by region</b> one block, folded</p>
  </div>
</div>
<div class="wb-sec">
  <div class="wb-sec__h"><p><b>Proposed by {code('local-7f21')}</b><span>3 proposals, made while it ran</span></p></div>
  <ol class="wb-props">
    {proposal("15:24", "Add a chart: Pool waits by pod", "It explains the timeouts: one pod's waits climb right after the deploy.",
              f'<p class="wb-q wb-q--code">{E(chr(115) + "um by (pod) (count_over_time({service=" + chr(34) + "checkout" + chr(34) + "} |= " + chr(34) + "pool timeout" + chr(34) + " [5m]))")}</p><div class="wb-block">{POOL}</div>', open_confirm=True)}
    {proposal("15:19", "Remove a block: Error rate by region", "It has shown one region for 30 days, so it says nothing.", "")}
    <li class="wb-prop wb-prop--notes">
      <p class="wb-prop__h"><span class="wb-by">{ic('info', 'ic ic--sm')}run notes, 15:28</span><b>Kept with this run only</b></p>
      <ul class="wb-hyp">{''.join(f'<li><span class="badge tone-{t}">{ic(i)}{w}</span><div><b>{E(h)}</b><span>{E(why)}</span></div></li>' for w, t, i, h, why in HYP)}</ul>
      <p class="wb-notet">{E("Since 4a1f, checkout-2 retries pool.acquire three times with no backoff. With 10 connections the pool drains under normal load. Proposed fix-db-pool: add backoff and raise the pool to 20. Not verified against traffic.")}</p>
    </li>
  </ol>
</div>
<div class="wb-bact">{btn('Go back to v2', 'ghost', 'rerun')}{btn('Clear the adopted board', 'danger', 'cancel')}</div>""",
    sub="what you adopted, and what this run proposes", id_="p-wb-board")

# ---- how the job went: the same view for 15 minutes or 6 hours ----
def run_chart():
    spend = [0, .004, .01, .018, .026, .033, .041, .05, .058, .066, .074, .083, .091, .1, .106, .11]
    W, H, M = 300, 90, .40
    pts = " ".join(f"{i * W / (len(spend) - 1):.1f},{H - v / M * H:.1f}" for i, v in enumerate(spend))
    def mx(minute): return minute / 15 * 100
    marks = ([("prop", m) for m in (5.5, 10.3, 14.7)] + [("dec", m) for m in (2.3, 13.2)] + [("q", m) for m in (3.0, 7.5, 10.1)])
    ticks = "".join(f'<circle class="wb-rk wb-rk--{k}" cx="{mx(m):.1f}%" cy="{ {"prop": 8, "dec": 22, "q": 36}[k] }" r="5"/>' for k, m in marks)
    return f"""<div class="wb-run">
  <svg class="wb-run__s" viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Spend over the run: rising steadily to $0.11 against a $0.40 cap">
    <line class="wb-run__cap" x1="0" x2="{W}" y1="1" y2="1"/>
    <polyline class="wb-run__l" points="{pts}"/>
  </svg>
  <svg class="wb-run__m" height="44" role="img" aria-label="3 board proposals, 2 decisions and 3 log queries over the run">{ticks}</svg>
  <div class="wb-chart__ax"><span>15:14</span><span>15:21</span><span>15:29</span></div>
  <p class="keyrow"><span><i class="wb-k wb-kprop"></i>board proposal</span><span><i class="wb-k wb-k1"></i>decision</span><span><i class="wb-k wb-kq"></i>log query</span><span><i class="wb-k wb-kc"></i>its $0.40 cap</span></p>
</div>"""

RUN = card("How the job went", f"""{run_chart()}
<div class="wb-mstats wb-mstats--2">
  <span><b>$0.44 an hour</b>so its cap is about 55 minutes of work</span>
  <span><b>31%</b>of its context at the end, not compacted</span>
  <span><b>3, while it ran</b>board proposals, at 15:19, 15:24 and 15:28</span>
  <span><b>not armed</b>recovery: a local job is not recovered</span>
</div>
""",
    sub=f"{code('local-7f21')}, 15:14 to 15:29 · the same view for a job of 15 minutes or 6 hours", id_="p-wb-run")

# ---- streams ----
def spark(vals, cls=""):
    n = len(vals); m = max(vals) or 1
    pts = " ".join(f"{i * 100 / (n - 1):.1f},{22 - v / m * 20:.1f}" for i, v in enumerate(vals))
    return f'<svg class="wb-sp {cls}" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="{pts}"/></svg>'

STREAMS = card("Streams", f"""<ul class="wb-src">
  <li><div class="wb-src__h"><span class="dot tone-ok"></span><b class="code">prod-alerts</b><span class="vtag">push</span><span class="wb-src__r">3m ago</span></div>
    {spark([1, 0, 0, 2, 1, 0, 0, 0, 1, 3, 2, 1, 0, 0, 1, 2, 4, 3, 2, 6, 9, 2, 1, 0])}
    <p class="card__sub">Vector, hmac-sha256 · 41 findings in 24h: 36 held by cooldown, 2 passed the rules, 1 capped, 2 unmatched</p></li>
  <li><div class="wb-src__h"><span class="dot tone-ok"></span><b class="code">loki.internal</b><span class="vtag">query</span><span class="wb-src__r">19m ago</span></div>
    {spark([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0])}
    <p class="card__sub">read by jobs through the shop bundle, which reaches only loki.internal · 6 queries in 24h</p></li>
  <li><div class="wb-src__h"><span class="dot tone-attention"></span><b class="code">staging-logs</b><span class="vtag">push</span><span class="wb-src__r">never</span></div>
    <p class="wb-warn">{ic('attention', 'ic ic--sm')}<span>Doctor: secret {code('WATCH_STAGING_SECRET')} is missing, so its deliveries are refused.</span></p></li>
</ul>""", sub="what came in, and what was read", id_="p-wb-streams")

MODELS = card("Decision models", f"""<ul class="wb-models">
  <li><div class="wb-m__h"><b>jev-1.13</b><span class="muted">pinned to the 2026-09-17 snapshot</span><span class="wb-by tone-running">{ic('spend', 'ic ic--sm')}typed decisions</span></div>
    <p class="card__sub">TypeSafe, through OpenRouter's Decisions API (alpha).</p>
    <ul class="wb-roles">
      <li><span class="chip tone-ok">{ic('done')}acts</span><span><b>In the triage job,</b> as the {code('decide')} tool.</span></li>
      <li><span class="chip">{ic('eye')}shadow</span><span><b>At the gate.</b></span></li>
    </ul>
    <p class="wb-mstats"><span><b>6</b>calls, 24h</span><span><b>$0.0003</b>spend</span><span><b>0.13 s</b>typical time</span></p>
    <p class="wb-m__k">Shadow, last 30 days: did it agree with what happened?</p>
    <svg class="wb-dist" height="14" role="img" aria-label="agreed 9, disagreed 2"><rect class="wb-dok" x="0" width="81.2%" height="14" rx="7"/><rect class="wb-dno" x="81.8%" width="18.2%" height="14" rx="7"/></svg>
    <p class="keyrow wb-dk"><span><i class="wb-k wb-kok"></i>agreed 9</span><span><i class="wb-k wb-kno"></i>disagreed 2: it said ignore, and both became fixes a person merged</span></p>
    <p class="wb-warn">{ic('attention', 'ic ic--sm')}<span>Not available through EU in-region routing yet, so its input leaves the EU.</span></p></li>
  <li><div class="wb-m__h"><b>claude-haiku-5-5</b><span class="muted">in the triage job</span><span class="wb-by">{ic('runs', 'ic ic--sm')}reasons and queries</span></div>
    <p class="card__sub">1 job in 24h, 14 turns, $0.11, read-only.</p></li>
</ul>
<p class="wb-pol">{ic('pause', 'ic ic--sm')}<span><b>Acting at the gate: off.</b> Set by hand in triggers.json.</span></p>""",
    sub="any model behind the decide tool's contract", id_="p-wb-models")

KPIS = f"""<div class="cards-4">
{card('Findings, 24h', '<p class="kpi"><b>41</b><span>3 fingerprints</span></p><p class="wb-kp">36 held by cooldown, 1 capped, 2 unmatched</p>', id_="p-wb-findings")}
{card('Jobs', '<p class="kpi"><b>1</b><span>triage, 15m</span></p><p class="wb-kp">read-only; it asked for one follow-up and proposed 2 board changes</p>', id_="p-wb-jobs")}
{card('Jev in shadow', '<p class="kpi"><b>2 of 2</b><span>agreed</span></p><p class="wb-kp">with what happened today · 9 of 11 in 30 days</p>', id_="p-wb-shadow")}
{card('Spend, 24h', '<p class="kpi"><b>$0.11</b><span>jobs</span></p><p class="wb-kp">plus $0.0003 of decisions · cap $0.40 a job, 4 a day</p>', id_="p-wb-spend")}
</div>"""

def page():
    inner = (trigger_tabs("Watch") + KPIS + CHAIN +
             f'<div class="cols"><div class="stack">{BOARD}</div><div class="stack">{RUN}{STREAMS}{MODELS}</div></div>' +
             TRACECARD)
    end = f'<span class="badge tone-running">{ic("running")}Watching</span>{btn("Open the rule", "", "bolt", sm=False)}'
    return shell("Triggers", inner, "shop-5xx",
                 sub=f"A watch on checkout errors from {code('prod-alerts')}. Every finding gets a fresh job; jobs propose board changes and you adopt them.",
                 end=end, back="Watch")

CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.titlebar__end { display: flex; align-items: center; gap: 10px; }
.wb-kp { font-size: 13px; color: var(--ink-muted); }
.wb-chain { display: grid; grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr) 20px minmax(0, 1.15fr) 20px minmax(0, 1fr); align-items: stretch; }
.wb-st { display: grid; grid-template-rows: auto 1fr; gap: 8px; min-width: 0; }
.wb-st .code { white-space: normal; overflow-wrap: anywhere; }
.wb-st__t > span:last-child { min-width: 0; }
.wb-st__k { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: var(--ink-muted); }
.wb-st__n { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-2); color: var(--ink); font-size: 11px; }
.wb-st__c { display: grid; align-content: start; gap: 10px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 0 3px 0 var(--tone); }
.wb-st__t { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; color: var(--ink); line-height: 20px; }
.wb-st__t .tile { background: var(--tone-tint); color: var(--tone-ink); }
.wb-st__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.wb-st__m { font-size: 11px; line-height: 16px; color: var(--ink-muted); border-top: 1px solid var(--line); padding-top: 8px; margin-top: auto; }
.wb-st__a { margin-top: 2px; }
.wb-arrow { display: flex; align-items: center; justify-content: center; color: var(--ink-faint); padding-top: 28px; }
.wb-checks { display: grid; gap: 4px; }
.wb-checks li { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; line-height: 17px; color: var(--ink); }
.wb-checks .ic { color: var(--ok-ink); flex: none; margin-top: 2px; }
.wb-probs { display: grid; gap: 6px; }
.wb-p { display: grid; grid-template-columns: 92px minmax(0, 1fr) 34px; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-muted); }
.wb-p__o { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); }
.wb-p--on .wb-p__o { color: var(--ink); font-weight: 700; }
.wb-p--on .ic { color: var(--running-ink); }
.wb-p__b { width: 100%; display: block; }
.wb-p__bed { fill: var(--surface-3); }
.wb-p__fill { fill: var(--ink-faint); }
.wb-p--on .wb-p__fill { fill: var(--running); }
.wb-p b { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }
.wb-filt { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--space-3); }
.wb-filt .fpill b { margin-left: 2px; }
.wb-log { display: grid; }
.wb-e { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
.wb-e__t { font-size: 12px; font-weight: 650; color: var(--ink-muted); font-variant-numeric: tabular-nums; padding-top: 4px; }
.wb-e__b { display: grid; gap: 6px; min-width: 0; }
.wb-e__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wb-e__m { font-size: 12px; color: var(--ink-muted); }
.wb-e__m b { color: var(--ink); }
.wb-q--code { font-family: var(--font-mono); padding: 8px 10px; border-radius: 10px; background: var(--surface-2); }
.wb-e--decide .wb-q--code { box-shadow: inset 3px 0 0 var(--running); }
.wb-foot { font-size: 12px; color: var(--ink-muted); margin-top: var(--space-3); }
.wb-kind { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; color: var(--ink); white-space: nowrap; }
.wb-by { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; color: var(--ink-muted); white-space: nowrap; }
.wb-by.tone-running, .wb-by.tone-parked, .wb-by.tone-ok, .wb-by.tone-attention { color: var(--tone-ink); }
.wb-q { font-size: 13px; line-height: 19px; color: var(--ink); overflow-wrap: anywhere; }
.wb-bh { display: grid; gap: 8px; margin-bottom: var(--space-4); }
.wb-ver { display: flex; flex-wrap: wrap; gap: 6px; }
.wb-by { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.wb-by .ic { flex: none; margin-top: 2px; }
.wb-board { display: grid; gap: var(--space-3); padding: var(--space-4); border-radius: var(--radius-md); box-shadow: inset 0 0 0 1.5px var(--line-strong); background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px); background-size: 14px 14px; }
.wb-stats { gap: var(--space-3); }
.wb-stat { display: grid; gap: 2px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.wb-stat b { font-size: 28px; line-height: 32px; font-weight: 800; letter-spacing: -0.02em; color: var(--ink); }
.wb-stat span { font-size: 12px; color: var(--ink); }
.wb-stat small, .wb-block__h small { font-size: 11px; color: var(--ink-muted); font-weight: 500; }
.wb-block { display: grid; gap: 10px; padding: 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.wb-block__h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 13px; font-weight: 700; color: var(--ink); }
.wb-chart { display: grid; gap: 6px; }
.wb-chart__s { width: 100%; height: 120px; display: block; }
.wb-ch__g { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.wb-ch__dep { stroke: var(--attention); stroke-width: 2; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
.wb-ch__l { fill: none; stroke: var(--ink-faint); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.wb-ch__l--hi { stroke: var(--running); stroke-width: 3; }
.wb-chart__lab { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px; color: var(--ink-muted); }
.wb-ch__k { display: inline-flex; align-items: center; gap: 6px; }
.wb-ch__k::before { content: ""; width: 14px; height: 3px; border-radius: 2px; background: var(--ink-faint); }
.wb-ch__k--hi::before { background: var(--running); height: 4px; }
.wb-ch__k--dep::before { background: var(--attention); }
.wb-chart__ax { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
.wb-hyp { display: grid; gap: 8px; }
.wb-hyp li { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px; align-items: start; }
.wb-hyp li > .badge { justify-self: start; }
.wb-hyp div { display: grid; font-size: 13px; color: var(--ink); }
.wb-hyp div span { font-size: 12px; color: var(--ink-muted); }
.wb-note p:last-child { font-size: 13px; line-height: 20px; color: var(--ink); }
.wb-bact { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-3); }
.wb-src { display: grid; gap: var(--space-4); }
.wb-src li { display: grid; gap: 6px; }
.wb-src__h { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.wb-src__r { margin-left: auto; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wb-sp { width: 100%; height: 28px; display: block; }
.wb-sp polyline { fill: none; stroke: var(--running); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.wb-warn { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--attention-ink); }
.wb-warn .ic { flex: none; margin-top: 2px; }
.wb-models { display: grid; gap: var(--space-4); }
.wb-models > li { display: grid; gap: 8px; padding-bottom: var(--space-4); border-bottom: 1px solid var(--line); }
.wb-m__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
.wb-m__h .chip, .wb-m__h .wb-by { margin-left: auto; }
.wb-m__k { font-size: 12px; font-weight: 700; color: var(--ink); }
.wb-mstats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.wb-mstats span { display: grid; gap: 2px; padding: 8px 10px; border-radius: 12px; background: var(--surface-2); font-size: 11px; color: var(--ink-muted); }
.wb-mstats b { font-size: 16px; color: var(--ink); font-variant-numeric: tabular-nums; }
.wb-dist { width: 100%; display: block; }
.wb-d1 { fill: var(--running); } .wb-d2 { fill: var(--parked); } .wb-d3 { fill: var(--surface-3); }
.wb-dk { margin-top: 0; }
.wb-k { display: inline-block; width: 10px; height: 10px; border-radius: 3px; }
.wb-k1 { background: var(--running); } .wb-k2 { background: var(--parked); } .wb-k3 { background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--line-strong); }
.wb-pol { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-4); padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.wb-pol .ic { flex: none; margin-top: 2px; }
.wb-pol b { color: var(--ink); }
.wb-shadow { display: grid; gap: 10px; margin-top: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); box-shadow: inset 0 0 0 1.5px var(--line-strong); background: repeating-linear-gradient(135deg, transparent 0 10px, var(--surface-2) 10px 11px); }
.wb-shadow__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; color: var(--ink); }
.wb-shadow__ok { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; font-weight: 650; color: var(--ok-ink); }
.wb-shadow__b { display: grid; grid-template-columns: minmax(0, 360px) minmax(0, 1fr); gap: var(--space-5); align-items: center; }
.wb-sec { display: grid; gap: 10px; margin-bottom: var(--space-5); }
.wb-sec__h { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.wb-sec__h p { display: grid; font-size: 12px; color: var(--ink-muted); }
.wb-sec__h p b { font-size: 15px; color: var(--ink); }
.wb-col { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.wb-props { display: grid; gap: 10px; }
.wb-prop { display: grid; gap: 8px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 3px 0 0 var(--parked); }
.wb-prop--notes { box-shadow: inset 3px 0 0 var(--line-strong); }
.wb-prop__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; color: var(--ink); }
.wb-prop__why { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.wb-prop__act { display: flex; gap: 8px; flex-wrap: wrap; }
.wb-prop .wb-block { background: var(--surface); }
.wb-prop .wb-q--code { background: var(--surface); }
.wb-notet { font-size: 13px; line-height: 20px; color: var(--ink); }
.wb-roles { display: grid; gap: 8px; }
.wb-roles li { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.wb-roles li > .chip { justify-self: start; }
.wb-roles b { color: var(--ink); }
.wb-dok { fill: var(--ok); } .wb-dno { fill: var(--attention); }
.wb-kok { background: var(--ok); } .wb-kno { background: var(--attention); }
.wb-kprop { background: var(--parked); } .wb-kq { background: var(--ink-faint); } .wb-kc { background: transparent; box-shadow: inset 0 -2px 0 var(--failed); border-radius: 0; }
.wb-run { display: grid; gap: 6px; }
.wb-run__s { width: 100%; height: 90px; display: block; }
.wb-run__cap { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
.wb-run__l { fill: none; stroke: var(--ok); stroke-width: 3; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.wb-run__m { width: 100%; display: block; }
.wb-rk--prop { fill: var(--parked); } .wb-rk--dec { fill: var(--running); } .wb-rk--q { fill: var(--ink-faint); }
.wb-mstats--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: var(--space-3); }
@media (max-width: 760px) { .wb-shadow__b { grid-template-columns: minmax(0, 1fr); } .wb-shadow__ok { margin-left: 0; } .wb-mstats--2 { grid-template-columns: minmax(0, 1fr); } .wb-roles li { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
@media (max-width: 1280px) { .wb-chain { grid-template-columns: minmax(0, 1fr); gap: 0; } .wb-arrow { padding: 4px 0; transform: rotate(90deg); } }
@media (max-width: 760px) {
  .tr-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .titlebar__end { flex-wrap: wrap; }
  .wb-filt { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .wb-e { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .wb-stats { grid-template-columns: minmax(0, 1fr); }
  .wb-hyp li { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
"""

if __name__ == "__main__":
    write("WatchBoard", card_marker("Planned for 5.0.0", 4470, 1440, "A watch rule's board: why each finding did what it did, every query and decision, Jev acting in the job and in shadow at the gate, and a board jobs propose and you adopt"),
          "shop-5xx watch board", page(), CSS)
    readme("WatchBoard", """
A watch rule's own page. It shows why each finding did what it did, every query and decision on the way, and a board that gets better over time: jobs propose changes, and a person adopts them. It extends #735 (proposed in #743) and keeps #735's rules: no agent lives on, and nothing writes code without a person.

**How a person uses it.**
- **The numbers.** Findings in 24 hours and what held them, the jobs that ran, how often Jev in shadow agreed with what happened, and the spend of jobs and decisions apart.
- **Why this finding started a job.** Four stages in a row, each with what it saw and what it concluded:
  1. **Stream.** A signed finding, its count and fingerprint, and how many redacted samples were kept.
  2. **Rules.** Every rule it passed, at no cost and with no model. The rules decide.
  3. **Job.** The read-only triage job: its log queries, its decisions with Jev's `decide` tool, the board proposals it made while it ran, and its spend against its cap.
  4. **Outcome.** Here, a follow-up that changes code, so it waits for a person.

  Under the stages, a hatched **shadow** strip shows what Jev at the gate would have chosen: the probability of each option, whether that agrees with what happened, and its 30-day record. A switch picks another finding.
- **The board, in two parts.**
  - **Adopted.** The blocks the operator adopted, as reviewed config. Each job re-runs the adopted queries on fresh data and refreshes the numbers. Versions show who adopted what, and the operator can go back a version or clear the board.
  - **Proposed.** What this run proposed, each with a reason: add a chart with its query, or remove a block. *Adopt* opens a safe preview that names the query, the only endpoint it can reach, the new version and the undo. It is audited as `board-adopt`.
  - **Run notes.** Hypotheses and a note, kept with this run only, as plain text.
- **How the job went.** The run's spend against its cap, with board proposals, decisions and queries marked as they happened. Under it: the hourly rate and how long the cap lasts at that rate, how much of the context was used and whether it was compacted, and whether recovery was armed.
- **Every stream, query and decision.** One log, newest first:
  - **Who acted:** the collector, the rules, Jev in shadow, or the job.
  - **The entry:** the query or question as plain text, the result, and the cost and time.
  - **Used for:** what each entry fed.
  - **Filters:** decisions, log queries, board proposals, model turns, and streams and rules.
- **Streams.** Each source with a 24-hour sparkline and what happened to its findings, the log store the jobs read, and a source doctor says is broken.
- **Decision models.**
  - **Jev:** pinned to a dated snapshot. It acts inside the job as the `decide` tool and runs in shadow at the gate. The card shows its calls, spend and typical time, its 30-day shadow record (agreed 9, disagreed 2, and what the misses were), and a warning that its input leaves the EU.
  - **The triage model:** reasons and queries inside the job.
  - **Acting at the gate:** off, set by hand in triggers.json.

**Panels.** `p-wb-findings`, `p-wb-jobs`, `p-wb-shadow`, `p-wb-spend`, `p-wb-chain`, `p-wb-board`, `p-wb-run`, `p-wb-streams`, `p-wb-trace`, `p-wb-models`.

**The server provides.**
- The finding, its rule checks and cooldown state.
- Each decision: model and snapshot, the state's fields (fields and counts only at the gate), the questions with their options, probabilities, confidence, cost and time.
- Each query: the store, the text as written, rows and time, recorded by a read-only query tool.
- The adopted board's versions, and each run's proposals and notes.
- The job's spend over time, its cap, its context use and whether it was compacted, and recovery state.
- Per source: deliveries and what happened to them.
- The shadow record: what the gate would have chosen beside what happened.

**Who sees what.** Query text, decision state, run notes and samples are operator only, like transcripts. A viewer sees the counts, the rule checks, which option each decision chose with its probabilities, the stages and the adopted board's numbers. Only an operator adopts, goes back or clears.

**Why it works this way.**
- **No agent lives on.** Each finding is one fresh job with its reserve taken before it starts. Only what a person adopted carries over, and agent text never does: run notes stay with their run, as plain text, and are never shown to the next job.
- **The rules decide at the gate**, with no model and at no cost.
- **Decisions earn their place.** Jev acts only inside the read only job. At the gate it runs in shadow: it records what it would have chosen and changes nothing, until its record says it helps. It sees fingerprint fields and counts only.
- **If it is allowed to act at the gate later**, it would investigate at confidence 0.70 or more, ignore at 0.90 or more, and otherwise file an issue for a person. It would run as a one-call job, so the host still never calls a model. That is set by hand in triggers.json, once the shadow results earn it.
- **Log text stays in the job.** The gate sees fingerprint fields and counts. Sample text reaches only the read only job.
- **Jobs propose, a person adopts.** The adopted board is reviewed config. A block's query reaches only the bundle's endpoints, every later job runs it on fresh data, and the console draws every block itself: no scripts, styles, images or outside links, never agent HTML.
- **Ready for long runs.** Each decision and query is kept as a small record of its own, not read back from the transcript, so a run of hours keeps its first query too. Proposals appear while the job runs, and the cap projection updates every 30 seconds, so a job of six hours shows the same view, live.
- **Jev gives no reasons.** Decisions show the state the model saw, the question and its options, and the probabilities, and that is the why. Jev answers yes or no, a choice, or a score, with no prose.
- **A person before code.** A follow-up that writes code becomes an issue or an approval; nothing writes code until someone with write access says so.

**Fixture note.** This is a planned screen, and all of it is sample:
- the finding and the job are the Watch page's (checkout TimeoutError, `local-7f21`, `acme/shop#88`);
- Jev's model id, dated snapshot, answer shapes and input-only price follow its Decisions API, and the note on EU routing follows its OpenRouter page;
- the queries, probabilities, proposals, versions, shadow record and spend are illustrative.
""")
    print("watch board written")
