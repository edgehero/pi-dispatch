A completed run's **Loaded** card: what the job had when it started, one line per kind. Today a run page names the model and the flow; nothing says which extensions, skills, MCP servers or tools the job loaded, or which pi and image it ran on. Those depend on the host, the repository at its base commit, the trigger and the image, and the configuration pages show only what should load.

**How a person uses it.**
- **The top line** says whether everything the trigger asks for loaded. When something did not (LoadedStates draws each case), it names what, and the outcome says it too.
- **One line per kind:**
  - **pi:** the version and image the job ran, with the image digest.
  - **Model:** the model, its calls and what the trigger allows.
  - **Extensions:** each staged package with its exact version, and how many came from the overlay and the repository.
  - **Skills:** the flow and where it was found (repository, the trigger's skills folder, the overlay or a staged package), and how many more loaded.
  - **MCP:** each server and whether it connected.
  - **Tools:** how many were active, pi's own by name, and which the trigger removed.
- **What was left out on purpose** is said as such, never as missing: tools a trigger removes (`run.excludeTools`), staged packages a trigger withholds (`"packages": false`) and a host's overlay extensions turned off (`PI_GLOBAL_ALLOW_EXTENSIONS=0`).
- **Each item, and where it came from** folds a table with every item, its version and its source.

**Panels.** `p-outcome`, `p-run`, `p-loaded`, `p-cost`, `p-resources`, `p-session`.

**The server provides.**
- **Today:** the model, the flow's name, the per-model usage, the trigger row and the host. The runner already computes most of the rest but only writes it to the job's log: each staged package's resources, a flow found nowhere (`flow_not_loaded`), a package skill shadowed, an extension that failed or was dropped, the active tools when some are removed, and how many MCP servers came up.
- **New:** one bounded `loaded` field on the runner's signed exit line, kept in the run record: pi's version; each extension and skill with its name, version and source tier; whether the flow was found and where; each MCP server's state; the active tools by count and pi's own by name; and every load failure. The worker adds the image and its digest. Older records have none, and say so.

**Who sees what.** Operators and viewers alike: the card holds names, versions, counts and states, never content, as the tool names a viewer sees today.

**Why it works this way.**
- **What ran, not what is configured.** Each host has its own overlay and staged packages, the repository changes with every merge, and an Adopt can miss a host. Only the run's own record says what it had.
- **A clean exit is not proof.** A flow found nowhere, or an extension that throws while loading, still runs and can exit 0. Fail loudly: the run page says so.
- **No repository names in the record.** The run record holds no string a repository chose, so skills and extensions from the repository are counts with a link to the base commit. Names come only from what the deployment staged and configured.
- **One line per kind,** as on the Workspace row. The table folds.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, trigger 3 and the model are the fixture, as on RunEnded. pi 1.5.0, pi-job:4.3.1 and the staged packages pi-lint 1.4.2 and pi-test-runner 0.9.0 are as on Updates, Sandboxes and Connections. Sample: the digest, the base commit a41c0d2, the skill run-tests, the counts and the tool split.
