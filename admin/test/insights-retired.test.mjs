import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The static insights export is retired (the insights move to the console): the operator console's `/insights` page is
 * the one analytics surface, and `/dispatch insights` prints its address. A retired name left in the code, an example
 * file or a doc is a promise nothing keeps: an operator who sets the old graph dir, opens the old file or follows a doc
 * to the old builder finds nothing and is told nothing. So no source, example or doc may name them.
 *
 * ALLOWED: a spec revision-history row (`| YYYY-MM-DD | ... |`). Those rows record what was true when they were
 * written, and rewriting history to pass a grep would lose exactly the record this repository keeps on purpose. Tests
 * are not scanned: a test may name a retired thing to prove it is gone (this one does).
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The export's names, and the graph dir it wrote into: `graphDir` (resolvePaths' key) also covers `defaultGraphDir`,
// the worker's export the admin resolved it with, but both are listed so a hit names the one left behind.
const RETIRED = Object.freeze(["insights.html", "PI_GRAPH_DIR", "buildInsightsHtml", "insightsCommand", "INSIGHTS_JS", "graphDir", "defaultGraphDir", "secureGraphRoot"]);
const TREES = ["admin/src", "admin/skills", "worker/src", "receiver/src", "image", "deploy", "worker/deploy", "docs", "launch", "specs", ".github"];
const FILES = ["README.md", "admin/README.md", "worker/README.md", "receiver/README.md", ".env.example", "worker/.env.example", "CLAUDE.md"];
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "fixtures", ".git"]);
const TEXT = /\.(?:mjs|js|cjs|ts|mts|md|json|ya?ml|sh|service|socket|timer|container|env|example|tape|txt|toml|conf)$|(?:^|\/)(?:Dockerfile|Containerfile)[^/]*$/;
const REVISION_ROW = /^\| \d{4}-\d{2}-\d{2} \|/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (TEXT.test(p)) out.push(p);
  }
  return out;
}

test("no source, example file or doc names the retired insights export (revision rows excepted)", () => {
  const files = [];
  for (const t of TREES) if (existsSync(join(ROOT, t))) walk(join(ROOT, t), files);
  for (const f of FILES) if (existsSync(join(ROOT, f))) files.push(join(ROOT, f));
  assert.ok(files.length > 200, `the scan reached the trees (${files.length} files)`);
  assert.ok(files.some((f) => f.endsWith("specs/requirements.md")) && files.some((f) => f.endsWith("admin/src/index.ts")), "including the specs and the panel");
  const hits = [];
  let rowsSeen = 0;
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const named = RETIRED.filter((w) => line.includes(w));
      if (named.length === 0) return;
      if (relative(ROOT, f).startsWith("specs/") && REVISION_ROW.test(line)) {
        rowsSeen += 1;
        return;
      }
      hits.push(`${relative(ROOT, f)}:${i + 1} names ${named.join(", ")}`);
    });
  }
  assert.deepEqual(hits, []);
  assert.ok(rowsSeen > 0, "the revision rows that record the export are still there, and were allowed, not missed");
});
