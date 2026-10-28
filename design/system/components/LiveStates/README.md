How live data looks when it is live, paused, failing or over.

- **Live pill.** Live; Reconnecting (the page stays, retrying every 2 seconds); Not live (refused or closed: reload after closing another console tab); Signed out (every stream ends, then sign-in says why).
- **Pages drawn once.** Spend, Configuration and Audit say when they were drawn and offer Reload.
- **A panel in use is not swapped.** While a preview is open, a form has focus or a field has changed, the panel keeps still and says newer data is waiting.
- **Read failures.**
  - A snapshot panel with nothing to show says the Valkey could not be read, and that the next refresh tries again.
  - A panel that has older data shows it dimmed, under the time it was last seen.
- **Transcript stream.**
  - Status chips: live, reconnecting, ended (with the outcome), not live.
  - A jump pill counts new entries when the person has scrolled up.
  - Progress with no update for 3 minutes or more says the worker may be gone, and points to Fleet.
- **Stream limits.** One token may hold 4 live tabs (a run with its transcript counts as two). Past that, the tab stays still and says why.
