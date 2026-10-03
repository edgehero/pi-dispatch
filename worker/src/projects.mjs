/**
 * Projects (issue #499, INT-PROJECTS-FILE-CONTRACT): a named group of repos and folders. One `projects.json` of
 * `{ version: 1, projects: [{ id, name?, members }] }`. A job whose scope is a member belongs to that project, and the
 * project's id is written into the job's run record (`project`), so spend can later be read and capped per project.
 *
 * This module is pure and fs-injectable, on the scoped-limits.mjs pattern: `parseProjects` validates the file TEXT
 * fail-loud, `loadProjects` layers the one fs read on top, and `projectOf` is what the pickup gate and the record path
 * consume. The worker holds the parsed list in a watched ref with a last-good copy (start.mjs).
 *
 * `version` is REQUIRED and a newer one is refused: which project a scope belongs to decides which cap applies to it
 * (issue #499 part B), so this is a money file, and a field an old build silently drops could widen a cap.
 *
 * `name` is display text for the panel. It never enters a record or a log line: the record carries the `id`, which is
 * charset-checked, and so stays free of personal data by construction. For the same reason no error message here
 * quotes a name, and an invalid-JSON error does not quote the parser's message, which carries file text.
 *
 * Custom: projects validated inline per scoped-limits.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { configError } from "./config.mjs";
import { parseScopeString, qualifiedScopeOf } from "./pause-windows.mjs";
import { canonicalScope } from "./scoped-limits.mjs";

/** The highest schema version this build reads. A file declaring a higher one is refused loudly. */
export const PROJECTS_VERSION = 1;

/**
 * A project id: lowercase, 1 to 32 characters, free of `:`, `#` and `/`, so it can enter a run record and a Valkey key
 * without escaping. The run record checks a `project` against this same pattern (`isProjectId`).
 */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The longest `name` accepted, in UTF-16 code units. A display label, not a document. */
const NAME_MAX = 120;

/** Is this a well-formed project id? The record path's charset check. */
export function isProjectId(value) {
	return typeof value === "string" && PROJECT_ID_RE.test(value);
}

/**
 * Parse, validate and normalize the projects file TEXT. Returns the normalized list: each project rebuilt as an
 * explicit `{ id, name, members }` literal (`name` null when absent, members in their stored spelling, unknown fields
 * dropped by the operator-file policy). Throws `configError` on anything malformed. `path` is for messages only.
 *
 * Members use the scope grammar of `parseScopeString` (issue #498):
 *   - a forge-qualified scope (`github:acme/web`), stored as `<kind>:<repo>`;
 *   - an absolute folder (`/srv/shop-tools`), stored resolved, the spelling `canonicalScope` gives a local job.
 * A bare `owner/name` is refused: it names that repo on every forge, and this file has no legacy to keep. A relative
 * folder, a drive path on a host where it is not absolute, `*` and globs are refused too: each would be a member no
 * job's scope can ever equal.
 *
 * Refused across the file: a duplicate id, a scope claimed by two projects (both ids named, one project per scope),
 * a scope listed twice in one project, and an empty `members`.
 */
export function parseProjects(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// Not the parser's own message: it quotes the file's text around the fault, and that text may be a `name`.
		const at = /position (\d+)/.exec(String(error?.message))?.[1];
		throw configError(`projects file is not valid JSON${at === undefined ? "" : ` (at character ${at})`}: ${path}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`projects file must be an object with "version" and "projects": ${path}`);
	}
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) {
		throw configError(`projects file must have "version": ${PROJECTS_VERSION} (an integer >= 1): ${path}`);
	}
	if (version > PROJECTS_VERSION) {
		throw configError(`projects file written by a newer pi-dispatch (version ${version}; this build understands ${PROJECTS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.projects)) throw configError(`projects file must have a "projects" array: ${path}`);
	const projects = parsed.projects.map((entry, index) => normalizeProject(entry, index, path));
	const ids = new Map();
	const owners = new Map();
	projects.forEach((project, index) => {
		if (ids.has(project.id)) {
			throw configError(`project at index ${index}: duplicate id "${project.id}" (first at index ${ids.get(project.id)}): ${path}`);
		}
		ids.set(project.id, index);
		for (const member of project.members) {
			const owner = owners.get(member);
			// One project per scope: a job in two projects would have two project ledgers and an unclear refusal.
			if (owner !== undefined) {
				throw configError(`project at index ${index}: ${JSON.stringify(member)} is claimed by both "${owner}" and "${project.id}" (a scope belongs to one project): ${path}`);
			}
			owners.set(member, project.id);
		}
	});
	return projects;
}

function normalizeProject(entry, index, path) {
	const at = `project at index ${index}`;
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw configError(`${at}: must be an object: ${path}`);
	if (!isProjectId(entry.id)) {
		throw configError(`${at}: id must match ${PROJECT_ID_RE.source} (lowercase letters, digits and "-", 1 to 32 characters, starting with a letter or digit): ${path}`);
	}
	const id = entry.id;
	let name = null;
	if (entry.name !== undefined && entry.name !== null) {
		// The name's own text is never echoed: it is free text, and this message can reach a log line.
		if (typeof entry.name !== "string" || entry.name.trim() === "" || entry.name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(entry.name)) {
			throw configError(`${at} ("${id}"): name, when given, must be a string of 1 to ${NAME_MAX} characters with no control characters: ${path}`);
		}
		name = entry.name.trim();
	}
	if (!Array.isArray(entry.members) || entry.members.length === 0) {
		throw configError(`${at} ("${id}"): members must be a non-empty array of scopes (github:owner/name or an absolute folder): ${path}`);
	}
	const members = [];
	entry.members.forEach((raw, m) => {
		const member = normalizeMember(raw, `${at} ("${id}") member ${m}`, path);
		if (members.includes(member)) throw configError(`${at} ("${id}") member ${m}: ${JSON.stringify(member)} is listed twice: ${path}`);
		members.push(member);
	});
	return { id, name, members };
}

/** One member, in its stored spelling, or the refusal naming where it sits. */
function normalizeMember(raw, at, path) {
	if (typeof raw !== "string" || raw.trim() === "") throw configError(`${at}: must be a non-empty string: ${path}`);
	const trimmed = raw.trim().normalize("NFC");
	if (trimmed.includes("*")) throw configError(`${at}: members match exactly; a scope containing "*" is refused (no globs): ${path}`);
	let form;
	try {
		form = parseScopeString(trimmed);
	} catch (error) {
		throw configError(`${at}: ${error.message}: ${path}`);
	}
	if (form.type === "qualified") return `${form.kind}:${form.repo}`;
	if (form.type === "bare") {
		throw configError(`${at}: ${JSON.stringify(trimmed)} is a bare repo, which names that repo on every forge; write it with its forge, such as github:${trimmed}, or give an absolute folder: ${path}`);
	}
	// `local`: platform-native isAbsolute, so a drive path on a POSIX host is refused rather than kept as a member no
	// job here can have (scoped limits keep such a row verbatim and inert; a new file need not).
	if (!isAbsolute(trimmed)) throw configError(`${at}: ${JSON.stringify(trimmed)} is not an absolute path on this host: ${path}`);
	return resolve(trimmed);
}

/**
 * Load and validate the projects file named by `config.projectsFile`. Returns `[]` when it is unset (no projects, a
 * valid deployment). An empty string is a value, so it reaches `existsSync` and is refused, as the scoped-limits key's
 * is. `readFileSync`/`existsSync` are injectable for tests.
 */
export function loadProjects(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.projectsFile;
	if (path === null || path === undefined) return [];
	if (!existsSync(path)) throw configError(`projects file does not exist: ${path}`);
	return parseProjects(readFileSync(path, "utf8"), path);
}

/**
 * The id of the project this job belongs to, or null. `job` is job data (`kind`, `repo`, `folder`). A forge job is
 * matched by its forge-qualified scope (`github:acme/web`), never by its bare repo, so a GitHub job and a Forgejo job
 * for `acme/web` can sit in different projects. A local job is matched by its resolved folder (`canonicalScope`), the
 * spelling a member is stored in, so `/srv/shop-tools/` matches the member `/srv/shop-tools`.
 */
export function projectOf(job, projects) {
	if (!Array.isArray(projects) || projects.length === 0) return null;
	const scope = job?.kind === "local" ? canonicalScope(job) : qualifiedScopeOf(job);
	if (typeof scope !== "string" || scope === "") return null;
	for (const project of projects) {
		if (Array.isArray(project?.members) && project.members.includes(scope)) return project.id;
	}
	return null;
}
