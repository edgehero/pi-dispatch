"""Fleet, more states: the fleet part paused, one venue in full, one host in full. Pulse kit, sibling of gen_fleet.py."""
from pulse import *
from common2 import ICONS, S

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

# ---- helpers copied from gen_fleet.py (it writes its pages at import, so it is not imported) ----
def table(headers, rows, cls="tbl", caption=""):
    th = "".join(f'<th scope="col"{(" class=" + chr(34) + c + chr(34)) if c else ""}>{h}</th>' for h, c in headers)
    trs = []
    for r in rows:
        rcls = ""
        if isinstance(r, tuple):
            rcls, r = r
        tds = "".join(f'<td{(" class=" + chr(34) + c + chr(34)) if c else ""}>{v}</td>' for v, c in r)
        trs.append(f'<tr{(" class=" + chr(34) + rcls + chr(34)) if rcls else ""}>{tds}</tr>')
    cap = f'<caption class="sr">{caption}</caption>' if caption else ""
    return f'<div class="tbl-wrap"><table class="{cls}">{cap}<thead><tr>{th}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>'

def state(s):
    return {"running": chip("Running", "ok", "play"), "paused": chip("Paused", "attention", "pause")}[s]

def num(v):
    return f'<span class="faint">0</span>' if v == 0 else f"<b>{v}</b>"

def check(level, code, said, fix):
    tone, icon, word = {"failing": ("failed", "failed", "Failing"), "warning": ("attention", "attention", "Warning")}[level]
    return f"""<li class="fl-chk tone-{tone}">
  <span class="badge tone-{tone}">{ic(icon)}{word}</span><span class="code">{code}</span>
  <span class="fl-chk__said">{said}</span>
  <span class="fl-chk__fix"><b>Fix:</b> {fix}</span>
</li>"""

def counts(f, w, p):
    return (f'<span class="fl-cnt"><span class="tinted tone-failed">{ic("failed", "ic ic--sm")}<b>{f}</b> failing</span>'
            f'<span class="tinted tone-attention">{ic("attention", "ic ic--sm")}<b>{w}</b> warning</span>'
            f'<span class="tinted tone-ok">{ic("done", "ic ic--sm")}<b>{p}</b> passing</span></span>')

def word(v):
    """Venue declaration word: glyph + word, never colour alone."""
    if v == "enforced":
        return f'<span class="chip tone-ok vw">{ic("shield")}enforced</span>'
    if v == "asserted":
        return f'<span class="chip vw vw--asserted">{ic("done")}asserted</span>'
    return f'<span class="chip vw vw--absent">{ic("minus")}absent</span>'

def serves_word(v):
    if v == "yes":
        return f'<span class="chip tone-ok vw">{ic("done")}yes</span>'
    if v == "image":
        return f'<span class="chip vw vw--asserted">{ic("layers")}with the image</span>'
    return f'<span class="chip vw vw--absent">{ic("minus")}no</span>'

def code(t):
    return f'<span class="code">{E(t)}</span>'

BASE_CSS = """
.fl-bar { display: grid; gap: var(--space-4); }
.fl-bar__row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.fl-bar__t { min-width: 0; flex: 1 1 340px; }
.fl-bar__t h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.fl-bar__t .muted { font-size: 13px; }
.fl-bar__stats { display: flex; gap: 6px; flex-wrap: wrap; }
.fl-bar__stats > span { display: inline-flex; gap: 5px; height: 34px; padding: 0 14px; align-items: center; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.fl-bar__stats b { color: var(--ink); font-size: 15px; }
.fl-bar__stats .tinted b { color: var(--tone-ink); }
.fl-bar__btns { display: flex; gap: 8px; flex-wrap: wrap; }
.fl-doc__h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; }
.fl-cnt { display: inline-flex; gap: 12px; font-size: 12px; flex-wrap: wrap; }
.fl-cnt > span { display: inline-flex; align-items: center; gap: 4px; }
.fl-chks { display: grid; gap: 4px; }
.fl-chk { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.fl-chk .code { font-size: 12px; color: var(--ink-muted); }
.fl-chk__said { min-width: 0; }
.fl-chk__fix { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; }
.fl-chk__fix b { color: var(--ink); }
.vw .ic { width: 13px; height: 13px; }
.vw--asserted { background: var(--surface-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.vw--absent { background: transparent; color: var(--ink-muted); box-shadow: none; border: 1px dashed var(--line); }
.lead-s { font-size: 13px; line-height: 20px; color: var(--ink-muted); max-width: 820px; }
.mini-list { display: grid; gap: 6px; font-size: 13px; }
.mini-list li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
.mini-list li > .ic { margin-top: 2px; color: var(--tone-ink, var(--ink-muted)); }
.mini-list small { display: block; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.sect-h { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: var(--space-4) 0 var(--space-2); }
.sect-h:first-child { margin-top: 0; }
.pp-pad { padding: 0 var(--space-5) var(--space-5); }
.pp-pad .confirm { margin-top: var(--space-3); }
@media (max-width: 760px) {
  .pp-pad { padding: 0 var(--space-4) var(--space-4); }
  .fl-bar__t { flex-basis: 100%; }
  .fl-chk { grid-template-columns: auto minmax(0, 1fr); }
  .fl-chk__said { grid-column: 1 / -1; }
}
"""

# =====================================================================================
# 1. FLEET, PART PAUSED
# =====================================================================================
VK_SHELL = "redis://127.0.0.1:6399/0"
VK_FILE = "redis://127.0.0.1:6379/0"

PP_BAR = f"""<section class="card fl-bar card--ring tone-attention" id="p-fleetbar" data-panel aria-labelledby="pp-bar-h">
  <div class="fl-bar__row">
    <span class="tile tone-attention">{ic('pause')}</span>
    <div class="fl-bar__t"><h2 id="pp-bar-h">Part paused: 2 of 4 queues are paused</h2>
      <p class="muted">Some hosts' queues are paused and others are not. Nothing new starts on <span class="code">pi-jobs@build3</span> or <span class="code">pi-jobs@mini2</span>; <span class="code">pi-jobs</span> and <span class="code">pi-jobs@mini1</span> keep starting jobs.</p></div>
    <div class="fl-bar__stats">
      <span><b>0</b> waiting</span><span class="tinted tone-attention"><b>3</b> in paused queues</span><span><b>2</b> active</span><span><b>6</b> delayed</span><span><b>2</b> held</span><span class="tinted tone-failed"><b>2</b> awaiting retry</span>
    </div>
    <div class="fl-bar__btns">
      <button class="btn btn--paid" type="button" aria-expanded="true">{ic('play', 'ic ic--sm')}Resume the fleet</button>
      <button class="btn btn--danger" type="button">{ic('pause', 'ic ic--sm')}Pause the fleet</button>
    </div>
  </div>
  {banner("attention", "attention", "Two Valkeys: this console and the service disagree",
          f"VALKEY_URL is {code(VK_SHELL)} in this shell and {code(VK_FILE)} in …/pi-dispatch/.env (what the service uses). A pause reaches both. A resume reaches neither until they agree.", small=True)}
  <div class="pp-refusal tone-refused" role="region" aria-live="polite" aria-label="Preview">
    <p class="pp-refusal__h">{ic('refused')}Refused: Resume the fleet</p>
    <p>VALKEY_URL is {code(VK_SHELL)} in this shell and {code(VK_FILE)} in …/pi-dispatch/.env (what the service uses): resume would start jobs on one of them, so it resumes neither. Make them agree (the .env is what the service reads), or run:</p>
    {cmd("pi-dispatch resume --valkey-url " + VK_FILE)}
    <p class="pp-refusal__f"><b>Nothing was changed.</b> A single queue can still be resumed below: it is named on the Valkey this console read it from.<button class="btn btn--sm btn--ghost" type="button">Close</button></p>
  </div>
  <p class="pp-src">{ic('beat', 'ic ic--sm')}<span>Read 2s ago from <span class="code">{VK_SHELL}</span> and 3 hosts' registry rows. Live: this panel redraws when the fleet changes.</span></p>
</section>"""

PP_QROWS = [("pi-jobs", "shared by 3 hosts", "running", 0, 1, 4, 0, 2),
            ("pi-jobs@build3", "build3's own; build3 still takes shared jobs", "paused", 0, 1, 0, 2, 0),
            ("pi-jobs@mini1", "mini1", "running", 0, 0, 1, 0, 0),
            ("pi-jobs@mini2", "mini2's own; mini2 still takes shared jobs", "paused", 0, 0, 1, 1, 0)]

def qact(st, q):
    return btn("Resume", "paid", "play") if st == "paused" else btn("Pause", "danger", "pause")

PP_QUEUES = card("Queues", table(
    [("Queue", ""), ("State", ""), ("Waiting", "num"), ("Active", "num"), ("Delayed", "num"), ("Paused", "num"), ("Failed", "num"), ("", "act")],
    [((("row--attention") if st == "paused" else ""),
      [(f'<span class="code"><b>{q}</b></span><span class="reason">{sub}</span>', "id"), (state(st), ""), (num(w), "num"), (num(a), "num"), (num(d), "num"),
       (num(p), "num"), (f'<b class="tinted tone-failed">{f}</b>' if f else num(0), "num"), (qact(st, q), "act")])
     for q, sub, st, w, a, d, p, f in PP_QROWS], caption="Queues")
    + f'<div class="pp-pad">' + confirm("paid", "Resume pi-jobs@build3",
        ["Resume queue <span class='code'>pi-jobs@build3</span>: its queued jobs start again.",
         "2 job(s) wait to start in it (pi-jobs@build3): each reserves up to its own per-job dollar cap, and one job slot, when a worker picks it up, so no single reserve figure applies.",
         f"Valkey <span class='code'>{VK_SHELL}</span>, where this queue's paused flag was seen. Audited as <b>queue-resume</b>."],
        "Pause queue pi-jobs@build3", "Resume pi-jobs@build3") + "</div>",
    end='<span class="card__sub">A paused queue starts nothing new; its running jobs finish</span>', id_="p-queues", flush=True)

PP_HELD = card("Held", table(
    [("Job", ""), ("Project", ""), ("Target", ""), ("Waiting for", ""), ("Held for", "num"), ("Checks", "num"), ("", "act")],
    [[('<a href="#">gh-77c1</a>', "id"), (tag("web"), ""), ('<a href="#">acme/web#415</a>', "tgt"),
      (f'{code("after 2026-10-09T07:00:00Z + ci-green")}<span class="reason">After a time, then a check named ci-green</span>', ""), ("2h 14m", "num"), ("14 <span class='faint'>of 96</span>", "num"), (btn("Cancel", "danger"), "act")],
     [('<a href="#">gh-91a0</a>', "id"), (tag("api"), ""), ('<a href="#">acme/api#140</a>', "tgt"),
      (f'{code("jira")}<span class="reason">The jira check answers "not yet". 1 check could not tell (5 in a row ends the wait)</span>', ""), ("6h 2m", "num"), ("38 <span class='faint'>of 96</span>", "num"), (btn("Cancel", "danger"), "act")]],
    caption="Held jobs")
    + '<p class="pp-foot">A job starts when every condition is met. Checks spend nothing. A check profile gives up after 24 hours or 96 checks (refused: <span class="code">wait-expired</span>); a cancelled held job spent nothing while it waited.</p>',
    end=btn("Cancel all held", "danger"), sub="2 jobs, longest wait first", id_="p-held", flush=True)

FAILED_ROWS = [
    ("gh-5d10", "pi-jobs", "3", "12:39 UTC", '<span class="faint">no target recorded</span>', "Failed: the job image is missing on the host, so the container never started."),
    ("gh-6e21", "pi-jobs", "2", "13:58 UTC", '<a href="#">acme/web#418</a>', "Failed: the worker lost the job twice (it stalled), so the queue gave up."),
]
PP_FAILED = card("Failed jobs", table(
    [("Job", ""), ("Queue", ""), ("Target", ""), ("Attempts", "num"), ("Failed", ""), ("", "act")],
    [[(f'<a href="#">{j}</a><span class="reason pp-wrap">Its run record says: {E(why)}</span>', "id"), (code(q), ""), (t, "tgt"), (f"<b>{a}</b>", "num"), (at, "when"),
      (f'{btn("Retry", "paid", "rerun")} {btn("Remove", "danger")}', "act")] for j, q, a, at, t, why in FAILED_ROWS], caption="Failed jobs")
    + f"""<div class="pp-pad pp-bulk">
  <p class="sect-h">Retry or remove failed jobs in bulk</p>
  <div class="pp-bulk__row">
    <label class="field"><span>Only queue</span><select class="select"><option>pi-jobs</option><option>Every queue</option></select></label>
    <label class="field"><span>Only repository</span><input class="input input--code" placeholder="owner/name"></label>
    <div class="pp-bulk__b"><button class="btn btn--paid" type="button" aria-expanded="true">{ic('rerun', 'ic ic--sm')}Retry all</button><button class="btn btn--danger" type="button">Remove all</button></div>
  </div>
  {confirm("paid", "Retry 2 failed job(s) in pi-jobs; each is re-checked and acted on alone",
    ["<span class='code'>gh-5d10</span> on pi-jobs, 3 attempt(s), reserve $2.00",
     "<span class='code'>gh-6e21</span> on pi-jobs, 2 attempt(s), acme/web#418, reserve unknown",
     "Each goes back to waiting and runs again through every pre-spend gate, and the worker reserves for it again at pickup.",
     "<b>Together they hold 2 job slot(s) and $2.00 for the jobs whose reserve is known in each dollar window that applies; the reserve of 1 job(s) is unknown (their data could not be read), so the total is at least this.</b>"],
    "cancel a retried job on Fleet before a worker picks it up", "Retry 2 jobs, at least $2.00")}
</div>
<div class="pp-pad pp-why">
  <p class="sect-h">Why each failed <span class="faint">· the queue's own words, scrubbed and cut to 120 characters. Operators only.</span></p>
  <details><summary><span class="code">gh-5d10</span></summary><pre class="pp-pre">{E("Error: docker run exited 125: Unable to find image 'pi-dispatch-job:4.3.1' locally")}</pre></details>
  <details open><summary><span class="code">gh-6e21</span></summary><pre class="pp-pre">{E("job stalled more than allowable limit")}</pre></details>
</div>""",
    end='<span class="card__sub">kept by the queue until you retry or remove</span>', id_="p-failed", flush=True)

# delayed breakdown: one count, named where its parts can be counted
def seg_bar():
    parts = [("2 cron next", 2, "wb--0"), ("2 held", 2, "pp-wb-hold"), ("2 other", 2, "wb--1")]
    tot = sum(p[1] for p in parts); x = 0; out = []
    for name, n, cls in parts:
        w = n / tot * 100
        out.append(f'<rect class="wb {cls}" x="{x:.2f}%" y="0" width="{w:.2f}%" height="34" rx="10"/>'
                   f'<text class="wb-t" x="{x + w / 2:.2f}%" y="22" text-anchor="middle">{name}</text>')
        x += w
    return (f'<svg class="wbar" height="34" role="img" aria-label="6 delayed: 2 cron next occurrences, 2 held on a condition, 2 undifferentiated">'
            f'{"".join(out)}</svg>')

PP_DELAYED = card("Delayed", f"""
  {seg_bar()}
  <ul class="mini-list pp-legend">
    <li class="tone-idle">{ic('clock', 'ic ic--sm')}<span><b>2 cron next occurrences</b><small>nightly-tidy at 2026-10-09 03:00 UTC, pm-weekly at 2026-10-12 06:00 UTC. Counted from the schedule list.</small></span></li>
    <li class="tone-idle">{ic('hourglass', 'ic ic--sm')}<span><b>2 held on a condition</b><small>gh-77c1 and gh-91a0, under Held. Counted from the worker's own index.</small></span></li>
    <li class="tone-idle">{ic('queue', 'ic ic--sm')}<span><b>2 other, undifferentiated</b><small>Retry backoff, a pause window, or a scope, model endpoint or host deferral. Nothing records which, so this page does not guess.</small></span></li>
  </ul>
  <details class="pp-what">
    <summary>What can delay a job, and when it asks again</summary>
    <ul class="mini-list">
      <li>{ic('pause', 'ic ic--sm')}<span><b>A pause window</b><small>Moved to the window's end; never dropped, reserves nothing.</small></span></li>
      <li>{ic('rerun', 'ic ic--sm')}<span><b>Retry backoff</b><small>After an infrastructure failure, forge and local jobs try once more, from 60 seconds and growing.</small></span></li>
      <li>{ic('slot-held', 'ic ic--sm')}<span><b>A busy scope</b><small>One local job per folder, or a scoped limit's at-once count: asks again every 5 seconds.</small></span></li>
      <li>{ic('bolt', 'ic ic--sm')}<span><b>A busy model endpoint</b><small>Its concurrency in model-endpoints.json is full: asks again every 7 seconds.</small></span></li>
      <li>{ic('slot', 'ic ic--sm')}<span><b>Host slots full</b><small>PI_CONCURRENCY is taken: asks again every 5 seconds.</small></span></li>
      <li>{ic('fleet', 'ic ic--sm')}<span><b>The host budget</b><small>Its size fits the host, just not now: asks again about every 9 seconds and keeps its place.</small></span></li>
      <li>{ic('chev-r', 'ic ic--sm')}<span><b>Never fits this host</b><small>A shared job larger than this host's budget is put back for 60 seconds for another host.</small></span></li>
    </ul>
  </details>
  <p class="pp-waiter">{ic('fleet', 'ic ic--sm')}<span><b>build3:</b> 1 job waits for the host budget (memory). <a class="link" href="#">Open build3</a></span></p>
""", sub="6 jobs, one count", id_="p-delayed")

def state_row(tone, icon, title, sentence, act=""):
    return f"""<li class="pp-st tone-{tone}"><span class="tile tile--sm">{ic(icon)}</span>
  <div><p class="pp-st__t">{title}</p><p class="pp-st__s">{sentence}</p>{act}</div></li>"""

PP_STATES = card("Other states of this page", f"""<ul class="pp-sts">
  {state_row("ok", "play", "The fleet is running", "Every queue accepts jobs. The bar offers only Pause the fleet.")}
  {state_row("failed", "pause", "Paused: the kill switch is on", "Nothing new starts on any queue; running jobs finish. The bar offers only Resume the fleet, which is paid.")}
  {state_row("failed", "failed", "The kill switch did not reach every queue",
             f"{code(VK_SHELL)} done; {code(VK_FILE)} stopped after pi-jobs, pi-jobs@build3, failed at pi-jobs@mini1. Look at the fleet and try again.")}
  {state_row("attention", "attention", "The host registry could not be read", "This shows the fleet as it was last seen. Every count keeps its last value and says when it was read.")}
  {state_row("idle", "hourglass", "More held than one read takes", "The held set is larger than one read takes; not every member was read. 12 more held.")}
  {state_row("ok", "done", "After a bulk retry", '<span class="pp-res"><span>' + ic('done', 'ic ic--sm') + '<span><b>gh-5d10:</b> done</span></span><span>' + ic('failed', 'ic ic--sm') + '<span><b>gh-6e21:</b> not done, job gh-6e21 is waiting now, not failed: it changed since the preview. Nothing was done</span></span></span>',
             act='<button class="btn btn--sm" type="button">' + ic('rerun', 'ic ic--sm') + 'Reload</button>')}
</ul>""", sub="the same panels, other moments")

PP_CSS = BASE_CSS + """
.pp-refusal { display: grid; gap: 10px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--tone-tint); color: var(--ink); font-size: 13px; line-height: 20px; }
.pp-refusal__h { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--tone-ink); font-size: 14px; }
.pp-refusal__h .ic { width: 18px; height: 18px; }
.pp-refusal .cmd { background: var(--surface); }
.pp-refusal__f { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pp-refusal__f .btn { margin-left: auto; }
.pp-src { display: flex; align-items: flex-start; gap: 6px; line-height: 17px; font-size: 12px; color: var(--ink-muted); }
.pp-foot { padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.pp-bulk { border-top: 1px solid var(--line); padding-top: var(--space-4); }
.pp-bulk__row { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; }
.pp-bulk__row .field { flex: 1 1 180px; }
.pp-bulk__b { display: flex; gap: 8px; flex-wrap: wrap; }
.pp-why { border-top: 1px solid var(--line); padding-top: var(--space-4); display: grid; gap: 6px; }
.pp-why .sect-h { margin: 0 0 4px; }
.pp-why details { border-radius: 12px; background: var(--surface-2); padding: 8px 12px; font-size: 13px; }
.pp-why summary { cursor: pointer; }
.pp-pre { margin: 8px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 12px; line-height: 18px; color: var(--ink); }
.pp-wb-hold { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; stroke-dasharray: 5 4; }
.pp-wrap { white-space: normal; min-width: 220px; }
.pp-legend { margin-top: var(--space-4); }
.pp-what { margin-top: var(--space-4); padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.pp-what summary { cursor: pointer; font-weight: 650; }
.pp-what .mini-list { margin-top: 10px; }
.pp-waiter { display: flex; gap: 8px; align-items: center; margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); font-size: 13px; }
.pp-sts { display: grid; gap: 8px; }
.pp-st { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pp-st .tile { background: var(--tone-tint); color: var(--tone-ink); }
.pp-st__t { font-size: 13px; font-weight: 700; }
.pp-st__s { font-size: 12px; line-height: 17px; color: var(--ink-muted); margin-top: 2px; }
.pp-st .btn { margin-top: 8px; }
.pp-res { display: grid; gap: 4px; }
.pp-res > span { display: flex; gap: 6px; align-items: flex-start; }
.pp-res .ic { margin-top: 1px; flex: none; }
.pp-res b { color: var(--ink); }
@media (max-width: 760px) { .confirm__act .btn { white-space: normal; height: auto; min-height: 40px; padding-top: 8px; padding-bottom: 8px; text-align: center; } .pp-src .code { white-space: normal; overflow-wrap: anywhere; } .pp-foot { padding: var(--space-3) var(--space-4); } .pp-refusal__f .btn { margin-left: 0; } }
"""

def part_paused():
    inner = PP_BAR + f'<div class="cols"><div class="stack">{PP_QUEUES}{PP_FAILED}{PP_HELD}</div><div class="stack">{PP_DELAYED}{PP_STATES}</div></div>'
    return shell("Fleet", inner, "Fleet", sub="Queues, hosts and their health. Every pause, cancel and removal previews first.")

write("FleetPartPaused", card_marker("Fleet", 2540, 1440, "Fleet part paused: two Valkeys that disagree, a refused fleet resume, a queue resume and a bulk retry in preview, the delayed count split where it can be"),
      "Fleet, part paused", part_paused(), PP_CSS)
readme("FleetPartPaused", """
Fleet when it is part paused: two of four queues are paused, the console and the service read different Valkeys, and an operator works out what is stuck and what to start again.

**How a person uses it.**
- **The fleet bar.** It is ringed yellow and says *Part paused* with which queues start nothing new and which keep going. Its counts add *in paused queues*. Both switches are offered: *Resume the fleet* (paid, amber outline, because queued jobs start spending) and *Pause the fleet* (danger).
- **Two Valkeys.** When `VALKEY_URL` differs between the console's environment and the deployment's `.env`, a yellow line says so in the repo's words. A pause reaches both; a resume is refused, and the refusal opens where the preview would, with the command that resumes one Valkey on purpose. Nothing was changed.
- **Queues.** Paused rows are tinted and say *Paused* with the pause glyph. Their sub-line says the host still takes shared jobs. *Resume* on a row is paid; its preview names how many jobs wait in it and why no single reserve figure applies.
- **Failed jobs.** Each row quotes its run record's sentence. The bulk editor filters by queue or repository; *Retry all* opens a preview that lists each job with its reserve, then the bulk reserve, including the case where one job's reserve is unknown. *Why each failed* shows the queue's own text in a collapsed row per job.
- **Held.** Each held job's condition label as the worker writes it (`after … + ci-green`), how long it has waited and how many of its 96 checks it has used.
- **Delayed.** The delayed count is one number. The card splits out what can be counted (cron next occurrences, held jobs) and calls the rest *undifferentiated*. A folded list explains every deferral and how often it asks again. Jobs waiting for a host budget link to the host.
- **Other states.** Running, paused (kill switch on), a pause that did not reach every queue, an unreadable host registry, a held set too large to read, and the per-job results after a bulk retry with *Reload*.

**Panels.** `p-fleetbar`, `p-queues`, `p-failed`, `p-held`, `p-delayed`.

**The server provides.**
- The paused state: running, part paused or paused.
- The kill switch's plan: Valkey URLs as shown (never with credentials), the disagreement sentence, or the refusal.
- Per queue: counts and paused flag.
- Failed jobs with queue, attempts, failed time, target, run record reason, and the scrubbed queue text (operators only).
- Held rows (job, target, label, waited, checks).
- The delayed total with the counted cron and held parts.
- Host waiters.
- Every preview's summary lines and reserve text come from the server, not the page.

**Viewers** see the bar, counts, queues, held and failed rows and the delayed split. They do not see any button or preview. In place of *Why each failed* they see "Failure reasons are shown to operators only."

**Fixture note.** Queue names, hosts, `redis://127.0.0.1:6399/0`, gh-77c1, gh-5d10 and the schedules come from the fixture. These are sample data:
- the paused queues and every count;
- the second Valkey `redis://127.0.0.1:6379/0`;
- gh-91a0, gh-6e21 and their texts;
- the reserves.
""")

# =====================================================================================
# 2. VENUE DETAIL (openshell)
# =====================================================================================
PROPS = [  # key, short label, question, armedBy
    ("isolation", "Isolation flags", "capabilities dropped, no-new-privileges, pid and memory bounds on the job container", None),
    ("ephemeral", "One container per job", "one container per job, destroyed after it, never reused across jobs", None),
    ("mountSet", "Declared mounts only", "only the declared mounts exist; no docker socket, no home dir, no shared session store", None),
    ("egress", "Egress allowlist", "the job reaches only what the allowlist proxy permits", "PI_EGRESS"),
    ("jobToJobIsolation", "Jobs cannot reach each other", "two jobs cannot reach each other, structurally rather than by policy", "PI_EGRESS"),
    ("imagePinning", "Image never pulled", "the image cannot be fetched at run time, so a typo'd name is unreachable (--pull=never)", None),
    ("exitCodes", "Exit code unmodified", "the container's integer exit code reaches the processor unmodified", None),
    ("abortable", "Stoppable on timeout", "a running job can be stopped on the 30-minute timeout or a shutdown, and the abort is distinguishable from a crash", None),
    ("readOnlyJobInputs", "Read-only /job", "/job is read-only by the kernel, not by convention", None),
    ("nonRoot", "Agent not root", "the agent runs as a non-root user", None),
    ("secretsCustody", "No secret value logged", "no resolved secret VALUE reaches a log, a run record or a forge comment", None),
    ("credentialTransit", "Credentials stay on owned networks", "the provider key and the per-job forge token reach the container without crossing a network this deployment does not own", None),
    ("localFolders", "Local folders in place", "a local folder can be bind-mounted and edited in place", None),
    ("pausable", "Freezable", "a running job can be frozen by the cgroup freezer and thawed again, so the host reads its workspace while nothing in the container runs", None),
]
W = {  # venue -> word per property, in PROPS order
    "local":          ["enforced"] * 9 + ["asserted", "enforced", "enforced", "enforced", "enforced"],
    "podman":         ["enforced"] * 14,
    "openshell":      ["asserted"] * 11 + ["enforced", "absent", "absent"],
    "openshell-bind": ["asserted"] * 11 + ["enforced", "asserted", "absent"],
}
SERVES = {  # liveTranscript, steering, recovery, sandboxShell
    "local": ["yes", "yes", "yes", "yes"], "podman": ["yes", "yes", "yes", "yes"],
    "openshell": ["image", "image", "no", "no"], "openshell-bind": ["yes", "yes", "yes", "no"],
}
CUSTODY = {"local": "container", "podman": "container", "openshell": "layer", "openshell-bind": "layer"}
OS_ASSERTS = {
    "isolation": "OpenShell's compute driver (the agent container it creates with every capability dropped, no new privileges, networking off and a pids limit, under Landlock and seccomp)",
    "ephemeral": "the OpenShell gateway, which removes a sandbox's containers when the worker deletes it",
    "mountSet": "OpenShell's compute driver, which mounts its own runtime and the supervisor's socket and nothing of the job's",
    "egress": "OpenShell's supervisor, which decides every connection by the sandbox's policy",
    "jobToJobIsolation": "OpenShell's compute driver, which gives each sandbox's agent no network beside its own supervisor",
    "imagePinning": "the OpenShell gateway's image pull policy on its compute driver",
    "exitCodes": "OpenShell's exec relay, which returns the command's own code and 128 plus the signal",
    "abortable": "the OpenShell gateway, whose sandbox delete ends the running exec",
    "readOnlyJobInputs": "the job image's /opt/pi-dispatch/pi-landlock (the sandboxLayout capability), which the worker starts the runner through after the upload",
    "nonRoot": "OpenShell, which refuses a root workload, with the image's uid as the policy's run_as_user",
    "secretsCustody": "the OpenShell gateway and supervisor, which hold the job's environment while it runs",
}
SERVE_ROWS = [("liveTranscript", "Live transcript", {"yes": "Streams the live transcript and progress.", "no": "Streams no live transcript or progress.",
                                                   "image": "Streams the live transcript and progress only from a job image that declares transcriptStderr and exitAuth."}),
              ("steering", "Steering", {"yes": "Takes steering messages (run.steer).", "no": "Takes no steering messages.",
                                        "image": "Takes steering messages only from a job image that declares steerStdin, transcriptStderr and exitAuth."}),
              ("recovery", "Recovery", {"yes": "Recovers a lost run (run.recover).", "no": "Recovers no lost run: run.recover is refused there.",
                                        "image": "Recovers a lost run only from a job image that supports it."}),
              ("sandboxShell", "Sandbox shell", {"yes": "Reopens a retained workspace (pi-dispatch sandbox).", "no": "Has no sandbox shell: pi-dispatch sandbox cannot reopen its runs.",
                                                 "image": "Reopens a retained workspace only from a job image that supports it."})]
VNAMES = ["local", "podman", "openshell", "openshell-bind"]
V = "openshell"

def meaning(key, w, armed):
    if w == "asserted":
        parts = [f"Asserted by {E(OS_ASSERTS.get(key, 'the job image'))}."]
    elif w == "absent":
        parts = ["Not provided: a floor that asks for it refuses this venue."]
    else:
        parts = ["The worker builds it and a test reads it back."]
    if armed:
        parts.append(f'<span class="vd-by">Only while {code(armed)} is on.</span>')
    if key == "credentialTransit":
        parts.append('<span class="vd-by">Holds on a host where the OpenShell gateway this worker\'s openshell CLI talks to listens on a loopback address or a unix socket on this host; elsewhere it counts as asserted.</span>')
    return " ".join(parts)

def floor_cell(key):
    if key == "egress":
        return (f'<span class="vd-floorl">{ic("attention", "ic ic--sm")}<span>A floor asks for <b>enforced</b> on build3. This venue says asserted, below it, '
                'so build3 would refuse it; build3 does not bless it.</span></span>')
    return ""

VD_SUMMARY = card("Where it runs", facts([
    ("Blessed on", "<b>mini2</b>"),
    ("Default on", '<span class="muted">no live host</span>'),
    ("Credentials", f'<span class="vd-key">{ic("key", "ic ic--sm")}held by the venue\'s egress layer</span>'),
    ("Floors", f'<span>One host sets a floor: build3, <span class="code">egress=enforced</span>.</span><span class="note">No host that blesses openshell sets one.</span>'),
    ("Published by", 'mini1, mini2, build3'),
], cols=1), id_="p-venue")

VD_SERVES = card("What it serves", "<ul class=\"vd-serves\">" + "".join(
    f'<li><span class="vd-serves__n">{n}</span>{serves_word(SERVES[V][i])}<span class="vd-serves__t">{t[SERVES[V][i]]}</span></li>'
    for i, (k, n, t) in enumerate(SERVE_ROWS)) + "</ul>",
    sub="per feature", id_="p-venue-serves")

def gw(tone, icon, text):
    return f'<span class="vd-gw tone-{tone}">{ic(icon, "ic ic--sm")}<span>{text}</span></span>'

VD_HOSTS = card("OpenShell on each host", table(
    [("Host", ""), ("Engine", ""), ("Modes", ""), ("Gateway", "")],
    [[("<b>mini2</b>", "id"), ("docker", ""), (code("copy"), ""), (gw("ok", "done", "The gateway was on this host when the worker started."), "")]],
    caption="OpenShell setup per host"),
    sub="read once, when each worker started", id_="p-venue-hosts", flush=True)

VD_PROPS = card("What it declares", table(
    [("Property", ""), ("Word", ""), ("Who provides it", "")],
    [[(f'<b>{lab}</b><span class="reason">{E(q)}</span><span class="vd-key">{code(k)}</span>', "vd-p"), (word(W[V][i]), ""),
      (f'<span class="vd-mean">{meaning(k, W[V][i], armed)}{floor_cell(k)}</span>', "wide")]
     for i, (k, lab, q, armed) in enumerate(PROPS)], cls="tbl tbl--stack vd-tbl", caption="Properties of openshell"),
    sub="this build's table, 14 properties", id_="p-venue-props", flush=True)


def compare():
    head = [("", "")] + [(f'<span class="code">{v}</span>', "vd-c" + (" vd-cur" if v == V else "")) for v in VNAMES]
    rows = []
    for i, (k, lab, q, armed) in enumerate(PROPS):
        rows.append([(f'{lab}{" <span class=" + chr(34) + "faint" + chr(34) + ">· PI_EGRESS</span>" if armed else ""}', "vd-p")] + [(word(W[v][i]), "vd-c" + (" vd-cur" if v == V else "")) for v in VNAMES])
    rows.append(("vd-split", [("<b>It serves</b>", "vd-p")] + [("", "vd-c" + (" vd-cur" if v == V else "")) for v in VNAMES]))
    for j, (k, n, t) in enumerate(SERVE_ROWS):
        rows.append([(n, "vd-p")] + [(serves_word(SERVES[v][j]), "vd-c" + (" vd-cur" if v == V else "")) for v in VNAMES])
    rows.append([("Credentials held by", "vd-p")] + [(f'<span class="vd-key">{ic("key", "ic ic--sm")}{"the container" if CUSTODY[v] == "container" else "egress layer"}</span>', "vd-c" + (" vd-cur" if v == V else "")) for v in VNAMES])
    return card("Compare venues", table(head, rows, cls="tbl vd-cmp", caption="Every venue's words"),
                sub="the same table for all four; this one is highlighted", id_="p-venue-compare", flush=True)

VD_TABS = '<nav class="seg vd-seg" aria-label="Venues">' + "".join(
    f'<a href="#"{" aria-current=" + chr(34) + "page" + chr(34) if v == V else ""}>{v}</a>' for v in VNAMES) + "</nav>"

VD_CSS = BASE_CSS + """
.vd-key { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.vd-key .ic { flex: none; }
.vd-intro { font-size: 13px; line-height: 20px; color: var(--ink-muted); max-width: 900px; }
.vd-seg { flex-wrap: wrap; height: auto; max-width: 100%; }
.vd-serves { display: grid; gap: 6px; }
.vd-serves li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.vd-serves__n { font-weight: 650; }
.vd-serves__t { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.vd-decl { display: grid; gap: 6px; padding: 0 var(--space-5) var(--space-4); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.vd-decl li { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 10px; align-items: center; }
.vd-note { margin-top: var(--space-3); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.vd-gw { display: inline-flex; gap: 6px; align-items: flex-start; font-size: 13px; }
.vd-gw .ic { color: var(--tone-ink); margin-top: 2px; flex: none; }
.vd-gws { display: grid; gap: 6px; }
.vd-tbl td { vertical-align: top; }
.vd-tbl .vd-p { min-width: 260px; max-width: 360px; white-space: normal; }
.vd-p .reason { max-width: 360px; }
.vd-key { display: block; margin-top: 4px; }
.vd-key .code { font-size: 11px; color: var(--ink-muted); }
.vd-mean { display: block; max-width: 520px; font-size: 13px; line-height: 19px; }
.vd-by { display: block; margin-top: 4px; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.vd-floorl { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; padding: 6px 10px; border-radius: 10px; background: var(--attention-tint); color: var(--ink); font-size: 12px; line-height: 17px; }
.vd-floorl .ic { color: var(--attention-ink); margin-top: 1px; flex: none; }
.vd-fixl { margin: var(--space-3) 0 var(--space-2); font-size: 13px; line-height: 19px; }
.vd-cmp th.vd-c, .vd-cmp td.vd-c { text-align: center; }
.vd-cmp .vd-cur { background: var(--surface-2); }
.vd-cmp tbody tr:hover td.vd-cur { background: var(--surface-3); }
.vd-cmp .vd-p { white-space: nowrap; font-weight: 600; }
.vd-cmp th:first-child, .vd-cmp td.vd-p { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.vd-cmp tbody tr:hover td.vd-p { background: var(--surface-2); }
.vd-split td { padding-top: 18px; border-bottom-color: var(--line-strong); }
.vd-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-muted); }
.vd-legend > span { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 760px) {
  .vd-decl { padding: 0 var(--space-4) var(--space-3); }
  .vd-decl li { grid-template-columns: minmax(0, 1fr); gap: 4px; justify-items: start; }
  .vd-tbl .vd-p { min-width: 0; max-width: none; }
  .vd-tbl .vd-mean { margin-top: 6px; }
  .vd-cmp .vd-p { white-space: normal; min-width: 150px; max-width: 150px; box-shadow: 1px 0 0 var(--line); }
  .vd-legend { padding: var(--space-3) var(--space-4); }
}
"""

def venue_page():
    inner = (f'<div class="cols">{VD_PROPS}<div class="stack">{VD_SUMMARY}{VD_SERVES}{VD_HOSTS}</div></div>' + compare())
    return shell("Fleet", inner, "openshell", sub="An NVIDIA OpenShell sandbox on this host's gateway, through the openshell CLI.", end=VD_TABS, back="Fleet")

write("VenueDetail", card_marker("Fleet", 3180, 1440, "One venue in full: the word for every property and who provides it, what the venue serves, the OpenShell setup per host, floors, and all four venues compared"),
      "Venue: openshell", venue_page(), VD_CSS)
readme("VenueDetail", """
One venue in full, opened from Fleet's Venues panel: what the venue declares, what it serves, where it runs, and how it compares with the other three. It answers "can I trust this venue with this job, and why".

**How a person uses it.**
- **Venue switch.** A segmented control at the top moves between local, podman, openshell and openshell-bind.
- **What it declares.** All 14 properties. Each shows its short name, the question it answers, its key, and its word: *enforced* (shield), *asserted* (check, outlined) or *absent* (dash, dashed outline), so the word is never colour alone.
  - For an asserted word, the next column says who asserts it, in the build table's own words.
  - It says when a switch arms the property (`PI_EGRESS`) and which host observation the word depends on.
  - The last column names any host floor that asks for the property, and whether this venue meets it.
- **Where it runs.** The hosts that bless the venue, where it is the default, who holds credentials (the egress layer, or the container), floors, and which hosts published nothing.
- **What it serves.** Live transcript, steering, recovery and sandbox shell, each *yes*, *no* or *with the image*, with one line for this venue.
- **OpenShell on each host.** Engine, modes and the gateway word per blessing host.
- **Compare venues.** All four venues' 14 words, what each serves and who holds credentials, with this venue's column highlighted. This replaces the Fleet matrix wherever a full comparison is wanted.

**Panels.** `p-venue`, `p-venue-serves`, `p-venue-hosts`, `p-venue-props`, `p-venue-compare`.

**The server provides.**
- The build's venue table: describe, declares, asserts, armedBy, observedBy, serves and credential custody.
- Each live host's published blessing, default, floor and OpenShell engine, modes and gateway word.
- The hosts that published nothing.

Nothing on this page is read live from a host. Viewers and operators see the same page; there are no actions.

**Why it works this way.**
- **The three words.** *Enforced*: this worker builds the property in its own code, and a test reads it back off what was produced. *Asserted*: something outside the worker provides it (an image, a vendor's documentation), which the worker cannot verify. *Absent*: not provided, so a floor that asks for it refuses this venue. *With the image* means only from a job image that declares the feature.
- **Where the words come from.** What a venue declares is this build's table. Which hosts bless it, their floors and their OpenShell setup are what each host's worker published when it started.
- **Serving is not a guarantee.** What a venue serves is what it can do for an operator, so no floor compares those rows. A feature it serves can still be refused before spend by what the job image lacks.
- **Credentials on openshell.** Values with an endpoint are placeholders in the agent; `run.secrets` go to the job's provider.
- **A worker older than this console** publishes nothing, and the summary names it.
- **Other gateway words a host can publish.** Not local (every job there is refused as `openshell-gateway-not-local`), unread (the gateway did not answer when the worker started), and not published.
- **When an observation does not hold.** *Credentials stay on owned networks* is enforced only where the gateway is local. On a host where the observation fails, the word drops to asserted, and a floor asking for enforced refuses there. The fix is to run the gateway on that host and register it on loopback (`openshell gateway add https://127.0.0.1:17670 --local`); a remote gateway is refused, not lowered.

**Fixture note.** The hosts and build3's floor `egress=enforced` come from the fixture. The words, questions, asserts, serves and gateway sentences are the repo's (`worker/src/backends.mjs`, `admin/src/read-model.mjs`). mini2's engine and mode are sample values.
""")

# =====================================================================================
# 3. HOST DETAIL (build3)
# =====================================================================================
def budget_bar(label, used, held, total, unit):
    u = used / total * 100; h = held / total * 100
    return f"""<div class="hd-bud">
  <span class="hd-bud__l">{label}</span>
  <svg class="hd-bud__bar" height="14" role="meter" aria-valuenow="{int(u + h + .5)}" aria-valuemax="100" aria-label="{label}: {used} {unit} promised to running jobs and {held} {unit} held by an orphaned container, of {total} {unit}">
    <rect class="hd-bed" width="100%" height="14" rx="7"/>
    <rect class="hd-used" width="{u:.1f}%" height="14" rx="7"/>
    <rect class="hd-held" x="{u:.1f}%" width="{h:.1f}%" height="14" fill="url(#hatch)"/>
    <line class="hd-sep" x1="{u:.1f}%" x2="{u:.1f}%" y1="0" y2="14"/>
  </svg>
  <span class="hd-bud__v"><b>{used + held}</b> of {total} {unit}</span>
</div>"""

HD_STATE = f"""<section class="card hd-state tone-attention card--tint" id="p-hoststate" data-panel aria-labelledby="hd-st-h">
  <span class="tile">{ic('beat')}</span>
  <div class="hd-state__t"><h2 id="hd-st-h">Stale: no beat for 3m</h2>
    <p>build3's worker beats every 15 seconds. Shared jobs stop going to a host after 3 missed beats; jobs on <span class="code">pi-jobs@build3</span> wait for it. Doctor on build3 is also 3 days old.</p></div>
  <div class="hd-state__a">{btn("Pause pi-jobs@build3", "danger", "pause")}</div>
</section>"""

HD_SLOTS = card("Slots and budget", f"""
  <div class="hd-slots">
    <span class="sls hd-sls" aria-label="3 slots: 1 running, 1 held by an orphaned container, 1 free">{slots("rhf")}</span>
    <span class="hd-slots__t"><b>2 of 3 slots</b> taken: 1 running, 1 held by an orphaned container. <span class="muted">PI_CONCURRENCY 3.</span></span>
  </div>
  {budget_bar("Memory", 8, 8, 24, "GiB")}
  {budget_bar("CPU", 4, 4, 12, "cores")}
  <div class="hd-key"><span><i class="hd-k hd-k--used"></i>promised to running jobs</span><span><i class="hd-k hd-k--held"></i>held by an orphaned container</span><span><i class="hd-k"></i>free</span></div>
  {facts([
    ("Budget", "24 GiB and 12 cores <span class='note'>auto: the machine's 28 GiB less a 4 GiB reserve, and 13 cores less 1.</span>"),
    ("Waiting for it", "<b>1 job</b>, gh-91d2 (api, 12 GiB, 4 cores). <span class='note'>Room is kept for the oldest waiter, so a smaller job that arrives later cannot take it.</span>"),
    ("Project rules", "<span class='code'>billing</span> hostShare 50%, minJobs 1"),
    ("CPU reserve", "held <span class='note'>Every job runs under pidispatch.slice, whose quota is the CPU budget.</span>"),
    ("Old containers", "listed <span class='note'>The worker counted the job containers left from before it started.</span>"),
  ], cols=1)}
  <p class="sect-h">Other words this card can show</p>
  <ul class="hd-words">
    <li><b>no memory budget</b> <span>the dimension is switched off (PI_HOST_MEMORY_BUDGET=off)</span></li>
    <li><b>budget not known yet</b> <span>a starting worker has not read it</span></li>
    <li><b>budget unreadable</b> <span>a value no worker writes</span></li>
    <li><b>admits no job on podman</b> <span>it could not list the job containers left from before it started there</span></li>
  </ul>
""", sub="what the host promised, from its registry row", id_="p-hostbudget")

HD_JOBS = card("Jobs on build3", table(
    [("Job", ""), ("Project", ""), ("Size", ""), ("For", "num"), ("State", ""), ("", "act")],
    [[('<a href="#">gh-e802</a>', "id"), (tag("billing"), ""), ("8 GiB, 4 cores", "hd-nw"), ("1h 20m", "num"), (badge("running"), "wide"), (btn("Cancel", "danger"), "act")],
     ("row--attention", [('<a href="#">gh-4a7e</a>', "id"), (tag("billing"), ""), ("8 GiB, 4 cores", "hd-nw"), ("5h 0m", "num"),
      (f'{badge("attention", "Orphaned")}<span class="reason">Cancelled at 10:59; its container\'s stop did not take, so it still holds 8 GiB and 4 cores.</span>', "wide"), (btn("Free the slot", "danger"), "act")]),
     [('<a href="#">gh-91d2</a>', "id"), (tag("api"), ""), ("12 GiB, 4 cores", "hd-nw"), ("4m", "num"),
      (f'{badge("held", "Waits for the budget")}<span class="reason">Its size fits build3, not now (memory). Asks again about every 9 seconds and keeps its place.</span>', "wide"), (btn("Cancel", "danger"), "act")]],
    cls="tbl tbl--stack", caption="Jobs on build3"),
    sub="2 running, 1 waiting; sizes from each job's project row", id_="p-hostjobs", flush=True)

# capacity: 28 buckets of 6h over 7 days
CAP = [None, None, None, (0.4, 1), (1.2, 2), (2.1, 3), (0.9, 2), (0.2, 1), (1.6, 3), (2.6, 3), (2.2, 3), (0.5, 1), (0.1, 1), (1.8, 3), (2.9, 3), (2.4, 3),
       (0.7, 2), (0.0, 0), (1.4, 2), (2.2, 3), (1.9, 3), (0.6, 1), (0.3, 1), (1.7, 3), (2.8, 3), (2.5, 3), (1.1, 2), (2.0, 3)]
def cap_chart():
    n = len(CAP); slot = 3; base = 116; H = 96
    step = 100 / n; out = []
    for i, b in enumerate(CAP):
        x = i * step + .25; w = step - .5
        if b is None:
            out.append(f'<rect class="hd-nd" x="{x:.2f}%" y="{base - H}" width="{w:.2f}%" height="{H}" fill="url(#nodata)"/>')
            continue
        avg, peak = b
        h = max(avg / slot * H, 1.5)
        out.append(f'<rect class="hd-bar" x="{x:.2f}%" y="{base - h:.1f}" width="{w:.2f}%" height="{h:.1f}" rx="2"/>')
        if peak:
            py = base - peak / slot * H
            out.append(f'<line class="hd-peak" x1="{x:.2f}%" x2="{x + w:.2f}%" y1="{py:.1f}" y2="{py:.1f}"/>')
    out.append(f'<line class="hd-slotline" x1="0" x2="100%" y1="{base - H}" y2="{base - H}"/>')
    out.append(f'<line class="hd-axis" x1="0" x2="100%" y1="{base}" y2="{base}"/>')
    days = ["10-02", "10-03", "10-04", "10-05", "10-06", "10-07", "10-08"]
    for d, lab in enumerate(days):
        out.append(f'<text class="hd-tick" x="{(d * 4 + 1) * step + step:.2f}%" y="{base + 16}" text-anchor="middle">{lab}</text>')
    out.append(f'<text class="hd-tick" x="99.5%" y="{base - H - 5}" text-anchor="end">3 slots</text>')
    defs = ('<defs><pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
            '<rect class="hd-nd-bg" width="6" height="6"/><rect class="hd-nd-ln" width="2" height="6"/></pattern></defs>')
    return (f'<svg class="hd-chart" height="{base + 22}" role="img" aria-label="build3 over the last 7 days in 6-hour buckets: jobs at once on average, a tick at the most at once, against 3 slots; the first 18 hours have no history">'
            f'{defs}{"".join(out)}</svg>')

HD_CAP = card("Last 7 days", f"""
  <div class="hd-kpis">
    <div><b>63%</b><span>busy</span></div><div><b>29%</b><span>idle</span></div><div><b>8%</b><span>no history</span></div>
    <div><b>2.1</b><span>of 3 slots on average, peak 3</span></div><div><b>12%</b><span>of the time full</span></div><div><b>6m</b><span>wait for a slot, p95 <span class="faint">(p50 40s)</span></span></div>
  </div>
  {cap_chart()}
  <div class="hd-key"><span><i class="hd-k hd-k--bar"></i>jobs at once, on average</span><span><i class="hd-k hd-k--peak"></i>the most at once</span><span><i class="hd-k hd-k--slot"></i>slots</span><span><i class="hd-k hd-k--nd"></i>no history: neither busy nor idle</span></div>
  {facts([
    ("Promised", "48% of memory, 40% of CPU"), ("CPU used", "18% of 12 cores"),
    ("By run time", f"{tag('billing')} 61% · {tag('api')} 22% · {tag('web')} 17%"),
  ], cols=1)}
  <ul class="mini-list hd-cav">
    <li class="tone-attention">{ic('attention', 'ic ic--sm')}<span>Jobs only: a machine busy with other work reads as idle.</span></li>
    <li class="tone-idle">{ic('info', 'ic ic--sm')}<span>History truncated: it starts at 2026-10-02 09:00 UTC, so the time before is drawn as no history, never as idle.</span></li>
  </ul>
  {cmd("pi-dispatch capacity")}
""", sub="last 7d to 15:39 UTC, 6-hour buckets", id_="p-hostcap")

HD_ROW = card("Registry row", facts([
    ("Worker", "4.3.1, started 2026-10-07 22:14 UTC <span class='note'>pid 48122</span>"),
    ("Job image", "<span class='code'>pi-dispatch-job:4.3.1</span> <span class='note'>digest sha256:7c41…e09a, the same on every host</span>"),
    ("pi", "0.71.2"),
    ("Time zone", "UTC <span class='note'>the same on every host</span>"),
    ("Queues", "<span class='code'>pi-jobs@build3</span> and the shared <span class='code'>pi-jobs</span>"),
    ("Venues", "podman (default) <span class='note'>Floor <span class='code'>egress=enforced</span></span>"),
    ("Profiles", "secret <span class='code'>prod</span>, wait <span class='code'>ci-green</span> <span class='note'>Jobs that need them are routed to this host.</span>"),
    ("Matches the fleet", f'<span class="hd-fp">{chip("all four match", "ok", "done")}<span class="muted">triggers, dollar caps, projects, envelope</span></span>'),
    ("Last beat", '<span class="tinted tone-attention"><b>3m ago</b></span> <span class="note">Every 15s. The row expires after 90s without one.</span>'),
], cols=1), sub="what the worker publishes about itself", id_="p-hostrow")

SECTIONS = ["node", "env", "image", "docker", "triggers", "dollars", "venues", "images", "egress", "backends", "sizing", "job-user", "podman",
            "openshell", "selinux", "forges", "github", "valkey", "fleet", "capacity", "provider", "overlay", "waits", "models", "secrets",
            "sessions", "files", "limits", "envelope", "console", "dirs", "state", "live"]
SEC_STATE = {"docker": "failing", "openshell": "not run", "live": "not run"}
def sec_chip(s):
    st = SEC_STATE.get(s, "ok")
    if st == "failing":
        return f'<li class="hd-sec tone-failed">{ic("failed", "ic ic--sm")}{s}<span class="sr">:</span> <b>1 failing, 1 warning</b></li>'
    if st == "not run":
        return f'<li class="hd-sec hd-sec--off">{ic("minus", "ic ic--sm")}{s}<span class="sr"> not run</span></li>'
    return f'<li class="hd-sec">{ic("done", "ic ic--sm")}{s}</li>'

HD_DOC = card("Doctor", f"""
  <p class="hd-docline tinted tone-failed">{ic('failed', 'ic ic--sm')}<span>Doctor ran <b>3d ago</b> (version 4.3.1), run by the worker: 1 failing, 1 warning, 38 passing.</span></p>
  {banner("attention", "clock", "Stale: older than two of this host's doctor runs (every 24h)", "So it may no longer describe the host. Run doctor on build3 to publish a fresh result.", small=True)}
  <p class="sect-h">Sections <span class="faint">· 31 ran, 2 did not apply</span></p>
  <ul class="hd-secs">{''.join(sec_chip(s) for s in SECTIONS)}</ul>
  <p class="hd-seckey"><span>{ic('done', 'ic ic--sm')}every check passed</span><span>{ic('failed', 'ic ic--sm')}a check fails or warns</span><span>{ic('minus', 'ic ic--sm')}did not apply on this host (no openshell venue; live checks run only with --live)</span></p>
  <p class="sect-h">Failing first, then warnings</p>
  <ul class="fl-chks">
    {check("failing", "docker.39", "Docker daemon unreachable at &lt;path&gt;", "Start Docker, then re-run doctor.")}
    {check("warning", "docker.40", "PI_CONCURRENCY=6 is above this host's slot budget", "Lower PI_CONCURRENCY or raise the budget.")}
  </ul>
  {cmd("pi-dispatch doctor")}
  <p class="sect-h">Other doctor states</p>
  <ul class="hd-words">
    <li><b>Replaced by a hand run</b> <span>It replaced the worker's own run of 2h ago (uid 1001), so it shows another account's view of the host.</span></li>
    <li><b>More than 8</b> <span>4 more not shown here; pi-dispatch doctor on that host prints them all.</span></li>
    <li><b>All passing</b> <span>Every check passed.</span></li>
    <li><b>Unreadable</b> <span>Its published result cannot be read (a worker of another version may have written it).</span></li>
    <li><b>Never published</b> <span>No doctor result published by: build3.</span></li>
  </ul>
""", sub="visible to viewers too; paths and secrets redacted at the source", id_="p-hostdoctor")

HD_CSS = BASE_CSS + """
.hd-state { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-4); align-items: center; }
.hd-state .tile { background: var(--surface); color: var(--tone-ink); }
.hd-state__t h2 { font-size: 18px; line-height: 24px; font-weight: 750; color: var(--tone-ink); }
.hd-state__t p { font-size: 13px; line-height: 20px; margin-top: 2px; }
.hd-slots { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: var(--space-4); font-size: 13px; }
.hd-sls .sl { width: 22px; height: 22px; }
.hd-bud { display: grid; grid-template-columns: 64px minmax(0, 1fr) 112px; gap: 10px; align-items: center; margin-bottom: 10px; font-size: 13px; }
.hd-bud__l { color: var(--ink-muted); }
.hd-bud__bar { width: 100%; display: block; }
.hd-bud__v { text-align: right; white-space: nowrap; color: var(--ink-muted); }
.hd-bud__v b { color: var(--ink); }
.hd-bed { fill: var(--surface-3); }
.hd-used { fill: var(--running); }
.hd-held { stroke: var(--attention); stroke-width: 1; }
.hd-sep { stroke: var(--surface); stroke-width: 2; }
.hd-key { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 var(--space-4); font-size: 12px; color: var(--ink-muted); }
.hd-key > span { display: inline-flex; align-items: center; gap: 6px; }
.hd-k { display: inline-block; width: 14px; height: 10px; border-radius: 3px; background: var(--surface-3); }
.hd-k--used, .hd-k--bar { background: var(--running); }
.hd-k--held { background: var(--attention-tint); box-shadow: inset 0 0 0 1px var(--attention); }
.hd-k--peak { height: 2px; background: var(--ink); border-radius: 1px; }
.hd-k--slot { height: 0; border-top: 2px dashed var(--ink-muted); background: transparent; border-radius: 0; }
.hd-k--nd { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
.tbl .hd-nw { white-space: nowrap; }
.hd-words { display: grid; gap: 6px; font-size: 12px; line-height: 17px; }
.hd-words li { padding: 8px 12px; border-radius: 12px; background: var(--surface-2); color: var(--ink-muted); }
.hd-words b { color: var(--ink); font-weight: 650; margin-right: 4px; }
.hd-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: var(--space-4); }
.hd-kpis > div { display: grid; gap: 2px; padding: 10px 12px; border-radius: 14px; background: var(--surface-2); }
.hd-kpis b { font-size: 22px; line-height: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
.hd-kpis span { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.hd-chart { display: block; width: 100%; }
.hd-bar { fill: var(--running); }
.hd-peak { stroke: var(--ink); stroke-width: 2; }
.hd-slotline { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.hd-axis { stroke: var(--line-strong); stroke-width: 1; }
.hd-tick { fill: var(--ink-muted); font-size: 11px; }
.hd-nd-bg { fill: var(--surface-2); }
.hd-nd-ln { fill: var(--line); }
.hd-cav { margin: var(--space-3) 0; }
.hd-fp { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.hd-docline { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; line-height: 20px; margin-bottom: var(--space-3); }
.hd-docline .ic { margin-top: 3px; flex: none; }
.hd-docline span { color: var(--ink); }
.hd-secs { display: flex; flex-wrap: wrap; gap: 4px; }
.hd-sec { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px 0 7px; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--ink-muted); font-size: 12px; font-weight: 600; }
.hd-sec .ic { width: 12px; height: 12px; color: var(--ok-ink); }
.hd-sec.tone-failed { background: var(--failed-tint); color: var(--failed-ink); }
.hd-sec.tone-failed .ic { color: var(--failed-ink); }
.hd-sec b { font-weight: 800; }
.hd-seckey { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: var(--ink-muted); }
.hd-seckey > span { display: inline-flex; align-items: center; gap: 5px; }
.hd-seckey .ic { width: 12px; height: 12px; }
.hd-sec--off { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.hd-sec--off .ic { color: var(--ink-muted); }
.card .fl-chks + .cmd { margin-top: var(--space-3); }
@media (max-width: 760px) {
  .tbl--stack tr.row--attention { background: var(--attention-tint); }
  .hd-state { grid-template-columns: auto minmax(0, 1fr); }
  .hd-state__a { grid-column: 1 / -1; }
  .hd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hd-bud { grid-template-columns: 56px minmax(0, 1fr) auto; }
}
"""

def host_page():
    inner = (HD_STATE + f'<div class="cols cols--wide-side"><div class="stack">{HD_JOBS}{HD_SLOTS}{HD_CAP}</div><div class="stack">{HD_ROW}{HD_DOC}</div></div>')
    sub = "podman (default) · worker 4.3.1 · 2 of 3 slots taken · last beat 3m ago"
    return shell("Fleet", inner, "build3", sub=sub, back="Fleet")

write("HostDetail", card_marker("Fleet", 1980, 1440, "One host in full: a stale beat, slots and budget with an orphaned hold and a waiter, its jobs, the last 7 days, its registry row and its doctor result"),
      "Host: build3", host_page(), HD_CSS)
readme("HostDetail", """
One host in full, opened from a host row on Fleet or Overview: is it alive, what it promised, what runs and waits on it, how busy it has been, and what doctor last said.

**How a person uses it.**
- **State first.** A stale host leads with a yellow card: no beat for 3 minutes, what that means for routing, and *Pause pi-jobs@build3* (danger). A healthy host shows no card here.
- **Jobs on build3.** Running, orphaned and waiting jobs with project and size.
  - An orphaned job is tinted and says what it still holds, with *Free the slot*.
  - A job waiting for the host budget says which dimension, that it asks again about every 9 seconds, and that it keeps its place.
- **Slots and budget.** Slot dots, then memory and CPU bars split into promised to running jobs (solid), held by an orphan (hatched) and free. Facts cover:
  - how the budget was set;
  - who waits for it, and the room kept for the oldest waiter;
  - project rules (`hostShare`, `minJobs`);
  - the CPU reserve;
  - whether old containers were listed.
  The words a budget can show instead are listed.
- **Last 7 days.** Busy, idle and no-history shares, average and peak slots, time full, and wait p50 and p95, then a 6-hour bar chart. Each bar has a tick at the most at once, a dashed slot line, and hatched no-history time, which counts as neither busy nor idle. It also shows promised and used shares, projects by run time, the "Jobs only" caveat and any truncation.
- **Registry row.** Version, start, image and digest, pi, time zone, queues, venues and floor, the profiles that route jobs here, the fingerprints that match the fleet, and the last beat.
- **Doctor.** The head line in the console's words, red when a check fails, then:
  - the stale warning;
  - 33 section chips (passing, failing, or not run);
  - failing then warning checks, each with its fix, and the command;
  - every other doctor state: replaced by a hand run, more than 8, all passing, unreadable, never published.

**Panels.** `p-hoststate`, `p-hostjobs`, `p-hostbudget`, `p-hostcap`, `p-hostrow`, `p-hostdoctor`.

**The server provides.**
- The host registry row: name, version, start, pid, concurrency, image and digest, pi version, time zone, caps, fingerprints, and budget used, held and waiters. It also carries the jobs list with sizes and orphan flags, the seed, and the beat time.
- The host's slice of the capacity report.
- The host's published doctor result, with checks redacted at the source.

**Viewers** see everything here except the Pause, Cancel and Free the slot buttons. Doctor results are visible to both roles.

**Fixture note.** build3, podman, the floor, the 3-minute late beat, gh-e802, gh-4a7e (cancelled 10:59), the 16 of 24 GiB and 8 of 12 cores, and doctor checks docker.39 and docker.40 come from the fixture. These are sample data:
- gh-91d2;
- the job sizes;
- pid, digest, pi version and profiles;
- the 7-day figures and chart;
- the sections that did not run;
- the hand-run uid.
""")

if __name__ == "__main__":
    print("wrote FleetPartPaused, VenueDetail, HostDetail")
