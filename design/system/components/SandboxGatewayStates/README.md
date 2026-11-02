Exceptional states of the standalone sandbox gateway and the console’s attachment controls. A blocked or disconnected state never silently retries, replays input or starts a replacement container.

**How a person uses it.**
- Read the state and follow its specific next step: enable an enrolled gateway, start a native shell, use the existing browser window, sign in again or inspect the host.
- Phone and no-JavaScript states keep the native terminal/copy route. A stale public id or replayed authorization requires a fresh launch.
- Session loss, idle timeout, connection loss and sandbox exit disconnect the browser and clear its terminal buffer. What was typed is not recorded.

**Panels.** `p-gateway-states`.

**The server provides.** Closed reason words mapped to actionable, fixed sentences. Raw runtime errors, terminal output and credentials never become a banner.

**Fixture note.** Every card is an illustrative state, not a claim that a gateway is currently connected.
