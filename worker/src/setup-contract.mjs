/** Data-only wire vocabulary for the explicitly granted local setup child (#774). */
export const SETUP_VERSION = 1;
export const SETUP_LIMITS = Object.freeze({ inputBytes: 64 * 1024, outputBytes: 256 * 1024, keyBytes: 4096, serviceMs: 60_000, doctorMs: 120_000, killGraceMs: 2000, readinessMs: 90_000 });
export const SETUP_OPERATIONS = Object.freeze(["setup-worker-install", "setup-worker-start", "setup-worker-stop", "setup-worker-restart", "setup-receiver-install", "setup-receiver-start", "setup-receiver-stop", "setup-receiver-restart", "setup-egress-start", "setup-doctor", "setup-provider-key"]);
export const SETUP_STATES = Object.freeze(["planned", "unchanged", "applied", "refused", "partial", "unknown"]);
export const SETUP_REASONS = Object.freeze(["ready", "invalid-request", "unsupported", "unavailable", "unsafe-deployment", "unsafe-entry", "foreign-service", "missing-service", "missing-receiver", "service-exists", "manager-unavailable", "unsafe-dependencies", "plan-stale", "setup-busy", "process-failed", "process-timeout", "readback-unavailable", "already-running", "egress-off", "gateway-egress", "remote-runtime", "unsafe-proxy", "proxy-refresh-required", "provider-unsupported", "provider-shadowed", "provider-managed", "key-present", "key-invalid", "env-unsafe", "doctor-incomplete", "doctor-published"]);
export const SETUP_EFFECTS = Object.freeze(["write-worker-unit", "write-receiver-unit", "start-worker", "start-receiver", "stop-worker", "stop-receiver", "restart-worker", "restart-receiver", "write-stack-files", "start-valkey", "start-proxy", "start-keeper", "write-provider-key", "publish-doctor"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const short = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function validSetupRequest(value) {
	if (!keys(value, ["version", "id", "phase", "operation", "expected", "input"]) || value.version !== SETUP_VERSION || !/^[a-f0-9]{32}$/.test(value.id ?? "") || !["plan", "apply", "status"].includes(value.phase) || !SETUP_OPERATIONS.includes(value.operation)) return false;
	if (value.expected !== undefined && !/^[a-f0-9]{64}$/.test(value.expected)) return false;
	if (value.phase === "apply" && value.expected === undefined) return false;
	if (value.input !== undefined && (!keys(value.input, ["provider", "key", "value"]) || Object.entries(value.input).some(([key, v]) => typeof v !== "string" || (key !== "value" && !short(v))))) return false;
	if (value.operation !== "setup-provider-key" && value.input !== undefined && Object.keys(value.input).length > 0) return false;
	if (value.phase !== "apply" && value.input?.value !== undefined) return false;
	return true;
}
export function validSetupResult(value) {
	if (!keys(value, ["version", "id", "operation", "state", "reason", "plan", "effects"]) || value.version !== SETUP_VERSION || !/^[a-f0-9]{32}$/.test(value.id ?? "") || !SETUP_OPERATIONS.includes(value.operation) || !SETUP_STATES.includes(value.state) || !SETUP_REASONS.includes(value.reason)) return false;
	const effects = (list) => Array.isArray(list) && list.length <= SETUP_EFFECTS.length && new Set(list).size === list.length && list.every((v) => SETUP_EFFECTS.includes(v));
	if (value.effects !== undefined && !effects(value.effects)) return false;
	if (value.plan !== undefined) {
		const p = value.plan;
		if (!keys(p, ["digest", "component", "manager", "host", "workerName", "account", "effects", "key", "provider"]) || !/^[a-f0-9]{64}$/.test(p.digest ?? "") || !["worker", "receiver", "egress", "doctor", "provider"].includes(p.component) || !["systemd", "launchd"].includes(p.manager) || !short(p.host, 64) || !short(p.account, 64) || !effects(p.effects)) return false;
		const component = value.operation === "setup-provider-key" ? "provider" : value.operation === "setup-doctor" ? "doctor" : value.operation.split("-")[1];
		if (p.component !== component) return false;
		if (p.workerName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.workerName)) return false;
		if (p.key !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(p.key)) return false;
		if (p.provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.provider)) return false;
	}
	return value.state !== "planned" || value.plan !== undefined;
}
export { validSetupRequest as validateSetupRequest, validSetupResult as validateSetupResult };
