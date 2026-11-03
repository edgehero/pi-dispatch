The project page's **What its runs load**: what its runs had over the last 7 days, one line per kind, and a warning when runs of one project load different things on different hosts.

**How a person uses it.**
- **The top line** says what differs. Here build3's overlay adds git-guard, so the 18 runs of acme/billing on build3 load an extension the 6 on mini2 do not. *Open build3*.
- **One line per kind:** pi and image, models, extensions, flows and where each was found, MCP servers, and what was missing.
- **By host:** a table of each host's runs, the extensions they loaded and the flow.

**Panels.** `p-proj-loads`, beside ProjectDetail's panels.

**The server provides.** Nothing new beyond RunLoaded's `loaded` field: the page groups its runs' records by host.

**Who sees what.** As the rest of the project page.

**Why it works this way.**
- **A project spans hosts,** and each host has its own overlay and staged packages. A difference by host is the one thing no single run page shows.
- **From records, not configuration,** so it shows what happened, including after an Adopt that one host missed.

**Fixture note.** billing, its two repositories with 18 and 6 runs this week, build3 for acme/billing and mini2 for acme/billing-ui, and triggers 3 and 4 are as on ProjectDetail and in the fixture. Sample: git-guard in build3's overlay, and trigger 4's skills folder.
