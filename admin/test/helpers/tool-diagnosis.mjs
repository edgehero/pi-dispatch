/** Preserve exact planner diagnosis assertions while also checking it was kept out of model context. */
import assert from "node:assert/strict";
import { MODEL_TOOL_REFUSAL } from "../../src/tool-refusals.mjs";
export function withOperatorDiagnosis(tool) {
  return { ...tool, async execute(...args) {
    const ctx = args[4];
    if (ctx?.hasUI !== true || !ctx.ui) return tool.execute(...args);
    const notes = [];
    const notify = ctx.ui.notify;
    ctx.ui.notify = (message, level) => { notes.push(String(message)); return notify?.(message, level); };
    try { return await tool.execute(...args); }
    catch (error) {
      if (error.message !== MODEL_TOOL_REFUSAL) throw error;
      assert.equal(notes.length, 1, "a private planner diagnosis goes only to the local operator");
      assert.notEqual(notes[0], MODEL_TOOL_REFUSAL, "the original diagnosis is preserved for the person");
      // The caller's exact diagnostic assertion concerns what the person was told, after this helper
      // has independently asserted the actual model error was the fixed public refusal.
      throw new Error(notes[0]);
    } finally { if (notify === undefined) delete ctx.ui.notify; else ctx.ui.notify = notify; }
  } };
}
