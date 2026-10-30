import * as nodeFs from "node:fs";
import { join } from "node:path";
import { cleanTouch } from "./touch-state.mjs";

/**
 * An applied action must never be repeated merely because its metric did not publish. The durable intent is written
 * before acting, marked applied before publication, and only applied entries are replayed. An interrupted pending
 * entry is unknown until its owner supplies proof; it cannot be guessed successful from an audit row.
 */
export function makeTouchOutbox({ dir, store, fs = nodeFs, log = () => {} } = {}) {
	const path = (id) => join(dir, `${id}.json`);
	function save(event, state) {
		if (!dir) return false;
		try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(`${path(event.id)}.tmp`, JSON.stringify({ state, event }), { mode: 0o600 }); fs.renameSync(`${path(event.id)}.tmp`, path(event.id)); return true; } catch { log("touch_outbox_unavailable", {}); return false; }
	}
	function drop(event) { try { fs.unlinkSync(path(event.id)); } catch {} }
	return {
		async begin(value) {
			const event = cleanTouch(value);
			if (!event) return { error: "touch-event-invalid" };
			const durable = save(event, "pending");
			const indexed = await store.begin(event);
			return { event, durable, ...(indexed.ok ? { ok: true } : { error: indexed.error }) };
		},
		async applied(intent) {
			if (!intent?.event) return { error: "touch-event-invalid" };
			const durable = save(intent.event, "applied");
			const result = await store.write(intent.event);
			if (result.ok) drop(intent.event);
			if (!result.ok) log("touch_record_pending", {});
			return result.ok ? result : { error: result.error, durable };
		},
		async abort(intent) { if (!intent?.event) return; await store.abort(intent.event); drop(intent.event); },
		async repair() {
			const result = { repaired: 0, pending: 0, invalid: 0 };
			let names; try { names = fs.readdirSync(dir); } catch { return result; }
			for (const name of names) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				let row; try { const stat = fs.lstatSync(join(dir, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error(); row = JSON.parse(fs.readFileSync(join(dir, name), "utf8")); } catch { result.invalid++; continue; }
				const event = cleanTouch(row.event);
				if (!event || `${event.id}.json` !== name) { result.invalid++; continue; }
				if (row.state !== "applied") { result.pending++; await store.begin(event); continue; }
				const sent = await store.write(event);
				if (sent.ok) { drop(event); result.repaired++; }
			}
			return result;
		},
	};
}

/** The action runs exactly once. A metric failure is an explicit warning, never a reason to retry its side effect. */
export async function trackTouchAction({ store, outbox = null, event, act, succeeded = (result) => result?.ok === true }) {
	if (!store && !outbox) return act();
	const writer = outbox ?? { begin: (e) => store.begin(e), applied: (intent) => store.write(intent.event), abort: (intent) => store.abort(intent.event) };
	const intent = await writer.begin(event);
	let result;
	try { result = await act(); } catch (error) { await writer.abort(intent); throw error; }
	if (!succeeded(result)) { await writer.abort(intent); return result; }
	const tracked = await writer.applied(intent);
	return tracked?.ok ? result : { ...result, touchWarning: "touch-tracking-incomplete" };
}
