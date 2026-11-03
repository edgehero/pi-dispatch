/** Test-only TLS fronts use the actual application handlers; no system/browser trust store is changed (#754). */
import { createServer } from "node:https";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);
export const TLS_CONSOLE_HOST = "console.gateway-browser.test";
export const TLS_GATEWAY_HOST = "sandbox.other-browser.test";
export const TLS_UNTRUSTED_HOST = "untrusted.certificate-browser.test";
export async function gatewayTestCertificate(dir, names) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem"), config = join(dir, "openssl.cnf");
  writeFileSync(config, `[req]\ndistinguished_name=subject\nx509_extensions=extensions\nprompt=no\n[subject]\nCN=${names[0]}\n[extensions]\nsubjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\n`, { mode: 0o600 });
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { timeout: 30000 });
  chmodSync(key, 0o600);
  const certificate = readFileSync(cert), privateKey = readFileSync(key);
  const parsed = new X509Certificate(certificate);
  for (const name of names) if (parsed.checkHost(name) !== name) throw new Error("test certificate hostname mismatch");
  return { key: privateKey, cert: certificate, spki: createHash("sha256").update(createPublicKey(certificate).export({ type: "spki", format: "der" })).digest("base64") };
}
export async function gatewayTlsFront(inner, port, certificate) {
  const sockets = new Set();
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => inner.emit("request", req, res));
  if (inner.listenerCount("upgrade")) server.on("upgrade", (req, socket, head) => inner.emit("upgrade", req, socket, head));
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // A browser that drops a frozen page's socket resets it. In this test-only front that is an ordinary event, and an
  // unhandled "error" on the TLS socket would kill the whole run. Production terminates TLS in its own proxy.
  server.on("secureConnection", (socket) => { socket.on("error", () => {}); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
