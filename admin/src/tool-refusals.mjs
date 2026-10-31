/** Only a producing code path can mark text as safe for model context; syntax is not provenance (#766). */
export const MODEL_TOOL_REFUSAL = "The dispatch action did not report success. An operator can inspect its current state and local diagnosis before trying again.";
export const MODEL_TOOL_READ_UNAVAILABLE = "Operational facts could not be read. An operator can inspect its local diagnosis or the console.";
const publicMessages = new WeakMap();
export function publicToolRefusal(message) {
  const error = new Error(message);
  publicMessages.set(error, message);
  return error;
}
export function modelToolRefusal(error) { return publicMessages.get(error) ?? MODEL_TOOL_REFUSAL; }

export function modelToolReadFailure(error) { return publicMessages.get(error) ?? MODEL_TOOL_READ_UNAVAILABLE; }
