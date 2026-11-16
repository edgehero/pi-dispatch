import { randomUUID } from "node:crypto";

/** Mint only at enqueue: a reused public job id must not resurrect another logical run's selection. */
export function withModelSelectionGeneration(data, { nonce = randomUUID } = {}) {
	return data?.modelSelection === undefined ? data : { ...data, modelSelectionGeneration: nonce() };
}

export function modelSelectionGenerationValid(value) {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
