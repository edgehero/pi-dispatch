/** Each terminal owns its DOM; layout moves the same root rather than rebuilding a transport. */
export function createTerminalElements(document, { prefix, kind = "drive" } = {}) {
	const node = (tag, className = "", text = "") => { const e = document.createElement(tag); if (className) e.className = className; e.textContent = text; return e; };
	const root = node("section", "wb-pane"); root.setAttribute("data-kind", kind); root.setAttribute("data-state", "connecting"); root.setAttribute("data-active", "false"); root.setAttribute("data-visible", "true");
	const head = node("div", "wb-pane-head"), identity = node("span"), connection = node("span", "badge tone-running", "Connecting");
	connection.setAttribute("data-terminal-status", "");
	const disconnect = node("button", "btn btn--ghost", kind === "watch" ? "Stop watching" : "Disconnect"); disconnect.setAttribute("type", "button"); disconnect.disabled = true; disconnect.setAttribute("data-terminal-disconnect", "");
	head.append(identity, connection, disconnect);
	const terminal = node("div", "wb-terminal" + (kind === "watch" ? " wb-watch-output" : "")); terminal.setAttribute("data-terminal-output", "");
	const state = node("div", "wb-pane-state"), title = node("h3"), text = node("p"); title.setAttribute("data-terminal-state-title", ""); text.setAttribute("data-terminal-state-text", ""); const back = node("a", "link", "Back to the console"); back.setAttribute("data-terminal-return", ""); back.hidden = true; state.append(title, text, back); state.hidden = true; state.setAttribute("role", "status"); state.tabIndex = -1;
	const small = node("p", "wb-too-small", "Enlarge this terminal to at least 40 columns and 10 rows. Its connection remains open; no input is sent from this pane."); small.hidden = true; small.setAttribute("role", "status");
	const tabFocus = node("input"); tabFocus.setAttribute("type", "checkbox"); tabFocus.checked = true;
	const after = node("button", "btn btn--ghost", "Leave terminal focus"); after.setAttribute("type", "button"); after.hidden = true;
	const idle = node("span"), theme = node("button"); theme.hidden = true;
	const terminalTitle = node("span");
	// A watcher sees no history, so a quiet shell would otherwise look like a broken page.
	const waiting = node("p", "wb-watch-wait", "Waiting for new output. Earlier output is not shown."); waiting.setAttribute("data-terminal-waiting", ""); waiting.hidden = kind !== "watch";
	root.append(head, waiting, terminal, state, small);
	const elements = { state, "state-title": title, "state-text": text, "terminal-card": root, "terminal-title": terminalTitle, identity, connection, terminal, "tab-focus": tabFocus, disconnect, "after-terminal": after, idle, theme, small, waiting, "terminal-return": back };
	if (prefix) for (const [key, element] of Object.entries(elements)) element.id = `${prefix}-${key.startsWith("state") ? "pane-" : ""}${key}`;
	return { root, elements };
}
