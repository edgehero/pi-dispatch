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
