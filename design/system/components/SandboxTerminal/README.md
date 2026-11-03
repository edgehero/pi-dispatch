The sandbox gateway’s own tab, on a different hostname from the console. It attaches to an existing shell after fresh operator authorization. The console keeps its current CSP, assets and one-way SSE channel.

**How a person uses it.**
- Read the sandbox id, host and signed-in operator before typing. Connected means this browser has the one active gateway attachment to that exact container.
- Type and read new output in the terminal; earlier screen contents are not replayed and no Enter is injected to redraw them. Ordinary Escape, Ctrl+C, arrow keys, Unicode and shell completion work. “Tab moves focus” starts on; turn it off for completion, or use Ctrl+Shift+M to switch it back.
- Disconnect closes the browser attachment and clears its terminal buffer. It leaves the original shell running; Ctrl+D can end that shell normally.
- Return to console goes through its generic return page so a cross-site navigation does not discard the original Strict-cookie session.
- On a phone, no terminal opens. Copy the command from Sandboxes instead. Shrinking a connected window into that layout disconnects it.
- Use a current browser with Web Locks. Without secure launch coordination, the gateway refuses before cookie binding and keeps the native terminal fallback.

**Panels.** `p-gateway-terminal`.

**The server provides.**
- A one-use authorization for the current operator session, browser launch and exact live container, after fresh sign-in with the same token.
- The host, sandbox id, operator and configured idle timeout only after authorization. Terminal input and output never enter a run record or audit payload.
- Existing-container output and bounded input/resize messages. There is no container creation, exec, command choice, image choice, terminal history or automatic reconnect.

**Why it works this way.** The gateway is off by default and explicitly enrolled. Its own hostname isolates host cookies. Its self-hosted xterm renderer needs generated styles, so its own CSP allows inline styles; the console’s CSP remains unchanged. OSC title, link and clipboard commands have no browser side effects.

**Fixture note.** gh-9575, mini1, ops and the terminal output are sample. The static reference illustrates xterm’s rendered surface; the application uses the real terminal renderer and transport, verified by behavioral and browser tests.
