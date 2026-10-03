/**
 * The project id rule (issue #499, INT-PROJECTS-FILE-CONTRACT), in a module with NO imports. `run-history.mjs` checks a
 * record's `project` against it, and the admin loads run-history inside pi, so the record module must not drag the
 * projects parser's graph (config.mjs and its fs, os and child_process) in with it: the rule `model-ref.mjs` keeps for
 * the same reader. `projects.mjs` re-exports both names.
 */

/**
 * A project id: lowercase, 1 to 32 characters, free of `:`, `#` and `/`, so it can enter a run record and a Valkey key
 * without escaping.
 */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Is this a well-formed project id? The record path's charset check. */
export function isProjectId(value) {
	return typeof value === "string" && PROJECT_ID_RE.test(value);
}
