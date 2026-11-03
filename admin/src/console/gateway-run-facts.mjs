import { outcomeKey, recordReason } from "../words.mjs";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { validGatewayRunFacts } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const clean = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : null;

/** Rebuild the six permitted historical facts. A sandbox id is never evidence that a record belongs to it. */
export function gatewayRunFacts(target, record) {
  if (!target || !record || record.jobId !== target.id || record.host !== target.host || target.venue && (record.backend ?? "local") !== target.venue || !RUN_ID.test(record.jobId) || record.jobId.startsWith("sb-")) return null;
  const outcome = outcomeKey(record.outcome, recordReason(record));
  if (!outcome) return null;
  const facts = {
    id: record.jobId,
    outcome,
    project: clean(record.project, PROJECT_ID_RE),
    target: clean(record.target, /^[A-Za-z0-9._:/#! -]{1,300}$/),
    flow: clean(record.flow, SKILL_NAME_RE),
    endedAt: null,
  };
  // Date parsing repairs impossible calendar dates. Keep only the original canonical
  // timestamp accepted by the shared contract, rather than inventing historical facts.
  const withTime = { ...facts, endedAt: record.endedAt };
  return validGatewayRunFacts(withTime) ? withTime : facts;
}
