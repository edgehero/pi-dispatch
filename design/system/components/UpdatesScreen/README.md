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
