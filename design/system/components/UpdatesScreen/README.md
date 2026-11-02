Updates: pi and the extensions jobs run, prepared for the person and adopted by the person. pi-dispatch pins every version a job runs, so nothing updates by itself; what pi-dispatch does by itself, once `PI_UPDATES_LOOK=1` is set, is look: it finds a newer pi or a newer staged extension and whether the checks hold. Trying a new extension is a paid canary, and adopting it is a person.

**How a person uses it.**
- **The banner** says when a new pi is out and pi-dispatch's checks on it fail, so jobs stay on the pinned pi. It links to the bump pull request, which lists what broke.
- **What jobs run** (`p-up-jobs`), one row each, with one button:
  - **pi**, pinned by pi-dispatch: the version jobs run and the newest, and whether pi-dispatch's checks hold. It arrives in a pi-dispatch release, so the button opens the bump pull request.
  - **each staged extension**: the version jobs load and the newest, then the canary's result. **Run a canary** runs one paid job of a cron trigger with the new version for that job only. The result reads "completed, read the run", never "passed": a completed job does not prove the extension is good. **Adopt** stages that version on every host, with a preview and Undo.
- **pi on each host** (`p-up-hosts`): the pi where `/dispatch` and the host files run, against the version pi-dispatch is tested with. Updating it is the person's, for example with `pi update --all` (`pi update --self` alone keeps what `/dispatch` loads).
- **How it keeps up** (`p-up-how`): when it looks, which trigger a canary runs as and its cap, and that adopting is always a person.
- **Recently adopted** (`p-up-recent`), from the audit log.

**Panels.** `p-up-problems`, `p-up-jobs`, `p-up-hosts`, `p-up-how`, `p-up-recent`.

**The server provides.**
- **Today:** the pinned pi version, the staged packages manifest with each exact version, and each host's doctor record.
- **New:** a daily look at the npm registry for newer pi and newer staged extensions, from a worker host, never from a job, off until `PI_UPDATES_LOOK=1`; the checks on this repository's bump branch; a canary job, whose run records whether the candidate loaded; a desired version per package that each host reconciles to, with each host's state.

**Who sees what.** A viewer sees the versions and the check results. Run a canary and Adopt are operator only.

**Why it works this way.**
- **Pinned, on purpose.** pi breaks between minors. pi 1.5.0 is the worked example: extensions began importing a view of pi-ai rather than pi-ai itself, and the cost meter's identity check would have refused every capped job.
- **An extension update is new third-party code in jobs that hold a forge token.** A canary run and a person's Adopt are the review.
- **Automatic where it is free.** Looking and showing the checks cost nothing and change nothing, so they happen daily once enabled. A canary spends money, so it runs when asked. A changelog is a link to the version, plus a short escaped excerpt once a canary has installed it: reading changelogs daily would download third-party tarballs on every host every day.
- **Jobs never update anything.** They run pi offline (`PI_OFFLINE=1`), so pi 1.5.0's `-e npm:` refresh and version check never fire inside a job.

**Fixture note.** From the fixture: the hosts, trigger 3 and its $2.00 cap, and the staged packages pi-lint 1.4.2 and pi-test-runner 0.9.0 (as on ConnectionsScreen). pi 1.6.0 and each newer extension are illustrative.
