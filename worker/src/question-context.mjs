import * as nodeFs from "node:fs";

/**
 * Private final context for semantic grouping. An oversized final entry is not skipped to find an older convenient
 * question. The reader follows no link, holds a descriptor identity, and never reads an entire unbounded transcript.
 */
export function readQuestionContext({ path, redact, fs = nodeFs, readBytes = 64 * 1024, excerptBytes = 16 * 1024 } = {}) {
	if (typeof redact !== "function") return { status: "source-unavailable" };
	let fd;
	try {
		const before = fs.lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink()) return { status: "source-unavailable" };
		fd = fs.openSync(path, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return { status: "source-unavailable" };
		const offset = Math.max(0, stat.size - readBytes);
		const buffer = Buffer.alloc(Math.min(stat.size, readBytes));
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
		const after = fs.fstatSync(fd);
		if (bytes !== buffer.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return { status: "source-unavailable" };
		const raw = buffer.toString("utf8");
		const complete = offset > 0 ? raw.slice(raw.indexOf("\n") + 1) : raw;
		if (offset > 0 && (!raw.includes("\n") || !complete.trim() && raw.trim())) return { status: "source-oversize" };
		const clean = redact(complete);
		if (typeof clean !== "string" || !clean.trim()) return { status: "source-unavailable" };
		if (Buffer.byteLength(clean) <= excerptBytes) return { status: "ready", text: clean, truncated: offset > 0 };
		let kept = "";
		for (const line of clean.split("\n").reverse()) {
			if (Buffer.byteLength(`${line}\n${kept}`) > excerptBytes) break;
			kept = `${line}\n${kept}`;
		}
		return kept.trim() ? { status: "ready", text: kept, truncated: true } : { status: "source-oversize" };
	} catch { return { status: "source-unavailable" }; }
	finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
