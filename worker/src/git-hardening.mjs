/**
 * The `-c` pairs that stop a hostile repository config executing code on the worker HOST, outside any
 * container. `materialize.mjs` states the intent in one line and it is the whole of it: no hooks, no
 * external filters, no pager.
 *
 * A LEAF that imports nothing, on `container-spec.mjs`'s precedent and for its reason. `materialize.mjs`
 * is the file three "keep in sync" comments already named as canonical, but it imports `flow-gate.mjs`
 * and `flow-gate.mjs` needs these flags too, so canonical-by-comment could not become
 * canonical-by-import without a cycle. The array moves here and the comments become imports.
 *
 * Seven sites carried this by hand and one of them -- `prepare-local.mjs` -- was missing
 * `core.fsmonitor`. Nothing was exploitable: its only command is `git rev-parse HEAD`, which does not
 * refresh the index, so the fsmonitor hook is never invoked, and the `.pi/` materialisation beside it
 * uses materialize's own hardened git. That is exactly the shape of a drift that survives review --
 * harmless in the copy that has it wrong, load-bearing in the six that have it right -- and it is why
 * this file exists rather than an eighth careful copy.
 *
 * `core.fsmonitor` is the one worth naming: it makes git run an operator-supplied command on any
 * index-refreshing read, and a local-folder job's agent can write `.git/config` inside `/workspace`, so
 * the value is attacker-controlled by construction on exactly the path that reads it.
 */
export const GIT_SAFE_CONFIG = Object.freeze(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);

/**
 * The whole prefix for a READ that must run no repository-supplied code. `-C <dir>` follows at the call
 * site, because two callers pass a `-C` and one (doctor's probe) supplies its own directory handling.
 *
 * Two constants rather than one: `prepare-github.mjs` INTERLEAVES its clone-specific locks
 * (`protocol.ext.allow`, an empty `credential.helper`) between the fsmonitor pair and `--no-pager`, so a
 * single flat prefix would not compose there and would force that file's argv to be reordered for the
 * convenience of this one.
 */
export const GIT_READ_FLAGS = Object.freeze([...GIT_SAFE_CONFIG, "--no-pager"]);

/**
 * The flags for every git spawned against the WORKSPACE CHECKPOINT STORE (issue #645). Unlike the two
 * constants above, which guard a read of a repository the worker cloned, the store is written while a
 * paid job is paused, from a tree the agent fully controls, so the prefix pins every knob that could make
 * git run a program, sign, prompt, or do background work in the middle of that window:
 *
 * - `protocol.ext.allow=never` and an empty `credential.helper`: the store only ever talks `file://`, and
 *   nothing it does may reach a helper or an `ext::` command.
 * - `commit.gpgSign`/`tag.gpgSign=false`: `gpg.program` is a command, and a signing default in some
 *   config would run it on the host.
 * - `gc.auto=0`, `maintenance.auto=false`: an auto-gc forked mid-snapshot holds the store's packs while
 *   the checkpointer repacks on its own schedule; two writers on one object store is the race to avoid.
 * - `core.protectNTFS`/`core.protectHFS=true`: git's own dotgit folding, on whatever the host is, so the
 *   store refuses the same names `checkpoint-paths.mjs` does.
 * - `transfer.fsckObjects`/`fetch.fsckObjects=true`: the base fetch is the one place objects arrive from
 *   outside; a malformed tree there (a `..` entry, a `.GIT`) is refused before it is ever stored.
 * - `core.untrackedCache=false`: the untracked cache is written into the index of whatever work tree git
 *   was pointed at; the one command given a work tree (`check-ignore`) must write nothing there.
 */
export const STORE_GIT_FLAGS = Object.freeze([
	...GIT_SAFE_CONFIG,
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"credential.helper=",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"tag.gpgSign=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
	"-c",
	"core.protectNTFS=true",
	"-c",
	"core.protectHFS=true",
	"-c",
	"transfer.fsckObjects=true",
	"-c",
	"fetch.fsckObjects=true",
	"-c",
	"core.untrackedCache=false",
	"--no-pager",
]);

/**
 * The environment for a store git, built FROM NOTHING rather than from `process.env`. A spread would carry
 * whatever the worker's own environment holds into git: `GIT_DIR`/`GIT_WORK_TREE` from a developer shell,
 * `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS` (every one of them a way to run a
 * program or read another repository), plus every secret the worker holds. A deny list would have to name
 * all of those and every one git adds later; an allow list of exactly what git needs cannot drift that way.
 *
 * `HOME` and `XDG_CONFIG_HOME` both point at an empty per-run directory, so neither `~/.gitconfig` nor
 * `$XDG_CONFIG_HOME/git/{config,attributes,ignore}` can exist; `GIT_CONFIG_GLOBAL=/dev/null` says the same
 * for the global file, and the two NOSYSTEM switches for the system ones. `GIT_OPTIONAL_LOCKS=0` keeps a
 * status-like read from writing an index; `GIT_NO_REPLACE_OBJECTS` stops a `refs/replace` ref swapping the
 * object a commit names; `GIT_PROTOCOL_FROM_USER=0` turns every "user"-policy protocol off by default (the
 * two `file://` fetches re-enable `file` explicitly, at their call sites). `LC_ALL=C` keeps any message we
 * match on in one language.
 */
// env-internal PATH: the worker's own search path, passed through so the store git finds its helpers (`git-upload-pack`).
export function storeGitEnv({ gitDir, home, path = process.env.PATH }) {
	// Empty and relative PATH entries are dropped: both resolve against the CWD, so a `git-upload-pack`
	// (or any helper git execs) found there would be whatever the directory git runs in happens to hold.
	const safePath = String(path ?? "")
		.split(":")
		.filter((entry) => entry.startsWith("/"))
		.join(":");
	return {
		PATH: safePath || "/usr/bin:/bin",
		HOME: home,
		XDG_CONFIG_HOME: home,
		GIT_DIR: gitDir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_PROTOCOL_FROM_USER: "0",
		LC_ALL: "C",
	};
}
