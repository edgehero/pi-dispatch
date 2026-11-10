import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { DEVICES_FIXTURE } from "./devices-fixture.mjs";

// The DevicesScreen's goldens (issue #849): the page through the real loader and renderer over a store listing as `serve` hands it to pages (no hashes).
const LISTED = { devices: DEVICES_FIXTURE, unreadable: 0, unreadableIds: [] };

async function draw({ role = "operator", readOnly = false, remembered = "3f9a1c0b7d2e", listed = LISTED, offer = false } = {}) {
  const parsed = parsePageQuery("devices", "");
  const deps = { now: () => NOW, fleet: { snapshot: async () => ({}), parkedCount: async () => 0 }, devices: listed === null ? null : () => listed };
  const data = await loadPageData("devices", parsed.query, deps, { role, readOnly });
  const name = role === "operator" ? "ops" : role === "viewer" ? "watcher" : "bot";
  const out = await renderPage("devices", { data, query: parsed.query, session: { role, name, remembered: role === "agent" ? null : remembered }, readOnly, offer });
  return String(out.html);
}

export const devicesPage = draw;

export const DEVICES_DRAW = Object.freeze({
  "devices-remembered.operator": () => draw(),
  "devices-remembered.viewer": () => draw({ role: "viewer", remembered: "c71d0e5a9b34" }),
  "devices-not-remembered.operator": () => draw({ remembered: null }),
  "devices-offer.operator": () => draw({ remembered: null, offer: true }),
  "devices-none.operator": () => draw({ remembered: null, listed: { devices: [], unreadable: 0, unreadableIds: [] } }),
  "devices-unreadable-record.operator": () => draw({ listed: { ...LISTED, unreadable: 1, unreadableIds: ["0d4c2b1a9e8f"] } }),
  "devices-store-unusable.operator": () => draw({ remembered: null, listed: { problem: "the remembered-device folder /deployment/console-devices is open to other accounts (mode 0755); remove it" } }),
  "devices-readonly.operator": () => draw({ readOnly: true }),
});
export const DEVICES_PANEL_STATES = Object.freeze(Object.keys(DEVICES_DRAW));
