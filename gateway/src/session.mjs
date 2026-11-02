import { performance } from "node:perf_hooks";
import { GATEWAY_AUTH_MS } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { gatewayDimensions, GATEWAY_LIMITS } from "./terminal-protocol.mjs";
import { makeSharingController } from "./sharing.mjs";
export { GATEWAY_LIMITS } from "./terminal-protocol.mjs";

/** No transcript or replay buffer: bytes exist only while crossing a currently authorized attachment. */
export function runGatewaySession({ ws, channel, store, intent, connectionId, browserHash, room = null, authRemainingMs, idleMinutes, runtime, audit, now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval, onEnd = () => {}, onClosing = () => {}, onLocalStop = () => {} }) {
	const watch = intent.kind === "watch";
	let ended = false, polling = false, resizing = false, transportLost = false;
	let pendingResize = null;
	let deadline = now() + Math.min(GATEWAY_AUTH_MS, authRemainingMs);
	let lastInput = now(), rateSince = now(), frames = 0, inputBytes = 0, resizes = 0, activities = 0;
	let timer, peerAnswered = true, lastPing = now();
	const finish = async (reason = "disconnected") => {
		if (ended) return;
		ended = true;
		onClosing();
		pendingResize = null;
		clearTimer(timer);
		channel.stream.removeListener("data", output);
		channel.detach();
		// close() keeps sending what is queued, for up to ws's 30-second close timer. A stalled watcher told to stop must not
		// go on receiving, so it loses the polite goodbye. A driver's queue holds only its own output.
		try { if (ws.readyState === 1) { if (watch && ws.bufferedAmount > 0) ws.terminate(); else { ws.send(JSON.stringify({ type: "ended", reason })); ws.close(1000, reason); } } } catch { ws.terminate(); }
		try { await store.release({ intentId: intent.intentId, connectionId, reason }); } catch {}
		try { await audit("end", intent, connectionId, reason); }
		catch { onEnd({ reason, auditFailed: true }); return; }
		onEnd({ reason });
	};
	const authorized = () => {
		if (ended) return false;
		if (now() >= deadline) { void finish("authorization-unavailable"); return false; }
		if (transportLost) return false;
		if (!watch && idleMinutes > 0 && now() - lastInput >= idleMinutes * 60000) { void finish("idle"); return false; }
		return true;
	};
	const sharing = makeSharingController({ store, intent, connectionId, browserHash, ws, authorized, fail: finish, onLocalStop, audit });
	function output(bytes) {
		if (!authorized()) return;
		if (ws.bufferedAmount + bytes.length > GATEWAY_LIMITS.bufferedBytes) { void finish("backpressure"); return; }
		try { for (let start = 0; start < bytes.length; start += GATEWAY_LIMITS.frameBytes) { if (!authorized()) break; ws.send(bytes.subarray(start, start + GATEWAY_LIMITS.frameBytes), { binary: true }, (error) => { if (error) void finish("disconnected"); }); } }
		catch { void finish("disconnected"); }
	}
	async function tick() {
		if (!authorized() || polling) return;
		polling = true;
		const requestedAt = now();
		try {
			const result = await store.renewAttachment({ intentId: intent.intentId, connectionId, browserHash });
			if (ended) return;
			if (!result.ok || !Number.isFinite(result.authRemainingMs) || result.authRemainingMs <= 0) { await finish(["window-lost", "watch-disabled", "watch-removed", "driver-ended"].includes(result.refused) ? result.refused : "session-ended"); return; }
			if (!authorized()) return;
			deadline = requestedAt + Math.min(GATEWAY_AUTH_MS, result.authRemainingMs);
			if (!authorized()) return;
			if (room && !result.room) { await finish("authorization-unavailable"); return; }
			sharing.observe(result.room);
			const state = await runtime.inspect(intent.target);
			if (ended) return;
			if (!state.ok) await finish(state.refused === "sandbox-ended" ? "sandbox-ended" : "runtime-unavailable");
		} catch { await finish("authorization-unavailable"); }
		finally { polling = false; }
	}
	function resize(geometry) {
		pendingResize = geometry;
		if (resizing) return;
		resizing = true;
		void (async () => {
			try {
				// A slower daemon must not turn an ordinary window drag into a protocol fault.
				// One numeric geometry replaces the previous pending one; input is never queued.
				while (pendingResize && authorized()) {
					const current = pendingResize; pendingResize = null;
					try { await channel.resize(current); }
					catch { await finish("runtime-unavailable"); return; }
					if (!authorized()) return;
					if (room) {
						// PTY resize succeeded. Losing the separate consent/geometry store is an
						// authority failure, never evidence that the container runtime is unavailable.
						try { await sharing.geometry(current.cols, current.rows); }
						catch (error) { await finish(error.message === "session-ended" ? "session-ended" : "authorization-unavailable"); return; }
					}
				}
			}
			finally { resizing = false; }
		})();
	}
	const overFrameBudget = () => {
		if (now() - rateSince >= 1000) { rateSince = now(); frames = 0; inputBytes = 0; resizes = 0; activities = 0; }
		return ++frames > GATEWAY_LIMITS.framesPerSecond;
	};
	// ws answers a ping itself, so a client that pings and never reads would grow the pong queue outside every other budget.
	ws.on("ping", () => { if (authorized() && overFrameBudget()) void finish("protocol-error"); });
	ws.on("pong", () => { peerAnswered = true; });
	ws.on("message", (raw, binary) => {
		if (!authorized()) return;
		if (binary || raw.length > GATEWAY_LIMITS.frameBytes || overFrameBudget()) { void finish("protocol-error"); return; }
		let m;
		try { m = JSON.parse(raw.toString("utf8")); } catch { void finish("protocol-error"); return; }
		if (!m || typeof m !== "object" || Array.isArray(m)) { void finish("protocol-error"); return; }
		// A renderer can emit device-query replies without a person typing. A watch has no
		// input/activity/resize capability, even when a hostile client invents those frames.
		if (watch && ["input", "resize", "activity"].includes(m.type)) return;
		if (sharing.handle(m)) return;
		if (m.type === "input" && Object.keys(m).sort().join() === "data,type" && typeof m.data === "string") {
			const bytes = Buffer.byteLength(m.data);
			if (bytes > GATEWAY_LIMITS.inputBytes || (inputBytes += bytes) > GATEWAY_LIMITS.bytesPerSecond || channel.stream.writableLength > GATEWAY_LIMITS.bufferedBytes) { void finish("backpressure"); return; }
			if (!bytes) return;
			try { channel.stream.write(m.data, "utf8"); } catch { void finish("runtime-unavailable"); }
			return;
		}
		if (m.type === "activity" && Object.keys(m).join() === "type") {
			// xterm also generates onData for a terminal's queries. Only the UI's trusted
			// keyboard/paste/composition observation counts as activity, never those replies.
			// Redundant observations may bunch in transit; ignoring extras avoids dropping input.
			if (++activities <= GATEWAY_LIMITS.activityPerSecond) lastInput = now();
			return;
		}
		if (m.type === "resize" && Object.keys(m).sort().join() === "cols,rows,type,width" && gatewayDimensions(m.cols, m.rows) && Number.isInteger(m.width)) {
			if (m.width < GATEWAY_LIMITS.minimumWidth) { void finish("phone"); return; }
			if (++resizes > GATEWAY_LIMITS.resizesPerSecond) { void finish("protocol-error"); return; }
			resize(m);
			return;
		}
		void finish("protocol-error");
	});
	ws.once("close", () => { void finish("disconnected"); });
	ws.once("error", () => { void finish("disconnected"); });
	sharing.observe(room, true);
	channel.stream.on("data", output);
	const lost = () => {
		if (ended || transportLost) return;
		transportLost = true;
		// Loss of a daemon stream proves no container exit. Stop both directions immediately,
		// then name an exit only when the bounded immutable-id inspection actually confirms it.
		void Promise.resolve().then(() => runtime.inspect(intent.target)).then(state => finish(state?.refused === "sandbox-ended" ? "sandbox-ended" : "runtime-unavailable"), () => finish("runtime-unavailable"));
	};
	channel.stream.once("end", lost);
	channel.stream.once("close", lost);
	channel.stream.once("error", lost);
	let lastPoll = now();
	timer = setTimer(() => {
		if (!authorized()) return;
		if (now() - lastPoll >= GATEWAY_LIMITS.pollMs) { lastPoll = now(); void tick(); }
		// A peer lost without a FIN, on a silent shell, would otherwise hold its slot and its window until idle expiry, or for
		// ever at idle zero. A browser's network stack answers pings even in a hidden or frozen tab.
		if (typeof ws.ping === "function" && now() - lastPing >= GATEWAY_LIMITS.pingMs) {
			if (!peerAnswered) { void finish("disconnected"); return; }
			peerAnswered = false; lastPing = now();
			try { ws.ping(); } catch { void finish("disconnected"); }
		}
	}, GATEWAY_LIMITS.timerMs);
	timer.unref?.();
	if (ended) clearTimer(timer); // The first observe can already have ended this session, before the timer existed to clear.
	return { finish, tick, get ended() { return ended; } };
}
