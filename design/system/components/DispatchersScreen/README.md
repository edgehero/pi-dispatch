The Dispatchers tab on Triggers. Many dispatchers can run at once, and most do different jobs, so the page leads with each one's purpose and shows how they share inputs and limits.

**PROPOSED, spec only (#776).** Nothing here is built. This card corrects its earlier resident-container and forge-start claims: service uptime is not a model container's lifetime, each Jev decision runs in a fresh bounded container, and review routing starts only a local read-only job. CloudWatch, deployments, merged-commit, organisation and advisory adapters remain proposed. Long LLM runs are deferred to a separate issue; hourly reserves and token renewal are not granted here.

**How a person uses it.**
- **The numbers.** How many dispatchers there are and by engine, how many run now (and which are idle or paused), the jobs and total spend today against their own caps and the deployment's $25.00, and the trigger proposals waiting. Spend includes decisions, even for a dispatcher that proposes only.
- **Today.** One lane per dispatcher over the day in UTC:
  - a green dot for each job started;
  - a violet dot for each trigger proposal;
  - thin ticks for decisions that did nothing;
  - a blue band while an LLM flow runs;
  - a hatched band while a dispatcher is paused.

  The person sees at a glance which dispatcher is busy and which is quiet.
- **One card per dispatcher**, and a last card to add one, which opens the format. Each card shows:
  - its name, state, and its purpose in one sentence;
  - its engine and service host or schedule (fresh Jev decision containers, or an ordinary LLM job);
  - what it reads, and what it may start (or "nothing: it proposes only");
  - jobs and spend today against its own caps;
  - proposals waiting, and its last action;
  - *Open*, and *Pause* or *Resume*. Resume is a paid act, because it starts spending again.
- **Where they meet.**
  - A table of which dispatcher reads which input, with a note where several read the same one.
  - Today's events that more than one dispatcher acted on, with what each did: a deploy that one watched and another kept as a fact, and merged commits that two read and a paused one will pick up later.
  - Two proposals for one trigger merged into one.

**Panels.** `p-ds-count`, `p-ds-running`, `p-ds-jobs`, `p-ds-props`, `p-ds-today`, `p-ds-meet`, and one card per dispatcher.

**The server provides.**
- Per dispatcher: name, purpose, engine, service host or schedule, state with who paused it and why, inputs, allowed local read-only flows and models, job and decision caps, today's jobs and total spend, proposals waiting and the last action.
- Per input: which dispatchers read it.
- Events acted on by several dispatchers, with each action, plus merged proposals and requests the queue took as duplicates.
- The deployment's dollar window.

**Who sees what.** A viewer sees purposes, states, counts and actions, without *Pause*, *Resume* or proposals. Dispatchers are written by hand in triggers.json; *How to add one* shows the format.

**Why it works this way.** These rules keep the dispatchers bounded as a group:
- **Each has its own caps**, including a decision-call count and decision dollar cap even if it starts no jobs. Every decision and started job is held first and counts against the deployment's windows and applicable scoped limits.
- **Two requests for the same canonical local target and flow** within 10 minutes become one job, regardless of dispatcher, input or chosen model. A different model never bypasses deduplication.
- **Identical proposals for one trigger** become one proposal with both origins. Conflicting edits stay separate for a person to resolve.
- **None can change another**, start a flow outside its own list, or edit its own rules. Adopting a proposal is a reviewed edit.
- **Resident Jev containers are rejected.** A deterministic service reads inputs; a fresh metered container answers each bounded decision using only its current event's projected fields. Bounded deterministic facts may feed later ordinary LLM jobs, never Jev's next event. No model transcript persists between jobs.
- **A cursor alone is not a paid-start receipt.** Durable event identities, fenced ownership and atomic admission records must survive crashes so a restart cannot repeat a paid start. This is proposed acceptance behaviour, not supplied by the card.
- **LLM flows remain ordinary jobs**, at most 30 minutes, with no renewable hourly hold or days-long model credential. The longer-lived alternative remains deferred.

**Fixture note.** This is a proposed screen, and all of it is sample:
- the five dispatchers, their purposes, hosts, caps and today's activity;
- `gh-5c21`, `4a1f` and the shop-5xx proposal follow the Dispatcher and Watch fixtures.
