import assert from "node:assert/strict";
import { test } from "node:test";
import * as panels from "../src/console/panels/connections.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { consoleConnectionsFixture } from "./helpers/configuration-goldens.mjs";

const AT = Date.UTC(2026, 9, 30, 12);
const draw = (name, value, options = {}) => String(panels[name]({ role: "operator", data: { connections: value }, ...options }));
function row(markup, name, tag = "tr") {
  const doc = cardDocument(markup);
  const hit = doc.nodes.find((node) => node.tag === tag && cardText(doc.within(node)).startsWith(name));
  assert.ok(hit, `${name}: a complete row`);
  return doc.within(hit);
}
function marked(markup, word, glyph, tone) {
  const doc = cardDocument(markup);
  const hit = doc.nodes.find((node) => node.classes.includes("cn-state") && cardText(doc.within(node)) === word);
  assert.ok(hit, `${word}: a labelled state`);
  assert.ok(hit.classes.includes(`tone-${tone}`), `${word}: its semantic tone`);
  assert.ok(doc.descendants(hit).some((node) => node.tag === "use" && node.attrs.href === `#i-${glyph}`), `${word}: its glyph is in the same state as its word`);
}

test("armed but unstartable GitHub leads with a qualified receiver refusal and no invented host link", async () => {
  const facts = await consoleConnectionsFixture(AT, { change: (_, reads) => { reads.environment = () => ({ env: { GITHUB_AUTH_SOURCE: "gh" } }); } });
  assert.equal(facts.problems[0].kind, "receiver");
  const banner = draw("connectionsProblems", facts);
  assert.match(cardText(banner), /WEBHOOK_SECRET is not set in the deployment's \.env.*unless its service environment sets it/);
  assert.doesNotMatch(banner, /\/fleet\/host|\/run\?|name=null/);
  const github = row(draw("connectionsForges", facts), "github");
  marked(github, "armed by trigger 3", "done", "ok");
  marked(github, "not set", "failed", "attention");
  const doc = cardDocument(github);
  const cells = doc.nodes.filter((node) => node.tag === "td");
  const webhook = doc.within(cells.find((node) => node.attrs["data-l"] === "Webhook"));
  const stack = cardDocument(webhook);
  const detail = stack.nodes.find((node) => node.tag === "small");
  assert.ok(detail, "route and deduplication have their own muted line");
  assert.equal(cardText(stack.within(detail)), "path / · duplicates by X-GitHub-Delivery");
  assert.match(cardText(webhook), /HMAC-SHA256, WEBHOOK_SECRET not set/);
});

test("forge configuration unknown and not-configured remain distinct non-colour states", async () => {
  const known = await consoleConnectionsFixture(AT);
  marked(row(draw("connectionsForges", known), "forgejo"), "not configured", "minus", "idle");
  const unread = await consoleConnectionsFixture(AT, { unread: true });
  const github = row(draw("connectionsForges", unread), "github");
  marked(github, "configuration unknown", "info", "attention");
  marked(github, "unknown", "info", "attention");
  assert.doesNotMatch(cardText(github), /not configured|not set|60 s/);
});

test("polling prints an interval only for a configured poller, never for off or unknown", async () => {
  for (const [env, expected, interval] of [
    [{ GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "private-value" }, "off", null],
    [{ GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "private-value", POLL_REPOS: "acme/web", POLL_INTERVAL_SECONDS: "45" }, "on", 45],
    [{ GITHUB_AUTH_SOURCE: "app", WEBHOOK_SECRET: "private-value" }, "on", 60],
  ]) {
    const facts = await consoleConnectionsFixture(AT, { change: (_, reads) => { reads.environment = () => ({ env }); } });
    const github = row(draw("connectionsForges", facts), "github");
    marked(github, expected, expected === "on" ? "done" : "minus", expected === "on" ? "ok" : "idle");
    if (interval === null) assert.doesNotMatch(cardText(github), /\d+ s|interval/);
    else assert.match(cardText(github), new RegExp(`${interval} s`));
    assert.doesNotMatch(github, /private-value/);
  }
});

test("proxy rows carry concise glyph-word states and stale evidence stays separate from running", async () => {
  const facts = await consoleConnectionsFixture(AT);
  facts.egress.hosts = [
    { name: "running", proxy: { level: "ok" }, at: AT - 60_000, ageMs: 60_000, stale: false },
    { name: "missing", proxy: { level: "fail", label: "diagnostic detail belongs in the banner" }, at: AT - 48 * 3_600_000, ageMs: 48 * 3_600_000, stale: true },
    { name: "unread", unreadable: true, at: null, ageMs: null, stale: true },
    { name: "absent", proxy: null, at: AT, ageMs: 0, stale: false },
  ];
  const result = draw("connectionsEgress", facts);
  marked(row(result, "running"), "running", "done", "ok");
  marked(row(result, "missing"), "missing", "failed", "failed");
  marked(row(result, "missing"), "stale", "attention", "attention");
  marked(row(result, "unread"), "unavailable", "info", "attention");
  marked(row(result, "absent"), "not published", "minus", "idle");
  assert.equal(cardText(result).match(/No proxy check can mean/g).length, 1);
  assert.doesNotMatch(result, /diagnostic detail belongs/);
  assert.match(result, /href="https:\/\/github\.com\/edgehero\/pi-dispatch\/blob\/[^\"]+\/docs\/egress\.md"[^>]+rel="noreferrer noopener"/);
  assert.doesNotMatch(cardText(result), /HTTPS tunnels|leading dot covers|Bundle endpoints never widen|Jobs cannot reach another job/);
  facts.egress.on = false;
  marked(draw("connectionsEgress", facts), "off: jobs reach what their host reaches (PI_EGRESS=0)", "minus", "idle");
  facts.egress.on = null;
  marked(draw("connectionsEgress", facts), "unknown", "info", "attention");
});

test("Model endpoints links to the permanent provider-key card without duplicating credential source claims", async () => {
  const facts = await consoleConnectionsFixture(AT);
  const result = draw("connectionsEndpoints", facts);
  assert.match(result, /href="#p-provider-keys"/);
  assert.doesNotMatch(result, /ANTHROPIC_API_KEY|Provider keys, by name|pi login on each host/);
});

test("Notifications uses two icon rows and short hook configuration, with timing and payload details in the docs", async () => {
  const facts = await consoleConnectionsFixture(AT);
  const result = draw("connectionsNotify", facts);
  const doc = cardDocument(result);
  const list = doc.nodes.find((node) => node.classes.includes("cn-icon-list"));
  const items = doc.descendants(list).filter((node) => node.tag === "li");
  assert.equal(items.length, 2);
  assert.match(doc.within(items[0]), /href="#i-comment"/);
  assert.match(cardText(doc.within(items[0])), /Forge comments: on; trigger 3 also keeps a status comment up to date\./);
  assert.match(doc.within(items[1]), /href="#i-bell"/);
  assert.equal(cardText(doc.within(items[1])), "Failure hook: PI_ON_FAILURE → .../notify , once per paid failure.");
  assert.match(cardText(result), /no hook run published/);
  assert.match(cardText(result), /An exit code describes the hook, not notification delivery/);
  assert.doesNotMatch(result, /\/srv\/hooks|does not run for completions|Two things reach people|10 s|timeout|job, outcome, reason, host/);
  const unknown = { ...facts, notify: { ...facts.notify, unknown: true } };
  marked(draw("connectionsNotify", unknown), "configuration unknown", "info", "attention");
});

test("compact MCP rows retain each server's transport, address, exposure and non-colour state without definition blocks", async () => {
  const facts = await consoleConnectionsFixture(AT);
  facts.mcp.servers.push({ name: "docs", transport: "stdio", where: "npx docs-mcp", exposure: "deferred", enabled: false, refs: ["DOCS_KEY", "LINEAR_API_KEY"] });
  const result = draw("connectionsMcp", facts);
  const linear = row(result, "linear", "li");
  assert.match(cardText(linear), /^linear http · mcp\.example\.com codemode on$/);
  marked(linear, "on", "done", "ok");
  const docs = row(result, "docs", "li");
  assert.match(cardText(docs), /^docs stdio · npx docs-mcp deferred off$/);
  marked(docs, "off", "minus", "idle");
  const refused = row(result, "dispatch-notes", "li");
  assert.match(refused, /tone-failed/);
  assert.match(refused, /href="#i-failed"/);
  assert.match(cardText(refused), /refused, a name holding dispatch is reserved/);
  assert.match(cardText(result), /References LINEAR_API_KEY, DOCS_KEY \./);
  assert.equal(cardText(result).match(/LINEAR_API_KEY/g).length, 1, "shared references are not repeated into every server's block");
  assert.doesNotMatch(result, /<dl|<dt|cn-mcp-row|\$\{|Bearer/);
  marked(draw("connectionsMcp", { ...facts, mcp: null }), "overlay MCP file unavailable", "info", "attention");
});

test("phone stack rows retain all labelled forge, proxy and endpoint facts together", async () => {
  const facts = await consoleConnectionsFixture(AT);
  for (const [panel, name, labels, content] of [
    ["connectionsForges", "github", ["Forge", "State", "Auth", "Webhook", "Polling", "Who may fire"], /GitHub App.*WEBHOOK_SECRET.*X-GitHub-Delivery.*60 s.*write access/],
    ["connectionsEgress", "build3", ["Host", "Proxy", "Checked"], /build3 running.*2026-10-30/],
    ["connectionsEndpoints", "ollama-mini2", ["Endpoint", "Host and port", "Key", "Slots in use"], /ollama-mini2 mini2\.lan:11434 keyless 1 of 2/],
  ]) {
    const result = draw(panel, facts);
    const html = row(result, name);
    const doc = cardDocument(html);
    assert.deepEqual(doc.nodes.filter((node) => node.tag === "td").map((node) => node.attrs["data-l"]), labels);
    assert.match(cardText(html), content);
    assert.match(result, /class="tbl tbl--stack"/);
  }
});

test("environment disagreement and an unread staged manifest carry glyphs and actionable words", async () => {
  const facts = await consoleConnectionsFixture(AT);
  facts.environment = [{ key: "PI_CONCURRENCY", value: "4", disagrees: true }];
  marked(draw("connectionsEnvironment", facts), "this shell and the .env differ; the service reads the .env", "attention", "attention");
  facts.packages = null;
  marked(draw("connectionsPackages", facts), "staged-package manifest unavailable", "info", "attention");
  marked(draw("connectionsForges", null), "connection facts unavailable", "info", "attention");
});

test("many armed triggers retain each accessible numbered link without repeating the label or narrowing Polling", async () => {
  const facts = await consoleConnectionsFixture(AT, { change: (s) => { s.triggers.triggers.push(...Array.from({ length: 12 }, (_, n) => ({ index: n + 4, forge: "github", type: "comment" }))); } });
  const github = row(draw("connectionsForges", facts), "github");
  const doc = cardDocument(github);
  const state = doc.nodes.find((node) => node.classes.includes("cn-state"));
  const links = doc.descendants(state).filter((node) => node.tag === "a");
  const indexes = facts.forges.find((forge) => forge.name === "github").triggers;
  assert.deepEqual(links.map((link) => [link.attrs.href, link.attrs["aria-label"], cardText(doc.within(link))]), indexes.map((index) => [`/config/trigger?index=${index}`, `Trigger ${index + 1}`, String(index + 1)]));
  assert.match(cardText(doc.within(state)), /^armed by triggers /);
  const poll = doc.nodes.find((node) => node.tag === "td" && node.attrs["data-l"] === "Polling");
  assert.ok(poll.classes.includes("wide"), "the detailed polling fact keeps the full phone row when State lists many triggers");
  assert.match(cardText(doc.within(poll)), /on.*60 s.*App installation repositories/);
});
