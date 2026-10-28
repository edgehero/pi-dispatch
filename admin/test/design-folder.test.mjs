import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PULSE_CSS_SHA256 } from "../src/console/pulse-css.mjs";
import { PULSE_TOKENS_SHA256 } from "../src/console/pulse-tokens.mjs";

// The design system lives in this repository since #737's design moved in (design/system), and the console still does
// not read it at runtime: it pastes the design's tokens.json and components/bundle.css, each pinned by its sha256
// (`console-stylesheet.test.mjs`, DES-OPERATOR-CONSOLE "The visual system"). Before the move the two sides could drift
// unseen, because only one of them was here. This holds them together.
//
// The tokens are one file, so they must be equal. The stylesheet may run AHEAD of the paste, because a change to the
// look lands in the design first and a console pull request pastes it after measuring it on the console's own pages.
// So it is either the pasted file or EXACTLY the version recorded below as waiting. A third version fails here: paste
// it, or record it as waiting and say what it changes. When the console pastes the waiting version, its hash becomes
// PULSE_CSS_SHA256 and this constant goes back to null.

/**
 * The design's bundle.css waiting to be pasted, or null when the paste is current. Waiting since #737's design moved
 * into the repository: tabular figures on numbers only (counts, money, times, table figures and the timeline's times),
 * because on running text they also widen hyphens, so an id like gh-2f6a read "gh - 2f6a". Before, `body` set them
 * for all text. The paste re-measures what the console sizes by hand on tabular digits (DES-OPERATOR-CONSOLE).
 */
const DESIGN_CSS_WAITING_SHA256 = "c94d6fe9f9513ace1f42bfff05f3058ddb5a845c85a606b9899e14653d4f7a8f";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const designFile = (path) => readFileSync(new URL(`../../design/system/${path}`, import.meta.url));

test("the design's tokens.json is the file the console pasted, byte for byte", () => {
  assert.equal(sha256(designFile("tokens.json")), PULSE_TOKENS_SHA256);
});

test("the design's bundle.css is the pasted stylesheet, or exactly the version recorded as waiting to be pasted", () => {
  const got = sha256(designFile("components/bundle.css"));
  const known = [PULSE_CSS_SHA256, DESIGN_CSS_WAITING_SHA256].filter(Boolean);
  assert.ok(known.includes(got), `design/system/components/bundle.css is ${got}: paste it into pulse-css.mjs, or record it in this file as waiting`);
});

test("a recorded waiting version is not the pasted one (when they match, the constant goes back to null)", () => {
  assert.notEqual(DESIGN_CSS_WAITING_SHA256, PULSE_CSS_SHA256);
});
