import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES, returnPathOf } from "../src/console/pages.mjs";
import { CONSOLE_SCRIPT, RETRY_MS } from "../src/console/script.mjs";
import { loginCodePage } from "../src/console/shell.mjs";
import { runConsoleScript, trapGlobalFetch } from "./helpers/script-dom.mjs";

// Issue #708: a sign-in link may name the page to land on (`login/code#<code>&next=/runs`). The value comes from a link
// anyone could have written, so it must never send the browser anywhere but this console's own pages.

test("returnPathOf accepts the console's own pages with a query their parser takes, and nothing else", () => {
  for (const ok of ["/", "/runs", "/fleet", "/config", "/parked", "/audit", "/insights?range=mtd", "/run?id=repeat:t1:1760000000000"]) assert.equal(returnPathOf(ok), ok, ok);
  const refused = [
    "//evil.example", "//evil.example/runs", "https://evil.example/", "javascript:alert(1)", "/\\evil.example", "\\\\evil.example",
    "/login", "/login/code", "/static/console.js", "/api/whoami", "/healthz", "/nope", "runs", "",
    "/runs?evil=1", "/run", "/run?id=<x>", "/insights?range=1y", "/fleet?x=1", "/runs#frag", "/runs\n", "/r\u0000uns",
    "/" + "a".repeat(2000), null, 7, {},
  ];
  for (const bad of refused) assert.equal(returnPathOf(bad), null, JSON.stringify(bad));
});

/** Run the console script on a fake login-code page with fragment `hash`; the server answers `answer`. */
async function signIn(hash, answer) {
  const posted = [];
  const replaced = [];
  const el = () => ({ addEventListener() {}, textContent: "", getAttribute: () => null, querySelectorAll: () => [] });
  const document = {
    body: { getAttribute: (k) => (k === "data-page" ? "login-code" : null) },
    getElementById: (id) => (id === "notice" ? el() : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  const location = { hash, pathname: "/login/code", replace: (u) => replaced.push(u), assign: (u) => replaced.push(u) };
  const history = { replaceState: () => (location.hash = "") };
  const fetch = async (path, init) => {
    posted.push([path, JSON.parse(init.body)]);
    return { ok: true, status: 200, json: async () => answer };
  };
  new Function("document", "location", "history", "fetch", "URLSearchParams", "window", CONSOLE_SCRIPT)(document, location, history, fetch, URLSearchParams, {});
  for (let i = 0; i < 10 && replaced.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  return { posted, replaced };
}

test("the script posts the code and next, and lands only where both the server and its own check agree", async () => {
  const code = "k".repeat(43);
  const plain = await signIn(`#${code}`, { ok: true, next: "/" });
  assert.deepEqual(plain.posted, [["/login/code", { code }]], "no next: only the code");
  assert.deepEqual(plain.replaced, ["/"]);

  const runs = await signIn(`#${code}&next=/runs`, { ok: true, next: "/runs" });
  assert.deepEqual(runs.posted[0][1], { code, next: "/runs" });
  assert.deepEqual(runs.replaced, ["/runs"]);

  const run = await signIn(`#${code}&next=/run?id=gh-1`, { ok: true, next: "/run?id=gh-1" });
  assert.deepEqual(run.posted[0][1].next, "/run?id=gh-1");
  assert.deepEqual(run.replaced, ["/run?id=gh-1"]);

  // Whatever the server answered, a destination off this console's pages is the overview.
  for (const evil of ["//evil.example", "https://evil.example/", "/\\evil.example", "/login", "/nope", "/runs#x", 7, null]) {
    const r = await signIn(`#${code}&next=/runs`, { ok: true, next: evil });
    assert.deepEqual(r.replaced, ["/"], JSON.stringify(evil));
  }
});

test("a link that is refused never navigates, and one that reaches nothing posts the same code and next again and still lands only on the console's own pages", () => trapGlobalFetch(async () => {
  const code = "k".repeat(43);
  // The server's own link page, with the script's states (issue #737): refused, the used state, and no navigation.
  const refused = runConsoleScript(CONSOLE_SCRIPT, String(loginCodePage()), { url: `/login/code#${code}&next=/runs` });
  await refused.fetch.open("/login/code").answer(401, { error: "this sign-in link is used, expired or unknown" });
  assert.deepEqual([refused.location.replaced, refused.location.assigned], [[], []]);
  assert.deepEqual(refused.document.querySelectorAll("[data-link-state]").filter((n) => !n.hidden).map((n) => n.getAttribute("data-link-state")), ["used"]);
  // No answer: the same code and next, 2 s later, and whatever the answer names, only one of PAGES' paths.
  const far = runConsoleScript(CONSOLE_SCRIPT, String(loginCodePage()), { url: `/login/code#${code}&next=//evil.example` });
  await far.fetch.open("/login/code").fail();
  assert.deepEqual(far.location.replaced, [], "no answer is no navigation");
  far.tick(RETRY_MS);
  assert.deepEqual(far.fetch.calls.map((c) => c.body), [{ code, next: "//evil.example" }, { code, next: "//evil.example" }]);
  await far.fetch.open("/login/code").answer(200, { ok: true, next: "//evil.example" });
  assert.deepEqual(far.location.replaced, ["/"]);
}));

test("the script's page list is PAGES' paths, so the two checks name the same pages", () => {
  assert.ok(CONSOLE_SCRIPT.includes(`var PAGE_PATHS = ${JSON.stringify(Object.values(PAGES).map((p) => p.path))};`));
});
