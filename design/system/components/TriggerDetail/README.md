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
- **Other kinds.** A cron trigger shows its next fire and health (on time, overdue, stalls N of 3). A one-shot shows armed or "spent by" a run, and how to re-arm it. Fire now is a paid action with its reserve sentence.
- **Before you change it.** The trigger-skew rule with the jobs it would refuse now, renumbering, and the file-trouble sentence that quotes doctor.

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
- **Never merges.** A run opens or updates a pull request; a person merges it.
- These hold for every comment trigger, so the page shows the trigger's own facts and leaves the rules here.

**Fixture note.**
- **From the fixture:** trigger 3 (comment "@pi", flow fix, github, keeps a session, has instructions) and the runs gh-e9a0, gh-9575, gh-ebd7, gh-7cdf and gh-4a7e. Every card numbers triggers from 1, as this page does.
- **Sample values:** progress and statusComment on trigger 3, the instructions text, the 24-hour totals, gh-c9e1 as a job from it, the cron timings, the slip example, the spent one-shot gh-40a1, and the doctor quote.
- **Proposed, not in the console today:** Fire now (the CLI has `pi-dispatch run --trigger`).
