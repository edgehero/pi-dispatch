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
  <p class="pp-where">{ic('info', 'ic ic--sm')}<span>The question is the run's last message: read it on <a class="link" href="#">acme/api#131</a>, or on <a class="link" href="#">its run page</a> while its transcript is kept (24 hours after the run).</span></p>
  <label class="sr" for="pp-a">Your answer</label>
  <textarea id="pp-a" class="textarea" rows="3" placeholder="Write your answer"></textarea>
  <div class="pp-act">{btn("Preview answer", "answer", "parked", sm=False)}{btn("Open run", "ghost", sm=False)}</div>
  <p class="pp-hint">Posted to acme/api#131 after you confirm. It resumes the run.</p>
</section>"""
    a = f"""<p class="pp-sect">1 approval also waits</p>
<section class="card pp-card pp-appr" id="p-approvals" data-panel aria-labelledby="pp-ap">
  <p class="pp-top"><span class="tile tile--sm tone-parked">{ic('shield', 'ic ic--sm')}</span><b id="pp-ap"><span class="code">gh-7b21</span> asks to raise its run cap</b><span class="pp-wait">12m</span></p>
  <p class="pp-meta">{tag('web')}<a class="link" href="#">acme/web#415</a><span>budget-raise</span></p>
  <p class="pp-risk">{ic('shield', 'ic ic--sm')}Worker-enforced: the declared cap only after approval.</p>
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
.pp-where { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-md); background: var(--parked-tint); font-size: 13px; line-height: 20px; }
.pp-where .ic { flex: none; margin-top: 3px; }
.pp-act { display: flex; gap: 6px; flex-wrap: wrap; }
.pp-act .btn { flex: 1 1 auto; }
.pp-act .btn--ghost { flex: 0 0 auto; }
.pp-hint { font-size: 12px; color: var(--ink-muted); }
.pp-sect { margin: 6px 4px 0; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.pp-risk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); }
.seg b { font-weight: 800; }
"""
    write("ParkedPhone", card_marker("Screens, phone", 1300, 390, "Parked on a phone: who asks and where to read the question, the answer box, one tap to preview"),
          "Parked on a phone", body, style)
    readme("ParkedPhone", """
The Parked page at phone width: each parked run is a card with who asks, its target and wait time, where to read the question, and an answer box one tap from the preview.

## How a person uses it
- The person opens the console from a notification. Questions and approvals share the inbox and its count.
- The question card shows who asked, the project and target, how long it has waited, and where to read the question: on its issue or pull request, or on its run page while its transcript is kept.
- **Preview answer** opens the same two-step confirm as the run page. Nothing is posted until they confirm.
- Below the questions, a compact card shows the approval that also waits (#649): the action, the target, the risk line, and Approve or Decline as full-width buttons.
- Everything fits 390px with no sideways scroll; the nav pills scroll inside their own row.

## Panels
`p-questions`, `p-approvals`.

## The server provides
Parked runs (questions and approval requests) with their target, project and wait time, and whether an answer can be built here. Never the question or the gate's text.

## Why it works this way
The question is the run's last message, text a run wrote after reading issue text. The console shows it on the run page and nowhere else (REQ-CONSOLE-SECURITY (l)), so this card says where to read it, as the shipped page does.

## Fixture note
From the fixture: gh-2f6a, acme/api#131, triage on mini1, parked 26 minutes. The budget-raise approval is sample content. Approval controls are built by #649.
""")

# ======================================================================
# 4. Approval request (#649)
# ======================================================================
SEG_A = '<div class="seg" role="group" aria-label="Show"><button aria-pressed="false">Questions <b>1</b></button><button aria-pressed="true">Approvals <b>2</b></button></div>'

def approval():
    main = f"""<section class="card card--ring tone-parked" id="p-questions" data-panel>
  <div class="card__head"><span class="tile tone-parked">{ic('shield')}</span><h2><span class="code">gh-3c90</span> asks</h2><span class="end">{chip('waiting 12m', 'parked', 'clock')}</span></div>
  <p>{tag('billing')} acme/billing#261</p>
  <p>Awaiting approval for <span class="code">budget-raise</span>.</p>
  <p>Worker-enforced: approval permits the declared run cap, subject to deployment and scoped budgets.</p>
  <p class="muted">Read the agent's request on its issue or on its run page. Model text is never copied into this inbox.</p>
  <div class="stack">{btn('Preview approval', 'primary', 'done', sm=False)}
    <label for="approval-reason">Reason for declining (optional)</label><textarea id="approval-reason" class="textarea" rows="2" placeholder="Why should the agent change course?"></textarea>
    {btn('Preview decline', 'danger', sm=False)}
    <label for="approval-question">Your question</label><textarea id="approval-question" class="textarea" rows="3" placeholder="Write your question"></textarea>
    {btn('Preview the answer', 'answer', 'comment', sm=False)}
    <p class="muted">Ask a question back: the run resumes with your question and no approval is granted.</p>
  </div>
</section>"""
    how = card("How decisions work", "<p>Every decision previews and confirms through the existing audited answer action. The run resumes in a new container after all budget and policy checks.</p><p>External actions such as deploy:staging are advisory. Push to the default branch and PR-open gates are refused until they can be enforced.</p>")
    body = shell("Parked", f'<div class="cols"><div class="stack">{main}</div><div class="stack">{how}</div></div>', "Parked", sub="Runs that stopped to wait for a person", end='<span class="muted">1 question, 2 approvals</span>', parked=3)
    write("ApprovalRequest", card_marker("Screens", 1200, 1440, "Approval gates (#649): preview an approval, decline or question"), "Parked, approvals", body, COMMON)
    readme("ApprovalRequest", """
The Parked page shows typed approval requests alongside parked questions. The gate action and its enforcement boundary are visible; the agent's summary stays on its issue and run transcript.

## How a person uses it
- Read the request on the forge or run page, then preview approval, preview a decline with an optional reason, or ask a question.
- Every choice uses the existing audited preview and confirmation action. A question resumes the agent without granting approval.
- Budget raises use the trigger's declared cap within deployment and scoped limits. External actions are advisory. Default-branch pushes and PR-open gates are refused until they can be enforced.
- Viewers and read-only consoles show the request without decision controls.

## Panels
`p-questions`.

## The server provides
Run id, target, project, parked time, declared gate action and whether the existing answer planner permits a reply. Model text is never stored in the run record or copied into the inbox.

## Fixture note
The budget-raise request is illustrative. The production inbox uses the existing question-card and answer-form kit, and shows both request kinds together rather than hiding either behind a tab.
""")

# ======================================================================
# 5. Fork a run (#648)
# ======================================================================
def fork_run():
    from gen_runs import fork_controls
    inner = card("Actions", fork_controls(), id_="p-actions")
    body = shell("Runs", inner, runtitle("gh-9575"),
                 sub=meta(tag("web"), '<a href="#">acme/web#490</a>', badge("completed"), '<span class="faint">ended 15:12 UTC on mini1</span>'), back="Runs")
    write("ForkRun", card_marker("Runs", 1000, 1440, "Managed fork controls on a finished run: a saved point, a permitted model, and a paid preview"), "Fork gh-9575", body, COMMON)
    readme("ForkRun", """
# Fork a run

The operator's managed fork controls in the finished run's Actions panel, built by #648.

## How a person uses it

Choose a saved entry and position. Before the first user message uses the run's original base. Other offered points have an exact retained workspace snapshot. Optionally choose a provider, permitted model, supported thinking level and follow-up message, then preview the reservation before confirming a separate paid job and branch. The original attempt remains unchanged.

Unavailable, expired, unsupported-venue and unsafe sources show their named reason. Viewer pages expose no fork action or entry metadata. Source text and filesystem paths never enter this form.

## Panels

`p-actions`, embedded in the run page.

## The server provides

Run identity and safe entry positions from an immutable source, current model policy, the reservation estimate and a single-use paid confirmation. The worker rechecks the source and current trigger at pickup.

## Fixture note

The run is the completed gh-9575 on acme/web#490. Entry identifiers and saved positions illustrate the control; no raw transcript or provider call is used by this card.
""")

if __name__ == "__main__":
    run_refused(); run_parked(); parked_phone(); approval(); fork_run()
    print("parked screens written")
