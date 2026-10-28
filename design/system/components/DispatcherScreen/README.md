One dispatcher in full. A dispatcher is a sandbox with a purpose of its own. It reads git changes and infra streams, and has two powers only: start jobs from its list, and propose triggers. Many can run at once, each for a different purpose (see Dispatchers). This one, `infra-dispatch`, turns infra alarms and log findings into read-only triage, and proposes watch rules. It generalises #735.

**How a person uses it.**
- **The title bar** gives its purpose in one sentence, its engine and state, and Pause.
- **The numbers.** Events read in 24 hours, decisions and what they cost, jobs started against its day cap, and trigger proposals waiting for a person.
- **What it may do.** The boundary, set by hand in triggers.json like any trigger:
  - **It reads:** CloudWatch alarms through EventBridge, Vector findings, deployments, and merged commits for context.
  - **It may start:** only `triage-incident` and `db-health`, each with a listed model, under its own day caps.
  - **It may propose:** new or tuned watch rules, for a person to adopt. "Apply proposals without me" shows as off.
- **What it saw and did.** A live feed, newest first. Each event shows its input and the event, with log text as plain text. Then Jev's questions with their answers, probabilities and cost. Last, the one thing it did: started a job, proposed a watch rule, held by a watch rule before any decision, or nothing.
- **Trigger proposals.** A new watch rule for a new fingerprint, and a tuned threshold for an existing one. Each has its reason and the triggers.json diff. *Adopt* is the usual preview and Confirm, audited with the proposal's id.
- **Engine.** The same boundary for two engines, each as facts: the Jev loop (this one, on mini1) with its decisions, context and cursor, and the LLM flow with its runs and tools.
- **Jobs it started.** Ordinary jobs; a refusal shows its reason.

**Panels.** `p-dp-events`, `p-dp-decisions`, `p-dp-jobs`, `p-dp-props`, `p-dp-bound`, `p-dp-live`, `p-dp-props-card`, `p-dp-engine`, `p-dp-jobs-card`.

**The server provides.**
- The dispatcher's rule: purpose, inputs, allowed flows and models, caps, and the auto-apply setting.
- The engine and its state: host, uptime and cursors for a Jev loop, or the last and next runs for an LLM flow.
- Per event: its input, its summary fields, each decision (question, options, answer, probability, cost), the action with its job or proposal id, and any fact the loop kept.
- The proposals with their diffs, and the jobs started with their outcomes.

**Who sees what.** Log text and decision state are operator only. A viewer sees the counts, the actions, and the decisions' chosen options and probabilities. Only an operator adopts, dismisses or pauses.

**Why it works this way.**
- **Two powers only:** start a job from its list, and propose a trigger. It holds no write token, so it cannot change code or the forge.
- **What it never does:** write code, push or merge, comment or label as a person, start a flow or model outside its list, change caps, secrets or its own rules, or see a secret's value or a write token.
- **Applying proposals without a person** is off. It can be turned on only by hand in triggers.json, and never for models, caps, secrets or MCP servers. A proposal may not set a model outside its list, a dollar cap, secrets or MCP servers: those stay the person's to write.
- **Every cost is held first.** Decisions are priced before they are asked (Jev bills input only), and jobs pass every check before spend, inside the dispatcher's own day caps.
- **The event never picks the flow or model.** Jev picks from options a person wrote. Untrusted text can sway a choice, but not widen it. Log text is untrusted and shown as plain text.
- **Jev gives no reasons.** The question, its answer and the probability are the why.
- **No model context lives on in the Jev loop.** Each decision sees one event's fields, so nothing from one log line carries into the next. Facts it keeps, such as a recent deploy, are structured fields the loop holds.
- **The Jev loop** runs all the time like the GitHub poller, in a plain container whose network reaches only its inputs and the decision API, and loses nothing on restart because its cursors live in Valkey.
- **The LLM flow** is just a flow: a skill in a job. It reasons across events, such as a deploy, then an alarm, then a log spike. Today it runs at most 30 minutes, every 10 minutes; waiting in its own loop for hours needs long runs first (a timeout per trigger, budget held an hour at a time, tokens that refresh).
- **Each job it starts is ordinary:** its own container, budget held before it starts, flow and model from this dispatcher's list, never from the event.
- **Triggers change through a person.** Proposals are adopted as reviewed edits, audited as `trigger-add` or `trigger-edit` with the proposal's id. Models change only this way. These follow #735 and #650's decisions.

**Fixture note.** This is a planned screen, and all of it is sample:
- the dispatcher, its inputs, the CloudWatch alarm and the payments fingerprint;
- the jobs `local-8b02`, `local-6c10` and `local-6c3a` (`local-7f21` and the shop-5xx numbers follow the Watch fixture);
- the decisions and their costs, which follow Jev's input-only price.
