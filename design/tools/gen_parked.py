"""Run refused, run parked, Parked on a phone, approval request (#649) and fork a run (#648), on the Pulse kit."""
import os
from pulse import *

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def runtitle(jid):
    return f'Run <span class="rt-id">{jid}</span>'

def disabled(text, kind="paid", icon="rerun"):
    return f'<a class="btn btn--{kind}" aria-disabled="true" role="link">{ic(icon, "ic ic--sm")}{text}</a>'

COMMON = """
.rt-id { font-family: var(--font-mono); font-weight: 700; letter-spacing: -0.04em; }
.rt-meta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rt-meta a { font-weight: 650; text-decoration: none; color: var(--ink); }
.rt-small { font-size: 12px; color: var(--ink-muted); display: flex; align-items: center; gap: 6px; }
"""

def meta(*parts):
    return '<span class="rt-meta">' + "".join(parts) + "</span>"

# ======================================================================
# 1. Run refused
# ======================================================================
def run_refused():
    acts = (btn("Open Fleet", "primary", "fleet", sm=False)
            + disabled("Preview a re-run")
            + '<span class="rf-why">Re-run opens once the egress proxy on build3 is running.</span>')
    oc = outcome("refused", "Refused before it started",
                 "Refused: this deployment runs jobs behind an egress policy, and its egress proxy is not running on build3.",
                 'Start the egress proxy on build3 (<span class="code">pi-dispatch doctor</span> shows it), then re-run. <b>Nothing was spent.</b>',
                 acts)
    f = facts([
        ("Target", '<a class="link" href="#">acme/billing#260</a>'), ("Project", tag("billing")),
        ("Forge", "github"), ("Flow", "fix"),
        ("Host", "build3"), ("Venue", venue("podman") + ' <span class="faint">egress enforced</span>'),
        ("Trigger", '3, comment "@pi"'), ("Model", "anthropic / claude-sonnet-5-5"),
        ("Attempt", "1"), ("Reason token", '<span class="code">egress-proxy-missing</span>'),
        ("Started", "2026-10-08 15:30 UTC"), ("Ended", "15:30 UTC, took 0s"),
        ("Cost", "not metered"), ("Dollar window", "none applied"),
    ], cols=2)
    main = (card("Run", f + '<p class="rt-small rf-note">' + ic("terminal", "ic ic--sm")
                 + 'No workspace to open: this run kept none.</p>', id_="p-run")
            + f'<section class="collapsed" id="p-rest" data-panel>{ic("cancel", "ic ic--sm")}<b>Nothing ran,</b> so there is no progress, transcript or spend. Session fresh, no parent or child runs.</section>')
    why = card("Why it was refused", f"""
  <p class="rf-rule"><span class="tile tile--sm tone-refused">{ic('refused', 'ic ic--sm')}</span><span><b>Egress policy</b><span class="muted">build3 sets <span class="code">PI_BACKEND_FLOOR=egress=enforced</span>: a job starts only when its egress proxy answers.</span></span></p>
  <ul class="rows">
    <li class="rowpill">{ic('refused', 'ic ic--sm')}<span>Same reason in the last 24 hours</span><span class="end"><b>1</b></span></li>
    <li class="rowpill">{ic('doctor', 'ic ic--sm')}<span>Doctor on build3: 1 failing, 3 days old</span><a class="rowpill__act" href="#">Re-run doctor</a></li>
  </ul>
  <p class="rf-docs"><a class="link" href="#">About egress-proxy-missing</a></p>""", id_="p-why")
    host = card("build3", f"""<ul class="hosts">{hostrow("build3", "attention", "podman", "2m", "attention", "rhf",
        f'<span class="tinted tone-failed">{ic("failed", "ic ic--sm")}Docker daemon unreachable</span><span><span class="code">@build3</span> 0 waiting, 1 running</span>')}</ul>""",
        end=btn("Open Fleet"), sub="the host that refused", id_="p-host")
    inner = oc + f'<div class="cols"><div class="stack">{main}</div><div class="stack">{why}{host}</div></div>'
    body = shell("Runs", inner, runtitle("gh-e9a0"),
                 sub=meta(tag("billing"), '<a href="#">acme/billing#260</a>', badge("refused"), '<span class="faint">15:30 UTC</span>'),
                 back="Runs")
    style = COMMON + """
.rf-why { font-size: 12px; line-height: 16px; color: var(--ink-muted); max-width: 210px; }
.rf-note { margin-top: var(--space-3); }
.rf-rule { display: flex; gap: 12px; align-items: flex-start; margin-bottom: var(--space-3); font-size: 13px; line-height: 19px; }
.rf-rule > span:last-child { display: flex; flex-direction: column; gap: 2px; }
.rf-docs { margin-top: var(--space-3); font-size: 13px; }
"""
    write("RunRefused", card_marker("Screens", 900, 1440, "A run refused before it started: the reason leads, what did not happen collapses to one line"),
          "Run gh-e9a0, refused", body, style)
    readme("RunRefused", """
The run page for a run refused before it started: the outcome banner leads with the reason sentence and the next step, and everything that did not happen folds into one line.

## How a person uses it
- The banner says what happened ("Refused: …"), why (the egress proxy on build3 is not running), what to do (start the proxy, then re-run) and that nothing was spent.
- The one primary action is **Open Fleet**, where the proxy and doctor live. **Preview a re-run** is shown but disabled, with the reason beside it, so the person knows it exists and why it waits.
- Progress, transcript, tokens and chain do not apply, so they collapse into one line instead of five empty panels.
- The sandbox command is hidden because the run kept no workspace (#710), and a small line says there is none to open.
- *Why it was refused* names the rule in one sentence, counts the same reason in 24 hours and links the reason's docs.

## Panels
`p-outcome`, `p-run`, `p-rest` (the collapsed line), `p-why`, `p-host`.

## The server provides
The run record (target, project, flow, host, venue, trigger, model, attempt, times, reason token), the reason catalog's sentence and next step for the token, whether a re-run would be refused again and why, whether a workspace was kept, the count of the same reason in 24 hours, and the host's doctor summary.

## Why it works this way
- The egress floor exists so a job can reach the hosts on its allowlist and nothing else. With the proxy down, no job on build3 may start.

## Fixture note
From the fixture: gh-e9a0, acme/billing#260, fix, build3, podman, trigger 3 (index 2 in the fixture file), claude-sonnet-5-5, attempt 1, 15:30 UTC, 0s, not metered, no dollar window, `egress-proxy-missing`. The fixture record says project `api`; the page follows the project config, which maps acme/billing to `billing`. The rule text, the doctor link and "same reason in 24 hours" are sample copy.
""")

# ======================================================================
# 2. Run parked
# ======================================================================
SAMPLE_ANSWER = "Per API key. An account can hold several keys; limit each key to 60 exports an hour."

def run_parked():
    hero = f"""<section class="card card--ring tone-parked pk-hero" id="p-chat" data-panel aria-labelledby="pk-h">
  <div class="card__head">
    <span class="tile tone-parked">{ic('parked')}</span>
    <h2 id="pk-h"><span class="code pk-code">gh-2f6a</span> asked a question</h2>
    <span class="end">{chip('waiting 26m', 'parked', 'clock')}</span>
  </div>
  <p class="pk-who">{tag('api')}<a class="link" href="#">acme/api#131</a><span>triage on mini1, parked at 15:13 UTC</span></p>
  <blockquote class="pk-q">{E(PARKED_Q)}</blockquote>
  <div class="field">
    <label for="pk-a">Your answer</label>
    <textarea id="pk-a" class="textarea" rows="3">{E(SAMPLE_ANSWER)}</textarea>
    <span class="field__hint">Plain text. It is posted as you, and the agent reads it as the reply to its question.</span>
  </div>
  {confirm("safe", "Preview: answer gh-2f6a", [
        "Posts your answer to <b>acme/api#131</b> as a reply and resumes the run",
        "The run continues the same session (trigger 7 keeps a session), on the next free slot",
        "Reserves up to <b>$2.00</b>, the job cap, before the first token",
    ], "Edit or delete the reply on the forge before the run resumes", "Post answer and resume")}
  <div class="pk-term"><span class="muted">Or continue it in a terminal</span>{cmd("pi-dispatch chat gh-2f6a")}</div>
</section>"""
    expired = f"""<section class="pk-alt" aria-labelledby="pk-alt-h">
  <p class="pk-alt__h" id="pk-alt-h">When the run's data has expired</p>
  {banner("attention", "attention", "This run cannot be answered here",
          "The queue no longer holds its data (kept 31 days). Answer on <b>acme/api#131</b> instead; a reply there resumes it.",
          btn("Open acme/api#131", "", "git"), small=True)}
</section>"""
    run_facts = card("Run", facts([
        ("Target", '<a class="link" href="#">acme/api#131</a>'), ("Project", tag("api")), ("Flow", "triage"),
        ("Host", "mini1, " + venue("local")), ("Trigger", "7, label pi:triage"), ("Session", "kept; resumes on reply"),
        ("MCP", '<span class="code">linear</span>'), ("Started", "14:52 UTC"), ("Parked", "15:13 UTC, took 20m"), ("Turns", "11"),
    ], cols=1), id_="p-run")
    spend = card("Tokens and dollars", f"""<p class="kpi"><b>$0.21</b><span>metered, settled $0.209633</span></p>
  {meterrow("Job cap", "this run", 0.21/2, "$0.21", "$2.00")}
  {facts([("Input", "74,953"), ("Output", "5,523"), ("Total", "125,448"), ("Model calls", "11")], cols=2)}""", id_="p-spend")
    tail = card("Transcript tail", '<ol class="tx pk-tail">' + "".join([
        tx("call", "15:11:42", '<span class="code">linear.search_issues</span> {"query": "export rate limit"}', label="linear"),
        tx("result", "15:12:05", "3 issues mention export limits; two say per key, one says per account.", label="linear"),
        tx("assistant", "15:13:02", "The issue and the linked Linear tickets disagree on the scope of the limit. I asked on the issue before choosing.", trunc=True),
    ]) + "</ol>", end=btn("Full transcript", "ghost"), id_="p-tail")
    inner = f'<div class="cols"><div class="stack">{hero}{expired}</div><div class="stack">{run_facts}{spend}{tail}</div></div>'
    body = shell("Runs", inner, runtitle("gh-2f6a"),
                 sub=meta(tag("api"), '<a href="#">acme/api#131</a>', badge("awaiting"), '<span class="faint">parked 15:13 UTC</span>'),
                 back="Runs")
    style = COMMON + """
.pk-code { font-size: 17px; font-weight: 700; }
.pk-hero { display: grid; gap: var(--space-4); }
.pk-hero .card__head { margin-bottom: 0; }
.pk-who { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-muted); }
.pk-q { padding: 18px 20px; border-radius: var(--radius-md); background: var(--parked-tint); font-size: 22px; line-height: 31px; font-weight: 600; letter-spacing: -0.01em; }
.pk-term { display: grid; gap: 6px; font-size: 12px; }
.pk-alt { display: grid; gap: 8px; }
.pk-tail .tx__e { grid-template-columns: minmax(0, 1fr) auto; }
.pk-tail .tx__b { grid-column: 1 / -1; grid-row: 2; }
.pk-alt__h { margin-left: 4px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
"""
    write("RunParked", card_marker("Screens", 1080, 1440, "A parked run: the question is the hero, with the answer box and the two-step confirm"),
          "Run gh-2f6a, awaiting input", body, style)
    readme("RunParked", """
The run page for a parked run: the agent's question is the hero, with the answer box and the two-step confirm right under it.

## How a person uses it
- The question card shows who asked (gh-2f6a, `api`, acme/api#131), how long it has waited and the question in large text.
- The person writes an answer and previews it. The preview says it is posted to acme/api#131 as a reply and resumes the run, that the session continues, and what is reserved before the first token. **Post answer and resume** confirms; the undo line says how to take it back.
- A terminal route stays available: `pi-dispatch chat gh-2f6a`.
- When the queue no longer holds the run's data, the answer box is replaced by an attention banner that sends the person to the issue, where a reply still resumes the run. Both states are shown on this card.
- The side column holds the run facts, tokens and dollars against the job cap, and the last three transcript entries.

## Panels
`p-chat` (question, answer, preview), `p-run`, `p-spend`, `p-tail`.

## The server provides
The parked run record, the question (the last assistant entry, untrusted text, escaped), whether the queue still holds the job's data (so an answer can be built here), the session-keeping trigger, the job cap and the reservation, and the transcript tail.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, local, trigger 7 (index 6 in the fixture file; label pi:triage, keeps a session, MCP linear), 11 turns, $0.21 (settled $0.209633), 74,953 in, 5,523 out, 125,448 total, 11 model calls, 14:52 to 15:13 UTC, and the "cannot be answered here" state. The question, the typed answer and the transcript tail are sample copy.
""")

# ======================================================================
# 3. Parked on a phone
# ======================================================================
SEG_Q = '<div class="seg" role="group" aria-label="Show"><button aria-pressed="true">Questions <b>1</b></button><button aria-pressed="false">Approvals <b>1</b></button></div>'

def parked_phone():
    q = f"""<section class="card card--ring tone-parked pp-card" id="p-questions" data-panel aria-labelledby="pp-q">
  <p class="pp-top"><span class="tile tile--sm tone-parked">{ic('parked', 'ic ic--sm')}</span><b id="pp-q"><span class="code">gh-2f6a</span> asks</b><span class="pp-wait">26m</span></p>
  <p class="pp-meta">{tag('api')}<a class="link" href="#">acme/api#131</a><span>triage, mini1</span></p>
  <blockquote class="pp-quote">{E(PARKED_Q)}</blockquote>
  <label class="sr" for="pp-a">Your answer</label>
  <textarea id="pp-a" class="textarea" rows="3" placeholder="Write your answer"></textarea>
  <div class="pp-act">{btn("Preview answer", "answer", "parked", sm=False)}{btn("Open run", "ghost", sm=False)}</div>
  <p class="pp-hint">Posted to acme/api#131 after you confirm. It resumes the run.</p>
</section>"""
    a = f"""<p class="pp-sect">1 approval also waits</p>
<section class="card pp-card pp-appr" id="p-approvals" data-panel aria-labelledby="pp-ap">
  <p class="pp-top"><span class="tile tile--sm tone-parked">{ic('shield', 'ic ic--sm')}</span><b id="pp-ap"><span class="code">gh-7b21</span> asks to push to main</b><span class="pp-wait">12m</span></p>
  <p class="pp-meta">{tag('web')}<a class="link" href="#">acme/web#415</a><span>3 commits, 4 files</span></p>
  <p class="pp-risk">{ic('shield', 'ic ic--sm')}Worker-enforced: push scope only after you approve.</p>
  <div class="pp-act">{btn("Approve", "primary", "done", sm=False)}{btn("Decline", "danger", "", sm=False)}</div>
</section>"""
    inner = q + a
    body = shell("Parked", inner, "Parked", sub="Runs that stopped to wait for a person", end=SEG_Q, parked=2)
    style = """
.pp-card { display: grid; gap: 12px; }
.pp-top { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.pp-top b { flex: 1; min-width: 0; }
.pp-top .code { font-size: 14px; font-weight: 700; }
.pp-wait { font-size: 12px; font-weight: 700; color: var(--parked-ink); }
.pp-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--ink-muted); }
.pp-quote { padding: 12px 14px; border-radius: var(--radius-md); background: var(--parked-tint); font-size: 16px; line-height: 23px; font-weight: 600; }
.pp-act { display: flex; gap: 6px; flex-wrap: wrap; }
.pp-act .btn { flex: 1 1 auto; }
.pp-act .btn--ghost { flex: 0 0 auto; }
.pp-hint { font-size: 12px; color: var(--ink-muted); }
.pp-sect { margin: 6px 4px 0; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.pp-risk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); }
.seg b { font-weight: 800; }
"""
    write("ParkedPhone", card_marker("Screens, phone", 1300, 390, "Parked on a phone: the question, the answer box, one tap to preview"),
          "Parked on a phone", body, style)
    readme("ParkedPhone", """
The Parked page at phone width: each parked question is a card with the question, its target and wait time, and an answer box one tap from the preview.

## How a person uses it
- The person opens the console from a notification. A tab switch splits *Questions* from *Approvals*, each with its count.
- The question card shows who asked, the project and target, how long it has waited and the question in large text.
- **Preview answer** opens the same two-step confirm as the run page. Nothing is posted until they confirm.
- Below the questions, a compact card shows the approval that also waits (#649): the action, the target, the risk line, and Approve or Decline as full-width buttons.
- Everything fits 390px with no sideways scroll; the nav pills scroll inside their own row.

## Panels
`p-questions`, `p-approvals`.

## The server provides
Parked runs (questions and approval requests) with their target, project, wait time, question or gate text (untrusted, escaped) and whether an answer can be built here.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, parked 26 minutes. The question text and the approval gh-7b21 (push to main on acme/web#415) are sample content; approvals are planned for 5.0.0.
""")

# ======================================================================
# 4. Approval request (#649)
# ======================================================================
SEG_A = '<div class="seg" role="group" aria-label="Show"><button aria-pressed="false">Questions <b>1</b></button><button aria-pressed="true">Approvals <b>2</b></button></div>'

def approval():
    files = [("src/checkout/PayButton.tsx", "+18", "-4"), ("api/payments.ts", "+52", "-6"),
             ("api/payments.test.ts", "+16", "-0"), ("migrations/0042_idempotency.sql", "+12", "-0")]
    file_rows = "".join(f'<li><span class="code">{f}</span><span class="ap-add">{a}</span><span class="ap-del">{d}</span></li>' for f, a, d in files)
    main = f"""<section class="card card--ring tone-parked ap-card" id="p-approval" data-panel aria-labelledby="ap-h">
  <div class="card__head">
    <span class="tile tone-parked">{ic('shield')}</span>
    <h2 id="ap-h"><span class="code ap-code">gh-7b21</span> asks to push to main</h2>
    <span class="end">{chip('waiting 12m', 'parked', 'clock')}<span class="ap-decl">{ic('hourglass', 'ic ic--sm')}declines by itself in 2d 23h</span></span>
  </div>
  <p class="ap-who">{tag('web')}<a class="link" href="#">acme/web#415</a><span>fix on mini1, trigger 3, a comment by @rob, asked at 15:27 UTC</span></p>
  <div class="ap-gate">
    <div class="ap-gate__h"><span class="ap-gname">Gate <span class="code">push</span></span><span class="muted">push to the default branch</span></div>
    {facts([("Action", "Push 3 commits to <b>main</b>"), ("Branch", '<span class="code">pi/issue-415</span> into <span class="code">main</span>'),
            ("Commits", '<span class="code">a1f2c3d</span> <span class="code">9e8b7f0</span> <span class="code">44c1d2e</span>'), ("Files", "4 changed, +98 -10"),
            ("Agent's summary", '<span class="ap-untrusted">Adds an idempotency key to POST /payments and disables Pay while a request is in flight.</span>'),
            ("Risk", f'<span class="ap-risk">{ic("shield", "ic ic--sm")}Worker-enforced: the resumed run gets push scope for main only after you approve.</span>')], cols=1)}
    <ul class="ap-files" aria-label="Files changed">{file_rows}</ul>
  </div>
  <div class="ap-act">{btn("Approve push", "primary", "done", sm=False)}{btn("Decline", "danger", "", sm=False)}{btn("Ask a question back", "ghost", "parked", sm=False)}</div>
  <div class="ap-decline">
    <div class="field">
      <label for="ap-r">Reason for declining</label>
      <textarea id="ap-r" class="textarea" rows="2">Keep this on a branch and open a pull request; main is protected during the release freeze.</textarea>
      <span class="field__hint">Sent to the agent as the result of its request, so it can change course. Not an error.</span>
    </div>
    {confirm("danger", "Preview: decline the push", [
        "Records your decision (ops, now) on gh-7b21 and in the audit log",
        "Resumes the run with <b>declined</b> and your reason as the result of <span class=\"code\">request_approval</span>",
        "Posts a comment on <b>acme/web#415</b> naming you and the reason",
    ], "None once the run resumes; until then, approve from this page instead", "Decline push")}
  </div>
</section>"""
    others = card("Also waiting", f"""<ul class="rows">
    <li class="rowpill tone-parked">{ic('shield', 'ic ic--sm')}{tag('billing')}<span class="code">gh-3c90</span><span>budget-raise</span><a class="rowpill__act" href="#">Review</a></li>
    <li class="rowpill tone-parked">{ic('parked', 'ic ic--sm')}{tag('api')}<span class="code">gh-2f6a</span><span>question, 26m</span><a class="rowpill__act" href="#">Answer</a></li>
  </ul>
  <div class="ap-mini">
    <p class="ap-mini__h"><span class="tile tile--sm tone-parked">{ic('spend', 'ic ic--sm')}</span><b><span class="code">gh-3c90</span> asks to raise its run cap</b><span class="faint">4m</span></p>
    <p class="ap-mini__s">{tag('billing')} acme/billing#261, fix on build3. Raise the run cap from <b>$2.00</b> to <b>$3.50</b>; it has spent $1.84 and has 2 of 4 phases left.</p>
    <p class="ap-risk">{ic('shield', 'ic ic--sm')}Worker-enforced: the cap only rises after you approve.</p>
    <div class="ap-act">{btn("Approve", "primary", "done")}{btn("Decline", "danger")}</div>
  </div>""", id_="p-others")
    history = card("Decided recently", f"""<ul class="rows">
    <li class="rowpill">{ic('done', 'ic ic--sm')}{tag('web')}<span class="code">gh-71aa</span><span>push approved by ops</span><span class="end faint">14:02</span></li>
    <li class="rowpill">{ic('failed', 'ic ic--sm')}{tag('ops')}<span class="code">gh-0c4e</span><span>deploy:staging declined by ops</span><span class="end faint">yesterday</span></li>
    <li class="rowpill">{ic('hourglass', 'ic ic--sm')}{tag('api')}<span class="code">gh-55d2</span><span>budget-raise timed out</span><span class="end faint">Mon</span></li>
  </ul>""", end=btn("Audit", "ghost"), id_="p-history")
    inner = f'<div class="cols"><div class="stack">{main}</div><div class="stack">{others}{history}</div></div>'
    body = shell("Parked", inner, "Parked", sub="Runs that stopped to wait for a person", end=SEG_A, parked=3)
    style = COMMON + """
.ap-card { display: grid; gap: var(--space-4); }
.ap-card .card__head { margin-bottom: 0; }
.ap-code { font-size: 17px; font-weight: 700; }
.ap-decl { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-muted); }
.ap-who { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-muted); }
.ap-gate { display: grid; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-radius: var(--radius-md); background: var(--surface-2); }
.ap-gate .fact { border-bottom-color: var(--line); }
.ap-gate__h { display: flex; align-items: baseline; gap: 10px; }
.ap-gname { font-size: 17px; font-weight: 750; }
.ap-gname .code { font-size: 16px; font-weight: 700; padding: 1px 8px; border-radius: 6px; background: var(--parked-tint); color: var(--parked-ink); }
.ap-untrusted { display: block; padding: 8px 10px; border-radius: 10px; background: var(--surface); color: var(--ink); }
.ap-risk { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); font-weight: 600; }
.ap-files { display: grid; gap: 2px; }
.ap-files li { display: grid; grid-template-columns: minmax(0, 1fr) 48px 40px; gap: 8px; padding: 6px 10px; border-radius: 10px; background: var(--surface); font-size: 12px; }
.ap-files .code { font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.ap-add { color: var(--ok-ink); font-weight: 700; text-align: right; }
.ap-del { color: var(--failed-ink); font-weight: 700; text-align: right; }
.ap-act { display: flex; gap: 8px; flex-wrap: wrap; }
.ap-decline { display: grid; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.ap-mini { display: grid; gap: 8px; margin-top: var(--space-3); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.ap-mini__h { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.ap-mini__h b { flex: 1; }
.ap-mini__h .code { font-size: 13px; font-weight: 700; }
.ap-mini__s { font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.ap-mini__s b { color: var(--ink); }
.ap-mini .ap-risk { font-size: 12px; }
.seg b { font-weight: 800; }
"""
    write("ApprovalRequest", card_marker("Planned for 5.0.0", 1240, 1440, "Approval gates (#649): the agent asks permission for a named action; approve, or decline with a reason"),
          "Parked, approvals", body, style)
    readme("ApprovalRequest", """
The Parked page with the Approvals tab (#649): the agent asks permission for a named action, the run parks, and a person approves, declines with a reason or asks a question back.

## How a person uses it
- The request card names the run, the gate and the action in one line ("gh-7b21 asks to push to main"), with the project, target, trigger author and how long it has waited. A chip shows when an unanswered gate declines itself.
- The gate block lists:
  - the action and its arguments (branch, commits, files with line counts);
  - the agent's own summary, set apart as untrusted text;
  - the risk line, which says whether the worker enforces the gate or it is advisory.
- **Approve push** is the primary action. **Decline** is a danger outline; here it is expanded with a reason field, and the danger preview says the reason goes back to the agent as the result of `request_approval`, not as an error. **Ask a question back** keeps the run parked.
- The side column lists what else waits (a budget-raise request in compact form, and the parked question). It also shows recent decisions with who decided and when.

## Panels
`p-approval`, `p-others`, `p-history`.

## The server provides
Per request: run, gate name and its declared kind (worker-enforced or advisory), action and arguments, the agent's summary (untrusted, escaped), the trigger author, asked-at time, the optional `gateTimeout`, and who may decide. Plus recent decisions from the audit log.

## Why it works this way
- A trigger declares its gates (`run.gates`). When the agent asks, the run parks like a question.
- Push to the default branch, pull request and budget raise are enforced by the worker. Deploy gates are advisory to the skill.
- Only people who pass the trigger's author gate can decide.

## Fixture note
All approval content is sample, because approval gates are planned for 5.0.0: gh-7b21, gh-3c90, gh-71aa, gh-0c4e, gh-55d2, the commits, files, summary, reason and @rob as trigger author. gh-2f6a and its question count come from the fixture. The Parked count in the nav is 3: 1 question and 2 approvals.
""")

# ======================================================================
# 5. Fork a run (#648)
# ======================================================================
def fork_run():
    tree = f"""<section class="card" id="p-forks" data-panel aria-labelledby="fk-t">
  <div class="card__head"><h2 id="fk-t">Forks of this run</h2><span class="card__sub">each fork runs on its own branch; the original pull request is untouched</span></div>
  <div class="fk-tree" role="img" aria-label="gh-b3d7, completed, has two forks: gh-b3d7-f1 completed and gh-b3d7-f2 running">
    <div class="fk-node fk-node--root">
      <p class="fk-n__h"><span class="code">gh-b3d7</span>{badge("completed")}</p>
      <p class="fk-n__s">original, claude-sonnet-5-5, $0.42</p>
    </div>
    <svg class="fk-lines" width="96" height="132" viewBox="0 0 96 132" aria-hidden="true">
      <path class="fk-line" d="M0 66 C48 66 48 30 96 30"/>
      <path class="fk-line" d="M0 66 C48 66 48 102 96 102"/>
    </svg>
    <div class="fk-kids">
      <div class="fk-node">
        <p class="fk-n__h"><span class="code">gh-b3d7-f1</span>{badge("completed")}</p>
        <p class="fk-n__s">from entry 9, claude-opus-5-5, $1.12</p>
      </div>
      <div class="fk-node fk-node--live">
        <p class="fk-n__h"><span class="code">gh-b3d7-f2</span>{badge("running")}</p>
        <p class="fk-n__s">from entry 14, kimi-for-coding, 4m</p>
      </div>
    </div>
  </div>
</section>"""

    def n(k):
        return f'<span class="fk-num">#{k}</span>'
    entries = [
        tx("call", "15:27:48", n(10) + '<span class="code">{"path": "src/checkout/PayButton.tsx"}</span>', label="read", fork=True),
        tx("result", "15:27:49", n(11) + '<details><summary>142 lines</summary><pre>export function PayButton({ onPay }) {\n  return &lt;button onClick={onPay}&gt;Pay&lt;/button&gt;\n}</pre></details>', label="read", fork=True),
        tx("call", "15:29:08", n(12) + '<span class="code">npm test -- checkout</span>', label="bash", fork=True),
        tx("error", "15:29:10", n(13) + "1 failing: charges twice when Pay is pressed twice.", label="bash", fork=True),
        tx("assistant", "15:29:48", n(14) + "The test confirms the double submit. I'll disable the button while the payment request is in flight and add an idempotency key on the server side.", forkpoint=True),
        tx("call", "15:30:03", n(15) + '<span class="code">src/checkout/PayButton.tsx</span>, 2 hunks', label="edit", fork=True),
        tx("result", "15:30:04", n(16) + "Applied.", label="edit", fork=True),
        tx("compaction", "15:36:10", n(17) + "Context compacted from 61% to 18%.", fork=True),
        tx("end", "15:52:31", n(18) + "Completed: 3 commits on pi/issue-415, pull request #512 opened."),
    ]
    transcript = f"""<section class="card" id="p-transcript" data-panel aria-labelledby="fk-tx">
  <div class="card__head"><h2 id="fk-tx">Transcript</h2><span class="card__sub">pick an entry to fork from</span><span class="end">{btn("Entries 1 to 9", "ghost", "chev")}</span></div>
  <ol class="tx fk-tx">{''.join(entries)}</ol>
</section>"""
    form = f"""<section class="card card--ring tone-parked fk-form" id="p-fork" data-panel aria-labelledby="fk-f">
  <div class="card__head"><span class="tile tone-parked">{ic('git')}</span><h2 id="fk-f">Fork this run</h2></div>
  <div class="rowpill fk-point">{ic('git', 'ic ic--sm')}<span>From <b>entry 14</b>, assistant 15:29:48</span><a class="rowpill__act" href="#">Change</a></div>
  <div class="fk-pos"><span class="field__l">Position</span><div class="seg" role="group" aria-label="Position"><button aria-pressed="true">Before the entry</button><button aria-pressed="false">At the entry</button></div></div>
  <div class="fk-two">
    <div class="field"><label for="fk-m">Model</label><select id="fk-m" class="select"><option>claude-sonnet-5-5 (original)</option><option selected>claude-opus-5-5</option><option>kimi-for-coding</option></select></div>
    <div class="field"><label for="fk-th">Thinking</label><select id="fk-th" class="select"><option>low</option><option>medium</option><option selected>high</option></select></div>
  </div>
  <div class="field"><label for="fk-msg">Message to the agent, optional</label><textarea id="fk-msg" class="textarea" rows="2">Try a server-side lock on the order id instead of an idempotency key.</textarea></div>
  <div class="fk-est">
    <p class="kpi"><b>$1.12 to $1.64</b><span>estimated, from 6 runs of fix on acme/web with this model</span></p>
    {meterrow("Job cap", "high end", 1.64/2, "$1.64", "$2.00")}
    <p class="fk-note">{ic('attention', 'ic ic--sm')}Close to the job cap. The run stops at $2.00.</p>
  </div>
  <div class="field"><span class="field__l">New branch</span>{cmd("pi/issue-415-fork-1")}</div>
  <p class="fk-note fk-note--muted">{ic('clock', 'ic ic--sm')}Edits made before entry 14 are restored from the run's checkpoint, kept 7 days.</p>
  {confirm("paid", "Preview: fork gh-b3d7", [
        "Starts a new run from <b>before entry 14</b> on <b>claude-opus-5-5</b>, thinking high",
        "Works on <b>pi/issue-415-fork-1</b>; the original pull request stays untouched",
        "Reserves <b>$2.00</b>, the job cap, before the first token. Today: $15.04 of $25.00",
        "Posts a comment on <b>acme/web#415</b> linking both attempts",
    ], "Cancel the fork run; nothing merges automatically", "Start fork")}
</section>"""
    inner = f'{tree}<div class="cols"><div class="stack">{transcript}</div><div class="stack">{form}</div></div>'
    end = '<div class="seg" role="group" aria-label="Mode"><button aria-pressed="false">Run</button><button aria-pressed="true">Fork</button></div>'
    body = shell("Runs", inner, runtitle("gh-b3d7"),
                 sub=meta(tag("web"), '<a href="#">acme/web#415</a>', badge("completed"), '<span class="faint">ended 15:52 UTC on mini1</span>'),
                 end=end, back="Runs")
    style = COMMON + """
.fk-tree { display: flex; align-items: center; }
.fk-node { display: grid; gap: 4px; width: 280px; height: 60px; padding: 9px 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.fk-node--root { box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.fk-node--live { box-shadow: inset 0 0 0 1.5px var(--running); }
.fk-n__h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fk-n__h .code { font-weight: 700; }
.fk-n__s { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fk-lines { flex: none; display: block; }
.fk-line { fill: none; stroke: var(--line-strong); stroke-width: 1.6; }
.fk-kids { display: grid; gap: 12px; }
@media (max-width: 760px) { .fk-tree { flex-direction: column; align-items: stretch; gap: 12px; } .fk-lines { display: none; } .fk-node { width: auto; height: auto; } .fk-kids { margin-left: 14px; padding-left: 16px; box-shadow: inset 2px 0 0 var(--line-strong); } }
.fk-num { display: inline-block; min-width: 30px; margin-right: 6px; font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--ink-faint); }
.fk-tx .tx__e { padding-right: 154px; }
.fk-tx .tx__e--forkpoint { padding-right: 12px; }
.fk-tx .tx__e--forkpoint .tx__t::after { content: "fork point"; display: block; margin-top: 4px; font-weight: 700; color: var(--parked-ink); }
.fk-tx .tx__fork { top: 8px; }
.fk-tx details { display: inline-block; }
.fk-tx .tx__e .tx__t { margin-right: 0; }
.fk-form { display: grid; gap: var(--space-4); }
.fk-form .card__head { margin-bottom: 0; }
.fk-point b { color: var(--ink); }
.fk-pos { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.fk-two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.fk-est { display: grid; gap: 4px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.fk-est .kpi { margin-bottom: 4px; }
.fk-est .kpi b { font-size: 28px; line-height: 32px; }
.fk-note { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--attention-ink); }
.fk-note--muted { color: var(--ink-muted); font-weight: 500; }
"""
    write("ForkRun", card_marker("Planned for 5.0.0", 1320, 1440, "Fork a run (#648): pick a transcript entry, choose a model, see the cost, start a fork on its own branch"),
          "Fork gh-b3d7", body, style)
    readme("ForkRun", """
A finished run's page in fork mode (#648): pick a transcript entry, choose the model and thinking level, see the estimated cost against the job cap, and start a fork on its own branch.

## How a person uses it
- The *Forks of this run* tree at the top shows the original run and its forks. Each node gives the fork point, the model, and the cost or elapsed time, so earlier attempts are visible before starting another.
- In the transcript, every entry has **Fork from here**. The chosen entry is ringed in violet and marked *fork point*; tool results stay folded.
- The *Fork this run* card holds the rest:
  - the chosen point, with Change;
  - before-or-at the entry;
  - the model, from the deployment's allowed models, and the thinking level;
  - an optional message to the agent;
  - the cost estimate as a range, with a bar against the job cap (attention when it nears the cap);
  - the new branch name;
  - a note that earlier edits come back from the run's checkpoint.
- **Start fork** sits behind a paid preview. The preview says what is reserved before the first token, that the original pull request is untouched, and that a comment links both attempts.

## Panels
`p-forks`, `p-transcript`, `p-fork`.

## The server provides
The promoted session's transcript entries with ids and kinds, existing forks (`fork: {fromJob, fromEntry, model}`), the allowed models, a cost estimate from past runs of the same flow and repository per model, the job cap and today's dollar window, the branch name it will use, and whether a workspace checkpoint exists for the chosen point.

## Fixture note
All fork content is sample, because forking is planned for 5.0.0: gh-b3d7 is shown as completed (in the fixture it is still running), and gh-b3d7-f1, gh-b3d7-f2, the transcript entries 10 to 18, the costs and the estimate are illustrative. Entry 14's text and the first read come from the fixture's live transcript.
""")

if __name__ == "__main__":
    run_refused(); run_parked(); parked_phone(); approval(); fork_run()
    print("parked screens written")
