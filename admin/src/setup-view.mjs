/** #774: safe setup facts and evidence-derived progress. No host execution belongs in this reader. */
import { firstRunState, FIRST_RUN_STATES, doctorHostsOf, doctorStale } from "./doctor-view.mjs";
import { SETUP_OPERATIONS, SETUP_REASONS } from "@edgehero/pi-dispatch/setup-contract";

export const SETUP_ACTIONS = Object.freeze([...SETUP_OPERATIONS, "setup-viewer-add", "setup-viewer-revoke"]);
export const SETUP_PROGRESS_STATES = Object.freeze({
  starting: ["running", "Starting"], applied: ["ok", "Applied"], failed: ["failed", "Failed"],
  partial: ["attention", "Partly applied"], unknown: ["attention", "Outcome unknown"], timeout: ["attention", "Timed out"], refused: ["attention", "Refused"],
});
export const SETUP_PROGRESS_STAGES = Object.freeze({
  planned: "The operation was planned.", dispatched: "The host accepted the operation.",
  "unit-written": "Wrote the service unit.", "start-accepted": "The service manager accepted the start.",
  "waiting-heartbeat": "Waiting for a fresh heartbeat.", complete: "The host operation finished. Published evidence decides readiness.",
});
export const SETUP_UNAVAILABLE = "Host setup is not granted to this console. Run pi-dispatch service install --console --host-setup on the deployment host, or use the terminal commands below.";
export const SETUP_REASON_TEXT = Object.freeze(Object.fromEntries(SETUP_REASONS.map(reason => [reason, ({
  unsupported: "This platform or service manager does not support browser setup. Use the host terminal.",
  "manager-unavailable": "The local user service manager is unavailable. Check the host user session, then use the terminal command.",
  "unsafe-entry": "The worker entry is not a verified durable installation. Install the exact packages in the deployment first.",
  "remote-runtime": "The runtime is not proven local. Use the worker host's terminal.",
  "foreign-service": "This service belongs to another deployment. Inspect its owner in the host terminal.",
  "process-timeout": "The host operation timed out. Inspect its effects before retrying.",
  "readback-unavailable": "The host outcome could not be confirmed. Inspect the host before retrying.",
  "provider-managed": "This provider has a managed subscription binding. Review Connections; an API key must not replace it.",
  "missing-receiver": "Install the receiver package on the host before starting its service.",
})[reason] ?? `Host setup reports ${reason}. Inspect the host with pi-dispatch doctor before retrying.`])));

/** Rebuild known fields, rather than trusting an executor result or copying its diagnostics into a page. */
export function setupFacts(raw, { role = "viewer" } = {}) {
  const enabled = raw?.enabled === true;
  const suppliedReason = raw?.reasonCode ?? raw?.reason;
  const reasonCode = SETUP_REASONS.includes(suppliedReason) ? suppliedReason : null;
  const actions = role === "operator" && enabled && Array.isArray(raw?.actions) ? raw.actions.filter(action => SETUP_ACTIONS.includes(action)) : [];
  const progress = (Array.isArray(raw?.progress) ? raw.progress : []).slice(-16).flatMap(item => {
    if (!Object.hasOwn(SETUP_PROGRESS_STATES, item?.state) || !["worker", "receiver", "egress", "provider", "token", "forge", "doctor"].includes(item?.step)) return [];
    return [{ step: item.step, state: item.state, stage: Object.hasOwn(SETUP_PROGRESS_STAGES, item.stage) ? item.stage : null,
      atMs: Number.isSafeInteger(item.atMs) && item.atMs >= 0 ? item.atMs : null,
      reason: Object.hasOwn(SETUP_REASON_TEXT, item.reason) ? item.reason : null }];
  });
  return {
    enabled, reasonCode, reason: enabled ? null : reasonCode === null ? SETUP_UNAVAILABLE : SETUP_REASON_TEXT[reasonCode], actions,
    providerKey: role === "operator" && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw?.providerKey ?? "") ? raw.providerKey : null,
    allowlistCount: Number.isSafeInteger(raw?.allowlistCount) && raw.allowlistCount >= 0 ? raw.allowlistCount : null,
    progress,
  };
}

/** A direct setup page survives the overview's first-run predicate and refuses to promote uncertain observations. */
export function setupState(snapshot, { role = "viewer", deployment = null, facts = null, now = 0 } = {}) {
  const safe = setupFacts(facts, { role });
  const state = firstRunState(snapshot, { session: { role }, deployment });
  const doctorRows = doctorHostsOf(snapshot);
  const incomplete = snapshot?.doctor?.unreachable || snapshot?.doctor?.partial || (snapshot?.doctor?.more ?? 0) > 0 || doctorRows.some(row => row.unreadable || doctorStale(row) || !Number.isSafeInteger(row.ageMs));
  const steps = state.steps.map(step => {
    let next = { ...step };
    if (incomplete && ["egress", "provider", "forge"].includes(step.id) && step.state === "ready") next = { ...step, state: "check", sentence: ["Published doctor observations are incomplete or stale. Run doctor on the host before treating this step as ready."] };
    const progress = safe.progress.filter(item => item.step === step.id).at(-1);
    if (progress && progress.state === "starting") {
      const timedOut = progress.atMs !== null && now - progress.atMs > 90_000;
      next = { ...next, state: timedOut ? "check" : "starting", sentence: [timedOut ? "The readiness wait timed out. Inspect the service and run doctor; a successful start alone does not prove readiness." : SETUP_PROGRESS_STAGES[progress.stage] ?? "The host operation is starting. Waiting for published readiness evidence."] };
    }
    if (progress?.state === "timeout") next = { ...next, state: "check", sentence: ["The readiness wait timed out. Inspect the host and run doctor before treating this step as ready."] };
    return { ...next, progress };
  });
  return { ...state, ready: steps.filter(step => step.state === "ready").length, steps, facts: safe };
}

export const SETUP_STATES = Object.freeze({ ...FIRST_RUN_STATES, starting: Object.freeze({ word: "Starting", status: "running" }) });
