"""SandboxesScreen: credential-free terminal handoff and host-prepared workspaces (#771)."""
from pulse import *

def code(t): return f'<span class="code">{E(t)}</span>'

def command(job="gh-9575", host="mini1"):
    return cmd(f"ssh -t -- ops@{host} '/usr/bin/node' '/srv/pi/node_modules/@edgehero/pi-dispatch/src/cli.mjs' 'sandbox' '{job}' '--deployment' '/srv/pi' '--expected-host' '{host}'")

def routes():
    return f"""<div class="sx-ch sx-ch--on"><div class="sx-ch__h">{ic('terminal', 'ic ic--sm')}<b>In your terminal</b><span class="sx-rec sandbox-opener">recommended</span></div>
      <p class="sx-ch__s">Your terminal opens with the command typed in and waits for Enter. The link holds no secret. On a phone, copy the command.</p>
      <span class="sandbox-opener">{btn('Open in Terminal', 'primary', 'terminal', sm=False)}</span>
      {command()}
      <p class="card__sub">For mini1, using its saved deployment settings.</p>
      <p class="card__sub">The opener checks its own saved hosts. It types the command and waits for Enter. Install once on this computer:</p>
      {cmd('pi-dispatch opener install --config sandbox-hosts.json')}
    </div>"""

def from_run():
    picker = '<div class="sx-picker"><div class="field"><label for="sx-workspace">Kept workspace</label><select class="select" id="sx-workspace"><option>gh-9575 on mini1</option><option>gh-ebd7 on build3</option></select></div>' + btn('Show workspace') + '</div>'
    head = f'<div class="sx-run"><span class="tile tone-ok">{ic("box")}</span><div><p class="sx-run__t">{code("gh-9575")}</p><p class="sx-run__s">mini1 {venue("local")}. Kept until 14:39 UTC tomorrow, 23h left.</p></div></div>'
    what = facts([('Image', 'pi-job:4.3.1, as its manifest records it'), ('/workspace', 'its retained clone'), ('/job', 'read only, with retained job inputs'), ('Processes', 'none until you start them'), ('Credentials', 'none, on purpose'), ('Network', "the host’s current job egress policy")], 3)
    foot = f'<div class="sx-foot"><p>{ic("info", "ic ic--sm")}<span>The shell uses a job’s isolation and network. A published host port is refused while egress is on. Pinning uses this host’s configured pin window.</span></p>{btn("Preview pin", "", "clock")}</div>'
    return card('From a run', picker + head + '<h3 class="sx-h3">What opens</h3>' + what + '<h3 class="sx-h3">How it opens</h3>' + routes() + foot, sub='the same image, workspace and isolation as the run', id_='p-sb-run')

def without_run():
    form = """<div class="sx-form">
      <div class="field"><label for="sx-repo">Repository</label><input id="sx-repo" class="input" value="acme/web" placeholder="owner/repository"></div>
      <div class="field"><label for="sx-trigger">As the jobs of</label><select id="sx-trigger" class="select"><option>trigger 3, comment, github, flow fix</option><option>trigger 2, label, github, flow triage</option></select><p class="field__hint">Its image, size and egress are shown below, rather than chosen here.</p></div>
      <div class="field"><label for="sx-ref">Start from</label><input id="sx-ref" class="input input--code" value="HEAD"><p class="field__hint">HEAD means the default branch. Enter a branch, tag, full commit SHA, or pr:42 for a pull request.</p></div>
      <div class="field"><label for="sx-host">Host</label><select id="sx-host" class="select"><option>mini1, local</option><option>build3, podman</option></select><p class="field__hint">The worker checks the trigger and its own policy again before cloning.</p></div>
      <div class="field"><label for="sx-keep">Keep it</label><select id="sx-keep" class="select"><option>Host’s retention window</option><option>Host’s pin window</option></select></div>
    </div>"""
    given = facts([('Image', 'pi-job:4.3.1'), ('Size', '2,048 MiB, 1 CPU'), ('Network', 'the host’s job allowlist through its egress proxy'), ('Credentials', 'none in the shell')], 2)
    return card('Without a run', form + '<div class="sx-form-end">' + btn('Review settings') + '</div><h3 class="sx-h3">Given by the trigger, not chosen here</h3>' + given + '<p class="sx-p">Kept for 24 hours, on mini1. The worker clones on that host with a credential for this repository, then drops it. No container starts, no model runs, no dollars are spent and no run slot is taken.</p>' + btn('Preview preparation', 'primary', 'plus', sm=False) + cmd('pi-dispatch sandbox --new acme/web --ref HEAD --as 2'), sub='a fresh clone with a trigger’s image and a job’s isolation', id_='p-sb-new')

def open_now():
    body = f'<ul class="sx-opens"><li class="sx-open"><span class="dot tone-running"></span><div class="sx-open__b"><p class="sx-open__t">{code("gh-9575")}{venue("local")}</p><p class="sx-open__s">mini1, opened by ops. Open since 15:20 UTC.</p><div class="sx-open__a"><span class="sandbox-opener">{btn("Open in Terminal", "", "terminal")}</span><details><summary>Copy the command</summary>{command()}</details>{btn("Preview End", "danger", "cancel")}</div></div></li></ul>'
    body += f'<p class="sx-small">{ic("info", "ic ic--sm")}<span>One shell per workspace at a time. End asks the terminal that opened it to close the shell and keeps the workspace. What you type is not recorded.</span></p>'
    return card('Open now', body, end=badge('running', '1 open'), id_='p-sb-open')

def kept():
    rows = [('gh-9575','web','mini1','local','Kept until 14:39 UTC tomorrow, 23h left'), ('gh-ebd7','billing','build3','podman','Pinned until 15:39 UTC in 13 days'), ('billing-sweep','billing','mini2','openshell-bind','This venue has no sandbox shell')]
    lis=[]
    for job,project,host,v,left in rows:
      controls = f'<div class="sx-kept__actions"><span class="sandbox-opener">{btn("Open in Terminal", "", "terminal")}</span><details><summary>Copy the command</summary>{command(job,host)}</details>{btn("Preview pin", "", "clock")}</div>' if v != 'openshell-bind' else ''
      lis.append(f'<li class="sx-kept"><p class="sx-kept__t">{code(job)}</p><p class="sx-kept__s">{host} {venue(v)}. {left}</p>{controls}</li>')
    return card('Kept workspaces','<ul class="sx-kepts">'+''.join(lis)+'</ul>',sub='what each host still keeps',id_='p-sb-kept')

def browser_card():
    return card('In this browser','<p class="sx-p">A terminal in this browser needs a decision in #754. This console opens no shell and starts no container.</p><a class="link" href="#">Read the browser terminal proposal</a>',sub='proposed',end=chip('Needs a decision','attention','attention'),id_='p-sb-browser')

def page():
    tabs = '<nav class="tabs sx-tabs" aria-label="Runs views"><a href="#">All runs</a><a href="#">Zero touch</a><a href="#" aria-current="page">Sandboxes</a></nav>'
    main='<div class="stack">'+from_run()+without_run()+'</div>'
    side='<div class="stack">'+open_now()+kept()+browser_card()+'</div>'
    return shell('Runs',tabs+'<div class="cols">'+main+side+'</div>','Sandboxes',sub='A kept workspace or a fresh clone, in your own terminal. A job’s isolation, no credentials and no agent.',end=btn('New sandbox','','plus',sm=False))

CSS = """
/* Published ids and bounded request ids must wrap inside cards and state banners, including on a phone. */
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.banner__t, .banner__s { overflow-wrap: anywhere; }
/* Keep fact values readable inside a narrow desktop card as well as on a phone. */
.facts, .facts--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.facts--1 { grid-template-columns: minmax(0, 1fr); }
.fact { grid-template-columns: minmax(0, min(128px, 40%)) minmax(0, 1fr); }
.sx-picker { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); margin-bottom: var(--space-4); }
.sx-picker .field { flex: 1 1 240px; }
.sx-form-end { margin-top: var(--space-3); }
.sx-kept__actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: start; gap: var(--space-2); }
.sx-kept__actions details { min-width: 0; flex: 1 1 240px; }
.sx-open__a details { min-width: 0; max-width: 100%; }
.sx-open__a { align-items: start; }
.sx-ch > .cmd { margin-top: 8px; }
.sx-ch details summary { cursor: pointer; }
@media (max-width: 760px) { .sandbox-opener { display: none !important; } }

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

README = """The operator-only Sandboxes tab on Runs opens a kept workspace in the person’s own terminal, or prepares a fresh clone without a run. The shell has a job’s image, isolation and network, no credentials and no agent.

**How a person uses it.**
- Pick a kept workspace under **From a run**, inspect its image, read-only job inputs, host, venue and deadline, then choose **Open in Terminal** or copy the command.
- The opener, installed once with `pi-dispatch opener install --config sandbox-hosts.json`, checks its own imported host configuration and opens the terminal with the command typed in. It waits for Enter. The link carries an `open` or `attach` verb, id and host, no command or credential.
- On a phone, the opener links are hidden and unfocusable. Copy the command or select its text. With JavaScript off, navigation and Review settings still work; writes explain that Preview and Confirm require JavaScript.
- Under **Without a run**, enter a repository, select a trigger and host, and enter HEAD (the default branch), a branch, tag, commit SHA or `pr:42`. Choose that host’s retention or pin window, then Review settings.
- The preview shows the resolved image, size, venue, network and retention. Confirm queues one host preparation request. The worker rechecks the trigger digest and host plan before cloning; changed settings are refused before a credential is minted.
- The worker clones with a repository-scoped credential, drops it, and keeps the result under an `sb-` id. No container starts, no model runs, no dollars are spent and no run slot is taken. Open the prepared workspace from the terminal after it is ready.
- **Open now** shows the host, opening account and opening time. Attach opens the existing shell. End previews and confirms a request to the terminal that opened that exact shell; it cannot end a replacement shell. The workspace remains kept.
- **Kept workspaces** shows each host’s published list, pin and deadline. Pin previews the host’s configured pin window. Stale, missing, unreadable and truncated publications are stated; none means an empty fleet.
- Fleet’s host page edits a credential-free SSH target and explicit executable/deployment paths. Download and inspect the file, then import it into the opener on the person’s computer. A link cannot enroll a host or change this config.
- **In this browser** is an off/proposed note linking #754. It opens no terminal, pty or WebSocket.

**Panels.** `p-sb-run`, `p-sb-new`, `p-sb-open`, `p-sb-kept`, `p-sb-browser`.

**The server provides.**
- Host-published kept workspaces with their identity, venue, deadline, pin, manifest generation and shell capability; a separate, credential-free host settings projection supports exact previews.
- Short-lived shell registrations renewed by the terminal process, with exact-incarnation End requests and acknowledgements. The console never asks Docker for this list.
- Durable bounded preparation/pin requests and results, separate from paid jobs and their run slots.
- Operator-only reads and preview/Confirm/audit writes. The private inventory and opener host configuration never join `/api/state` or viewer page data.

**Why it works this way.**
- The container boundary is the existing sandbox launcher, with read-only `/job`, a non-root user, no capabilities, no new privileges, resource limits and the host’s job network. The original run venue must support reopening; openshell and openshell-bind do not.
- A kept workspace holds issue text and stays on its host. Sweeping, pinning and idle logout keep their existing lifecycle rules. Retention defaults to 24 hours, pinning to seven days and idle logout to 30 minutes, but the screen reads the selected host’s actual configuration.
- A hostile page can only ask the locally configured opener to show a command that waits for Enter. No credentials or arbitrary executable string travel in the URI.
- The browser-terminal rejection remains while #754 / OQ-050 is open.

**Fixture note.** The pictured hosts, runs, paths, image tag and times are sample data. Its 24-hour retention and seven-day pin are the sample host’s settings. The implementation reads real publications and reports exceptional states instead of substituting these values.
"""

if __name__ == "__main__":
    write("SandboxesScreen", card_marker("Planned and proposed", 2200, 1440, "Open a kept workspace in the operator’s terminal or prepare a fresh sandbox, with no agent or credentials"), "Sandboxes", page(), CSS)
    open(f"{ROOT}/SandboxesScreen/README.md", "w").write(README.strip()+"\n")
    print("sandboxes written")
