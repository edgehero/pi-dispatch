import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The oracle every width test in this workspace is held to, shared by `width.test.mjs` and its two
// siblings (issue #417 split the sweeps out, so that no one file runs longer than the per-file cap the
// test-count check allows).
/**
 * pi-tui's own `visibleWidth`, the oracle.
 *
 * Resolved from the pinned pi installation rather than declared as a dependency: `admin` does not depend on
 * pi-tui directly, it is `pi-coding-agent`'s dependency (wherever npm puts it: nested under pi up to 0.99.1's
 * shrinkwrap, at the top beside it since 1.0.1), and `CONST-PI-VERSION-PINNED` says to verify against the pinned
 * artifact rather than a range. A hard-coded path would break on the other layout.
 *
 * THE TWO RESOLVERS ARE BOTH NEEDED, and each fails where the other works:
 *   - `import.meta.resolve` finds pi itself. The CJS `require.resolve` does NOT: pi's export map carries no
 *     `require` condition, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED. This is why `dashboard.test.mjs:14`
 *     builds its own `createRequire` from `import.meta.resolve` rather than from a package.json URL.
 *   - `require.resolve` then finds the pi-tui pi's own lookup reaches, nested or not. `import.meta.resolve`
 *     cannot be given pi's entry as its parent without a flag, and from this file it would find whatever copy
 *     sits above `admin`, which is not a dependency of `admin`'s at all.
 * It returns the file PATH, and pi-tui is ESM, so the path is imported rather than required.
 */
export async function loadVisibleWidth() {
  return (await loadRenderer())?.visibleWidth ?? null;
}

/** The pinned renderer's module, or null: `visibleWidth` above, and `sliceByColumn` for the compositor's cut. */
export async function loadRenderer() {
  let pi;
  let entry;
  try {
    pi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    entry = pi.resolve("@earendil-works/pi-tui");
  } catch {
    return null;
  }
  // WHICH COPY, asserted rather than assumed, and asserted by CONTENT (issue #587). pi depends on pi-tui by a
  // RANGE, so a resolve that is not the lockfile's would answer any version in that range, and a hoisted layout
  // could put a different copy above this one. `CONST-PI-VERSION-PINNED` says to verify against the pinned
  // artifact, and an oracle measured against the wrong artifact is a table pinned to the wrong renderer. The file
  // the oracle and the panel's width table both come from is pinned by its hash rather than the package by its
  // version: a version literal went red on every pi bump whether the renderer moved or not. A mismatch THROWS,
  // naming the file, rather than returning null.
  const utils = join(dirname(entry), "utils.js");
  const actual = createHash("sha256").update(readFileSync(utils)).digest("hex");
  if (actual !== PI_TUI_UTILS_SHA256) {
    throw new Error(`pi-tui ${pi("@earendil-works/pi-tui/package.json").version}'s dist/utils.js changed (sha256 ${actual}): re-derive the panel's width table from its graphemeWidth and re-check the cutters against its sliceByColumn (admin/src/panel.mjs), then update PI_TUI_UTILS_SHA256`);
  }
  try {
    const tui = await import(pathToFileURL(entry).href);
    return typeof tui.visibleWidth === "function" && typeof tui.sliceByColumn === "function" ? tui : null;
  } catch {
    return null;
  }
}

/**
 * The sha256 of pinned pi-tui's `dist/utils.js`, where `visibleWidth`, `graphemeWidth` and `sliceByColumn` live.
 * Re-verified at 1.0.3: the width logic is byte-identical to 0.99.1's; the file gained `flattenLines` and
 * `sliceByColumn` now keeps an escape code that precedes the cut range ahead of one at its boundary.
 */
export const PI_TUI_UTILS_SHA256 = "6c187576b9a2f29b156a0f6cf140fdf6617a5606203db2769760a32a01f3d595";
