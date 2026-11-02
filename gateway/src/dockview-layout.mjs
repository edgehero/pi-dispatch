/** Community Dockview is a view adapter. It never owns a socket or authority-bearing object. */
export function createWorkbenchLayout({ window, document, container, createDockview, getPane, onActive, onVisible, onDimensions, onClose }) {
	let disposing = false;
	const subscriptions = [];
	const api = createDockview(container, {
		disableFloatingGroups: true, theme: { name: "Pulse", className: "wb-layout", gap: 4 },
		createComponent({ id }) {
			const pane = getPane(id);
			if (!pane) throw new Error("Unknown terminal view");
			const viewSubscriptions = [];
			return { element: pane.root, init(parameters) {
				viewSubscriptions.push(parameters.api.onDidVisibilityChange(e => onVisible(id, e.isVisible)));
				viewSubscriptions.push(parameters.api.onDidDimensionsChange(() => onDimensions(id)));
			}, dispose() { for (const subscription of viewSubscriptions.splice(0)) subscription.dispose(); } };
		},
		createTabComponent({ id }) {
			const element = document.createElement("div"); element.className = "wb-tab";
			const text = document.createElement("span"), close = document.createElement("button");
			text.textContent = getPane(id)?.connection.id ?? "Terminal"; close.textContent = "×"; close.setAttribute("type", "button"); close.tabIndex = -1;
			close.setAttribute("aria-label", `Close browser terminal ${text.textContent}`); element.append(text, close);
			close.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); onClose(id); });
			return { element, init() {} };
		},
	});
	subscriptions.push(api.onDidActivePanelChange(() => { if (!disposing) onActive(api.activePanel?.id ?? null); }));
	// Dockview documents removal notifications during moves. Observe the completed mutation before
	// deciding whether a user closed a panel; a remove event alone must never detach a live terminal.
	subscriptions.push(api.onDidRemovePanel(panel => { Promise.resolve().then(() => { if (!disposing && !api.getPanel(panel.id)) onClose(panel.id); }); }));
	return {
		add(id, { background = false } = {}) {
			const reference = api.activePanel;
			return api.addPanel({ id, title: getPane(id).connection.id, component: "terminal", renderer: "always", inactive: background, minimumWidth: 200, minimumHeight: 120, ...(reference ? { position: { referencePanel: reference, direction: "within" } } : {}) });
		},
		activate(id) { api.getPanel(id)?.api.setActive(); },
		remove(id) { const panel = api.getPanel(id); if (panel) api.removePanel(panel); },
		split(id, direction) {
			const panel = api.getPanel(id); if (!panel || panel.group.panels.length < 2 || api.groups.length >= 4) return false;
			panel.api.moveTo({ group: panel.group, position: direction === "below" ? "bottom" : "right" }); return true;
		},
		reorder(id, delta) {
			const panel = api.getPanel(id); if (!panel) return;
			const index = panel.group.panels.indexOf(panel), next = Math.max(0, Math.min(panel.group.panels.length - 1, index + delta));
			if (next !== index) panel.api.moveTo({ group: panel.group, position: "center", index: next });
		},
		move(id, groupId) { const panel = api.getPanel(id), group = api.groups.find(g => g.id === groupId); if (panel && group && group !== panel.group) panel.api.moveTo({ group, position: "center" }); },
		resize(id, axis, delta) { const panel = api.getPanel(id); if (!panel || api.groups.length < 2) return; const group = panel.group; group.api.setSize(axis === "width" ? { width: Math.max(200, group.api.width + delta) } : { height: Math.max(120, group.api.height + delta) }); },
		merge(id) {
			const active = api.getPanel(id) ?? api.activePanel ?? api.panels[0]; if (!active) return;
			const target = active.group;
			for (const panel of [...api.panels]) if (panel.group !== target) panel.api.moveTo({ group: target, position: "center", skipSetActive: true });
			active.api.setActive();
		},
		get groups() { return api.groups.map((g, i) => ({ id: g.id, label: `Group ${i + 1}`, panels: g.panels.map(p => p.id) })); },
		groupOf(id) { return api.getPanel(id)?.group.id ?? null; },
		get active() { return api.activePanel?.id ?? null; },
		layout() { api.layout(container.clientWidth, container.clientHeight); },
		dispose() { disposing = true; for (const subscription of subscriptions.splice(0)) subscription.dispose(); api.dispose(); },
	};
}
