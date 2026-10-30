A second tab on Runs that counts how often a run needed a person, per project and per repository, and helps the person drive that number to zero. A project nobody had to touch for 30 days is a zero-touch project.

**How a person uses it.**
- **The numbers.**
  - *Touch rate*: runs that needed a person out of runs that ended, over the window (7, 30 or 90 days), with a sparkline of the rolling rate each week, a dashed goal line, and the change against the window before in words.
  - *Zero-touch streak*: the project that has gone longest without a touch, and the others.
  - *Waiting for a person*: the hours runs waited on a person, the median wait for an answer, and what waits now.
  - *Answered from a draft*: an explicit coming-next state for #772. A draft the person sends will be a touch; #770 does not draft or send answers.
- **By project.** One row per project:
  - the rate as a meter, with the goal tick at 5% and a word beside it (*Under goal*, *Above goal*, *High* from 30%), so colour never carries it alone;
  - the change against the 30 days before, as an arrow and words ("down 8 points, from 24%");
  - how many runs needed a person out of how many ran;
  - the days since the last touch, or *waiting now*;
  - the most common cause.

  A row opens to its repositories or folders with the same columns (api is shown open: acme/api at 31%, acme/api-docs at 4%). *Open as runs* lists the touched runs on the Runs tab.
- **What needed a person** (side). One stacked bar per project on one scale, each with its counts in words under it. Under the bars, the six causes with what the record says for each and their counts (17, 5, 7, 5, 3 and 1, which make 38), and one line: merging is never a touch, with a link to how touches are counted.
- **Questions it keeps asking** (operator only). Questions with the same meaning, grouped by a decision model, per repository. A person names each group (an unnamed one says how many similar questions it holds and offers *Name this group*), and the page shows the name, the count and links to the runs, never the questions. Each group offers the fix that removes it:
  - *Add to instructions*: shown open, a preview with the diff of `triggers.json` and *Add to trigger 3*. The undo is to remove the sentence.
  - Standing answers and drafting arrive with #772; #770 offers no inactive draft or standing-answer control. Product-decision sample wording is illustrative.
  - A fixed group stays listed, with when it was fixed and *none since*.
- **Fixes that worked** (side). Each change a person made against a cause, with before and after bars over equal spans: the pnpm sentence on trigger 3 (package manager questions 5 to 0), and the vault reference fix (`secret-unresolved` refusals 4 to 0).
  Green means an established reduction. More occurrences use the failure colour and say so; unchanged, partial, unexposed and reverted observations never claim effectiveness.

**Panels.** `p-zt-rate`, `p-zt-streak`, `p-zt-wait`, `p-zt-handled`, `p-zt-projects`, `p-zt-questions`, `p-zt-causes`, `p-zt-fixes`.

**The server provides.**
- From run records, today:
  - outcome and reason (`awaiting-input`, `operator-cancel`, policy refusals and failures);
  - steering messages received;
  - explicit source-run lineage for re-runs and retries; never inferred from the target;
  - the project and repository each run recorded;
  - park source and answer-receipt times recorded by #770, not inferred from pickup time.
- New:
  - approvals decided (with ApprovalRequest);
  - linking a configuration change to the refusal it answered;
  - question groups from a decision model over the question text, named by a person;
  - standing answers and sent drafts remain #772;
  - the fixes log, each change with the cause it targets and counts before and after.
- The rate is a bounded read over records and fleet-wide touch facts. Grouping starts a capped job; naming a group and appending an instruction are operator-only writes through preview and Confirm. Private question context never enters this page.

**Who sees what.** A viewer sees the rates, counts, causes, streaks and fixes. Question groups and every action are operator only. No role sees question text on this page.

**Why it works this way.**
- **What a touch is.** Answering a question the run asked, deciding an approval, re-running after a failure or a refusal, changing the configuration because a run was refused, steering a run while it works, or cancelling a run.
- **What is never a touch.** Merging a pull request, which is always the person's; reading a run, its transcript or this page; opening a sandbox; and a run that starts itself on a schedule, a label or a watch rule. That is the ask, not a touch.
- **A run counts once**, however often a person stepped in. The rate is runs that needed a person, divided by runs that ended in the window.
- **Answered from a draft is still a touch.** A person sent it. It is shown apart only because it was quicker. Nothing answers a run without a person (OQ-051).
- **Zero touch.** A project with no touch for 30 days is marked zero touch.
- **No question text here.** A group's name is written by a person, never by the model, because a question is the run's own text, which the console shows on the run page and nowhere else.
- **Standing answers do not reach zero.** A draft may cite one, but the person still sends the answer. The way to zero is an instruction that stops the question being asked.

**Coverage.** Built by #770. Windows are partial when retained records or touch tracking cover less than requested. A zero-touch badge needs 30 days of complete observed workload and no outstanding wait. Charts assign each run to its first intervention; fixes count their typed refusal/group predicate independently.

**Fixture note.** This screen's deployment and values are sample:
- the 214 runs and 38 touches, and their split by project, repository and cause;
- the trend, the streaks and the waits;
- the question groups and their wording, the trigger 3 instructions line (from `triggers.example.json`) and the sentence added to it;
- the two fixes.

Projects, repositories, trigger 3 and `gh-2f6a` follow the fixture.
