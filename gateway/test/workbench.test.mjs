import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./helpers/frontend-world.mjs";
import { Event } from "../../admin/test/helpers/script-dom.mjs";
import { mountGateway } from "../src/browser.mjs";
import { mountWorkbench } from "../src/workbench.mjs";
import { createTerminalElements } from "../src/pane-elements.mjs";
import { workspaceConnection, duplicateConnection, validSharing, WORKBENCH_LIMITS } from "../src/frontend-contract.mjs";

const S = "a".repeat(64);
const admitted = (n = 1, kind = "drive") => ({ connectionId: String(n).repeat(43), kind, sessionKey: S, targetKey: String(n).repeat(64), ownerKey: "b".repeat(63) + n, host: "mini1", id: `gh-${n}`, by: "ops", idleMinutes: 30, theme: "dark", runFacts: { id: `gh-${n}`, outcome: "completed", project: "web", target: "acme/web#490", flow: "fix", endedAt: "2026-10-08T15:12:00.000Z" }, ...(kind === "watch" ? { driver: { name: "lee", ownerKey: "c".repeat(64) }, geometry: { cols: 120, rows: 36, revision: 0 } } : {}) });
const sharing = (revision = 0, watchers = [], enabled = false) => ({ type: "sharing", revision, enabled, watchers });
const ticks = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

function fakeLayout(options) {
	const panels = new Map(); let selected = null; let removed = 0;
	const visible = () => { for (const id of panels.keys()) options.onVisible(id, id === selected); };
	const api = {
		add(id, { background }) { panels.set(id, { id, group: "g1" }); options.container.append(options.getPane(id).root); if (!background || !selected) { selected = id; options.onActive(id); } visible(); },
		activate(id) { if (!panels.has(id)) return; selected = id; options.onActive(id); visible(); },
		remove(id) { if (!panels.delete(id)) return; removed++; options.getPane(id)?.root.remove(); if (id === selected) selected = panels.keys().next().value ?? null; if (selected) options.onActive(selected); visible(); },
		get groups() { return [...new Set([...panels.values()].map(p => p.group))].map(id => ({ id, label: id, panels: [...panels.values()].filter(p => p.group === id).map(p => p.id) })); },
		groupOf(id) { return panels.get(id)?.group; }, get active() { return selected; },
		split(id) { if (panels.has(id)) panels.get(id).group = "g2"; }, reorder() {}, move(id, group) { panels.get(id).group = group; }, resize() {},
		merge() { for (const p of panels.values()) p.group = "g1"; visible(); }, layout() {}, dispose() { panels.clear(); },
		get removed() { return removed; },
	};
	return api;
}
async function workspace() {
	const w = world(); w.document.visibilityState = "visible";
	w.window.requestAnimationFrame = fn => w.window.setTimeout(fn, 0);
	let layout;
	const wb = await mountWorkbench({ ...w, mountTerminal: opts => mountGateway({ ...opts, Terminal: w.Terminal, FitAddon: w.FitAddon }), layoutFactory: options => (layout = fakeLayout(options)) });
	return { ...w, wb, layout };
}
async function open(w, connection = admitted()) {
	const pending = w.wb.admit(connection); await ticks();
	const socket = w.sockets.at(-1); socket.open();
	if (connection.kind === "watch") socket.emit("message", { data: JSON.stringify({ type: "geometry", ...connection.geometry }) });
	else socket.emit("message", { data: JSON.stringify(sharing()) });
	socket.emit("message", { data: '{"type":"ready"}' }); await ticks(); w.advance(0); await ticks();
	return pending;
}

test("strict admission rejects wrong session, mode, identity and unexpected run text before renderer/socket creation", async () => {
	assert.equal(workspaceConnection(admitted()), true); assert.equal(workspaceConnection(admitted(2, "watch")), true);
	for (const patch of [{ sessionKey: null }, { kind: "admin" }, { ownerKey: "raw" }, { runFacts: { ...admitted().runFacts, question: "PRIVATE" } }, { runFacts: { ...admitted().runFacts, outcome: "policy" } }, { driver: { name: "<x>", ownerKey: "c".repeat(64) } }]) {
		const value = { ...admitted(patch.driver ? 2 : 1, patch.driver ? "watch" : "drive"), ...patch };
		assert.equal(workspaceConnection(value), false);
	}
	const w = await workspace(); await open(w);
	assert.equal(w.wb.sessionKey, S); const sockets = w.sockets.length;
	await assert.rejects(w.wb.admit({ ...admitted(2), sessionKey: "d".repeat(64) }), /refused/);
	assert.equal(w.sockets.length, sockets); w.wb.dispose();
});

test("four panes and two pending offers are bounded without resetting original session after close", async () => {
	assert.equal(WORKBENCH_LIMITS.panes, 4);
	const w = await workspace(); await open(w);
	assert.equal(w.wb.reserve("x"), true); assert.equal(w.wb.reserve("y"), true); assert.equal(w.wb.reserve("z"), false);
	w.wb.release("x"); w.wb.release("y");
	for (let n = 2; n <= 4; n++) await open(w, admitted(n));
	assert.equal(w.wb.size, 4); assert.equal(w.wb.reserve("extra"), false);
	await assert.rejects(w.wb.admit(admitted(5)), /refused/);
	for (let n = 0; n < 4; n++) w.document.querySelector('[data-wb-action="close"]').dispatchEvent(new Event("click"));
	assert.equal(w.wb.size, 0); assert.equal(w.wb.sessionKey, S);
	assert.ok(w.terminals.every(t => t.disposed)); assert.ok(w.sockets.every(s => s.closed.length === 1)); w.wb.dispose();
});

test("background Add retains focus, hidden drivers answer DSR without human activity, selection routes input only to its terminal", async () => {
	const w = await workspace(); const first = await open(w), focused = w.document.activeElement;
	const second = await open(w, admitted(2));
	assert.ok(w.document.activeElement === focused, "background ready does not steal the original editor focus");
	assert.equal(w.document.querySelector('.wb-pane[data-sandbox-id="gh-1"]').getAttribute("data-active"), "true");
	w.layout.activate("p2");
	const before = w.sockets[0].sent.filter(m => m.type === "activity").length;
	w.terminals[0].input("\u001b[1;1R");
	assert.deepEqual(w.sockets[0].sent.at(-1), { type: "input", data: "\u001b[1;1R" });
	w.terminals[0].userKey({ domEvent: { isTrusted: true } });
	assert.equal(w.sockets[0].sent.filter(m => m.type === "activity").length, before);
	assert.equal(w.terminals[0].options.disableStdin, false, "parser replies remain enabled for hidden driver");
	assert.equal(w.terminals[0].key({ key: "x" }), false); assert.equal(w.terminals[0].textarea.readOnly, true);
	w.terminals[1].input("SECOND_ONLY"); assert.equal(w.sockets[0].sent.some(m => m.data === "SECOND_ONLY"), false);
	assert.deepEqual(w.sockets[1].sent.at(-1), { type: "input", data: "SECOND_ONLY" });
	assert.match(w.document.getElementById("wb-return").getAttribute("href"), /run=gh-2$/);
	assert.match(w.document.getElementById("wb-context").textContent, /gh-2/);
	assert.equal(w.document.getElementById("wb-theme").textContent, "Theme: dark");
	second.disconnect(); assert.equal(first.ready, true); assert.equal(w.terminals[0].disposed, undefined); w.wb.dispose();
});

test("watch renderer preserves driver cells, forwards no DSR/input/activity/resize, and hides driver-only switches", async () => {
	const w = await workspace(); const watch = await open(w, admitted(2, "watch")), term = w.terminals[0], socket = w.sockets[0];
	assert.equal(term.options.disableStdin, true); assert.equal(term.input, undefined); assert.equal(term.userKey, undefined);
	assert.equal(term.cols, 120); assert.equal(term.rows, 36); assert.deepEqual(socket.sent, []);
	w.window.emit("resize"); w.advance(500); assert.deepEqual(socket.sent, []);
	socket.emit("message", { data: '{"type":"geometry","cols":80,"rows":24,"revision":1}' }); assert.equal(term.cols, 80); assert.equal(term.rows, 24); assert.deepEqual(socket.sent, []);
	assert.equal(w.document.getElementById("wb-tab-label").hidden, true); assert.equal(w.document.getElementById("wb-watch-label").hidden, true);
	assert.equal(watch.requestSharing(true), false); assert.equal(watch.removeWatcher("c".repeat(64)), false);
	socket.emit("message", { data: '{"type":"geometry","cols":120,"rows":36,"revision":0}' }); assert.equal(watch.ended, true, "regressing driver geometry fails closed"); w.wb.dispose();
});

test("complete persistent roster is rendered before ACK, including inactive targets; consent and Remove wait for sharing receipt", async () => {
	const w = await workspace(); const first = await open(w); await open(w, admitted(2)); w.layout.activate("p2");
	const key = "e".repeat(64), frame = sharing(1, [{ watcherKey: key, name: "lee", state: "pending" }], true);
	const socket = w.sockets[0]; socket.emit("message", { data: JSON.stringify(frame) });
	assert.match(w.document.getElementById("wb-roster").textContent, /gh-1:.*lee is joining/);
	assert.equal(socket.sent.some(m => m.type === "sharing-seen" && m.revision === 1), false);
	w.advance(0); await ticks(); assert.equal(socket.sent.some(m => m.type === "sharing-seen" && m.revision === 1), true);
	w.document.querySelector('[data-watch-remove]').dispatchEvent(new Event("click"));
	assert.deepEqual(socket.sent.at(-1), { type: "watch-remove", watcherKey: key }); assert.match(w.document.getElementById("wb-roster").textContent, /lee/);
	socket.emit("message", { data: JSON.stringify(sharing(2, [], true)) }); assert.equal(w.document.getElementById("wb-roster").hidden, true);
	w.layout.activate("p1"); const policy = w.document.getElementById("wb-watch-policy"); policy.checked = false; policy.dispatchEvent(new Event("change"));
	assert.equal(policy.checked, true, "UI retains acknowledged true until gateway commits false"); assert.equal(policy.disabled, true);
	socket.emit("message", { data: JSON.stringify(sharing(3)) }); assert.equal(policy.checked, false); assert.equal(policy.disabled, false);
	w.document.visibilityState = "hidden"; socket.emit("message", { data: JSON.stringify(sharing(4, [{ watcherKey: key, name: "lee", state: "pending" }], true)) }); w.advance(0); await ticks();
	assert.equal(socket.sent.some(m => m.type === "sharing-seen" && m.revision === 4), false, "invisible document does not acknowledge a new observer");
	w.document.visibilityState = "visible"; w.document.dispatchEvent(new Event("visibilitychange")); w.advance(0); await ticks();
	assert.equal(socket.sent.some(m => m.type === "sharing-seen" && m.revision === 4), true, "foregrounding renders and acknowledges the same pending revision without a new server frame");
	assert.equal(first.ready, true); w.wb.dispose();
});

test("mode and exact winning attachment are mandatory for duplicate focus; invalid roster never renders attacker text", () => {
	const connection = admitted(), controller = { connection, ready: true, ended: false };
	assert.ok(duplicateConnection(connection, [controller]) === controller);
	for (const patch of [{ kind: "watch" }, { ownerKey: "f".repeat(64) }, { targetKey: "f".repeat(64) }]) assert.equal(duplicateConnection({ ...connection, ...patch }, [controller]), null);
	controller.ended = true; assert.equal(duplicateConnection(connection, [controller]), null);
	for (const frame of [sharing(0, [{ watcherKey: "e".repeat(64), name: "<script>", state: "pending" }], true), sharing(-1), { ...sharing(), command: "PRIVATE" }, sharing(0, Array(4).fill({ watcherKey: "e".repeat(64), name: "lee", state: "pending" }), true)]) assert.equal(validSharing(frame), false);
});

test("too-small driver retains last geometry/DSR and never fits a hidden tab", async () => {
	const w = world(); let dimensions = { cols: 90, rows: 22 }, fits = 0;
	class Fit { proposeDimensions() { return dimensions; } fit() { fits++; } }
	const made = createTerminalElements(w.document, { kind: "drive" }); w.document.body.append(made.root);
	const controller = await mountGateway({ ...w, connection: admitted(), elements: made.elements, FitAddon: Fit, autoFocus: false }); const socket = w.sockets[0]; socket.ready();
	const initial = socket.sent.filter(m => m.type === "resize").length; dimensions = { cols: 39, rows: 9 }; controller.fit(); w.advance(200);
	assert.equal(controller.tooSmall, true); assert.equal(socket.sent.filter(m => m.type === "resize").length, initial); assert.equal(w.terminals[0].options.disableStdin, false); assert.equal(w.terminals[0].textarea.readOnly, true);
	w.terminals[0].input("\u001b[1;1R"); assert.deepEqual(socket.sent.at(-1), { type: "input", data: "\u001b[1;1R" });
	controller.setVisible(false); dimensions = { cols: 100, rows: 30 }; const before = fits; controller.fit(); w.advance(200); assert.equal(fits, before);
	controller.setVisible(true); w.advance(200); assert.equal(controller.tooSmall, false); assert.equal(fits, before + 1); controller.disconnect();
});

test("browser run-fact schema and vocabularies equal the shared private protocol in both acceptance directions", async () => {
	const { validGatewayRunFacts, GATEWAY_RUN_OUTCOMES, GATEWAY_MAX_WATCHERS } = await import("../../worker/src/sandbox-gateway-protocol.mjs");
	const { validRunFacts, RUN_OUTCOME_WORDS, FRONTEND_MAX_WATCHERS, validGeometry, validGeometryFrame } = await import("../src/frontend-contract.mjs");
	assert.deepEqual(Object.keys(RUN_OUTCOME_WORDS), GATEWAY_RUN_OUTCOMES); assert.equal(FRONTEND_MAX_WATCHERS, GATEWAY_MAX_WATCHERS);
	const base = admitted().runFacts;
	const cases = [null, base, ...GATEWAY_RUN_OUTCOMES.map(outcome => ({ ...base, outcome }))];
	for (const [key, values] of Object.entries({ id: [null, "-bad", "x".repeat(200), "x".repeat(201)], outcome: [null, "policy", "PRIVATE"], project: [null, "a", "a".repeat(32), "a".repeat(33), "a_b", "a.b"], target: [null, "acme/web#1", "x".repeat(300), "x".repeat(301), "<script>"], flow: [null, "a", "a".repeat(64), "a".repeat(65), "a/b", "a.b", "trailing_"], endedAt: [null, "2026-10-08T15:12:00.000Z", "2026-10-08T15:12:00Z", "2026-02-31T15:12:00.000Z", "PRIVATE"] })) for (const value of values) cases.push({ ...base, [key]: value });
	cases.push({ ...base, question: "PRIVATE" }, { id: base.id });
	for (const value of cases) assert.equal(Boolean(validRunFacts(value)), Boolean(validGatewayRunFacts(value)), `closed run facts agree for ${JSON.stringify(value)}`);
	assert.equal(workspaceConnection({ ...admitted(), runFacts: { ...base, id: "other-run" } }), false);
	const geometry = { cols: 80, rows: 24, revision: 0 };
	assert.equal(validGeometry(geometry), true); assert.equal(validGeometry({ ...geometry, type: "geometry" }), false);
	assert.equal(validGeometryFrame({ type: "geometry", ...geometry }), true);
	for (const value of [{ type: "resize", ...geometry }, { type: "geometry", ...geometry, command: "PRIVATE" }, { ...geometry, revision: -1 }]) assert.equal(validGeometryFrame(value), false);
});

test("explicit activation waits for visibility/useful fit and then focuses, while background readiness never focuses", async () => {
	const w = world(); let dimensions = { cols: 20, rows: 4 }, controller;
	class Fit { proposeDimensions() { return dimensions; } fit() {} }
	const made = createTerminalElements(w.document, { kind: "drive" }); w.document.body.append(made.root);
	controller = await mountGateway({ ...w, connection: admitted(), elements: made.elements, FitAddon: Fit, active: false, visible: false, autoFocus: false, onFocus() { controller.setActive(true); controller.setVisible(true); } });
	w.sockets[0].ready(); assert.notEqual(w.document.activeElement, w.terminals[0].textarea);
	controller.focus(); w.advance(0); assert.equal(controller.tooSmall, true); assert.notEqual(w.document.activeElement, w.terminals[0].textarea);
	dimensions = { cols: 80, rows: 24 }; controller.fit(); w.advance(200);
	assert.equal(controller.tooSmall, false); assert.ok(w.document.activeElement === w.terminals[0].textarea); assert.equal(w.terminals[0].textarea.readOnly, false); controller.disconnect();
});

test("pagehide disposes every pane and leaves truthful guidance for a bfcache restore without reconnecting", async () => {
	const w = await workspace(); await open(w); await open(w, admitted(2));
	w.window.emit("pagehide", { persisted: true });
	assert.equal(w.wb.disposed, true); assert.ok(w.terminals.every(term => term.disposed)); assert.equal(w.document.getElementById("gateway-workbench").hidden, true);
	assert.equal(w.document.getElementById("gateway-state").hidden, false); assert.equal(w.text("state-title"), "Terminal disconnected");
	w.window.emit("pageshow", { persisted: true }); assert.equal(w.sockets.length, 2); assert.ok(w.sockets.every(socket => socket.closed.length === 1));
});

test("abort while fonts are delayed clears provisional pane and cannot create a late socket or session", async () => {
	const w = await workspace(); let loaded; w.document.fonts.ready = new Promise(resolve => { loaded = resolve; });
	const signal = new AbortController(), pending = w.wb.admit(admitted(), { signal: signal.signal }); await ticks(); signal.abort();
	await assert.rejects(pending, /Admission ended/); assert.equal(w.wb.sessionKey, null); assert.equal(w.wb.size, 0); assert.equal(w.sockets.length, 0);
	loaded(); await ticks(); assert.equal(w.sockets.length, 0); assert.equal(w.terminals.length, 0); w.wb.dispose();
});
