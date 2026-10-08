/**
 * The worker name rule (issue #57), in a module with NO imports, so a pure reader (the capacity report, issue #599) can
 * hold a record's `host` to it without loading config.mjs and its fs and os. `config.mjs` re-exports the name.
 */

/**
 * What a worker may call itself (issue #57). The CHARACTER CLASS is `sanitizeJobId`'s
 * (`[A-Za-z0-9._-]`), reused rather than invented so this project has one name-safe alphabet -- but that
 * function is a REPLACER, not a validator, so the three rules around the class are NEW and are claimed
 * as new here rather than borrowed:
 *
 *   - a leading alphanumeric, which is what refuses `..` and a leading `-` that reads as a flag;
 *   - a 64-character ceiling, because the name is a Valkey key segment and a log field on every line;
 *   - no `.json`/`.log` tail, which is not decoration. The class contains the dot, so `prod.json` is
 *     otherwise a legal name -- and a later slice writes a per-host marker file into `PI_LOGS_DIR`,
 *     where `<something>.json` is parsed as a run record by the admin and DELETED by the log reaper.
 *     A name is refused here rather than escaped there, because the escape would have to be remembered
 *     at every site that ever composes a filename from this value.
 *
 * The class is `:`-free, `,`-free and `#`-free, which is what lets the name be a Valkey key segment
 * UNHASHED. That is the point of validating instead of hashing (`scopeKeyPrefix` does the opposite for
 * a folder path, which was never chosen for key-safety and cannot be refused): the whole value of a host
 * registry is that `HGETALL host:h:mac-mini-1` is readable by a human.
 */
export const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
