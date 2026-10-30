/** Console presentation only: raw plans and optimistic-write inputs never pass through this projection (#751). */
export function resolverPathShown(path) {
  if (typeof path !== "string" || path === "") return "(path unknown)";
  const last = path.split(/[\\/]/).filter(Boolean).at(-1);
  return last ? `…/${last}` : "(root folder)";
}

/**
 * Replace exact known paths, longest first, including JSON's spelling of Windows separators. A path may hold spaces,
 * commas or quotes, so a token-shaped regular expression is not a redaction boundary. The caller gathers the raw
 * resolver/root paths and their real paths before it builds a response; only this display string is returned.
 */
export function resolverTextShown(text, paths = []) {
  const replacements = new Map();
  for (const path of new Set(paths.filter((p) => typeof p === "string" && p !== ""))) {
    const shown = resolverPathShown(path);
    replacements.set(path, shown);
    const json = JSON.stringify(path).slice(1, -1);
    if (json !== path) replacements.set(json, JSON.stringify(shown).slice(1, -1));
  }
  if (!replacements.size) return String(text);
  const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // One pass: a root such as /opt must not be found again inside a basename this very projection just produced.
  return String(text).replace(new RegExp(pattern, "g"), (raw) => replacements.get(raw));
}
