The live run gh-b3d7 as a viewer sees it: status and numbers only, with a plain line where operator-only parts would be.

**How a person uses it.**
- A small banner says they are signed in as a viewer and what that hides.
- *Progress* keeps:
  - the elapsed time, turn and steps;
  - the tool running now;
  - "Phase 2 of 4: 3 of 10 done" on numbered phase bars;
  - recent steps by tool name.

  Phase names and the note are replaced by one line.
- *Live transcript* holds a single locked state: "Transcripts are shown to operators only."
- *Chat* gives the status and "Chat is for operators; a viewer sees the run's status only."
- *Inbox* lists ids, modes, sources, states, times and bytes, with no Withdraw.
- There is no Cancel, no re-run, no command to copy, and no Audit in the More menu.
- *Three more states a viewer meets*:
  - stale progress;
  - a failed run whose record names no reason (the queue's failure text is operator-only);
  - a reason token this console does not know yet, shown as written with "no explanation yet".

**Panels.** `p-progress`, `transcript`, `p-chat`, `p-inbox`, `p-run`.

**The server provides.** The same data as for an operator, minus everything model-written: no phase names, no note, no transcript, no failure text, no forms. The privacy split happens on the server, not in CSS.

**Why it works this way.**
- A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop.
- A message's text is never listed, for any role: the run reads it, and the audit log keeps its sha256.
- A reason a newer worker wrote that this console has no sentence for is shown as its token, as written. An outcome it does not know shows with the failed glyph.

**Fixture note.** gh-b3d7's progress and steps are the fixture, as on RunLive. The inbox rows, the stale time, the failed run and the token `scope-cap-window` are sample.
