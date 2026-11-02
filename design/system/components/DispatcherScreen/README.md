One proposed dispatcher in full. A dispatcher is a service with a purpose of its own. It reads reviewed git changes and infra inputs, and has two powers: start listed local read-only jobs, and propose triggers for a person. Many can run at once, each for a different purpose (see Dispatchers). This one, `infra-dispatch`, turns infra alarms and log findings into read-only triage, and proposes watch rules. It generalises #735.

**PROPOSED, spec only (#776).** Nothing here is built. This card corrects the earlier resident Jev container and configurable proposal-application claims. A long-running deterministic service starts fresh bounded Jev decision containers; LLM runs stay ordinary jobs of at most 30 minutes. All started jobs are local and read-only. Unsupported input adapters and watch adoption support remain proposed. No setting enables adoption without a person.

**How a person uses it.**
- **The title bar** gives its purpose in one sentence, its engine and state, and Pause.
- **The numbers.** Events read in 24 hours, decisions and what they cost, jobs started against its day cap, and trigger proposals waiting for a person.
- **What it may do.** The boundary, set by hand in triggers.json like any trigger:
  - **It reads:** reviewed source inputs; CloudWatch, deployments and default-branch git changes shown here are proposed adapters, not current integrations.
  - **It may start:** only local read-only `triage-incident` and `db-health` jobs, each with a listed model, under its own day caps. It starts no forge job.
  - **It may propose:** new or tuned watch rules, for a person to adopt. "Apply proposals without me" is unavailable, with no hand-written enable switch.
- **What it saw and did.** A live feed, newest first. Each event shows its input and the event, with log text as plain text. Then Jev's questions with their answers, probabilities and cost. Last, the one thing it did: started a job, proposed a watch rule, held by a watch rule before any decision, or nothing.
- **Trigger proposals.** A new watch rule for a new fingerprint, and a tuned threshold for an existing one. Each has its reason and an illustrative diff, not a loadable configuration example. Proposed *Adopt* requires a validated preview and a person's Confirm, audited with the proposal's id. The build must add watch adoption validation and preview support; no watch-add form exists today.
- **Engine.** The same boundary for two engines, each as facts: the deterministic Jev service (this one, on mini1) with fresh per-decision containers and durable receipts, and the ordinary LLM flow with its bounded runs and tools. Uptime describes the service, not a model container.
- **Jobs it started.** Ordinary jobs; a refusal shows its reason.

**Panels.** `p-dp-events`, `p-dp-decisions`, `p-dp-jobs`, `p-dp-props`, `p-dp-bound`, `p-dp-live`, `p-dp-props-card`, `p-dp-engine`, `p-dp-jobs-card`.

**The server provides.**
- The dispatcher's rule: purpose, inputs, allowed local read-only flows and models, job caps, decision-call caps and decision dollar caps. No auto-apply setting is admitted.
- The engine and its state: service host, uptime, fenced cursors and durable admission receipts for Jev decisions, or the last and next ordinary LLM runs.
- Per event: its input, its projected fields, each decision (question, options, answer, probability, cost), and the action with its job or proposal id. Structured facts are deterministic, bounded and separate from model context.
- The proposals with their diffs, and the jobs started with their outcomes.

**Who sees what.** Log text and decision state are operator only. A viewer sees the counts, the actions, and the decisions' chosen options and probabilities. Only an operator adopts, dismisses or pauses.

**Why it works this way.**
- **Two powers only:** start a job from its list, and propose a trigger. It holds no write token, so it cannot change code or the forge.
- **What it never does:** write code, push or merge, comment or label as a person, start a flow or model outside its list, or change caps, secrets or its own rules. Its model sandbox receives no collection credential or forge write key. The provider API key is a job-lifetime injected copy of a host-held key that may itself be long-lived; the card does not claim that copy is unreadable inside the sandbox.
- **Applying proposals without a person is rejected.** Hand-written configuration cannot enable it. A proposal may not widen its allowed flows, models, targets or caps, or change secrets or MCP servers. Those stay the person's to write.
- **Every cost is held first.** Decisions are priced before they are asked (Jev bills input only), including ignore and propose. Every dispatcher has a decision-call cap and decision dollar cap even if it starts no jobs. Decisions and jobs count against the deployment's dollar windows and applicable scoped limits; every free refusal precedes every paid admission.
- **The event never picks the flow or model.** Jev picks from options a person wrote. Untrusted text can sway a choice, but not widen it. Log text is untrusted and shown as plain text.
- **Jev gives no reasons.** The question, its answer and the probability are the why.
- **No model context lives on across Jev decisions.** Each sees only its current event's structured fields, never raw log or issue text and never a previous event's model output. A deterministic service may retain bounded structured facts for later ordinary LLM jobs, not Jev's next event.
- **Resident Jev containers are rejected.** A deterministic service reads inputs and starts one fresh metered container per bounded decision. A cursor alone cannot prevent duplicate paid starts: durable event identity, fenced ownership and atomic admission receipts are prerequisites for restart correctness.
- **The LLM flow** is just a flow: a skill in an ordinary job. It may reason across reviewed bounded inputs and structured facts. Each run lasts at most 30 minutes; long runs, hourly budget renewal and refreshing a job's credentials remain deferred to a separate issue.
- **Each job it starts is ordinary:** its own container, budget held before it starts, local read-only target, flow and model from this dispatcher's list, never from the event. The same canonical target and flow within 10 minutes become one job regardless of dispatcher, input or chosen model.
- **Triggers change through a person.** Proposals are adopted as reviewed edits, audited as `trigger-add` or `trigger-edit` with the proposal's id. Models change only this way. These follow #735 and #650's decisions.

**Fixture note.** This is a proposed screen, and all of it is sample:
- the dispatcher, its inputs, the CloudWatch alarm and the payments fingerprint;
- the jobs `local-8b02`, `local-6c10` and `local-6c3a` (`local-7f21` and the shop-5xx numbers follow the Watch fixture);
- the decisions and their costs, which follow Jev's input-only price.
