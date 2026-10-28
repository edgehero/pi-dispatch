The Chat and Inbox panels in every state a run can be in, so each sentence has a designed place.

**How a person uses it.**
- **Modes** (first row):
  - **Live**: the steer and follow-up forms. Both are paid, because they spend from the run's existing reservation.
  - **Reply**: the answer box for a parked run.
  - **Fork**: the terminal command for a finished run that kept a session, warning when a later run's turns are in it too.
- **Forms that do not apply** (second row): not steer-armed, no session to fork, a read-only console, and a viewer.
- **No chat yet, or none any more**: the status words and the rule's sentence for queued, recovery queued, answered, being answered, the two unknowns, no record, no run, the queue unreadable, and a pull-request park that must be answered on the forge.
- **Inbox**: limit meters (16 messages, 65,536 bytes), then a table of messages with id, mode, source, state, time and bytes, and the 8,192 byte limit per message.
  - States: queued, written, delivered, withdrawn and late, each a glyph and a word.
  - Withdraw only on queued and written rows.
  - The ended run's inbox shows the late state.
- **Withdraw**: two previews, guaranteed (queued) and best effort (written), and the result line.
- **Steer preview**: the paid confirm. It says no new reserve is taken and shows the operator's own text.
- **When a message is refused**: each refusal and inbox status sentence.

**Panels.** `p-chat`, `p-chat-none`, `p-inbox`, `p-withdraw`, `p-steer-preview`, `p-msg-refusals`. On a run page only one Chat and one Inbox state shows at a time.

**The server provides.**
- From `/api/run`: `state`, `mode`, `says`, `activeJobId`, `steer {armed, open}`, `newerRunOnTarget` and `pendingRunOnTarget`.
- Inbox rows `{id, mode, source, state, at, bytes}`.
- The steer, answer and withdraw previews from the action pipeline.

**Why it works this way.**
- A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop. Either one spends from the run's existing reservation.
- A message's text is never listed: the run reads it, and the audit log keeps its sha256.
- A fork runs on a host that holds the session store (`PI_SESSIONS_DIR`). The session's transcript is not redacted and goes to the person's own pi provider; the run's own transcript is never written.
- On a pull request a fork refuses because a pull or merge request's session is keyed by its head branch, which the run record does not carry.

**Fixture note.** Message ids, times, byte counts, gh-77e0, gh-81b2, gh-a01c and gh-3e71 are sample. The sentences are the console's (`chat-mode.mjs`, `steer-inbox.mjs`, `job-actions.mjs`).
