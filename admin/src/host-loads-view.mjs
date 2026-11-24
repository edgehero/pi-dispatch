/**
 * What the hosts published about what their jobs can load, for a page (issue #800, `INT-DOCTOR-RESULTS-KEY`'s
 * `doctor:loads:<name>`), each row beside the pi and image its host beats out (`host:h:<name>`, INT-HOST-REGISTRY-CONTRACT).
 * So a live host that never published still has a row, reading unknown, with its pi and image, and nothing a page says of it
 * can read as "the same". The publication has no copy of those two, on purpose: `host-loads.mjs` says why.
 *
 * Never throws. An unreachable Valkey is `{ unreachable: true, hosts: [] }`, and a page reads that as unknown. Writes nothing:
 * `prune: false`, so a console that only looks never removes another host's row.
 *
 * A HOST WHOSE ROW WAS NOT READ IS STILL A HOST (issue #1036). The registry's read names the members whose rows it did not
 * read (`unreadHosts`: a row Valkey answered with an error, or one that got no answer). They were left out of the names asked
 * for here, so such a host had a row only if doctor's index happened to hold it, and a host that never published was on no
 * page at all. They are asked for like any live host, and each such row says `rowUnread: true`: its pi, image and triggers
 * version are null because nobody read them, which is not a host that publishes none.
 */
import { readHostLoads } from "@edgehero/pi-dispatch/host-loads";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";

export async function readHostLoadsView(redis, { now = () => Date.now(), readLoads = readHostLoads, readHosts = readLiveHosts } = {}) {
  let live = [];
  let unread = [];
  try {
    const got = await readHosts(redis, { now, prune: false });
    if (Array.isArray(got?.hosts)) live = got.hosts;
    if (Array.isArray(got?.unreadHosts)) unread = got.unreadHosts.filter((name) => typeof name === "string" && name !== "" && !live.some((host) => host?.name === name));
  } catch {
    // The publications may still read, and a host they do not name stays unknown.
  }
  let got;
  try {
    got = await readLoads(redis, { names: [...live.map((host) => host?.name), ...unread], now });
  } catch {
    got = { unreachable: "host loads unreadable" };
  }
  const beats = new Map(live.map((host) => [host?.name, host]));
  const text = (value) => (typeof value === "string" && value !== "" ? value : null);
  // `triggersVersion` is what that host's worker reads of the triggers file, for a page that says whether it would hold a file's jobs.
  const withBeat = (row) => ({ ...row, image: text(beats.get(row.name)?.image), piVersion: text(beats.get(row.name)?.piVersion), triggersVersion: text(beats.get(row.name)?.triggersVersion), ...(unread.includes(row.name) ? { rowUnread: true } : {}) });
  if (got?.unreachable || !Array.isArray(got?.hosts)) return { unreachable: true, hosts: [...live.filter((host) => typeof host?.name === "string").map((host) => host.name), ...unread].map((name) => withBeat({ name, state: "unknown", why: "unreachable" })), more: 0 };
  return { hosts: got.hosts.map(withBeat), more: Number.isSafeInteger(got.more) ? got.more : 0 };
}
