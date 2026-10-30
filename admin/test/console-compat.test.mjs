import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { PAGES, renderPage } from "../src/console/pages.mjs";

// The last page migration removes the adapter, rather than leaving two stylesystems for future pages.
test("all console pages use Pulse without the compatibility adapter", async () => {
  assert.equal(existsSync(new URL("../src/console/compat-css.mjs", import.meta.url)), false);
  assert.doesNotMatch(CONSOLE_CSS, /--pd-|\.legacy(?:[ >:{.]|$)/);
  for (const name of Object.keys(PAGES)) {
    const out = await renderPage(name, { query: {}, session: { name: "operator", role: "operator" }, data: { now: 0, snapshot: {} } });
    assert.doesNotMatch(String(out.html), /class="legacy"|--pd-/);
  }
  for (const name of readdirSync(new URL("./fixtures/console/", import.meta.url)).filter((n) => n.endsWith(".html"))) {
    assert.doesNotMatch(readFileSync(new URL(`./fixtures/console/${name}`, import.meta.url), "utf8"), /class="legacy"|--pd-/, name);
  }
});
