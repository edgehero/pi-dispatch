import { GATEWAY_LIMITS } from "./terminal-protocol.mjs";
import { endingFor, GATEWAY_ANSWERS } from "./endings.mjs";

/** Only these public room fields cross an already authenticated terminal socket. */
export function sharingFrame(room) {
	return { type: "sharing", enabled: room.enabled, revision: room.rosterRevision, watchers: Object.values(room.watchers).sort((a, b) => a.registeredRevision - b.registeredRevision).map(w => ({ watcherKey: w.watcherKey, name: w.actor.name, state: w.state })) };
}
export const geometryFrame = room => ({ type: "geometry", ...room.geometry });

/** No bytes or authority are stored here. Redis owns consent, revisions and attachment identity. */
export function makeSharingController({ store, intent, connectionId, browserHash, ws, authorized, lapsed = () => false, fail, onLocalStop = () => {}, audit = async () => {} }) {
	let revision = -1, geometryRevision = -1, chain = Promise.resolve(), pendingControls = 0;
	const identity = { intentId: intent.intentId, connectionId, browserHash };
	// The store refuses a control of a revoked driver with the same word it refuses that driver's renewal with, so the
	// browser reads the same ending whichever of the two reaches the store first (issues #1039, #1048). A new watcher
	// makes the driver's page acknowledge the roster at once; a console revoking that driver meanwhile is a session end.
	// Read after the session's own deadline, the same word is the lapse, as for a renewal (`endingFor`).
	const refusal = result => new Error(endingFor(result.refused, lapsed(), GATEWAY_ANSWERS.control));
	const send = value => {
		if (!authorized() || ws.readyState !== 1) return;
		const wire = JSON.stringify(value);
		// Metadata uses the same finite socket budget as terminal bytes. A silent shell must
		// not let policy/roster traffic grow an unchecked output queue for a slow reader.
		if (ws.bufferedAmount + Buffer.byteLength(wire) > GATEWAY_LIMITS.bufferedBytes) { void fail("backpressure"); return; }
		try { ws.send(wire, error => { if (error) void fail("disconnected"); }); }
		catch { void fail("disconnected"); }
	};
	function observe(room, force = false) {
		if (!room) return;
		const expected = intent.kind === "watch" ? intent.driver.connectionId : connectionId;
		if (room.driverConnectionId !== expected) throw new Error("driver-ended");
		if (intent.kind === "drive" && room.rosterRevision >= revision && (force || room.rosterRevision > revision)) {
			revision = Math.max(revision, room.rosterRevision);
			send(sharingFrame(room));
		}
		if (intent.kind === "watch" && room.geometry.revision > geometryRevision) {
			geometryRevision = room.geometry.revision;
			send(geometryFrame(room));
		}
	}
	async function apply(method, extra, force = false) {
		if (!authorized()) return;
		const result = await store[method]({ ...identity, ...extra });
		if (!result.ok || !result.room) throw refusal(result);
		if (authorized()) observe(result.room, force);
	}
	return {
		observe,
		async geometry(cols, rows) { await apply("updateGeometry", { cols, rows }); },
		handle(message) {
			if (intent.kind !== "drive") return false;
			let method, extra;
			if (message.type === "watch-policy" && Object.keys(message).sort().join() === "enabled,type" && typeof message.enabled === "boolean") {
				method = "setWatching"; extra = { enabled: message.enabled };
			} else if (message.type === "watch-remove" && Object.keys(message).sort().join() === "type,watcherKey" && /^[a-f0-9]{64}$/.test(message.watcherKey ?? "")) {
				method = "removeWatcher"; extra = { watcherKey: message.watcherKey };
			} else if (message.type === "sharing-seen" && Object.keys(message).sort().join() === "revision,type" && Number.isSafeInteger(message.revision) && message.revision >= 0) {
				method = "acknowledgeRoster"; extra = { revision: message.revision };
			} else return false;
			if (!authorized()) return true;
			// A fresh per-second frame allowance cannot grow a serialized backlog behind a slow
			// control store. The existing one-second frame budget also bounds all queued controls.
			if (pendingControls >= GATEWAY_LIMITS.framesPerSecond) { void fail("protocol-error"); return true; }
			pendingControls++;
			// Local output stops before a potentially stalled control write. Failure then closes
			// the driver too; remote processes cannot renew past the existing authority deadline.
			if (method === "setWatching" && !extra.enabled) onLocalStop({ reason: "watch-disabled" });
			if (method === "removeWatcher") onLocalStop({ reason: "watch-removed", watcherKey: extra.watcherKey });
			chain = chain.then(async () => {
				if (!authorized()) return;
				if (method === "acknowledgeRoster") { await apply(method, extra); return; }
				const policy = method === "setWatching", kind = policy ? "policy" : "remove";
				const reason = policy ? extra.enabled ? "watch-enabled" : "watch-disabled" : "watch-removed";
				let accountingFailed = false;
				try { await audit(`${kind}-intent`, intent, connectionId, `${reason}-requested`); } catch { accountingFailed = true; }
				// Revocation still happens when accounting fails. Enabling never does.
				if (accountingFailed && policy && extra.enabled) throw new Error("audit-unavailable");
				const result = await store[method]({ ...identity, ...extra });
				if (!result.ok || !result.room) throw refusal(result);
				try { await audit(kind, intent, connectionId, reason); } catch { accountingFailed = true; }
				if (accountingFailed) throw new Error("audit-unavailable");
				if (authorized()) observe(result.room, true);
			}).catch(error => fail(["audit-unavailable", "session-ended"].includes(error.message) ? error.message : "authorization-unavailable")).finally(() => { pendingControls--; });
			return true;
		},
		get settled() { return chain; },
		get pendingControls() { return pendingControls; },
	};
}
