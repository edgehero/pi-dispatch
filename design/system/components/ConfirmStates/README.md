Every state of the two-step write, from asking for a preview to the audit row.

- **Agent capability.** Every preview names whether an agent may act alone, needs a person to confirm, or only a person may act, with the evaluated reason. Undo uses its inverse action under current permissions.
- **Previewing.** The confirm bar opens at once with its title and grey lines; Confirm stays disabled until the preview arrives.
- **No change.** When the change would write what is already there, the bar says so and offers only Close.
- **Paid.** Under the list, the preview says what the job will hold, in one of the repo's sentences: a per-job cap, zero-rated, no per-job cap, unknown, or a dollar setting that does not parse. Bulk previews list each job with its own reserve, say how many more match but are not in this action (at most 100), and total what they hold.
- **After a bulk confirm.** One line per job, "done" or "not done" with the reason. Reload is the primary action when any job was refused.
- **Refused at preview.** Field errors name the field and the rule. Whole-action refusals say what to set. Every one ends "nothing was changed".
- **Refused at confirm.** The repo's sentences: the ticket expired (5 minutes), was used, or belongs to another sign-in or action; it changed since the preview; Valkey unreachable; the audit log could not be written. Each says nothing was changed and offers the next step.
- **Done.** A banner names what changed and its audit row, with Undo where one exists.

Viewers never see this bar: they get no action buttons.
