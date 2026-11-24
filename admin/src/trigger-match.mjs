/**
 * Which run records are a trigger's: one rule, for every page that counts a trigger's runs (issue #988). `/triggers`,
 * a trigger's own page and a project's page each had a rule of their own, and counted one history three ways: a
 * project's page took a record's row number alone, a trigger's page the row number and the type, and `/triggers` the
 * row number, the type and the forge.
 *
 * A record needs the persisted raw index AND kind/type, or the cron id (`cronRunOf`, any id length: a record is this
 * deployment's own history), or a local event's own identity. A shared flow alone is never attribution, and neither is
 * a row number alone: rows are renumbered when one is added or deleted before them.
 */
import { cronRunOf } from "@edgehero/pi-dispatch/bullmq-internals";

export function recordMatchesTrigger(record, trigger) {
  if (trigger.type === "cron") {
    const run = cronRunOf(record?.jobId);
    return record?.kind === "local" && run !== null && run.id === trigger.id;
  }
  if (trigger.runKind === "local") return record?.kind === "local" && record?.localEvent?.id === trigger.id && record?.localEvent?.forge === trigger.forge && record?.localEvent?.type === trigger.type && record?.localEvent?.digest === trigger.localEventDigest;
  return Number.isSafeInteger(record?.triggerIndex) && record.triggerIndex === trigger.index && record.triggerType === trigger.type && record.kind === trigger.forge;
}
