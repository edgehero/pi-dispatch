"""Updates (proposed): pi and the extensions jobs run, prepared for the person, adopted by the person.

pi-dispatch pins every version a job runs (CONST-PI-VERSION-PINNED), so nothing here updates by itself. What it does
by itself is look: it finds a newer pi or a newer staged extension, shows what changed and whether the checks hold, and
leaves one button. One line and one button per row, as on the run page's Workspace row."""
from pulse import *
from gen_config2 import table, code, state_line, COMMON_CSS


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


CSS = COMMON_CSS + """
.up-what { display: grid; gap: 2px; min-width: 0; }
.up-what b { font-weight: 650; }
.up-what span { font-size: 12px; color: var(--ink-muted); }
.up-ver { white-space: nowrap; font-family: var(--font-mono); font-size: 13px; }
.up-ver .ic { vertical-align: -2px; margin: 0 4px; color: var(--ink-faint); }
.up-line { font-size: 13px; line-height: 20px; min-width: 220px; }
.up-act { text-align: right; white-space: nowrap; }
.up-foot { display: flex; gap: 8px; align-items: flex-start; padding: var(--space-3) var(--space-5) var(--space-4); font-size: 12px; line-height: 18px; color: var(--ink-muted); border-top: 1px solid var(--line); }
.up-foot .ic { flex: none; margin-top: 2px; }
.up-confirm { padding: 0 var(--space-5) var(--space-5); }
@media (max-width: 760px) { .up-line { min-width: 0; } .up-act { text-align: left; } }
"""


def what(name, kind):
    return f'<span class="up-what"><b class="code">{E(name)}</b><span>{kind}</span></span>'


def ver(now, new):
    return f'<span class="up-ver">{E(now)}{ic("chev-r", "ic ic--sm")}{E(new)}</span>'


def jobs_table():
    rows = [
        [(what("pi", "in every job, pinned by pi-dispatch"), ""), (ver("1.4.0", "1.5.0"), ""),
         (state_line("failed", "failed", "Checks fail. Jobs stay on 1.4.0 until pi-dispatch’s bump is green and released."), "up-line wide"),
         (btn("Open the bump pull request", "", "pr"), "up-act wide")],
        [(what("pi-lint", "extension, staged on every host"), ""), (ver("1.4.2", "1.4.3"), ""),
         (state_line("ok", "done", 'Canary passed: <a class="link code" href="#">gh-c0a7</a> ran as trigger 3, $0.19.'), "up-line wide"),
         (btn("Adopt", "primary", "done"), "up-act wide")],
        [(what("pi-test-runner", "extension, staged on every host"), ""), (ver("0.9.0", "0.10.0"), ""),
         ('<span class="muted">Not tried yet. A canary runs one job of trigger 3 with it, up to $2.00.</span>', "up-line wide"),
         (btn("Run a canary", "paid", "rerun"), "up-act wide")],
    ]
    body = table([("What", ""), ("Version", ""), ("Checks", ""), ("", "up-act wide")], rows, cls="tbl", caption="What jobs run, and what is available", stack=True)
    adopt = confirm("safe", "Adopt pi-lint 1.4.3",
                    ["Re-stages <b>pi-lint</b> at exactly <b>1.4.3</b> on mini1, mini2 and build3",
                     "Jobs that start after this load it; running jobs keep 1.4.2",
                     "Triggers that set <span class=\"code\">\"packages\": false</span> are not affected (1 does)"],
                    "adopt 1.4.2 again", "Adopt pi-lint 1.4.3")
    return card("What jobs run", body + f'<div class="up-confirm">{adopt}</div>'
                + f'<p class="up-foot">{ic("info", "ic ic--sm")}<span>Checked daily. Nothing here changes a job until someone adopts it.</span></p>',
                sub="pi and its extensions", id_="p-up-jobs", flush=True)


def hosts_table():
    rows = [
        [(what("mini1", "the console’s own host"), ""), ('<span class="up-ver">1.5.0</span>', ""),
         (state_line("attention", "attention", "Newer than pi-dispatch is tested with (1.4.0)."), "up-line wide"), ("", "up-act wide")],
        [(what("mini2", "worker host"), ""), ('<span class="up-ver">1.4.0</span>', ""),
         (state_line("ok", "done", "The version pi-dispatch is tested with."), "up-line wide"), ("", "up-act wide")],
        [(what("build3", "worker host"), ""), ('<span class="muted">none</span>', ""),
         ('<span class="muted">No pi on this host; jobs bring their own.</span>', "up-line wide"), ("", "up-act wide")],
    ]
    body = table([("Host", ""), ("pi", ""), ("", ""), ("", "up-act wide")], rows, cls="tbl", caption="pi on each host", stack=True)
    return card("pi on each host", body
                + f'<p class="up-foot">{ic("info", "ic ic--sm")}<span>Your own pi is yours to update, for example with <span class="code">pi update --all</span>. '
                  f'pi-dispatch reads its version and checks that its admin extension and host files still load.</span></p>',
                sub="where /dispatch and the host files run", id_="p-up-hosts", flush=True)


def side():
    how = facts([("Looks for updates", "daily, 06:23 UTC"), ("A canary runs as", "trigger 3, fix, up to its $2.00 cap"),
                 ("Adopting", "always a person, with a preview")], 1)
    recent = '<ul class="rows">' + "".join(
        f'<li class="rowpill">{ic("done", "ic ic--sm")}<span><b class="code">{n}</b> {v}</span><span class="end">{w}</span></li>'
        for n, v, w in [("pi-lint", "1.4.1 to 1.4.2", "ops, 1 Oct"), ("pi", "1.3.0 to 1.4.0", "pi-dispatch 5.0.0, 24 Oct"),
                        ("pi-test-runner", "0.8.2 to 0.9.0", "ops, 1 Oct")]) + "</ul>"
    return (card("How it keeps up", how, id_="p-up-how")
            + card("Recently adopted", recent, id_="p-up-recent"))


def page():
    top = banner("attention", "attention", "pi 1.5.0 is out, and pi-dispatch’s checks on it fail",
                 "Jobs stay on pi 1.4.0. The bump pull request lists what broke; it ships in a pi-dispatch release once it is green.",
                 btn("Open the bump pull request", "", "pr"))
    inner = (f'<section id="p-up-problems" data-panel>{top}</section>'
             f'<div class="cols"><div class="stack">{jobs_table()}{hosts_table()}</div><div class="stack">{side()}</div></div>')
    return shell("Configuration", inner, "Updates", sub="pi and the extensions jobs run, prepared for you. Nothing changes until you adopt it.",
                 back="Configuration")


README = """
Updates (proposed): pi and the extensions jobs run, prepared for the person and adopted by the person. pi-dispatch pins every version a job runs, so nothing updates by itself; what pi-dispatch does by itself is look, try and tell.

**How a person uses it.**
- **The banner** says when a new pi is out and pi-dispatch's checks on it fail, so jobs stay on the pinned pi. It links to the bump pull request, which lists what broke.
- **What jobs run** (`p-up-jobs`), one row each, with one button:
  - **pi**, pinned by pi-dispatch: the version jobs run and the newest, and whether pi-dispatch's checks hold. It arrives in a pi-dispatch release, so the button opens the bump pull request.
  - **each staged extension**: the version jobs load and the newest, then the canary's result. **Run a canary** runs one paid job of the chosen trigger with the new version staged for that job only. **Adopt** opens a preview: re-stage at that exact version on every host, jobs that start after it load it, triggers with `"packages": false` are untouched, and the undo.
- **pi on each host** (`p-up-hosts`): the pi where `/dispatch` and the host files run, against the version pi-dispatch is tested with. Updating it is the person's, for example with `pi update --all` (pi 1.5.0 updates pi and its extensions together); pi-dispatch reads the version and checks that its admin extension and host files still load.
- **How it keeps up** (`p-up-how`): when it looks, which trigger a canary runs as and its cap, and that adopting is always a person.
- **Recently adopted** (`p-up-recent`), from the audit log.

**Panels.** `p-up-problems`, `p-up-jobs`, `p-up-hosts`, `p-up-how`, `p-up-recent`.

**The server provides.**
- **Today:** the pinned pi version, the staged packages manifest with each exact version, and each host's doctor record.
- **New:** a daily look at the npm registry for newer pi and newer staged extensions, from a worker host, never from a job; each extension's changelog (pi 1.5.0 reads `pi.changelogPath` or `CHANGELOG.md`); a canary job with one candidate package staged for it alone; the re-stage action, audited as `package-adopt`; each host pi's version and a check that the admin extension and host-pi mirrors load on it; and the bump pull request's state for pi.

**Who sees what.** A viewer sees the versions and the check results. Run a canary and Adopt are operator only.

**Why it works this way.**
- **Pinned, on purpose.** pi breaks between minors. pi 1.5.0 is the worked example: pi-dispatch's checks on how MCP tool calls are metered and capped fail on it, so jobs moved to it by themselves would be refused or unbrakeable. A floating version turns that into every queued job failing with no signal (`CONST-PI-VERSION-PINNED`).
- **An extension update is new third-party code in jobs that hold a forge token.** A canary run and a person's Adopt are the review.
- **Automatic where it is free.** Looking, reading changelogs and showing the checks cost nothing and change nothing, so they happen daily. A canary spends money, so it runs when asked.
- **Jobs never update anything.** They run pi offline (`PI_OFFLINE=1`), so pi 1.5.0's `-e npm:` refresh and version check never fire inside a job.

**Fixture note.** From the fixture: the hosts, trigger 3 and its $2.00 cap, and the staged packages pi-lint 1.4.2 and pi-test-runner 0.9.0 (as on ConnectionsScreen). pi 1.4.0 and 1.5.0 are the real versions. Sample: the newer extension versions, the canary run gh-c0a7, the hosts' pi versions and the adoption history.
"""

if __name__ == "__main__":
    write("UpdatesScreen", card_marker("Configuration", 1500, 1440, "Updates: pi and the extensions jobs run, checked daily and tried by a canary; nothing changes until a person adopts it"),
          "Updates", page(), CSS)
    readme("UpdatesScreen", README)
    print("updates card written")
