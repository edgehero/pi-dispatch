import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The oracle every width test in this workspace is held to, shared by `width.test.mjs` and its two
// siblings (issue #417 split the sweeps out, so that no one file runs longer than the per-file cap the
// test-count check allows).
/**
 * pi-tui's own `visibleWidth`, the oracle.
 *
 * Resolved from the pinned pi installation rather than declared as a dependency: `admin` does not depend on
 * pi-tui directly, it is nested under `pi-coding-agent`, and `CONST-PI-VERSION-PINNED` says to verify
 * against the pinned artifact rather than a range. A hard-coded nested path would break on a flat install.
 *
 * THE TWO RESOLVERS ARE BOTH NEEDED, and each fails where the other works:
 *   - `import.meta.resolve` finds pi itself. The CJS `require.resolve` does NOT: pi's export map carries no
 *     `require` condition, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED. This is why `dashboard.test.mjs:14`
 *     builds its own `createRequire` from `import.meta.resolve` rather than from a package.json URL.
 *   - `require.resolve` then finds pi-tui NESTED under pi. `import.meta.resolve` with pi's entry as the
 *     parent does not, because the ESM resolver reads pi's own dependency graph rather than walking
 *     `node_modules` upward, and pi-tui is not one of `admin`'s dependencies.
 * It returns the file PATH, and pi-tui is ESM, so the path is imported rather than required.
 */
export async function loadVisibleWidth() {
  return (await loadRenderer())?.visibleWidth ?? null;
}

/** The pinned renderer's module, or null: `visibleWidth` above, and `sliceByColumn` for the compositor's cut. */
export async function loadRenderer() {
  try {
    const pi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const entry = pi.resolve("@earendil-works/pi-tui");
    // WHICH COPY, asserted rather than assumed. pi depends on pi-tui by a RANGE, so a resolve that is not
    // the lockfile's would answer any 0.80.x, and a hoisted layout could put a different copy above this
    // one. `CONST-PI-VERSION-PINNED` says to verify against the pinned artifact rather than a range, and
    // an oracle measured against the wrong artifact is a table pinned to the wrong renderer.
    const version = pi("@earendil-works/pi-tui/package.json").version;
    if (version !== PI_TUI_VERSION) return null;
    const tui = await import(pathToFileURL(entry).href);
    return typeof tui.visibleWidth === "function" && typeof tui.sliceByColumn === "function" ? tui : null;
  } catch {
    return null;
  }
}

/** The pin, from `package-lock.json`. A mismatch fails the tests below rather than measuring silently. */
export const PI_TUI_VERSION = "0.80.7";
