from config_controls import CONFIG_CONTROLS_CSS
"""Fleet, Configuration, Audit, Sign-in and Error screens on the Pulse kit."""
import os
from pulse import *


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

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

# =====================================================================================
# 1. FLEET
# =====================================================================================
FLEETBAR = f"""<section class="card fl-bar" id="p-fleetbar" data-panel aria-labelledby="fl-bar-h">
  <div class="fl-bar__row">
    <span class="tile tone-ok">{ic('fleet')}</span>
    <div class="fl-bar__t"><h2 id="fl-bar-h">The fleet is running</h2><p class="muted">3 hosts beat, 4 queues accept jobs. Valkey <span class="code">redis://127.0.0.1:6399/0</span></p></div>
    <div class="fl-bar__stats">
      <span><b>0</b> waiting</span><span><b>4</b> active</span><span><b>3</b> delayed</span><span><b>1</b> held</span><span class="tinted tone-failed"><b>1</b> awaiting retry</span>
    </div>
    <button class="btn btn--danger" type="button" aria-expanded="true">{ic('pause', 'ic ic--sm')}Pause the fleet</button>
  </div>
  {confirm("danger", "Pause the fleet",
           ["Pause every queue of the fleet: <b>nothing new starts</b>, running jobs finish.",
            "Queues: <span class='code'>pi-jobs</span>, <span class='code'>pi-jobs@build3</span>, <span class='code'>pi-jobs@mini1</span>, <span class='code'>pi-jobs@mini2</span>.",
            "4 running jobs keep running. 3 delayed jobs and 1 held job wait until you resume.",
            "Valkey <span class='code'>redis://127.0.0.1:6399/0</span>. Audited as <b>fleet-pause</b>."],
           "Resume the fleet", "Pause the fleet")}
</section>"""

QROWS = [("pi-jobs", "shared by 3 hosts", "running", 0, 0, 3, 0, 1),
         ("pi-jobs@build3", "build3", "running", 0, 1, 0, 0, 0),
         ("pi-jobs@mini1", "mini1", "running", 0, 2, 0, 0, 0),
         ("pi-jobs@mini2", "mini2", "running", 0, 1, 0, 0, 0)]
QUEUES = card("Queues", table(
    [("Queue", ""), ("State", ""), ("Waiting", "num"), ("Active", "num"), ("Delayed", "num"), ("Paused", "num"), ("Failed", "num"), ("", "act")],
    [[(f'<span class="code"><b>{q}</b></span><span class="reason">{sub}</span>', "id"), (state(st), ""), (num(w), "num"), (num(a), "num"), (num(d), "num"),
      (num(p), "num"), (f'<b class="tinted tone-failed">{f}</b>' if f else num(0), "num"), (btn("Pause", "danger", "pause"), "act")]
     for q, sub, st, w, a, d, p, f in QROWS], caption="Queues"),
    end='<span class="card__sub">Pause stops new starts; running jobs finish</span>', id_="p-queues", flush=True)

def prog(text, pct=None, tone="running"):
    bar = pbar(pct, tone, text, 6) if pct is not None else '<span class="pnone" aria-hidden="true"></span>'
    return f'<span class="fl-prog">{bar}<span class="reason">{text}</span></span>'

ACTIVE = card("Active jobs", table(
    [("Job", ""), ("Project", ""), ("Target", ""), ("Host", ""), ("Started", ""), ("Running for", "num"), ("Progress", ""), ("", "act")],
    [[('<a href="#">gh-b3d7</a>', "id"), (tag("web"), ""), ('<a href="#">acme/web#415</a>', "tgt"), ("mini1", ""), ("15:27", "when"), ("12m", "num"),
      (prog("Phase 2 of 4, bash running 1m. Turn 7, 12 steps, 1 failed", 0.375), ""), (btn("Cancel", "danger"), "act")],
     [('<a href="#">gh-e802</a>', "id"), (tag("billing"), ""), ('<span class="faint">shown when the run ends</span>', ""), ("build3", ""), ("14:19", "when"), ("1h 20m", "num"),
      (prog("Turn 31 of 40, 58 steps", 31/40), ""), (btn("Cancel", "danger"), "act")],
     [('<a href="#">gh-c41f</a>', "id"), (tag("web"), ""), ('<span class="faint">shown when the run ends</span>', ""), ("mini1", ""), ("14:58", "when"), ("41m", "num"),
      (prog("This worker reports no progress"), ""), (btn("Cancel", "danger"), "act")],
     [('<a href="#">local-9e20</a>', "id"), (tag("ops"), ""), ('<span class="muted">folder job</span>', ""), ("mini2", ""), ("15:33", "when"), ("6m", "num"),
      (prog("This worker reports no progress"), ""), (btn("Cancel", "danger"), "act")],
     ("fl-orphan", [('<a href="#">gh-4a7e</a>', "id"), (tag("billing"), ""), ('<a href="#">acme/billing#290</a>', "tgt"), ("build3", ""), ("10:39", "when"), ("5h 0m", "num"),
      (f'{badge("attention", "Orphaned hold")}<span class="reason">Cancelled at 10:59, but it still holds a build3 slot. build3 runs 1 job where it could run 2.</span>', ""),
      (btn("Free the slot", "danger"), "act")])], caption="Active jobs"),
    end='<span class="card__sub">4 running, 1 slot held</span>', id_="p-active", flush=True)

HELD = card("Held", f"""<div class="fl-held">
    <div class="fl-held__h"><span class="code"><b>gh-77c1</b></span>{tag('web')}<a class="link" href="#">acme/web#415</a><span class="muted">held 2h 14m</span>
      <span class="end">{btn('Cancel', 'danger')}</span></div>
    <p class="card__sub">It starts when every condition is met</p>
    <ul class="fl-cond">
      <li>{ic('clock', 'ic ic--sm')}<span><b>After 2026-10-09 07:00 UTC</b><span class="muted">in 15h 21m</span></span>{chip('Pending', 'idle', 'hourglass')}</li>
      <li>{ic('done', 'ic ic--sm')}<span><b>CI green</b><span class="muted">checks on acme/web#415 have not passed yet</span></span>{chip('Pending', 'idle', 'hourglass')}</li>
    </ul>
  </div>""", end=btn("Cancel all held", "danger"), sub="1 job", id_="p-held")

FAILED = card("Failed jobs", table(
    [("Job", ""), ("Queue", ""), ("Attempts", "num"), ("Failed", ""), ("Why it failed", ""), ("", "act")],
    [[('<a href="#">gh-5d10</a>', "id"), ('<span class="code">pi-jobs</span>', ""), ("<b>3</b> of 3", "num"), ("12:39 UTC", "when"),
      ('<span class="fl-why"><b>Failed:</b> the job image is missing on the host, so the container never started.</span><span class="reason">Next: pull the job image on the host, then retry.</span>', ""),
      (f'{btn("Retry", "paid", "rerun")} {btn("Remove", "danger")}', "act")]], caption="Failed jobs"),
    end=f'{btn("Retry all 1", "paid", "rerun")}{btn("Remove all 1", "danger")}', sub="kept by the queue until you retry or remove", id_="p-failed", flush=True)

def res(label, pct, value, tone="running"):
    return f'<span class="fl-res"><span class="fl-res__l">{label}</span>{pbar(pct, tone, label + " " + value, 8)}<span class="fl-res__v">{value}</span></span>'

HOSTS = card("Hosts", f"""<ul class="hosts">
  {hostrow("build3", "attention", "podman (default)", "3m", "attention", "rhf",
           res("Memory", 16384/24576, "16 of 24 GiB") + res("CPU", 8/12, "8 of 12 cores") +
           f'<span>Running <span class="code">gh-e802</span> 1h 20m, <span class="code">gh-4a7e</span> orphaned hold 5h 0m</span><span>Routes: yes</span><span class="tinted tone-attention">{ic("attention", "ic ic--sm")}Heartbeat late: 3m (expected within 1m)</span>')}
  {hostrow("mini1", "ok", "local (default)", "46s", "", "rrff",
           res("Memory", 6144/16384, "6 of 16 GiB") + res("CPU", 3/8, "3 of 8 cores") +
           '<span>Running <span class="code">gh-c41f</span> 41m, <span class="code">gh-b3d7</span> 12m</span><span>Routes: yes</span>')}
  {hostrow("mini2", "ok", "local (default), openshell, openshell-bind", "46s", "", "rf",
           '<span class="faint">This host reports no memory or CPU figures.</span><span>Running <span class="code">local-9e20</span> 6m</span><span>Routes: yes</span>')}
</ul>""", sub="3 beating, 5 of 9 slots busy", id_="p-hosts")

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

DOCTOR = card("Doctor", f"""<div class="fl-doc">
  <div class="fl-doc__h"><b>build3</b>{counts(1, 1, 38)}</div>
  {banner("attention", "clock", "Stale: this result is 3 days old", "Older than two of this host's doctor runs (every 24h), so it may no longer describe the host. Version 4.3.1, run by the worker.", small=True)}
  <ul class="fl-chks">
    {check("failing", "docker.39", "Docker daemon unreachable at &lt;path&gt;", "Start Docker, then re-run doctor.")}
    {check("warning", "docker.40", "PI_CONCURRENCY=6 is above this host's slot budget", "Lower PI_CONCURRENCY or raise the budget.")}
  </ul>
</div>
<div class="fl-doc">
  <div class="fl-doc__h"><b>mini1</b>{counts(0, 1, 41)}<span class="card__sub">1h ago, version 4.3.1</span></div>
  <ul class="fl-chks">
    {check("warning", "fleet.42", "This host's worker admits no job on the podman venue: it could not list the job containers left from before it started there", "Make the runtime answer for the worker's account (<span class='code'>podman ps -a</span>).")}
  </ul>
</div>
<div class="fl-doc">
  <div class="fl-doc__h"><b>mini2</b><span class="faint">No doctor result published</span></div>
  <p class="muted fl-doc__p">Run doctor on mini2 so this page can describe it.</p>
  {cmd("pi-dispatch doctor")}
</div>""", sub="each host's latest health check", id_="p-doctor")

def vp(v):
    if v == "enforced":
        return f'<span class="chip tone-ok">{ic("shield")}enforced</span>'
    if v == "asserted":
        return f'<span class="chip fl-asserted">{ic("done")}asserted</span>'
    return f'<span class="chip fl-absent">{ic("minus")}absent</span>'

def sv(v):
    if v == "yes":
        return f'<span class="chip tone-ok">{ic("done")}yes</span>'
    if v == "image":
        return f'<span class="chip fl-asserted">{ic("info")}with the image</span>'
    return f'<span class="chip fl-absent">{ic("minus")}no</span>'

VENUES_ROWS = [  # egress, local folders (properties); steering, live transcript, recovery (serves); credentials held by
    ("local", "Docker", "mini1, mini2", "mini1, mini2", ["enforced", "enforced"], ["yes", "yes", "yes"], "the container"),
    ("podman", "rootless Podman", "build3", "build3", ["enforced", "enforced"], ["yes", "yes", "yes"], "the container"),
    ("openshell", "NVIDIA OpenShell", "mini2", "none", ["asserted", "absent"], ["image", "image", "no"], "the OpenShell layer"),
    ("openshell-bind", "OpenShell with folder jobs", "mini2", "none", ["asserted", "asserted"], ["yes", "yes", "yes"], "the OpenShell layer"),
]
VENUES = card("Venues", table(
    [("Venue", ""), ("Blessed on", ""), ("Default on", ""), ("Egress", ""), ("Local folders", ""), ("Steering", ""), ("Live transcript", ""), ("Recovery", ""), ("Credentials held by", "")],
    [[(f'<span class="code"><b>{v}</b></span><span class="reason">{d}</span>', "id"), (b, ""), (df, "")] + [(vp(x), "") for x in props] + [(sv(x), "") for x in serves] + [(cust, "")]
     for v, d, b, df, props, serves, cust in VENUES_ROWS], caption="Venue properties and what each venue serves")
    + f'<div class="fl-vfoot"><span class="fl-floor">Floor on build3: <span class="code">PI_BACKEND_FLOOR egress=enforced</span> · <a class="link" href="#">All 14 properties</a></span></div>',
    sub="published by each host's worker when it started; nothing here is read live", id_="p-venues", flush=True)

SCHEDULES = card("Schedules", table(
    [("Schedule", ""), ("Project", ""), ("Pattern", ""), ("Next", ""), ("Overdue", ""), ("Stalls", "num")],
    [[('<span class="code"><b>nightly-tidy</b></span>', "id"), (tag("ops"), ""), ('<span class="code">0 3 * * *</span>', ""),
      ('2026-10-09 03:00 UTC<span class="reason">in 11h 21m</span>', ""), ('<span class="muted">No</span>', ""), ("0 of 2", "num")],
     [('<span class="code"><b>pm-weekly</b></span>', "id"), (tag("ops"), ""), ('<span class="code">0 6 * * 1</span>', ""),
      ('2026-10-12 06:00 UTC<span class="reason">in 3d 14h</span>', ""), ('<span class="muted">No</span>', ""), ("0 of 2", "num")]], caption="Schedules"),
    sub="2 schedules", id_="p-schedules", flush=True)

FLEET_CSS = """
.fl-bar { display: grid; gap: var(--space-4); }
.fl-bar__row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.fl-bar__t { min-width: 0; }
.fl-bar__t h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.fl-bar__t .muted { font-size: 13px; }
.fl-bar__stats { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.fl-bar__stats > span { display: inline-flex; align-items: baseline; gap: 5px; height: 34px; padding: 0 14px; align-items: center; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.fl-bar__stats b { color: var(--ink); font-size: 15px; }
.fl-bar__stats .tinted b { color: var(--failed-ink); }
.fl-prog { display: grid; gap: 4px; min-width: 190px; }
.fl-prog .reason { margin-top: 0; }
.fl-orphan td { background: var(--attention-tint); }
.tbl tbody tr.fl-orphan:hover td { background: var(--attention-tint); }
.fl-held { display: grid; gap: 8px; padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.fl-held__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.fl-held__h .end { margin-left: auto; }
.fl-cond { display: grid; gap: 4px; }
.fl-cond li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: var(--surface); font-size: 13px; }
.fl-cond li > .ic { color: var(--ink-muted); }
.fl-cond li > span:nth-child(2) { display: flex; flex-direction: column; line-height: 18px; }
.fl-cond .muted { font-size: 12px; }
.hostrow__x { min-width: 0; }
.hostrow__x > .fl-res, .fl-res { flex: 1 1 100%; min-width: 0; display: grid; grid-template-columns: 64px minmax(0, 1fr) 112px; align-items: center; gap: 10px; }
.fl-res__l { color: var(--ink-muted); }
.fl-res__v { color: var(--ink); font-weight: 600; white-space: nowrap; text-align: right; }
.fl-doc { display: grid; gap: 8px; padding-top: var(--space-3); margin-top: var(--space-3); border-top: 1px solid var(--line); }
.fl-doc:first-of-type { padding-top: 0; margin-top: 0; border-top: 0; }
.fl-doc__h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; }
.fl-doc__p { font-size: 13px; }
.fl-cnt { display: inline-flex; gap: 12px; font-size: 12px; }
.fl-cnt > span { display: inline-flex; align-items: center; gap: 4px; }
.fl-chks { display: grid; gap: 4px; }
.fl-chk { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.fl-chk .code { font-size: 12px; color: var(--ink-muted); }
.fl-chk__said { min-width: 0; }
.fl-chk__fix { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; }
.fl-chk__fix b { color: var(--ink); }
.fl-asserted { background: var(--surface-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.fl-absent { background: transparent; color: var(--ink-faint); box-shadow: none; border: 1px dashed var(--line); }
.fl-vfoot { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-muted); }
.fl-vfoot > span { display: inline-flex; align-items: center; gap: 6px; }
.fl-floor { margin-left: 0; }
.fl-why { display: block; max-width: 420px; }
@media (max-width: 760px) { .fl-bar__stats { margin-left: 0; } .fl-floor { margin-left: 0; } .hostrow__x > .fl-res { grid-template-columns: 56px minmax(0, 1fr) auto; } }
"""

def fleet():
    inner = FLEETBAR + ACTIVE + f'<div class="cols cols--wide-side"><div class="stack">{QUEUES}{HELD}{FAILED}{SCHEDULES}</div><div class="stack">{HOSTS}{DOCTOR}</div></div>' + VENUES
    return shell("Fleet", inner, "Fleet", sub="Queues, hosts and their health. Every pause, cancel and removal previews first.")

write("FleetScreen", card_marker("Screens", 2600, 1440, "Fleet: the kill switch with its preview open, queues, active and held jobs, hosts, doctor, venues"),
      "Fleet", fleet(), FLEET_CSS)
readme("FleetScreen", """
Fleet is where an operator keeps the fleet healthy and unsticks the queue: the kill switch, queues, active, held and failed jobs, hosts, doctor results, venues and schedules.

**How a person uses it.**
- **The fleet bar.** It says in one line whether the fleet runs and how many jobs wait, run, are delayed, held or await retry. *Pause the fleet* is the kill switch. It is outlined in red, and its preview opens under it, naming every queue, what keeps running, the Valkey address and the undo ("Resume the fleet"), with a ticket that expires in 5 minutes. Only the confirm button is filled red.
- **Queues.** Each queue's state with waiting, active, delayed, paused and failed counts, and a Pause per queue.
- **Active jobs.** Every running job with its project, target, host, start, run time and progress (phases or turns where reported, stripes where the worker reports none). An orphaned hold such as gh-4a7e is flagged in yellow with what it costs ("build3 runs 1 job where it could run 2") and *Free the slot*.
- **Held.** Each held job with its conditions as a checklist (time, CI green) and whether each is met.
- **Failed jobs.** The reason sentence and next step inline; Retry is a paid act (amber outline), Remove is destructive (red outline); both also come in bulk.
- **Hosts.** Slots as dots, memory in GiB and CPU in cores as bars, heartbeat (late beyond 1 minute), venues and routes.
- **Doctor.** Failing, warning and passing counts per host, each check with its fix; a stale result is flagged; a host with no result says how to get one.
- **Venues.** One row per venue: where it is blessed and the default, two of its properties (egress, local folders) as enforced, asserted or absent, what it serves (steering, live transcript, recovery) as yes, no or with the image, and who holds the credentials. Each value is a word with a glyph, never colour alone. The footer names build3's floor and links to all 14 properties on the venue's own page.

**Panels.** `p-fleetbar`, `p-queues`, `p-active`, `p-held`, `p-failed`, `p-schedules`, `p-hosts`, `p-doctor`, `p-venues`.

**The server provides.**
- Queue counts per queue.
- Active jobs with project, target (once known), host, start and progress.
- Held jobs with each condition and its state.
- Failed jobs with attempts and the reason token, which the reason catalog turns into a sentence and next step.
- Per host: slots, memory and CPU (or none), last beat, venues and routes.
- Doctor results with version, age and checks.
- The venue table from the build, plus each host's published floor.
- Schedules with next run, overdue and stalls.

**Why it works this way.**
- The venue words are a closed set, and the table carries no legend: *enforced* means the worker makes it so and reads it back; *asserted* means someone else provides it and the worker cannot check; *absent* means it is not offered.
- *With the image* means a venue serves the feature only when the job image supports it.
- The venue table is what each host's worker published when it started; nothing in it is read live.

**Fixture note.** Queues, active, held and failed jobs, hosts, doctor checks and schedules come from the fixture. These are sample data:
- the projects of gh-e802, gh-c41f and local-9e20;
- maxTurns 40 for gh-e802's turn bar;
- gh-5d10's reason sentence;
- the venue property values;
- mini2 blessing openshell-bind beside openshell, where RunSandboxed's run is;
- the `pi-dispatch doctor` command.
""")

# ---------------- Fleet as a viewer sees it, and Fleet on a phone ----------------
# Both read the same rows as the operator's page (QROWS, ACTIVE_ROWS, HOST_ROWS below) and draw no action a viewer
# may not take; the viewer never sees a failure reason (failedReason) or a doctor check's text.
ACTIVE_ROWS = [("gh-b3d7", "web", "acme/web#415", "mini1", "15:27", "12m", "Phase 2 of 4, bash running 1m. Turn 7, 12 steps, 1 failed", 0.375),
               ("gh-e802", "billing", None, "build3", "14:19", "1h 20m", "Turn 31 of 40, 58 steps", 31 / 40),
               ("gh-c41f", "web", None, "mini1", "14:58", "41m", "This worker reports no progress", None),
               ("local-9e20", "ops", "folder", "mini2", "15:33", "6m", "This worker reports no progress", None)]
HOST_ROWS = [("build3", "attention", "podman", "late 3m", "attention", "rhf"),
             ("mini1", "ok", "local", "46s", "", "rrff"),
             ("mini2", "ok", "local, openshell, openshell-bind", "46s", "", "rf")]

FLEETBAR_VIEW = f"""<section class="card fl-bar" id="p-fleetbar" data-panel aria-labelledby="fl-bar-h">
  <div class="fl-bar__row">
    <span class="tile tone-ok">{ic('fleet')}</span>
    <div class="fl-bar__t"><h2 id="fl-bar-h">The fleet is running</h2><p class="muted">3 hosts beat, 4 queues accept jobs, and Valkey answers.</p></div>
    <div class="fl-bar__stats">
      <span><b>0</b> waiting</span><span><b>4</b> active</span><span><b>3</b> delayed</span><span><b>1</b> held</span><span class="tinted tone-failed"><b>1</b> awaiting retry</span>
    </div>
  </div>
</section>"""

def target_cell(t):
    if t is None:
        return '<span class="faint">shown when the run ends</span>'
    if t == "folder":
        return '<span class="muted">folder job</span>'
    return f'<a href="#">{t}</a>'

QUEUES_VIEW = card("Queues", table(
    [("Queue", ""), ("State", ""), ("Waiting", "num"), ("Active", "num"), ("Delayed", "num"), ("Paused", "num"), ("Failed", "num")],
    [[(f'<span class="code"><b>{q}</b></span><span class="reason">{sub}</span>', "id"), (state(st), ""), (num(w), "num"), (num(a), "num"), (num(d), "num"),
      (num(p), "num"), (f'<b class="tinted tone-failed">{f}</b>' if f else num(0), "num")]
     for q, sub, st, w, a, d, p, f in QROWS], caption="Queues"), id_="p-queues", flush=True)

ACTIVE_VIEW = card("Active jobs", table(
    [("Job", ""), ("Project", ""), ("Target", ""), ("Host", ""), ("Started", ""), ("Running for", "num"), ("Progress", "")],
    [[(f'<a href="#">{j}</a>', "id"), (tag(p), ""), (target_cell(t), "tgt" if t and t != "folder" else ""), (h, ""), (st_, "when"), (ran, "num"),
      (prog(pr, pct), "")] for j, p, t, h, st_, ran, pr, pct in ACTIVE_ROWS]
    + [("fl-orphan", [('<a href="#">gh-4a7e</a>', "id"), (tag("billing"), ""), ('<a href="#">acme/billing#290</a>', "tgt"), ("build3", ""), ("10:39", "when"), ("5h 0m", "num"),
      (f'{badge("attention", "Orphaned hold")}<span class="reason">Cancelled at 10:59, but it still holds a build3 slot.</span>', "")])], caption="Active jobs"),
    end='<span class="card__sub">4 running, 1 slot held</span>', id_="p-active", flush=True)

HELD_VIEW = card("Held", f"""<div class="fl-held">
    <div class="fl-held__h"><span class="code"><b>gh-77c1</b></span>{tag('web')}<a class="link" href="#">acme/web#415</a><span class="muted">held 2h 14m</span></div>
    <p class="card__sub">It starts when every condition is met</p>
    <ul class="fl-cond">
      <li>{ic('clock', 'ic ic--sm')}<span><b>After 2026-10-09 07:00 UTC</b><span class="muted">in 15h 21m</span></span>{chip('Pending', 'idle', 'hourglass')}</li>
      <li>{ic('done', 'ic ic--sm')}<span><b>A check</b><span class="muted">its name is shown to operators</span></span>{chip('Pending', 'idle', 'hourglass')}</li>
    </ul>
  </div>""", sub="1 job", id_="p-held")

FAILED_VIEW = card("Failed jobs", table(
    [("Job", ""), ("Queue", ""), ("Attempts", "num"), ("Failed", "")],
    [[('<a href="#">gh-5d10</a>', "id"), ('<span class="code">pi-jobs</span>', ""), ("<b>3</b> of 3", "num"), ("12:39 UTC", "when")]], caption="Failed jobs"),
    sub="why it failed is shown to operators", id_="p-failed", flush=True)

HOSTS_VIEW = card("Hosts", f"""<ul class="hosts">
  {hostrow("build3", "attention", "podman (default)", "3m", "attention", "rhf",
           res("Memory", 16384/24576, "16 of 24 GiB") + res("CPU", 8/12, "8 of 12 cores") +
           f'<span>Running <span class="code">gh-e802</span> 1h 20m, <span class="code">gh-4a7e</span> orphaned hold 5h 0m</span><span>Routes: yes</span><span class="tinted tone-attention">{ic("attention", "ic ic--sm")}Heartbeat late: 3m (expected within 1m)</span>', pause=False)}
  {hostrow("mini1", "ok", "local (default)", "46s", "", "rrff",
           res("Memory", 6144/16384, "6 of 16 GiB") + res("CPU", 3/8, "3 of 8 cores") +
           '<span>Running <span class="code">gh-c41f</span> 41m, <span class="code">gh-b3d7</span> 12m</span><span>Routes: yes</span>', pause=False)}
  {hostrow("mini2", "ok", "local (default), openshell, openshell-bind", "46s", "", "rf",
           '<span class="faint">This host reports no memory or CPU figures.</span><span>Running <span class="code">local-9e20</span> 6m</span><span>Routes: yes</span>', pause=False)}
</ul>""", sub="3 beating, 5 of 9 slots busy", id_="p-hosts")

DOCTOR_VIEW = card("Doctor", f"""<div class="fl-doc">
  <div class="fl-doc__h"><b>build3</b>{counts(1, 1, 38)}</div>
  {banner("attention", "clock", "Stale: this result is 3 days old", "Older than two of this host's doctor runs, so it may no longer describe the host.", small=True)}
</div>
<div class="fl-doc">
  <div class="fl-doc__h"><b>mini1</b>{counts(0, 1, 41)}<span class="card__sub">1h ago</span></div>
</div>
<div class="fl-doc">
  <div class="fl-doc__h"><b>mini2</b><span class="faint">No doctor result published</span></div>
</div>
<p class="muted fl-doc__p">Each check and its fix are shown to operators.</p>""", sub="each host's latest health check", id_="p-doctor")

def fleet_viewer():
    note = (f'<p class="collapsed" id="p-fl-viewer" data-panel>{ic("eye", "ic ic--sm")}<b>Viewer.</b> '
            'You see the fleet\'s state, its hosts and its queues. Pausing, cancelling, retrying and removing are for operators.</p>')
    inner = (FLEETBAR_VIEW + note + ACTIVE_VIEW +
             f'<div class="cols cols--wide-side"><div class="stack">{QUEUES_VIEW}{HELD_VIEW}{FAILED_VIEW}{SCHEDULES}</div><div class="stack">{HOSTS_VIEW}{DOCTOR_VIEW}</div></div>' + VENUES)
    return shell("Fleet", inner, "Fleet", sub="Queues, hosts and their health.", role="viewer")

write("FleetViewer", card_marker("Fleet", 2400, 1440, "Fleet as a viewer sees it: states, hosts, slots, queues and counts; no pause, cancel, retry or removal, and no failure reasons"),
      "Fleet, as a viewer", fleet_viewer(), FLEET_CSS)
readme("FleetViewer", """
Fleet as a viewer sees it: whether the fleet runs, what is in its queues, what runs where, and each host's health. Nothing on it acts.

**How a person uses it.**
- **The fleet bar** says the fleet is running, with the waiting, active, delayed, held and awaiting-retry counts. There is no *Pause the fleet*.
- **Active jobs**, **Queues**, **Held**, **Failed jobs**, **Schedules**, **Hosts**, **Doctor** and **Venues**, read as on the operator's page.
- One line under the bar says what is the operator's.

**Panels.** `p-fleetbar`, `p-fl-viewer`, `p-active`, `p-queues`, `p-held`, `p-failed`, `p-schedules`, `p-hosts`, `p-doctor`, `p-venues`.

**Who sees what.** Left out for a viewer:
- every action: *Pause the fleet*, each queue's *Pause*, *Cancel*, *Free the slot*, *Cancel all held*, *Retry*, *Remove* and their bulk forms, and each host's pause;
- the Valkey address (the bar says "Valkey answers", as the overview's first run does);
- a failed job's reason and next step (`failedReason` is the operator's, in a detail view only);
- a held job's check name (the waiting reason is said in the worker's vocabulary, as on the overview);
- the doctor checks' text and fixes, which name paths and settings; the counts and the stale warning stay.

**Fixture note.** The same fixture as FleetScreen: queues, active, held and failed jobs, hosts, doctor counts, venues and schedules.
""")

# ---- Fleet on a phone: the kill switch first, then hosts, then counts that link to the lists ----
def host_phone(name, lamp, ven, beat, beat_tone, seq):
    return f"""<li class="fp-host">
  <span class="dot tone-{lamp}"></span>
  <span class="fp-host__n"><b>{name}</b><span>{ven}</span></span>
  <span class="sls" aria-label="slots">{slots(seq)}</span>
  <span class="fp-host__b{(' tone-' + beat_tone) if beat_tone else ''}">{ic('beat', 'ic ic--sm')}{beat}</span>
</li>"""

def count_row(icon, n, what, sub, tone="", href="#"):
    return (f'<li><a class="fp-count{(" tone-" + tone) if tone else ""}" href="{href}"><span class="fp-count__n">{ic(icon, "ic ic--sm")}<b>{n}</b></span>'
            f'<span class="fp-count__t"><b>{what}</b><span>{sub}</span></span>{ic("chev-r", "ic ic--sm")}</a></li>')

FLEETBAR_PHONE = f"""<section class="card fp-bar" id="p-fleetbar" data-panel aria-labelledby="fp-bar-h">
  <div class="fp-bar__h"><span class="tile tile--sm tone-ok">{ic('fleet', 'ic ic--sm')}</span><h2 id="fp-bar-h">The fleet is running</h2></div>
  <p class="muted fp-bar__s">3 hosts beat, 4 queues accept jobs.</p>
  <dl class="fp-stats">
    <div><dt>waiting</dt><dd>0</dd></div><div><dt>active</dt><dd>4</dd></div><div><dt>delayed</dt><dd>3</dd></div>
    <div><dt>held</dt><dd>1</dd></div><div class="tone-failed"><dt>retry</dt><dd>1</dd></div>
  </dl>
  <button class="btn btn--danger fp-kill" type="button">{ic('pause', 'ic ic--sm')}Pause the fleet</button>
</section>"""

HOSTS_PHONE = card("Hosts", '<ul class="fp-hosts">' + "".join(host_phone(*h) for h in HOST_ROWS) + "</ul>"
                   + f'<p class="fp-foot">{ic("attention", "ic ic--sm")}<span>build3\'s heartbeat is 3m late (expected within 1m).</span></p>',
                   sub="5 of 9 slots busy", id_="p-hosts")

ACTIVE_PHONE = card("Active jobs", '<ul class="fp-jobs">' + "".join(
    f'<li><a class="code" href="#">{j}</a>{tag(p)}<span class="muted">{h}, {ran}</span></li>' for j, p, t, h, st_, ran, pr, pct in ACTIVE_ROWS)
    + f'<li class="fp-jobs--orphan"><a class="code" href="#">gh-4a7e</a>{tag("billing")}{badge("attention", "Orphaned hold")}</li></ul>',
    sub="4 running, 1 slot held", id_="p-active")

COUNTS_PHONE = card("Queues and waiting jobs", '<ul class="fp-counts">'
    + count_row("queue", 4, "Queues", "all running: pi-jobs and one per host")
    + count_row("hourglass", 3, "Delayed", "in pi-jobs")
    + count_row("clock", 1, "Held", "gh-77c1 on acme/web#415, waits for a time and CI green")
    + count_row("failed", 1, "Failed", "gh-5d10, 3 of 3 attempts, at 12:39 UTC", tone="failed")
    + count_row("doctor", 3, "Doctor checks need a look", "build3: 1 failing, 1 warning, result stale; mini1: 1 warning", tone="attention")
    + "</ul>", id_="p-queues")

def fleet_phone():
    inner = FLEETBAR_PHONE + HOSTS_PHONE + ACTIVE_PHONE + COUNTS_PHONE
    return shell("Fleet", inner, "Fleet", sub="Queues, hosts and their health.")

FLEET_PHONE_CSS = """
.fp-bar { display: grid; gap: 10px; }
.fp-bar__h { display: flex; align-items: center; gap: 10px; }
.fp-bar__h h2 { font-size: 18px; line-height: 24px; font-weight: 750; }
.fp-bar__s { font-size: 13px; }
.fp-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.fp-stats > div { display: grid; justify-items: center; gap: 2px; padding: 8px 4px; border-radius: var(--radius-md); background: var(--surface-2); }
.fp-stats dd { order: -1; margin: 0; font-size: 18px; line-height: 22px; font-weight: 800; color: var(--ink); font-variant-numeric: tabular-nums; }
.fp-stats dt { font-size: 11px; color: var(--ink-muted); }
.fp-stats .tone-failed dd, .fp-stats .tone-failed dt { color: var(--failed-ink); }
.fp-kill { width: 100%; justify-content: center; }
.fp-hosts { display: grid; gap: 8px; }
.fp-host { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.fp-host__n { display: grid; font-size: 14px; line-height: 19px; min-width: 0; }
.fp-host__n span { font-size: 12px; color: var(--ink-muted); }
.fp-host .sls { grid-column: 2; }
.fp-host__b { grid-column: 3; grid-row: 1; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.fp-host__b.tone-attention { color: var(--attention-ink); }
.fp-foot { display: flex; gap: 6px; align-items: flex-start; margin-top: 10px; font-size: 12px; line-height: 18px; color: var(--attention-ink); }
.fp-foot .ic { flex: none; margin-top: 2px; }
.fp-jobs { display: grid; gap: 6px; }
.fp-jobs li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.fp-jobs .code { font-weight: 650; }
.fp-counts { display: grid; gap: 6px; }
.fp-count { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); color: inherit; text-decoration: none; }
.fp-count__n { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-muted); }
.fp-count__n b { font-size: 17px; color: var(--ink); font-variant-numeric: tabular-nums; }
.fp-count.tone-failed .fp-count__n, .fp-count.tone-failed .fp-count__n b { color: var(--failed-ink); }
.fp-count.tone-attention .fp-count__n, .fp-count.tone-attention .fp-count__n b { color: var(--attention-ink); }
.fp-count__t { display: grid; font-size: 13px; line-height: 18px; min-width: 0; }
.fp-count__t span { font-size: 12px; color: var(--ink-muted); }
"""

write("FleetPhone", card_marker("Phone", 1800, 390, "Fleet on a phone: the kill switch first, then hosts, running jobs, and queues and waiting jobs as counts that link to their lists"),
      "Fleet on a phone", fleet_phone(), FLEET_CSS + FLEET_PHONE_CSS)
readme("FleetPhone", """
Fleet on a phone. The question on a phone is "is it running, and is anything stuck", so the kill switch and the counts come first, and every list is one tap away.

**How a person uses it.**
- **The fleet bar**: whether the fleet runs, the waiting, active, delayed, held and retry counts, and *Pause the fleet* as the one action, outlined red as on desktop. Its preview opens under it, as on desktop.
- **Hosts** as compact rows: the lamp, the venues, the slots as dots, and the heartbeat age. A late heartbeat says so in words.
- **Active jobs**: each run's id, project, host and time running, with the orphaned hold flagged.
- **Queues and waiting jobs** as counts with a line each: queues, delayed, held (with what it waits for), failed (with its attempts) and the doctor checks that need a look. Each opens its list on the full page.

**Panels.** `p-fleetbar`, `p-hosts`, `p-active`, `p-queues`.

**Who sees what.** A viewer gets the same card without *Pause the fleet*, and the failed row without a reason, as on FleetViewer.

**Fixture note.** The same fixture as FleetScreen, from the same rows (`QROWS`, `ACTIVE_ROWS`, `HOST_ROWS`).
""")

# =====================================================================================
# 2. CONFIGURATION
# =====================================================================================
SECTIONS = [("Settings", "13"), ("Pause windows", "1"), ("Scoped limits", "6"), ("Projects", "4"),
            ("MCP servers", "1"), ("pi packages", "0")]
PAGES = [("Triggers", "what starts a job"), ("Secrets", "profiles and bundles"), ("Connections", "forges, egress, endpoints")]
TABS = '<nav class="tabs cf-tabs" aria-label="Sections on this page, and the other Configuration pages">' + "".join(
    f'<a href="#cf-{n.lower().replace(" ", "-")}"{" aria-current=" + chr(34) + "page" + chr(34) if n == "Settings" else ""}>{n}<span class="count">{c}</span></a>' for n, c in SECTIONS) + \
    '<span class="cf-tabs__sep" aria-hidden="true"></span>' + "".join(
    f'<a href="#" class="cf-tabs__page" title="{s}">{n}{ic("chev-r", "ic ic--sm")}</a>' for n, s in PAGES) + "</nav>"

SAVED = banner("ok", "done", "Saved the pause windows",
               'Added <b>github:acme/web</b>, 22:00 to 06:00 Europe/Amsterdam, Monday to Friday. Written by ops at 15:12 UTC, audit row 4.',
               act=f'{btn("Undo", "ghost")}{btn("Audit row 4")}')

SETTINGS_VALUES = [("provider", "anthropic"), ("model", "claude-sonnet-5-5"), ("maxTurns", "30"), ("maxTokens", "400,000"),
                   ("concurrency", "4"), ("dailyCap", "40 jobs"), ("weeklyCap", "200 jobs"), ("monthlyCap", "600 jobs"),
                   ("dailyTokenCap", "8,000,000 tokens"), ("softHoldPct", "80%"), ("maxCostUsd", "$2.00 per job"),
                   ("dailyCostUsd", "$25.00"), ("weeklyCostUsd", "$120.00")]
KEYS = ["model", "provider", "maxTurns", "dailyCap", "weeklyCap", "monthlyCap", "maxTokens", "dailyTokenCap", "concurrency",
        "softHoldPct", "maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]

SETTINGS = card("Settings overlay", f"""
  {facts([(f'<span class="code">{k}</span>', f'<b>{v}</b>' if k == 'maxTurns' else v) for k, v in SETTINGS_VALUES], cols=2)}
  <form class="cf-form" aria-label="Change a setting">
    <p class="cf-form__h">{ic('config', 'ic ic--sm')}Change a setting</p>
    <div class="formrow">
      <div class="field cf-key"><label for="cf-k">Key</label><select id="cf-k" class="select"><option>maxTurns</option></select></div>
      <div class="field cf-val"><label for="cf-v">Value</label><input id="cf-v" class="input" value="40"></div>
      <button class="btn btn--primary" type="button">Preview the change</button>
    </div>
  </form>
  {diff("~/.pi-dispatch/settings.json", [("ctx", '"model": "claude-sonnet-5-5",'), ("ctx", '"provider": "anthropic",'),
                                       ("del", '"maxTurns": 30,'), ("add", '"maxTurns": 40,'), ("ctx", '"maxTokens": 400000,'), ("ctx", '"dailyCap": 40,')])}
  {confirm("safe", "Set maxTurns to 40", ["<b>maxTurns: 30 → 40</b>. A job may take up to 40 turns.",
                                         "Jobs that start after you confirm use it; running jobs keep 30.",
                                         "Written to <span class='code'>~/.pi-dispatch/settings.json</span> and audited as a write."],
           "Set maxTurns back to 30", "Confirm: set maxTurns to 40")}
""", end=btn("Unset a setting", "ghost"), sub="13 keys set", id_="cf-settings")

UNSET = card("Unset a setting", f"""
  <div class="formrow">
    <div class="field field--err cf-key2"><label for="cf-u">Key</label><input id="cf-u" class="input input--code" value="colour" aria-invalid="true" aria-describedby="cf-u-err"></div>
    <button class="btn" type="button" aria-disabled="true">Preview the unset</button>
  </div>
  <p id="cf-u-err" class="field__err" role="alert">{ic('failed', 'ic ic--sm')}Unknown key <span class="code">colour</span>. Nothing was changed.</p>
  <p class="field__hint">Valid keys: {', '.join('<span class="code">' + k + '</span>' for k in KEYS)}.</p>
""", sub="a form refuses what it cannot use, by name", id_="cf-unset")

TRIG = [("1", "clock", "Every day at 03:00 UTC", "tidy"), ("2", "tag", "Label <span class='code'>pi:frontend</span> on a GitHub issue", "frontend-fix"),
        ("3", "comment", "Comment <span class='code'>@pi</span> on GitHub", "fix"), ("4", "pr", "A GitLab merge request opened or updated", "review"),
        ("5", "issue", "GitHub issue #40 closed, once (spent)", "deploy"), ("6", "clock", "Every Monday at 06:00 UTC", "portfolio-manager"),
        ("7", "tag", "Label <span class='code'>pi:triage</span> on a GitHub issue", "triage")]
TRIGGERS = card("Triggers", '<ul class="rows cf-trig">' + "".join(
    f'<li class="rowpill"><span class="cf-trig__n">{n}</span>{ic(i, "ic ic--sm")}<span class="cf-trig__w">{w}</span>'
    f'<span class="cf-trig__r">{ic("chev-r", "ic ic--sm")}<b>{f}</b></span></li>' for n, i, w, f in TRIG) + "</ul>"
    '<p class="card__sub cf-trig__f">Each rule, its status, a week of schedules and a check for which rule an event starts are on the Triggers page.</p>',
    end=btn("Open Triggers", "primary", "bolt"), sub="7 rules, numbered 1 to 7 everywhere", id_="cf-triggers")

PAUSE = card("Pause windows", table(
    [("Scope", ""), ("From", ""), ("To", ""), ("Zone", ""), ("Days", ""), ("Next", ""), ("", "act")],
    [[('<span class="code"><b>github:acme/web</b></span>', "id"), ("22:00", ""), ("06:00", ""), ("Europe/Amsterdam", ""), ("Monday to Friday", ""),
      ('starts 20:00 UTC<span class="reason">in 4h 21m</span>', ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")]], caption="Pause windows"),
    end=btn("Add a window", "", "plus"), id_="cf-pause-windows", flush=True)

LIMITS = card("Scoped limits", table(
    [("Scope", ""), ("Limits", ""), ("", "act")],
    [[('<span class="code">github:acme/web</span>', "id"), ("20 jobs a day; 80 jobs a week; 6 at once", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")],
     [('<span class="code">project:billing</span>', "id"), ("8 GiB memory; 4 CPUs", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")],
     [('<span class="code">project:api</span>', "id"), ("2 GiB memory; 1 CPU", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")],
     [('<span class="code">project:ops</span>', "id"), ("2 GiB memory; 1 CPU", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")],
     [('<span class="code">project:web</span>', "id"), ("$45.00 a week", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")],
     [('<span class="code">model:anthropic/claude-sonnet-5-5</span>', "id"), ("$80.00 a week", ""), (f'{btn("Edit")} {btn("Delete", "danger")}', "act")]], caption="Scoped limits"),
    end=btn("Add a limit", "", "plus"), id_="cf-scoped-limits", flush=True)

PROJECTS = card("Projects", table(
    [("Project", ""), ("Members", ""), ("", "act")],
    [[(tag("web"), ""), ('<span class="code">github:acme/web</span>', ""), (btn("Edit"), "act")],
     [(tag("api"), ""), ('<span class="code">github:acme/api</span>', ""), (btn("Edit"), "act")],
     [(tag("billing"), ""), ('<span class="code">github:acme/billing</span>, <span class="code">gitlab:acme/billing-ui</span>', ""), (btn("Edit"), "act")],
     [(tag("ops"), ""), ('<span class="code">…/site</span>, <span class="code">…/pm</span>', ""), (btn("Edit"), "act")]], caption="Projects")
    + '<p class="tbl-foot">Allocation envelope: <b>set</b>.</p>',
    end=btn("Add a project", "", "plus"), id_="cf-projects", flush=True)

MCP = card("MCP servers", f"""<ul class="rows">
  <li class="rowpill"><b class="code">linear</b><span>http</span><span class="code">mcp.example.com</span><span class="end"><span class="muted">codemode</span>{chip('on', 'ok', 'done')}</span></li>
</ul><p class="card__sub cf-names">References <span class="code">LINEAR_API_KEY</span>, by name.</p>""", sub="1 server", id_="cf-mcp-servers")

EMPTIES = card("Not set up yet", f"""<ul class="rows cf-empties">
  <li class="rowpill" id="cf-pi-packages">{ic('queue', 'ic ic--sm')}<b>pi packages</b><span>None staged</span><a class="rowpill__act" href="#">Stage one</a></li>
  <li class="rowpill" id="cf-secret-profiles">{ic('shield', 'ic ic--sm')}<b>Secret profiles</b><span>None declared</span><a class="rowpill__act" href="#">Open Secrets</a></li>
  <li class="rowpill" id="cf-secret-bundles">{ic('slot-held', 'ic ic--sm')}<b>Secret bundles</b><span>No resolver; none bound</span><a class="rowpill__act" href="#">Open Secrets</a></li>
</ul>""", sub="3 sections are empty", id_="cf-empty")

CONFIG_CSS = """
.cf-tabs a .count { background: var(--surface-3); color: var(--ink-muted); }
.cf-trig .rowpill { gap: 10px; }
.cf-trig__n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); font-size: 11px; font-weight: 750; flex: none; }
.cf-trig__w { flex: 1; min-width: 0; color: var(--ink); }
.cf-trig__r { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-muted); }
.cf-trig__r b { color: var(--ink); }
.cf-trig__f { margin-top: var(--space-3); }
.cf-tabs__sep { width: 1px; align-self: stretch; margin: 6px 4px; background: var(--line-strong); }
.cf-tabs__page { box-shadow: inset 0 0 0 1px var(--line-strong); }
.cf-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.cf-form { display: grid; gap: var(--space-3); margin: var(--space-5) 0 var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.cf-form__h { display: flex; align-items: center; gap: 8px; font-weight: 650; }
.cf-key { width: 220px; } .cf-val { width: 160px; } .cf-key2 { width: 260px; }
#cf-settings .diff { margin-bottom: var(--space-3); }
#cf-unset .formrow { margin-bottom: 8px; }
#cf-unset .field__hint { margin-top: 6px; line-height: 20px; }
.cf-names { margin-top: var(--space-3); }
.cf-empties b { min-width: 112px; }
.cf-note { display: block; font-size: 12px; color: var(--ink-muted); }
@media (max-width: 760px) { .cf-key, .cf-val, .cf-key2 { width: 100%; } }
"""

def config():
    sub = 'Settings in <span class="code">~/.pi-dispatch/settings.json</span>; triggers in <span class="code">…/deploy/triggers.json</span>.'
    inner = SAVED + TABS + f'<div class="cols config-layout"><div class="stack">{SETTINGS}{TRIGGERS}{PAUSE}{LIMITS}{PROJECTS}</div><div class="stack">{UNSET}{MCP}{EMPTIES}</div></div>'
    return shell("Configuration", inner, "Configuration", sub=sub)

CONFIG_CSS += CONFIG_CONTROLS_CSS

write("ConfigScreen", card_marker("Screens", 2400, 1440, "Configuration: a setting's edit with its diff preview and confirm bar open, triggers with row actions, a refused key"),
      "Configuration", config(), CONFIG_CSS)
readme("ConfigScreen", """
Configuration shows the nine sections of the deployment's settings as readable tables, each with an editor whose every change previews as a diff before Confirm.

**How a person uses it.**
- **Where it lives.** The title bar says where the files are (`~/.pi-dispatch/settings.json`, outside the deployment folder, and the triggers file), so nobody has to preview a change to find out.
- **After a write.** A green banner names what changed, who wrote it, its audit row, and offers the undo.
- **Sections.** A pill row jumps to each section on this page and shows its count; empty sections collapse to one line ("No secret profile is declared"). After a divider, outlined pills open the other pages: *Triggers*, *Secrets* (profiles and bundles) and *Connections* (forges, egress, model endpoints, notifications). A project row opens *Project detail*.
- **Settings.** All keys as facts. *Change a setting* takes a key from a select (a closed list) and a value. *Preview the change* opens a diff (`-` and `+` lines) and a confirm bar with what it means, when it applies, where it is written, the undo line ("Set maxTurns back to 30") and a 5-minute ticket.
- **Refusals.** A form refuses what it cannot use, by name: the unset form rejects `colour` and lists the valid keys.
- **Triggers.** A short list, one line per rule (\"Every day at 03:00 UTC\" to *tidy*), numbered 1 to 7 as everywhere. *Open Triggers* goes to the Triggers page, which has each rule in full.
- **The rest.** Pause windows, scoped limits and projects get the same row actions. MCP servers and secrets show variable names only, never values.

**Panels.** `cf-settings`, `cf-triggers`, `cf-pause-windows`, `cf-scoped-limits`, `cf-projects`, `cf-unset`, `cf-mcp-servers`, plus one line each for pi packages, secret profiles and secret bundles.

**The server provides.**
- Each section's rows and their file paths.
- For a preview: the diff, the plan sentence, the undo plan and a single-use ticket (5 minutes).
- After a write: the change summary and its audit row.
- For refusals: the field and the closed list of valid values.

**Why it works this way.**
- The settings overlay lives in `~/.pi-dispatch/settings.json`, outside the deployment folder; the triggers live in `…/deploy/triggers.json`. The title bar names both, so no side card repeats them.
- Every change on this page is a preview, then Confirm, then an audit row. That is the console's rule for every write, so the page does not restate it.

**Fixture note.** Triggers, settings, the pause window, scoped limits, projects, the MCP server and the empty sections come from the fixture. These are sample data:
- the triggers file path `…/deploy/triggers.json`;
- the "applies to jobs that start after you confirm" sentence;
- the after-write banner, which reflects audit row 4.

Rows are numbered 1 to 7 here, where the fixture numbered them 0 to 6 (#711: one numbering everywhere).
""")

# =====================================================================================
# 3. AUDIT
# =====================================================================================
def who(name, role):
    if name == "anonymous":
        return f'<span class="au-who"><span class="avatar au-av">?</span><span>anonymous<small>no role</small></span></span>'
    return f'<span class="au-who"><span class="avatar au-av">{name[:2]}</span><span>{name}<small>{role}</small></span></span>'

AROWS = [
    ("8", "15:46", ("ops", "operator"), "write", "settings.json", "unverified", "after a damaged row"),
    ("7", "15:44", ("ops", "operator"), "write", "triggers.json", "damaged", ""),
    ("6", "15:39", ("ops", "operator"), "login", "-", "ok", "-"),
    ("5", "15:39", ("ops", "operator"), "login", "-", "ok", "-"),
    ("4", "15:12", ("ops", "operator"), "write", "pause-windows.json", "ok", "-"),
    ("3", "15:10", ("anonymous", ""), "login-failed", "/login", "refused", "no token matched"),
    ("2", "15:09", ("ops", "operator"), "login", "-", "ok", "-"),
    ("1", "14:39", ("console", "operator"), "serve-started", "-", "ok", "-"),
]
def arow(seq, at, wh, act, tgt, oc, reason):
    tgtc = f'<span class="code">{tgt}</span>' if tgt != "-" else '<span class="faint">-</span>'
    if oc == "ok":
        ocb = badge("completed", "ok")
    elif oc == "refused":
        ocb = badge("refused", "refused")
    elif oc == "damaged":
        ocb = badge("failed", "damaged")
    else:
        ocb = f'<span class="badge tone-idle">{ic("hourglass")}not verified</span>'
    rs = f'<span class="muted">{reason}</span>' if reason not in ("-", "") else '<span class="faint">-</span>'
    if oc == "damaged":
        rs = '<span class="au-dmg"><b>Its hash does not follow row 6.</b> Changed, or a row before it was removed.</span>'
    cls = "au-bad" if oc == "damaged" else ""
    cells = [(f"<b>{seq}</b>", "num"), (f'{at} UTC<span class="reason">Thu 8 Oct</span>', "when"), (who(*wh), ""), (f'<span class="code">{act}</span>', ""), (tgtc, ""), (ocb, ""), (rs, "")]
    return (cls, cells) if cls else cells

AUDIT_FILTERS = f"""<div class="filterbar">
  <label class="search">{ic('search')}<input type="search" placeholder="Search targets and reasons"></label>
  <button class="fpill" type="button">Who: <b>All</b>{ic('chev', 'ic ic--sm')}</button>
  <button class="fpill" type="button">Action: <b>All</b>{ic('chev', 'ic ic--sm')}</button>
  <button class="fpill" type="button">Outcome: <b>All</b>{ic('chev', 'ic ic--sm')}</button>
</div>"""

CHAIN = banner("failed", "chain", "Chain verified through row 6. Row 7 is damaged.",
               "Its hash does not follow row 6, so row 7 and every row after it cannot be trusted. Keep the file as it is and compare it with your last backup.",
               act=btn("Show row 7", "primary"))

AUDIT_TABLE = card("Audit log", table(
    [("Seq", "num"), ("At", ""), ("Who", ""), ("Action", ""), ("Target", ""), ("Outcome", ""), ("Reason", "")],
    [arow(*r) for r in AROWS], caption="Audit log") + '<div class="tbl-foot">Showing 8 of 8 rows<span class="pager"><button class="btn btn--sm" type="button" aria-disabled="true">Newer</button><button class="btn btn--sm" type="button" aria-disabled="true">Older</button></span></div>',
    sub="newest first; every write, sign-in and refusal", id_="p-audit", flush=True)

AUDIT_SIDE = card("About this log", facts([
    ("Rows", "<b>8</b>"), ("Verified", "rows 1 to 6"), ("Damaged", '<b class="tinted tone-failed">row 7</b>'), ("Not verified", "row 8"),
    ("Each row keeps", "who, what, target, outcome, reason and a hash of the row before"),
    ("Who sees it", "operators only; viewers do not see this page")], cols=1), id_="p-audit-about")

AUDIT_CSS = """
.au-who { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.au-who > span:last-child { display: flex; flex-direction: column; line-height: 16px; }
.au-who small { font-size: 11px; color: var(--ink-muted); }
.au-av { width: 28px; height: 28px; font-size: 11px; }
.au-bad td { background: var(--failed-tint); }
.tbl tbody tr.au-bad:hover td { background: var(--failed-tint); }
.au-dmg { display: block; max-width: 230px; font-size: 12px; line-height: 17px; color: var(--ink); }
.au-dmg b { color: var(--failed-ink); }
"""

def audit():
    inner = CHAIN + AUDIT_FILTERS + f'<div class="cols"><div class="stack">{AUDIT_TABLE}</div><div class="stack">{AUDIT_SIDE}</div></div>'
    return shell("Audit", inner, "Audit log", sub="Hash-chained. Every write, who made it and what came of it.")

write("AuditScreen", card_marker("Screens", 1100, 1440, "Audit log: the hash chain's state first, then every write and sign-in, with a damaged row flagged"),
      "Audit log", audit(), AUDIT_CSS)
readme("AuditScreen", """
The audit log lists every write, sign-in and refusal in a hash chain, and says first whether the chain still holds.

**How a person uses it.**
- **Chain state.** The banner on top says how far the chain is verified. When a row is damaged, it says what that means and what to do: keep the file, compare it with a backup.
- **Filters.** A search for targets and reasons, plus closed lists for who, action and outcome.
- **The table.** Seq, At (UTC), Who (name and role), Action, Target, Outcome (a badge with a glyph and a word: ok, refused, damaged, not verified) and Reason.
- **A damaged row** is tinted red with its sentence inline. Rows after it are marked *not verified*.
- **About this log.** A side card summarises rows, verified range and who can see the page (operators only).

**Panels.** `p-audit`, `p-audit-about`, and the chain banner.

**The server provides.**
- The rows, newest first, 50 per page.
- Each row's verification state.
- The first damaged row, if any.

**Fixture note.** Rows 1 to 6 come from the fixture. Rows 7 (damaged) and 8 (not verified) are sample data, there to show the damaged state.
""")

# =====================================================================================
# 4. SIGN-IN
# =====================================================================================
VARIANTS = [
    ("failed", "failed", "That token is not valid for this console", "Check that you copied all of it, or make a new one."),
    ("attention", "clock", "This sign-in link was used or has expired", "A link works once, for 60 seconds. Make a new one with <span class='code'>/dispatch console</span>."),
    ("idle", "clock", "You were signed out after 60 minutes idle", "Sign in again to carry on. Nothing you were doing was lost."),
    ("idle", "hourglass", "You were signed out after 12 hours", "That is the longest a session lasts. Sign in again."),
    ("attention", "slot-held", "Your token was revoked or rotated", "Ask an operator for a new token, or make a link from pi."),
    ("idle", "shield", "Your role changed, so you were signed out", "Sign in again to carry on with your new role."),
    ("idle", "logout", "An operator ended every session", "Sign in again. Your token still works."),
    ("idle", "logout", "You signed out in another tab", "Sign in again to carry on here."),
    ("attention", "clock", "Too many sign-in attempts", "Wait a minute and try again."),
    ("failed", "config", "The console's tokens file cannot be used right now", "An operator should run <span class='code'>pi-dispatch doctor</span> on the host."),
    ("failed", "audit", "The audit log could not be written, so the sign-in was refused", "Check the console's log directory. Nothing else changed."),
    ("idle", "rerun", "The console restarted, so every session ended", "Sign in again. Nothing else changed."),
    ("attention", "beat", "Console not reachable, retrying", "Your page stays as it is. Retrying every 5 seconds."),
]
SIGNIN = f"""<a class="skip" href="#si-token">Skip to sign-in</a>
<main id="main" class="page si-page">
  <header class="top"><a class="brandpill" href="#"><span class="brandpill__m">pi</span>pi-dispatch</a>
    <div class="top__end"><button class="roundbtn" type="button" aria-label="Theme: follows the system">{ic('theme')}</button></div></header>
  <div class="si-grid">
    <section class="si-card" id="p-signin" data-panel aria-labelledby="si-h">
      <span class="brandpill__m si-mark">pi</span>
      <h1 id="si-h">Sign in to the console</h1>
      <p class="muted">Paste a console token, or open a one-time link from pi.</p>
      <form class="si-form" aria-label="Sign in">
        <div class="field"><label for="si-token">Console token</label><input id="si-token" class="input si-input" type="password" autocomplete="off" placeholder="pdc_…"></div>
        <button class="btn btn--primary btn--lg si-go" type="button">Sign in</button>
      </form>
      <div class="si-help">
        <p class="si-help__h">No token yet?</p>
        <p class="muted">Make a link from pi. It works once, for 60 seconds:</p>
        {cmd('/dispatch console')}
        <p class="muted">Or make a token on the host:</p>
        {cmd('pi-dispatch-console token add --name <you> --role operator')}
      </div>
      <p class="si-foot faint">This console answers on 127.0.0.1 only. Reach it locally or through an SSH tunnel.</p>
    </section>
    <section class="si-variants" aria-labelledby="si-v">
      <h2 id="si-v">What this page says</h2>
      <p class="muted si-v__s">One notice at a time, above the token field.</p>
      <div class="stack si-v__list">{''.join(banner(t, i, h, s, small=True) for t, i, h, s in VARIANTS)}</div>
    </section>
  </div>
</main>"""

SIGNIN_CSS = """
.si-page { min-height: 100vh; }
.si-grid { display: grid; grid-template-columns: 560px 480px; justify-content: center; align-items: start; gap: var(--space-8); margin-top: var(--space-6); }
.si-card, .si-card > *, .si-help > * { min-width: 0; }
.si-card { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); padding: 40px; border-radius: var(--radius-xl); background: var(--surface); }
.si-mark { width: 52px; height: 52px; font-size: 18px; }
.si-card h1 { font-size: 32px; line-height: 38px; font-weight: 800; letter-spacing: -0.02em; }
.si-form { display: grid; gap: var(--space-3); }
.si-input { height: var(--control-h); border-radius: var(--radius-pill); padding: 0 20px; font-family: var(--font-mono); }
.si-go { width: 100%; }
.si-help { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.si-help .cmd { background: var(--surface); }
.si-help__h { font-weight: 650; }
.si-foot { font-size: 12px; }
.si-variants h2 { font-size: 17px; font-weight: 650; }
.si-v__s { font-size: 13px; margin: 4px 0 var(--space-3); }
.si-v__list { gap: 8px; }
.si-v__list .banner { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.si-v__list .banner .tile { background: var(--tone-tint); }
@media (max-width: 760px) { .si-grid { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); margin-top: 0; } .si-card { padding: var(--space-5); } .si-card h1 { font-size: 26px; line-height: 32px; } }
"""

write("SignIn", card_marker("Screens", 1120, 1440, "Sign in: a token field, help on where tokens and links come from, and every notice this page can show"),
      "Sign in", SIGNIN, SIGNIN_CSS)
readme("SignIn", """
Sign-in is a single centered card: paste a console token or open a one-time link from pi, with help that says exactly where both come from.

**How a person uses it.**
- **The token.** A person pastes the token and presses *Sign in*.
- **No token yet.** The help block gives the two commands with a copy button each: `/dispatch console` in pi, which prints the address and a link that works once for 60 seconds, and `pi-dispatch-console token add --name <you> --role operator` on the host.
- **Notices.** One notice at a time sits above the token field, each saying what happened and what to do.
  - Why a session ended: 60 minutes idle (an open live tab does not count), the 12-hour maximum, a revoked or rotated token, a changed role, an operator ending every session, signing out in another tab, or a console restart.
  - Why a sign-in was refused: a wrong token, a used or expired link, too many attempts (5 a minute), a tokens file the console cannot use, or an audit log it cannot write.
  - "Console not reachable, retrying" keeps the page instead of going to the browser's error page.
- **Where it answers.** The footer says the console answers on 127.0.0.1 only.

**Panels.** `p-signin`.

**The server provides.** The notice as a closed reason, never echoed input: `ended=idle|max|revoked|role|all|elsewhere|restart`, or the refusal (401 wrong token, 401 link used or expired, 429 too many attempts, 503 tokens file, 500 audit log). Today the repo's login page says nothing about why a session ended; the `ended` reason is the change this design asks for.

**Fixture note.** The token placeholder `pdc_…` and the 5-second retry interval are sample values.
""")

# =====================================================================================
# 5. ERROR PAGE
# =====================================================================================
ERR = f"""<section class="card er-card" id="p-error" data-panel aria-labelledby="er-h">
  <span class="tile tone-idle er-tile">{ic('search', 'ic ic--lg')}</span>
  <p class="er-code">404</p>
  <h2 id="er-h" class="er-h">No run with that id</h2>
  <p class="er-s">You asked for <span class="code er-id">gh-zzzz</span>. This host's run history and the queue have no run by that id. It may be older than the history keeps, or the id may be mistyped.</p>
  <label class="search er-search">{ic('search')}<input type="search" value="gh-zzzz" aria-label="Search runs"></label>
  <div class="er-act">{btn('Go to Runs', 'primary', 'runs', sm=False)}{btn('Go to Overview', '', 'home', sm=False)}</div>
</section>
<section class="card er-421" id="p-error-421" data-panel aria-labelledby="er421-h">
  <span class="tile tone-attention">{ic('shield')}</span>
  <div class="er-421__t">
    <p class="er-code">421</p>
    <h2 id="er421-h">This console answers on 127.0.0.1 only</h2>
    <p class="muted">Your browser asked for <span class="code">myhost.lan</span>, so the console refused the request. Open it through an SSH tunnel and use the local address:</p>
    {cmd('ssh -L 7788:127.0.0.1:7788 build3')}
  </div>
</section>"""

ERR_CSS = """
.er-card { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: 56px var(--space-6); text-align: center; }
.er-tile { width: 64px; height: 64px; border-radius: 20px; }
.er-code { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--ink-muted); }
.er-h { font-size: 36px; line-height: 42px; font-weight: 800; letter-spacing: -0.02em; }
.er-s { max-width: 560px; color: var(--ink-muted); font-size: 15px; line-height: 22px; }
.er-id { color: var(--ink); font-weight: 700; }
.er-search { width: 420px; max-width: 100%; background: var(--surface-2); margin-top: var(--space-2); }
.er-act { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.er-421 { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-4); align-items: start; max-width: 760px; justify-self: center; width: 100%; }
.er-421__t { display: grid; gap: 8px; }
.er-421 h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.er-421 .muted { font-size: 14px; }
"""

def error_page():
    return shell("Runs", ERR, "Page not found", sub="The console could not find what this address points to.")

write("ErrorPage", card_marker("Screens", 1100, 1440, "Error pages with the nav: 404 for an unknown run id, and a 421 for a refused host"),
      "Page not found", error_page(), ERR_CSS)
readme("ErrorPage", """
Error pages keep the console's nav and say in one sentence what went wrong and how to get back, instead of raw JSON.

**How a person uses it.**
- **404.** The page names the id the person asked for, says where the console looked and why it may be missing, and offers a search pill already filled with that id, plus Runs and Overview.
- **421.** The console only answers on 127.0.0.1. The page names the host the browser asked for and gives the SSH tunnel command to copy.
- **400** follows the same pattern: the field it could not use, by name, and a way back.
- Error pages carry the same CSP and escaping as every page. The API keeps answering in JSON.

**Panels.** `p-error`, `p-error-421`.

**The server provides.** The status, a fixed sentence from the reason catalog, the requested id (escaped), and for 421 the Host it refused.

**Fixture note.** These are sample values: the id `gh-zzzz`, the host `myhost.lan`, and the tunnel command with port 7788.
""")

print("fleet, config, audit, sign-in, error written")
