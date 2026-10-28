The live run page leads with progress and the live transcript; steering and the terminal command sit beside them, and everything that only exists after the run ends collapses to one line.

**How a person uses it.** The Progress card answers "how far along is it":
- elapsed timecode, turn 7 of 40, 12 steps with 1 failed;
- the tool running now and for how long;
- phase 2 of 4 as chapters, with 3 of 10 ticks on the current phase;
- the run's own note and the three most recent steps.

The live transcript streams below. Tool arguments and results fold; a failed result opens by default; the running call says how long it has run. The side column has the Steer card (steer now, queue a follow-up, an inbox with Withdraw), the terminal chat command and the run's facts. Cancel run is in the title bar, outlined until its confirm step.

**Panels.** `p-progress`, `p-transcript`, `p-record` (one line), `p-chat`, `p-terminal`, `p-run`.

**The server provides.** Progress events (turn, steps, running tool, phase names, item counts, note) and transcript entries with kind, time and a truncated flag, over the live stream. Whether the trigger sets `run.steer`, and the queued and delivered steering messages.

**Why it works this way.**
- A run whose trigger sets no run.steer takes no messages. Its side column then shows "This run takes no messages: its trigger sets no run.steer. Watch it here instead, or continue it in a terminal once it ends." in place of the Steer card (drawn on RunChatStates as *Not steer-armed*).

**Fixture note.** Progress, recent steps and the transcript's entry kinds and times are the fixture (gh-b3d7). The tool arguments, the read result, the test failure text, the bash command and the inbox messages are sample copy. The fixture run is not steer-armed, so on the fixture its Chat panel would show the not-armed sentence instead of the Steer card.
