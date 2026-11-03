The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, then the Confirm:
  - each change in words, a widening said as one (*connect to mcp.example.com, with LINEAR_API_KEY by name*);
  - the jobs it affects: here adding `run.mcp` refuses gh-77c1, waiting in line, as `trigger-skew`;
  - that every host's release reads the new fields;
  - where it is written and how it is audited (`trigger-edit`, by the person).
  - **Undo** puts the trigger back as it was.
- **What it refuses, and why:** a server some hosts lack (said on the switch, before the preview), a model whose first call costs more than the cap, a file that changed since the page opened, and what belongs elsewhere.
- **As a viewer sees it:** the same rows, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's planner and Confirm, widened to the card's fields for a person only, with the file's digest to refuse a stale write; the store version check (#761) for a field an older host would refuse; each model's first-call bound.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` exist because which systems a job reaches and what it spends is the operator's to write. A person at the console is the operator; a model's call is not.
- **Refuse what would fail later, now.** A server or package missing on a host, or a first call above the cap, would refuse jobs at pickup; the preview says so first.

**Fixture note.** Trigger 3, gh-77c1, the hosts and the cap are the fixture. Sample: the first-call bound for openai / gpt-5.6-cyber is the bump report's reference figure, and the rest is as on TriggerEnvironment.
