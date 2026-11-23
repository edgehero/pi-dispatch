import { connect as netConnect, createServer } from "node:net";

/**
 * A TCP proxy in front of a real Valkey that RECORDS every command a client sends, by name and arguments: the wire
 * itself, for a test that holds a surface to sending reads only (issue #1036). A census of keys before and after sees
 * a write only when it leaves a key changed; a write that leaves none (an HSET of the fields already there, an SREM
 * of a member that is put back) is seen here and nowhere else.
 *
 * A SCRIPT IS RECORDED WITH ITS BODY. A client runs a script by its hash (EVALSHA) and sends the body only when the
 * server does not know the hash, so on a server that has seen the script before, the wire shows forty hex characters
 * and nothing of what the script does. The proxy overwrites the hash of every EVALSHA with zeros before it forwards
 * it: the server answers NOSCRIPT, in order, and the client falls back to EVAL with the body, as it does on a server
 * that was restarted. The EVAL is recorded with `script`, its body; the EVALSHA that led to it is not recorded.
 *
 * `commands` is the list so far, each `{ name, args, script? }`: `name` upper case, a two-word command joined
 * ("CLIENT SETINFO", "SCRIPT LOAD"), `args` as text (latin1, each cut at 200 characters, at most 8 kept). `take()`
 * returns the list and empties it. Requests are parsed as RESP arrays of bulk strings, which is what every client of
 * this repository sends; a connection that sends anything else is forwarded as it is and recorded as one command
 * named "UNPARSED", which no read set holds.
 */
export async function recordingProxy(target) {
  const to = new URL(target);
  const commands = [];
  const sockets = new Set();
  const TWO_WORD = new Set(["CLIENT", "SCRIPT", "CONFIG", "COMMAND", "OBJECT", "XINFO", "MEMORY", "FUNCTION", "ACL"]);
  const record = (parts) => {
    const text = parts.map((p) => p.toString("latin1"));
    const first = (text[0] ?? "").toUpperCase();
    const two = TWO_WORD.has(first) && text.length > 1;
    const name = two ? `${first} ${text[1].toUpperCase()}` : first;
    const args = text.slice(two ? 2 : 1);
    if (name === "EVALSHA") return;
    commands.push({ name, args: args.slice(0, 8).map((a) => (a.length > 200 ? `${a.slice(0, 200)}...` : a)), ...(name === "EVAL" ? { script: args[0] ?? "" } : {}) });
  };
  const server = createServer((client) => {
    const upstream = netConnect({ host: to.hostname, port: Number(to.port) });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
    }
    let pending = Buffer.alloc(0);
    let raw = false;
    client.on("data", (data) => {
      if (raw) return void upstream.write(data);
      pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
      // Every whole command at the head of `pending` is recorded and forwarded; a part of one waits for its rest.
      for (;;) {
        const parsed = parseCommand(pending);
        if (parsed === null) break;
        if (parsed === false) {
          commands.push({ name: "UNPARSED", args: [] });
          raw = true;
          upstream.write(pending);
          pending = Buffer.alloc(0);
          return;
        }
        const bytes = Buffer.from(pending.subarray(0, parsed.end));
        if (parsed.parts[0]?.toString("latin1").toUpperCase() === "EVALSHA" && parsed.spans[1]) bytes.fill(0x30, parsed.spans[1][0], parsed.spans[1][1]);
        record(parsed.parts);
        upstream.write(bytes);
        pending = pending.subarray(parsed.end);
      }
    });
    upstream.on("data", (data) => client.write(data));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const via = new URL(target);
  via.hostname = "127.0.0.1";
  via.port = String(server.address().port);
  return {
    url: via.toString(),
    commands,
    take: () => commands.splice(0, commands.length),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/**
 * One RESP command at the head of `buf`: `{ parts, spans, end }` (each bulk string, where its bytes lie, and where
 * the command ends), null when the buffer holds only part of one, false when it does not start an array of bulk
 * strings.
 */
function parseCommand(buf) {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x2a) return false;
  const lineEnd = (from) => buf.indexOf("\r\n", from, "latin1");
  let at = lineEnd(0);
  if (at === -1) return null;
  const count = Number(buf.toString("latin1", 1, at));
  if (!Number.isSafeInteger(count) || count < 0) return false;
  let pos = at + 2;
  const parts = [];
  const spans = [];
  for (let i = 0; i < count; i += 1) {
    if (pos >= buf.length) return null;
    if (buf[pos] !== 0x24) return false;
    at = lineEnd(pos);
    if (at === -1) return null;
    const length = Number(buf.toString("latin1", pos + 1, at));
    if (!Number.isSafeInteger(length) || length < 0) return false;
    const start = at + 2;
    if (start + length + 2 > buf.length) return null;
    parts.push(buf.subarray(start, start + length));
    spans.push([start, start + length]);
    pos = start + length + 2;
  }
  return { parts, spans, end: pos };
}

/**
 * The commands a Lua script's body calls, upper case, in the order they appear: `redis.call("X", ...)`,
 * `redis.pcall('x', ...)` and a call through a local alias of either (`local rcall = redis.call`, BullMQ's habit). A
 * call whose command is not a string literal is listed as "DYNAMIC", which no read set holds.
 */
export function scriptCommands(body) {
  const text = String(body);
  const aliases = ["redis\\.call", "redis\\.pcall", ...[...text.matchAll(/local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*redis\.p?call\b/g)].map((m) => m[1])];
  const out = [];
  for (const m of text.matchAll(new RegExp(`(?:${aliases.join("|")})\\s*\\(\\s*(?:"([A-Za-z]+)"|'([A-Za-z]+)'|([^"'\\s)]))`, "g"))) out.push((m[1] ?? m[2] ?? "DYNAMIC").toUpperCase());
  return out;
}
