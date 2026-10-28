"""Run states on the Pulse kit: RunRecovered, RunSandboxed, RunChatStates, RunViewer (work package B)."""
from pulse import *
from common2 import ICONS, S
from gen_runs import RUN_STYLE, run_title

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t, wrap=False):
    return f'<span class="code{" rx-wrap" if wrap else ""}">{E(t)}</span>'

def link(t, mono=False):
    return f'<a class="link{" rx-mono" if mono else ""}" href="#">{E(t)}</a>'

def state_row(tone, icon, word, sentence, extra=""):
    """A labelled state: a tone badge (glyph + word), then the sentence the console prints."""
    return (f'<li class="rx-state"><span class="badge tone-{tone}">{ic(icon)}{word}</span>'
            f'<p>{sentence}{(" " + extra) if extra else ""}</p></li>')

def mini_tbl(headers, rows, cls=""):
    th = "".join(f'<th scope="col"{" class=num" if n else ""}>{h}</th>' for h, n in headers)
    trs = "".join("<tr>" + "".join(f'<td{(" class=" + chr(34) + c + chr(34)) if c else ""}>{v}</td>' for v, c in r) + "</tr>" for r in rows)
    return f'<div class="tbl-wrap"><table class="tbl {cls}"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'

def lg(kind, label):
    shape = {"live": '<circle class="rx-ck" cx="7" cy="7" r="4.5"/>',
             "exit": '<circle class="rx-ck rx-ck--exit" cx="7" cy="7" r="4.5"/>',
             "skip": '<circle class="rx-ck rx-ck--skip" cx="7" cy="7" r="4.5"/>'}[kind]
    return f'<span class="rx-lg"><svg width="14" height="14" aria-hidden="true">{shape}</svg>{label}</span>'

STYLE = RUN_STYLE + """
.rx-mono { font-family: var(--font-mono); font-weight: 650; }
.rx-wrap { white-space: normal; overflow-wrap: anywhere; }
.rx-meta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rx-meta a { font-weight: 650; text-decoration: none; color: var(--ink); }
.rx-lead { display: flex; align-items: center; gap: 10px; margin-bottom: var(--space-4); padding: 12px 16px; border-radius: var(--radius-md); background: var(--tone-tint); color: var(--tone-ink); font-size: 14px; font-weight: 650; }
.rx-lead a { color: inherit; }
.rx-lead .dot { background: var(--tone); }
.rx-text { font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.rx-text b { color: var(--ink); font-weight: 650; }
.rx-text + .rx-text { margin-top: 8px; }
.rx-h3 { margin: var(--space-4) 0 8px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.rx-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin-top: var(--space-4); }
.rx-tile { display: grid; gap: 2px; padding: 12px 16px; border-radius: var(--radius-md); background: var(--surface-2); }
.rx-tile b { font-size: 22px; line-height: 28px; font-weight: 800; letter-spacing: -0.02em; }
.rx-tile span { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.rx-track { display: block; width: 100%; overflow: visible; }
.rx-ck { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.8; }
.rx-ck--exit { fill: var(--ink); stroke: var(--ink); }
.rx-ck--skip { fill: none; stroke: var(--ink-faint); stroke-dasharray: 2 2; }
.rx-l--failed { fill: var(--on-failed); }
.rx-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px; font-size: 12px; color: var(--ink-muted); }
.rx-lg { display: inline-flex; align-items: center; gap: 6px; }
.rx-calls { display: grid; gap: 4px; }
.rx-calls .rowpill { min-height: 36px; }
.rx-calls .rowpill .end { font-size: 12px; }
.rx-states { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3) var(--space-5); }
.rx-state { display: grid; gap: 6px; align-content: start; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.rx-state .badge { justify-self: start; }
.rx-state p { font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.rx-state p b { color: var(--ink); font-weight: 650; }
.rx-hosts, .rx-tools { font-size: 13px; line-height: 22px; color: var(--ink-muted); overflow-wrap: anywhere; }
.rx-hosts .code, .rx-tools .code { color: var(--ink); font-size: 12px; white-space: normal; }
.rx-vars { display: grid; gap: 6px; }
.rx-vars li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.rx-vars li .muted { font-size: 12px; }
.rx-big { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: var(--space-3); }
.rx-big b { font-size: 32px; line-height: 36px; font-weight: 800; letter-spacing: -0.02em; }
.rx-big span { color: var(--ink-muted); font-size: 13px; }
.rx-note { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.rx-note > .ic { flex: none; margin-top: 2px; }
.rx-note b { color: var(--ink); font-weight: 650; }
.rx-note + .rx-note, .rx-note + .cmd, .cmd + .rx-note, .banner + .cmd, .rx-text + .cmd, .rx-text + .rx-note, .rx-note + .rx-text { margin-top: 8px; }
.rx-split { display: grid; gap: 6px; margin-top: var(--space-3); }
.rx-split .rx-h3 { margin: 0; }
.rx-split svg { display: block; width: 100%; }
.rx-split__seg { fill: var(--running); }
.rx-split__seg--2 { fill: var(--running); opacity: .55; }
.rx-split__seg--3 { fill: var(--running); opacity: .3; }
.rx-split__key { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-muted); }
.rx-split__key b { color: var(--ink); font-weight: 650; }
.rx-children { display: grid; gap: 4px; margin-top: 6px; }
.rx-children .rowpill { min-height: 36px; }
.rx-children .rowpill a { font-family: var(--font-mono); font-weight: 650; font-size: 12px; text-decoration: none; color: var(--ink); }
.rx-tblsm td, .rx-tblsm th { padding-top: 8px; padding-bottom: 8px; }
.rx-nw { white-space: nowrap; }
.rx-model { display: grid; white-space: nowrap; font-weight: 600; }
.rx-model small { font-size: 11px; font-weight: 500; color: var(--ink-muted); }
.rx-tblsm th small { display: block; font-weight: 500; color: var(--ink-muted); }
.rx-actrow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.rx-status { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 14px; font-weight: 650; }
.rx-status .dot { background: var(--tone, var(--idle)); }
.rx-field { display: grid; gap: 6px; margin-top: 10px; }
.rx-field .textarea { min-height: 64px; }
.rx-mode .card__head { margin-bottom: var(--space-3); }
.rx-mode .card__head h2 { font-size: 15px; }
.rx-msg { font-family: var(--font-mono); font-size: 12px; font-weight: 650; }
.rx-quote { margin: 8px 0 0; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface); font-size: 13px; color: var(--ink); white-space: pre-wrap; }
.rx-meters { display: grid; gap: 8px; margin-bottom: var(--space-4); }
.rx-foot { margin-top: var(--space-3); font-size: 12px; color: var(--ink-muted); }
.rx-viewer { margin-bottom: 0; }
.rx-locked { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: var(--space-8) var(--space-5); border-radius: var(--radius-md); background: var(--surface-2); text-align: center; color: var(--ink-muted); font-size: 13px; }
.rx-locked b { color: var(--ink); font-size: 15px; font-weight: 650; }
.rx-mini .card__head h2 { font-size: 15px; }
.rx-mini .banner { margin-bottom: var(--space-3); }
.rx-confirms { display: grid; gap: var(--space-3); }
.rx-confirms .confirm { margin: 0; }
.rx-chip-warn { margin-right: 4px; height: 22px; vertical-align: 1px; }
@media (max-width: 760px) {
  .rx-track { min-width: 640px; }
  .rx-tiles { grid-template-columns: minmax(0, 1fr); }
  .rx-states { grid-template-columns: minmax(0, 1fr); }
  .rx-calls .rowpill { flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); }
  .rx-calls .rowpill .end { margin-left: 0; width: 100%; white-space: normal; }
  .rx-children .rowpill { flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius-md); }
  .rx-children .rowpill .end { margin-left: 0; }
}
"""

# =====================================================================================
# 1. RunRecovered: a durable run whose first attempt was lost and continues in recovery 1
# =====================================================================================
T0, T1 = 15 * 60, 15 * 60 + 45
def xp(hhmm):
    h, mi = map(int, hhmm.split(":"))
    return (h * 60 + mi - T0) / (T1 - T0) * 100

def attempts_track():
    a0, a1, r0, now = xp("15:01"), xp("15:19"), xp("15:21"), xp("15:39")
    grid = "".join(f'<line class="tg" x1="{xp(t):.2f}%" x2="{xp(t):.2f}%" y1="22" y2="70"/>' for t in ("15:00", "15:15", "15:30", "15:45"))
    axis = (f'<text class="tax" x="0%" y="88">15:00</text><text class="tax" x="{xp("15:15"):.2f}%" y="88" text-anchor="middle">15:15</text>'
            f'<text class="tax" x="{xp("15:30"):.2f}%" y="88" text-anchor="middle">15:30</text><text class="tax" x="100%" y="88" text-anchor="end">15:45 UTC</text>')
    cks = "".join(f'<circle class="rx-ck{(" rx-ck--" + k) if k else ""}" cx="{xp(t):.2f}%" cy="12" r="5"><title>{lab}</title></circle>'
                  for t, k, lab in [("15:05", "", "checkpoint 1, live, 15:05"), ("15:09", "", "checkpoint 2, live, 15:09"),
                                    ("15:12", "skip", "skipped at 15:12: the freeze took too long"),
                                    ("15:14", "", "checkpoint 3, live, 15:14"), ("15:19", "exit", "checkpoint 4, exit, 15:19")])
    return f"""<div class="tl-wrap"><svg class="rx-track" height="96" role="img" aria-label="Attempt 1 ran 15:01 to 15:19 UTC on mini2 and was lost after 4 checkpoints. Recovery 1 started 15:21 from checkpoint 4 and is running.">
  <rect class="tl-future" x="{now:.2f}%" y="24" width="{100 - now:.2f}%" height="46" rx="0"/>
  {grid}
  <rect class="tp--failed" x="{a0:.2f}%" y="30" width="{a1 - a0:.2f}%" height="32" rx="16"/>
  <text class="tp-l rx-l--failed" x="{a0 + 1.6:.2f}%" y="50">attempt 1, lost</text>
  <line class="gapline" x1="{a1 + .4:.2f}%" x2="{r0 - .4:.2f}%" y1="46" y2="46"/>
  <rect class="tp--run" x="{r0:.2f}%" y="30" width="{now - r0:.2f}%" height="32" rx="16"/>
  <text class="tp-l tp-l--run" x="{r0 + 1.6:.2f}%" y="50">recovery 1, running</text>
  {cks}
  <line class="tnow" x1="{now:.2f}%" x2="{now:.2f}%" y1="22" y2="70"/>
  <rect class="tnowcap" x="{now:.2f}%" y="2" width="46" height="18" rx="9" transform="translate(-23 0)"/><text class="tnowcap-t" x="{now:.2f}%" y="15" text-anchor="middle">15:39</text>
  {axis}
</svg></div>
<div class="rx-legend">{lg("live", "live checkpoint")}{lg("exit", "exit checkpoint")}{lg("skip", "skipped")}<span class="rx-lg">{ic('hourglass', 'ic ic--sm')}waited 1m 50s for a slot on mini2</span></div>"""

def recovered_story():
    calls = "".join(
        f'<li class="rowpill tone-{tone}">{ic(icon, "ic ic--sm")}<span class="code">{tool}</span><b>{word}</b><span class="end">{why}</span></li>'
        for tone, icon, tool, word, why in [
            ("ok", "rerun", "read", "replayed", "run again through the extension hooks"),
            ("ok", "rerun", "edit", "replayed", "run again through the extension hooks"),
            ("attention", "attention", "bash", "interrupted", "it may or may not have happened"),
        ])
    body = f"""{attempts_track()}
  <div class="rx-tiles">
    <div class="rx-tile"><b>4 written</b><span>checkpoints this attempt: 0 failed, 1 skipped</span></div>
    <div class="rx-tile"><b>Checkpoint 4</b><span>the exit checkpoint, taken at 15:19 UTC on mini2</span></div>
    <div class="rx-tile"><b>1 of 2</b><span>recoveries a run may have; one more is allowed if this one is lost</span></div>
  </div>
  <p class="rx-h3">Calls that were open at checkpoint 4</p>
  <ul class="rx-calls">{calls}
    <li class="rowpill">{ic('cancel', 'ic ic--sm')}<span>Not started</span><b>none</b><span class="end">calls after an interrupted one never run</span></li></ul>
  <p class="rx-note">{ic('info', 'ic ic--sm')}<span>The agent was told it restarts from checkpoint 4.</span></p>"""
    return card("Recovery", body, sub="run.recover is armed on trigger 7", id_="p-recovery")

def recovered_progress():
    rows = [("Turns", "9", "4"), ("Steps", "31", "11"), ("Failed steps", "2", "0"), ("Interrupted steps", "1", "-"),
            ("Replayed calls", "-", "2"), ("Running now", "-", '<span class="code">bash</span> for 22s')]
    tbl = mini_tbl([("", 0), ("Attempt 1 <small>record</small>", 0), ("Recovery 1 <small>live</small>", 0)],
                   [[(f'<span class="muted">{a}</span>', ""), (b, ""), (c, "")] for a, b, c in rows], "rx-tblsm")
    tools = ", ".join(f'<span class="code">{t}</span> {n}' for t, n in [("read", 14), ("edit", 9), ("bash", 6), ("grep", 2)])
    body = f"""<p class="rx-lead tone-running"><span class="dot"></span><span>This run continues as {link("gh-5d10-r2.r1", True)}.</span></p>
  {tbl}
  <p class="rx-h3">Attempt 1, steps by tool</p>
  <p class="rx-tools">{tools}</p>
  {facts([("Sum of step durations", "6m 12s"), ("Longest step", "1m 48s"), ("Longest interrupted step", "40s"), ("Last phase", "2 of 3 declared")], 2)}"""
    return card("Progress", body, end=chip("recovery live", "running", "running"), id_="p-progress")

def recovered_facts():
    pairs = [("Job", code("gh-5d10-r2")), ("Target", link("acme/api#140")), ("Forge", "github"), ("Flow", "triage"),
             ("Project", tag("api")), ("Outcome", badge("failed", "Failed, continuing")), ("Reason", code("recovery-enqueued")),
             ("Exit code", "1"), ("Attempt", "1"), ("Replica", f'2 of 2, sibling {link("gh-5d10-r1", True)} completed'),
             ("Checkpoints", "4 written, 0 failed, 1 skipped"), ("Host", "mini2"), ("Venue", venue("local")),
             ("Trigger", "7, label pi:triage"), ("Queued", "15:00:18 UTC"), ("Wait for a slot", "43s"), ("Started", "15:01 UTC"),
             ("Ended", "15:19 UTC"), ("Took", "18m"), ("Stalled re-pick", "no"), ("Read from", "the fleet's run mirror")]
    return card("Run", facts(pairs, 1), id_="p-run")

def recovered_cost():
    tbl = mini_tbl([("Attempt", 0), ("Cost", 1), ("Hold", 1)],
                   [[("Attempt 1", ""), ("$0.38", "num"), ("settled, metered", "num")],
                    [(link("Recovery 1"), ""), ('<span class="muted">running</span>', "num"), ("$2.00 held", "num")]], "rx-tblsm")
    body = f"""<p class="rx-big"><b>$0.38</b><span>spent so far, and $2.00 held for recovery 1</span></p>
  {tbl}"""
    return card("Tokens and dollars", body, id_="p-cost")

def run_recovered_page():
    sub = f'<span class="rx-meta">{tag("api")}{link("acme/api#140")}<span class="faint">triage, replica 2 of 2, on mini2</span></span>'
    oc = outcome("running", "Failed, continuing",
                 "Attempt 1 was lost on mini2; the run goes on from checkpoint 4",
                 "This attempt was lost to an infrastructure fault (exit code 1), and the run continues from its last checkpoint in a recovery job. <b>Nothing to do yet.</b> Follow the recovery job's own run.",
                 btn("Open gh-5d10-r2.r1", "primary", sm=False) + btn("Open the sibling replica", "", "chain", sm=False))
    main = f'<div class="stack">{recovered_story()}{recovered_progress()}</div>'
    side = f"""<div class="stack">{recovered_facts()}{recovered_cost()}
  <p class="collapsed" id="p-chain" data-panel>{ic('chain', 'ic ic--sm')}<b>Chain:</b> no parent and no child runs.</p></div>"""
    inner = oc + f'<div class="cols">{main}{side}</div>'
    return shell("Runs", inner, run_title("gh-5d10-r2"), sub=sub, end=badge("running", "Recovering"), back="Runs")

# =====================================================================================
# 2. RunSandboxed: an openshell-bind cron run with a secret bundle, a cost floor and chained children
# =====================================================================================
RULE_HOSTS = ["api.anthropic.com", "api.stripe.com", "github.com", "api.github.com", "registry.npmjs.org", "objects.githubusercontent.com",
              "sentry.io", "o91.ingest.sentry.io"]

def sb_facts():
    pairs = [("Job", code("repeat:billing-sweep:1759932000000", True)), ("Target", '<span class="muted">local:billing-jobs</span>'),
             ("Flow", "sweep"), ("Project", tag("billing")), ("Trigger", 'cron <span class="code">billing-sweep</span>, 14:00 daily'),
             ("Host", "mini2"), ("Venue", venue("openshell-bind")), ("Attempt", "1"), ("Exit code", "0"), ("Queued", "14:00:00 UTC"),
             ("Wait for a slot", "41s"), ("Started", "14:00:41 UTC"), ("Ended", "14:23:12 UTC"), ("Took", "22m 31s"),
             ("Steering", "not armed: its trigger sets no run.steer"), ("Live transcript", "streamed, kept 24 hours after the end"),
             ("Read from", "mini2's run history")]
    return card("Run", facts(pairs, 2), id_="p-run")

def sb_sandbox():
    hosts = ", ".join(f'<span class="code">{E(h)}</span>' for h in RULE_HOSTS) + ', and <a class="link" href="#">4 more</a>'
    body = f"""{facts([("Sandbox policy", "bind mode, 2 credential providers, 3 placeholders"),
                      ("Credentials", "held by the OpenShell layer; the agent sees placeholders, never values"),
                      ("Workspace", "not reopenable (openshell-bind has no sandbox shell)")], 1)}
  <p class="rx-h3">12 rule hosts: what the sandbox may reach</p>
  <p class="rx-hosts">{hosts}</p>"""
    return card("Sandbox", body, sub="openshell-bind on mini2", end=f'<span class="tile tile--sm tone-idle">{ic("box", "ic ic--sm")}</span>', id_="p-sandbox")

def sb_secrets():
    vars_ = "".join(f'<li>{ic("key", "ic ic--sm")}<span class="code">{k}</span><span class="muted">{w}</span></li>'
                    for k, w in [("BILLING_DB_URL", "placeholder"), ("STRIPE_TEST_KEY", "placeholder"), ("LEDGER_REGION", "value")])
    body = f"""{facts([("Secrets profile", code("prod")), ("Secret bundle", f'{code("billing")}, project {tag("billing")}')], 1)}
  <p class="rx-h3">Variables received from bundle billing</p>
  <ul class="rx-vars">{vars_}</ul>
  <p class="rx-note">{ic('attention', 'ic ic--sm')}<span><b>Shadowed by the trigger's own run.secrets:</b> <span class="code">SENTRY_DSN</span>. The trigger's value won; the bundle's was not passed.</span></p>
  <p class="rx-foot">2 as placeholders, 1 as a value.</p>"""
    return card("Secrets", body, id_="p-secrets")

def sb_chain():
    kids = "".join(f'<li class="rowpill">{ic("chain", "ic ic--sm")}<a href="#">{k}</a>{b}<span class="end"><span class="run-at">{t}</span></span></li>'
                   for k, b, t in [("chain-4be1a07c9d2e3f10", badge("completed"), "ended 14:31 UTC"),
                                   ("chain-91c0d5e2a7b84f36", badge("refused"), "ended 14:24 UTC")])
    body = f"""{facts([("Parent", "none"), ("Depth", "0"), ("Refused chain requests", '1 <span class="muted">(at most 2 per job)</span>')], 1)}
  <p class="rx-h3">Children, among the 300 newest runs</p>
  <ul class="rx-children">{kids}</ul>"""
    return card("Chain", body, sub="what this run queued from /outbox", id_="p-chain")

def sb_actions():
    body = f"""<div class="run-acts">
  <div class="run-act"><div class="run-act__h"><p><b>Fire it again by hand.</b> A cron run is re-run from its trigger as the triggers file says now.</p>{btn("Preview a re-run", "paid", "rerun", sm=False)}</div></div>
  <div class="run-act"><p class="rx-note">{ic('box', 'ic ic--sm')}<span><b>Its workspace is not reopenable</b> (openshell-bind has no sandbox shell).</span></p></div>
  <div class="run-act"><p class="rx-note">{ic('terminal', 'ic ic--sm')}<span><b>No terminal chat.</b> This run's trigger keeps no session (no run.resume), so there is no transcript to fork.</span></p></div>
</div>"""
    return card("Actions", body, id_="p-actions")

def sb_cost():
    split = f"""<div class="rx-split"><p class="rx-h3">Tokens, of which other sessions and subprocesses</p>
    <svg height="10" role="img" aria-label="Tokens: this run 380,412, other sessions 52,118, subprocesses 12,040">
      <rect class="rx-split__seg" x="0" y="0" width="85.6%" height="10" rx="5"/>
      <rect class="rx-split__seg--2" x="86%" y="0" width="11.3%" height="10"/>
      <rect class="rx-split__seg--3" x="97.6%" y="0" width="2.4%" height="10"/></svg>
    <p class="rx-split__key"><span><b>380,412</b> this run</span><span><b>52,118</b> other sessions</span><span><b>12,040</b> subprocesses, 1 not metered</span></p></div>"""
    body = f"""<p class="rx-big"><b>&ge;$1.42</b><span>metered, a floor: the meter could not see all of it</span></p>
  {meterrow("Job cap", "this run", 1.42 / 2, "&ge;$1.42", "$2.00")}
  {split}
  {facts([("Cost class", "metered, a floor"), ("Why a floor", "1 pi subprocess ran outside the meter"),
          ("Reserved", "$2.00"), ("Settled", "$2.00 (floor): the window keeps the whole hold"),
          ("Model window", "claude-sonnet-5-5, this week: $1.31 of $80.00"), ("Total tokens", "444,570"), ("Model calls", "43")], 1)}"""
    return card("Tokens and dollars", body, id_="p-cost")

def sb_models():
    def mname(p, m):
        return f'<span class="rx-model">{E(m)}<small>{E(p)}</small></span>'
    tbl = mini_tbl([("Model", 0), ("Calls", 1), ("Input", 1), ("Output", 1), ("Cost", 1)],
                   [[(mname("anthropic", "claude-sonnet-5-5"), ""), ("31", "num"), ("398,120", "num"), ("19,880", "num"), ("$1.31", "num")],
                    [(mname("anthropic", "claude-haiku-5-5"), ""), ("12", "num"), ("14,760", "num"), ("1,522", "num"), ("$0.11", "num")]],
                   "rx-tblsm")
    return card("Model usage", tbl + '<p class="rx-foot">Cache reads 1,292,523 tokens, cache writes 96,204. Priced by pi-ai 1.0.3 at stream time; 0 calls unpriced, 0 with no model resolved.</p>', id_="p-models")

def sb_resources():
    body = f"""{meterrow("Peak memory", "of the size given", 3.1 / 4, "3.1 GiB", "4.0 GiB")}
  {facts([("Size given", "4,096 MiB, 2 CPUs (default)"), ("Memory pressure", "some 1.2 s, full 0.0 s"), ("Peak swap", "0 MiB"),
          ("CPU time", "18m 40s"), ("Throttled", "3.1 s over 42 periods"), ("Out-of-memory kills", "0"), ("Peak processes", "211"),
          ("Host offered", "3 slots, 58.7 GiB, 15 of 16 CPUs")], 1)}"""
    return card("Resources", body, id_="p-resources")

def sb_session():
    return card("Session and plan", facts([("Session", "fresh: its trigger sets no run.resume"),
                                           ("Plan", "none")], 1), id_="p-session")

def run_sandboxed_page():
    sub = f'<span class="rx-meta">{tag("billing")}<span class="muted">local:billing-jobs</span><span class="faint">sweep on mini2, cron, ended 14:23 UTC</span></span>'
    oc = outcome("completed", "Completed", "Finished in 22m on mini2, in an OpenShell sandbox",
                 "It queued 2 runs from /outbox, and 1 more request was refused: a job may queue at most 2.",
                 btn("Open the children", "primary", "chain", sm=False) + btn("Preview a re-run", "paid", "rerun", sm=False))
    main = f'<div class="stack">{sb_facts()}{sb_sandbox()}{sb_secrets()}{sb_chain()}{sb_actions()}</div>'
    side = f'<div class="stack">{sb_cost()}{sb_models()}{sb_resources()}{sb_session()}</div>'
    return shell("Runs", oc + f'<div class="cols">{main}{side}</div>', run_title("billing-sweep"), sub=sub, end=badge("completed"), back="Runs")

# =====================================================================================
# 3. RunChatStates: the Chat and Inbox panels in every mode
# =====================================================================================
def status(tone, words):
    return f'<p class="rx-status tone-{tone}"><span class="dot"></span>This run is {words}.</p>'

def mode_card(title, badge_html, body, id_=""):
    return card(title, body, end=badge_html, cls="rx-mode", id_=id_)

def chat_modes():
    live = mode_card("Live", badge("running"), f"""{status("running", "running")}
  <p class="rx-text">Its live transcript is below.</p>
  <div class="rx-field"><label class="field__l" for="cs-steer">Steer: read after the agent's current tool calls</label>
    <textarea id="cs-steer" class="textarea" rows="2"></textarea></div>
  <div class="rx-actrow"><button class="btn btn--sm btn--paid" type="button">{ic('steer', 'ic ic--sm')}Preview the steer</button></div>
  <div class="rx-field"><label class="field__l" for="cs-follow">Follow-up: read once the agent would otherwise stop</label>
    <textarea id="cs-follow" class="textarea" rows="2"></textarea></div>
  <div class="rx-actrow"><button class="btn btn--sm btn--paid" type="button">Preview the follow-up</button></div>
  <p class="rx-foot">Either one spends from the run's existing reservation.</p>
  {cmd("pi-dispatch chat gh-b3d7")}""", "p-chat")
    reply = mode_card("Reply", badge("awaiting"), f"""{status("parked", "parked, waiting for an answer")}
  <p class="rx-text">Its question is the last assistant entry of its transcript below (kept 24 hours), and on {link("acme/api#131")}. An answer resumes it, as a reply there would.</p>
  <div class="rx-field"><label class="field__l" for="cs-ans">Your answer, as the reply on the issue</label>
    <textarea id="cs-ans" class="textarea" rows="3"></textarea></div>
  <div class="rx-actrow"><button class="btn btn--sm btn--answer" type="button">{ic('parked', 'ic ic--sm')}Preview the answer</button></div>
  {cmd("pi-dispatch chat gh-2f6a")}""")
    fork = mode_card("Fork", badge("completed", "Finished"), f"""{status("idle", "finished")}
  <p class="rx-text">Continue it in your own pi as a fork, on a host that holds the session store. Its transcript goes to your pi's provider unredacted.</p>
  {cmd("pi-dispatch chat gh-9575")}
  <div class="rx-note">{ic('attention', 'ic ic--sm')}<span><b>The session holds a later run's turns too.</b> {link("gh-a01c", True)} continued it on acme/web#490 after this run.</span></div>""")
    row1 = f'<div class="cards-3">{live}{reply}{fork}</div>'

    notarmed = mode_card("Not steer-armed", badge("running"), f"""{status("running", "running")}
  <p class="rx-text">This run is not steer-armed (its trigger sets no run.steer), so it takes no message; watch it instead.</p>
  {cmd("pi-dispatch chat gh-b3d7")}""")
    nosession = mode_card("No session to fork", badge("completed", "Finished"), f"""{status("idle", "finished")}
  <p class="rx-text">This run's trigger keeps no session (no run.resume), so there is no transcript to fork.</p>
  <p class="rx-text">On a pull request a fork refuses: its session cannot be found from the record.</p>""")
    readonly = mode_card("Read-only console", badge("running"), f"""{status("running", "running")}
  <p class="rx-text">This console is read-only, so it sends nothing.</p>
  {cmd("pi-dispatch chat gh-b3d7")}""")
    viewer = mode_card("Viewer", badge("running"), f"""{status("running", "running")}
  <p class="rx-note">{ic('eye', 'ic ic--sm')}<span>Chat is for operators; a viewer sees the run's status only.</span></p>""")
    row2 = f'<div class="cards-4">{notarmed}{nosession}{readonly}{viewer}</div>'
    return row1 + row2

def chat_none():
    items = [
        state_row("idle", "clock", "Queued", "This run has not started yet (its job is queued), so there is nothing to chat with until it runs."),
        state_row("idle", "hourglass", "Recovery queued", f"This run goes on as a recovery job that is queued and has not started yet, so there is nothing to chat with until it runs. The queued recovery job is {link('gh-5d10-r2.r1', True)}."),
        state_row("ok", "done", "Answered by a later run", f"This run asked a question and a later run on the same target took the answer; open that run's chat instead: {link('gh-77e0', True)}."),
        state_row("running", "running", "Being answered", f"This run asked a question and a run on the same target is queued or running now, which takes the answer; open that run's chat instead. The run taking the answer is {link('gh-81b2', True)}."),
        state_row("attention", "attention", "Unknown", "This run asked a question, but whether it still waits for an answer cannot be told right now (the run history or the queue could not be read); try again."),
        state_row("attention", "attention", "Unknown", "This run asked a question, but the queue holds too many jobs to check whether an answer is already on its way; answer it on the forge, or wait until the queue is shorter."),
        state_row("idle", "cancel", "Finished", "This run's job has ended but its record is not in this host's history or the fleet's run mirror, so there is no session to open."),
        state_row("idle", "info", "Unknown", "No run with that id is in this host's history, the fleet's run mirror or the queue."),
        state_row("attention", "attention", "Not read", "The queue could not be read (is Valkey reachable?), so whether this run can chat is unknown. The next refresh tries again."),
        state_row("refused", "refused", "Cannot answer here", "It cannot be answered from here: gh-3e71 parked on a pull request, whose reply must carry the trigger phrase (the receiver's rule: its key needs the head branch); answer on the forge."),
    ]
    return card("No chat yet, or none any more", f'<ul class="rx-states">{"".join(items)}</ul>',
                sub="the Chat panel's status line and the rule's sentence", id_="p-chat-none")

MSGS = [("9f2c41d0e7b35a18c6d2f0e94a7b1c35", "follow-up", "console", "queued", "15:36:02", "412"),
        ("3b7a0e95d21c4f6a8e0b7d93c5f2a11c", "steer", "cli", "written", "15:35:40", "1,204"),
        ("c0d8e211f5a94b7c2e6d0a8b3f1c97a4", "steer", "console", "delivered", "15:31:12", "688"),
        ("51e9b7aa0c3d2f8e6b4a1d7c9e5f200f", "follow-up", "panel", "withdrawn", "15:29:47", "530"),
        ("d77f20b4a8e1c6935f0d2b7e4a9c1e66", "steer", "forge", "delivered", "15:28:19", "578")]
MSTATE = {"queued": ("idle", "clock", "queued"), "written": ("running", "queue", "written"), "delivered": ("ok", "done", "delivered"),
          "withdrawn": ("idle", "cancel", "withdrawn"), "late": ("attention", "hourglass", "late")}

def msg_badge(s):
    t, g, w = MSTATE[s]
    return f'<span class="badge tone-{t}">{ic(g)}{w}</span>'

def msg_id(h):
    return f'<span class="rx-msg" title="{h}">{h[:8]}&hellip;</span>'

def inbox_table(rows, action=True, short=False):
    head = [("Message", 0), ("Mode", 0), ("Source", 0), ("State", 0), ("Sent", 0), ("Bytes", 1)] + ([("", 0)] if action else [])
    out = []
    for h, mode, src, st, at, b in rows:
        cells = [(msg_id(h), ""), (f'<span class="rx-nw">{mode}</span>', ""), (src, ""), (msg_badge(st), ""), (f'<span class="muted">{at[:5] if short else at}</span>', ""), (b, "num")]
        if action:
            cells.append((f'<a class="rowpill__act" href="#">Withdraw</a>' if st in ("queued", "written") else "", "act"))
        out.append(cells)
    return mini_tbl(head, out, "rx-tblsm")

def inbox_live():
    body = f"""<p class="rx-text">The run takes messages.</p>
  <div class="rx-meters">{meterrow("Messages", "withdrawn ones count", 5 / 16, "5", "16")}{meterrow("Bytes", "of the run's inbox", 3412 / 65536, "3,412", "65,536")}</div>
  {inbox_table(MSGS)}
  <p class="rx-foot">At most 8,192 bytes per message.</p>"""
    return card("Inbox", body, sub="gh-b3d7, running", id_="p-inbox")

def inbox_ended():
    rows = [("c0d8e211f5a94b7c2e6d0a8b3f1c97a4", "steer", "console", "delivered", "15:31:12", "688"),
            ("e4a6f3c29b1d07e58a2c6f4d3b9e0a9d", "follow-up", "forge", "late", "15:12:40", "301")]
    body = f"""<p class="rx-text">The job is completed, not running, so it takes no message; its inbox is kept for an hour after its run.</p>
  {inbox_table(rows, action=False)}
  <p class="rx-foot">Late: the run ended before the message arrived, so the agent never saw it.</p>"""
    return card("Inbox after the run", body, sub="gh-9575, completed")

def withdraw_previews():
    a = confirm("safe", "Withdraw message 9f2c41d0&hellip; from job gh-b3d7",
                ["It is queued: the worker has not written it into the run yet, so withdrawing it is <b>guaranteed</b> and the run never sees it."],
                "send it again", "Withdraw the message")
    b = confirm("safe", "Withdraw message 3b7a0e95&hellip; from job gh-b3d7",
                [f'<span class="chip tone-attention rx-chip-warn">{ic("attention")}best effort</span> ' + "It is already written into the run's inbox, so withdrawing it is best effort: the agent may have read it before the worker removes it. The run's transcript says whether it did."],
                "none: if the agent read it, it read it", "Withdraw the message", expires="3:18")
    done = banner("ok", "done", "Withdrawn", "Message 9f2c41d0&hellip; was queued, so the run never sees it (guaranteed).", small=True)
    return card("Withdraw", f'<div class="rx-confirms">{a}{b}{done}</div>', id_="p-withdraw")

def steer_preview():
    c = confirm("paid", "Send a steer to running job gh-b3d7, as ops",
                ["Message <span class='rx-msg'>7a1e04c2&hellip;</span>, 33 bytes. The agent reads it after its current tool calls, before its next model call.",
                 "It spends from this run's existing reservation: <b>no new reserve is taken</b>, and the run's turn, dollar and token caps still bind.",
                 "The audit log keeps the message's sha256, never its text."],
                "withdraw it while it is queued", "Send the steer",
                extra='<p class="rx-quote">Keep the button label unchanged.</p>')
    return card("Steer preview", c, sub="only the typing operator sees the text", id_="p-steer-preview")

def msg_refusals():
    items = [
        state_row("refused", "refused", "Not sent", "The run's inbox is full (at most 16 messages and 65536 bytes per run, withdrawn ones included). Nothing was sent."),
        state_row("refused", "refused", "Not sent", "The message is 9,214 bytes, above the 8192-byte limit; shorten it. Nothing was sent."),
        state_row("refused", "refused", "Not sent", "The run has finished and its inbox is closed. Nothing was sent."),
        state_row("refused", "refused", "Not sent", "The run stopped accepting messages before this one arrived (it ended, or its worker stopped refreshing it). Nothing was sent."),
        state_row("refused", "refused", "Not withdrawn", "Message c0d8e211&hellip; was already delivered: the agent has received it, so it cannot be withdrawn. Nothing was changed."),
        state_row("refused", "refused", "Not withdrawn", "Message e4a6f3c2&hellip; arrived after the run had ended (late): the agent never saw it, and there is nothing to withdraw."),
        state_row("idle", "info", "Not accepting", "The run is not accepting messages: it has not started its loop yet, it has finished, or its venue cannot deliver (bind mounts, an exit key and an image with the steer capability)."),
        state_row("attention", "attention", "Not read", "Whether the run takes messages could not be read."),
    ]
    return card("When a message is refused", f'<ul class="rx-states">{"".join(items)}</ul>', id_="p-msg-refusals")

def chat_states_page():
    inner = (chat_modes() + chat_none()
             + f'<div class="cols"><div class="stack">{inbox_live()}{inbox_ended()}</div><div class="stack">{withdraw_previews()}{steer_preview()}</div></div>'
             + msg_refusals())
    return shell("Runs", inner, "Chat and inbox", sub="What a run's Chat and Inbox panels say in each state, and every message state.", back="Runs")

# =====================================================================================
# 4. RunViewer: a live run as a viewer sees it, plus three states a viewer meets
# =====================================================================================
def v_progress():
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
  <p class="run-phase">Phase 2 of 4: 3 of 10 done</p>
  {phases(["done", "now", "next", "next"], 1, 3, 10)}
  <p class="rx-note">{ic('eye', 'ic ic--sm')}<span>Phase names and the run's note are shown to operators only.</span></p>
  <p class="run-sub">Recent steps</p>
  <ul class="rows">{rows}</ul>"""
    return card("Progress", body, end=chip("live", "running", "running"), id_="p-progress")

def v_transcript():
    body = f"""<div class="rx-locked"><span class="tile tone-idle">{ic('eye')}</span><b>Transcripts are shown to operators only.</b>
    <span>The run's messages, tool calls and results stay with operators. Its numbers are above.</span></div>"""
    return card("Live transcript", body, id_="transcript")

def v_chat():
    body = f"""{status("running", "running")}
  <p class="rx-note">{ic('eye', 'ic ic--sm')}<span>Chat is for operators; a viewer sees the run's status only.</span></p>"""
    return card("Chat", body, id_="p-chat")

def v_inbox():
    rows = [MSGS[0], MSGS[2]]
    body = f"""<p class="rx-text">The run takes messages.</p>
  {inbox_table(rows, action=False, short=True)}"""
    return card("Inbox", body, id_="p-inbox")

def v_facts():
    pairs = [("Target", link("acme/web#415")), ("Project", tag("web")), ("Flow", "fix"), ("Host", "mini1"),
             ("Venue", venue("local")), ("Model", "anthropic / claude-sonnet-5-5"), ("Queue", code("pi-jobs@mini1")), ("Started", "15:27 UTC")]
    return card("Run", facts(pairs, 1), id_="p-run")

def v_states():
    stale = card("Progress, when the worker goes quiet", f"""{banner("attention", "attention", "Stale", "Stale: no update for 4 min; the worker may be gone.", small=True)}
  {facts([("Turn", "7"), ("Steps", "12 (1 failed)"), ("Updated", "15:35 UTC")], 1)}""", end=chip("stale", "attention", "attention"), cls="rx-mini")
    noreason = card("A failed run with no reason", f"""{banner("failed", "failed", "Failed", "Failed: the run's record names no reason. The worker could not classify this infrastructure failure, and the queue retried it as far as it allows.", small=True)}
  <p class="rx-note">{ic('eye', 'ic ic--sm')}<span>Failure reasons are shown to operators only.</span></p>""", end=badge("failed"), cls="rx-mini")
    unknown = card("A reason this console does not know", f"""{banner("refused", "refused", "Refused", '<span class="code">scope-cap-window</span>, no explanation yet.', small=True)}
  <p class="rx-text">Shown as the worker wrote it.</p>""",
                   end=badge("refused"), cls="rx-mini")
    return f'<div class="sect"><h2>Three more states a viewer meets</h2></div><div class="cards-3">{stale}{noreason}{unknown}</div>'

def run_viewer_page():
    sub = f'<span class="rx-meta">{tag("web")}{link("acme/web#415")}<span class="faint">fix on mini1, started 15:27 UTC</span></span>'
    note = banner("idle", "eye", "Signed in as a viewer",
                  "You see this run's status and numbers. Transcripts, chat, phase names, the run's note, failure reasons and every action are for operators.", small=True)
    main = f'<div class="stack">{v_progress()}{v_transcript()}</div>'
    side = f'<div class="stack">{v_chat()}{v_inbox()}{v_facts()}</div>'
    inner = note + f'<div class="cols">{main}{side}</div>' + v_states()
    return shell("Runs", inner, run_title("gh-b3d7"), sub=sub, end=badge("running"), back="Runs", role="viewer")

# =====================================================================================
README = {
"RunRecovered": """A durable run whose first attempt was lost: the outcome says it goes on, a track shows the attempt, its checkpoints and the recovery, and the side column keeps the facts and what each attempt spent.

**How a person uses it.**
- The outcome reads "Failed, continuing" with the running glyph, because the run is not over. Its one action opens the recovery job.
- *Recovery* draws the run on one track (15:00 to 15:45 UTC):
  - attempt 1 as a red pill;
  - its checkpoints as markers above it: live, exit, and the skipped one;
  - the wait for a slot as a dotted gap;
  - recovery 1 running up to the now line.
- Under the track:
  - three tiles: checkpoints written, failed and skipped; which checkpoint it resumed from; recovery 1 of at most 2;
  - what happened to the calls that were open at the checkpoint: replayed, interrupted (may or may not have happened), not started;
  - one line saying the agent was told it restarts from checkpoint 4.
- *Progress* starts with "This run continues as gh-5d10-r2.r1." It then sets attempt 1's record beside the recovery's live numbers, and shows steps by tool.
- *Run* adds the record fields the old page did not show:
  - replica 2 of 2 with its sibling;
  - queued time and the wait for a slot;
  - stalled re-pick;
  - checkpoints.
- *Tokens and dollars* lists each attempt's cost or hold.
- *Chain* is one line: no parent and no child runs.

**Panels.** `p-outcome`, `p-recovery`, `p-progress`, `p-run`, `p-cost`, `p-chain` (one line).

**The server provides.**
- From the run record: `recovered {from, n, fromAttempt, checkpointSeq, replayed, interrupted, notStarted}`, `checkpoints {written, failed, skipped}`, `recoveryOf`, `replica` and `replicas`, `queuedAt`, `stalledRepick` and `earlier[]`.
- The recovery job's id and state from the queue.
- Live progress, including `replayed`.
- The tool name of each call that was open at the checkpoint, from the transcript, for operators only.
- The catalog sentences for `recovery-*` and the recovery-skipped reasons.

**Why it works this way.**
- The agent is told what was restored: the workspace at checkpoint 4, with `.pi/`, `.agents/` and the root context files reset to the base commit. It checks before repeating anything with outside effects.
- A durable run can hold up to four per-job caps: two queue attempts and two recoveries. Each settles on its own.
- A forge run has no /outbox, so it has no parent and no child runs.
- The same outcome banner and Run facts read differently on other durable runs. Each sentence is the catalog's:
  - Failed, `recovery-failed`: "Failed: this run was lost, continued from its checkpoint, and the continuation was lost too, so it is not continued again. Partial work may exist."
  - Failed, `recovery-host-lost`: "Failed: this run stopped on a worker that has not come back, and its checkpoint lives on that worker, so it could not be continued and will not be retried further."
  - Refused, `recovery-cap`: "Failed: this run was lost and continued from its checkpoint as many times as allowed, so it is not continued again."
  - Refused, `recovery-checkpoint-absent`: "Failed: this run was lost, and its checkpoint could not be used to continue it (absent, damaged, or taken on another host, pi version or venue)."
  - Refused, `recovery-unsafe-extensions`: "Failed: this run was lost, and it is not continued from its checkpoint because the repository's `.pi/extensions/` could load code the agent wrote."
  - Not run, `recovery-superseded`: "Not run: the run this recovery would continue had already reached its final outcome, so there was nothing left to continue."
  - Recovery skipped, `workspace-extensions`: "Recovery: skipped (workspace-extensions): the repository's base commit holds `.pi/extensions/`, whose imports could load code the agent wrote, so the run was not armed for recovery."
  - Recovery queued: "This run goes on as a recovery job that is queued and has not started yet. It waits for its checkpoint's host for 6 hours, longer while that host is alive, and 7 days at most."
  - Retried: "An earlier attempt of this run ended (failed); this is the attempt after it. Earlier attempt: mini1, 14:10 to 14:12 UTC."
  - Re-picked: "The first attempt stalled (its worker stopped answering), and this pickup ran it again. Stalled re-pick: yes."

**Fixture note.** All of it is sample: gh-5d10-r2, its sibling gh-5d10-r1, acme/api#140, trigger 7 (pi:triage, which the fixture gives two replicas and recovery), the times, the checkpoint markers, the costs, and the earlier attempt on mini1. The sentences are the catalog's (`recovery-enqueued`, `recovery-failed`, `recovery-host-lost`, `recovery-cap`, `recovery-checkpoint-absent`, `recovery-unsafe-extensions`, `recovery-superseded`, `workspace-extensions`). The checkpoint markers' times are illustrative: the record keeps only counts.""",

"RunSandboxed": """A completed run in an OpenShell sandbox, with a project secret bundle, a cost that is only a floor, per-model usage, and two chained children.

**How a person uses it.**
- The outcome says it finished and what it queued. Its actions open the children or preview a re-run (paid).
- *Run* covers:
  - the cron job id, which wraps rather than overflows;
  - the queued time and the wait for a slot;
  - steering and the live transcript, in words.
- *Sandbox* shows:
  - the policy (mode, credential providers, placeholders);
  - who holds the credentials;
  - that the workspace cannot be reopened;
  - the rule hosts as a list of names, with the rest counted behind a link.
- *Secrets* names the profile and the bundle, and lists the variables received, each marked placeholder or value. The shadowed name gets its own sentence.
- *Chain* gives the parent, depth and refused requests, and lists the children found among the newest runs, each with its outcome badge.
- *Actions* offers the re-run of a cron run, and says there is no sandbox shell and no terminal chat.
- The side column:
  - "≥$1.42" with its class ("metered, a floor") and why;
  - the settled basis;
  - the token split between this run, other sessions and subprocesses;
  - per-model usage rows;
  - resources, including memory pressure, swap and what the host offered at admission;
  - the session.

**Panels.** `p-outcome`, `p-run`, `p-sandbox`, `p-secrets`, `p-chain`, `p-actions`, `p-cost`, `p-models`, `p-resources`, `p-session`.

**The server provides.**
- The run record: `openshell {mode, ruleHosts, ruleHostCount, providers, placeholders}`, `secretsProfile`, `bundle {id, variables, shadowed, placeholders, plain}`, `bundleSkipped`, `liveSkipped`, `steerSkipped`.
- Tokens: the split keys, `unmeteredChildren`, `usage.models[]` and `dollars {reservedMicros, settledMicros, basis}`.
- `resources`, `size`, `capacity`, `session`, `plan`, `parentJobId`, `chainDepth` and `chainRefused`.
- The children, from a search of the newest runs.

**Why it works this way.**
- Secret names only: no secret value reaches a log, a record or this page.
- The session is fresh because the trigger does not set run.resume, so the job did not continue a saved conversation.
- On other runs the same Run rows say why a part was skipped, each with its token:
  - Live transcript, none (`venue-copies`): its venue copies the job's files and does not stream the transcript back.
  - Live transcript, none (`no-capability`): its venue streams the transcript only from a job image that declares transcriptStderr, and this one does not.
  - Steering, skipped (`venue-copies`): its venue copies the job's files (no /inbox mount) and its job image does not declare steerStdin, so no message could reach the run.
  - Steering, skipped (`no-exit-key`): its job image does not declare exitAuth, so no delivery could be verified.
  - Bundle skipped (`fork`): a pull request from another repository, and the bundle does not set forkReviews.
  - Bundle skipped (`chained`): a chained /outbox child, so it got no bundle: the grant was to the trigger, not to what its job queues.
  - Rule hosts, no rule host: the sandbox reaches nothing.

**Fixture note.** All of it is sample: the billing-sweep cron trigger, the billing-jobs folder as a billing member, the variable names, the rule hosts, the token and cost figures, and the two chain children. The skip sentences and the chain cap (2 per job) are the repo's.""",

"RunChatStates": """The Chat and Inbox panels in every state a run can be in, so each sentence has a designed place.

**How a person uses it.**
- **Modes** (first row):
  - **Live**: the steer and follow-up forms. Both are paid, because they spend from the run's existing reservation.
  - **Reply**: the answer box for a parked run.
  - **Fork**: the terminal command for a finished run that kept a session, warning when a later run's turns are in it too.
- **Forms that do not apply** (second row): not steer-armed, no session to fork, a read-only console, and a viewer.
- **No chat yet, or none any more**: the status words and the rule's sentence for queued, recovery queued, answered, being answered, the two unknowns, no record, no run, the queue unreadable, and a pull-request park that must be answered on the forge.
- **Inbox**: limit meters (16 messages, 65,536 bytes), then a table of messages with id, mode, source, state, time and bytes, and the 8,192 byte limit per message.
  - States: queued, written, delivered, withdrawn and late, each a glyph and a word.
  - Withdraw only on queued and written rows.
  - The ended run's inbox shows the late state.
- **Withdraw**: two previews, guaranteed (queued) and best effort (written), and the result line.
- **Steer preview**: the paid confirm. It says no new reserve is taken and shows the operator's own text.
- **When a message is refused**: each refusal and inbox status sentence.

**Panels.** `p-chat`, `p-chat-none`, `p-inbox`, `p-withdraw`, `p-steer-preview`, `p-msg-refusals`. On a run page only one Chat and one Inbox state shows at a time.

**The server provides.**
- From `/api/run`: `state`, `mode`, `says`, `activeJobId`, `steer {armed, open}`, `newerRunOnTarget` and `pendingRunOnTarget`.
- Inbox rows `{id, mode, source, state, at, bytes}`.
- The steer, answer and withdraw previews from the action pipeline.

**Why it works this way.**
- A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop. Either one spends from the run's existing reservation.
- A message's text is never listed: the run reads it, and the audit log keeps its sha256.
- A fork runs on a host that holds the session store (`PI_SESSIONS_DIR`). The session's transcript is not redacted and goes to the person's own pi provider; the run's own transcript is never written.
- On a pull request a fork refuses because a pull or merge request's session is keyed by its head branch, which the run record does not carry.

**Fixture note.** Message ids, times, byte counts, gh-77e0, gh-81b2, gh-a01c and gh-3e71 are sample. The sentences are the console's (`chat-mode.mjs`, `steer-inbox.mjs`, `job-actions.mjs`).""",

"RunViewer": """The live run gh-b3d7 as a viewer sees it: status and numbers only, with a plain line where operator-only parts would be.

**How a person uses it.**
- A small banner says they are signed in as a viewer and what that hides.
- *Progress* keeps:
  - the elapsed time, turn and steps;
  - the tool running now;
  - "Phase 2 of 4: 3 of 10 done" on numbered phase bars;
  - recent steps by tool name.

  Phase names and the note are replaced by one line.
- *Live transcript* holds a single locked state: "Transcripts are shown to operators only."
- *Chat* gives the status and "Chat is for operators; a viewer sees the run's status only."
- *Inbox* lists ids, modes, sources, states, times and bytes, with no Withdraw.
- There is no Cancel, no re-run, no command to copy, and no Audit in the More menu.
- *Three more states a viewer meets*:
  - stale progress;
  - a failed run whose record names no reason (the queue's failure text is operator-only);
  - a reason token this console does not know yet, shown as written with "no explanation yet".

**Panels.** `p-progress`, `transcript`, `p-chat`, `p-inbox`, `p-run`.

**The server provides.** The same data as for an operator, minus everything model-written: no phase names, no note, no transcript, no failure text, no forms. The privacy split happens on the server, not in CSS.

**Why it works this way.**
- A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop.
- A message's text is never listed, for any role: the run reads it, and the audit log keeps its sha256.
- A reason a newer worker wrote that this console has no sentence for is shown as its token, as written. An outcome it does not know shows with the failed glyph.

**Fixture note.** gh-b3d7's progress and steps are the fixture, as on RunLive. The inbox rows, the stale time, the failed run and the token `scope-cap-window` are sample.""",
}

HEIGHTS = {"RunRecovered": 2340, "RunSandboxed": 2570, "RunChatStates": 3230, "RunViewer": 1590}

if __name__ == "__main__":
    write("RunRecovered", card_marker("Runs", HEIGHTS["RunRecovered"], 1440, "A durable run: attempt 1 lost, its checkpoints, and recovery 1 carrying it on"),
          "Run gh-5d10-r2, recovering", run_recovered_page(), STYLE)
    write("RunSandboxed", card_marker("Runs", HEIGHTS["RunSandboxed"], 1440, "An OpenShell run: sandbox policy, rule hosts, secret bundle names, a cost floor and chained children"),
          "Run billing-sweep, sandboxed", run_sandboxed_page(), STYLE)
    write("RunChatStates", card_marker("Runs", HEIGHTS["RunChatStates"], 1440, "Chat and Inbox in every state: modes, refusals, message states, withdraw and steer previews"),
          "Chat and inbox states", chat_states_page(), STYLE)
    write("RunViewer", card_marker("Runs", HEIGHTS["RunViewer"], 1440, "A live run as a viewer sees it: numbers only, operator parts named, no actions"),
          "Run gh-b3d7, as a viewer", run_viewer_page(), STYLE)
    for n, t in README.items():
        readme(n, t)
    print("runs2 written")
