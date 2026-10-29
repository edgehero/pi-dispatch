/** The timer survives an initially empty registry: sources can be added by reviewed live configuration. */
export function makeWatchDrainer({ runtime, intervalMs = 5000, setInterval: start = globalThis.setInterval, clearInterval: stop = globalThis.clearInterval, log = () => {} }) {
	let closed = false;
	let active = false;
	const timer = start(() => {
		if (closed || active) return;
		active = true;
		void Promise.resolve().then(() => { if (!closed) return runtime.drain(); }).catch(() => {
			if (!closed) log("watch-handoff-unavailable", {});
		}).finally(() => { active = false; });
	}, intervalMs);
	timer?.unref?.();
	return { close() { if (closed) return; closed = true; stop(timer); } };
}
