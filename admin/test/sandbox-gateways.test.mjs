import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readSandboxGateways, validateSandboxGateways } from "../src/sandbox-gateways.mjs";

const registry = () => ({ version: 1, consoleOrigin: "http://localhost:4790", hosts: { mini1: { origin: "http://127.0.0.1:4791" } } });
test("gateway enrollment separates hostname cookies, not merely origins or ports", () => {
  assert.deepEqual(validateSandboxGateways(registry()), registry());
  const duplicated = registry(); duplicated.hosts.second = { origin: "http://127.0.0.1:4792" };
  assert.throws(() => validateSandboxGateways(duplicated), /own hostname/);
  for (const origin of ["http://localhost:4791", "http://localhost:4790", "https://localhost:4791"]) {
    const input = registry(); input.hosts.mini1.origin = origin;
    assert.throws(() => validateSandboxGateways(input), /hostnames/);
  }
  for (const origin of ["http://remote.example", "https://u:p@remote.example", "https://remote.example/path", "https://remote.example#proof", "https://remote.example?token=x", "https://remote.example.", "https://host.docker.internal", "https://gateway.docker.internal", "https://host.containers.internal"]) {
    const input = registry(); input.hosts.mini1.origin = origin;
    assert.throws(() => validateSandboxGateways(input), /origin|canonical|HTTPS/);
  }
});
test("enrollment is hand-owned, strict and absent by default", () => {
  const dir = tempDir("gateway-enrollment-"), path = join(dir, "sandbox-gateways.json");
  assert.deepEqual(readSandboxGateways(path), { disabled: true });
  writeFileSync(path, JSON.stringify(registry()), { mode: 0o600 });
  const good = readSandboxGateways(path);
  assert.deepEqual(good.config, registry()); assert.match(good.digest, /^[a-f0-9]{64}$/);
  writeFileSync(path, JSON.stringify({ ...registry(), enabled: true }));
  assert.ok(readSandboxGateways(path).refusal);
  writeFileSync(path, JSON.stringify(registry())); chmodSync(path, 0o666);
  if (process.platform !== "win32") assert.ok(readSandboxGateways(path).refusal);
  chmodSync(path, 0o600);
  const link = join(dir, "alias.json");
  symlinkSync(path, link); assert.ok(readSandboxGateways(link).refusal);
  const mutated = registry(); mutated.hosts.mini1.socket = "/var/run/docker.sock";
  assert.throws(() => validateSandboxGateways(mutated), /origin only/);
});
