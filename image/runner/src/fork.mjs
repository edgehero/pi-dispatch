import { unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { configError } from "./outcome.mjs";

/** Refuse rather than let pi quietly clamp an explicit operator choice to a different level. */
export function assertThinkingLevel(model, thinkingLevel) {
	if (thinkingLevel !== null && thinkingLevel !== undefined && clampThinkingLevel(model, thinkingLevel) !== thinkingLevel) throw configError("thinking level is not supported by the selected model");
}

/**
 * Only the per-job copy is passed here. pi extracts the tree path (including label/compaction repair), never a
 * JSONL prefix: a later physical line may belong to another branch. Reopen at the mounted filename so the worker's
 * transcript reader and promotion still observe current.jsonl, even when pi lazily persists an empty conversation.
 */
export function openForkSessionManager({ sessionFile, cwd, fork, Manager = SessionManager }) {
	let manager;
	try {
		manager = Manager.open(sessionFile, dirname(sessionFile), cwd);
	} catch {
		throw configError("fork source is not a readable pi session");
	}
	const selected = manager.getEntry(fork.entry);
	if (!selected) throw configError("fork entry is not present in the staged session");
	const leaf = fork.position === "before" ? selected.parentId : selected.id;
	if (leaf && !manager.getEntry(leaf)) throw configError("fork entry has an absent parent");
	const path = leaf ? manager.getBranch(leaf) : [];
	const pending = new Set();
	for (const entry of path) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content ?? []) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	if (pending.size) throw configError("fork entry has incomplete tool calls");
	if (leaf) manager.createBranchedSession(leaf);
	else manager.newSession({ parentSession: sessionFile });
	const generated = manager.getSessionFile();
	// pi normally names another on-disk session here. The worker reuses current.jsonl for the mounted copy,
	// so retaining that path would make this session its own parent. Run records carry the actual source run.
	const { parentSession: _parentSession, ...header } = manager.getHeader();
	writeFileSync(sessionFile, `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	if (generated !== sessionFile) {
		try { unlinkSync(generated); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	manager = Manager.open(sessionFile, dirname(sessionFile), cwd);
	return { sessionManager: manager, resumed: manager.buildSessionContext().messages.length > 0, reason: "forked" };
}

/** Explicit SDK options override restored state, but the SDK does not record overrides on existing sessions. */
export function recordForkSettings(sessionManager, model, thinkingLevel) {
	sessionManager.appendModelChange(model.provider, model.id);
	if (thinkingLevel !== null && thinkingLevel !== undefined) sessionManager.appendThinkingLevelChange(thinkingLevel);
}
