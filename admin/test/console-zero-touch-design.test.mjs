import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ZERO_TOUCH_CSS } from "../src/console/zero-touch-css.mjs";
import { ZERO_TOUCH_PANELS } from "../src/console/panels/zero-touch.mjs";
import { QUESTION_GROUP_STATUSES } from "@edgehero/pi-dispatch/question-groups";
import { ZERO_TOUCH_SOURCE_WORDS } from "../src/console/panels/zero-touch.mjs";

test("Zero touch styles are the source card's actual CSS and phone rules, including design-first refinements", () => {
  const generator = readFileSync(new URL("../../design/tools/gen_zerotouch.py", import.meta.url), "utf8");
  const css = generator.match(/^CSS = """([\s\S]*?)"""/m)?.[1];
  const phone = generator.match(/^PHONE_CSS = """([\s\S]*?)"""/m)?.[1];
  const additions = [...generator.matchAll(/^CSS \+= """([\s\S]*?)"""/gm)].map((m) => m[1]).join("");
  assert.ok(css && phone && additions);
  assert.equal(ZERO_TOUCH_CSS, css + additions + phone);
});

test("every grouping state has an explicit operator sentence and no arbitrary error text is rendered", () => {
  assert.deepEqual(Object.keys(ZERO_TOUCH_SOURCE_WORDS), [...QUESTION_GROUP_STATUSES]);
  for (const sentence of Object.values(ZERO_TOUCH_SOURCE_WORDS)) assert.ok(sentence.length > 10);
});

test("all three cards have ledgers and the phone's merged KPI panels stay explicitly accounted for", () => {
  const panels = ZERO_TOUCH_PANELS.map(([id]) => id);
  for (const card of ["ZeroTouchScreen", "ZeroTouchViewer", "ZeroTouchPhone"]) {
    const ledger = JSON.parse(readFileSync(new URL(`./fixtures/console-ledger/${card}.json`, import.meta.url), "utf8"));
    assert.equal(ledger.pr, 777);
    for (const id of ledger.panels) assert.ok(panels.includes(id));
    assert.ok(ledger.elements.some((e) => /Standing answers/.test(e.el) && e.status === "absent"));
  }
  const phone = JSON.parse(readFileSync(new URL("./fixtures/console-ledger/ZeroTouchPhone.json", import.meta.url), "utf8"));
  assert.deepEqual(phone.panels, ["p-zt-rate", "p-zt-projects", "p-zt-causes", "p-zt-questions", "p-zt-fixes"]);
  assert.ok(phone.elements.some((e) => e.reason?.includes("Three desktop KPI panels")));
});
