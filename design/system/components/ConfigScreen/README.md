Configuration shows the nine sections of the deployment's settings as readable tables, each with an editor whose every change previews as a diff before Confirm.

**How a person uses it.**
- **Where it lives.** The title bar says where the files are (`~/.pi-dispatch/settings.json`, outside the deployment folder, and the triggers file), so nobody has to preview a change to find out.
- **After a write.** A green banner names what changed, who wrote it, its audit row, and offers the undo.
- **Sections.** A pill row jumps to each section on this page and shows its count; empty sections collapse to one line ("No secret profile is declared"). After a divider, outlined pills open the other pages: *Triggers*, *Secrets* (profiles and bundles) and *Connections* (forges, egress, model endpoints, notifications). A project row opens *Project detail*.
- **Settings.** All keys as facts. *Change a setting* takes a key from a select (a closed list) and a value. *Preview the change* opens a diff (`-` and `+` lines) and a confirm bar with what it means, when it applies, where it is written, the undo line ("Set maxTurns back to 30") and a 5-minute ticket.
- **Refusals.** A form refuses what it cannot use, by name: the unset form rejects `colour` and lists the valid keys.
- **Triggers.** A short list, one line per rule ("Every day at 03:00 UTC" to *tidy*), numbered 1 to 7 as everywhere. *Open Triggers* goes to the Triggers page, which has each rule in full.
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
