/**
 * What a package's name and exact version may look like. Their own module because the run record validates them too, and `run-history.mjs` must not reach `packages.mjs`,
 * whose import of `import-pi.mjs` reaches `config.mjs`: the admin loads the record module inside pi (issue #499's review).
 */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** An npm package name: lowercase, optionally `@scope/`-prefixed. */
export const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
