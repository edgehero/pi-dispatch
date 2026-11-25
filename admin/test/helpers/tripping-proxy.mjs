import { connect as netConnect, createServer } from "node:net";
import { freezingProxy } from "../../../worker/test/helpers/freezing-proxy.mjs";

/**
 * The worker tests' freezing proxy with a trip in front of it: `freezeAt(pattern)` freezes the moment a client sends
 * bytes that match, those bytes included, and resolves when it has. A Valkey that stops answering at one named command
 * of a console the test does not drive command by command (`kill -STOP` as that command leaves, to every client at once).
 * The pattern is matched against one chunk as latin1 text, which holds a whole command of the few hundred bytes these send.
 *
 * `slow(ms)` (issue #1072): every chunk Valkey sends back reaches its client `ms` later, in order, from then on; 0 ends
 * it. A Valkey that answers every command, each 100 to 200 ms late, as a healthy and slow deployment does: the case a
 * frozen one cannot stand for, since a bound that is right for a Valkey that answers nothing can cut one that answers.
 */
export async function trippingProxy(target) {
  const proxy = await freezingProxy(target);
  const inner = new URL(proxy.url);
  let trip = null;
  let delayMs = 0;
  const sockets = new Set();
  const server = createServer((client) => {
    const upstream = netConnect({ host: inner.hostname, port: Number(inner.port) });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
    }
    client.on("data", (data) => {
      if (trip && trip.pattern.test(data.toString("latin1"))) {
        const { seen } = trip;
        trip = null;
        proxy.freeze();
        seen();
      }
      upstream.write(data);
    });
    // Each chunk at its own instant, never before the one before it: timers whose instants rise fire in that order.
    let lastAt = 0;
    upstream.on("data", (data) => {
      if (delayMs <= 0 && lastAt <= Date.now()) return void client.write(data);
      lastAt = Math.max(Date.now() + delayMs, lastAt);
      setTimeout(() => client.write(data), lastAt - Date.now()).unref?.();
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const via = new URL(proxy.url);
  via.port = String(server.address().port);
  return {
    url: via.toString(),
    freezeAt: (pattern) => new Promise((seen) => { trip = { pattern, seen }; }),
    freeze: proxy.freeze,
    thaw: proxy.thaw,
    slow: (ms) => {
      delayMs = ms;
    },
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
      proxy.close();
    },
  };
}

/** One RESP command by its name and the start of its first key, as ioredis writes it. */
export const commandOn = (name, keyPrefix) => new RegExp(`\\r\\n\\$${name.length}\\r\\n${name}\\r\\n\\$\\d+\\r\\n${keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
