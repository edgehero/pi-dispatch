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
	// The intents this host's outbox holds, from its files alone, in the folder's order: each valid one with its state,
	// and how many files are not intents at all. Shared by `repair()`, which acts on them, and `inspect()`, which only
	// counts them (issue #1076), so the two cannot disagree about what a file is.
	function entries() {
		const found = { rows: [], invalid: 0 };
		let names; try { names = fs.readdirSync(dir); } catch { return found; }
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			let row; try { const stat = fs.lstatSync(join(dir, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error(); row = JSON.parse(fs.readFileSync(join(dir, name), "utf8")); } catch { found.invalid++; continue; }
			const event = cleanTouch(row.event);
			if (!event || `${event.id}.json` !== name) { found.invalid++; continue; }
			found.rows.push({ event, applied: row.state === "applied" });
		}
		return found;
	}
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
		// The file goes whatever the store answers (issue #961): an abort whose answer was lost left it behind as pending, and
		// `repair()` then began that action again on every read of the page. The store's answer is handed on (issue #987):
		// it ANSWERS an error and never throws, so a caller that logs what it could not take back had nothing to log.
		async abort(intent) { if (!intent?.event) return { ok: true }; try { return await store.abort(intent.event); } finally { drop(intent.event); } },
		async repair() {
			const found = entries();
			const result = { repaired: 0, pending: 0, invalid: found.invalid };
			for (const { event, applied } of found.rows) {
				if (!applied) { result.pending++; await store.begin(event); continue; }
				const sent = await store.write(event);
				if (sent.ok) { drop(event); result.repaired++; }
			}
			return result;
		},
		/**
		 * What `repair()` would do, with nothing written (issue #1076): the Zero touch page reads this, and settling is an
		 * operator's action. `applied` intents are actions that ran and whose accounting did not finish, which a settle
		 * publishes; `pending` ones are actions interrupted before they said whether they ran, which a settle only begins
		 * again; `invalid` files are passed over by both.
		 */
		inspect() {
			const found = entries();
			const applied = found.rows.filter((row) => row.applied).length;
			return { applied, pending: found.rows.length - applied, invalid: found.invalid };
		},
	};
}

/** The action runs exactly once. A metric failure is an explicit warning, never a reason to retry its side effect. */
export async function trackTouchAction({ store, outbox = null, event, act, succeeded = (result) => result?.ok === true }) {
	if (!store && !outbox) return act();
	const writer = outbox ?? { begin: (e) => store.begin(e), applied: (intent) => store.write(intent.event), abort: (intent) => store.abort(intent.event) };
	const intent = await writer.begin(event);
	let result;
	// Aborted on any throw, also one whose answer was lost (`valkeyMayStillRun`, issue #867): a cancel's removal that then
	// lands is a stop not counted, so the stops count can be one short (the rate is unaffected, since stops never enter
	// its denominator). REJECTED: keeping the intent pending as unknown. Nothing resolves it (a rerun finds no job, the CLI
	// has no outbox, `repair()` only begins it again), so the store reads `touch-actions-unresolved` with its coverage reset
	// to now, the Zero touch page reads unavailable, and every later tracked action renews its 30-day TTL.
	try { result = await act(); } catch (error) { await writer.abort(intent); throw error; }
	if (!succeeded(result)) { await writer.abort(intent); return result; }
	const tracked = await writer.applied(intent);
	return tracked?.ok ? result : { ...result, touchWarning: "touch-tracking-incomplete" };
}
