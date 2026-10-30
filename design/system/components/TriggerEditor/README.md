Add a trigger with a form that knows the five kinds and each forge's own words, then preview it as the lines it adds to the triggers file.

**How a person uses it.**
1. **What starts it.** Pick a kind (cron, label, comment, pull request, issue). The fields change with it.
   - For a pull request: the forge, its actions in that forge's words, the review states, and labels when `labeled` is picked.
   - The hint says what the forge does with them: a review trigger fires on every verdict unless narrowed.
2. **What it runs.** Flow (with where the skill must live), venue (only blessed venues), provider and model, and the turn budget. Blank fields say the default they fall back to.
3. **Run options.** Report phases, status comment, take messages and recover. Each names its `run.` key and what it needs.
4. **Set by hand.** One line says that some fields are set by hand in the triggers file only, with a link to which ones.
5. **Preview the add.** The preview sits beside the form: the new entry as added lines, then a confirm bar with the trigger in one sentence, who can fire it, the per-run reserve, where it is written, and the undo (delete row 8).

For people who know the file, *Or paste the add tool's fields as JSON* keeps the old textarea.

A refusal shows under the field it is about, in the loader's words, ending "Nothing was changed."

A viewer never sees this page.

**Panels.** `p-trigger-add`, `p-kinds`, `p-forge-words`, `p-refusals`. The preview is the shared confirm slot.

**The server provides.**
- The blessed venues and the deployment defaults.
- The forges that have webhooks configured.
- The flows found in the repository skill tiers, for suggestions.
- For a preview: the entry as JSON, the diff against the file, the plan summary, the undo plan and the ticket.
- For a refusal: the field and the loader's sentence.

**Why it works this way.**
- **The five kinds.** Cron: a schedule, in a local folder (needs an id, a pattern of 5 or 6 fields, a folder and a task). Label: a label on an issue, never a pull request (any or all labels; none only narrows). Comment: a phrase in a comment, one comment trigger per forge. Pull request: a pull request event, a submitted review, or a close (actions in the forge's words). Issue: an issue closing (the close word; a number and `once` for a one-shot).
- **Pull request words per forge.** The form offers only these. GitHub: `labeled opened synchronize reopened review_submitted closed` (labels with labeled; closed counts a merge). GitLab: `open update reopen approved close` (a label is an update; a merge does not fire close). Forgejo: `label_updated opened synchronized reopened closed`. Azure: `created updated` (no label rule, no issue or close-only rule).
- **Set by hand, never by a tool:** `run.maxCostUsd`, `run.models`, `run.mcp`, `run.secretBundle`, `run.resume`, `run.awaitInput`, `run.image`, `run.secrets`, `run.waitFor` and `run.replicas`. A per-job dollar cap, allowed models and MCP servers decide what a trigger can spend or reach.
- **What the form refuses**, each by name and ending "Nothing was changed.":
  - backend 'openshell' is not blessed by this deployment (PI_BACKENDS: local, podman);
  - unknown trigger kind 'push';
  - the console cannot set run.maxCostUsd: a trigger's per-job dollar cap is set by hand in the triggers file, never by a tool;
  - a pull request trigger on github that names labeled needs a label predicate (any or all);
  - once needs number: a one-shot names the issue or pull request it waits for;
  - github already has a comment trigger (row 3), so a second one does not load.

**Fixture note.**
- **From the repo:** the per-forge action words, the five kinds and what each needs, and the first three refusals (the unblessed backend, the unknown kind, the cannot-set-maxCostUsd sentence).
- **Sample:** the other three refusals, which are worded for this design from the loader's rules, and trigger 8, address-review.
