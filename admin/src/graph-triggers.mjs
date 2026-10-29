/** Strict graph input (#749): never draw a partial trigger set the worker would refuse as a whole. */
import * as nodeFs from "node:fs";
import { basename, isAbsolute } from "node:path";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { readTriggers } from "./read-model.mjs";

/**
 * Keep the display reader's shape and raw indices, but validate the very same bytes with the worker's loader.
 * Reading twice would let an edit pass one parser and draw another file. Full paths are a caller's effective
 * operator permission, never the raw query. Invalid JSON omits the parser's context, which can quote secret refs.
 */
export function readGraphTriggers({ triggersPath, fs = nodeFs, fullPaths = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(triggersPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "read failed";
    return { invalid: `triggers file could not be read (${code})` };
  }
  const view = readTriggers({ triggersPath, fs: { readFileSync: () => text } });
  const label = fullPaths ? triggersPath : basename(triggersPath ?? "triggers.json");
  try {
    parseTriggers(text, label);
    return view;
  } catch (error) {
    if (view.invalid === "triggers file is not valid JSON") return { invalid: `${view.invalid}: ${label}` };
    let message = error instanceof Error ? error.message : `triggers file could not be validated: ${label}`;
    if (!fullPaths) message = message.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
      let value;
      try { value = JSON.parse(quoted); } catch { return quoted; }
      if (typeof value !== "string" || !isAbsolute(value.trim())) return quoted;
      // Loader explanations may quote a bad skillsDir; its value is a host path too, not just the file label.
      const leading = value.match(/^\s*/)[0];
      const trailing = value.match(/\s*$/)[0];
      return JSON.stringify(leading + basename(value.trim()) + trailing);
    });
    return { invalid: message };
  }
}
