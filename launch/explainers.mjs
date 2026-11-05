/**
 * The READMEs' explaining pictures (issue #820): small animations in the console's own design language, drawn as
 * SVG from words and the design folder, and shot to animated PNG by `render-images.mjs --explain`. The console images
 * show what the product looks like; these say how it works, to someone who has not used it. Each holds one idea.
 *
 * THE DESIGN IS DERIVED, NOT COPIED. Colours and type come from `design/system/tokens.json`, and icons from the sprite a
 * card carries, so a change to the system reaches these at the next render. The parts are the console's: flat rounded
 * cards on the canvas, a tight headline with a quiet sentence under it, tiles, badges with a glyph and a word, the brand
 * mark, mono job pills, dashed pills for what waits. Status colours mean what they mean there.
 *
 * WHY AN ANIMATED PNG, NOT THE ANIMATED SVG. The npm page cannot show an SVG from raw.githubusercontent.com, and an SVG in
 * an image tag draws with the reader's fonts, so a line that fits here could run past its card there. An animated PNG
 * shows the same pixels on both, and is a plain PNG (its first frame) anywhere that does not animate one. A GIF would
 * band the soft tints, and has no soft edge for the rounded corners.
 *
 * EVERY FRAME READS ON ITS OWN. Motion only adds emphasis: every word is on screen at full strength in every frame, so a
 * reader who arrives mid-loop, or whose browser shows the first frame only, misses nothing. A reader who asked for
 * reduced motion gets a still (the design system's rule), through a source on the README's picture.
 *
 * NO DEPENDENCIES AND NO BROWSER here, so the test can build every picture without Chrome.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKENS = JSON.parse(readFileSync(new URL("../design/system/tokens.json", import.meta.url), "utf8"));
const COLOURS = new Map(TOKENS.color.tokens.map((token) => [token.name, token.value]));
const SANS = TOKENS.type.families.sans;
const MONO = TOKENS.type.families.mono;
const SPRITE = readFileSync(new URL("../design/system/components/Status/preview.html", import.meta.url), "utf8");
/**
 * A few icons in the sprite spell an attribute twice. HTML keeps the first and ignores the rest, which is how the console
 * draws them; XML, which an SVG file is, refuses the page. So the rest go, and the icon is the one the console shows.
 */
const htmlAttributes = (markup) => markup.replace(/<[a-z]+ [^>]*>/g, (tag) => {
	const seen = new Set();
	return tag.replace(/\s([a-z-]+)="[^"]*"/g, (attribute, name) => (seen.has(name) ? "" : (seen.add(name), attribute)));
});
const ICONS = new Map([...SPRITE.matchAll(/<symbol id="i-([a-z-]+)" viewBox="0 0 24 24">(.*?)<\/symbol>/gs)].map(([, name, body]) => [name, htmlAttributes(body)]));

export const EXPLAIN_THEMES = Object.freeze(["light", "dark"]);
/** The width every picture is drawn at. */
export const EXPLAIN_WIDTH = 1200;
/**
 * The smallest text a picture may hold: the console's body size at the scale these are drawn. A phone shows 1200 px at
 * about 358, so this is about 6.5 px there, small but sharp, and the README's words and the alt text say the same.
 */
export const EXPLAIN_MIN_TEXT = 22;
/** 1.5 times the drawn width: sharp at the widest a README column gets, and it keeps a loop small enough to commit. */
export const EXPLAIN_SCALE = 1.5;
export const EXPLAIN_FPS = 15;

const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A theme's colour by its token name, so a picture's blue is the console's running blue in either theme. */
const paletteOf = (theme) => (name) => {
	const value = COLOURS.get(name);
	if (!value) throw new Error(`explainers: no colour token ${name}`);
	return value[theme];
};

function text(x, y, words, { size = EXPLAIN_MIN_TEXT, weight = 400, fill, anchor = "start", mono = false, track = null, cls = null }) {
	const family = mono ? ` font-family="${esc(MONO)}"` : "";
	const spacing = track === null ? "" : ` letter-spacing="${track}"`;
	const klass = cls === null ? "" : ` class="${cls}"`;
	return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${family}${spacing}${klass}>${esc(words)}</text>`;
}

const lines = (x, y, rows, { leading = 30, ...options }) => rows.map((row, at) => text(x, y + at * leading, row, options)).join("");

/** An icon from the design system's sprite, by its name there. */
/** One of the design system's icons as SVG markup, for a picture that is not drawn here (the film). */
export const iconBody = (name) => ICONS.get(name);

function icon(name, x, y, size, colour) {
	const body = ICONS.get(name);
	if (!body) throw new Error(`explainers: no icon ${name} in the design system's sprite`);
	return `<g transform="translate(${x} ${y}) scale(${size / 24})" color="${colour}">${body}</g>`;
}

const box = (x, y, width, height, radius, attrs = "") => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ${attrs}/>`;
const cardAt = (x, y, width, height, c, fill = "surface", radius = 26) => box(x, y, width, height, radius, `fill="${c(fill)}"`);

/** A round mark holding a short word: the brand's "pi", and "you" the way the console shows a person. */
function mark(cx, cy, r, word, fill, ink, size = 26) {
	return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>${text(cx, cy + size * 0.35, word, { size, weight: 800, fill: ink, anchor: "middle" })}`;
}

/** A tile: the console's rounded icon square, in a status tone or quiet. */
function tile(x, y, size, name, c, tone = null) {
	const inner = Math.round(size * 0.56);
	const at = (size - inner) / 2;
	return `${box(x, y, size, size, 14, `fill="${c(tone ? `${tone}-tint` : "surface-2")}"`)}${icon(name, x + at, y + at, inner, c(tone ? `${tone}-ink` : "ink"))}`;
}

/** A badge: a glyph and a word in a status tone, never the colour alone. `width` is measured by eye: the render shows it. */
function badge(x, y, width, words, name, c, tone) {
	return `${box(x, y, width, 40, 20, `fill="${c(`${tone}-tint`)}"`)}${icon(name, x + 10, y + 9, 22, c(`${tone}-ink`))}${text(x + 40, y + 28, words, { size: 22, weight: 650, fill: c(`${tone}-ink`) })}`;
}

/** The ground, the headline, its sentence and the brand: the head of a console page, on the page's own canvas. */
function page(height, c, headline, sentence, body) {
	return [
		box(0, 0, EXPLAIN_WIDTH, height, 32, `fill="${c("canvas")}"`),
		text(44, 86, headline, { size: 46, weight: 800, fill: c("ink"), track: "-0.03em" }),
		text(45, 126, sentence, { size: 24, fill: c("ink-muted") }),
		box(EXPLAIN_WIDTH - 44 - 196, 40, 196, 48, 24, `fill="${c("surface")}"`),
		mark(EXPLAIN_WIDTH - 44 - 196 + 24, 64, 18, "pi", c("primary"), c("on-primary"), 22),
		text(EXPLAIN_WIDTH - 44 - 196 + 50, 72, "pi-dispatch", { size: 22, weight: 750, fill: c("ink") }),
		body,
	].join("");
}

/**
 * Keyframes as `[percent, css]` rows. The easing runs between each pair of rows, so a thing that holds still is two rows
 * with the same value. Every loop ends where it began.
 */
const frames = (name, rows) => `@keyframes ${name}{${rows.map(([at, css]) => `${at}%{${css}}`).join("")}}`;
/** Opacity that is off, then on between two percents, with a short fade at each end. */
const onBetween = (from, to, fade = 1.5, peak = 1) => [
	[0, "opacity:0"],
	[Math.max(from - fade, 0.01), "opacity:0"],
	[from, `opacity:${peak}`],
	[to, `opacity:${peak}`],
	[Math.min(to + fade, 99.99), "opacity:0"],
	[100, "opacity:0"],
];
const eased = (name, seconds) => `${name} ${seconds}s cubic-bezier(.45,0,.2,1) infinite`;
const steady = (name, seconds) => `${name} ${seconds}s linear infinite`;

/** A ring around a card that lights while the story is there. */
function lit(klass, x, y, width, height, radius, colour) {
	return box(x, y, width, height, radius, `class="${klass}" fill="none" stroke="${colour}" stroke-width="3"`);
}

/** A job as the console's timeline draws it: a mono pill, dashed while it waits, filled while it runs. */
function jobPill(width, words, fill, ink, { dashed = null, glyph = null } = {}) {
	const outline = dashed ? `stroke="${dashed}" stroke-width="2.5" stroke-dasharray="7 6"` : "";
	const left = glyph ? -width / 2 + 40 : 0;
	const anchor = glyph ? "start" : "middle";
	return `${box(-width / 2, -19, width, 38, 19, `fill="${fill}" ${outline}`)}${glyph ?? ""}${text(left, 7.5, words, { size: 22, weight: 600, fill: ink, anchor, mono: true })}`;
}

/** Picture 1. The strip under the cards is the point: the free steps come first, and money moves only while the agent works. */
function oneJob(c) {
	const seconds = 10;
	const height = 618;
	const cardsY = 156;
	const cardHeight = 292;
	const width = 204;
	const xOf = (i) => 44 + i * 227;
	const centre = (i) => xOf(i) + width / 2;
	const railY = 504;
	const paidFrom = xOf(3) - 13;
	const paidWidth = width + 26;
	const pill = 100;
	const at = (x) => `transform:translateX(${x}px)`;
	const css = [
		frames("oj-a", [[0, at(centre(0))], [6, at(centre(0))], [14, at(centre(1))], [20, at(centre(1))], [28, at(centre(2))], [34, at(centre(2))], [40, at(paidFrom)], [50, at(paidFrom + paidWidth / 2)], [58, at(paidFrom + paidWidth / 2)], [66, at(paidFrom + paidWidth)], [72, at(centre(4))], [100, at(centre(4))]]),
		frames("oj-a-on", [[0, "opacity:0"], [1.5, "opacity:1"], [76, "opacity:1"], [78, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-wait", [[0, "opacity:1"], [38, "opacity:1"], [40, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-run", [[0, "opacity:0"], [38, "opacity:0"], [40, "opacity:1"], [49, "opacity:1"], [50.5, "opacity:0"], [57.5, "opacity:0"], [59, "opacity:1"], [65, "opacity:1"], [67, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-ask", onBetween(50.5, 57.5, 1)),
		frames("oj-done", [[0, "opacity:0"], [65, "opacity:0"], [67, "opacity:1"], [100, "opacity:1"]]),
		frames("oj-b", [[0, at(centre(0))], [80, at(centre(0))], [87, at(centre(2))], [100, at(centre(2))]]),
		frames("oj-b-on", [[0, "opacity:0"], [79, "opacity:0"], [80.5, "opacity:1"], [97, "opacity:1"], [99, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-b-wait", [[0, "opacity:1"], [87, "opacity:1"], [88.5, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-b-no", [[0, "opacity:0"], [87, "opacity:0"], [88.5, "opacity:1"], [100, "opacity:1"]]),
		frames("oj-fill", [[0, "transform:scaleX(0)"], [40, "transform:scaleX(0)"], [50, "transform:scaleX(.5)"], [58, "transform:scaleX(.5)"], [66, "transform:scaleX(1)"], [97, "transform:scaleX(1)"], [100, "transform:scaleX(1)"]]),
		// It empties with the job, so the refused job that follows is seen to add nothing.
		frames("oj-fill-on", [[0, "opacity:1"], [75, "opacity:1"], [78, "opacity:0"], [100, "opacity:0"]]),
		frames("oj-r0", onBetween(0.5, 8)),
		frames("oj-r1", onBetween(12, 22)),
		frames("oj-r2", onBetween(26, 36)),
		frames("oj-r3", onBetween(38, 68)),
		frames("oj-r4", onBetween(70, 78)),
		frames("oj-r5", onBetween(84, 97)),
		frames("oj-r6", onBetween(50, 58, 1)),
		`.oj-a{animation:${eased("oj-a", seconds)}}.oj-a-on{animation:${steady("oj-a-on", seconds)}}.oj-wait{animation:${steady("oj-wait", seconds)}}.oj-run{animation:${steady("oj-run", seconds)}}.oj-ask{animation:${steady("oj-ask", seconds)}}.oj-done{animation:${steady("oj-done", seconds)}}`,
		`.oj-b{animation:${eased("oj-b", seconds)}}.oj-b-on{animation:${steady("oj-b-on", seconds)}}.oj-b-wait{animation:${steady("oj-b-wait", seconds)}}.oj-b-no{animation:${steady("oj-b-no", seconds)}}`,
		`.oj-fill{transform-box:fill-box;transform-origin:0 50%;animation:${eased("oj-fill", seconds)}}.oj-fill-on{animation:${steady("oj-fill-on", seconds)}}`,
		[0, 1, 2, 3, 4, 5, 6].map((i) => `.oj-r${i}{animation:${steady(`oj-r${i}`, seconds)}}`).join(""),
	].join("");
	const title = (i, rows) => lines(xOf(i) + 20, cardsY + 118, rows, { leading: 32, size: 26, weight: 650, fill: c("ink") });
	const note = (i, y, rows, fill = c("ink-muted")) => lines(xOf(i) + 20, y, rows, { leading: 28, size: 22, fill });
	const bodyY = cardsY + 192;
	const body = [
		...[0, 1, 2, 3, 4].map((i) => cardAt(xOf(i), cardsY, width, cardHeight, c)),
		tile(xOf(0) + 20, cardsY + 20, 60, "bolt", c),
		tile(xOf(1) + 20, cardsY + 20, 60, "queue", c),
		tile(xOf(2) + 20, cardsY + 20, 60, "shield", c),
		tile(xOf(3) + 20, cardsY + 20, 60, "box", c, "running"),
		mark(xOf(4) + 50, cardsY + 50, 30, "you", c("primary"), c("on-primary"), 22),
		title(0, ["Something", "starts it"]),
		title(1, ["It waits", "in line"]),
		title(2, ["It is", "checked"]),
		title(3, ["The agent", "works"]),
		title(4, ["You", "decide"]),
		note(0, bodyY, ["A schedule, an", "issue, or you"]),
		note(1, bodyY, ["Nothing runs", "yet"]),
		note(2, bodyY, ["Over a limit?"]),
		badge(xOf(2) + 16, bodyY + 14, 138, "refused", "refused", c, "refused"),
		note(3, bodyY, ["In a sealed box"]),
		badge(xOf(3) + 14, bodyY + 14, 176, "stops to ask", "parked", c, "parked"),
		// Who decides is the point. Not "pi-dispatch never accepts it", which a cold reader took for the product always rejecting
		// the change. And not "it cannot be accepted": the job's token could, which is why branch protection is the real control
		// (README, GitHub automation).
		note(4, bodyY, ["A proposed", "change."]),
		note(4, bodyY + 56, ["You accept it,", "not pi-dispatch"], c("ink")),
		lit("oj-r0", xOf(0), cardsY, width, cardHeight, 26, c("line-strong")),
		lit("oj-r1", xOf(1), cardsY, width, cardHeight, 26, c("line-strong")),
		lit("oj-r2", xOf(2), cardsY, width, cardHeight, 26, c("line-strong")),
		lit("oj-r3", xOf(3), cardsY, width, cardHeight, 26, c("running")),
		lit("oj-r4", xOf(4), cardsY, width, cardHeight, 26, c("ok")),
		lit("oj-r5", xOf(2), cardsY, width, cardHeight, 26, c("refused")),
		lit("oj-r6", xOf(3) + 14, bodyY + 14, 176, 40, 20, c("parked")),
		// The rail: where the money goes, under the step it belongs to.
		cardAt(44, cardsY + cardHeight + 16, 1112, 130, c),
		box(68, railY - 6, paidFrom - 68 - 4, 12, 6, `fill="${c("surface-3")}"`),
		box(paidFrom, railY - 6, paidWidth, 12, 6, `fill="${c("running-tint")}"`),
		box(paidFrom + paidWidth + 4, railY - 6, 1132 - paidFrom - paidWidth - 4, 12, 6, `fill="${c("surface-3")}"`),
		`<g class="oj-fill-on">${box(paidFrom, railY - 6, paidWidth, 12, 6, `class="oj-fill" fill="${c("running")}"`)}</g>`,
		text((68 + paidFrom) / 2, railY + 56, "No AI cost", { size: 24, weight: 650, fill: c("ink-muted"), anchor: "middle" }),
		icon("spend", paidFrom + paidWidth / 2 - 62, railY + 36, 26, c("running-ink")),
		text(paidFrom + paidWidth / 2 + 14, railY + 56, "AI cost", { size: 24, weight: 750, fill: c("running-ink"), anchor: "middle" }),
		text((paidFrom + paidWidth + 1132) / 2, railY + 56, "No AI cost", { size: 24, weight: 650, fill: c("ink-muted"), anchor: "middle" }),
		// The job that makes it, and the one that does not.
		`<g transform="translate(0 ${railY})"><g class="oj-a"><g class="oj-a-on">`,
		`<g class="oj-wait">${jobPill(pill, "job 1", c("surface"), c("ink"), { dashed: c("line-strong") })}</g>`,
		`<g class="oj-run">${jobPill(pill, "job 1", c("running"), c("on-running"))}</g>`,
		`<g class="oj-ask">${jobPill(pill, "job 1", c("parked"), c("on-parked"))}</g>`,
		`<g class="oj-done">${jobPill(pill, "job 1", c("surface-3"), c("ink"))}</g>`,
		`</g></g></g>`,
		`<g transform="translate(0 ${railY})"><g class="oj-b"><g class="oj-b-on">`,
		`<g class="oj-b-wait">${jobPill(pill, "job 2", c("surface"), c("ink"), { dashed: c("line-strong") })}</g>`,
		`<g class="oj-b-no">${jobPill(pill, "job 2", c("refused"), c("on-refused"))}</g>`,
		`</g></g></g>`,
	].join("");
	return { height, seconds, stillAt: 0.45, css, body: page(height, c, "One job, from start to finish", "You pay for AI only while the agent works, not while it waits for you.", body) };
}

/** A loop of work as a racetrack, clockwise from the middle of its left end, so the right end is exactly half way round. */
const racetrack = (x0, x1, cy, r) => `M${x0} ${cy}A${r} ${r} 0 0 1 ${x0 + r} ${cy - r}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${cy}A${r} ${r} 0 0 1 ${x1 - r} ${cy + r}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${cy}z`;
/**
 * The work's place on the track: its centre at `laps` times round, for a dash 8 long on a path measured as 100. That is
 * shorter than a stop is wide, so the work disappears behind a stop while it is there instead of showing at both sides.
 */
const onTrack = (laps) => `stroke-dashoffset:${4 - laps * 100}`;
/** Opacity on during each window of the loop, with a short fade each side. */
const during = (windows, fade = 1) => [[0, "opacity:0"], ...windows.flatMap(([from, to]) => [[Math.max(from - fade, 0.01), "opacity:0"], [from, "opacity:1"], [to, "opacity:1"], [Math.min(to + fade, 99.99), "opacity:0"]]), [100, "opacity:0"]];

/**
 * Picture 2: one loop of work, three times, one above the other, so the only thing that changes is where you stand and
 * what the loop needs from you. Stacked rows, not three columns: side by side there was no room to stand far away, and
 * rings read as loading spinners. In the loop you are on the track, so everything passes you and you can step in, but the
 * work does not wait for you: a running job only reads a message when one is sent (`docs/steering.md`). Near it, the work
 * really stops while it asks: nothing runs and no model is paid for. Out of it, a second agent is on the track instead of
 * you, and only what it has reviewed travels to you. It says "reviews", never "approves": a self-approval would be a merge
 * by another name (`CONST-MERGE-NEVER-AUTOMATIC`), and the final say stays yours.
 */
function howCloseYouStay(c) {
	const seconds = 9;
	const height = 792;
	const rowH = 166;
	const rowY = (i) => 156 + i * (rowH + 12);
	const middle = (i) => rowY(i) + rowH / 2;
	const x0 = 510;
	const x1 = 810;
	const bend = 52;
	const nearYou = 904;
	const farYou = 1104;
	const css = [
		// In the loop: it keeps going, past you each time round, and once you step in.
		frames("hc-in", [[0, onTrack(0)], [100, onTrack(3)]]),
		frames("hc-in-you", during([[15, 18.5], [48.5, 51.5], [81.5, 85]])),
		frames("hc-in-pi", during([[32, 35], [64.5, 69]])),
		frames("hc-step", [[0, "transform:translateX(0);opacity:0"], [52, "transform:translateX(0);opacity:0"], [53, "transform:translateX(0);opacity:1"], [64, `transform:translateX(${72 - (x1 - x0)}px);opacity:1`], [65, `transform:translateX(${72 - (x1 - x0)}px);opacity:0`], [100, `transform:translateX(${72 - (x1 - x0)}px);opacity:0`]]),
		// Near the loop: once round alone, then it reaches something it cannot decide, stops, and asks.
		frames("hc-near", [[0, onTrack(0)], [13, onTrack(0.5)], [26, onTrack(1)], [39, onTrack(1.5)], [70, onTrack(1.5)], [85, onTrack(2.25)], [100, onTrack(3)]]),
		frames("hc-ask", [[0, "transform:translate(0,0);opacity:0"], [39, "transform:translate(0,0);opacity:0"], [41, "transform:translate(0,0);opacity:1"], [47, "transform:translate(58px,-46px);opacity:1"], [61, "transform:translate(58px,-46px);opacity:1"], [63, "transform:translate(58px,-46px);opacity:0"], [100, "transform:translate(58px,-46px);opacity:0"]]),
		frames("hc-near-you", during([[47, 63]])),
		frames("hc-reply", [[0, "transform:translateX(0);opacity:0"], [62, "transform:translateX(0);opacity:0"], [63, "transform:translateX(0);opacity:1"], [69, "transform:translateX(-30px);opacity:1"], [70, "transform:translateX(-30px);opacity:0"], [100, "transform:translateX(-30px);opacity:0"]]),
		frames("hc-asks", during([[39, 70]])),
		// Out of the loop: writes, reviews, answers the review, reviews again, and only then does anything reach you.
		frames("hc-out", [[0, onTrack(0)], [15, onTrack(0.5)], [20, onTrack(0.5)], [35, onTrack(1)], [50, onTrack(1.5)], [98, onTrack(1.5)], [100, onTrack(2)]]),
		frames("hc-out-on", [[0, "opacity:0"], [1.5, "opacity:1"], [56, "opacity:1"], [60, "opacity:0"], [100, "opacity:0"]]),
		frames("hc-out-review", during([[15, 20], [50, 58]])),
		frames("hc-out-write", during([[0.5, 3], [35, 38]])),
		frames("hc-doc", [[0, "transform:translateX(0);opacity:0"], [57, "transform:translateX(0);opacity:0"], [59, "transform:translateX(0);opacity:1"], [81, `transform:translateX(${farYou - 38 - 54 - (x1 + 40 + 54)}px);opacity:1`], [83, `transform:translateX(${farYou - 38 - 54 - (x1 + 40 + 54)}px);opacity:0`], [100, `transform:translateX(${farYou - 38 - 54 - (x1 + 40 + 54)}px);opacity:0`]]),
		frames("hc-out-you", during([[82, 97]])),
		`.hc-in{animation:${steady("hc-in", seconds)}}.hc-step{animation:${eased("hc-step", seconds)}}.hc-near{animation:${eased("hc-near", seconds)}}.hc-ask{animation:${eased("hc-ask", seconds)}}.hc-reply{animation:${eased("hc-reply", seconds)}}.hc-doc{animation:${eased("hc-doc", seconds)}}`,
		["hc-in-you", "hc-in-pi", "hc-near-you", "hc-asks", "hc-out-review", "hc-out-write", "hc-out-you"].map((name) => `.${name}{animation:${steady(name, seconds)}}`).join(""),
		// One element, two animations: where the work is on the track, and whether it is showing.
		`.hc-out-on{animation:${eased("hc-out", seconds)},${steady("hc-out-on", seconds)}}`,
	].join("");
	/** The loop: a track with its direction on it, and the work going round. */
	const loop = (i, tone, klass) => {
		const cy = middle(i);
		const chevron = (x, y, direction) => `<path d="M${x - 5 * direction} ${y - 7}L${x + 5 * direction} ${y}L${x - 5 * direction} ${y + 7}" fill="none" stroke="${c("ink-faint")}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
		return [
			`<path d="${racetrack(x0, x1, cy, bend)}" fill="${c(`${tone}-tint`)}" stroke="${c("surface-3")}" stroke-width="10"/>`,
			chevron((x0 + x1) / 2, cy - bend, 1),
			chevron((x0 + x1) / 2, cy + bend, -1),
			`<path class="${klass}" d="${racetrack(x0, x1, cy, bend)}" pathLength="100" fill="none" stroke="${c(tone)}" stroke-width="10" stroke-linecap="round" stroke-dasharray="8 92"/>`,
		].join("");
	};
	/** A stop on the track: a mark with a gap around it, and a halo that lights while the work is there. */
	const stop = (x, cy, word, fill, ink, halo = null, ring = null) => [
		`<circle cx="${x}" cy="${cy}" r="35" fill="${c("surface")}"/>`,
		halo === null ? "" : `<circle class="${halo}" cx="${x}" cy="${cy}" r="35" fill="none" stroke="${ring}" stroke-width="4"/>`,
		mark(x, cy, 30, word, fill, ink, word === "you" ? 22 : 28),
	].join("");
	const inside = (x, cy, word, anchor) => text(x, cy + 8, word, { size: 22, weight: 650, fill: c("ink"), anchor });
	const say = (i, rows) => lines(68, rowY(i) + 98, rows, { leading: 32, size: 24, fill: c("ink") });
	const you = () => [c("primary"), c("on-primary")];
	const body = [
		...[0, 1, 2].map((i) => cardAt(44, rowY(i), 1112, rowH, c)),
		badge(66, rowY(0) + 20, 172, "In the loop", "running", c, "running"),
		badge(66, rowY(1) + 20, 194, "Near the loop", "parked", c, "parked"),
		badge(66, rowY(2) + 20, 202, "Out of the loop", "bolt", c, "ok"),
		say(0, ["You watch it work", "and step in."]),
		say(1, ["It works alone, and stops to", "ask when it needs you."]),
		say(2, ["It starts without you. A second", "agent reviews it. Then you decide."]),
		// In the loop: you are on the track, and what you say crosses to the agent.
		loop(0, "running", "hc-in"),
		stop(x0, middle(0), "pi", c("running"), c("on-running"), "hc-in-pi", c("running")),
		stop(x1, middle(0), "you", ...you(), "hc-in-you", c("running")),
		inside(x0 + 46, middle(0), "works", "start"),
		inside(x1 - 46, middle(0), "watches", "end"),
		`<g transform="translate(${x1 - 36} ${middle(0) + 28})"><circle class="hc-step" r="6" fill="${c("primary")}"/></g>`,
		// Near the loop: you stand just beside it, and it stops at what it cannot decide.
		loop(1, "parked", "hc-near"),
		stop(x0, middle(1), "pi", c("parked"), c("on-parked")),
		`<circle cx="${x1}" cy="${middle(1)}" r="35" fill="${c("surface")}"/><circle class="hc-asks" cx="${x1}" cy="${middle(1)}" r="35" fill="none" stroke="${c("parked")}" stroke-width="4"/><circle cx="${x1}" cy="${middle(1)}" r="30" fill="${c("parked")}"/>${icon("parked", x1 - 19, middle(1) - 19, 38, c("on-parked"))}`,
		inside(x0 + 46, middle(1), "works", "start"),
		inside(x1 - 46, middle(1), "asks", "end"),
		`<path d="M${x1 + 40} ${middle(1)}H${nearYou - 38}" stroke="${c("line-strong")}" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round"/>`,
		stop(nearYou, middle(1), "you", ...you(), "hc-near-you", c("parked")),
		`<g transform="translate(${x1} ${middle(1)})"><g class="hc-ask"><circle r="20" fill="${c("parked")}" stroke="${c("surface")}" stroke-width="3"/>${icon("parked", -13, -13, 26, c("on-parked"))}</g></g>`,
		`<g transform="translate(${nearYou - 36} ${middle(1)})"><circle class="hc-reply" r="7" fill="${c("primary")}"/></g>`,
		// Out of the loop: a second agent on the track where you were, and you far away.
		loop(2, "ok", "hc-out hc-out-on"),
		stop(x0, middle(2), "pi", c("ok"), c("on-ok"), "hc-out-write", c("ok")),
		stop(x1, middle(2), "pi", c("ok"), c("on-ok"), "hc-out-review", c("ok")),
		inside(x0 + 46, middle(2), "works", "start"),
		inside(x1 - 46, middle(2), "reviews", "end"),
		`<path d="M${x1 + 40} ${middle(2)}H${farYou - 38}" stroke="${c("line-strong")}" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round"/>`,
		text((x1 + 40 + farYou - 38) / 2, middle(2) - 24, "reviewed by AI", { size: 22, weight: 650, fill: c("ok-ink"), anchor: "middle" }),
		stop(farYou, middle(2), "you", ...you(), "hc-out-you", c("ok")),
		`<g transform="translate(${x1 + 40 + 54} ${middle(2)})"><g class="hc-doc">${jobPill(108, "change", c("ok"), c("on-ok"))}</g></g>`,
		// What does not change.
		cardAt(44, rowY(2) + rowH + 12, 1112, 66, c),
		text(68, rowY(2) + rowH + 54, "At every stage", { size: 24, weight: 650, fill: c("ink") }),
		icon("spend", 258, rowY(2) + rowH + 32, 26, c("ink-muted")),
		text(292, rowY(2) + rowH + 54, "a spending limit", { size: 24, fill: c("ink") }),
		icon("box", 508, rowY(2) + rowH + 32, 26, c("ink-muted")),
		text(542, rowY(2) + rowH + 54, "a sealed box", { size: 24, fill: c("ink") }),
		icon("done", 714, rowY(2) + rowH + 32, 26, c("ink-muted")),
		text(748, rowY(2) + rowH + 54, "the final say stays yours", { size: 24, fill: c("ink") }),
	].join("");
	return { height, seconds, stillAt: 0.66, css, body: page(height, c, "Decide how closely you watch", "Step back one kind of work at a time, at your own pace.", body) };
}

/**
 * Picture 3: a job has to fit inside every limit. It says "stops before", never "cannot pass": `docs/costs.md` names what
 * the caps do not cover, which is why the provider's own limit is drawn at all. That ring is dashed because pi-dispatch
 * neither sets nor enforces it.
 */
function limitsInsideLimits(c) {
	const seconds = 10;
	const height = 620;
	const css = [
		frames("ll-a", [[0, "transform:translateX(116px);opacity:0"], [2, "transform:translateX(116px);opacity:1"], [13, "transform:translateX(304px);opacity:1"], [15, "transform:translateX(304px);opacity:0"], [100, "transform:translateX(304px);opacity:0"]]),
		frames("ll-b", [[0, "transform:translateX(116px);opacity:0"], [24, "transform:translateX(116px);opacity:0"], [26, "transform:translateX(116px);opacity:1"], [37, "transform:translateX(304px);opacity:1"], [39, "transform:translateX(304px);opacity:0"], [100, "transform:translateX(304px);opacity:0"]]),
		frames("ll-c", [[0, "transform:translateX(116px);opacity:0"], [62, "transform:translateX(116px);opacity:0"], [64, "transform:translateX(116px);opacity:1"], [72, "transform:translateX(236px);opacity:1"], [96, "transform:translateX(236px);opacity:1"], [98, "transform:translateX(236px);opacity:0"], [100, "transform:translateX(236px);opacity:0"]]),
		frames("ll-c-wait", [[0, "opacity:1"], [72, "opacity:1"], [73.5, "opacity:0"], [100, "opacity:0"]]),
		frames("ll-c-no", [[0, "opacity:0"], [72, "opacity:0"], [73.5, "opacity:1"], [100, "opacity:1"]]),
		frames("ll-all", [[0, "transform:scaleX(.18)"], [15, "transform:scaleX(.18)"], [34, "transform:scaleX(.55)"], [39, "transform:scaleX(.55)"], [58, "transform:scaleX(1)"], [96, "transform:scaleX(1)"], [100, "transform:scaleX(.18)"]]),
		frames("ll-all-tone", [[0, "opacity:0"], [56, "opacity:0"], [58, "opacity:1"], [96, "opacity:1"], [99, "opacity:0"], [100, "opacity:0"]]),
		frames("ll-pro", [[0, "transform:scaleX(.12)"], [15, "transform:scaleX(.12)"], [34, "transform:scaleX(.36)"], [39, "transform:scaleX(.36)"], [58, "transform:scaleX(.62)"], [96, "transform:scaleX(.62)"], [100, "transform:scaleX(.12)"]]),
		// The job's own meter climbs a call at a time, and the call that could pass the cap is the one that does not happen.
		frames("ll-job", [[0, "transform:scaleX(0)"], [15, "transform:scaleX(0)"], [22, "transform:scaleX(.3)"], [28, "transform:scaleX(.3)"], [34, "transform:scaleX(.55)"], [40, "transform:scaleX(.55)"], [48, "transform:scaleX(.82)"], [96, "transform:scaleX(.82)"], [100, "transform:scaleX(0)"]]),
		frames("ll-next", onBetween(50, 60, 1)),
		frames("ll-stop", onBetween(48, 60)),
		frames("ll-wall", onBetween(72, 97)),
		`.ll-a{animation:${eased("ll-a", seconds)}}.ll-b{animation:${eased("ll-b", seconds)}}.ll-c{animation:${eased("ll-c", seconds)}}.ll-c-wait{animation:${steady("ll-c-wait", seconds)}}.ll-c-no{animation:${steady("ll-c-no", seconds)}}`,
		`.ll-meter{transform-box:fill-box;transform-origin:0 50%}.ll-all{animation:${eased("ll-all", seconds)}}.ll-pro{animation:${eased("ll-pro", seconds)}}.ll-job{animation:${eased("ll-job", seconds)}}.ll-all-tone{animation:${steady("ll-all-tone", seconds)}}`,
		`.ll-next{animation:${steady("ll-next", seconds)}}.ll-stop{animation:${steady("ll-stop", seconds)}}.ll-wall{animation:${steady("ll-wall", seconds)}}`,
	].join("");
	/** A level, as the console's bar: a quiet track, with the amount over it. */
	const meter = (x, y, width, klass, fill, track = "surface-3") => `${box(x, y, width, 14, 7, `fill="${c(track)}"`)}${box(x, y, width, 14, 7, `class="ll-meter ${klass}" fill="${fill}"`)}`;
	const left = 268;
	const outerW = 1156 - left;
	const meterX = 850;
	const meterW = 212;
	const laneY = 440;
	const body = [
		cardAt(44, 156, left - 44 - 12, 424, c),
		text(66, laneY - 40, "New jobs", { size: 22, weight: 650, fill: c("ink-muted") }),
		// The rings, from the one you set elsewhere to the one around a single job.
		box(left, 156, outerW, 424, 26, `fill="${c("surface")}" stroke="${c("line-strong")}" stroke-width="3" stroke-dasharray="12 10"`),
		`<path d="M66 ${laneY}H${left + 18}" stroke="${c("surface-3")}" stroke-width="6" stroke-linecap="round"/>`,
		text(left + 28, 200, "Your AI provider's limit", { size: 24, weight: 650, fill: c("ink") }),
		text(left + 306, 200, "You set it with them: your last line of defence", { size: 22, fill: c("ink-muted") }),
		cardAt(left + 18, 222, outerW - 36, 340, c, "surface-2"),
		text(left + 46, 268, "All your jobs", { size: 26, weight: 650, fill: c("ink") }),
		text(left + 216, 268, "per day, week and month", { size: 22, fill: c("ink-muted") }),
		meter(meterX, 254, meterW, "ll-all", c("ok"), "surface-3"),
		box(meterX, 254, meterW, 14, 7, `class="ll-all-tone" fill="${c("refused")}"`),
		cardAt(left + 40, 292, outerW - 80, 250, c, "surface-3", 22),
		text(left + 68, 336, "One project", { size: 26, weight: 650, fill: c("ink") }),
		text(left + 222, 336, "with its own limits", { size: 22, fill: c("ink-muted") }),
		meter(meterX, 322, meterW, "ll-pro", c("ok"), "surface"),
		box(left + 62, 360, outerW - 124, 160, 16, `fill="${c("running-tint")}" stroke="${c("running")}" stroke-width="3"`),
		mark(left + 122, 440, 36, "pi", c("running"), c("on-running"), 30),
		text(left + 180, 424, "One job with its own limit", { size: 26, weight: 650, fill: c("ink") }),
		text(left + 180, 462, "stops before an AI call that could pass that limit.", { size: 22, fill: c("ink") }),
		meter(meterX, 414, meterW, "ll-job", c("running"), "surface"),
		box(meterX + meterW * 0.82 + 3, 414, meterW * 0.18 - 3, 14, 7, `class="ll-next" fill="none" stroke="${c("refused")}" stroke-width="2.5" stroke-dasharray="4 4"`),
		`<g class="ll-stop">${icon("refused", meterX + meterW - 26, 384, 26, c("refused-ink"))}</g>`,
		// The jobs: two go in, and the one after the limit is used up does not.
		`<g transform="translate(0 ${laneY})"><g class="ll-a">${jobPill(100, "job 1", c("running"), c("on-running"))}</g></g>`,
		`<g transform="translate(0 ${laneY})"><g class="ll-b">${jobPill(100, "job 2", c("running"), c("on-running"))}</g></g>`,
		`<g transform="translate(0 ${laneY})"><g class="ll-c"><g class="ll-c-wait">${jobPill(100, "job 3", c("surface"), c("ink"), { dashed: c("line-strong") })}</g><g class="ll-c-no">${jobPill(100, "job 3", c("refused"), c("on-refused"))}</g></g></g>`,
		`<g class="ll-wall">${lit("", left + 18, 222, outerW - 36, 340, 26, c("refused"))}</g>`,
		// What happens when one is used up.
		// "Does not fit", not "used up": with $1 left, a job holding a $5 limit is refused too (`docs/costs.md`, "One run, end to end").
		text(66, 196, "Does not fit?", { size: 24, weight: 700, fill: c("refused-ink") }),
		lines(66, 232, ["The job is", "refused before", "it starts.", "No AI cost."], { leading: 30, size: 22, fill: c("ink") }),
	].join("");
	return { height, seconds, stillAt: 0.8, css, body: page(height, c, "A job has to fit inside every limit", "You choose the limits. The job is checked against each of them.", body) };
}

/**
 * Picture 4: what crosses the wall of the box. The two keys are their own group, marked, because the agent can read them:
 * a safety picture that left them out would be the one thing here that misleads. "Your project" and not "a copy": a job
 * on a folder on your own machine edits that folder directly.
 */
function inAndOutOfTheBox(c) {
	const seconds = 9;
	const height = 712;
	const cardY = 156;
	const cardH = 360;
	const cardW = 376;
	const boxX = 490;
	const boxW = 220;
	const rows = [240, 296, 424, 480];
	const flow = (name, from, to, x0, x1) => frames(name, [[0, `transform:translateX(${x0}px);opacity:0`], [from, `transform:translateX(${x0}px);opacity:0`], [from + 1, `transform:translateX(${x0}px);opacity:1`], [to, `transform:translateX(${x1}px);opacity:1`], [to + 1, `transform:translateX(${x1}px);opacity:0`], [100, `transform:translateX(${x1}px);opacity:0`]]);
	const inFrom = cardW + 44;
	const outTo = 780;
	const css = [
		flow("bx-i0", 2, 12, inFrom, boxX),
		flow("bx-i1", 7, 17, inFrom, boxX),
		flow("bx-i2", 12, 22, inFrom, boxX),
		flow("bx-i3", 17, 27, inFrom, boxX),
		flow("bx-o0", 46, 56, boxX + boxW, outTo),
		flow("bx-o1", 52, 62, boxX + boxW, outTo),
		flow("bx-o2", 30, 40, boxX + boxW, outTo),
		frames("bx-probe", [[0, `transform:translateX(${boxX + boxW}px);opacity:0`], [36, `transform:translateX(${boxX + boxW}px);opacity:0`], [37, `transform:translateX(${boxX + boxW}px);opacity:1`], [44, `transform:translateX(${boxX + boxW + 26}px);opacity:1`], [50, `transform:translateX(${boxX + boxW + 26}px);opacity:1`], [51, `transform:translateX(${boxX + boxW + 26}px);opacity:0`], [100, `transform:translateX(${boxX + boxW + 26}px);opacity:0`]]),
		frames("bx-stop", onBetween(43, 52)),
		frames("bx-work", onBetween(28, 66, 3)),
		frames("bx-gone", [[0, "opacity:0"], [72, "opacity:0"], [78, "opacity:1"], [94, "opacity:1"], [98, "opacity:0"], [100, "opacity:0"]]),
		frames("bx-here", [[0, "opacity:1"], [72, "opacity:1"], [78, "opacity:0"], [94, "opacity:0"], [98, "opacity:1"], [100, "opacity:1"]]),
		frames("bx-pi", [[0, "opacity:1"], [72, "opacity:1"], [78, "opacity:.2"], [94, "opacity:.2"], [98, "opacity:1"], [100, "opacity:1"]]),
		frames("bx-spin", [[0, "transform:rotate(0deg)"], [28, "transform:rotate(0deg)"], [66, "transform:rotate(720deg)"], [100, "transform:rotate(720deg)"]]),
		["i0", "i1", "i2", "i3", "o0", "o1", "o2"].map((n) => `.bx-${n}{animation:${eased(`bx-${n}`, seconds)}}`).join(""),
		`.bx-probe{animation:${eased("bx-probe", seconds)}}.bx-stop{animation:${steady("bx-stop", seconds)}}.bx-work{animation:${steady("bx-work", seconds)}}.bx-gone{animation:${steady("bx-gone", seconds)}}.bx-here{animation:${steady("bx-here", seconds)}}.bx-pi{animation:${steady("bx-pi", seconds)}}`,
	].join("");
	const row = (x, y, name, words, tone = null) => `${tile(x + 20, y - 24, 48, name, c, tone)}${text(x + 84, y + 8, words, { size: 24, fill: c("ink") })}`;
	const group = (x, y, words, fill = c("ink")) => text(x + 22, y, words, { size: 26, weight: 650, fill });
	const wire = (x0, x1, y, colour) => `<path d="M${x0} ${y}H${x1}" stroke="${colour}" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round"/>`;
	const dot = (klass, y, colour) => `<g transform="translate(0 ${y})"><circle class="${klass}" r="8" fill="${colour}"/></g>`;
	const leftX = 44;
	const rightX = 780;
	const boxY = cardY;
	const boxH = cardH;
	const cx = boxX + boxW / 2;
	const body = [
		cardAt(leftX, cardY, cardW, 172, c),
		cardAt(leftX, cardY + 184, cardW, cardH - 184, c),
		cardAt(rightX, cardY, cardW, 172, c),
		cardAt(rightX, cardY + 184, cardW, cardH - 184, c),
		group(leftX, 198, "Goes in"),
		row(leftX, rows[0], "folder", "Your project"),
		row(leftX, rows[1], "skill", "Instructions, read only"),
		group(leftX, 384, "And two keys it can read", c("attention-ink")),
		row(leftX, rows[2], "key", "Your AI provider key", "attention"),
		row(leftX, rows[3], "key", "GitHub or GitLab key", "attention"),
		group(rightX, 198, "Comes out"),
		row(rightX, rows[0], "edit", "A proposed change", "ok"),
		row(rightX, rows[1], "audit", "What it did and cost", "ok"),
		group(rightX, 384, "It can reach"),
		row(rightX, rows[2], "globe", "Only addresses you allow", "ok"),
		row(rightX, rows[3], "refused", "Nothing else", "refused"),
		wire(leftX + cardW + 4, boxX - 4, rows[0], c("line-strong")),
		wire(leftX + cardW + 4, boxX - 4, rows[1], c("line-strong")),
		wire(leftX + cardW + 4, boxX - 4, rows[2], c("attention")),
		wire(leftX + cardW + 4, boxX - 4, rows[3], c("attention")),
		wire(boxX + boxW + 4, rightX - 4, rows[0], c("line-strong")),
		wire(boxX + boxW + 4, rightX - 4, rows[1], c("line-strong")),
		wire(boxX + boxW + 4, rightX - 4, rows[2], c("line-strong")),
		wire(boxX + boxW + 4, boxX + boxW + 26, rows[3], c("refused")),
		// The box, and the same box once the job has ended: gone, with only where it stood left.
		`<g class="bx-here">${box(boxX, boxY, boxW, boxH, 26, `fill="${c("running-tint")}" stroke="${c("running")}" stroke-width="6"`)}</g>`,
		`<g class="bx-gone">${box(boxX, boxY, boxW, boxH, 26, `fill="none" stroke="${c("line-strong")}" stroke-width="3" stroke-dasharray="10 10"`)}</g>`,
		text(cx, boxY + 42, "The sealed box", { size: 26, weight: 650, fill: c("ink"), anchor: "middle" }),
		text(cx, boxY + 76, "thrown away", { size: 22, fill: c("ink-muted"), anchor: "middle" }),
		text(cx, boxY + 104, "afterwards", { size: 22, fill: c("ink-muted"), anchor: "middle" }),
		`<g class="bx-work"><circle cx="${cx}" cy="${boxY + 212}" r="54" fill="none" stroke="${c("line-strong")}" stroke-opacity=".35" stroke-width="6"/><circle cx="${cx}" cy="${boxY + 212}" r="54" fill="none" stroke="${c("running")}" stroke-width="6" stroke-linecap="round" stroke-dasharray="84 255" style="transform-origin:${cx}px ${boxY + 212}px;animation:${steady("bx-spin", seconds)}"/></g>`,
		`<g class="bx-pi">${mark(cx, boxY + 212, 40, "pi", c("running"), c("on-running"), 32)}</g>`,
		text(cx, boxY + 306, "agent", { size: 24, weight: 650, fill: c("ink"), anchor: "middle" }),
		dot("bx-i0", rows[0], c("ink-muted")),
		dot("bx-i1", rows[1], c("ink-muted")),
		dot("bx-i2", rows[2], c("attention")),
		dot("bx-i3", rows[3], c("attention")),
		dot("bx-o0", rows[0], c("ok")),
		dot("bx-o1", rows[1], c("ok")),
		dot("bx-o2", rows[2], c("ok")),
		dot("bx-probe", rows[3], c("refused")),
		`<g class="bx-stop">${icon("refused", boxX + boxW + 34, rows[3] - 15, 30, c("refused-ink"))}</g>`,
		// The two things to know.
		box(44, 532, 1112, 66, 18, `fill="${c("refused-tint")}"`),
		icon("refused", 66, 551, 28, c("refused-ink")),
		text(106, 574, "Stays out: your other files and your other passwords.", { size: 24, weight: 600, fill: c("refused-ink") }),
		box(44, 610, 1112, 66, 18, `fill="${c("attention-tint")}"`),
		icon("attention", 66, 629, 28, c("attention-ink")),
		text(106, 652, "The agent can read both keys. Limit what each key can do, so a leak does less harm.", { size: 24, weight: 600, fill: c("attention-ink") }),
	].join("");
	return { height, seconds, stillAt: 0.5, css, body: page(height, c, "What goes in the box, and what comes out", "A fresh box for every job.", body) };
}

/**
 * Opacity for a state a thing holds during `windows` of the loop. Unlike `during`, a window may touch either end, so a thing
 * that is on as the loop ends is on as it starts and the loop closes without a blink.
 */
const holding = (windows, fade = 0.6) => {
	const rows = [];
	if (windows.length === 0 || windows[0][0] > 0) rows.push([0, "opacity:0"]);
	for (const [from, to] of windows) {
		if (from > 0) rows.push([from - fade, "opacity:0"], [from, "opacity:1"]);
		else rows.push([0, "opacity:1"]);
		if (to < 100) rows.push([to, "opacity:1"], [to + fade, "opacity:0"]);
		else rows.push([100, "opacity:1"]);
	}
	if (windows.length === 0 || windows.at(-1)[1] < 100) rows.push([100, "opacity:0"]);
	return rows;
};

/**
 * Picture 5: what a swarm looks like from where you stand. The eight boxes are the point: at no moment is anything asking for
 * your eyes except the one count that needs you. It says "works, asks, reviews", and never that agents talk to each other,
 * because they do not: pi-dispatch looks after them and does not direct them (`docs/replicas.md`: neither replica knows what
 * the other did). The switch is drawn because it is what makes a swarm safe to leave: it stops new work, running jobs finish
 * (`docs/service.md`), and the line holds and then moves again, so nothing is dropped.
 */
function manyAtOnce(c) {
	const seconds = 12;
	const height = 564;
	const paused = [58, 80];
	// Each box's day, in percent of the loop: state, from, to. Nothing starts during the pause. What holds at 100 holds at 0.
	const DAY = [
		[["works", 0, 24], ["works", 30, 62], ["works", 82, 100]],
		[["reviews", 0, 14], ["works", 20, 52], ["reviews", 86, 100]],
		[["works", 10, 40], ["asks", 40, 56], ["works", 56, 70]],
		[["works", 0, 34], ["reviews", 44, 66], ["works", 84, 100]],
		[["asks", 0, 18], ["works", 18, 46], ["works", 54, 74], ["works", 84, 94], ["asks", 94, 100]],
		[["works", 0, 12], ["works", 26, 58], ["works", 82, 100]],
		[["reviews", 6, 30], ["works", 36, 68]],
		[["reviews", 0, 8], ["works", 16, 50], ["works", 56, 72], ["reviews", 88, 100]],
	];
	// A job starts where a box goes from open to busy. An answer picks up the same job, so it is no start.
	const starts = DAY.flatMap((day, i) => day.filter(([, from], at) => from > 0 && (at === 0 || day[at - 1][2] < from)).map(([, from]) => ({ box: i, at: from }))).sort((a, b) => a.at - b.at);
	const answers = DAY.flatMap((day, i) => day.filter(([state]) => state === "asks").filter(([, , to]) => to < 100).map(([, , to]) => ({ box: i, at: to })));
	/** Which moments of the loop a count holds, read from the boxes, so the page in the picture cannot disagree with its floor. */
	const countWindows = (states) => {
		const edges = [...new Set([0, 100, ...DAY.flatMap((day) => day.flatMap(([, from, to]) => [from, to]))])].sort((a, b) => a - b);
		const value = (t) => DAY.filter((day) => day.some(([state, from, to]) => states.includes(state) && from <= t && t < to)).length;
		const windows = new Map();
		for (let i = 0; i + 1 < edges.length; i++) {
			const n = value(edges[i]);
			const list = windows.get(n) ?? [];
			if (list.length > 0 && list.at(-1)[1] === edges[i]) list.at(-1)[1] = edges[i + 1];
			else list.push([edges[i], edges[i + 1]]);
			windows.set(n, list);
		}
		return windows;
	};
	const slotW = 117;
	const slotH = 84;
	const slotX = (i) => 314 + (i % 4) * (slotW + 12);
	const slotY = (i) => (i < 4 ? 246 : 374);
	const laneEnd = 264;
	const laneY = 476;
	const step = 72;
	// The line: it moves one place for every job that starts, and stands still while new work is stopped.
	const laneRows = [[0, "transform:translateX(0)"]];
	let moved = 0;
	let previous = 0;
	for (const at of [...new Set(starts.map((s) => s.at))]) {
		laneRows.push([Math.max(previous, at - 2.5), `transform:translateX(${moved}px)`]);
		moved += step * starts.filter((s) => s.at === at).length;
		laneRows.push([at, `transform:translateX(${moved}px)`]);
		previous = at;
	}
	laneRows.push([100, `transform:translateX(${moved}px)`]);
	const hop = (name, from, to, at, span = 3) => frames(name, [
		[0, `transform:translate(${from[0]}px,${from[1]}px);opacity:0`],
		[at - span, `transform:translate(${from[0]}px,${from[1]}px);opacity:0`],
		[at - span + 0.5, `transform:translate(${from[0]}px,${from[1]}px);opacity:1`],
		[at, `transform:translate(${to[0]}px,${to[1]}px);opacity:1`],
		[at + 0.5, `transform:translate(${to[0]}px,${to[1]}px);opacity:0`],
		[100, `transform:translate(${to[0]}px,${to[1]}px);opacity:0`],
	]);
	const middleOf = (i) => [slotX(i) + slotW / 2, slotY(i) + slotH / 2];
	const needsYouAt = [1110, 240];
	const running = countWindows(["works", "reviews"]);
	const needing = countWindows(["asks"]);
	const STATES = ["works", "asks", "reviews"];
	// A count changes at once: the new digit starts as the old one ends, so no frame of the loop shows both.
	const digit = (windows) => holding(windows.map(([from, to]) => [from > 0 ? from + 0.05 : from, to]), 0.05);
	const css = [
		frames("mm-lane", laneRows),
		...DAY.flatMap((day, i) => STATES.map((state) => frames(`mm-${i}-${state}`, holding(day.filter(([s]) => s === state).map(([, from, to]) => [from, to]))))),
		...starts.map((s, n) => hop(`mm-start-${n}`, [laneEnd, laneY], middleOf(s.box), s.at)),
		...answers.map((s, n) => hop(`mm-answer-${n}`, needsYouAt, middleOf(s.box), s.at, 4)),
		...[...running].map(([n, windows]) => frames(`mm-run-${n}`, digit(windows))),
		...[...needing].map(([n, windows]) => frames(`mm-need-${n}`, digit(windows))),
		frames("mm-need-on", holding([...needing].filter(([n]) => n > 0).flatMap(([, windows]) => windows).sort((a, b) => a[0] - b[0]))),
		frames("mm-off", holding([paused])),
		frames("mm-on", holding([[0, paused[0]], [paused[1], 100]])),
		frames("mm-knob", [[0, "transform:translateX(36px)"], [paused[0] - 1, "transform:translateX(36px)"], [paused[0], "transform:translateX(0)"], [paused[1] - 1, "transform:translateX(0)"], [paused[1], "transform:translateX(36px)"], [100, "transform:translateX(36px)"]]),
		frames("mm-spend", [[0, "transform:scaleX(.3)"], [58, "transform:scaleX(.72)"], [80, "transform:scaleX(.78)"], [97, "transform:scaleX(.9)"], [100, "transform:scaleX(.3)"]]),
		`.mm-lane{animation:${eased("mm-lane", seconds)}}.mm-knob{animation:${eased("mm-knob", seconds)}}.mm-spend{transform-box:fill-box;transform-origin:0 50%;animation:${eased("mm-spend", seconds)}}.mm-off{animation:${steady("mm-off", seconds)}}.mm-on{animation:${steady("mm-on", seconds)}}.mm-need-on{animation:${steady("mm-need-on", seconds)}}`,
		DAY.flatMap((_, i) => STATES.map((state) => `.mm-${i}-${state}{animation:${steady(`mm-${i}-${state}`, seconds)}}`)).join(""),
		starts.map((_, n) => `.mm-start-${n}{animation:${eased(`mm-start-${n}`, seconds)}}`).join(""),
		answers.map((_, n) => `.mm-answer-${n}{animation:${eased(`mm-answer-${n}`, seconds)}}`).join(""),
		[...running.keys()].map((n) => `.mm-run-${n}{animation:${steady(`mm-run-${n}`, seconds)}}`).join(""),
		[...needing.keys()].map((n) => `.mm-need-${n}{animation:${steady(`mm-need-${n}`, seconds)}}`).join(""),
	].join("");
	/** One box of the floor: open underneath, and a state on top of it while it holds one. */
	const slot = (i) => {
		const [x, y] = [slotX(i), slotY(i)];
		const cx = x + slotW / 2;
		const busy = (state, tone, inner) => `<g class="mm-${i}-${state}">${box(x, y, slotW, slotH, 16, `fill="${c(`${tone}-tint`)}" stroke="${c(tone)}" stroke-width="3"`)}${inner}${text(cx, y + 74, state, { size: 22, weight: 650, fill: c("ink"), anchor: "middle" })}</g>`;
		return [
			box(x, y, slotW, slotH, 16, `fill="${c("surface-2")}" stroke="${c("line-strong")}" stroke-width="2" stroke-dasharray="6 6"`),
			text(cx, y + 50, "open", { size: 22, fill: c("ink-muted"), anchor: "middle" }),
			busy("works", "running", mark(cx, y + 28, 18, "pi", c("running"), c("on-running"), 22)),
			busy("asks", "parked", `<circle cx="${cx}" cy="${y + 28}" r="18" fill="${c("parked")}"/>${icon("parked", cx - 12, y + 16, 24, c("on-parked"))}`),
			busy("reviews", "ok", mark(cx, y + 28, 18, "pi", c("ok"), c("on-ok"), 22)),
		].join("");
	};
	const row = (y, name, words) => `${tile(66, y - 24, 48, name, c)}${text(126, y + 8, words, { size: 24, fill: c("ink") })}`;
	const body = [
		// New work, and the line it waits in.
		cardAt(44, 156, 236, 372, c),
		text(66, 198, "New work", { size: 26, weight: 650, fill: c("ink") }),
		row(244, "clock", "A schedule"),
		row(300, "issue", "An issue"),
		row(356, "comment", "A comment"),
		text(66, 432, "One line", { size: 22, weight: 650, fill: c("ink-muted") }),
		`<clipPath id="mm-clip"><rect x="52" y="450" width="220" height="52"/></clipPath>`,
		`<g clip-path="url(#mm-clip)"><g class="mm-lane">`,
		...Array.from({ length: Math.round(moved / step) + 5 }, (_, k) => `<g transform="translate(${laneEnd - 32 - k * step} ${laneY})">${jobPill(64, "job", c("surface"), c("ink"), { dashed: c("line-strong") })}</g>`),
		`</g></g>`,
		`<g class="mm-off">${box(52, 450, 220, 52, 14, `fill="none" stroke="${c("attention")}" stroke-width="3"`)}</g>`,
		// The floor.
		cardAt(292, 156, 548, 372, c),
		text(314, 198, "Each agent in its own box", { size: 26, weight: 650, fill: c("ink") }),
		text(314, 234, "Machine 1", { size: 22, weight: 650, fill: c("ink-muted") }),
		text(314, 362, "Machine 2", { size: 22, weight: 650, fill: c("ink-muted") }),
		...DAY.map((_, i) => slot(i)),
		text(314, 504, "One budget", { size: 22, weight: 650, fill: c("ink-muted") }),
		box(452, 490, 366, 14, 7, `fill="${c("surface-3")}"`),
		box(452, 490, 366, 14, 7, `class="mm-spend" fill="${c("ok")}"`),
		// Where you stand.
		cardAt(852, 156, 304, 372, c),
		mark(892, 196, 24, "you", c("primary"), c("on-primary"), 22),
		text(928, 205, "One page", { size: 26, weight: 650, fill: c("ink") }),
		`<g class="mm-need-on">${box(866, 226, 276, 46, 14, `fill="${c("parked-tint")}" stroke="${c("parked")}" stroke-width="3"`)}</g>`,
		text(880, 258, "Needs you", { size: 24, fill: c("ink") }),
		...[...needing.keys()].map((n) => `<g class="mm-need-${n}">${text(1128, 260, String(n), { size: 28, weight: 800, fill: c("parked-ink"), anchor: "end" })}</g>`),
		text(880, 310, "Running", { size: 24, fill: c("ink") }),
		...[...running.keys()].map((n) => `<g class="mm-run-${n}">${text(1128, 312, String(n), { size: 28, weight: 800, fill: c("running-ink"), anchor: "end" })}</g>`),
		`<path d="M874 336H1134" stroke="${c("line")}" stroke-width="2"/>`,
		text(880, 382, "One switch", { size: 26, weight: 650, fill: c("ink") }),
		`<g class="mm-on">${box(1056, 358, 72, 36, 18, `fill="${c("ok")}"`)}</g>`,
		`<g class="mm-off">${box(1056, 358, 72, 36, 18, `fill="${c("attention")}"`)}</g>`,
		`<g class="mm-knob"><circle cx="1074" cy="376" r="14" fill="${c("surface")}"/></g>`,
		// Said at full strength in every frame, on or off, so a reader who only ever sees it on still learns what off does.
		text(880, 428, "Off: new work waits,", { size: 22, fill: c("ink") }),
		text(880, 458, "running jobs finish.", { size: 22, fill: c("ink") }),
		`<g class="mm-off">${box(866, 402, 276, 70, 14, `fill="none" stroke="${c("attention")}" stroke-width="3"`)}</g>`,
		// Work going to a box, and an answer going to the one that asked.
		...starts.map((_, n) => `<g class="mm-start-${n}"><circle r="8" fill="${c("running")}" stroke="${c("surface")}" stroke-width="2"/></g>`),
		...answers.map((_, n) => `<g class="mm-answer-${n}"><circle r="8" fill="${c("primary")}" stroke="${c("surface")}" stroke-width="2"/></g>`),
	].join("");
	return { height, seconds, stillAt: 0.45, css, body: page(height, c, "Many agents, one place to run them", "A swarm works in the background. You look after it from one page.", body) };
}

/**
 * Picture 6: when to step back. It is the one question words answered badly ("when a kind of work rarely needs you": how
 * rarely?), so it shows what the Zero touch page gives you to judge by, over time. Each row is a project, not a kind of work,
 * because that is what the page counts (`REQ-ZERO-TOUCH-RATE`). The words under each number are the page's own, at the page's
 * own thresholds (`admin/src/console/panels/zero-touch.mjs`). THE NUMBER DOES NOT MOVE ANYONE. Nothing in the product moves a
 * project when it crosses the marker, and a project under the marker is a guide and not permission (`docs/zero-touch.md`). A
 * first draft ringed the row in green and then moved you, and a cold reader took that for the software doing it, so there is no
 * ring now: the number crosses, nothing happens, the words say it is your choice, and only then do you step. One line goes up, because a rate can, and then nobody steps anywhere. It starts and
 * ends on the finished state, so a reader who sees one frame sees the whole answer. One shared scale for all three rows, and
 * no number on any point but the last.
 */
function whenToStepBack(c) {
	const seconds = 10;
	const height = 672;
	const WEEKS = 8;
	const ROWS = [
		{ name: "ops", rates: [12, 10, 9, 7, 6, 5, 4, 3], stage: 1 },
		{ name: "web", rates: [28, 27, 25, 24, 22, 20, 18, 16], stage: 1 },
		{ name: "billing", rates: [22, 24, 23, 26, 28, 28, 30, 32], stage: 0 },
	];
	const STAGES = [["In the loop", "running"], ["Near the loop", "parked"], ["Out of the loop", "ok"]];
	const statusOf = (rate) => (rate < 5 ? ["Under goal", "done", "ok", 168] : rate < 30 ? ["Above goal", "attention", "attention", 172] : ["High", "attention", "failed", 100]);
	const rowH = 116;
	const rowY = (i) => 192 + i * (rowH + 10);
	const plotX = 176;
	const plotW = 464;
	const xOf = (week) => plotX + week * (plotW / (WEEKS - 1));
	const yOf = (i, rate) => rowY(i) + 14 + ((40 - rate) / 40) * 88;
	// The loop: the finished state, gone, then eight weeks drawn, then your step, then the finished state again.
	const heldUntil = 19.5;
	const drawFrom = 22;
	const drawTo = 66;
	const tOf = (week) => drawFrom + week * ((drawTo - drawFrom) / (WEEKS - 1));
	const choiceFrom = 70;
	const stepFrom = 78;
	const stepTo = 84;
	const lengths = (i) => {
		const rates = ROWS[i].rates;
		const parts = rates.slice(1).map((rate, w) => Math.hypot(xOf(w + 1) - xOf(w), yOf(i, rate) - yOf(i, rates[w])));
		const total = parts.reduce((a, b) => a + b, 0);
		let sum = 0;
		return [0, ...parts.map((part) => (sum += part) / total)];
	};
	/** While each value holds: the last one also holds through the start of the loop. Equal neighbours are one window. */
	const valueWindows = (keyOf, i) => {
		const windows = new Map();
		const rates = ROWS[i].rates;
		const last = keyOf(rates.at(-1));
		windows.set(last, [[0, heldUntil]]);
		rates.forEach((rate, w) => {
			const key = keyOf(rate);
			const from = tOf(w);
			const to = w + 1 < WEEKS ? tOf(w + 1) : 100;
			const list = windows.get(key) ?? [];
			if (list.length > 0 && list.at(-1)[1] === from) list.at(-1)[1] = to;
			else list.push([from, to]);
			windows.set(key, list);
		});
		return windows;
	};
	const digit = (windows) => holding(windows.map(([from, to]) => [from > 0 ? from + 0.05 : from, to]), 0.05);
	const slug = (words) => String(words).toLowerCase().replace(/[^a-z0-9]+/g, "");
	const numbers = ROWS.map((_, i) => valueWindows((rate) => `${rate}%`, i));
	const statuses = ROWS.map((_, i) => valueWindows((rate) => statusOf(rate)[0], i));
	const trackX = (stage) => 908 + stage * 100;
	const css = [
		frames("zs-fade", [[0, "opacity:1"], [18.5, "opacity:1"], [20, "opacity:0"], [21, "opacity:0"], [drawFrom, "opacity:1"], [100, "opacity:1"]]),
		...ROWS.map((row, i) => {
			const cum = lengths(i);
			return frames(`zs-line-${i}`, [[0, "stroke-dashoffset:0"], [20, "stroke-dashoffset:0"], [20.1, "stroke-dashoffset:100"], [drawFrom, "stroke-dashoffset:100"], ...cum.slice(1).map((share, w) => [tOf(w + 1), `stroke-dashoffset:${(1 - share) * 100}`]), [100, "stroke-dashoffset:0"]]);
		}),
		...ROWS.map((row, i) => {
			const at = (w) => `transform:translate(${xOf(w)}px,${yOf(i, row.rates[w])}px)`;
			return frames(`zs-dot-${i}`, [[0, at(WEEKS - 1)], [20, at(WEEKS - 1)], [20.1, at(0)], [drawFrom, at(0)], ...row.rates.slice(1).map((_, w) => [tOf(w + 1), at(w + 1)]), [100, at(WEEKS - 1)]]);
		}),
		...numbers.flatMap((map, i) => [...map].map(([key, windows]) => frames(`zs-n-${i}-${slug(key)}`, digit(windows)))),
		...statuses.flatMap((map, i) => [...map].map(([key, windows]) => frames(`zs-s-${i}-${slug(key)}`, digit(windows)))),
		// Your step, on the one row that crossed the marker. It comes after the number, and is yours.
		frames("zs-you", [[0, "transform:translateX(100px);opacity:1"], [18.5, "transform:translateX(100px);opacity:1"], [20, "transform:translateX(100px);opacity:0"], [20.1, "transform:translateX(0);opacity:0"], [21.5, "transform:translateX(0);opacity:1"], [stepFrom, "transform:translateX(0);opacity:1"], [stepTo, "transform:translateX(100px);opacity:1"], [100, "transform:translateX(100px);opacity:1"]]),
		frames("zs-near", digit([[20.1, choiceFrom]])),
		frames("zs-choice", digit([[choiceFrom, stepTo]])),
		frames("zs-out", digit([[0, 20], [stepTo, 100]])),
		`.zs-fade{animation:${steady("zs-fade", seconds)}}.zs-you{animation:${eased("zs-you", seconds)}}.zs-near{animation:${steady("zs-near", seconds)}}.zs-out{animation:${steady("zs-out", seconds)}}.zs-choice{animation:${steady("zs-choice", seconds)}}`,
		ROWS.map((_, i) => `.zs-line-${i}{animation:${steady(`zs-line-${i}`, seconds)}}.zs-dot-${i}{animation:${steady(`zs-dot-${i}`, seconds)}}`).join(""),
		numbers.flatMap((map, i) => [...map.keys()].map((key) => `.zs-n-${i}-${slug(key)}{animation:${steady(`zs-n-${i}-${slug(key)}`, seconds)}}`)).join(""),
		statuses.flatMap((map, i) => [...map.keys()].map((key) => `.zs-s-${i}-${slug(key)}{animation:${steady(`zs-s-${i}-${slug(key)}`, seconds)}}`)).join(""),
	].join("");
	const stops = (y) => [
		`<path d="M${trackX(0)} ${y}H${trackX(2)}" stroke="${c("surface-3")}" stroke-width="6" stroke-linecap="round"/>`,
		...STAGES.map(([, tone], stage) => `<circle cx="${trackX(stage)}" cy="${y}" r="9" fill="${c(tone)}"/>`),
	].join("");
	const you = (x, y) => `<circle cx="${x}" cy="${y}" r="28" fill="${c("surface")}"/>${mark(x, y, 25, "you", c("primary"), c("on-primary"), 22)}`;
	const stageWord = (y, words) => text(trackX(1), y, words, { size: 22, weight: 650, fill: c("ink"), anchor: "middle" });
	const body = [
		text(plotX, 174, "Runs that needed a person, last 8 weeks", { size: 22, weight: 650, fill: c("ink-muted") }),
		text(668, 174, "Now", { size: 22, weight: 650, fill: c("ink-muted") }),
		text(trackX(0) - 24, 174, "You choose how close", { size: 22, weight: 650, fill: c("ink-muted") }),
		...ROWS.flatMap((row, i) => {
			const top = rowY(i);
			const points = row.rates.map((rate, w) => `${w === 0 ? "M" : "L"}${xOf(w)} ${yOf(i, rate)}`).join("");
			return [
				cardAt(44, top, 1112, rowH, c, "surface", 22),
				text(68, top + 66, row.name, { size: 26, weight: 650, fill: c("ink") }),
				`<path d="M${plotX} ${yOf(i, 5)}H${plotX + plotW}" stroke="${c("ok")}" stroke-width="2" stroke-dasharray="6 7"/>`,
				`<g class="zs-fade"><path class="zs-line-${i}" d="${points}" pathLength="100" fill="none" stroke="${c("ink")}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="100 100"/></g>`,
				`<g class="zs-fade"><g class="zs-dot-${i}"><circle r="7" fill="${c("ink")}" stroke="${c("surface")}" stroke-width="2"/></g></g>`,
				...[...numbers[i].keys()].map((key) => `<g class="zs-n-${i}-${slug(key)}">${text(668, top + 46, key, { size: 36, weight: 800, fill: c("ink"), track: "-0.02em" })}</g>`),
				...[...statuses[i].keys()].map((key) => {
					const [words, glyph, tone, width] = statusOf(row.rates.find((rate) => statusOf(rate)[0] === key));
					return `<g class="zs-s-${i}-${slug(key)}">${badge(664, top + 62, width, words, glyph, c, tone)}</g>`;
				}),
				stops(top + 42),
			];
		}),
		// You, and the word for where you are.
		`<g class="zs-you">${you(trackX(1), rowY(0) + 42)}</g>`,
		`<g class="zs-near">${stageWord(rowY(0) + 96, STAGES[1][0])}</g>`,
		`<g class="zs-out">${stageWord(rowY(0) + 96, STAGES[2][0])}</g>`,
		`<g class="zs-choice">${box(trackX(1) - 72, rowY(0) + 74, 144, 32, 16, `fill="${c("primary")}"`)}${text(trackX(1), rowY(0) + 97, "Your choice", { size: 22, weight: 700, fill: c("on-primary"), anchor: "middle" })}</g>`,
		you(trackX(1), rowY(1) + 42),
		stageWord(rowY(1) + 96, STAGES[1][0]),
		you(trackX(0), rowY(2) + 42),
		stageWord(rowY(2) + 96, STAGES[0][0]),
		// The sentence the picture exists to say.
		cardAt(44, rowY(2) + rowH + 12, 1112, 66, c, "surface", 22),
		icon("flag", 66, rowY(2) + rowH + 32, 26, c("ink-muted")),
		text(104, rowY(2) + rowH + 53, "Aim for zero. The dashed line at 5% is a guide, not permission: you decide.", { size: 24, weight: 600, fill: c("ink") }),
	].join("");
	return { height, seconds, stillAt: 0.1, css, body: page(height, c, "Step back when the numbers say you can", "Zero touch shows how often runs needed a person, per project. Sample data.", body) };
}

/**
 * Every picture, with its alt text (which the READMEs use unchanged) and its claims: `says` is words the picture holds,
 * and `needle` the sentence in `source` that makes them true. A picture is a restatement like any table, so
 * `admin/test/explainers.test.mjs` holds both ends: reword either and the test sends you to look at the other.
 */
export const EXPLAINERS = Object.freeze([
	Object.freeze({
		name: "one-job",
		alt: "An animation of one job in five steps, under the headline: you pay for AI only while the agent works. Something starts it: a schedule, an issue, or you. It waits in line, and nothing runs yet. It is checked: over a limit, it is refused. The agent works in a sealed box, and if it needs you it stops to ask. You decide on a proposed change: you accept it, not pi-dispatch. A strip under the steps shows no AI cost in the first three and the last, and AI cost only where the agent works. A job crosses the strip and it fills only there. A second job is refused at the check.",
		build: oneJob,
		claims: [
			{ says: "You accept it, not pi-dispatch", source: "README.md", needle: "Accepting a pull request into the project. pi-dispatch never does this" },
			{ says: "refused", source: "README.md", needle: "A job over a limit is refused before it starts" },
			{ says: "stops to ask", source: "README.md", needle: "A job with a question stops and waits. Nothing runs and no model is paid for while it waits" },
			{ says: "No AI cost", source: "specs/constitution.md", needle: "Every spend cap shall be checked and reserved **before** an agent run begins" },
		],
	}),
	Object.freeze({
		name: "how-close-you-stay",
		alt: "An animation of one loop of work drawn three times, one above the other, under the headline: decide how closely you watch. In the loop, you are on the track: you watch it work and step in, and a message from you crosses to the agent. Near the loop, you stand just beside it: it works alone and stops to ask when it needs you, and it waits until you answer. Out of the loop, you are far away: it starts without you, a second agent reviews it, and only the change, reviewed by AI, travels to you, and then you decide. At every stage: a spending limit, a sealed box, and the final say stays yours.",
		build: howCloseYouStay,
		claims: [
			{ says: "In the loop", source: "README.md", needle: "### 1. In the loop" },
			{ says: "Near the loop", source: "README.md", needle: "### 2. Near the loop" },
			{ says: "Out of the loop", source: "README.md", needle: "### 3. Out of the loop" },
			{ says: "the final say stays yours", source: "README.md", needle: "so what ships stays a person's decision" },
			{ says: "one kind of work at a time", source: "README.md", needle: "one kind of work at a time" },
			{ says: "second agent reviews it", source: "README.md", needle: "A second job can review a proposed change" },
			{ says: "reviewed by AI", source: "README.md", needle: "what reaches you has already been read by an AI" },
			{ says: "stops to ask", source: "README.md", needle: "A job with a question stops and waits" },
			{ says: "watch it work and step in", source: "README.md", needle: "If it heads the wrong way you tell it, and it reads your message before its next step" },
			{ says: "reviews", source: "docs/triggers.md", needle: '"flow": "review"' },
		],
	}),
	Object.freeze({
		name: "limits-inside-limits",
		alt: "An animation of limits drawn inside one another, under the headline: a job has to fit inside every limit. Innermost, one job with its own limit, which stops before an AI call that could pass that limit. Around it one project with its own limits, around that all your jobs per day, week and month, and outermost, dashed because you set it with them, your AI provider's limit, your last line of defence. Two jobs go in and the meters rise. A job that does not fit is refused before it starts, at no AI cost.",
		build: limitsInsideLimits,
		claims: [
			{ says: "stops before an AI call that could pass that limit", source: "README.md", needle: "a job with its own cap is stopped before any model call that could take it past that cap" },
			{ says: "per day, week and month", source: "README.md", needle: "You set limits in dollars and in jobs, per day, week and month, for everything or per project" },
			{ says: "your last line", source: "README.md", needle: "Also set a spending limit at your AI provider, as a last line" },
			{ says: "before it starts", source: "README.md", needle: "A job over a limit is refused before it starts" },
			{ says: "stops before", source: "docs/costs.md", needle: "The runner checks the per-job cap before every model call" },
		],
	}),
	Object.freeze({
		name: "in-and-out-of-the-box",
		alt: "An animation of a sealed box with the agent inside, thrown away afterwards, a fresh one for every job. Going in: your project, and instructions that are read only. Two keys go in too, and it can read them: your AI provider key and a GitHub or GitLab key. Coming out: a proposed change, and what it did and cost. It can reach only addresses you allow, and nothing else. Your other files and your other passwords stay out. The agent can read both keys, so limit what each key can do, so a leak does less harm.",
		build: inAndOutOfTheBox,
		claims: [
			{ says: "Only addresses you allow", source: "README.md", needle: "A job sees only its own project, inside its box, and can reach only the internet addresses you allow" },
			{ says: "The agent can read both keys", source: "README.md", needle: "Two secrets do go in, and the agent can read them" },
			{ says: "Limit what each key can do", source: "README.md", needle: "a narrow token beats your whole login" },
			{ says: "thrown away", source: "README.md", needle: "a sealed box that is thrown away afterwards" },
			{ says: "so a leak does less harm", source: "README.md", needle: "The limit is on the damage, not on the leak" },
			{ says: "Instructions, read only", source: "README.md", needle: "/job read-only" },
		],
	}),
	Object.freeze({
		name: "many-at-once",
		alt: "An animation of many agents at once, under the headline: many agents, one place to run them. New work comes from a schedule, an issue or a comment, and waits in line. Two machines hold eight boxes, each with one agent that works, asks or reviews, or open for the next job, under one budget. One page tells you how many need you and how many are running. One switch stops new work: new work waits in line, running jobs finish, and when it is switched back on the line moves again.",
		build: manyAtOnce,
		claims: [
			{ says: "One line", source: "README.md", needle: "several projects sharing one queue, one budget and one page" },
			{ says: "One budget", source: "docs/multi-host.md", needle: "Two Mac minis, one queue, one budget, one panel" },
			{ says: "One switch", source: "README.md", needle: "one switch that stops new work everywhere" },
			{ says: "running jobs finish", source: "admin/skills/operate-pi-dispatch/SKILL.md", needle: "already running containers finish" },
			{ says: "new work waits", source: "docs/service.md", needle: "Jobs still queue up and wait" },
			{ says: "reviews", source: "docs/triggers.md", needle: '"flow": "review"' },
			{ says: "Each agent in its own box", source: "docs/replicas.md", needle: "Neither replica knows what the other did" },
		],
	}),
	Object.freeze({
		name: "when-to-step-back",
		alt: "An animation of three projects under the headline: step back when the numbers say you can. Zero touch shows how often runs needed a person, per project, over the last 8 weeks, with a dashed line at 5 percent. This is sample data. The rate for ops falls to 3 percent, which reads under goal. Nothing happens by itself: after a pause the words say your choice, and only then do you step from near the loop to out of the loop. The rate for web falls to 16 percent, above goal, and you stay near the loop. The rate for billing rises to 32 percent, which reads high, and you stay in the loop. Aim for zero. The dashed line at 5 percent is a guide, not permission: you decide.",
		build: whenToStepBack,
		claims: [
			{ says: "how often runs needed a person, per project", source: "README.md", needle: "how often runs needed a person, per project" },
			{ says: "Aim for zero", source: "docs/zero-touch.md", needle: "The goal is zero touches" },
			{ says: "a guide, not permission", source: "docs/zero-touch.md", needle: "the 5% marker is a guide rather than permission to act" },
			{ says: "Under goal", source: "admin/src/console/panels/zero-touch.mjs", needle: 'row.rate < 5 ? "Under goal" : row.rate < 30 ? "Above goal" : "High"' },
			{ says: "Above goal", source: "admin/src/console/panels/zero-touch.mjs", needle: 'row.rate < 5 ? "Under goal" : row.rate < 30 ? "Above goal" : "High"' },
			{ says: "High", source: "admin/src/console/panels/zero-touch.mjs", needle: 'row.rate < 5 ? "Under goal" : row.rate < 30 ? "Above goal" : "High"' },
			{ says: "last 8 weeks", source: "specs/requirements.md", needle: "the weekly trend" },
		],
	}),
]);

/** The words a picture shows, one string per line of text, as a reader sees them. */
export const explainerWords = (svg) => [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map(([, words]) => words.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&"));

/** One picture in one theme, as a whole SVG document, with its motion in its own style. Open it in a browser to review it. */
export function explainerSvg(explainer, theme) {
	const { height, css, body } = explainer.build(paletteOf(theme));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPLAIN_WIDTH}" height="${height}" viewBox="0 0 ${EXPLAIN_WIDTH} ${height}" role="img" aria-label="${esc(explainer.alt)}" font-family="${esc(SANS)}"><style>${css}</style>${body}</svg>\n`;
}

/** A picture's file: light is the plain name, dark a suffix as `console-overview` has, and the still for reduced motion another. */
export const explainerFile = (name, theme, still = false) => `${name}${theme === "dark" ? "-dark" : ""}${still ? "-still" : ""}.png`;

/** Every animated PNG `--explain` writes: its SVG, its size, its length, the moment its still is taken, and both files. */
export function explainShots(explainers = EXPLAINERS) {
	return explainers.flatMap((explainer) =>
		EXPLAIN_THEMES.map((theme) => {
			const svg = explainerSvg(explainer, theme);
			const { height, seconds, stillAt } = explainer.build(paletteOf(theme));
			return { name: explainer.name, theme, file: explainerFile(explainer.name, theme), still: explainerFile(explainer.name, theme, true), svg, width: EXPLAIN_WIDTH, height, seconds, stillAt, frames: Math.round(seconds * EXPLAIN_FPS) };
		}),
	);
}

/**
 * `sources.json`: each picture's file against the hash of the SVG it was shot from. PNGs are Chrome's rendering and are not
 * held to bytes, so without this a changed word would leave a picture saying the old one with every test green.
 */
export function explainSources(shots = [...explainShots(), bannerShot()]) {
	return Object.fromEntries(shots.map((shot) => [shot.file, createHash("sha256").update(shot.svg).digest("hex")]));
}

/**
 * The banner: from one agent on a lit floor to many in the dark, while you walk from the floor to the one page that stays lit.
 * It carries "dark engineering", which is a metaphor the words can only explain, in the first seconds a reader spends here.
 * It is not an explainer: it holds no claim of its own past the README's first lines, it has one look in both themes (dark
 * ground, light console, as it always had), and no README's rule for pictures of how things work applies to its small console.
 *
 * IT STARTS DARK. The first frame is what a place that does not animate a PNG shows, and the dark floor is the point, so the
 * loop begins and ends there and only passes through the lit floor. The floor's lights go off in steps rather than a long fade,
 * so most frames change only what moves and the loop stays light. Who stands where follows `how-close-you-stay`: beside the
 * agent, then near it, then gone from the floor. The word for the last stage stays in the same row of pills as the three it
 * follows, because it is where they lead and not a fourth setting.
 */
export const BANNER_ALT = "An animation of the pi-dispatch banner: go from sitting next to one AI coding agent to running many in the background. In the loop, near the loop, out of the loop, dark engineering. On a lit floor you stand beside one agent. As the lights go off, more agents start, and you walk away to the one page that stays lit, whose counts follow the floor. Spending limits that hold, a sealed box for every job, and you decide what ships.";
export const BANNER_WIDTH = 1200;
export const BANNER_HEIGHT = 420;

function bannerParts() {
	const dark = paletteOf("dark");
	const light = paletteOf("light");
	const seconds = 14;
	// The stages, in percent of the loop. The dark floor holds across the end and the start.
	const STAGE = { in: [18, 36], near: [36, 54], out: [54, 72], dark: [72, 100] };
	const stations = 16;
	const stationX = (i) => 49 + i * 70;
	const floorY = 312;
	const floorH = 86;
	const stationY = floorY + 17;
	const startOf = (i) => (i === 0 ? null : i < 3 ? STAGE.near[0] + i * 1.2 : i < 8 ? STAGE.out[0] + (i - 3) * 1.2 : STAGE.dark[0] + (i - 8) * 1.2);
	const tones = (i) => (i === 1 ? "parked" : i === 6 || i === 13 ? "ok" : "running");
	// Station 1 asks from the near stage on, so it needs you and is not running. Everything else that has started runs.
	const COUNTS = {
		running: { 1: [[14, STAGE.in[1]]], 2: [STAGE.near], 7: [STAGE.out], 15: [[0, 14], STAGE.dark] },
		needs: { 0: [[14, STAGE.in[1]]], 1: [[0, 14], [STAGE.near[0], 100]] },
	};
	const count = (windows) => holding(windows.map(([from, to]) => [from > 0 ? from + 0.05 : from, to]), 0.05);
	const pill = (x, width, words, fill, ink, klass) => [
		box(x, 222, width, 34, 17, `fill="${fill}"`),
		box(x - 3, 219, width + 6, 40, 20, `class="${klass}" fill="none" stroke="${ink}" stroke-width="2"`),
		text(x + width / 2, 244, words, { size: 16, weight: 650, fill: ink, anchor: "middle" }),
	].join("");
	const arrow = (x) => `<path d="M${x} 239h14m-5-5 5 5-5 5" fill="none" stroke="${dark("ink-faint")}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
	// Beside an agent, on open floor. There are no empty boxes: a first draft had them, and "you" standing in one read as a job in line.
	const youFloor = (i) => [stationX(i + 1) + 26, floorY + floorH / 2];
	const at = ([x, y]) => `transform:translate(${x}px,${y}px)`;
	const css = [
		// The lights, in steps: on, then lower, lower, off. They come back all at once, as the loop starts over.
		frames("bn-lights", [[0, "opacity:0"], [14, "opacity:0"], [16, "opacity:1"], [STAGE.near[0], "opacity:1"], [STAGE.near[0] + 2, "opacity:.5"], [STAGE.out[0], "opacity:.5"], [STAGE.out[0] + 2, "opacity:.14"], [STAGE.dark[0], "opacity:.14"], [STAGE.dark[0] + 2, "opacity:0"], [100, "opacity:0"]]),
		frames("bn-pill-in", holding([STAGE.in])),
		frames("bn-pill-near", holding([STAGE.near])),
		frames("bn-pill-out", holding([STAGE.out])),
		frames("bn-pill-dark", holding([[0, 14], STAGE.dark])),
		// You: at the page in the dark; back beside the first agent as the lights come on; then away.
		frames("bn-you", [[0, `${at([772, 150])};opacity:1`], [13, `${at([772, 150])};opacity:1`], [14.5, `${at([772, 150])};opacity:0`], [14.6, `${at(youFloor(0))};opacity:0`], [17, `${at(youFloor(0))};opacity:1`], [STAGE.near[0], `${at(youFloor(0))};opacity:1`], [STAGE.near[0] + 4, `${at(youFloor(2))};opacity:1`], [STAGE.out[0], `${at(youFloor(2))};opacity:1`], [STAGE.out[0] + 6, `${at([772, floorY + floorH / 2])};opacity:1`], [STAGE.out[0] + 12, `${at([772, 150])};opacity:1`], [100, `${at([772, 150])};opacity:1`]]),
		...Array.from({ length: stations }, (_, i) => (i === 0 ? "" : frames(`bn-s-${i}`, holding([[0, 14], [startOf(i), 100]])))),
		frames("bn-work", [[0, "transform:scaleX(0)"], [100, "transform:scaleX(1)"]]),
		// The small console counts what the floor holds, so it cannot say 4 running over 16 boxes.
		...Object.entries(COUNTS.running).map(([n, windows]) => frames(`bn-run-${n}`, count(windows))),
		...Object.entries(COUNTS.needs).map(([n, windows]) => frames(`bn-need-${n}`, count(windows))),
		`.bn-lights{animation:${steady("bn-lights", seconds)}}.bn-you{animation:${eased("bn-you", seconds)}}.bn-work{transform-box:fill-box;transform-origin:0 50%}`,
		Object.keys(COUNTS.running).map((n) => `.bn-run-${n}{animation:${steady(`bn-run-${n}`, seconds)}}`).join(""),
		Object.keys(COUNTS.needs).map((n) => `.bn-need-${n}{animation:${steady(`bn-need-${n}`, seconds)}}`).join(""),
		["in", "near", "out", "dark"].map((name) => `.bn-pill-${name}{animation:${steady(`bn-pill-${name}`, seconds)}}`).join(""),
		Array.from({ length: stations }, (_, i) => (i === 0 ? "" : `.bn-s-${i}{animation:${steady(`bn-s-${i}`, seconds)}}`)).join(""),
	].join("");
	// A job's progress, at a speed that closes the loop: 14 seconds divides into each of these.
	const speeds = [7, 14 / 3, 3.5, 14 / 5, 7 / 3];
	const station = (i) => {
		const x = stationX(i);
		const y = stationY;
		const tone = tones(i);
		const glyph = tone === "parked"
			? `<circle cx="${x + 26}" cy="${y + 22}" r="15" fill="${dark("parked")}"/>${icon("parked", x + 16, y + 12, 20, dark("on-parked"))}`
			: `<circle cx="${x + 26}" cy="${y + 22}" r="15" fill="${dark(tone)}"/>${text(x + 26, y + 28, "pi", { size: 16, weight: 800, fill: dark(`on-${tone}`), anchor: "middle" })}`;
		// A job that asked is waiting, and no bar moves while it waits.
		const work = tone === "parked" ? "" : `<rect class="bn-work" x="${x + 6}" y="${y + 44}" width="40" height="4" rx="2" fill="${dark(tone)}" style="animation:bn-work ${speeds[i % speeds.length].toFixed(4)}s linear infinite"/>`;
		return [
			`<g${i === 0 ? "" : ` class="bn-s-${i}"`}>${box(x, y, 52, 52, 12, `fill="${dark("surface-2")}" stroke="${dark(tone)}" stroke-width="2"`)}${glyph}${work}</g>`,
		].join("");
	};
	const consoleX = 812;
	const consoleY = 28;
	const scale = 0.84;
	const miniPill = (x, width, words, active = false) => `${box(x, 44, width, 20, 10, `fill="${light(active ? "primary" : "surface")}"`)}<text x="${x + width / 2}" y="58" text-anchor="middle" fill="${light(active ? "on-primary" : "ink-muted")}">${esc(words)}</text>`;
	const miniTile = (x, title, big, bigFill, small, smallFill = light("ink-muted"), bigSize = 24) => `${box(x, 120, 94, 72, 12, `fill="${light("surface")}"`)}<text x="${x + 10}" y="138" font-size="10" font-weight="700" fill="${light("ink")}">${esc(title)}</text><text x="${x + 10}" y="166" font-size="${bigSize}" font-weight="800" fill="${bigFill}">${esc(big)}</text><text x="${x + 10}" y="182" font-size="10" fill="${smallFill}">${esc(small)}</text>`;
	const miniConsole = [
		`<g transform="translate(${consoleX} ${consoleY}) scale(${scale})">`,
		box(0, 0, 424, 276, 16, `fill="${light("canvas")}"`),
		box(14, 14, 86, 22, 11, `fill="${light("surface")}"`),
		`<circle cx="26" cy="25" r="7" fill="${light("ink")}"/><text x="38" y="30" font-size="11" font-weight="700" fill="${light("ink")}">pi-dispatch</text>`,
		box(350, 14, 60, 22, 11, `fill="${light("surface")}"`),
		`<circle cx="363" cy="25" r="4" fill="${light("ok")}"/><text x="372" y="29" font-size="11" font-weight="650" fill="${light("ok-ink")}">Live</text>`,
		`<g font-size="10" font-weight="650">${miniPill(14, 62, "Overview", true)}${miniPill(80, 42, "Runs")}${miniPill(126, 50, "Parked")}${miniPill(180, 44, "Fleet")}${miniPill(228, 46, "Spend")}</g>`,
		`<text x="14" y="94" font-size="22" font-weight="800" letter-spacing="-.5" fill="${light("ink")}">Overview</text>`,
		miniTile(14, "Needs you", "", light("parked"), "question"),
		...Object.keys(COUNTS.needs).map((n) => `<g class="bn-need-${n}"><text x="24" y="166" font-size="24" font-weight="800" fill="${light("parked")}">${n}</text></g>`),
		miniTile(114, "In line", "5", light("ink"), "waiting"),
		miniTile(214, "Running", "", light("running"), "in 16 slots"),
		...Object.keys(COUNTS.running).map((n) => `<g class="bn-run-${n}"><text x="224" y="166" font-size="24" font-weight="800" fill="${light("running")}">${n}</text></g>`),
		miniTile(314, "Spend today", "$15.03", light("ink"), "60% of limit", light("ok-ink"), 20),
		box(14, 198, 396, 66, 12, `fill="${light("surface")}"`),
		box(58, 210, 84, 14, 7, `fill="${light("parked")}"`),
		box(148, 210, 96, 14, 7, `fill="${light("running")}"`),
		box(58, 230, 156, 14, 7, `fill="${light("surface-3")}"`),
		box(220, 230, 60, 14, 7, `fill="${light("running")}"`),
		box(58, 250, 110, 8, 4, `fill="${light("surface-3")}"`),
		`<line x1="284" y1="204" x2="284" y2="260" stroke="${light("running")}" stroke-width="2"/>`,
		box(292, 210, 108, 14, 7, `fill="none" stroke="${light("line-strong")}" stroke-width="1.5" stroke-dasharray="4 3"`),
		box(292, 230, 72, 14, 7, `fill="none" stroke="${light("line-strong")}" stroke-width="1.5" stroke-dasharray="4 3"`),
		`<text x="22" y="221" font-size="9" font-weight="700" fill="${light("ink-muted")}">api</text><text x="22" y="241" font-size="9" font-weight="700" fill="${light("ink-muted")}">web</text>`,
		`</g>`,
	].join("");
	const body = [
		box(1, 1, BANNER_WIDTH - 2, BANNER_HEIGHT - 2, 18, `fill="${dark("canvas")}" stroke="${dark("line-strong")}" stroke-width="2"`),
		text(64, 104, "pi-dispatch", { size: 62, weight: 800, fill: dark("ink"), track: "-1.5" }),
		text(66, 152, "Go from sitting next to one AI coding agent", { size: 24, fill: dark("ink-muted") }),
		text(66, 184, "to running many in the background.", { size: 24, fill: dark("ink-muted") }),
		pill(66, 118, "in the loop", dark("running-tint"), dark("running-ink"), "bn-pill-in"),
		arrow(194),
		pill(218, 134, "near the loop", dark("parked-tint"), dark("parked-ink"), "bn-pill-near"),
		arrow(362),
		pill(386, 142, "out of the loop", dark("ok-tint"), dark("ok-ink"), "bn-pill-out"),
		arrow(538),
		pill(562, 152, "dark engineering", dark("surface-3"), dark("ink"), "bn-pill-dark"),
		text(66, 288, "Spending limits that hold, a sealed box for every job, and you decide what ships.", { size: 18, fill: dark("ink-muted") }),
		miniConsole,
		// The floor: dark underneath, and its lights over it.
		box(24, floorY, BANNER_WIDTH - 48, floorH, 14, `fill="${dark("surface")}"`),
		box(24, floorY, BANNER_WIDTH - 48, floorH, 14, `class="bn-lights" fill="${light("canvas")}"`),
		...Array.from({ length: stations }, (_, i) => station(i)),
		// A pale ring, because this mark crosses a lit floor and a dark one.
		`<g class="bn-you"><circle r="20" fill="${dark("ink")}"/>${mark(0, 0, 18, "you", light("primary"), light("on-primary"), 16)}</g>`,
	].join("");
	return { css, body, seconds };
}

/** The banner as a whole SVG document, with its motion in its own style. It is written to `docs/images/banner.svg` by `--explain`. */
export function bannerSvg() {
	const { css, body } = bannerParts();
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" viewBox="0 0 ${BANNER_WIDTH} ${BANNER_HEIGHT}" role="img" aria-label="${esc(BANNER_ALT)}" font-family="${esc(SANS)}"><style>${css}</style>${body}</svg>\n`;
}

/** The banner's shot for `render-images.mjs --explain`. It lives beside the folder, not in it: the READMEs and pi's gallery load it from there. */
export function bannerShot() {
	const { seconds } = bannerParts();
	return { name: "banner", theme: "dark", file: "banner.png", still: "banner-still.png", svg: bannerSvg(), width: BANNER_WIDTH, height: BANNER_HEIGHT, seconds, stillAt: 0.05, frames: Math.round(seconds * EXPLAIN_FPS) };
}
