import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SANDBOX_DRAW, SANDBOX_HOSTS_FIXTURE } from "./helpers/sandbox-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { buildSandboxOpenUrl, parseSandboxOpenUrl } from "@edgehero/pi-dispatch/opener-protocol";
import { sandboxCommand } from "@edgehero/pi-dispatch/sandbox-hosts";
import { outLink } from "../src/console/kit.mjs";
import { SANDBOX_CSS } from "../src/console/sandbox-css.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { PAGE_CSS, pageCss } from "../src/console/page-css.mjs";
import { chromeLaunchArgs } from "../../.github/scripts/console-width-check.mjs";

test("both console browser checks keep the local Chrome sandbox and use the established CI startup flags without bypassing document security", () => {
  assert.deepEqual(chromeLaunchArgs(), ["--use-mock-keychain"]);
  assert.deepEqual(chromeLaunchArgs({ sandbox: true }), ["--use-mock-keychain"]);
  assert.deepEqual(chromeLaunchArgs({ sandbox: false }), ["--use-mock-keychain", "--no-sandbox"]);
  for (const sandbox of [true, false]) assert.equal(chromeLaunchArgs({ sandbox }).some((arg) => /disable-web-security|disable-features.*ContentSecurityPolicy|bypass.*csp/i.test(arg)), false);
});

test("the screen's Open and Attach links carry the exact host/id/verb; copied commands use that host's saved deployment", async () => {
  const markup = await SANDBOX_DRAW["sandboxes-populated.operator"]();
  const links = [...markup.matchAll(/href="(pi-dispatch-open:[^"]+)"/g)].map((m) => parseSandboxOpenUrl(m[1].replaceAll("&amp;", "&")));
  assert.ok(links.some((l) => l.verb === "open" && l.id === "gh-9575" && l.host === "mini1"));
  assert.ok(links.some((l) => l.verb === "attach" && l.id === "gh-9575" && l.host === "mini1"));
  assert.ok(links.some((l) => l.id === "gh-ebd7" && l.host === "build3"));
  const cmd = sandboxCommand(SANDBOX_HOSTS_FIXTURE, { verb: "open", id: "gh-ebd7", host: "build3" });
  assert.equal(cmd.argv[3], "pdjob@build3");
  assert.match(cmd.argv[4], /--deployment.*\/home\/pdjob\/pi.*--expected-host.*build3/);
  assert.match(markup, /pdjob@build3/);
  assert.doesNotMatch(markup, /how idle|idle since|opener import/);
  const commandLines = [...markup.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  assert.ok(commandLines.includes("pi-dispatch sandbox --new acme/web --ref HEAD --as 2"), "copied --as is the selected zero-based index (trigger row 3)");
});

test("opener exception is narrow, canonical and only an anchor; hostile variants still fail both kit and page guard", async () => {
  const base = await SANDBOX_DRAW["sandboxes-populated.operator"]();
  assertClean("sandboxes.operator", base);
  for (const uri of ["pi-dispatch-open://exec/id?host=mini1", "pi-dispatch-open://open/..%2Fbad?host=mini1", "pi-dispatch-open://open/id?host=bad%3Bcmd", "pi-dispatch-open://open/id?host=mini1&command=sh", "javascript:alert(1)"]) {
    assert.throws(() => outLink({ href: uri, label: "open" }));
    assert.throws(() => assertClean("sandboxes.operator", base.replace(/pi-dispatch-open:[^"]+/, uri)));
  }
  const valid = buildSandboxOpenUrl({ verb: "open", id: "gh-9575", host: "mini1" });
  assert.throws(() => assertClean("sandboxes.operator", base.replace("</main>", `<img src="${valid}" alt=""></main>`)));
  assert.throws(() => assertClean("sandboxes.operator", base.replace("</main>", "<p>/home/private/outside-command</p></main>")));
  assert.throws(() => assertClean("sandboxes.viewer", base));
});

test("read-only operators keep terminal commands, but no server write forms; viewers cannot read any workspace state", async () => {
  const readonly = await SANDBOX_DRAW["sandboxes-readonly.operator"]();
  assert.doesNotMatch(readonly, /data-action=/); assert.match(readonly, /pi-dispatch-open:/);
  const viewer = await SANDBOX_DRAW["sandboxes-denied.viewer"]();
  for (const secret of ["gh-9575", "pi-dispatch-open:", "sandbox-hosts.json", "ops@mini1", "nodePath", "nonce"]) assert.equal(viewer.includes(secret), false, secret);
});

test("host-derived windows are shown dynamically, failed reads stay unknown, unsupported venues never offer a shell", async () => {
  const filled = await SANDBOX_DRAW["sandboxes-populated.operator"]();
  assert.match(filled, /Kept for 24 hours/);
  const stale = await SANDBOX_DRAW["sandboxes-stale.operator"]();
  assert.match(stale, /publication stale/); assert.match(stale, /128 more retained/); assert.match(stale, /Open shells could not be read/);
  assert.match(stale, /1 shown/); assert.doesNotMatch(stale, />1 open</);
  const partial = await SANDBOX_DRAW["sandboxes-cleanup-notices.operator"]();
  assert.match(partial, /1 shown/); assert.match(partial, /incomplete/); assert.doesNotMatch(partial, />1 open</);
  const unsupported = await SANDBOX_DRAW["sandboxes-unsupported.operator"]();
  const run = unsupported.split('id="p-sb-run" data-panel>')[1].split('</section>')[0];
  assert.doesNotMatch(run, /pi-dispatch-open:/); assert.match(run, /no sandbox shell/);
});

test("the published card's entire page CSS is served with a page scope, and every README bullet has a ledger entry", () => {
  const preview = readFileSync(new URL("../../design/system/components/SandboxesScreen/preview.html", import.meta.url), "utf8");
  const css = /<style>([\s\S]*?)<\/style>/.exec(preview)[1].trim();
  assert.ok(SANDBOX_CSS.includes(css)); assert.equal(PAGE_CSS.sandboxes, SANDBOX_CSS);
  assert.match(pageCss(), /body\[data-page="sandboxes"\]/);
  const runPreview = readFileSync(new URL("../../design/system/components/RunEnded/preview.html", import.meta.url), "utf8");
  for (const rule of [".facts, .facts--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }", ".fact { grid-template-columns: minmax(0, min(128px, 40%)) minmax(0, 1fr); }"]) {
    assert.ok(css.includes(rule)); assert.ok(runPreview.includes(rule)); assert.ok(PAGE_CSS.run.includes(rule));
  }
  const readme = readFileSync(new URL("../../design/system/components/SandboxesScreen/README.md", import.meta.url), "utf8");
  const ledger = JSON.parse(readFileSync(new URL("./fixtures/console-ledger/SandboxesScreen.json", import.meta.url)));
  for (const bullet of readme.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))) assert.ok(ledger.elements.some((e) => e.el === bullet), bullet);
});

test("the console route table documents the sandbox path and its actual operator-only guard", () => {
  const docs = readFileSync(new URL("../../docs/console.md", import.meta.url), "utf8");
  const row = docs.split("\n").find((line) => line.startsWith(`| \`${PAGES.sandboxes.path}\` |`));
  assert.equal(PAGES.sandboxes.auth, "operator"); assert.ok(row); assert.match(row, /Operators only/);
});
