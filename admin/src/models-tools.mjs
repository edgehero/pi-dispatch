/** The model tool shares the page's bounded reader, then rebuilds its explicit machine projection (#773). */
import { createFleetReader } from "./read-model.mjs";
import { readModelsView, modelsForAgent } from "./models-view.mjs";

let testReads = {};
/** TEST ONLY: process-local I/O injection; no tool parameter can install a reader. */
export function setModelsToolReadsForTest(reads = {}) { testReads = reads; }

export async function readModelsTool({ paths, env = {}, deploymentDir = null, now = Date.now, reads = {} } = {}) {
  reads = { ...testReads, ...reads };
  const clock = typeof now === "function" ? now : () => now;
  const fleet = (reads.fleet ?? createFleetReader)(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: clock });
  try {
    const snapshot = await fleet.snapshot({ waiting: true });
    const view = await (reads.models ?? readModelsView)({ paths, env, deploymentDir, now: clock(), snapshot, fleet });
    return modelsForAgent(view);
  } finally { await fleet.dispose(); }
}
