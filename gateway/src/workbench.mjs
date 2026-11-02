/** Session-bound terminal lifetimes. Dockview owns only the arrangement of their existing DOM. */
import { createTerminalElements } from "./pane-elements.mjs";
import { createWorkbenchLayout } from "./dockview-layout.mjs";
import { workspaceConnection, duplicateConnection, WORKBENCH_LIMITS, RUN_OUTCOME_WORDS } from "./frontend-contract.mjs";
import { GATEWAY_END_WORDS } from "./browser.mjs";

function untilAborted(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Admission ended"));
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Admission ended")); };
		signal.addEventListener("abort", abort, { once: true });
		promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export async function mountWorkbench({ window, document, createDockview, mountTerminal, layoutFactory = createWorkbenchLayout, onEndAll } = {}) {
	const el = name => document.getElementById(name), root = el("gateway-workbench"), panes = new Map(), pending = new Set(), railButtons = new Map();
	if (!root) throw new Error("Incomplete workbench shell");
	let sequence = 0, activeId = null, sessionKey = null, host = null, by = null, disposed = false, endingAll = false, theme = null, railClosed = window.innerWidth < 1100, firstReady = false;
	const listeners = [], timers = new Set();
	const on = (element, name, listener) => { element.addEventListener(name, listener); listeners.push(() => element.removeEventListener(name, listener)); };
	const node = (tag, text = "", className = "") => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
	const notice = text => { el("wb-notice").textContent = text; };
	const active = () => panes.get(activeId);
	const action = name => document.querySelector(`[data-wb-action="${name}"]`);
	const timer = (fn, ms) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
	const clearTimer = id => { if (id !== undefined) { timers.delete(id); window.clearTimeout(id); } };
	const returnUrl = connection => {
		const origin = document.querySelector('meta[name="gateway-console-origin"]')?.getAttribute("content");
		return origin ? `${origin}/sandbox/gateway/return${connection?.runFacts ? `?run=${encodeURIComponent(connection.runFacts.id)}` : ""}` : null;
	};
	const paintRail = () => { el("wb-main").classList.toggle("wb-rail-closed", railClosed); action("rail").setAttribute("aria-expanded", String(!railClosed)); };
	const layout = layoutFactory({ window, document, container: el("wb-dock"), createDockview, getPane: id => panes.get(id),
		onActive(id) { if (!id || disposed || !panes.has(id)) return; activeId = id; for (const pane of panes.values()) pane.controller?.setActive(pane.id === id); refresh(); },
		onVisible(id, visible) { const pane = panes.get(id); if (pane) { pane.visible = visible; pane.root.setAttribute("data-visible", String(visible)); pane.controller?.setVisible(visible); } },
		onDimensions(id) { panes.get(id)?.controller?.fit(); },
		onClose(id) { close(id); },
	});
	function renderRoster() {
		const rows = [], roster = el("wb-roster");
		for (const pane of panes.values()) {
			if (pane.controller?.ended) continue;
			for (const watcher of pane.sharing?.watchers ?? []) {
				const li = node("li"); li.setAttribute("data-driver-pane", pane.id); li.setAttribute("data-watcher-name", watcher.name);
				li.append(node("b", `${pane.connection.id}:`), node("span", `${watcher.name} ${watcher.state === "pending" ? "is joining" : "is watching"}`));
				const remove = node("button", `Remove ${watcher.name}`); remove.setAttribute("type", "button"); remove.setAttribute("data-watch-remove", "");
				remove.disabled = !!pane.removals?.has(watcher.watcherKey);
				remove.addEventListener("click", () => {
					if (!pane.controller?.ready || pane.controller.ended || pane.removals?.has(watcher.watcherKey)) return;
					if (!pane.controller.removeWatcher(watcher.watcherKey)) return;
					pane.removals ??= new Map(); pane.removals.set(watcher.watcherKey, timer(() => pane.controller.disconnect("authorization-unavailable"), 10000)); renderRoster();
				});
				li.append(remove); rows.push(li);
			}
		}
		roster.replaceChildren(); roster.hidden = rows.length === 0;
		if (rows.length) { const list = node("ul"); list.append(...rows); roster.append(list, node("small", "Watchers see all new output, including what is typed. Every watched terminal is listed, including inactive tabs.")); }
	}
	async function sharingSeen(pane, sharing) {
		if (disposed || !panes.has(pane.id)) return false;
		pane.sharing = sharing;
		if (pane.policy && pane.policy.enabled === sharing.enabled) { clearTimer(pane.policy.timer); pane.policy = null; }
		for (const [key, timeout] of pane.removals ?? []) if (!sharing.watchers.some(w => w.watcherKey === key)) { clearTimer(timeout); pane.removals.delete(key); }
		renderRoster(); refresh();
		// An acknowledgement means the complete persistent roster reached a live rendering turn.
		// Background/frozen documents do not grant admission by updating an invisible object.
		if (document.visibilityState === "hidden" || typeof window.requestAnimationFrame !== "function") return false;
		await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
		return !disposed && document.visibilityState !== "hidden" && panes.has(pane.id) && pane.sharing?.revision === sharing.revision;
	}
	function refresh() {
		if (disposed) return;
		const current = active(), list = el("wb-terminal-list");
		for (const [id, row] of railButtons) if (!panes.has(id)) { row.button.remove(); railButtons.delete(id); }
		for (const pane of panes.values()) {
			let row = railButtons.get(pane.id);
			if (!row) {
				const button = node("button", "", "wb-terminal-row"), title = node("b"), state = node("small");
				button.setAttribute("type", "button"); button.setAttribute("data-terminal-select", pane.id); button.append(title, state);
				button.addEventListener("click", () => { layout.activate(pane.id); pane.controller?.focus(); });
				row = { button, title, state }; railButtons.set(pane.id, row); list.append(button);
			}
			row.button.setAttribute("aria-current", String(pane.id === activeId)); row.title.textContent = pane.connection.id;
			row.state.textContent = `${pane.connection.kind === "watch" ? "Watching" : pane.controller?.ready ? "Connected" : pane.controller?.ended ? "Disconnected" : "Connecting"} · ${pane.connection.kind === "watch" ? pane.connection.driver.name : pane.connection.by}`;
		}
		el("wb-count").textContent = String(panes.size); el("wb-host").textContent = host ?? ""; el("wb-person").textContent = host ? `${host} · ${by}` : "";
		const add = action("add"), origin = document.querySelector('meta[name="gateway-console-origin"]')?.getAttribute("content");
		if (origin && host) add.setAttribute("href", `${origin}/sandbox/gateway/select?host=${encodeURIComponent(host)}`);
		const full = panes.size + pending.size >= WORKBENCH_LIMITS.panes; add.setAttribute("aria-disabled", String(full || !host));
		const groups = layout.groups, destination = el("wb-group-target"), chosen = destination.value;
		const groupIds = groups.map(group => group.id).join("|");
		if (destination.getAttribute("data-groups") !== groupIds) {
			destination.replaceChildren(); for (const group of groups) { const option = node("option", group.label); option.value = group.id; destination.append(option); }
			destination.setAttribute("data-groups", groupIds); if (groups.some(g => g.id === chosen)) destination.value = chosen;
		}
		const group = groups.find(g => g.id === layout.groupOf(activeId));
		for (const name of ["split-right", "split-below"]) { const button = action(name), fits = current && group && group.panels.length >= 2 && groups.length < 4; button.disabled = !fits; if (fits) button.removeAttribute("title"); else button.setAttribute("title", groups.length >= 4 ? "Four groups is the most this workspace holds." : "A split needs two tabs in this group."); }
		for (const name of ["close", "move-left", "move-right"]) action(name).disabled = !current;
		for (const name of ["move-group", "narrower", "wider", "shorter", "taller", "merge"]) action(name).disabled = !current || groups.length < 2;
		el("wb-focus-terminal").disabled = !current || !current.controller?.ready;
		el("wb-tab-label").hidden = current?.connection.kind === "watch";
		el("wb-tab-focus").disabled = !current || current.connection.kind === "watch" || current.controller?.ended;
		el("wb-tab-focus").checked = current?.controller?.tabMovesFocus ?? true;
		el("wb-watch-label").hidden = current?.connection.kind === "watch";
		el("wb-watch-policy").checked = current?.sharing?.enabled ?? false;
		el("wb-watch-policy").disabled = !current?.controller?.ready || current?.controller?.ended || !!current?.policy || current?.connection.kind === "watch";
		el("wb-watch-help").textContent = current?.connection.kind === "watch" ? "Read only: you cannot type. Stop watching leaves the driver and shell running." : current?.policy ? "Updating watch access. Waiting for the gateway." : "Watchers see all new output, including what is typed.";
		el("wb-idle").textContent = current?.elements.idle.textContent ?? "Only new output is shown; closing leaves the shell running.";
		const context = el("wb-context"); context.replaceChildren();
		if (current) {
			context.append(node("b", `${current.connection.kind === "watch" ? "Watching " : ""}${current.connection.id} on ${current.connection.host}`));
			const run = current.connection.runFacts;
			if (run) { for (const value of [RUN_OUTCOME_WORDS[run.outcome], run.project, run.target, run.flow, run.endedAt ? `ended ${new Date(run.endedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : null]) if (value) context.append(node("span", value)); }
			else context.append(node("span", "Existing sandbox shell"));
			const back = el("wb-return"); if (back) { back.setAttribute("href", returnUrl(current.connection)); back.textContent = run ? `Back to ${run.id}` : "Return to console"; }
		}
	}
	function ensureSpace() {
		if (disposed || window.innerWidth <= 760) return;
		if (!railClosed) { railClosed = true; paintRail(); layout.layout(); return; }
		if (layout.groups.length > 1) { layout.merge(activeId); notice("The groups were combined into tabs to keep the terminal readable. Split them again when you have more room."); refresh(); }
	}
	function close(id) {
		const pane = panes.get(id); if (!pane) return;
		panes.delete(id); clearTimer(pane.policy?.timer); for (const timeout of pane.removals?.values() ?? []) clearTimer(timeout);
		pane.controller?.disconnect("disconnected"); layout.remove(id);
		if (activeId === id) { activeId = layout.active ?? panes.keys().next().value ?? null; if (activeId) layout.activate(activeId); else action("add").focus(); }
		renderRoster(); refresh(); if (!panes.size) notice("No terminals are open. Add an existing terminal through the console; its connection always needs fresh authorization.");
	}
	function endAll(reason = "disconnected") {
		if (endingAll || disposed) return; endingAll = true;
		for (const pane of panes.values()) pane.controller?.disconnect(reason);
		api.dispose();
		const words = GATEWAY_END_WORDS[reason] ?? GATEWAY_END_WORDS["connection-lost"];
		el("gateway-state-title").textContent = words[0]; el("gateway-state-text").textContent = words[1]; el("gateway-state").hidden = false;
		onEndAll?.(reason);
	}
	const api = {
		get sessionKey() { return sessionKey; }, get host() { return host; }, get disposed() { return disposed; },
		get size() { return panes.size; }, get pending() { return pending.size; },
		reserve(intentId) { if (disposed || pending.has(intentId) || pending.size >= WORKBENCH_LIMITS.pending || panes.size + pending.size >= WORKBENCH_LIMITS.panes) return false; pending.add(intentId); refresh(); return true; },
		release(intentId) { pending.delete(intentId); refresh(); },
		duplicate(response) { const controller = duplicateConnection(response, [...panes.values()].map(p => p.controller).filter(Boolean)); if (!controller) return false; const pane = [...panes.values()].find(p => p.controller === controller); layout.activate(pane.id); controller.focus(); return true; },
		async admit(connection, { signal } = {}) {
			if (disposed || signal?.aborted || !workspaceConnection(connection) || sessionKey && connection.sessionKey !== sessionKey || host && connection.host !== host || panes.size >= 4) throw new Error("Terminal admission refused");
			const initialView = panes.size === 0, first = !firstReady, id = `p${++sequence}`, made = createTerminalElements(document, { kind: connection.kind });
			const pane = { id, root: made.root, elements: made.elements, connection, visible: initialView, controller: null, sharing: null };
			pane.root.setAttribute("data-pane", id); pane.root.setAttribute("data-sandbox-id", connection.id); pane.root.setAttribute("data-host", connection.host);
			panes.set(id, pane); host ??= connection.host; by ??= connection.by;
			root.hidden = false; el("gateway-state").hidden = true; layout.add(id, { background: !initialView }); if (initialView) { activeId = id; layout.activate(id); }
			try {
				const promise = mountTerminal({ window, document, connection: { ...connection, theme: first ? connection.theme : theme }, elements: pane.elements, returnHref: returnUrl(connection), active: id === activeId, visible: pane.visible, autoFocus: false, requireSharing: true, signal,
					onFocus() { if (panes.has(id)) layout.activate(id); }, onFocusMode() { refresh(); }, onNeedsSpace: ensureSpace,
					onSharing: value => sharingSeen(pane, value), onReady() { refresh(); },
					onState(reason) { pane.sharing = null; renderRoster(); refresh(); if (["session-ended", "phone"].includes(reason)) endAll(reason); },
				}).then(controller => { if (disposed || signal?.aborted || !panes.has(id)) controller.disconnect("disconnected"); return controller; });
				pane.controller = await untilAborted(promise, signal);
				pane.controller.setActive(id === activeId); pane.controller.setVisible(pane.visible);
				const ready = await untilAborted(pane.controller.whenReady, signal);
				if (!ready || disposed || signal?.aborted || sessionKey && sessionKey !== connection.sessionKey) throw new Error("Terminal did not become ready");
				sessionKey ??= connection.sessionKey; theme = first ? connection.theme : theme; firstReady = true;
				el("wb-theme").textContent = theme ? `Theme: ${theme}` : "Theme: follows the system";
				if (initialView && document.visibilityState !== "hidden") pane.controller.focus();
				refresh(); notice(connection.kind === "watch" ? "Only new output is shown, as the driver sees it. You cannot type here." : "Only new output is shown. The original terminal may already hold the prompt. Nothing typed here reaches the run."); return pane.controller;
			} catch (error) { close(id); if (!firstReady && !panes.size) { host = null; by = null; root.hidden = true; } throw error; }
		},
		dispose() { if (disposed) return; disposed = true; for (const remove of listeners.splice(0)) remove(); for (const id of timers) window.clearTimeout(id); timers.clear(); for (const pane of panes.values()) pane.controller?.disconnect("disconnected"); panes.clear(); pending.clear(); layout.dispose(); root.hidden = true; },
	};
	for (const name of ["split-right", "split-below", "move-left", "move-right", "move-group", "narrower", "wider", "shorter", "taller", "merge", "close", "rail"]) on(action(name), "click", () => {
		if (name === "rail") { railClosed = !railClosed; paintRail(); layout.layout(); }
		else if (name === "close") close(activeId);
		else if (name.startsWith("split-")) layout.split(activeId, name === "split-below" ? "below" : "right");
		else if (name === "move-left" || name === "move-right") layout.reorder(activeId, name === "move-left" ? -1 : 1);
		else if (name === "move-group") layout.move(activeId, el("wb-group-target").value);
		else if (name === "merge") layout.merge(activeId);
		else layout.resize(activeId, ["narrower", "wider"].includes(name) ? "width" : "height", ["narrower", "shorter"].includes(name) ? -40 : 40);
		refresh();
	});
	on(action("add"), "click", event => { if (panes.size + pending.size >= 4 || !host) { event.preventDefault(); notice("Four terminal slots are in use. Close a tab before adding another existing terminal."); } });
	on(el("wb-focus-terminal"), "click", () => active()?.controller?.focus());
	on(el("wb-tab-focus"), "change", () => active()?.controller?.setTabMovesFocus(el("wb-tab-focus").checked));
	on(el("wb-watch-policy"), "change", () => {
		const pane = active(), enabled = el("wb-watch-policy").checked;
		if (!pane?.controller?.ready || pane.connection.kind !== "drive" || pane.policy) { refresh(); return; }
		if (pane.controller.requestSharing(enabled)) pane.policy = { enabled, timer: timer(() => pane.controller.disconnect("authorization-unavailable"), 10000) };
		refresh();
	});
	on(el("wb-theme"), "click", () => { theme = theme === null ? "light" : theme === "light" ? "dark" : null; if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme"); el("wb-theme").textContent = theme ? `Theme: ${theme}` : "Theme: follows the system"; for (const pane of panes.values()) pane.controller?.setTheme(theme); });
	on(document, "visibilitychange", () => { if (document.visibilityState !== "hidden") for (const pane of panes.values()) pane.controller?.refreshSharing(); });
	// A bfcache restore must expose the ended state, never a blank public shell or a reconnect.
	on(window, "pagehide", () => {
		api.dispose();
		const words = GATEWAY_END_WORDS.disconnected;
		el("gateway-state-title").textContent = words[0]; el("gateway-state-text").textContent = words[1]; el("gateway-state").hidden = false;
		onEndAll?.("disconnected");
	});
	on(window, "resize", () => { if (window.innerWidth <= 760) endAll("phone"); else layout.layout(); });
	paintRail(); refresh(); return api;
}
