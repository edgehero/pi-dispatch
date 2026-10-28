"""SandboxesScreen: open a run's kept workspace in a terminal from the console, or a fresh sandbox for a repository with no
run behind it. The recommended route hands off to the person's own terminal; a browser terminal is shown as a proposal,
off by default, because specs/design.md rejected it (#642). Pulse kit."""
from pulse import *

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'

def runs_tabs(cur):
    items = [("All runs", "runs", ""), ("Zero touch", "flag", "18%"), ("Sandboxes", "box", "2 open")]
    return '<nav class="tabs sx-tabs" aria-label="Runs views">' + "".join(
        f'<a href="#"{" aria-current=" + chr(34) + "page" + chr(34) if n == cur else ""}>{ic(i, "ic ic--sm")}{n}'
        f'{f"<span class=count>{c}</span>" if c else ""}</a>' for n, i, c in items) + "</nav>"

# ---------------- routes: how a sandbox opens ----------------
def routes(job, host, name="sx-route"):
    term = f"""<label class="sx-ch sx-ch--on"><input type="radio" name="{name}" checked>
    <span class="sx-ch__h">{ic('terminal', 'ic ic--sm')}<b>In your terminal</b><span class="sx-rec">recommended</span></span>
    <span class="sx-ch__s">Your terminal opens with the command typed in and waits for Enter. The link holds no secret.</span>
    <span class="sx-ch__a">{btn('Open in Terminal', 'primary', 'terminal', sm=False)}</span>
    <span class="sx-ch__f">Needs the opener on this computer, once:</span>
    {cmd('pi-dispatch opener install')}
  </label>"""
    copy = f"""<label class="sx-ch"><input type="radio" name="{name}">
    <span class="sx-ch__h">{ic('edit', 'ic ic--sm')}<b>Copy the command</b></span>
    <span class="sx-ch__s">On {host}, where the workspace is kept:</span>
    {cmd(f'pi-dispatch sandbox {job}')}
    <span class="sx-ch__s">From another computer, through the SSH target set for {host} in Fleet:</span>
    {cmd(f'ssh -t {host} pi-dispatch sandbox {job}')}
  </label>"""
    browser = f"""<label class="sx-ch sx-ch--off"><input type="radio" name="{name}" disabled>
    <span class="sx-ch__h">{ic('globe', 'ic ic--sm')}<b>In this browser</b>{chip('Off: proposed', 'idle', 'pause')}</span>
    <span class="sx-ch__s">Off on this deployment. <a class="link" href="#p-sb-browser">See the proposal</a>.</span>
  </label>"""
    return f'<div class="sx-chs" role="radiogroup" aria-label="How it opens">{term}{copy}{browser}</div>'

# ---------------- A: from a run ----------------
def from_run():
    head = f"""<div class="sx-run">
  <span class="tile tone-ok">{ic('box')}</span>
  <div class="sx-run__b">
    <p class="sx-run__t">{code('gh-9575')}{tag('web')}<a class="link" href="#">acme/web#490</a>{badge('completed')}</p>
    <p class="sx-run__s">fix on mini1 {venue('local')} ended 15:12 UTC. Kept until 15:12 UTC tomorrow, <b>23h 33m</b> from now.</p>
  </div>
</div>"""
    what = facts([("Image", "pi-job:latest, as its manifest records it"), ("/workspace", "the clone it worked in"),
                  ("/job", "read only: its prompt.md, event.json and pi/"), ("Processes", "none: you start what you want"),
                  ("Credentials", "none, on purpose"), ("Network", "a job's: the allowlist through the egress proxy")], 3)
    body = f"""{head}
  <p class="sx-h3">What opens</p>
  {what}
  <p class="sx-h3">How it opens</p>
  {routes('gh-9575', 'mini1')}
  <div class="sx-foot">
    <p>{ic('info', 'ic ic--sm')}<span>A port on the host (<span class="code">--publish</span>) is refused while egress is on, as it is on mini1. Pinning keeps the workspace 7 days instead of 24 hours.</span></p>
    {btn('Pin for 7 days', '', 'clock')}
  </div>"""
    return card("From a run", body, sub="the same image, workspace and isolation as the run", id_="p-sb-run")

# ---------------- B: without a run ----------------
def without_run():
    form = f"""<div class="sx-form">
  <div class="field"><label for="sx-r">Repository</label><select id="sx-r" class="select"><option>acme/web</option><option>acme/api</option><option>acme/billing</option></select></div>
  <div class="field"><label for="sx-p">As the jobs of</label><select id="sx-p" class="select"><option>trigger 3, comment "@pi", flow fix</option><option>trigger 2, label pi:triage</option></select><span class="field__hint">Its image, size and egress, because a project's triggers can differ.</span></div>
  <div class="field sx-span2"><span class="field__l" id="sx-from-l">Start from</span>
    <div class="sx-from"><div class="seg" role="group" aria-labelledby="sx-from-l"><button type="button" aria-pressed="true">Branch</button><button type="button" aria-pressed="false">Pull request</button><button type="button" aria-pressed="false">Commit or tag</button></div>
    <input class="input input--code" value="main" aria-label="Branch, the default is main"></div></div>
  <div class="field"><label for="sx-h">Host</label><select id="sx-h" class="select"><option>mini1, local</option><option>mini2, local</option></select><span class="field__hint">Where trigger 3's runs may go.</span></div>
  <div class="field"><span class="field__l" id="sx-keep-l">Keep it</span><div class="seg" role="group" aria-labelledby="sx-keep-l"><button type="button" aria-pressed="true">24 hours</button><button type="button" aria-pressed="false">Pin 7 days</button></div></div>
  <div class="field"><label for="sx-port">Port on the host</label><input id="sx-port" class="input input--code" placeholder="3000" disabled aria-describedby="sx-port-h"><span class="field__hint" id="sx-port-h">Only with egress off on mini1. It is on.</span></div>
</div>"""
    given = facts([("Image", "pi-job:latest, trigger 3's image"), ("Size", "2,048 MiB, 1 CPU, as web's jobs get"),
                   ("Network", "the allowlist through the proxy on mini1"), ("Credentials", "none in the shell")], 2)
    conf = confirm("safe", "Prepare a sandbox for acme/web at main",
        ["The worker on <b>mini1</b> clones <b>acme/web</b> at <b>main</b> with a read-only token for that one repository, then drops the token",
         "No container starts here. It starts when you open it: <b>pi-job:latest</b>, as trigger 3's jobs get it, with a job's isolation and egress, no credentials, no agent, no model",
         "Kept like a run's workspace, as <b>sb-3c1f</b>, for 24 hours",
         "Costs no dollars and takes no run slot"],
        "remove it under Kept workspaces; it is deleted after 24 hours anyway", "Prepare sandbox")
    body = f"""{form}
  <p class="sx-h3">Given by the trigger, not chosen here</p>
  {given}
  {conf}
  <p class="sx-h3">Then open it</p>
  <p class="sx-p">Open it like a run's, in your terminal. Or prepare it from a terminal in one line:</p>
  {cmd('pi-dispatch sandbox --new acme/web --ref main --as 3')}"""
    return card("Without a run", body, sub="a fresh clone with a trigger's image and a job's isolation", id_="p-sb-new")

# ---------------- C: in this browser (proposed) ----------------
TERM = [
    ("p", "pnpm install --frozen-lockfile"), ("o", "Lockfile is up to date, resolution step is skipped"), ("o", "Packages: +812"),
    ("o", "Done in 9.4s"),
    ("p", "pnpm test:ci"), ("o", " \u2713 src/export.test.ts (14 tests) 412ms"), ("o", " \u2713 src/limits.test.ts (9 tests) 88ms"),
    ("o", " Test Files  23 passed (23)"),
    ("p", "gh auth status"), ("o", "You are not logged into any GitHub hosts. To log in, run: gh auth login"),
    ("c", ""),
]
def term_mock():
    lines = []
    for k, t in TERM:
        if k == "p":
            lines.append(f'<span class="sx-tl"><span class="sx-ps">pi@sb-3c1f:/workspace$</span> {E(t)}</span>')
        elif k == "c":
            lines.append('<span class="sx-tl"><span class="sx-ps">pi@sb-3c1f:/workspace$</span> <span class="sx-cur" aria-hidden="true"></span></span>')
        else:
            lines.append(f'<span class="sx-tl sx-out">{E(t)}</span>')
    return f"""<figure class="sx-term" aria-label="Preview of a sandbox terminal in the browser">
  <div class="sx-term__h">
    <p class="sx-term__t">{ic('terminal', 'ic ic--sm')}{code('sb-3c1f')}<span>acme/web at main, mini1</span></p>
    <p class="sx-term__c"><span>{ic('key', 'ic ic--sm')}no credentials</span><span>{ic('globe', 'ic ic--sm')}egress allowlist</span><span>{ic('clock', 'ic ic--sm')}logs out idle in 27:41</span></p>
  </div>
  <pre class="sx-term__b" tabindex="0">{''.join(lines)}</pre>
  <div class="sx-term__f">{btn('Detach', 'ghost')}{btn('End sandbox', 'danger', 'cancel')}<span>Ticket used at 15:36 UTC. What you type is not recorded; opening and ending are audited.</span></div>
</figure>"""

def browser_card():
    body = f"""<p class="sx-p">Off on this deployment. Whether to allow it is decided in <a class="link" href="#">#754</a>.</p>
  {term_mock()}"""
    return card("In this browser", body, sub="proposed", end=chip("Needs a decision", "attention", "attention"), id_="p-sb-browser")

# ---------------- side ----------------
def open_now():
    rows = [
        ("pi-sandbox-gh-9575", "from run", code("gh-9575") + ' <a class="link" href="#">acme/web#490</a>', "mini1, opened by ops in a terminal", "open since 15:20", "docker attach pi-sandbox-gh-9575"),
        ("sb-3c1f", "without a run", "acme/web at <span class=\"code\">main</span>", "mini1, opened by ops in a terminal", "open since 15:36", "docker attach pi-sandbox-sb-3c1f"),
    ]
    lis = "".join(f"""<li class="sx-open">
  <span class="dot tone-running"></span>
  <div class="sx-open__b">
    <p class="sx-open__t">{code(n)}<span class="sx-kind">{k}</span></p>
    <p class="sx-open__s">{what}</p>
    <p class="sx-open__s">{where}, {ic('clock', 'ic ic--sm')}{idle}</p>
    <div class="sx-open__a">{btn('Open in Terminal', '', 'terminal')}{btn('End', 'danger', 'cancel')}</div>
  </div>
</li>""" for n, k, what, where, idle, att in rows)
    body = f"""<ul class="sx-opens">{lis}</ul>
  <p class="sx-small">{ic('info', 'ic ic--sm')}<span>One per run at a time. <i>End</i> closes the shell and keeps the workspace.</span></p>"""
    return card("Open now", body, end=badge("running", "2 open"), id_="p-sb-open")

def kept():
    R = [("gh-9575", "web", "acme/web#490", "mini1", "local", "23h 33m left", "ok", "in use", True),
         ("gh-ebd7", "billing", "acme/billing#259", "build3", "podman", "pinned, 6d 21h left", "ok", "", True),
         ("gh-a3ac", "web", "acme/web#487", "mini1", "local", "22h 55m left", "ok", "", True),
         ("gh-8251-r1", "web", "acme/web#408", "mini1", "local", "22h 16m left", "attention", "", True),
         ("billing-sweep", "billing", "cron, 14:00", "mini2", "openshell-bind", "not reopenable", "idle", "that venue has no sandbox shell", False)]
    lis = []
    for j, p, tgt, h, v, left, tone, note, ok in R:
        act = btn("Open", "", "terminal") if ok else ""
        lis.append(f"""<li class="sx-kept{'' if ok else ' sx-kept--no'}">
  <p class="sx-kept__t">{code(j)}{tag(p)}<span class="muted">{tgt}</span></p>
  <p class="sx-kept__s">{h} {venue(v)} <span class="sx-left tone-{tone}">{ic('clock' if ok else 'refused', 'ic ic--sm')}{left}</span>{f'<span class="muted">, {note}</span>' if note else ''}</p>
  <span class="sx-kept__a">{act}</span>
</li>""")
    body = f"""<ul class="sx-kepts">{''.join(lis)}</ul>
  <p class="sx-small">{ic('info', 'ic ic--sm')}<span>Kept 24 hours after a run ends. Pin one to keep it 7 days.</span></p>"""
    return card("Kept workspaces", body, sub="what can still open", id_="p-sb-kept")

def page():
    main = f'<div class="stack">{from_run()}{without_run()}</div>'
    side = f'<div class="stack">{open_now()}{kept()}{browser_card()}</div>'
    inner = f'{runs_tabs("Sandboxes")}<div class="cols">{main}{side}</div>'
    return shell("Runs", inner, "Sandboxes",
                 sub="A shell next to a run's workspace, or a fresh one for a repository. Same image and isolation as a job, no credentials, and no agent: you are the one typing.",
                 end=btn("New sandbox", "", "plus", sm=False))

CSS = """
.sx-tabs { margin: 0 0 var(--space-4); }
.sx-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.sx-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.sx-h3 { font-size: 13px; font-weight: 700; color: var(--ink); margin: var(--space-5) 0 var(--space-2); }
.sx-h3--top { margin-top: 0; }
.sx-p { font-size: 13px; line-height: 20px; color: var(--ink-muted); margin-bottom: var(--space-2); }
.sx-run { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.sx-run__t { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; }
.sx-run__s { margin-top: 4px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.sx-run__s b { color: var(--ink); }
.sx-chs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.sx-ch .cmd { max-width: 560px; }
.sx-ch { position: relative; display: grid; align-content: start; gap: 8px; min-width: 0; padding: 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); cursor: pointer; }
.sx-ch input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.sx-ch--on { box-shadow: inset 0 0 0 2px var(--primary); }
.sx-ch--off { background: var(--surface-2); cursor: not-allowed; }
.sx-ch:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
.sx-ch__h { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14px; color: var(--ink); }
.sx-ch__h .chip { margin-left: auto; }
.sx-ch__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-ch__f { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
.sx-ch__a { display: flex; }
.sx-ch .cmd { background: var(--surface-2); }
.sx-ch--off .sx-ch__h b { color: var(--ink-muted); }
.sx-foot { display: flex; align-items: center; gap: var(--space-3); justify-content: space-between; flex-wrap: wrap; margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.sx-foot p { display: flex; gap: 8px; align-items: flex-start; flex: 1 1 320px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-foot p .ic { flex: none; margin-top: 2px; }
.sx-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
.sx-form .field { align-content: start; }
.sx-span2 { grid-column: 1 / -1; }
.sx-from { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.sx-from .input { flex: 1 1 180px; width: auto; min-width: 0; }
.sx-from .seg { min-width: 0; max-width: 100%; overflow-x: auto; }
.sx-form .seg { max-width: 100%; overflow-x: auto; justify-self: start; }
#p-sb-new .confirm { margin-top: var(--space-4); }
#p-sb-new .cmd { margin-top: 2px; }
.sx-term { min-width: 0; border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); overflow: hidden; }
.sx-term__h { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--surface); }
.sx-term__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-term__t span:last-child { font-weight: 500; color: var(--ink-muted); }
.sx-term__c { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-muted); }
.sx-term__c > span { display: inline-flex; align-items: center; gap: 5px; }
.sx-rec { margin-left: auto; font-size: 12px; font-weight: 650; color: var(--ok-ink); }
.sx-term__b { margin: 0; padding: 12px 14px; font-family: var(--font-mono); font-size: 12px; line-height: 19px; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.sx-term__b:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.sx-tl { display: block; }
.sx-ps { color: var(--running-ink); font-weight: 650; }
.sx-out { color: var(--ink-muted); }
.sx-cur { display: inline-block; width: 8px; height: 16px; vertical-align: -3px; background: var(--ink); }
.sx-term__f { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--surface); }
.sx-term__f span { flex: 1 1 220px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-opens, .sx-kepts { display: grid; gap: 8px; }
.sx-open { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sx-open > .dot { margin-top: 6px; }
.sx-open__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-kind { font-size: 12px; font-weight: 600; color: var(--ink-muted); }
.sx-open__s { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-open__a { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.sx-kept { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sx-kept--no { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.sx-kept__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-kept__t .muted { font-weight: 500; }
.sx-kept__s { grid-column: 1; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-kept__a { grid-column: 2; grid-row: 1 / span 2; }
.sx-left { white-space: nowrap; color: var(--tone-ink); font-weight: 650; }
.sx-left.tone-idle { color: var(--ink-muted); }
.sx-small { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-small .ic { flex: none; margin-top: 2px; }
.sx-small .code { white-space: normal; overflow-wrap: anywhere; }
.sx-open__s .ic, .sx-left .ic { vertical-align: -2px; margin-right: 3px; }
.sx-run__s .vtag { margin: 0 2px; }
#p-sb-browser .sx-p { margin-bottom: var(--space-3); }
@media (max-width: 760px) {
  .sx-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .sx-form { grid-template-columns: minmax(0, 1fr); }
  .sx-from { display: grid; grid-template-columns: minmax(0, 1fr); }
  .sx-from .seg { justify-self: start; }
  .sx-term__b { min-height: 0; font-size: 12px; }
}
"""

if __name__ == "__main__":
    write("SandboxesScreen", card_marker("Planned and proposed", 2600, 1440, "Open a run's kept workspace in your terminal from the console, or start a fresh sandbox for a repository with no run; a browser terminal shown as an off-by-default proposal"),
          "Sandboxes", page(), CSS)
    readme("SandboxesScreen", """
The Sandboxes tab on Runs. It opens a shell next to a run's kept workspace, or prepares a fresh one for a repository with no run behind it. Either way the shell gets the job image and a job's isolation, with no credentials and no agent. The person does the typing.

**How a person uses it.**
- **From a run.**
  - Pick a finished run that is still kept (here `gh-9575`), and see what opens:
    - the image its manifest records;
    - the clone it worked in, with `/job` read only;
    - no processes and no credentials;
    - a job's network.
  - Then choose how it opens:
    - *In your terminal* (recommended). The console fires a `pi-dispatch-open://` link. The opener on this computer, installed once with `pi-dispatch opener install`, opens the terminal with `pi-dispatch sandbox gh-9575` typed in, through `ssh -t mini1` when the workspace is on another host. It waits for Enter.
    - *Copy the command.* The same command for the host, and the `ssh -t` form for another computer.
    - *In this browser.* Shown as off, with a link to the proposal.
  - *Pin for 7 days* is the console form of `--pin`.
  - A port on the host is refused while egress is on, as the CLI refuses `--publish`.
- **Without a run.** Choose:
  - a repository, and the trigger whose jobs it should look like (its image, size and egress, since a project's triggers can differ);
  - where to start: a branch (the default branch unless changed), a pull request, or a commit or tag;
  - one of the hosts where that trigger's runs may go;
  - how long to keep it.

  The image, size, network and the no-credentials rule come from the trigger and are shown, not chosen. *Prepare sandbox* is a safe write with a preview:
  - The worker clones the repository with a read-only token for that one repository, and drops the token. No container starts: the console never starts one, and the shell starts when the person opens it from their terminal.
  - It costs no dollars and takes no run slot.
  - The sandbox shows up as `sb-3c1f` and opens like a run's. The CLI form is `pi-dispatch sandbox --new acme/web --ref main --as 3`.
- **Open now.** The sandboxes with a shell running: where, who opened them and since when (not how idle: the CLI hands the terminal straight to docker and never sees what is typed), with *Open in Terminal* (attach) and *End*. One sandbox per run at a time.
- **Kept workspaces.** What can still open, with the time left or the pin. A run from openshell-bind is listed as not reopenable, because that venue has no sandbox shell.
- **In this browser** (proposed, off). A preview of the terminal tab it would open, marked *Needs a decision*, with a link to #754.

**Panels.** `p-sb-run`, `p-sb-new`, `p-sb-open`, `p-sb-kept`, `p-sb-browser`.

**The server provides.**
- **From today's record.** Kept runs with their deadline, pin, host, venue and whether they can reopen (`pi-dispatch sandbox --list`), and the egress posture of each host.
- **New.**
  - A sandbox with no run: an `sb-` id, made by a safe write. The worker clones it, keeps it and sweeps it like a run's.
  - The list of open sandbox shells, with who opened each and how idle it is. The `pi-dispatch sandbox` that opened a shell registers it in Valkey with a short expiry it renews while the shell is open, so the console reads the list without asking docker. *End* writes a request that process polls, the way a cancel works.
  - Kept workspaces for every host, which each worker publishes the way it publishes its doctor results. Today the console reads a run's sandbox manifest for its own host only.
  - An SSH target per host in Fleet, and a remote command that loads the deployment's sandbox settings (the CLI reads them from its own environment, which an SSH command usually lacks).
  - The `pi-dispatch-open://` opener. The link holds no secret. The opener only builds commands from a fixed list (`sandbox`, `sandbox --new`) with ids and host names it checks, and shows the command before it runs. So a page that fires the link can at most show a prompt the person declines.
- **Proposed, not planned.** The sandbox gateway for the browser terminal.

**Who sees what.** The whole tab is operator only. A kept workspace holds issue text, and every control here opens a shell. A viewer does not see the Sandboxes tab.

**Why it works this way.**
- **What a sandbox is.** The run's exact image (or, for a prepared one, the image of the trigger it was prepared as), a job's isolation (no capabilities, no new privileges, its limits, not root) and a job's network: the egress allowlist, or the open bridge where egress is off.
- **No credentials.** On purpose. `gh auth login` is in the image for a person who wants to push as themself.
- **Idle logout.** After 30 minutes (`PI_SANDBOX_IDLE_MINUTES`).
- **It needs a real terminal.** From a pipe or CI it refuses.
- **Not on every venue.** openshell runs, and runs from a venue this host does not run, cannot reopen.
- **Kept workspaces stay on the host.** They hold issue text. A run's workspace is kept 24 hours after it ends (`PI_SANDBOX_RETENTION_HOURS`).
- **One sandbox per run at a time.** Opening a second points at the one running. *End* asks the terminal that opened it to close the shell.
- **The console never starts a container.** A prepared sandbox starts when the person opens it from their terminal.
- **Why the browser terminal is off.** specs/design.md rejected a terminal in the browser (#642), and WebSockets for the console (#641), which a terminal needs: a pty and a two way channel in the process that holds operator power is an interactive shell one stolen session away from anyone.
- **What turning it on would take** (#754, OQ-050):
  - a separate sandbox gateway process on the host, in its own tab at its own address, so the console keeps its CSP and gets no pty or WebSocket;
  - it only attaches to a `pi-sandbox` container the console gave it a ticket for;
  - one ticket per open, good once, for 60 seconds, for one operator session, after signing in again;
  - off by default, operator only, one window per sandbox, never on a phone; what is typed is not recorded, and opening and ending are audited;
  - the real cost: it still talks to Docker, which is root on that host.

**Fixture note.** Proposed in issue #753 (REQ-SANDBOX-FROM-THE-CONSOLE); the browser terminal is #754 (OQ-050). Sample: `sb-3c1f`, the open shells, the times left, the opener, the SSH target and the gateway. The `pi-dispatch sandbox` commands and flags, the 24 hour window, the 7 day pin, the 30 minute idle logout, the publish refusal, the one-sandbox-per-run rule and the openshell exception are the repo's (docs/sandbox.md). So is the rejection quoted from specs/design.md.
""")
    print("sandboxes written")
