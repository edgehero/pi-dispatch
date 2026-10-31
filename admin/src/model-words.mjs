/** Fixed model-policy sentences shared by Models and Run; provider response text never enters either (#773). */
import { MODEL_WHY, providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import { splitModelEntry } from "@edgehero/pi-dispatch/model-ref";

const FAILURE_WORDS = Object.freeze({
  "rate-limited": "rate limited",
  "quota-exhausted": "quota exhausted",
  overloaded: "provider overloaded",
  "context-overflow": "context window exceeded",
});
export function providerFailureWords(kind) { return Object.hasOwn(FAILURE_WORDS, kind) ? FAILURE_WORDS[kind] : null; }

export function providerFailureSentence(value) {
  const failure = providerFailureOf(value);
  if (!failure) return null;
  return ({
    "rate-limited": "The provider rate limited this model.",
    "quota-exhausted": "The provider's quota was exhausted.",
    overloaded: "The provider was overloaded.",
    "context-overflow": "The request exceeded the model's context window.",
  })[failure.kind] ?? null;
}

export function modelChoiceSentence(record) {
  if (!MODEL_WHY.includes(record?.modelWhy)) return null;
  const ref = `${record?.provider}/${record?.model}`;
  if (!splitModelEntry(ref)) return null;
  const role = typeof record.modelRole === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(record.modelRole) ? ` for role ${record.modelRole}` : "";
  if (record.modelWhy === "primary") return `This run used ${ref} as its primary model${role}.`;
  const reason = ({
    "fallback-cooldown": "the primary model was cooling down",
    "fallback-window": "the primary model's dollar window had no room",
    "fallback-unavailable": "an earlier candidate was unavailable",
    "fallback-context": "this attempt needed a larger context window",
  })[record.modelWhy];
  return `This run used fallback ${ref}${role} because ${reason}.`;
}
