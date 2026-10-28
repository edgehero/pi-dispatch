"""Runs and Run screens on the Pulse kit: RunsScreen (1440), RunsPhone (390), RunLive (1440), RunEnded (1440)."""
from pulse import *

PROJ = {"acme/web": "web", "acme/api": "api", "acme/billing": "billing", "acme/billing-ui": "billing", "local:site": "ops", "local:pm": "ops"}
def proj_of(target):
    return PROJ.get(target.split("#")[0], "ops")

# ---------------- fixture: the runs list (last 24 hours, newest first) ----------------
# (when, job, target, flow, host, venue, outcome, model, tokens, cost, cap, reason)
RUNS = [
    ("Thursday 8 October", None),
    ("15:30", "gh-e9a0", "acme/billing#260", "fix", "build3", "podman", "refused", "claude-sonnet-5-5", "-", "not metered", "-",
     "Refused: this deployment runs jobs behind an egress policy, and the egress proxy is not running."),
    ("15:25", "gh-a91e", "acme/web#422", "fix", "mini2", "openshell", "completed", "claude-sonnet-5-5", "85,577", "$0.17", "$2.00", ""),
    ("15:13", "gh-2f6a", "acme/api#131", "triage", "mini1", "local", "awaiting", "claude-sonnet-5-5", "125,448", "$0.21", "$2.00",
     "Stopped: the agent asked a question on acme/api#131 and waits for an answer."),
    ("15:12", "gh-9575", "acme/web#490", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "150,126", "$0.24", "$2.00", ""),
    ("15:10", "gh-f0c2", "acme/web#491", "fix", "mini1", "local", "failed", "claude-sonnet-5-5", "85,577", "$0.17", "$2.00",
     "Failed before it started: the container runtime never handed control to the job, so nothing ran."),
    ("14:48", "gh-ebd7", "acme/billing#259", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "186,938", "$0.36", "$2.00", ""),
    ("14:39", "gh-4add", "acme/web#489", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "139,830", "$0.21", "$2.00", ""),
    ("14:34", "gh-a3ac", "acme/web#487", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "98,910", "$0.17", "$2.00", ""),
    ("14:17", "gh-8251-r2", "acme/web#408", "frontend-fix", "mini2", "local", "completed", "claude-sonnet-5-5", "212,921", "$0.36", "$2.00", ""),
    ("14:09", "gh-bd09", "acme/web#488", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "86,371", "$0.17", "$2.00", ""),
    ("14:06", "gh-e12d", "acme/web#486", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "196,050", "$0.30", "$2.00", ""),
    ("13:55", "gh-8251-r1", "acme/web#408", "frontend-fix", "mini1", "local", "completed", "claude-sonnet-5-5", "167,330", "$0.29", "$2.00", ""),
    ("13:49", "gl-9a2c", "acme/billing-ui!405", "review", "mini2", "local", "completed", "claude-sonnet-5-5", "116,750", "$0.18", "$2.00", ""),
    ("12:43", "gh-03a9", "acme/api#122", "fix", "mini2", "local", "completed", "claude-sonnet-5-5", "120,476", "$0.25", "$2.00", ""),
    ("12:39", "gh-7cdf", "acme/billing#258", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "254,648", "$0.40", "$2.00", ""),
    ("12:23", "gh-98f4", "acme/web#657", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "196,085", "$0.30", "$2.00", ""),
    ("11:05", "gh-985d", "acme/api#121", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "104,203", "$0.16", "$2.00", ""),
    ("10:59", "gh-4a7e", "acme/billing#290", "fix", "build3", "podman", "cancelled", "claude-sonnet-5-5", "-", "not metered", "$2.00",
     "Stopped: cancelled before the job spent anything."),
    ("10:44", "gl-021a", "acme/billing-ui!404", "review", "mini2", "local", "completed", "claude-sonnet-5-5", "74,575", "$0.14", "$2.00", ""),
    ("10:43", "gh-7813", "acme/billing#257", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "204,342", "$0.32", "$2.00", ""),
    ("09:45", "gh-444c", "acme/api#120", "fix", "mini2", "local", "completed", "claude-sonnet-5-5", "152,220", "$0.30", "$2.00", ""),
    ("09:29", "gh-52a8", "acme/billing#256", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "255,452", "$0.43", "$2.00", ""),
    ("08:58", "gh-b0bd", "acme/web#656", "fix", "mini1", "local", "completed", "claude-sonnet-5-5", "53,389", "$0.10", "$2.00", ""),
    ("03:11", "nightly-tidy", "local:site", "tidy", "mini1", "local", "completed", "kimi-for-coding", "185,186", "plan:kimi", "$2.00", ""),
    ("Wednesday 7 October", None),
    ("17:41", "gh-476b", "acme/billing#254", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "207,067", "$0.41", "$2.00", ""),
    ("17:15", "gh-c3f8", "acme/billing#253", "fix", "build3", "podman", "completed", "claude-sonnet-5-5", "117,130", "$0.31", "$2.00", ""),
    ("16:52", "gl-af91", "acme/billing-ui!403", "review", "mini2", "local", "completed", "claude-sonnet-5-5", "104,321", "$0.18", "$2.00", ""),
]

def outcome_cell(oc, reason):
    if oc == "completed":
        b = '<span class="badge tone-idle">' + ic("done") + "Completed</span>"
    else:
        b = badge(oc)
    r = f'<span class="reason">{E(reason)}</span>' if reason else ""
    return b + r

def row(r):
    when, job, tgt, flow, host, ven, oc, model, tok, cost, cap, reason = r
    p = proj_of(tgt)
    tgt_cell = f'<a href="#">{E(tgt)}</a>' if "#" in tgt else f'<span class="muted">{E(tgt)}</span>'
    job_label = "tidy" if job == "nightly-tidy" else job
    job_cell = f'<a href="#" title="repeat:nightly-tidy">{E(job_label)}</a>' if job == "nightly-tidy" else f'<a href="#">{E(job)}</a>'
    quiet = " runs-quiet" if oc == "completed" else ""
    return f"""<tr class="runs-row{quiet}">
  <td class="when c-when" data-l="Ended">{when}</td>
  <td class="id c-job">{job_cell}</td>
  <td class="tgt c-tgt">{tgt_cell}</td>
  <td class="c-proj">{tag(p)}</td>
  <td class="c-flow hide-phone">{E(flow)}</td>
  <td class="c-host" data-l="Host">{E(host)}</td>
  <td class="c-venue hide-phone">{venue(ven)}</td>
  <td class="c-out wide">{outcome_cell(oc, reason)}</td>
  <td class="c-model hide-phone">{E(model)}</td>
  <td class="num c-tok hide-phone">{tok}</td>
  <td class="num c-cost" data-l="Cost">{cost}</td>
  <td class="num c-cap hide-phone">{cap}</td>
</tr>"""

def table():
    body = []
    for r in RUNS:
        if r[1] is None:
            body.append(f'<tr class="runs-day"><td colspan="12" class="wide">{r[0]}</td></tr>')
        else:
            body.append(row(r))
    head = "".join(f"<th{(' class=num' if h in ('Tokens', 'Cost', 'Job cap') else '')}>{h}</th>" for h in
                   ["Ended", "Job", "Target", "Project", "Flow", "Host", "Venue", "Outcome", "Model", "Tokens", "Cost", "Job cap"])
    return f"""<section class="card card--flush" id="p-runs" data-panel aria-labelledby="runs-h">
  <div class="card__head"><h2 id="runs-h">27 runs</h2><span class="card__sub">newest first, times UTC</span>
    <span class="end"><div class="seg" role="group" aria-label="Show"><button aria-pressed="true">All outcomes</button><button aria-pressed="false">Only problems</button></div></span></div>
  <div class="tbl-wrap"><table class="tbl tbl--stack runs-tbl"><caption class="sr">Runs that ended in the last 24 hours</caption>
    <thead><tr>{head}</tr></thead>
    <tbody>{''.join(body)}</tbody>
  </table></div>
  <div class="tbl-foot"><span>Showing 27 of 27 in the last 24 hours, 50 per page · {ic("fleet", "ic ic--sm")} read from 3 hosts through the fleet's run mirror</span>
    <span class="pager"><a class="btn btn--sm" href="#" aria-disabled="true">Newer runs</a><a class="btn btn--sm" href="#">Older runs</a></span></div>
</section>"""

def kpis():
    cells = [("", "", "27", "runs ended"), ("idle", "done", "23", "completed"), ("failed", "failed", "1", "failed"),
             ("refused", "refused", "1", "refused"), ("parked", "parked", "1", "awaiting input"), ("idle", "cancel", "1", "cancelled"),
             ("", "spend", "$6.13", "metered spend")]
    out = []
    for tone, icon, n, label in cells:
        t = f" tone-{tone}" if tone else ""
        g = ic(icon, "ic ic--sm") if icon else ""
        out.append(f'<a class="runs-k{t}" href="#"><b>{n}</b><span>{g}{label}</span></a>')
    return f'<section class="card runs-kpis" id="p-summary" data-panel aria-label="Summary">{"".join(out)}</section>'

def filters():
    projs = [("All", "27"), ("web", "11"), ("api", "4"), ("billing", "11"), ("ops", "1")]
    proj = ('<div class="projseg" role="group" aria-label="Project"><span class="projseg__l">Project</span>'
            + "".join(f'<button type="button" aria-pressed="{"true" if p == "All" else "false"}">{p if p == "All" else tag(p)}<b>{n}</b></button>' for p, n in projs)
            + "</div>")
    def sel(label, val="Any"):
        return f'<button class="fpill" type="button" aria-haspopup="listbox">{label}: <b>{val}</b>{ic("chev", "ic ic--sm")}</button>'
    return f"""<section class="runs-filters" id="p-filters" data-panel aria-label="Filters">
  <div class="filterbar filterbar--collapsible">
    <label class="search runs-search">{ic('search')}<span class="sr">Search</span><input type="search" placeholder="Repository, target or job id"></label>
    <button class="fpill filterbar__toggle" type="button" aria-expanded="false">{ic('config', 'ic ic--sm')}Filters <b>(1)</b></button>
    {proj}
    {sel("Outcome")}{sel("Reason")}{sel("Flow")}{sel("Trigger")}{sel("Host")}{sel("Venue")}{sel("Forge")}{sel("Model")}
  </div>
  <p class="runs-applied"><span class="chip">Window: last 24 hours<button class="runs-x" type="button" aria-label="Remove filter: window">{ic('failed', 'ic ic--sm')}</button></span><a class="link" href="#">Clear filters</a></p>
</section>"""

RUNS_STYLE = """
.runs-kpis { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; padding: 8px; }
.runs-k { display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; border-radius: 18px; text-decoration: none; }
.runs-k:hover { background: var(--surface-2); }
.runs-k b { font-size: 28px; line-height: 32px; font-weight: 800; letter-spacing: -0.02em; color: var(--tone-ink, var(--ink)); }
.runs-k.tone-idle b { color: var(--ink); }
.runs-k span { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.runs-k span .ic { color: var(--tone-ink, var(--ink-muted)); }
.runs-filters { display: grid; gap: 10px; }
.runs-search { flex: 1 1 320px; max-width: 420px; }
.runs-applied { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.runs-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-right: -4px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ink-muted); cursor: pointer; }
.runs-tbl td.c-out { min-width: 240px; }
.runs-tbl .c-model { color: var(--ink-muted); white-space: nowrap; font-size: 12px; }
.runs-tbl .c-flow, .runs-tbl .c-host, .runs-tbl .tgt { white-space: nowrap; }
.runs-tbl .c-cost, .runs-tbl .c-cap, .runs-tbl .c-tok { color: var(--ink-muted); }
.runs-tbl tr:not(.runs-quiet):not(.runs-day) .c-cost { color: var(--ink); }
.runs-quiet .id a { font-weight: 600; }
.runs-day td { padding: 14px var(--space-5) 8px !important; background: var(--surface-2); font-size: 12px; font-weight: 700; color: var(--ink-muted); }
.runs-tbl tbody tr.runs-day:hover td { background: var(--surface-2); }
@media (max-width: 760px) {
  .runs-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 4px; gap: 0; }
  .runs-k { padding: 10px; }
  .runs-k b { font-size: 22px; line-height: 26px; }
  .runs-k:nth-child(2), .runs-k:nth-child(n+6) { display: none; }
  #p-runs.card--flush { padding: 0; }
  #p-runs .card__head { padding: var(--space-4) var(--space-4) 0; }
  .runs-search { max-width: none; }
  .runs-tbl tr.runs-row { grid-template-columns: minmax(0, 1fr) auto; }
  .runs-tbl .c-job { order: 1; } .runs-tbl .c-when { order: 2; text-align: right; }
  .runs-tbl .c-out { order: 3; grid-column: 1 / -1; min-width: 0; }
  .runs-tbl .c-tgt { order: 4; } .runs-tbl .c-proj { order: 5; text-align: right; }
  .runs-tbl .c-host { order: 6; font-size: 12px; color: var(--ink-muted); } .runs-tbl .c-cost { order: 7; font-size: 12px; text-align: right; }
  .runs-tbl .c-when[data-l]::before { content: none; }
  .runs-tbl .reason { max-width: none; }
  .runs-tbl tr.runs-day { display: block; padding: 0; }
  .runs-tbl tr.runs-day td { padding: 10px var(--space-4) !important; }
  .tbl-foot { flex-wrap: wrap; }
  .tbl-foot .pager { margin-left: 0; }
}
"""

def runs_page():
    inner = filters() + kpis() + table()
    return shell("Runs", inner, "Runs", sub="Every run that ended, with what happened and why.",
                 end=f'<button class="fpill" type="button">Window: <b>24 hours</b>{ic("chev", "ic ic--sm")}</button>')

# ---------------- RunLive: gh-b3d7 ----------------
ISSUE = "the checkout page double-charges when the user presses Pay twice"

def run_title(jid):
    return f'<span class="run-id">{E(jid)}</span>'

def live_progress(recent=True):
    """The Progress card. The phone (recent=False) leaves out the recent steps: the transcript below shows them."""
    steps = [("edit", "done", "ok", "-", "15:38"), ("bash", "failed", "error", "2.3 s", "15:38"), ("read", "done", "ok", "0.1 s", "15:37")]
    rows = "".join(f'<li class="rowpill tone-{"ok" if s == "done" else "failed"}">{ic(s, "ic ic--sm")}<span class="code">{t}</span>'
                   f'<span class="run-st tinted">{w}</span><span class="end"><span>{d}</span><span class="run-at">{at}</span></span></li>' for t, s, w, d, at in steps)
    body = f"""<div class="run-prog">
    <div class="run-big"><p class="kpi"><b class="run-tc">00:12:19</b><span>elapsed since 15:27 UTC</span></p></div>
    <dl class="run-stats">
      <div><dt>Turn</dt><dd><span><b>7</b> of 40</span></dd></div>
      <div><dt>Steps</dt><dd><span><b>12</b>, 1 failed</span></dd></div>
      <div class="tone-running"><dt>Running now</dt><dd><span class="dot"></span><b class="code">bash</b> for 1m 04s</dd></div>
    </dl>
  </div>
  <p class="run-phase">Phase 2 of 4</p>
  {phases(["survey", "migrate the schema", "verify", "report"], 1, 3, 10)}
  <p class="run-note">{ic('runs', 'ic ic--sm')}Note from the run: three of ten tables migrated</p>""" + ("""
  <p class="run-sub">Recent steps</p>
  <ul class="rows">""" + rows + "</ul>" if recent else "")
    return card("Progress", body, end=chip("live", "running", "running"), id_="p-progress")

def live_entries():
    issue = f'<p><b>Issue acme/web#415:</b> {E(ISSUE)}.</p><p class="muted">Labels: pi, bug</p>'
    return [
        tx("user", "15:27:30", issue),
        tx("assistant", "15:27:38", "<p>I'll start by surveying the checkout flow and the payment handler to find where a second submit is not guarded.</p>"),
        tx("call", "15:27:48", '<details><summary>arguments</summary><pre>{"path":"src/checkout/PayButton.tsx"}</pre></details>', label="read"),
        tx("result", "15:27:49", '<details><summary>result, 142 lines</summary><pre>export function PayButton({ onPay, amount }) {\n  return &lt;button onClick={onPay}&gt;Pay {amount}&lt;/button&gt;\n…</pre></details>', label="read", tone="ok", trunc=True),
        tx("call", "15:29:08", '<details><summary>arguments</summary><pre>{"command":"npx vitest run src/checkout/PayButton.test.tsx"}</pre></details>', label="bash"),
        tx("error", "15:29:10", '<details open><summary>result</summary><pre>1 failed: charges twice when Pay is pressed twice\nexpected 1 call to /api/pay, received 2</pre></details>', label="bash", tone="failed"),
        tx("assistant", "15:29:48", "<p>The test confirms the double submit. I'll disable the button while the payment request is in flight and add an idempotency key on the server side.</p>"),
        tx("call", "15:30:03", '<details><summary>arguments</summary><pre>{"path":"src/checkout/PayButton.tsx","old":"onClick={onPay}","new":"onClick={submit} disabled={pending}"}</pre></details>', label="edit"),
        tx("result", "15:30:04", '<p class="muted">Edited 1 file.</p>', label="edit", tone="ok"),
        tx("call", "15:38:28", '<details><summary>arguments</summary><pre>{"command":"npm run migrate -- --step 4"}</pre></details><p class="run-waiting"><span class="dot tone-running"></span>Running for 1m 04s, no result yet</p>', label="bash", tone="running"),
    ]

def live_transcript():
    entries = live_entries()
    end = ('<div class="seg" role="group" aria-label="Show"><button aria-pressed="true">All</button><button aria-pressed="false">Messages</button><button aria-pressed="false">Tools</button></div>'
           + '<button class="btn btn--sm" type="button" aria-pressed="true">' + ic("chev", "ic ic--sm") + 'Following</button>')
    body = f'<ol class="tx" aria-live="polite">{"".join(entries)}</ol>'
    return card("Live transcript", body, end=end, sub="streamed from mini1 as it happens", id_="p-transcript")

def steer_card():
    body = f"""<div class="field"><label for="steer">Steer now</label>
    <textarea id="steer" class="textarea" rows="3" placeholder="Reaches the agent while it works"></textarea>
    <p class="field__hint">Delivered into the running turn.</p></div>
  <div class="run-actrow"><button class="btn btn--primary" type="button">{ic('steer', 'ic ic--sm')}Preview steer</button></div>
  <div class="field"><label for="follow">Follow-up</label>
    <textarea id="follow" class="textarea run-short" rows="2" placeholder="Delivered after the current turn"></textarea></div>
  <div class="run-actrow"><button class="btn" type="button">Queue follow-up</button></div>
  <p class="run-sub">Inbox</p>
  <ul class="rows">
    <li class="rowpill tone-idle">{ic('clock', 'ic ic--sm')}<span class="run-inbox"><b>Follow-up</b> Also add a test for the double submit.</span><span class="end"><span class="run-at">queued 15:36</span><a class="rowpill__act" href="#">Withdraw</a></span></li>
    <li class="rowpill tone-ok">{ic('done', 'ic ic--sm')}<span class="run-inbox"><b>Steer</b> Keep the button label unchanged.</span><span class="end"><span class="run-at">delivered 15:31</span></span></li>
  </ul>"""
    return card("Steer this run", body, sub="ops can message the agent", id_="p-chat")

def chat_card():
    body = f"""<p class="run-text">Open this run's session in your own pi. Run it on a host that holds the session store.</p>
  {cmd("pi-dispatch chat gh-b3d7")}"""
    return card("Terminal chat", body, id_="p-terminal")

def live_facts():
    pairs = [("Target", f'<a class="link" href="#">acme/web#415</a>'), ("Project", tag("web")), ("Flow", "fix"), ("Host", "mini1"),
             ("Venue", venue("local")), ("Model", "anthropic / claude-sonnet-5-5"), ("Queue", '<span class="code">pi-jobs@mini1</span>'),
             ("Started", "15:27 UTC")]
    return card("Run", facts(pairs, 1), id_="p-run")

def run_live_page():
    sub = f'{tag("web")} <a class="link" href="#">acme/web#415</a> <span class="muted">{E(ISSUE)}</span>'
    end = badge("running") + btn("Cancel run", "danger", "cancel", sm=False)
    main = f"""<div class="stack">{live_progress()}{live_transcript()}
  <p class="collapsed" id="p-record" data-panel>{ic('clock', 'ic ic--sm')}<b>Run record, tokens, resources, session and chain</b> are written when the run ends.</p></div>"""
    side = f'<div class="stack">{steer_card()}{chat_card()}{live_facts()}</div>'
    return shell("Runs", f'<div class="cols">{main}{side}</div>', run_title("gh-b3d7"), sub=sub, end=end, back="Runs")

# ---------------- RunLivePhone: the same run on a phone ----------------
def run_live_phone_page():
    """gh-b3d7 on a phone: its state first, then the phases, spend so far against the cap, the newest transcript
    entries with the rest one tap away, and Steer as the one action."""
    sub = f'{tag("web")} <a class="link" href="#">acme/web#415</a> <span class="muted">fix on mini1</span>'
    cost = card("Spend so far", f"""<p class="run-kv"><b>$0.14</b><span>metered, on claude-sonnet-5-5</span></p>
  {meterrow("Job cap", "so far", 0.14 / 2, "$0.14", "$2.00")}
  <p class="rlp-small">$2.00 was reserved when the run started; what is left is released at the end.</p>""", id_="p-cost")
    entries = live_entries()
    shown = "".join(entries[-2:])
    tr = card("Live transcript", f"""<ol class="tx" aria-live="polite">{shown}</ol>
  <p class="rlp-more">{btn(f"Show all {len(entries)} entries", "ghost", "chev")}</p>""", sub="the newest two", id_="p-transcript")
    steer = card("Steer this run", f"""<div class="field"><label for="steer">Steer now</label>
    <textarea id="steer" class="textarea" rows="3" placeholder="Reaches the agent while it works"></textarea></div>
  <div class="run-actrow">{btn("Preview steer", "primary", "steer", sm=False)}</div>
  <p class="rlp-small">{ic('clock', 'ic ic--sm')}Inbox: 1 follow-up queued, 1 steer delivered. <a class="link" href="#">Open</a></p>""", id_="p-chat")
    foot = card("Run", facts([("Venue", f'{venue("local")} on mini1'), ("Model", "claude-sonnet-5-5"), ("Started", "15:27 UTC")], 1)
                + f'<div class="run-actrow">{btn("Cancel run", "danger", "cancel")}</div>', id_="p-run")
    record = (f'<p class="collapsed" id="p-record" data-panel>{ic("clock", "ic ic--sm")}<b>Run record, tokens and resources</b> '
              'are written when the run ends.</p>')
    inner = f'<div class="stack">{live_progress(recent=False)}{cost}{tr}{steer}{foot}{record}</div>'
    return shell("Runs", inner, run_title("gh-b3d7"), sub=sub, end=badge("running"), back="Runs")

RUN_PHONE_STYLE = """
.rlp-small { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.rlp-more { margin-top: var(--space-3); }
#p-run .run-actrow { margin-bottom: 0; }
#p-progress .run-prog { gap: var(--space-4); }
"""

RUN_STYLE = """
.run-id { font-family: var(--font-mono); font-weight: 700; letter-spacing: -0.03em; }
.titlebar__sub .link { margin-left: 4px; }
.titlebar__sub .muted { margin-left: 4px; }
.run-prog { display: flex; align-items: flex-end; gap: var(--space-6); flex-wrap: wrap; margin-bottom: var(--space-4); }
.run-big .kpi { margin: 0; }
.run-tc { font-family: var(--font-mono); color: var(--running-ink); }
.run-stats { display: flex; gap: var(--space-6); margin: 0 0 4px; flex-wrap: wrap; }
.run-stats div { display: grid; gap: 2px; }
.run-stats dt { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.run-stats dd { margin: 0; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--ink-muted); }
.run-stats dd b { color: var(--ink); font-size: 16px; }
.run-stats .tone-running dd b { color: var(--running-ink); }
.run-phase { margin-bottom: 8px; font-size: 13px; font-weight: 650; color: var(--ink-muted); }
.run-note { display: flex; align-items: center; gap: 8px; margin-top: var(--space-4); padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.run-sub { margin: var(--space-4) 0 8px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.run-st { font-weight: 650; }
.run-at { font-size: 12px; color: var(--ink-faint); white-space: nowrap; }
.run-waiting { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; font-weight: 650; color: var(--running-ink); }
.run-actrow { display: flex; gap: 8px; margin: 8px 0 var(--space-4); }
.run-short { min-height: 64px; }
.run-inbox { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#p-chat .rows > li { min-width: 0; }
#p-chat .rowpill .end { flex: none; }
.run-inbox b { margin-right: 4px; }
.run-small .card__head { margin-bottom: var(--space-2); }
.run-small .card__head h2 { font-size: 14px; color: var(--ink-muted); }
.run-text { margin-bottom: var(--space-3); font-size: 13px; color: var(--ink-muted); }
.run-kv { display: flex; align-items: baseline; gap: 10px; margin-bottom: var(--space-3); }
.run-kv b { font-size: 32px; line-height: 36px; font-weight: 800; letter-spacing: -0.02em; }
.run-kv span { color: var(--ink-muted); font-size: 13px; }
.run-acts { display: grid; gap: var(--space-4); }
.run-act { display: grid; gap: 8px; }
.run-act__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-act__h p { flex: 1 1 200px; font-size: 13px; color: var(--ink-muted); }
.run-act__h p b { color: var(--ink); font-weight: 650; }
.run-act + .run-act { padding-top: var(--space-4); border-top: 1px solid var(--line); }
"""

# ---------------- RunEnded: gh-9575 ----------------
def ended_facts():
    pairs = [("Job", '<span class="code">gh-9575</span>'), ("Target", '<a class="link" href="#">acme/web#490</a>'), ("Forge", "github"),
             ("Flow", "fix"), ("Project", tag("web")), ("Trigger", "3, a comment with @pi"), ("Host", "mini1"), ("Venue", venue("local")),
             ("Model", "anthropic / claude-sonnet-5-5"), ("Turns", "14 of 40"), ("Attempt", "1"), ("Exit code", "0"),
             ("Started", "14:50 UTC"), ("Ended", "15:12 UTC"), ("Took", "22m"), ("Recovery", "none needed"),
             ("Read from", "mini1's run history")]
    return card("Run", facts(pairs, 2), id_="p-run")

def ended_tokens():
    body = f"""<p class="run-kv"><b>$0.24</b><span>metered, settled</span></p>
  {meterrow("Job cap", "this run", 0.24 / 2, "$0.24", "$2.00")}
  {facts([("Input tokens", "89,880"), ("Output tokens", "6,941"), ("Total tokens", "150,126"), ("Model calls", "14"),
          ("Reserved", "$2.00, released at the end"), ("Dollar window", "deployment, today")], 1)}"""
    return card("Tokens and dollars", body, id_="p-cost")

def ended_resources():
    body = f"""{meterrow("Peak memory", "of the size given", 812 / 2048, "812 MiB", "2,048 MiB")}
  {facts([("Size given", "2,048 MiB, 1 CPU (project)"), ("CPU time", "10m 02s"), ("Throttled", "0.0 s"), ("Out-of-memory kills", "0"),
          ("Peak processes", "118")], 1)}"""
    return card("Resources", body, id_="p-resources")

def ended_session():
    body = facts([("Session", "fresh: no earlier session for acme/web#490"), ("Kept", "yes, for the next run on this issue"),
                  ("Transcript", "214 KB in the session store"), ("Plan", "none")], 1)
    return card("Session and plan", body, id_="p-session")

def ended_actions():
    rerun_confirm = confirm("paid", "Re-run gh-9575",
        ["Runs <b>fix</b> on <b>acme/web#490</b> again with <b>claude-sonnet-5-5</b>",
         "Reserves up to <b>$2.00</b> against today's deployment cap (<b>$15.04 of $25.00</b> spent and held)",
         "Starts on the first host with a free <b>local</b> slot"],
        "cancel the new run from its page before it spends", "Re-run gh-9575")
    body = f"""<div class="run-acts">
  <div class="run-act"><div class="run-act__h"><p><b>Run it again.</b> Same issue, flow and model. You see the cost before it starts.</p>{btn("Preview a re-run", "paid", "rerun", sm=False)}</div>
    {rerun_confirm}</div>
  <div class="run-act"><div class="run-act__h"><p><b>Fork from a point.</b> Pick a transcript entry and, optionally, another model.</p>{btn("Fork from a point", "", "git", sm=False)}</div></div>
  <div class="run-act"><div class="run-act__h"><p><b>Continue in a terminal</b> as a fork of its session. The session's transcript goes to your pi's provider, unredacted.</p></div>{cmd("pi-dispatch chat gh-9575")}</div>
  <div class="run-act"><div class="run-act__h"><p><b>Open its workspace</b> on mini1, where it is kept.</p></div>{cmd("pi-dispatch sandbox gh-9575")}</div>
</div>"""
    return card("Actions", body, id_="p-actions")

def run_ended_page():
    sub = f'{tag("web")} <a class="link" href="#">acme/web#490</a> <span class="muted">fix on mini1, ended 15:12 UTC</span>'
    oc = outcome("completed", "Completed", "Finished in 22m on mini1",
                 "Merges are never automatic: review the pull request on the forge.",
                 btn("Open acme/web#490", "primary", sm=False) + btn("Preview a re-run", "paid", "rerun", sm=False))
    main = f'<div class="stack">{ended_facts()}{ended_actions()}</div>'
    side = f"""<div class="stack">{ended_tokens()}{ended_resources()}{ended_session()}
  <p class="collapsed" id="p-chain" data-panel>{ic('chain', 'ic ic--sm')}<b>Chain:</b> no parent and no child runs.</p></div>"""
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("gh-9575"), sub=sub, end=badge("completed"), back="Runs")

# ---------------- READMEs ----------------
README = {
"RunsScreen": """The Runs page lists every run that ended, newest first, with its outcome and the reason in one sentence, filtered by the closed lists people actually use.

**How a person uses it.** They narrow the list with the pills: project chips with counts, then Outcome, Reason, Flow, Trigger, Host, Venue, Forge and Model as closed lists, and one search pill for a repository, target or job id. Applied filters show as removable chips with Clear filters. The summary strip counts the window by outcome, and each count is a link that filters to it. In the table, completed runs are quiet: a grey badge and no sentence. Failed, refused, awaiting-input and cancelled runs carry their tone badge and a reason sentence with the shared prefixes. Only problems switches the table to those rows. Rows are grouped by day. Times are UTC.

**Panels.** `p-filters`, `p-summary`, `p-runs`.

**The server provides.** For each run record: when it ended, job id, target and forge link, project (from the projects config), flow, host, venue, outcome, the reason token turned into its catalog sentence, model, tokens, cost (or "not metered", or "plan:kimi") and job cap. It also provides counts per project and per outcome for the window, and pagination at 50 per page.

**Where the runs come from.** The footer names the source. The default is "read from 3 hosts through the fleet's run mirror". The other cases are the repo's notes:
- "Showing this host's runs: the fleet's run mirror is off."
- "Other hosts' runs could not be read; showing this host's."
- "Stopped after examining 2,000 runs; the next page continues from there."
- "The run history could not be read."
- "No run matches." (empty)
An unknown reason token shows as the token followed by "no explanation yet".

**Fixture note.** Rows are the fixture's runs list for the last 24 hours. The reason sentences come from the catalog style in #710. The cancelled sentence for gh-4a7e ("cancelled before the job spent anything") is sample copy. The fixture's run records put gh-e9a0 and gh-f0c2 in project api; this page follows the projects config instead (billing and web).""",
"RunsPhone": """The Runs page at 390px: the search stays visible and every other filter folds behind one Filters button, so the first screen is runs, not inputs.

**How a person uses it.** They search by repository, target or job id, or open Filters for the closed lists. The summary strip shows the four counts that matter. Each run is a stacked row:
- the job id and when it ended on top;
- the outcome badge and reason sentence across the full width;
- the target and project tag;
- the host and the cost.

Ids never break. Flow, venue, model, tokens and job cap are on the run page.

**Panels.** `p-filters`, `p-summary`, `p-runs`.

**The server provides.** The same data as the desktop page. The phone layout is CSS only (`tbl--stack`, `data-l` labels, `filterbar--collapsible`).

**Fixture note.** The same rows as RunsScreen.""",
"RunLive": """The live run page leads with progress and the live transcript; steering and the terminal command sit beside them, and everything that only exists after the run ends collapses to one line.

**How a person uses it.** The Progress card answers "how far along is it":
- elapsed timecode, turn 7 of 40, 12 steps with 1 failed;
- the tool running now and for how long;
- phase 2 of 4 as chapters, with 3 of 10 ticks on the current phase;
- the run's own note and the three most recent steps.

The live transcript streams below. Tool arguments and results fold; a failed result opens by default; the running call says how long it has run. The side column has the Steer card (steer now, queue a follow-up, an inbox with Withdraw), the terminal chat command and the run's facts. Cancel run is in the title bar, outlined until its confirm step.

**Panels.** `p-progress`, `p-transcript`, `p-record` (one line), `p-chat`, `p-terminal`, `p-run`.

**The server provides.** Progress events (turn, steps, running tool, phase names, item counts, note) and transcript entries with kind, time and a truncated flag, over the live stream. Whether the trigger sets `run.steer`, and the queued and delivered steering messages.

**Why it works this way.**
- A run whose trigger sets no run.steer takes no messages. Its side column then shows "This run takes no messages: its trigger sets no run.steer. Watch it here instead, or continue it in a terminal once it ends." in place of the Steer card (drawn on RunChatStates as *Not steer-armed*).

**Fixture note.** Progress, recent steps and the transcript's entry kinds and times are the fixture (gh-b3d7). The tool arguments, the read result, the test failure text, the bash command and the inbox messages are sample copy. The fixture run is not steer-armed, so on the fixture its Chat panel would show the not-armed sentence instead of the Steer card.""",
"RunEnded": """The page of a finished run leads with its outcome, what happened and the next step, then the facts, costs and resources, with the actions to run it again or continue it.

**How a person uses it.** The outcome banner says "Completed: finished in 22m on mini1" and reminds the reader that merges are never automatic. Its buttons open the issue and preview a re-run. *Run* lists the record's facts in plain words: trigger, turns against maxTurns, attempt, exit code and recovery. *Actions* explains each next step in a sentence:
- **Preview a re-run** (paid). Its confirm bar is shown open with the reservation against today's cap and an undo line.
- **Fork from a point** links to the fork view.
- **Terminal chat** and **sandbox** commands copy with one click.

The side column has tokens and dollars (job cap as a bar with the soft-hold line), resources (peak memory against the size given), session and plan, and the chain as one line.

**Panels.** `p-outcome`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.** The run record: facts, outcome, reason and next-step sentences from the catalog, tokens, cost class and reservation, resource figures, session state in words (not raw tokens such as "fresh (absent)"), chain, and whether a workspace was kept. It also says whether a re-run is allowed, so the button is hidden or disabled with its reason when the planner would refuse it.

**Fixture note.** gh-9575's target, flow, host, venue, model, tokens, cost, cap and end time are the fixture. The start time (14:50), turns, trigger, token split, model calls, resources, session wording and transcript size are sample values.""",
"RunLivePhone": """The live run page laid out for a phone: what the run is doing now comes first, and the one action is Steer.

**How a person uses it.**
- **Progress.** The elapsed timecode, turn 7 of 40, 12 steps with 1 failed, the tool running now and for how long, phase 2 of 4 with 3 of 10 ticks, and the run's own note. The recent steps are left to the transcript below.
- **Spend so far.** $0.14 metered against the $2.00 job cap, as a bar with the soft-hold line, and what was reserved at the start.
- **Live transcript.** The newest two entries (the edit result and the bash call still running), with *Show all 10 entries* to open the rest.
- **Steer this run.** The steer box and **Preview steer**, the one solid button on the page, and the inbox in one line.
- **The run**: venue, host, model and start, with **Cancel run**, outlined until its confirm; then the run record's one line.

**Panels.** `p-progress`, `p-cost`, `p-transcript`, `p-chat`, `p-run`, `p-record` (one line).

**The server provides.** RunLive's reads, plus the run's metered spend so far, which the live run page does not show today (the design asks for a per-run spend so long runs read the same as short ones).

**Who sees what.** An operator's phone. A viewer's phone shows RunViewer's content: numbers and tool names, no transcript text and no Steer.

**Fixture note.** gh-b3d7, acme/web#415, fix on mini1, the progress and the transcript entries are the fixture, as on RunLive. The $0.14 spent so far is sample."""
}

def write_readme(name):
    open(f"{ROOT}/{name}/README.md", "w").write(README[name] + "\n")

if __name__ == "__main__":
    write("RunsScreen", card_marker("Screens", 1900, 1440, "Runs: filters, a summary by outcome, and every run with its reason"),
          "Runs", runs_page(), RUNS_STYLE)
    write("RunsPhone", card_marker("Screens, phone", 3400, 390, "Runs at 390px: filters behind one button, runs as stacked rows"),
          "Runs on a phone", runs_page(), RUNS_STYLE)
    write("RunLive", card_marker("Screens", 1800, 1440, "A live run: progress and the live transcript first, steering beside them"),
          "Run gh-b3d7, live", run_live_page(), RUN_STYLE)
    write("RunEnded", card_marker("Screens", 1500, 1440, "A completed run: the outcome first, then facts, cost, resources and actions"),
          "Run gh-9575, completed", run_ended_page(), RUN_STYLE)
    write("RunLivePhone", card_marker("Phone", 1850, 390, "A live run on a phone: its state, phases, spend so far against the cap, the newest transcript entries and Steer"),
          "Run gh-b3d7, live, on a phone", run_live_phone_page(), RUN_STYLE + RUN_PHONE_STYLE)
    for n in README:
        write_readme(n)
    print("runs written")
