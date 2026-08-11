import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Read a flow's AI-trigger opt-in from the git OBJECT STORE at a pinned commit.
 *
 * A flow is AI-triggerable only if `.pi/skills/<flow>/SKILL.md` at `sha` carries `ai-trigger: allow`
 * in its YAML frontmatter. `sha` is a REQUIRED input captured BEFORE the in-container agent runs, so
 * it is agent-uninfluenceable: an agent cannot self-authorize by committing its own `SKILL.md`,
 * because any `allow` it writes lands in a commit later than the pinned `sha` and is never consulted.
 * This module therefore resolves NO ref — no HEAD, no rev-parse, no ref primitive of any kind — the
 * caller supplies the SHA. (DES-AI-TRIGGER-FLOW-GATE, INT-OUTBOX-CONTRACT.)
 *
 * The read is object-store-only, mirroring materialize.mjs's blob-only discipline: enumerate the one
 * exact path with `git ls-tree` at `sha`, require a single regular blob (type `blob`, mode `100644`
 * — rejecting a 120000 symlink or 160000 gitlink), then `git cat-file blob <oid>`. The working tree
 * is never read, so a frontmatter symlinked at a token file cannot escape the tree.
 *
 * Fail-closed everywhere — only an exact `ai-trigger: allow` yields `allow`:
 *   - missing/empty `sha`                         -> deny  (never falls back to HEAD)
 *   - `flow` failing the skill charset            -> deny  (never interpolated; traversal choke)
 *   - SKILL.md absent at that path/sha            -> no-skill
 *   - entry present but non-blob / wrong mode     -> deny
 *   - unparseable / absent `---` frontmatter      -> deny
 *   - `ai-trigger` key absent                     -> deny
 *   - `ai-trigger` present but not exactly `allow`-> deny
 *   - git error / bad sha / binary failure        -> deny  (caught; this function never throws)
 */

// The skill name charset: lowercase kebab/underscore, 1-64 chars, no dots (so no "..") and no
// slashes. Validating `flow` against it BEFORE building any path is the traversal choke point: a
// bad name is denied, never interpolated into a git path. Exported as the single source of truth
// (issue #92): materialize.mjs imports it, and the admin's setup wizard lists a repo's .pi/skills
// through it — three keep-in-sync copies would drift exactly where a traversal guard cannot.
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export async function readFlowGate({ folder, flow, sha, git = defaultGit }) {
	// `sha` is REQUIRED and never defaulted: a missing SHA fails closed rather than resolving HEAD,
	// which would let a self-authored commit open the gate. See DES-AI-TRIGGER-FLOW-GATE.
	if (typeof sha !== "string" || sha.trim() === "") return { gate: "deny" };
	// Charset-guard `flow` BEFORE it reaches any git path (traversal choke point).
	if (typeof flow !== "string" || !SKILL_NAME_RE.test(flow)) return { gate: "deny" };

	const path = `.pi/skills/${flow}/SKILL.md`;
	try {
		const lsTreeZ = await git(folder, ["ls-tree", "-z", sha, path]);
		const record = lsTreeZ.split("\0").find((r) => r);
		if (!record) return { gate: "no-skill" }; // valid sha, path absent at that commit
		// "<mode> <type> <oid>\t<path>"
		const tab = record.indexOf("\t");
		if (tab === -1) return { gate: "deny" };
		const [mode, type, oid] = record.slice(0, tab).split(/\s+/);
		if (mode !== "100644" || type !== "blob") return { gate: "deny" }; // symlink/gitlink/exec
		const content = await git(folder, ["cat-file", "blob", oid], { raw: true });
		return { gate: aiTriggerAllows(content) ? "allow" : "deny" };
	} catch {
		// bad sha, git failure, binary error: fail closed, never crash the producer/collector.
		return { gate: "deny" };
	}
}

// Custom: no YAML parser in worker deps; a single ai-trigger boolean does not justify js-yaml.
// Strict leading-frontmatter scan: strip a BOM, normalise CRLF, isolate the leading `---`..`---`
// block, and require an exact `ai-trigger: allow` line (an optional surrounding double quote).
// Exported (issue #54) so the admin's skill enumeration answers "chainable?" with THIS scanner and
// not a keep-in-sync copy -- the SKILL_NAME_RE lesson one export up, applied to the frontmatter test.
export function aiTriggerAllows(buf) {
	const text = buf.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
	if (!block) return false; // no parseable frontmatter -> deny
	return /^ai-trigger:\s*("?)allow\1\s*$/m.test(block[1]);
}

async function defaultGit(gitDir, args, { raw = false } = {}) {
	// hardening flags mirror materialize.mjs defaultGit — keep in sync. No hooks, no fsmonitor, no
	// pager, so a hostile repo config cannot run code or corrupt output during a read.
	const hardened = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager", "-C", gitDir, ...args];
	const { stdout } = await exec("git", hardened, {
		encoding: raw ? "buffer" : "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}
