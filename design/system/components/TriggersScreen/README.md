Triggers get their own page, and every rule reads as a sentence: when this happens, run that flow. Each rule shows its status, and the page can say which rule a given event would start.

**How a person uses it.**
- **The numbers.** How many rules there are and of which kind, which fires next and when, and what the rules started this week.
- **When schedules fire.** A week strip in UTC with a dot for each time a schedule fires (filled when it ran, outlined when it will) and the quiet hours that hold forge jobs. The quiet hours do not hold schedules, and the key says so.
- **Rules, grouped by where they come from.** On a schedule, then one card per forge. Every rule is one row:
  - **Its number.** The same number is used in the editor, in previews and in the audit log.
  - **When.** The kind's glyph and word, then the event as a sentence ("The label `pi:frontend` is added to an issue"), with who may make it happen and where under it ("by someone with write access, in any repository wired to this deployment").
  - **Runs.** The flow as a dark pill, with the model and venue under it.
  - **Chips.** A chip says what the rule adds, with a glyph and a word: *costs more*, *reaches*, *writes*, *asks* or *narrows*. Spent rules get a *spent* chip.
  - **Status.** The last run's outcome and when it happened, the next fire for a schedule (with on time, overdue or stalled), and runs in 30 days with spend this week.
  - **Good to know.** A grey line under a rule, for the forge rules that surprise people. On GitHub, re-labelling fires a label rule again. A comment can pick another rule's flow. On GitLab, a label counts as an update.
  - **Spent one-shots.** The row is struck through with a light hatch and says how to arm the rule again.
- **Which rule would run?** The person describes an event (forge, repository, what happens, the comment text, who did it). The check names the rule that starts a job and the flow it runs, says in one line why each other rule does not match, and lists the checks the event must still pass when it arrives. It sends nothing and spends nothing.
- A row opens the trigger's own page. *Add a trigger* opens the editor. The compact *Watch* screen (#735) is reached from Configuration today. Its second tab here belongs to this planned Triggers screen (#750), because a watch rule is a trigger too.

**Panels.** `p-tr-count`, `p-tr-next`, `p-tr-spend`, `p-tr-week`, `p-tr-schedule`, `p-tr-github`, `p-tr-gitlab`, `p-tr-check`.

**The server provides.**
- Per rule: kind, selectors, forge, folder and host, flow, model, venue, the options behind each chip, and the one-shot state.
- The last run's outcome and time, runs in 30 days, spend this week, and the next fire and health of each schedule.
- The pause windows.
- For the check: a read-only match of a described event against the triggers file, the same match the receiver makes, plus each always-on gate's current state. The check is new: the console has no such route today.

A viewer sees the same rules, statuses and the check, without *Add a trigger* or edits.

**Why it works this way.**
- **One number everywhere.** A rule's number is the same here, in the editor, in previews and in the audit log.
- **When, then Runs.** *When* says what happens and who may make it happen; *Runs* says which flow, with which model and where.
- **The chips.** *Costs more* raises the bill. *Reaches* goes further than the repository. *Writes* writes something down: a session, a folder, the budget split. *Asks* may stop and wait for a person. *Narrows* does less than the kind would. *Spent* is finished and matches nothing. Each carries a glyph and a word, so the page needs no key.
- **Good to know** lines are the forge's own rules that surprise people.

**Fixture note.** The seven rules, their numbering, flows, forges, folders and models come from the fixture's triggers file. These are sample values:
- run counts and spend, which follow the flows map;
- the last runs (gh-e9a0, gh-2f6a and gl-9a2c are fixture runs; the times of the others are sample);
- the spent one-shot gh-40a1;
- the comment in the check.
