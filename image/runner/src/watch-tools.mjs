import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./outcome.mjs";
import { LAYOUT } from "./layout.mjs";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const name = (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) && !["constructor", "prototype", "__proto__"].includes(v);
const bad = () => configError("invalid watch tools configuration", "watch-config-invalid");
export function readWatchTools({ path = `${LAYOUT.job}/watch-tools.json`, fs = { lstatSync, readFileSync } } = {}) {
	let stat;
	try { stat = fs.lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return { version: 1, queries: {} }; throw bad(); }
	if (!stat.isFile() || stat.size > 65536) throw bad();
	let value;
	try { value = JSON.parse(fs.readFileSync(path, "utf8")); } catch { throw bad(); }
	return validateWatchTools(value);
}
export function validateWatchTools(value) {
	if (!only(value, ["version", "decisionModel", "queries"]) || value.version !== 1) throw bad();
	if (value.decisionModel !== undefined && (!only(value.decisionModel, ["provider", "id"]) || typeof value.decisionModel.provider !== "string" || typeof value.decisionModel.id !== "string" || !value.decisionModel.provider || !value.decisionModel.id || value.decisionModel.id.length > 256)) throw bad();
	if (value.queries !== undefined && (!object(value.queries) || Object.keys(value.queries).length > 32)) throw bad();
	for (const [key, query] of Object.entries(value.queries ?? {})) {
		if (!name(key) || !only(query, ["endpoint", "query", "headers"]) || typeof query.query !== "string" || Buffer.byteLength(query.query) > 8192) throw bad();
		let url; try { url = new URL(query.endpoint); } catch { throw bad(); }
		if (url.protocol !== "https:" || url.username || url.password || url.hash) throw bad();
		if (query.headers !== undefined && (!object(query.headers) || Object.keys(query.headers).length > 16)) throw bad();
		for (const [header, val] of Object.entries(query.headers ?? {})) if (!/^[a-zA-Z0-9-]+$/.test(header) || ["host", "connection", "content-length", "transfer-encoding"].includes(header.toLowerCase()) || typeof val !== "string" || val.length > 8192 || /[\r\n]/.test(val)) throw bad();
	}
	return JSON.parse(JSON.stringify({ ...value, queries: value.queries ?? {} }));
}
const reply = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {}, ...(isError && { isError: true }) });
/** File-only transport: the worker is the only Valkey writer. Header values are never traced. */
export function createWatchTools({ config, runtime, outbox = LAYOUT.outbox, fetch: fetchImpl = globalThis.fetch, fs = { appendFileSync, writeFileSync }, now = () => Date.now() }) {
	config = validateWatchTools(config);
	let bytes = 0; let entries = 0; let seq = 0;
	const trace = (entry) => {
		const id = `watch-${++seq}`;
		const line = JSON.stringify({ id, at: now(), ...entry }) + "\n";
		const size = Buffer.byteLength(line);
		if (entries >= 128 || bytes + size > 262144) throw new Error("trace-cap");
		fs.appendFileSync(join(outbox, "watch-trace.jsonl"), line, { mode: 0o600 }); bytes += size; entries++;
		return id;
	};
	const begin = (entry) => {
		// Leave bounded space for a completion even if a model's response fills its entire cap.
		if (entries > 125 || bytes > 196608) throw new Error("trace-cap");
		trace({ ...entry, status: "started" });
	};
	const tools = [];
	if (Object.keys(config.queries).length) tools.push({ name: "query_logs", label: "query logs", description: "Run one reviewed read-only query by name. No query text or endpoint overrides are accepted.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, async execute(callId, args) {
		if (!only(args, ["name"]) || !Object.hasOwn(config.queries, args.name)) return reply({ reason: "watch-query-refused" }, true);
		const query = config.queries[args.name];
		try {
			begin({ kind: "query", callId, name: args.name, query: query.query });
			const response = await fetchImpl(query.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", ...query.headers }, body: JSON.stringify({ query: query.query }) });
			if (!response.ok || !response.body) throw new Error("query-failed");
			let size = 0; const chunks = [];
			for await (const chunk of response.body) { size += chunk.byteLength; if (size > 65536) throw new Error("query-oversize"); chunks.push(Buffer.from(chunk)); }
			const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const rows = Array.isArray(result) ? result : result?.rows;
			if (!Array.isArray(rows) || rows.length > 100) throw new Error("query-rows-invalid");
			const traceId = trace({ kind: "query", callId, name: args.name, status: "completed", rows: rows.length });
			return reply({ rows, traceId });
		} catch {
			try { trace({ kind: "query", callId, status: "failed" }); } catch {}
			return reply({ reason: "watch-query-failed" }, true);
		}
	} });
	if (config.decisionModel) tools.push({ name: "decide", label: "decide", description: "Ask typed questions with the reviewed decision model, charged within this job's cap.", parameters: { type: "object", properties: { state: { type: "object" }, questions: { type: "object" } }, required: ["state", "questions"], additionalProperties: false }, async execute(callId, args) {
		if (!only(args, ["state", "questions"]) || !object(args.state) || !object(args.questions)) return reply({ reason: "decide-refused" }, true);
		let serialized; try { serialized = JSON.stringify(args); } catch { return reply({ reason: "decide-refused" }, true); }
		if (Buffer.byteLength(serialized) > 16384 || Object.keys(args.questions).length > 16) return reply({ reason: "decide-refused" }, true);
		const model = runtime.getModelsOfType("classifier", config.decisionModel.provider).find((m) => m.id === config.decisionModel.id);
		if (!model || !Number.isFinite(model.cost?.input) || model.cost.input < 0 || model.cost.output !== 0) return reply({ reason: "decide-refused" }, true);
		try {
			begin({ kind: "decide", callId, model: `${model.provider}/${model.id}`, state: args.state, questions: args.questions });
			// ModelRuntime.prototype.classify is wrapped by the process-wide meter BEFORE this factory loads.
			const result = await runtime.classify(model, args, { signal: AbortSignal.timeout(10000) });
			const summary = { answers: result.answers, usage: result.usage, stopReason: result.stopReason };
			if (Buffer.byteLength(JSON.stringify(summary)) > 16384) throw new Error("decide-oversize");
			const traceId = trace({ kind: "decide", callId, status: result.stopReason === "stop" ? "completed" : "failed", ...summary });
			return reply({ ...summary, traceId }, result.stopReason !== "stop");
		} catch {
			try { trace({ kind: "decide", callId, status: "failed" }); } catch {}
			return reply({ reason: "decide-unanswered" }, true);
		}
	} });
	tools.push({ name: "board_write", label: "propose board", description: "Propose a board document as plain data. A person adopts structural changes.", parameters: { type: "object", properties: { board: { type: "object" } }, required: ["board"], additionalProperties: false }, async execute(callId, args) {
		if (!only(args, ["board"]) || !object(args.board) || args.board.version !== 1 || !Array.isArray(args.board.blocks)) return reply({ reason: "watch-board-invalid" }, true);
		let raw; try { raw = JSON.stringify(args.board); } catch { return reply({ reason: "watch-board-invalid" }, true); }
		if (Buffer.byteLength(raw) > 16384) return reply({ reason: "watch-board-oversize" }, true);
		try { begin({ kind: "board", callId }); fs.writeFileSync(join(outbox, "board.json"), raw, { mode: 0o600 }); trace({ kind: "board", callId, status: "proposed", blocks: args.board.blocks.length }); return reply({ status: "proposed" }); } catch { return reply({ reason: "watch-board-write-failed" }, true); }
	} });
	return { tools, names: tools.map((tool) => tool.name), factories: [{ name: "job-watch-tools", factory(api) { for (const tool of tools) api.registerTool(tool); } }] };
}
