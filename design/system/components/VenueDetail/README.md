One venue in full, opened from Fleet's Venues panel: what the venue declares, what it serves, where it runs, and how it compares with the other three. It answers "can I trust this venue with this job, and why".

**How a person uses it.**
- **Venue switch.** A segmented control at the top moves between local, podman, openshell and openshell-bind.
- **What it declares.** All 14 properties. Each shows its short name, the question it answers, its key, and its word: *enforced* (shield), *asserted* (check, outlined) or *absent* (dash, dashed outline), so the word is never colour alone.
  - For an asserted word, the next column says who asserts it, in the build table's own words.
  - It says when a switch arms the property (`PI_EGRESS`) and which host observation the word depends on.
  - The last column names any host floor that asks for the property, and whether this venue meets it.
- **Where it runs.** The hosts that bless the venue, where it is the default, who holds credentials (the egress layer, or the container), floors, and which hosts published nothing.
- **What it serves.** Live transcript, steering, recovery and sandbox shell, each *yes*, *no* or *with the image*, with one line for this venue.
- **OpenShell on each host.** Engine, modes and the gateway word per blessing host.
- **Compare venues.** All four venues' 14 words, what each serves and who holds credentials, with this venue's column highlighted. This replaces the Fleet matrix wherever a full comparison is wanted.

**Panels.** `p-venue`, `p-venue-serves`, `p-venue-hosts`, `p-venue-props`, `p-venue-compare`.

**The server provides.**
- The build's venue table: describe, declares, asserts, armedBy, observedBy, serves and credential custody.
- Each live host's published blessing, default, floor and OpenShell engine, modes and gateway word.
- The hosts that published nothing.

Nothing on this page is read live from a host. Viewers and operators see the same page; there are no actions.

**Why it works this way.**
- **The three words.** *Enforced*: this worker builds the property in its own code, and a test reads it back off what was produced. *Asserted*: something outside the worker provides it (an image, a vendor's documentation), which the worker cannot verify. *Absent*: not provided, so a floor that asks for it refuses this venue. *With the image* means only from a job image that declares the feature.
- **Where the words come from.** What a venue declares is this build's table. Which hosts bless it, their floors and their OpenShell setup are what each host's worker published when it started.
- **Serving is not a guarantee.** What a venue serves is what it can do for an operator, so no floor compares those rows. A feature it serves can still be refused before spend by what the job image lacks.
- **Credentials on openshell.** Values with an endpoint are placeholders in the agent; `run.secrets` go to the job's provider.
- **A worker older than this console** publishes nothing, and the summary names it.
- **Other gateway words a host can publish.** Not local (every job there is refused as `openshell-gateway-not-local`), unread (the gateway did not answer when the worker started), and not published.
- **When an observation does not hold.** *Credentials stay on owned networks* is enforced only where the gateway is local. On a host where the observation fails, the word drops to asserted, and a floor asking for enforced refuses there. The fix is to run the gateway on that host and register it on loopback (`openshell gateway add https://127.0.0.1:17670 --local`); a remote gateway is refused, not lowered.

**Fixture note.** The hosts and build3's floor `egress=enforced` come from the fixture. The words, questions, asserts, serves and gateway sentences are the repo's (`worker/src/backends.mjs`, `admin/src/read-model.mjs`). mini2's engine and mode are sample values.
