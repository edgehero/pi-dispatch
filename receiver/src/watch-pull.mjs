import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as execute } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parseWatchFinding } from "@edgehero/pi-dispatch/watch-contract";
const execFile = promisify(execute);
const MAX_BYTES = 65536;
const digest = text => createHash("sha256").update(text).digest("hex");

/** A poll is bounded and has no model. The caller checkpoints only after every finding is accepted. */
export function makeWatchPullAdapter(config, { fileSystem = fs, run = execFile, fetchFn = fetch, env = process.env, now = () => Date.now(), redact = () => "[redacted]" } = {}) {
	if (!["file", "journald", "loki"].includes(config.kind)) throw new Error("unsupported watch pull source");
	if (!config.fields || typeof config.fields !== "object" || Array.isArray(config.fields)) throw new Error("watch pull requires reviewed structured fields");
	function finding(message, fields = {}, severity = config.severity ?? "error", at = new Date(now()).toISOString()) {
		const sample = redact(String(message).slice(0, 2048));
		return parseWatchFinding({ fields: { ...fields, ...config.fields }, severity, count: 1, firstSeen: at, lastSeen: at, samples: [sample] });
	}
	return {
		async poll(cursor = {}) {
			if (config.kind === "file") {
				if (typeof config.path !== "string" || !config.path.startsWith("/")) throw new Error("watch file path must be absolute");
				let handle;
				try {
					handle = await fileSystem.open(config.path, constants.O_RDONLY | constants.O_NOFOLLOW);
					const stat = await handle.stat(); if (!stat.isFile()) throw new Error("watch input is not a regular file");
					const identity = `${stat.dev}:${stat.ino}`;
					const offset = cursor.identity === identity && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= stat.size ? cursor.offset : 0;
					const buffer = Buffer.alloc(MAX_BYTES); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
					const bytes = buffer.subarray(0, bytesRead); const end = bytes.lastIndexOf(10);
					if (end < 0 && bytesRead === MAX_BYTES) throw new Error("watch log line exceeds read limit");
					const findings = []; const deliveries = []; let lineOffset = offset;
					if (end >= 0) for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
						const recordOffset = lineOffset; lineOffset += Buffer.byteLength(line) + 1;
						if (!line || config.contains && !line.includes(config.contains)) continue;
						findings.push(finding(line)); deliveries.push(digest(`${identity}:${recordOffset}:${line}`));
						if (findings.length > 100) throw new Error("watch file batch exceeds finding limit");
					}
					return { findings, deliveries, cursor: { identity, offset: offset + end + 1 } };
				} catch { throw new Error("watch file poll unavailable"); } finally { await handle?.close(); }
			}
			if (config.kind === "journald") {
				if (typeof config.unit !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(config.unit)) throw new Error("invalid watch journal unit");
				if (cursor.after !== undefined && (typeof cursor.after !== "string" || cursor.after.length > 512 || /[\r\n\u0000]/.test(cursor.after))) throw new Error("invalid watch journal cursor");
				const args = ["--unit", config.unit, "--output=json", "--no-pager", "--no-tail", ...(cursor.after ? ["--after-cursor", cursor.after] : ["--since", new Date(now() - 60000).toISOString()])];
				let stdout;
				try { ({ stdout } = await run("journalctl", args, { timeout: 5000, maxBuffer: MAX_BYTES, encoding: "utf8" })); } catch { throw new Error("watch journal poll unavailable"); }
				if (Buffer.byteLength(stdout) > MAX_BYTES) throw new Error("watch journal response exceeds limit");
				const findings = []; const deliveries = []; let after = cursor.after;
				for (const line of stdout.trim().split("\n").filter(Boolean)) {
					let entry; try { entry = JSON.parse(line); } catch { throw new Error("invalid watch journal response"); }
					if (typeof entry.__CURSOR !== "string" || entry.__CURSOR.length > 512) throw new Error("watch journal cursor missing");
					after = entry.__CURSOR;
					if (typeof entry.MESSAGE !== "string" || config.contains && !entry.MESSAGE.includes(config.contains)) continue;
					findings.push(finding(entry.MESSAGE)); deliveries.push(digest(entry.__CURSOR)); if (findings.length > 100) throw new Error("watch journal batch exceeds limit");
				}
				return { findings, deliveries, cursor: { after } };
			}
			let endpoint;
			try { endpoint = new URL(config.url); } catch { throw new Error("invalid watch Loki endpoint"); }
			if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || typeof config.query !== "string" || config.query.length > 4096) throw new Error("invalid watch Loki configuration");
			endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/loki/api/v1/query_range";
			const start = cursor.startNs ?? String(BigInt(now() - 60000) * 1000000n);
			if (typeof start !== "string" || !/^[0-9]{1,24}$/.test(start)) throw new Error("invalid watch Loki cursor");
			endpoint.search = new URLSearchParams({ query: config.query, start, end: String(BigInt(now()) * 1000000n), limit: "100", direction: "forward" }).toString();
			const token = config.secretEnv ? env[config.secretEnv] : undefined;
			if (config.secretEnv && !token) throw new Error("watch Loki credential unavailable");
			let response;
			try { response = await fetchFn(endpoint, { redirect: "error", signal: AbortSignal.timeout(5000), headers: token ? { authorization: `Bearer ${token}` } : {} }); } catch { throw new Error("watch Loki poll unavailable"); }
			if (!response.ok) { await response.body?.cancel?.(); throw new Error("watch Loki request refused"); }
			let bytes = 0; const chunks = []; const reader = response.body.getReader();
			try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BYTES) throw new Error("limit"); chunks.push(Buffer.from(value)); } } catch { await reader.cancel().catch(() => {}); throw new Error("watch Loki response exceeds limit"); } finally { reader.releaseLock(); }
			let result; try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("invalid watch Loki response"); }
			if (result.status !== "success" || result.data?.resultType !== "streams" || !Array.isArray(result.data.result)) throw new Error("invalid watch Loki response");
			const entries = [];
			for (const stream of result.data.result) {
				if (!Array.isArray(stream.values)) throw new Error("invalid watch Loki stream");
				for (const value of stream.values) { if (!Array.isArray(value) || !/^[0-9]{1,24}$/.test(value[0]) || typeof value[1] !== "string") throw new Error("invalid watch Loki value"); entries.push({ timestamp: value[0], message: value[1], fields: stream.stream ?? {} }); }
			}
			if (entries.length > 100) throw new Error("watch Loki batch exceeds limit");
			entries.sort((a, b) => BigInt(a.timestamp) < BigInt(b.timestamp) ? -1 : BigInt(a.timestamp) > BigInt(b.timestamp) ? 1 : 0);
			if (cursor.seen !== undefined && (!Array.isArray(cursor.seen) || cursor.seen.length > 100 || cursor.seen.some(x => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x)))) throw new Error("invalid watch Loki cursor");
			const seen = new Set(cursor.seen ?? []); const findings = []; const deliveries = []; let last = start;
			for (const entry of entries) {
				if (BigInt(entry.timestamp) < BigInt(start)) throw new Error("watch Loki cursor moved backwards");
				const id = digest(JSON.stringify(entry)); if (entry.timestamp === start && seen.has(id)) continue;
				if (last !== entry.timestamp) seen.clear(); last = entry.timestamp; seen.add(id);
				if (!config.contains || entry.message.includes(config.contains)) { findings.push(finding(entry.message, entry.fields, config.severity ?? "error", new Date(Number(BigInt(entry.timestamp) / 1000000n)).toISOString())); deliveries.push(id); }
			}
			if (entries.length === 100 && findings.length === 0) throw new Error("watch Loki timestamp batch cannot advance");
			return { findings, deliveries, cursor: { startNs: last, seen: [...seen] } };
		},
	};
}
