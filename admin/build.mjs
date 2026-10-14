/**
 * Bundle the operator extension into a single self-contained `dist/index.mjs` for publishing as a pi-package.
 *
 * The admin extension imports ~10 `@edgehero/pi-dispatch` subpaths (the worker workspace); esbuild INLINES those
 * local `.mjs` files so the published package has no worker dependency — the admin tarball stands alone even
 * though the worker is now published too (a devDependency, resolved through the workspace symlink at build
 * time and never declared at runtime). The pi runtime is
 * host-provided (a peerDependency) and `bullmq`/`ioredis` are heavy real deps kept EXTERNAL and declared in
 * package.json; everything else — the admin's own files, the inlined worker internals, and `typebox` — is
 * bundled in. `import.meta.url` is preserved (esm), so the extension's `../skills` resolution still points at
 * the shipped `skills/` dir (dist/ and skills/ sit side by side in the published tarball).
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [join(here, "src/index.ts")],
	outfile: join(here, "dist/index.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	// Host-provided peer + heavy runtime deps stay external (declared in package.json). typebox is bundled.
	external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
	banner: { js: "// pi-dispatch operator extension (bundled). Source: https://github.com/edgehero/pi-dispatch" },
	logLevel: "info",
});

console.log("[built admin/dist/index.mjs]");

// The operator console's command (issue #640), a second program from the same sources: `pi-dispatch-console`, the
// package's `bin`. Same bundling rule as the extension (worker internals inlined, the heavy deps external, so the
// published tarball still needs nothing it does not declare); the pi runtime stays external too, though the console
// never imports it, so a stray transitive import fails loudly at load rather than bundling pi. The banner is the
// shebang npm's bin shim needs; esbuild keeps it as the file's first line.
await build({
	entryPoints: [join(here, "src/console/cli.mjs")],
	outfile: join(here, "dist/console.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
	banner: { js: "#!/usr/bin/env node\n// pi-dispatch operator console (bundled). Source: https://github.com/edgehero/pi-dispatch" },
	logLevel: "info",
});

console.log("[built admin/dist/console.mjs]");
