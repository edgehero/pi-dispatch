/** Closed browser projections, independent of runtime capabilities. */
import { gatewayDimensions } from "./terminal-protocol.mjs";
export const PUBLIC_ID = /^[A-Za-z0-9_-]{43}$/;
export const PRIVATE_KEY = /^[a-f0-9]{64}$/;
export const WORKBENCH_LIMITS = Object.freeze({ panes: 4, pending: 2, admissionMs: 15000, minCols: 40, minRows: 10 });
export const RUN_OUTCOME_WORDS = Object.freeze({ completed: "Completed", refused: "Refused", failed: "Failed", "awaiting-input": "Awaiting input", "awaiting-approval": "Awaiting approval", cancelled: "Cancelled" });
export const exactKeys = (object, keys) => !!(object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join());
export const actorName = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(value);
export const FRONTEND_MAX_WATCHERS = 3;
export function validGeometry(value) {
	return exactKeys(value, ["cols", "rows", "revision"]) && gatewayDimensions(value.cols, value.rows) && Number.isSafeInteger(value.revision) && value.revision >= 0;
}
export function validGeometryFrame(value) { return exactKeys(value, ["type", "cols", "rows", "revision"]) && value.type === "geometry" && validGeometry({ cols: value.cols, rows: value.rows, revision: value.revision }); }
export function validSharing(value) {
	return exactKeys(value, ["type", "enabled", "revision", "watchers"]) && value.type === "sharing" && typeof value.enabled === "boolean" && Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value.watchers) && value.watchers.length <= FRONTEND_MAX_WATCHERS && new Set(value.watchers.map(w => w?.watcherKey)).size === value.watchers.length && value.watchers.every(w => exactKeys(w, ["watcherKey", "name", "state"]) && PRIVATE_KEY.test(w.watcherKey) && actorName(w.name) && ["pending", "watching"].includes(w.state)) && (value.enabled || value.watchers.length === 0);
}
export function validRunFacts(value) {
	if (value === null) return true;
	return exactKeys(value, ["id", "outcome", "project", "target", "flow", "endedAt"]) &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id ?? "") && Object.hasOwn(RUN_OUTCOME_WORDS, value.outcome) &&
		(value.project === null || /^[a-z0-9][a-z0-9-]{0,31}$/.test(value.project ?? "")) &&
		(value.target === null || typeof value.target === "string" && /^[A-Za-z0-9._:/#! -]{1,300}$/.test(value.target)) &&
		(value.flow === null || /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(value.flow ?? "")) &&
		(value.endedAt === null || typeof value.endedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.endedAt) && Number.isFinite(Date.parse(value.endedAt)) && new Date(Date.parse(value.endedAt)).toISOString() === value.endedAt);
}
export function workspaceConnection(value) {
	return value && PUBLIC_ID.test(value.connectionId ?? "") && PRIVATE_KEY.test(value.sessionKey ?? "") && PRIVATE_KEY.test(value.targetKey ?? "") && PRIVATE_KEY.test(value.ownerKey ?? "") && ["drive", "watch"].includes(value.kind) && typeof value.host === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.host) && typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id) && actorName(value.by) && Number.isSafeInteger(value.idleMinutes) && value.idleMinutes >= 0 && validRunFacts(value.runFacts) && (value.runFacts === null || value.runFacts.id === value.id) && (value.theme === null || ["light", "dark"].includes(value.theme)) && (value.kind === "drive" || exactKeys(value.driver, ["name", "ownerKey"]) && actorName(value.driver.name) && PRIVATE_KEY.test(value.driver.ownerKey) && validGeometry(value.geometry));
}
// The authenticated watch winner hashes its unique, never-rebound connection. Store dedup already
// binds that winner to its exact driver owner and epoch; matching only a target or driver is insufficient.
export function duplicateConnection(value, controllers) {
	if (!["drive", "watch"].includes(value?.kind) || !PRIVATE_KEY.test(value.targetKey ?? "") || !PRIVATE_KEY.test(value.ownerKey ?? "")) return null;
	return [...controllers].find(c => c.ready && !c.ended && c.connection.kind === value.kind && c.connection.targetKey === value.targetKey && c.connection.ownerKey === value.ownerKey) ?? null;
}
