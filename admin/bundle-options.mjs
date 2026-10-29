/** Bundled CommonJS dependencies still need Node's builtin modules when the output is ESM. */
export const NODE_REQUIRE_PRELUDE = 'import { createRequire as __dispatchCreateRequire } from "node:module";\nconst require = __dispatchCreateRequire(import.meta.url);';

export const NODE_BUNDLE_OPTIONS = Object.freeze({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
});
