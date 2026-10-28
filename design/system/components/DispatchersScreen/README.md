The Dispatchers tab on Triggers. Many dispatchers can run at once, and most do different jobs, so the page leads with each one's purpose and shows how they share inputs and limits.

**How a person uses it.**
- **The numbers.** How many dispatchers there are and by engine, how many run now (and which are idle or paused), the jobs and spend they started today against their combined caps and the deployment's $25.00, and the trigger proposals waiting.
- **Today.** One lane per dispatcher over the day in UTC:
  - a green dot for each job started;
  - a violet dot for each trigger proposal;
  - thin ticks for decisions that did nothing;
  - a blue band while an LLM flow runs;
  - a hatched band while a dispatcher is paused.

  The person sees at a glance which dispatcher is busy and which is quiet.
- **One card per dispatcher**, and a last card to add one, which opens the format. Each card shows:
  - its name, state, and its purpose in one sentence;
  - its engine and where it runs (a Jev loop on a host, or an LLM flow on a schedule or after an event);
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
- Per dispatcher: name, purpose, engine, host or schedule, state with who paused it and why, inputs, allowed flows, caps, today's jobs and spend, proposals waiting and the last action.
- Per input: which dispatchers read it.
- Events acted on by several dispatchers, with each action, plus merged proposals and requests the queue took as duplicates.
- The deployment's dollar window.

**Who sees what.** A viewer sees purposes, states, counts and actions, without *Pause*, *Resume* or proposals. Dispatchers are written by hand in triggers.json; *How to add one* shows the format.

**Why it works this way.** Five rules keep the dispatchers bounded as a group:
- **Each has its own caps**, and every job it starts also counts against the deployment's windows and its project's scoped limits, which still bind.
- **Two requests for the same target and flow** within 10 minutes become one job, whichever dispatcher sent them.
- **Two proposals for one trigger** become one proposal with both reasons.
- **None can change another**, start a flow outside its own list, or edit its own rules. Adopting a proposal is a reviewed edit.
- **Each Jev loop runs in its own container**, reaching only its own inputs and the decision API. LLM flows run as ordinary jobs.

**Fixture note.** This is a planned screen, and all of it is sample:
- the five dispatchers, their purposes, hosts, caps and today's activity;
- `gh-5c21`, `4a1f` and the shop-5xx proposal follow the Dispatcher and Watch fixtures.
