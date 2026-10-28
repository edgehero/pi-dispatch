Secret profiles and project bundles as names and states, never values: where each is declared, whether its resolver may run, who uses it, when it last resolved, and which hosts can serve it.

**How a person uses it.**
- **Problems first.** A red banner names the worst one in a sentence (here a profile declared in two places, which refuses every secrets job) with its fix.
- **Secret profiles.** One row per profile:
  - Source: the .env or the settings overlay, or ambiguous;
  - Resolver roots: inside, outside, not bounded;
  - Triggers and Projects that use it;
  - Last resolve, with its run;
  - Served by: the live hosts that advertise it.
  Rows that refuse jobs are tinted, and each says so in words. Remove opens a red confirm under the table with the settings diff (paths by last folder only) and what it refuses after: "Every trigger naming it is refused before spend after this, rather than running without its secrets."
- **Secret bundles.** Each bundle's project, resolver and its declared state, fork reviews, OpenShell endpoints, the triggers that opted out, and the variable names the newest run received.
- **Declare a resolver.** One form for a profile or a bundle resolver. It refuses a relative path in the console's words, and its hint names the resolver roots.

A viewer sees the tables, with no Remove or forms.

**Panels.** `p-secret-profiles`, `p-secret-bundles`, `p-secret-add`.

**The server provides.**
- Per profile: source, roots judgement, triggers and projects using it, the last resolve with its run, and the hosts advertising `s:<name>`.
- Per bundle: project, resolver and declared state, format, fork reviews, endpoints by name and host, opted-out triggers, and the newest received variable names.
- For writes: the settings diff with resolver paths shortened to their last folder, the effect sentence and the ticket.

**Why it works this way.**
- **A profile** resolves a trigger's own `run.secrets`: one reference per variable, at most 16.
- **A bundle** hands every variable its resolver prints to each trigger-made job of the project: at most 64 variables, 256 KiB of output, 64 KiB per value.
- **A run goes without its bundle** when it is a hand run, a chained run, opted out, a fork's pull request (unless fork reviews is on), or its head could not be verified. Its run page says which.
- **The resolver runs** as the worker's account, once per reference, and only from inside `PI_SECRET_RESOLVER_ROOTS`.
- **Never shown:** a reference, a value, or a resolver's full path. Viewers see names and states.

**Fixture note.** The fixture declares no secret profile or bundle, so everything here is sample: the profiles default, vault, ops-1p and stripe; the bundles billing, web and legacy; and their variables, hosts and runs. The sentences follow the console's own (`read-model.mjs`, `write-plans.mjs`). The all-caps words there (AMBIGUOUS, OUTSIDE, PRE-SPEND, EXECUTES) are written in sentence case.
