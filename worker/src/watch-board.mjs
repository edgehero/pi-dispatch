/** A board is inert data with provenance, never agent-authored markup or executable query config. */
export const WATCH_BOARD_MAX_BYTES = 16384;
export const WATCH_BOARD_TYPES = Object.freeze(["number", "line", "table", "note", "hypotheses", "timeline"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === "string" && value.length <= 2048 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const scalar = (value) => value === null || text(value) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
export function validateWatchBoard(input, { traceIds } = {}) {
	const refuse = (reason) => ({ ok: false, reason });
	let raw;
	try { raw = typeof input === "string" ? input : JSON.stringify(input); } catch { return refuse("watch-board-invalid"); }
	if (typeof raw !== "string") return refuse("watch-board-invalid");
	if (Buffer.byteLength(raw) > WATCH_BOARD_MAX_BYTES) return refuse("watch-board-oversize");
	let board;
	try { board = JSON.parse(raw); } catch { return refuse("watch-board-invalid"); }
	if (!record(board) || !keys(board, ["version", "blocks"]) || board.version !== 1 || !Array.isArray(board.blocks) || board.blocks.length > 64) return refuse("watch-board-invalid");
	const ids = new Set();
	for (const block of board.blocks) {
		if (!record(block) || !id(block.id) || ids.has(block.id) || !WATCH_BOARD_TYPES.includes(block.type) || !id(block.traceId) || (traceIds !== undefined && !traceIds.has(block.traceId)) || !text(block.title ?? "")) return refuse("watch-board-invalid");
		ids.add(block.id);
		const common = ["id", "type", "traceId", "title"];
		if (block.type === "number") {
			if (!keys(block, [...common, "value", "unit"]) || typeof block.value !== "number" || !Number.isFinite(block.value) || !text(block.unit ?? "")) return refuse("watch-board-invalid");
		} else if (block.type === "note") {
			if (!keys(block, [...common, "text"]) || !text(block.text)) return refuse("watch-board-invalid");
		} else if (block.type === "line") {
			if (!keys(block, [...common, "points"]) || !Array.isArray(block.points) || block.points.length > 256 || !block.points.every((p) => record(p) && keys(p, ["x", "y"]) && (text(p.x) || typeof p.x === "number" && Number.isFinite(p.x)) && typeof p.y === "number" && Number.isFinite(p.y))) return refuse("watch-board-invalid");
		} else if (block.type === "table") {
			if (!keys(block, [...common, "columns", "rows"]) || !Array.isArray(block.columns) || !block.columns.length || block.columns.length > 16 || !block.columns.every(text) || !Array.isArray(block.rows) || block.rows.length > 128 || !block.rows.every((row) => Array.isArray(row) && row.length === block.columns.length && row.every(scalar))) return refuse("watch-board-invalid");
		} else if (block.type === "hypotheses") {
			if (!keys(block, [...common, "items"]) || !Array.isArray(block.items) || block.items.length > 32 || !block.items.every(text)) return refuse("watch-board-invalid");
		} else if (block.type === "timeline") {
			if (!keys(block, [...common, "items"]) || !Array.isArray(block.items) || block.items.length > 64 || !block.items.every((item) => record(item) && keys(item, ["at", "text"]) && text(item.at) && Number.isFinite(Date.parse(item.at)) && text(item.text))) return refuse("watch-board-invalid");
		}
	}
	return { ok: true, board };
}
