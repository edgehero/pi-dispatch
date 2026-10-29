import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FLEET_DESIGN_CSS } from "../src/console/fleet-css.mjs";
import { HOST_DETAIL_CSS, VENUE_DETAIL_CSS } from "../src/console/host-venue-css.mjs";
import { PAGE_CSS, pageCss } from "../src/console/page-css.mjs";

// The reference's local card rules are part of the design, just like the shared bundle. Export existence alone
// missed the whole fleet-bar, checklist, host-resource and capacity treatment in the first implementation.
for (const [card, css, page] of [
  ["FleetScreen", FLEET_DESIGN_CSS, "fleet"],
  ["FleetPartPaused", FLEET_DESIGN_CSS, "fleet"],
  ["HostDetail", HOST_DETAIL_CSS, "host"],
  ["VenueDetail", VENUE_DETAIL_CSS, "venue"],
]) {
  test(`${card}: the page includes its published card rules, confined to its own page`, () => {
    const source = readFileSync(new URL(`../../design/system/components/${card}/preview.html`, import.meta.url), "utf8");
    const reference = /<style>([\s\S]*?)<\/style>/.exec(source)?.[1].trim();
    assert.ok(reference, `${card} has its page-local stylesheet`);
    assert.ok(css.includes(reference), `${card}'s local rules are pasted intact, rather than replaced with generic tables`);
    assert.ok(PAGE_CSS[page].includes(css), `${page} actually serves the copied card rules`);
    const served = pageCss({ [page]: PAGE_CSS[page] });
    assert.ok(served.includes(`body[data-page="${page}"]`));
    assert.doesNotMatch(served, /@import|style=/);
  });
}
