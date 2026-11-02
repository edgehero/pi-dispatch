/** Origin-local helpers exchange public intent ids only. Cookies and server admission remain authority. */
import { PUBLIC_ID, WORKBENCH_LIMITS, exactKeys } from "./frontend-contract.mjs";
export const WORKBENCH_CHANNEL = "pi-dispatch-sandbox-workbench";
export const WORKBENCH_OWNER_LOCK = "pi-dispatch-sandbox-workbench-owner";
const MESSAGE_TYPES = new Set(["offer", "accepted", "ready", "focused", "refused", "session-changed", "cancel"]);
export function publicWorkbenchMessage(value) { return exactKeys(value, ["type", "intentId"]) && MESSAGE_TYPES.has(value.type) && PUBLIC_ID.test(value.intentId); }

function abortable(promise, signal) {
	if (signal.aborted) return Promise.reject(new Error("Admission ended"));
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Admission ended")); };
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export async function startWorkbenchLaunch({ window, document, intentId, fetch, mountWorkbench, deadline = window.performance.now() + WORKBENCH_LIMITS.admissionMs, onRefusal } = {}) {
	const say = (title, text) => { document.getElementById("gateway-state-title").textContent = title; document.getElementById("gateway-state-text").textContent = text; document.getElementById("gateway-state").hidden = false; };
	if (!PUBLIC_ID.test(intentId) || typeof window.navigator?.locks?.request !== "function" || typeof window.BroadcastChannel !== "function") { say("Use your own terminal", "This browser cannot coordinate a secure terminal workspace. Return to the console and copy the native command."); return { state: "coordination" }; }
	if (deadline <= window.performance.now()) { say("Terminal opening timed out", "No automatic retry was made. Return to the console for a fresh launch."); return { state: "expired" }; }
	const channel = new window.BroadcastChannel(WORKBENCH_CHANNEL), admissions = new Map();
	let startupAbort, workbench = null, epoch = 0, stopped = false, releaseOwner, owner = false, chain = Promise.resolve(), helperTimer, helperInterval;
	let settle; const result = new Promise(resolve => { settle = resolve; });
	const post = (type, id) => { if (!stopped) channel.postMessage({ type, intentId: id }); };
	const cleanupHelper = () => { if (helperTimer !== undefined) window.clearTimeout(helperTimer); if (helperInterval !== undefined) window.clearInterval(helperInterval); };
	const stop = () => {
		if (stopped) return; stopped = true; epoch++; cleanupHelper();
		for (const admission of admissions.values()) admission.controller?.abort(); admissions.clear();
		startupAbort?.abort(); channel.close(); releaseOwner?.();
	};
	const check = (ticket, ownEpoch) => !stopped && owner && epoch === ownEpoch && !ticket.controller.signal.aborted && window.performance.now() < ticket.until;
	const consume = async (id, ticket) => {
		const ownEpoch = epoch;
		if (!check(ticket, ownEpoch)) {
			ticket.result = "refused"; workbench?.release(id); post("refused", id);
			if (id === intentId && !workbench?.sessionKey) { workbench?.dispose(); stop(); say("Terminal opening timed out", "Return to the console for a fresh launch; nothing reconnects automatically."); settle({ state: "expired" }); }
			return;
		}
		let timeout, knownRefusal = false;
		try {
			timeout = window.setTimeout(() => ticket.controller.abort(), Math.max(0, ticket.until - window.performance.now()));
			const response = await abortable(fetch("/api/connect", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentId: id, sessionKey: workbench.sessionKey, width: window.innerWidth, cols: 80, rows: 24 }), signal: ticket.controller.signal }), ticket.controller.signal);
			if (!check(ticket, ownEpoch)) throw new Error("Admission ended");
			let data; try { data = await abortable(response.json(), ticket.controller.signal); } catch { throw new Error("Invalid admission response"); }
			if (!check(ticket, ownEpoch)) throw new Error("Admission ended");
			if (!response.ok) {
				if (data?.error === "workbench-session-changed") ticket.result = "session-changed";
				if (response.status === 409 && data?.error === "window-busy" && workbench.duplicate(data)) { ticket.result = "focused"; post("focused", id); return; }
				if (id === intentId && !workbench.sessionKey && onRefusal) { onRefusal(response.status, data?.error); knownRefusal = true; }
				throw new Error("Admission refused");
			}
			await abortable(workbench.admit(data, { signal: ticket.controller.signal }), ticket.controller.signal);
			if (!check(ticket, ownEpoch)) throw new Error("Admission ended");
			ticket.result = "ready"; post("ready", id);
			if (id === intentId) settle({ state: "workbench", controller: workbench, dispose: stop });
		} catch {
			ticket.result ??= "refused"; post(ticket.result, id);
			if (id === intentId && !workbench?.sessionKey) { workbench?.dispose(); stop(); if (!knownRefusal) say("This terminal did not open", "The bounded opening ended. Return to the console for a fresh launch; nothing reconnects automatically."); settle({ state: "refused" }); }
		} finally { window.clearTimeout(timeout); workbench?.release(id); ticket.controller = null; }
	};
	const offer = (id, until) => {
		for (const [key, ticket] of admissions) if (ticket.result && window.performance.now() >= ticket.until + 60000) admissions.delete(key);
		const previous = admissions.get(id);
		if (previous) { post(previous.result ?? "accepted", id); return; }
		// The cache contains no proofs. Bound it independently of the four live transports.
		if (admissions.size >= 64 || !workbench?.reserve(id)) { post("refused", id); return; }
		const ticket = { controller: new window.AbortController(), until, result: null }; admissions.set(id, ticket); post("accepted", id);
		// First association is provisional through ready, so incoming offers cannot race adoption.
		chain = chain.then(() => consume(id, ticket)).catch(() => {});
	};
	channel.addEventListener("message", event => {
		const message = event.data; if (stopped || !publicWorkbenchMessage(message)) return;
		if (owner) {
			if (message.type === "offer") offer(message.intentId, window.performance.now() + WORKBENCH_LIMITS.admissionMs);
			if (message.type === "cancel") admissions.get(message.intentId)?.controller?.abort();
			return;
		}
		if (message.intentId !== intentId) return;
		if (["ready", "focused"].includes(message.type)) {
			cleanupHelper(); say(message.type === "ready" ? "Terminal added to your workspace" : "This terminal is already open", "Use the existing workspace window. This helper carries no terminal connection.");
			window.close?.(); stop(); settle({ state: "transferred" });
		} else if (message.type === "session-changed") { cleanupHelper(); say("This workspace uses another sign-in", "The existing workspace keeps its original sign-in even when all its tabs are closed. Close that workspace before opening a terminal with a different sign-in. Nothing was retried."); stop(); settle({ state: "session-changed" });
		} else if (message.type === "refused") { cleanupHelper(); say("The terminal could not be added", "Check the existing workspace for its four terminal slots and current sign-in. Start a fresh console launch when ready; nothing retries automatically."); stop(); settle({ state: "refused" }); }
	});
	window.addEventListener("pagehide", stop, { once: true });
	void window.navigator.locks.request(WORKBENCH_OWNER_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
		if (stopped) return;
		if (lock) {
			owner = true;
			const lifetime = new Promise(resolve => { releaseOwner = resolve; });
			const ownEpoch = epoch;
			startupAbort = new window.AbortController();
			const startupTimer = window.setTimeout(() => startupAbort.abort(), Math.max(0, deadline - window.performance.now()));
			try {
				const creating = Promise.resolve(mountWorkbench({ onEndAll: stop })).then(value => { if (stopped || startupAbort.signal.aborted || ownEpoch !== epoch) value.dispose(); return value; });
				workbench = await abortable(creating, startupAbort.signal);
				if (stopped || ownEpoch !== epoch || window.performance.now() >= deadline) throw new Error("Admission ended");
			} catch {
				workbench?.dispose(); stop(); say("Terminal opening timed out", "No workspace was adopted after its opening deadline. Return to the console for a fresh launch."); settle({ state: "expired" }); return;
			} finally { window.clearTimeout(startupTimer); }

			offer(intentId, deadline);
			await lifetime;
		} else {
			say("Adding this terminal to your workspace", "Keep this helper open until the existing workspace confirms the transfer.");
			post("offer", intentId);
			helperInterval = window.setInterval(() => post("offer", intentId), 250);
			helperTimer = window.setTimeout(() => { post("cancel", intentId); say("Workspace transfer unconfirmed", "The workspace may already have attached this terminal. Check its existing window before a fresh launch. No automatic retry was made."); stop(); settle({ state: "unconfirmed" }); }, Math.max(0, deadline - window.performance.now()));
		}
	}).catch(() => { stop(); say("Workspace coordination unavailable", "Return to the console and copy the native terminal command."); settle({ state: "coordination" }); });
	return result;
}
