import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readOverlayMcpView } from "../src/read-model.mjs";
import { readOverlayMcp } from "@edgehero/pi-dispatch/mcp-config";
import { modelConnections } from "../src/connections-view.mjs";
import { connectionsMcp } from "../src/console/panels/connections.mjs";
import { cardText } from "./helpers/card-structure.mjs";

test("real refused MCP declarations explain their distinct rules without diagnostic names or values", () => {
  const dir = tempDir("pd-751-mcp-problems-");
  const http = { url: "https://mcp.example.com/mcp", description: "A server" };
  const stdio = { command: "server", description: "A server" };
  const cases = {
    "http-header": [{ ...http, headers: { "X-HEADER_NAME_SENTINEL": "Bearer VALUE_SENTINEL" } }, "HTTP header credentials must use complete named references; literal header values are refused"],
    "header-name": [{ ...http, headers: { "HEADER_NAME_SENTINEL bad": "${MANAGER_VAR_SENTINEL}" } }, "an HTTP header name is invalid or reserved"],
    "env-value": [{ ...stdio, env: { MANAGER_VAR_SENTINEL: "VALUE_SENTINEL" } }, "stdio environment values must be complete named credential references; literal values are refused"],
    "env-name": [{ ...stdio, env: { "ENV_NAME_SENTINEL bad": "${MANAGER_VAR_SENTINEL}" } }, "an environment variable name is invalid or reserved"],
    "argument": [{ ...stdio, args: ["!ARGUMENT_SENTINEL /Users/ROOT_SENTINEL"] }, "stdio arguments may use complete named references; command execution and home-folder shorthand are refused"],
    "argument-list": [{ ...stdio, args: "ARGUMENT_SENTINEL" }, "stdio arguments must be a list of strings"],
    "url-shape": [{ ...http, url: "https:/mcp.example.com/URL_PATH_SENTINEL" }, "the HTTP URL must be a plain http or https URL, with a literal host, no fragment and only complete named references"],
    "url-query": [{ ...http, url: "https://mcp.example.com/mcp?QUERY_NAME_SENTINEL=VALUE_SENTINEL" }, "URL query values must be whole named credential references; literal query values are refused"],
    "url-host": [{ ...http, url: "https://${MANAGER_VAR_SENTINEL}.example.com/mcp" }, "the HTTP URL's host must be written literally; a credential reference cannot choose the egress host"],
    "url-user": [{ ...http, url: "https://PRIVATE_USER_SENTINEL:VALUE_SENTINEL@mcp.example.com/mcp" }, "the HTTP URL must not carry credentials; supply them through a named header reference"],
    "command": [{ ...stdio, command: "/Users/ROOT_SENTINEL/COMMAND_SENTINEL" }, "the stdio command must be an admitted image executable or a bare name on its PATH, without substitutions or home-folder shorthand"],
    "package-runner": [{ ...stdio, command: "npx" }, "a package runner fetches the server at job start; install it in the image or explicitly allow the package runner and its registry"],
    "unknown-field": [{ ...http, FIELD_NAME_SENTINEL: "VALUE_SENTINEL" }, "the server declaration contains a field this transport does not accept"],
    "transport": [{ ...http, type: "TRANSPORT_SENTINEL" }, "declare exactly one HTTP URL or stdio command, with a matching supported transport type"],
    "dispatcher": [{ ...http }, "a name holding `dispatch` is reserved for the dispatch admin"],
    "forge": [{ ...http }, "forge is reserved for the worker’s own forge server"],
  };
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(cases).map(([name, [entry]]) => [name, entry])) }));
  const parsed = readOverlayMcp(dir);
  assert.equal(parsed.refused.length, Object.keys(cases).length, "the worker itself refuses every counterexample");
  const view = readOverlayMcpView({ globalPiDir: dir });
  assert.equal(view.unreadable, null);
  assert.deepEqual(view.servers, []);
  assert.deepEqual(view.problems, Object.entries(cases).map(([name, [, problem]]) => ({ name, problem })));
  assert.deepEqual(view.refused, Object.keys(cases));
  assert.doesNotMatch(JSON.stringify(view), /SENTINEL|Bearer|\/Users\/|\$\{/);
  assert.ok(parsed.refused.some((r) => /SENTINEL/.test(r.problem)), "the control proves raw parser diagnostics would disclose source names or private URL text");
});

test("invalid path-shaped and secret-shaped MCP names become safe placeholders for people and counts for models", () => {
  const dir = tempDir("pd-751-mcp-names-");
  const entry = { url: "https://mcp.example.com/mcp", description: "A server" };
  const privatePath = "/Users/PRIVATE_SENTINEL/resolver";
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { [privatePath]: entry, MANAGER_VARIABLE_SENTINEL: entry, "dispatch-admin": entry } }));
  assert.deepEqual(readOverlayMcp(dir).refused.map((r) => r.name), [privatePath, "MANAGER_VARIABLE_SENTINEL", "dispatch-admin"], "the worker keeps the original invalid names, so display must project them");
  const view = readOverlayMcpView({ globalPiDir: dir });
  assert.equal(view.invalidNameCount, 2);
  assert.deepEqual(view.refused, ["invalid server name", "invalid server name", "dispatch-admin"]);
  assert.ok(view.problems.slice(0, 2).every((p) => p.problem.includes("lowercase letters and digits")));
  const page = String(connectionsMcp({ role: "operator", data: { connections: { mcp: view } } }));
  assert.match(cardText(page), /invalid server name: refused, the server name must use lowercase/);
  assert.match(cardText(page), /dispatch-admin: refused, a name holding/);
  const model = modelConnections({ mcp: view });
  assert.deepEqual(model.mcp.refused, ["dispatch-admin"]);
  assert.equal(model.mcp.invalidNameCount, 2);
  for (const output of [JSON.stringify(view), page, JSON.stringify(model)]) assert.doesNotMatch(output, /SENTINEL|\/Users\//);
  assert.ok(!Object.hasOwn(model.mcp, "problems"), "model output remains names and counts, without person-facing diagnostic text");
});
