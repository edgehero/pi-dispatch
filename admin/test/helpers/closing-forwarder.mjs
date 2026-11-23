import { createServer } from "node:net";

/**
 * A loopback listener that takes every connection, keeps what it was sent and closes it: a TCP forwarder whose Valkey
 * is gone, as a client of `target` sees one. The connection is accepted, nothing is ever answered, and the socket ends
 * with no error. Each connection is closed `lingerMs` after it was taken, long enough for a client to write what it
 * sends on connect, so "no such command was sent" is read off bytes that would have held one. `url` is `target` with
 * this listener's address (its database and credentials kept, so the client greets as it would the real one),
 * `bytes()` everything every connection sent so far, as latin1 text in arrival order, and `connections()` how many
 * were taken.
 */
export async function closingForwarder(target, { lingerMs = 30 } = {}) {
  const chunks = [];
  const sockets = new Set();
  let taken = 0;
  const server = createServer((client) => {
    taken += 1;
    sockets.add(client);
    client.on("error", () => {});
    client.on("data", (data) => chunks.push(data));
    client.on("close", () => sockets.delete(client));
    // A plain end, with everything sent so far read: the client sees a close, never a reset.
    const timer = setTimeout(() => client.end(), lingerMs);
    timer.unref?.();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const via = new URL(target);
  via.hostname = "127.0.0.1";
  via.port = String(server.address().port);
  return {
    url: via.toString(),
    bytes: () => Buffer.concat(chunks).toString("latin1"),
    connections: () => taken,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
