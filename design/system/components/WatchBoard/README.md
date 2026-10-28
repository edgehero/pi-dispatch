A watch rule's own page. It shows why each finding did what it did, every query and decision on the way, and a board that gets better over time: jobs propose changes, and a person adopts them. It extends #735 (proposed in #743) and keeps #735's rules: no agent lives on, and nothing writes code without a person.

**How a person uses it.**
- **The numbers.** Findings in 24 hours and what held them, the jobs that ran, how often Jev in shadow agreed with what happened, and the spend of jobs and decisions apart.
- **Why this finding started a job.** Four stages in a row, each with what it saw and what it concluded:
  1. **Stream.** A signed finding, its count and fingerprint, and how many redacted samples were kept.
  2. **Rules.** Every rule it passed, at no cost and with no model. The rules decide.
  3. **Job.** The read-only triage job: its log queries, its decisions with Jev's `decide` tool, the board proposals it made while it ran, and its spend against its cap.
  4. **Outcome.** Here, a follow-up that changes code, so it waits for a person.

  Under the stages, a hatched **shadow** strip shows what Jev at the gate would have chosen: the probability of each option, whether that agrees with what happened, and its 30-day record. A switch picks another finding.
- **The board, in two parts.**
  - **Adopted.** The blocks the operator adopted, as reviewed config. Each job re-runs the adopted queries on fresh data and refreshes the numbers. Versions show who adopted what, and the operator can go back a version or clear the board.
  - **Proposed.** What this run proposed, each with a reason: add a chart with its query, or remove a block. *Adopt* opens a safe preview that names the query, the only endpoint it can reach, the new version and the undo. It is audited as `board-adopt`.
  - **Run notes.** Hypotheses and a note, kept with this run only, as plain text.
- **How the job went.** The run's spend against its cap, with board proposals, decisions and queries marked as they happened. Under it: the hourly rate and how long the cap lasts at that rate, how much of the context was used and whether it was compacted, and whether recovery was armed.
- **Every stream, query and decision.** One log, newest first:
  - **Who acted:** the collector, the rules, Jev in shadow, or the job.
  - **The entry:** the query or question as plain text, the result, and the cost and time.
  - **Used for:** what each entry fed.
  - **Filters:** decisions, log queries, board proposals, model turns, and streams and rules.
- **Streams.** Each source with a 24-hour sparkline and what happened to its findings, the log store the jobs read, and a source doctor says is broken.
- **Decision models.**
  - **Jev:** pinned to a dated snapshot. It acts inside the job as the `decide` tool and runs in shadow at the gate. The card shows its calls, spend and typical time, its 30-day shadow record (agreed 9, disagreed 2, and what the misses were), and a warning that its input leaves the EU.
  - **The triage model:** reasons and queries inside the job.
  - **Acting at the gate:** off, set by hand in triggers.json.

**Panels.** `p-wb-findings`, `p-wb-jobs`, `p-wb-shadow`, `p-wb-spend`, `p-wb-chain`, `p-wb-board`, `p-wb-run`, `p-wb-streams`, `p-wb-trace`, `p-wb-models`.

**The server provides.**
- The finding, its rule checks and cooldown state.
- Each decision: model and snapshot, the state's fields (fields and counts only at the gate), the questions with their options, probabilities, confidence, cost and time.
- Each query: the store, the text as written, rows and time, recorded by a read-only query tool.
- The adopted board's versions, and each run's proposals and notes.
- The job's spend over time, its cap, its context use and whether it was compacted, and recovery state.
- Per source: deliveries and what happened to them.
- The shadow record: what the gate would have chosen beside what happened.

**Who sees what.** Query text, decision state, run notes and samples are operator only, like transcripts. A viewer sees the counts, the rule checks, which option each decision chose with its probabilities, the stages and the adopted board's numbers. Only an operator adopts, goes back or clears.

**Why it works this way.**
- **No agent lives on.** Each finding is one fresh job with its reserve taken before it starts. Only what a person adopted carries over, and agent text never does: run notes stay with their run, as plain text, and are never shown to the next job.
- **The rules decide at the gate**, with no model and at no cost.
- **Decisions earn their place.** Jev acts only inside the read only job. At the gate it runs in shadow: it records what it would have chosen and changes nothing, until its record says it helps. It sees fingerprint fields and counts only.
- **If it is allowed to act at the gate later**, it would investigate at confidence 0.70 or more, ignore at 0.90 or more, and otherwise file an issue for a person. It would run as a one-call job, so the host still never calls a model. That is set by hand in triggers.json, once the shadow results earn it.
- **Log text stays in the job.** The gate sees fingerprint fields and counts. Sample text reaches only the read only job.
- **Jobs propose, a person adopts.** The adopted board is reviewed config. A block's query reaches only the bundle's endpoints, every later job runs it on fresh data, and the console draws every block itself: no scripts, styles, images or outside links, never agent HTML.
- **Ready for long runs.** Each decision and query is kept as a small record of its own, not read back from the transcript, so a run of hours keeps its first query too. Proposals appear while the job runs, and the cap projection updates every 30 seconds, so a job of six hours shows the same view, live.
- **Jev gives no reasons.** Decisions show the state the model saw, the question and its options, and the probabilities, and that is the why. Jev answers yes or no, a choice, or a score, with no prose.
- **A person before code.** A follow-up that writes code becomes an issue or an approval; nothing writes code until someone with write access says so.

**Fixture note.** This is a planned screen, and all of it is sample:
- the finding and the job are the Watch page's (checkout TimeoutError, `local-7f21`, `acme/shop#88`);
- Jev's model id, dated snapshot, answer shapes and input-only price follow its Decisions API, and the note on EU routing follows its OpenRouter page;
- the queries, probabilities, proposals, versions, shadow record and spend are illustrative.
