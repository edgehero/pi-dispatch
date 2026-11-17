One trigger on its own page: what starts it, every run field with where it can change, the runs it started, its instructions, and an edit that previews as a diff.

**How a person uses it.**
- **Start.** The title says the trigger in one line: kind, phrase, flow, forge and row number (rows are numbered 1 to 7 everywhere). Open in Runs filters the Runs page to it. Delete is outlined red until its confirm step.
- **What starts it.** Kind, phrase, how a comment can pick another flow, the one-comment-trigger-per-forge rule, and who may fire it.
- **Runs it started.** The count and metered spend for 24 hours, then the last five runs with project, outcome and reason sentence.
- **What it runs.** Every `run` field, set or not, in two groups:
  - *Edit here*: flow, venue, provider, model, maxTurns, progress, statusComment, steer and recover, which the Edit form changes;
  - *By hand*: everything else, including the job cap, allowed models, MCP servers, secrets and the bundle opt-out, which only the triggers file sets.
- **Edit.** Changing the venue previews the triggers file as a diff, then a confirm bar with the plan's own line, what it means for runs in line, the undo and the ticket.
- **Instructions.** The trigger's instructions, quoted and escaped.
- **Private endpoints.** A trigger that names devices from `private-endpoints.json` adds `run.privateEndpoints` at the end of By hand: `["bench-device"]; deployment default: none`. A trigger that names none adds no row. The trigger list adds a `private: bench-device` marker among what it reaches. Only the reviewed file sets it; the page offers no setter, and no tool may write it.
- **May merge.** When explicitly enabled, By hand adds `run.mayMerge`: `true; deployment default: false`, immediately after instructions. An unflagged trigger adds no row. The trigger list adds a `may merge` marker. Only the reviewed file sets the permission; the page offers no setter. Its Trust model says: “This trigger permits merging through the forge’s checks and approvals when its flow or operator instructions ask for it.” Its queued-job note says: “A queued job with merge permission runs only while its reviewed trigger remains unchanged. A job queued without it does not gain permission from a later edit.” The unflagged fixture retains its default-policy wording.
- **Local event commands.** The existing facts show source forge, stable trigger ID, debounce seconds and exact review-author allowlist separately from `run.kind: local`, folder, command and owning worker. These are set in the reviewed file. The runs panel distinguishes a current generation and its one pending follow-up, with event counts and due instants; an unread state is unknown, never idle. No event text reaches the command. Source forge never implies forge MCP or a cloned workspace. A command cannot be fired by a tool or this page.
- **Other kinds.** A cron trigger shows its next fire and health (on time, overdue, stalls N of 3). A one-shot shows armed or "spent by" a run, and how to re-arm it. Fire now is a paid action with its reserve sentence.
- **Before you change it.** The trigger-skew rule with the jobs it would refuse now, renumbering, and the file-trouble sentence that quotes doctor. Random jobs recheck this trigger's current pool and allowed-model list before starting; a changed pool or a candidate no longer allowed refuses the old queued policy.

A viewer sees the same facts and runs, and no Edit, Delete or Fire now.

**Panels.** `p-trigger-on`, `p-trigger-runs`, `p-trigger-run`, `p-trigger-edit`, `p-trigger-trust`, `p-trigger-kinds`, `p-trigger-change`.

**The server provides.**
- The trigger's display record, including the fields the current record leaves out: `task`, `repository`, `reviewState`, `waitFor`, `awaitInput`, `github`, `progress`, `statusComment`, `recover` and `steer`.
- The deployment defaults it falls back to.
- Its runs in the window, and the jobs from it now in line.
- For cron: the next fire, overdue time and stall count. For one-shots: `on.disarmed` with its time and job.
- The newest named doctor check when the file does not load.
- For the edit: the diff, the plan line, the undo plan and a 5-minute ticket.

**Why it works this way.**
- **Who may start it.** A collaborator with write access who comments. A comment from anyone else, or from a bot, starts nothing.
- **Checked on every delivery:** the signature (HMAC with `WEBHOOK_SECRET`), the bot-loop guard, the commenter's permission, duplicates (by `X-GitHub-Delivery`, 31 days), quiet hours, the job image, default-branch protection and the spend caps.
- **Keeps a session.** The transcript stays in the session store on the host that ran it for 14 days, and the next run on the same issue continues it.
- **Human lands by default.** A run opens or updates a pull request. An explicitly enabled `run.mayMerge` permits its agent to land its own change through the forge's checks and approvals. The worker validates the current trigger before each container. Turning it off does not undo a running job or a request already accepted by the forge.
- The page shows the trigger's own facts; permission appears only when explicitly enabled.

**Fixture note.**
- **From the fixture:** trigger 3 (comment "@pi", flow fix, github, keeps a session, has instructions) and the runs gh-e9a0, gh-9575, gh-ebd7, gh-7cdf and gh-4a7e. Every card numbers triggers from 1, as this page does.
- **Sample values:** progress and statusComment on trigger 3, the instructions text, the 24-hour totals, gh-c9e1 as a job from it, the cron timings, the slip example, the spent one-shot gh-40a1, and the doctor quote.
- **Separate enabled example:** the `run.mayMerge` row illustrates the optional state; trigger 3 in the shared fixture keeps the default and carries no permission.
- **Fire now** previews a paid start of a cron trigger, as `pi-dispatch run --trigger` does from the terminal.
