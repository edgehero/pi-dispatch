import { lstatSync, readFileSync } from "node:fs";
import { configError } from "./outcome.mjs";
import { LAYOUT } from "./layout.mjs";

/** Host-authored on /job:ro. A malformed marker must never silently become an ordinary writable job. */
export function readWatchMode({ path = `${LAYOUT.job}/watch.json`, fs = { lstatSync, readFileSync } } = {}) {
	let stat;
	try { stat = fs.lstatSync(path); } catch (error) {
		if (error?.code === "ENOENT") return false;
		throw configError("watch marker cannot be read", "watch-config-invalid");
	}
	if (!stat.isFile() || stat.size > 1024) throw configError("invalid watch marker", "watch-config-invalid");
	let marker;
	try { marker = JSON.parse(fs.readFileSync(path, "utf8")); } catch { throw configError("invalid watch marker", "watch-config-invalid"); }
	if (!marker || typeof marker !== "object" || Array.isArray(marker) || marker.version !== 1 || marker.mode !== "investigate" || Object.keys(marker).sort().join() !== "mode,version") throw configError("invalid watch marker", "watch-config-invalid");
	return true;
}
export const WATCH_READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export function assertWatchCompatible(cfg, { roles, mcp } = {}) {
	if (cfg.command || cfg.fork || cfg.recover || cfg.recovering || roles || mcp || cfg.awaitInput || cfg.approvalGates?.length) throw configError("watch jobs cannot load writable integrations or resume another job", "watch-config-invalid");
}

export function watchToolOptions(excluded = [], builtinNames = [], trustedNames = []) {
	return { tools: [...WATCH_READ_TOOLS, ...trustedNames], excludeTools: [...new Set([...excluded, ...builtinNames.filter((name) => !WATCH_READ_TOOLS.includes(name)), "codemode"])] };
}
