import { NOW } from "../../../launch/fixture-deployment.mjs";

// The remembered browsers the DevicesScreen card shows (issue #849), as `serve` lists them for the page: a short id, no hash. No project module is
// imported here, so the page harness may import this at its top, before its child freezes the clock.
const DAY = 24 * 3600000;
const iso = (ms) => new Date(ms).toISOString();
const device = (id, name, role, label, created, used) => ({ id, name, role, label, createdAt: iso(NOW - created * DAY), lastUsedAt: iso(NOW - used * DAY) });
export const DEVICES_FIXTURE = Object.freeze([
  device("3f9a1c0b7d2e", "ops", "operator", "Chrome on macOS", 23, 0),
  device("8b2e4d6f1a90", "ops", "operator", "Safari on iPhone", 9, 2),
  device("c71d0e5a9b34", "watcher", "viewer", "Firefox on Linux", 14, 1),
]);
