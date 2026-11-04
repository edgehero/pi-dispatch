import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { decodePng, encodeApng } from "../../launch/apng.mjs";
import { EXPLAIN_FPS, EXPLAIN_MIN_TEXT, EXPLAIN_THEMES, EXPLAIN_WIDTH, EXPLAINERS, explainerFile, explainerSvg, explainerWords, explainShots, explainSources } from "../../launch/explainers.mjs";
import { TOP_HALF_BANNED } from "./helpers/plain-words.mjs";

// Issue #820: the READMEs' explaining pictures. A picture is a hand-written restatement like any table (AGENTS.md), and
// an easy one to get wrong, because simple words pull towards a stronger claim than the product makes. So the words are
// read from the source that draws them, without Chrome, and held both to who reads them and to what makes them true.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../launch/render-images.mjs", import.meta.url));
const DIR = "docs/images/explain";
const read = (path) => readFileSync(`${REPO}${path}`, "utf8");
const flat = (text) => text.replace(/\s+/g, " ");
const wordsOf = (explainer) => explainerWords(explainerSvg(explainer, "light"));
/** The pictures the npm page shows too: the two that say what the product is, not the worries or the swarm. */
const ON_NPM = ["how-close-you-stay", "one-job"];
const tokens = JSON.parse(read("design/system/tokens.json"));

/** A PNG's chunks, in order. */
function chunksOf(file) {
  const chunks = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    chunks.push({ type: file.toString("latin1", at + 4, at + 8), data: file.subarray(at + 8, at + 8 + length), crc: file.readUInt32BE(at + 8 + length), raw: file.subarray(at + 4, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

/** A small PNG of RGBA rows, with no filter: what the encoder has to read, without a browser. */
function pngOf(width, height, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Plays an animated PNG as a viewer does: each frame drawn over the last, and returns the RGBA of every stored frame with its delay. */
function play(file) {
  const chunks = chunksOf(file);
  const header = chunks.find((c) => c.type === "IHDR").data;
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  const palette = chunks.find((c) => c.type === "PLTE").data;
  const alpha = chunks.find((c) => c.type === "tRNS").data;
  const canvas = Buffer.alloc(width * height * 4);
  const shown = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type !== "fcTL") continue;
    const control = chunks[i].data;
    const [w, h, left, top, delay, blend] = [control.readUInt32BE(4), control.readUInt32BE(8), control.readUInt32BE(12), control.readUInt32BE(16), control.readUInt16BE(20), control[25]];
    const body = chunks[i + 1];
    const rows = inflateSync(body.type === "fdAT" ? body.data.subarray(4) : body.data);
    for (let y = 0; y < h; y++) {
      assert.equal(rows[y * (w + 1)], 0, "no filter on palette rows");
      for (let x = 0; x < w; x++) {
        const index = rows[y * (w + 1) + 1 + x];
        const to = ((top + y) * width + left + x) * 4;
        if (blend === 1 && alpha[index] === 0) continue; // "over": nothing here keeps what is there
        canvas[to] = palette[index * 3];
        canvas[to + 1] = palette[index * 3 + 1];
        canvas[to + 2] = palette[index * 3 + 2];
        canvas[to + 3] = alpha[index];
      }
    }
    shown.push({ rgba: Buffer.from(canvas), delay });
  }
  return { width, height, shown };
}

test("a picture's words and its alt text keep the README's rules: no dash as punctuation, nothing left to the engineers' half", () => {
  for (const explainer of EXPLAINERS) {
    for (const words of [...wordsOf(explainer), explainer.alt]) {
      assert.doesNotMatch(words, /[–—]/, `${explainer.name}: ${words}`);
      assert.doesNotMatch(words, / - /, `${explainer.name}: ${words}`);
      for (const banned of TOP_HALF_BANNED) assert.doesNotMatch(words, new RegExp(`\\b${banned}(?![a-z])`, "i"), `${explainer.name}: "${banned}" in ${words}`);
    }
  }
});

test("no picture says the simpler thing the docs refute", () => {
  // Each of these reads better than the truth, and each is false. The job's token CAN merge: pi-dispatch never does, and
  // branch protection is the control (README, GitHub automation). `docs/costs.md` lists what the caps do not cover. Two
  // keys go in and the agent can read both. A refusal can keep its job count slot, and the machine costs what it costs.
  // The worker has dozens of refusals, so any count of checks is stale the day one is added.
  // An AI reviews and never approves: a self-approval is a merge by another name (`CONST-MERGE-NEVER-AUTOMATIC`).
  // pi-dispatch looks after a swarm and does not direct it, so "orchestrates" would be another agent it does not have.
  const REFUTED = [/\b(can ?not|can't|unable to) (merge|accept)/i, /\bcan ?not (pass|exceed|overspend)/i, /\bnever (passes|exceeds|overspends)/i, /nothing (gets|leaves|comes) out/i, /\bfree\b/i, /\b\d+ (checks|gates|limits)\b/i, /never accepted/i, /\b(AI|agent|it) (also )?approves?\b/i, /approved by AI/i, /\borchestrat/i];
  for (const explainer of EXPLAINERS) {
    for (const words of [...wordsOf(explainer), explainer.alt]) for (const refuted of REFUTED) assert.doesNotMatch(words, refuted, `${explainer.name}: ${words}`);
  }
});

test("every claim is words the picture holds and a sentence that makes them true", () => {
  for (const explainer of EXPLAINERS) {
    const shown = wordsOf(explainer).join(" ");
    assert.ok(explainer.claims.length > 0, `${explainer.name} claims something`);
    for (const { says, source, needle } of explainer.claims) {
      assert.ok(shown.toLowerCase().includes(says.toLowerCase()), `${explainer.name} no longer says "${says}": change the claim with the words`);
      assert.ok(flat(read(source)).includes(needle), `${source} no longer says "${needle}": is ${explainer.name}'s "${says}" still true?`);
    }
  }
});

test("a picture is drawn in the design system: only its colours, its sentence case, and text a phone can still make out", () => {
  const allowed = Object.fromEntries(EXPLAIN_THEMES.map((theme) => [theme, new Set(tokens.color.tokens.map((token) => token.value[theme].toLowerCase()))]));
  for (const shot of explainShots()) {
    assert.equal(shot.width, EXPLAIN_WIDTH);
    for (const [, colour] of shot.svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)) assert.ok(allowed[shot.theme].has(colour.toLowerCase()), `${shot.file}: ${colour} is not a ${shot.theme} token`);
    const sizes = [...shot.svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0, `${shot.file} has text`);
    assert.ok(Math.min(...sizes) >= EXPLAIN_MIN_TEXT, `${shot.file}: text of ${Math.min(...sizes)} px, under ${EXPLAIN_MIN_TEXT}`);
    assert.ok(shot.svg.includes(`font-family="${tokens.type.families.sans.replaceAll('"', "&quot;")}"`), `${shot.file} uses the system's type stack`);
    for (const words of explainerWords(shot.svg)) assert.doesNotMatch(words, /\b[A-Z]{3,}\b/, `${shot.file}: all caps in ${words}`);
  }
});

test("a picture says the same in both themes, and its loop closes", () => {
  for (const explainer of EXPLAINERS) {
    const [first, ...rest] = EXPLAIN_THEMES.map((theme) => explainerWords(explainerSvg(explainer, theme)));
    for (const words of rest) assert.deepEqual(words, first, explainer.name);
  }
  for (const shot of explainShots()) {
    assert.equal(shot.frames, Math.round(shot.seconds * EXPLAIN_FPS), shot.file);
    assert.ok(shot.stillAt > 0 && shot.stillAt < 1, `${shot.file}: the still is a moment of the loop`);
    // A keyframe list that does not reach 100% would jump when the loop starts over.
    for (const [, name, body] of shot.svg.matchAll(/@keyframes ([a-z0-9-]+)\{(.*?\})\}/g)) assert.match(body, /100%\{/, `${shot.file}: ${name} does not reach the end of the loop`);
  }
});

test("the folder holds exactly the planned files, and no PNG is older than the picture it should show", () => {
  const shots = explainShots();
  const planned = [...shots.flatMap((shot) => [shot.file, shot.still]), "sources.json"].sort();
  assert.deepEqual(readdirSync(`${REPO}${DIR}`).sort(), planned, `${DIR} holds exactly the pictures: run node launch/render-images.mjs --explain`);
  // PNGs are Chrome's rendering and are not held to bytes, so this is what stands between a changed word and a picture
  // still showing the old one with every test green.
  assert.deepEqual(JSON.parse(read(`${DIR}/sources.json`)), explainSources(shots), "a picture changed: run node launch/render-images.mjs --explain");
});

test("what is committed plays: every loop is an animated PNG that repeats for ever and is light enough to keep, and every still is not animated", () => {
  const KEEP_UNDER = 1024 * 1024; // These stay in every clone for good. A loop past this is doing too much at once.
  for (const shot of explainShots()) {
    const loop = readFileSync(`${REPO}${DIR}/${shot.file}`);
    assert.ok(loop.length < KEEP_UNDER, `${shot.file} is ${Math.round(loop.length / 1024)} KB`);
    const chunks = chunksOf(loop);
    const control = chunks.find((c) => c.type === "acTL");
    assert.ok(control, `${shot.file} is animated`);
    assert.equal(control.data.readUInt32BE(4), 0, `${shot.file} loops for ever`);
    assert.ok(control.data.readUInt32BE(0) > 1, `${shot.file} has more than one frame`);
    assert.ok(chunks.findIndex((c) => c.type === "acTL") < chunks.findIndex((c) => c.type === "IDAT"), `${shot.file}: a reader must meet the animation before the first frame`);
    assert.equal(chunksOf(readFileSync(`${REPO}${DIR}/${shot.still}`)).some((c) => c.type === "acTL"), false, `${shot.still} holds still`);
  }
});

test("the encoder plays back exactly what went in, stores only what changed, and merges a frame that changed nothing", () => {
  const [width, height] = [4, 3];
  const solid = (colour) => {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) rgba.writeUInt32BE(colour, i * 4);
    return rgba;
  };
  const first = solid(0x112233ff);
  first.writeUInt32BE(0x00000000, 0); // a see-through corner, as the pictures have, that never changes
  const second = Buffer.from(first);
  second.writeUInt32BE(0xff0000ff, (1 * width + 2) * 4);
  const third = Buffer.from(second);
  const fourth = Buffer.from(second);
  fourth.writeUInt32BE(0x00ff00ff, (2 * width + 3) * 4);
  const file = encodeApng([first, second, third, fourth].map((rgba) => pngOf(width, height, rgba)), { fps: 10 });
  for (const chunk of chunksOf(file)) assert.equal(chunk.crc, crc32(chunk.raw) >>> 0, `${chunk.type} carries a good checksum`);
  const sequence = chunksOf(file).filter((c) => c.type === "fcTL" || c.type === "fdAT").map((c) => c.data.readUInt32BE(0));
  assert.deepEqual(sequence, sequence.map((_, at) => at), "frame chunks are numbered without a gap, or a viewer stops");
  const { shown } = play(file);
  assert.equal(shown.length, 3, "the frame that changed nothing is not stored");
  assert.deepEqual(shown.map((frame) => frame.delay), [1, 2, 1], "it lengthens the frame before it, so the loop keeps its length");
  assert.ok(shown[0].rgba.equals(first));
  assert.ok(shown[1].rgba.equals(second));
  assert.ok(shown[2].rgba.equals(fourth));
  const controls = chunksOf(file).filter((c) => c.type === "fcTL");
  assert.deepEqual([controls[1].data.readUInt32BE(4), controls[1].data.readUInt32BE(8)], [1, 1], "a change of one pixel stores one pixel");
  assert.throws(() => encodeApng([], { fps: 10 }), /no frames/);
  assert.throws(() => encodeApng([pngOf(1, 1, Buffer.alloc(4)), pngOf(2, 1, Buffer.alloc(8))], { fps: 10 }), /different sizes/);
  assert.deepEqual({ width: decodePng(pngOf(width, height, first)).width, same: decodePng(pngOf(width, height, first)).rgba.equals(first) }, { width, same: true });
});

test("the root README shows every picture in both themes, a still to who asked for less motion, with the alt text it was drawn with", () => {
  const readme = read("README.md");
  for (const { name, alt } of EXPLAINERS) {
    const start = readme.indexOf(`srcset="docs/images/explain/${name}-dark-still.png`);
    assert.ok(start > 0, `${name} is shown`);
    const block = readme.slice(readme.lastIndexOf("<picture>", start), readme.indexOf("</picture>", start));
    // The first source that matches wins, so the stills have to come first and the dark still before the light one.
    const order = [
      `media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="docs/images/explain/${explainerFile(name, "dark", true)}?v=`,
      `media="(prefers-reduced-motion: reduce)" srcset="docs/images/explain/${explainerFile(name, "light", true)}?v=`,
      `media="(prefers-color-scheme: dark)" srcset="docs/images/explain/${explainerFile(name, "dark")}?v=`,
      `<img src="docs/images/explain/${explainerFile(name, "light")}?v=`,
    ].map((part) => block.indexOf(part));
    assert.ok(order.every((at) => at >= 0), `${name}: every source is there: ${order}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${name}: sources in the order they must be tried`);
    assert.ok(block.includes(`alt="${alt}"`), `${name}: the README's alt text is the one in launch/explainers.mjs`);
  }
  const top = readme.slice(0, readme.indexOf("## For engineers\n"));
  for (const { name } of EXPLAINERS) assert.ok(top.includes(`explain/${name}.png`), `${name} is for the half written for someone who does not write code`);
});

test("the one-job picture says at once what a folder job does instead", () => {
  // The picture ends in a proposed change, and a job on a folder has none. It is the one simplification the words cannot
  // carry, so the caption has to, right under it.
  const readme = read("README.md");
  const after = readme.slice(readme.indexOf("explain/one-job.png"));
  assert.match(after.slice(after.indexOf("</picture>")), /^<\/picture>\n\n<sub>[^<]*the job edits that folder directly\.<\/sub>/);
});

test("the paragraph that says what the loop is comes before the picture of it", () => {
  const readme = read("README.md");
  assert.ok(readme.indexOf("You type, it works, you check") < readme.indexOf("explain/how-close-you-stay"));
});

test("the npm page shows its two pictures by absolute URL, light and moving, since it has neither SVG nor themes", () => {
  const readme = read("admin/README.md");
  for (const { name, alt } of EXPLAINERS) {
    const shown = readme.includes(`/docs/images/explain/${name}.png`);
    assert.equal(shown, ON_NPM.includes(name), name);
    if (shown) assert.ok(readme.includes(`alt="${alt}"`), `${name}: the npm page's alt text is the one in launch/explainers.mjs`);
  }
  assert.doesNotMatch(readme, /explain\/[a-z-]+-(dark|still)[a-z-]*\.png/);
});

test("--explain refuses what cannot go with it, and says what it needs, before it starts anything", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  for (const args of [["--explain", "--png"], ["--explain", "--console"], ["--explain", "--url", "redis://x"]]) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(" "));
    assert.match(refused.stderr, /--explain takes none of/, args.join(" "));
  }
  const noChrome = run(["--explain"], { CHROME: `${REPO}no-such-chrome` });
  assert.equal(noChrome.status, 2);
  assert.match(noChrome.stderr, /--explain needs Google Chrome/);
});
