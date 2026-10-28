"""A dispatcher (#735, generalised): a sandbox that reads git changes and infra streams and only starts jobs and proposes
triggers, with the right flow and model. Two engines: a Jev loop (stateless decisions, runs continuously) or an LLM flow.
Pulse kit."""
from pulse import *
from gen_triggers import tabs as trigger_tabs
from gen_watchboard import probs

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'
def flow(f): return f'<span class="dp-flow">{ic("skill", "ic ic--sm")}{E(f)}</span>'

KPIS = f"""<div class="cards-4">
{card('Events read, 24h', '<p class="kpi"><b>1,227</b><span>from 4 inputs</span></p><p class="dp-kp">1,204 infra events from 3 streams · 23 merged commits for context</p>', id_="p-dp-events")}
{card('Decisions', '<p class="kpi"><b>186</b><span>by Jev</span></p><p class="dp-kp">$0.008 in 24h</p>', id_="p-dp-decisions")}
{card('Jobs started', '<p class="kpi"><b>3</b><span>of 10 a day</span></p><p class="dp-kp">$0.42 of its $3.00 a day · all from its list</p>', id_="p-dp-jobs")}
{card('Trigger proposals', '<p class="kpi"><b>2</b><span>wait for you</span></p><p class="dp-kp">both from today</p>', id_="p-dp-props")}
</div>"""

# ---- the boundary: what it reads, what it may do, what it never does ----
INPUTS = [("infra", "attention", "aws-cloudwatch", "alarms in eu-west-1, pushed through EventBridge, signed"),
          ("infra", "queue", "prod-logs", "Vector findings, as #735 describes"),
          ("infra", "box", "deploys", "deployments from the forges"),
          ("git", "git", "acme/web, acme/api", "merged commits on the default branch, read for context only")]
MAY = [("triage-incident", "claude-haiku-5-5", "read-only, on an alarm or finding"),
       ("db-health", "kimi-for-coding", "read-only, when the database looks involved")]

BOUNDARY = card("What it may do", f"""<div class="dp-bound">
  <div class="dp-col"><p class="dp-h">{ic('search', 'ic ic--sm')}It reads</p>
    <ul class="dp-in">{''.join(f'<li><span class="dp-k{" tone-running" if k == "infra" else ""}">{ic(i, "ic ic--sm")}{k}</span><div><b>{E(n)}</b><span>{E(d)}</span></div></li>' for k, i, n, d in INPUTS)}</ul></div>
  <div class="dp-col"><p class="dp-h">{ic('runs', 'ic ic--sm')}It may start</p>
    <ul class="dp-may">{''.join(f'<li>{flow(f)}<span class="code">{E(m)}</span><span class="dp-why">{E(w)}</span></li>' for f, m, w in MAY)}</ul>
    <p class="dp-caps"><span>{ic("slot", "ic ic--sm")}10 jobs a day</span><span>{ic("spend", "ic ic--sm")}$3.00 a day</span><span>{ic("clock", "ic ic--sm")}1 per target an hour</span></p>
    <p class="dp-h dp-h2">{ic('edit', 'ic ic--sm')}It may propose</p>
    <p class="dp-p">New or tuned watch rules, for you to adopt.</p>
    <p class="dp-off">{ic('pause', 'ic ic--sm')}<span><b>Apply proposals without me: off.</b></span></p></div>
</div>""", sub="the sandbox: set by hand in triggers.json, like any trigger", id_="p-dp-bound")

# ---- the two engines ----
ENGINES = card("Engine", f"""<div class="seg dp-seg" role="group" aria-label="Engine"><button aria-pressed="true">{ic('spend', 'ic ic--sm')}Jev loop</button><button aria-pressed="false">{ic('runs', 'ic ic--sm')}LLM flow</button></div>
<div class="dp-eng">
  <div class="dp-e dp-e--on">
    <p class="dp-e__h"><b>Jev loop</b><span class="badge tone-running">{ic('running')}running for 3d 4h on mini1</span></p>
    {facts([("Decisions", "186 in 24h, $0.008"), ("Context", "none: each decision sees one event"), ("Cursor", "per input, in Valkey")], 1)}
  </div>
  <div class="dp-e">
    <p class="dp-e__h"><b>LLM flow</b><span class="dp-k">{ic('clock', 'ic ic--sm')}every 10 minutes today</span></p>
    {facts([("Each run", "at most 30 minutes, from <span class=\"code\">previousRunAt</span>"), ("Tools", "read-only git and streams, Jev's decide tool, an outbox")], 1)}
  </div>
</div>""", sub="the same boundary for both", id_="p-dp-engine")

# ---- the live feed: each event, what Jev decided, what it did ----
FEED = [
    ("15:35", "infra", "attention", "aws-cloudwatch · alarm CheckoutLatencyHigh is ALARM", "eu-west-1, p99 over 2 s for 5 minutes · 55 minutes after deploy 4a1f",
     [("act", "investigate 0.74")], "started", f"{flow('triage-incident')} read-only · {code('local-8b02')}", "$0.00003"),
    ("15:24", "infra", "queue", "prod-logs · new fingerprint payments/HTTPError/capture", "3 events in 10 minutes, and no watch rule matches it",
     [("needs_watch_rule", "yes 0.81"), ("which_flow", "triage-incident 0.77")], "proposed", f"a watch rule {code('payments-5xx')}, below", "$0.00003"),
    ("15:20", "infra", "queue", "prod-logs · checkout TimeoutError, 412 events", "the fingerprint is in its 6h cooldown",
     [], "held", "by the watch rule's cooldown, before any decision", ""),
    ("14:50", "infra", "attention", "aws-cloudwatch · alarm CheckoutLatencyHigh is OK", "the alarm cleared",
     [("act", "ignore 0.95")], "nothing", "ignore at 0.90 or more", "$0.00002"),
    ("14:40", "infra", "box", f"deploys · acme/web {code('4a1f')} to production", "touches checkout and the database pool",
     [("risky_change", "medium 1.4")], "nothing", "kept as a fact for later decisions: 4a1f touched checkout", "$0.00004"),
    ("13:58", "git", "git", "acme/api · 3 commits merged to main", "dependency bumps only",
     [("touches_infra", "no 0.91")], "nothing", "read for context; nothing to do", "$0.00003"),
]
ACT = {"started": ("ok", "runs", "Started"), "proposed": ("parked", "edit", "Proposed"), "held": ("idle", "clock", "Held"), "nothing": ("idle", "minus", "Nothing")}

def feed_rows():
    out = []
    for t, kind, icon, ev, detail, decisions, act, what, cost in FEED:
        tone, aic, aword = ACT[act]
        dec = "".join(f'<span class="dp-dq">{code(q)}<b>{E(a)}</b></span>' for q, a in decisions) or '<span class="muted">no decision: the rules held it</span>'
        out.append(f"""<li class="dp-ev">
  <span class="dp-ev__t">{t}</span>
  <div class="dp-ev__b">
    <p class="dp-ev__h"><span class="dp-k{' tone-running' if kind == 'infra' else ''}">{ic(icon, 'ic ic--sm')}{kind}</span><b>{ev}</b></p>
    <p class="dp-ev__d">{E(detail)}</p>
    <p class="dp-ev__q">{ic('spend', 'ic ic--sm')}{dec}{f'<span class="faint">{cost}</span>' if cost else ''}</p>
  </div>
  <div class="dp-ev__a"><span class="badge tone-{tone}">{ic(aic)}{aword}</span><span class="dp-ev__w">{what}</span></div>
</li>""")
    return "".join(out)

LIVE = card("What it saw and did", f"""<div class="dp-filt" role="group" aria-label="Show">
  <button class="fpill fpill--sm fpill--on" type="button" aria-pressed="true">All</button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('runs', 'ic ic--sm')}Started <b>3</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('edit', 'ic ic--sm')}Proposed <b>2</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('minus', 'ic ic--sm')}Nothing <b>181</b></button>
  <button class="fpill fpill--sm" type="button" aria-pressed="false">{ic('clock', 'ic ic--sm')}Held by rules <b>1,041</b></button>
</div>
<ol class="dp-feed">{feed_rows()}</ol>
<p class="dp-foot">Each line opens the decision's full record.</p>""",
    sub="each event, the questions Jev answered, and the one thing it did · newest first, UTC", id_="p-dp-live",
    end=f'<span class="live" role="status"><span class="dot"></span>Live</span>')

# ---- trigger proposals, adopted by a person ----
PROPS = card("Trigger proposals", f"""<ol class="dp-props">
  <li class="dp-prop">
    <p class="dp-prop__h"><span class="chip tone-parked">{ic('edit')}Proposed</span><span class="dp-k">15:24</span><b>Add a watch rule for payments errors</b></p>
    <p class="dp-prop__why">A new fingerprint, payments/HTTPError/capture, reached 3 in 10 minutes and no watch rule covers it. Jev: needs a watch rule, yes 0.81; flow triage-incident, 0.77.</p>
    {diff('triggers.json, new row 9', [('gap', '…'), ('add', '{ "on": { "type": "watch", "id": "payments-5xx", "source": "prod-alerts",'), ('add', '          "match": { "severity": ["error", "critical"], "labels": { "service": ["payments"] } },'), ('add', '          "fingerprint": ["service", "error.type", "frame.top"], "minCount": 5, "window": "10m",'), ('add', '          "cooldown": "6h", "maxPerDay": 4 },'), ('add', '  "run": { "kind": "local", "folder": "/srv/shop", "flow": "triage-incident", "mode": "investigate" } }'), ('gap', '…')])}
    <p class="dp-prop__n">{ic('info', 'ic ic--sm')}<span>It copies shop-5xx's caps and read-only mode.</span></p>
    <div class="dp-prop__act">{btn('Adopt', '', 'done')}{btn('Edit first', 'ghost', 'edit')}{btn('Dismiss', 'ghost', 'cancel')}</div>
  </li>
  <li class="dp-prop">
    <p class="dp-prop__h"><span class="chip tone-parked">{ic('edit')}Proposed</span><span class="dp-k">09:40</span><b>Raise shop-5xx's threshold from 5 to 8 in 10 minutes</b></p>
    <p class="dp-prop__why">36 of its 41 findings in 24 hours were held by cooldown. Over 30 days, a threshold of 8 would have started the same jobs and held 52 fewer findings.</p>
    {diff('triggers.json, row 8', [('gap', '…'), ('del', '          "minCount": 5, "window": "10m",'), ('add', '          "minCount": 8, "window": "10m",'), ('gap', '…')])}
    <div class="dp-prop__act">{btn('Adopt', '', 'done')}{btn('Dismiss', 'ghost', 'cancel')}</div>
  </li>
</ol>
<p class="dp-foot">Adopt opens a preview with this diff, then Confirm.</p>""",
    sub="it proposes, a person adopts", id_="p-dp-props-card")

JOBS = card("Jobs it started", f"""<ul class="rows dp-jobs">
  <li class="rowpill">{badge('running')}<span class="code">local-8b02</span>{tag('shop')}<span>triage-incident, read-only</span></li>
  <li class="rowpill">{badge('completed')}<span class="code">local-7f21</span>{tag('shop')}<span>triage-incident · $0.11</span></li>
  <li class="rowpill">{badge('completed')}<span class="code">local-6c10</span>{tag('shop')}<span>db-health · $0.06</span></li>
  <li class="rowpill">{badge('refused')}<span class="code">local-6c3a</span>{tag('shop')}<span>triage-incident: over its 1 per target an hour</span></li>
</ul>""",
    sub="3 in 24h, 1 refused", id_="p-dp-jobs-card")

def page():
    inner = (trigger_tabs("Dispatchers") + KPIS + BOUNDARY +
             f'<div class="cols"><div class="stack">{LIVE}</div><div class="stack">{ENGINES}{JOBS}</div></div>{PROPS}')
    end = f'<span class="badge tone-running">{ic("running")}Jev loop, running</span>{btn("Pause", "danger", "pause", sm=False)}'
    return shell("Triggers", inner, "infra-dispatch",
                 sub="Purpose: turn infra alarms and log findings into read-only triage. One of 5 dispatchers; it only starts jobs from its list and proposes watch rules.",
                 end=end, back="Dispatchers")

CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.titlebar__end { display: flex; align-items: center; gap: 10px; }
.dp-kp { font-size: 13px; color: var(--ink-muted); }
.dp-flow { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); background: var(--primary); color: var(--on-primary); font-size: 12px; font-weight: 700; white-space: nowrap; }
.dp-bound { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-5); }
.dp-col { display: grid; align-content: start; gap: 10px; min-width: 0; }
.dp-h { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--ink); }
.dp-h2 { margin-top: var(--space-2); }
.dp-in { display: grid; gap: 8px; }
.dp-in li { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; align-items: start; }
.dp-in li > .dp-k { justify-self: start; padding-top: 1px; }
.dp-in div { display: grid; font-size: 13px; color: var(--ink); }
.dp-in div span { font-size: 12px; color: var(--ink-muted); }
.dp-may { display: grid; gap: 8px; }
.dp-may li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 12px; }
.dp-why { width: 100%; color: var(--ink-muted); }
.dp-caps { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--ink); }
.dp-caps > span { display: inline-flex; align-items: center; gap: 5px; }
.dp-caps .ic { color: var(--ink-muted); }
.dp-k { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.dp-k.tone-running .ic { color: var(--tone-ink); }
.dp-p { font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.dp-off { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.dp-off .ic { flex: none; margin-top: 2px; color: var(--ink); }
.dp-off b { color: var(--ink); }
.dp-seg { margin-bottom: var(--space-4); }
.dp-eng { display: grid; gap: 10px; }
.dp-e { display: grid; gap: 10px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.dp-e--on { box-shadow: inset 0 0 0 2px var(--running); }
.dp-e__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 15px; color: var(--ink); }
.dp-e__h .badge, .dp-e__h .chip, .dp-e__h .dp-k { margin-left: auto; }
.dp-filt { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--space-3); }
.dp-filt .fpill b { margin-left: 2px; }
.dp-feed { display: grid; }
.dp-ev { display: grid; grid-template-columns: 48px minmax(0, 1fr) 230px; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); align-items: start; }
.dp-ev__t { font-size: 12px; font-weight: 650; color: var(--ink-muted); font-variant-numeric: tabular-nums; padding-top: 4px; }
.dp-ev__b { display: grid; gap: 4px; min-width: 0; }
.dp-ev__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--ink); }
.dp-ev__d { font-size: 12px; color: var(--ink-muted); }
.dp-ev__q { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; font-size: 12px; color: var(--ink-muted); }
.dp-ev__q > .ic { color: var(--running-ink); }
.dp-dq { display: inline-flex; align-items: center; gap: 6px; }
.dp-dq b { color: var(--ink); }
.dp-ev__a { display: grid; gap: 6px; justify-items: start; font-size: 12px; color: var(--ink-muted); }
.dp-ev__w { line-height: 18px; }
.dp-foot { font-size: 12px; line-height: 18px; color: var(--ink-muted); margin-top: var(--space-3); }
.dp-props { display: grid; gap: 12px; }
.dp-prop { display: grid; gap: 8px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 3px 0 0 var(--parked); }
.dp-prop__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; color: var(--ink); }
.dp-prop__why { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.dp-prop .diff { background: var(--surface); }
.dp-prop__n { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--ink-muted); }
.dp-prop__n .ic { flex: none; margin-top: 2px; }
.dp-prop__act { display: flex; flex-wrap: wrap; gap: 8px; }
.dp-jobs .rowpill { gap: 10px; }
.dp-jobs .rowpill > span:last-child { color: var(--ink-muted); font-size: 13px; }
@media (max-width: 760px) {
  .tr-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .titlebar__end { flex-wrap: wrap; }
  .dp-bound { grid-template-columns: minmax(0, 1fr); }
  .dp-ev { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .dp-filt { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
}
"""

if __name__ == "__main__":
    write("DispatcherScreen", card_marker("Planned for 5.0.0", 2400, 1440, "A dispatcher: reads git changes and infra streams, and only starts jobs and proposes triggers with the right flow and model; a Jev loop or an LLM flow"),
          "infra-dispatch", page(), CSS)
    readme("DispatcherScreen", """
One dispatcher in full. A dispatcher is a sandbox with a purpose of its own. It reads git changes and infra streams, and has two powers only: start jobs from its list, and propose triggers. Many can run at once, each for a different purpose (see Dispatchers). This one, `infra-dispatch`, turns infra alarms and log findings into read-only triage, and proposes watch rules. It generalises #735.

**How a person uses it.**
- **The title bar** gives its purpose in one sentence, its engine and state, and Pause.
- **The numbers.** Events read in 24 hours, decisions and what they cost, jobs started against its day cap, and trigger proposals waiting for a person.
- **What it may do.** The boundary, set by hand in triggers.json like any trigger:
  - **It reads:** CloudWatch alarms through EventBridge, Vector findings, deployments, and merged commits for context.
  - **It may start:** only `triage-incident` and `db-health`, each with a listed model, under its own day caps.
  - **It may propose:** new or tuned watch rules, for a person to adopt. "Apply proposals without me" shows as off.
- **What it saw and did.** A live feed, newest first. Each event shows its input and the event, with log text as plain text. Then Jev's questions with their answers, probabilities and cost. Last, the one thing it did: started a job, proposed a watch rule, held by a watch rule before any decision, or nothing.
- **Trigger proposals.** A new watch rule for a new fingerprint, and a tuned threshold for an existing one. Each has its reason and the triggers.json diff. *Adopt* is the usual preview and Confirm, audited with the proposal's id.
- **Engine.** The same boundary for two engines, each as facts: the Jev loop (this one, on mini1) with its decisions, context and cursor, and the LLM flow with its runs and tools.
- **Jobs it started.** Ordinary jobs; a refusal shows its reason.

**Panels.** `p-dp-events`, `p-dp-decisions`, `p-dp-jobs`, `p-dp-props`, `p-dp-bound`, `p-dp-live`, `p-dp-props-card`, `p-dp-engine`, `p-dp-jobs-card`.

**The server provides.**
- The dispatcher's rule: purpose, inputs, allowed flows and models, caps, and the auto-apply setting.
- The engine and its state: host, uptime and cursors for a Jev loop, or the last and next runs for an LLM flow.
- Per event: its input, its summary fields, each decision (question, options, answer, probability, cost), the action with its job or proposal id, and any fact the loop kept.
- The proposals with their diffs, and the jobs started with their outcomes.

**Who sees what.** Log text and decision state are operator only. A viewer sees the counts, the actions, and the decisions' chosen options and probabilities. Only an operator adopts, dismisses or pauses.

**Why it works this way.**
- **Two powers only:** start a job from its list, and propose a trigger. It holds no write token, so it cannot change code or the forge.
- **What it never does:** write code, push or merge, comment or label as a person, start a flow or model outside its list, change caps, secrets or its own rules, or see a secret's value or a write token.
- **Applying proposals without a person** is off. It can be turned on only by hand in triggers.json, and never for models, caps, secrets or MCP servers. A proposal may not set a model outside its list, a dollar cap, secrets or MCP servers: those stay the person's to write.
- **Every cost is held first.** Decisions are priced before they are asked (Jev bills input only), and jobs pass every check before spend, inside the dispatcher's own day caps.
- **The event never picks the flow or model.** Jev picks from options a person wrote. Untrusted text can sway a choice, but not widen it. Log text is untrusted and shown as plain text.
- **Jev gives no reasons.** The question, its answer and the probability are the why.
- **No model context lives on in the Jev loop.** Each decision sees one event's fields, so nothing from one log line carries into the next. Facts it keeps, such as a recent deploy, are structured fields the loop holds.
- **The Jev loop** runs all the time like the GitHub poller, in a plain container whose network reaches only its inputs and the decision API, and loses nothing on restart because its cursors live in Valkey.
- **The LLM flow** is just a flow: a skill in a job. It reasons across events, such as a deploy, then an alarm, then a log spike. Today it runs at most 30 minutes, every 10 minutes; waiting in its own loop for hours needs long runs first (a timeout per trigger, budget held an hour at a time, tokens that refresh).
- **Each job it starts is ordinary:** its own container, budget held before it starts, flow and model from this dispatcher's list, never from the event.
- **Triggers change through a person.** Proposals are adopted as reviewed edits, audited as `trigger-add` or `trigger-edit` with the proposal's id. Models change only this way. These follow #735 and #650's decisions.

**Fixture note.** This is a planned screen, and all of it is sample:
- the dispatcher, its inputs, the CloudWatch alarm and the payments fingerprint;
- the jobs `local-8b02`, `local-6c10` and `local-6c3a` (`local-7f21` and the shop-5xx numbers follow the Watch fixture);
- the decisions and their costs, which follow Jev's input-only price.
""")
    print("dispatcher written")
