/**
 * What the hosts published about what their jobs can load, for a page (issue #800, `INT-DOCTOR-RESULTS-KEY`'s
 * `doctor:loads:<name>`), each row beside the pi and image its host beats out (`host:h:<name>`, INT-HOST-REGISTRY-CONTRACT).
 * So a live host that never published still has a row, reading unknown, with its pi and image, and nothing a page says of it
 * can read as "the same". The publication has no copy of those two, on purpose: `host-loads.mjs` says why.
 *
 * Never throws. An unreachable Valkey is `{ unreachable: true, hosts: [] }`, and a page reads that as unknown. Writes nothing:
 * `prune: false`, so a console that only looks never removes another host's row.
 */
import { readHostLoads } from "@edgehero/pi-dispatch/host-loads";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";

export async function readHostLoadsView(redis, { now = () => Date.now(), readLoads = readHostLoads, readHosts = readLiveHosts } = {}) {
  let live = [];
  try {
    const got = await readHosts(redis, { now, prune: false });
    if (Array.isArray(got?.hosts)) live = got.hosts;
  } catch {
    // The publications may still read, and a host they do not name stays unknown.
  }
  let got;
  try {
    got = await readLoads(redis, { names: live.map((host) => host?.name), now });
  } catch {
    got = { unreachable: "host loads unreadable" };
  }
  const beats = new Map(live.map((host) => [host?.name, host]));
  const text = (value) => (typeof value === "string" && value !== "" ? value : null);
  const withBeat = (row) => ({ ...row, image: text(beats.get(row.name)?.image), piVersion: text(beats.get(row.name)?.piVersion) });
  if (got?.unreachable || !Array.isArray(got?.hosts)) return { unreachable: true, hosts: live.filter((host) => typeof host?.name === "string").map((host) => withBeat({ name: host.name, state: "unknown", why: "unreachable" })), more: 0 };
  return { hosts: got.hosts.map(withBeat), more: Number.isSafeInteger(got.more) ? got.more : 0 };
}
