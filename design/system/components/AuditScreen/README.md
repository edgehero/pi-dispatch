The audit log lists every write, sign-in and refusal in a hash chain, and says first whether the chain still holds.

**How a person uses it.**
- **Chain state.** The banner on top says how far the chain is verified. When a row is damaged, it says what that means and what to do: keep the file, compare it with a backup.
- **Filters.** A search for targets and reasons, plus closed lists for who, actor role, action and outcome. The agent role finds applied receipts and refused or compensated attempts without hiding damaged rows.
- **The table.** Seq, At (UTC), Who (name and role), Action, Target, Outcome (a badge with a glyph and a word: ok, refused, damaged, not verified) and Reason.
- **A damaged row** is tinted red with its sentence inline. Rows after it are marked *not verified*.
- **About this log.** A side card summarises rows, verified range and who can see the page (operators only).

**Panels.** `p-audit`, `p-audit-about`, and the chain banner.

**The server provides.**
- The rows, newest first, 50 per page.
- Each row's verification state.
- The first damaged row, if any.

**Fixture note.** Rows 1 to 6 come from the fixture. Rows 7 (damaged) and 8 (not verified) are sample data, there to show the damaged state.
