The project page's **What its runs load**: what its runs had in the last 7 days, one line per kind, and a warning when runs of one project load different things on different hosts.

**How a person uses it.**
- **The top line** says what differs. Here build3's overlay adds git-guard, so the 15 recorded runs of acme/billing on build3 load an extension the 6 on mini2 do not. *Open build3*. A host's fact comes from the newest of its runs able to show that fact: pi and its image from its newest run on the host's own image, its packages from its newest run that did not withhold them, was no canary and kept their whole list, and its overlay from its newest run with the overlay open and its whole list kept. So a host that ran 1.4.2 and then 1.4.3 has 1.4.3 whichever trigger ran last, and a routine Adopt is no difference.
- **One line per kind:** pi and image, models, extensions, flows and where each was found, MCP servers, what was missing, and the runs it could not read. Extensions says what each host's newest run able to show them had, and the rest count recorded runs: of the 18 on build3, gh-e9a0 was refused before its container started, gh-4a7e's runner did not say what it loaded, and an older release wrote gh-c3f8's record. A record cannot tell why a runner did not say (an older image, a runner that died), so none is claimed; a cancel with a live runner does write its line, on SIGTERM, so cancelled alone does not mean not recorded.
- **By host:** a table of each host's runs, how many of them are recorded, the extensions its newest runs able to show them had, and the flows.
- **While most runs have no record** (`p-proj-loads-incomplete`): the same card, whose top line says how few it read and why, and that runs may differ in ways it does not show. It claims no sameness on what it cannot read, and says why for each host it cannot. A difference between two hosts it did read stands, however few runs that was: the card above then says how few under its top line. A run with no agent loads nothing, so the card leaves it out and says how many it left out.
- **When no host differs** (`p-proj-loads-same`): one green line naming the hosts, on web, whose 8 runs in the last 7 days are all it counts. It is green only with nothing missing: when a run lacked its flow or an extension, or an MCP server stopped it, Missing says so and the line takes the attention tone, however well the hosts agree.
- **When nothing has a record** (`p-proj-loads-none`): one muted line, on shop, saying so, with no rows to read.

**Panels.** `p-proj-loads`, and `p-proj-loads-incomplete`, `p-proj-loads-same` and `p-proj-loads-none` (the same panel in those states), beside ProjectDetail's panels.

**The server provides.** Nothing new beyond RunLoaded's `loaded` field: the page groups its runs' records by host.

**Who sees what.** As the rest of the project page. A viewer reads the same words, and the top line has no *Open build3* (LoadedStates draws the same rule).

**Why it works this way.**
- **A project spans hosts,** and each host has its own overlay and staged packages. A difference by host is the one thing no single run page shows.
- **From records, not configuration,** so it shows what happened, including after an Adopt that one host missed.
- **The last 7 days, rolling.** A calendar week would empty this card every Monday, when a person is most likely to ask what ran over the weekend. Members, under it, stays this week from Monday 00:00 UTC (`costsSinceMs("week")`) and says so, so the two can differ; here 18 and 6 add up to this card's 24 because nothing of billing's ran earlier.
- **A model canary and a restricted run say nothing of a host's overlay,** which they have shut by their kind. A package canary is an ordinary job on its host's switch, fired by hand from a cron trigger, so its overlay is its host's; only its candidate stays out.
- **The image id is not a difference.** The image id on this host; two local builds of one tag differ, so it never counts as a host difference.

**Fixture note.** billing, its two repositories with 18 and 6 runs this week, its triggers' 9 and 2 runs in the last 24 hours, build3 for acme/billing, mini2 for acme/billing-ui, and gh-e9a0, gh-4a7e and gh-c3f8 are as on ProjectDetail, LoadedStates and in the fixture. Sample: git-guard in build3's overlay, review in the overlay (as on TriggerEnvironment), the incomplete card's 9 of 24 and its split, which are all build3's and so hold git-guard, the same and none states on web and shop, and pi 1.5.0 in pi-job:4.3.1 (RunLoaded's note says why).
