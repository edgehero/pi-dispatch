A guide card: the one deployment every card draws, read from `tools/fixture.py` rather than written by hand.

**How a person uses it.**
- **The numbers.** The day and time (15:39 UTC on Thursday 8 October 2026), the hosts, the projects, and the day's runs by outcome.
- **The day's runs.** Every run that ended today, newest first: when it ended, its id, target, project, flow, host, venue and outcome, each outcome a glyph and a word.
- **Not ended, and from earlier.** Runs that are running or waiting, the planned screens' own runs, and yesterday's runs that some cards still draw.
- **Hosts, projects, triggers and people.** The three hosts with their venues (the first is the default), the projects and their members, the seven triggers and the planned answer rule by number, and the two people, ops (operator) and watcher (viewer).
- **The check.** `tools/check_fixture.py` names any card that draws a run with another target, host or venue than this file.

**Panels.** `p-ss-day`, `p-ss-nhosts`, `p-ss-nproj`, `p-ss-nruns`, `p-ss-runs`, `p-ss-other`, `p-ss-hosts`, `p-ss-projects`, `p-ss-trig`, `p-ss-people`.

**Fixture note.** All of it is the fixture, by construction. Runs the fixture registers without details (drawn by one card only so far) are not listed.
