import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { frozenDateSource } from "../../launch/chrome-pipe.mjs";
import {
	CFT_PLATFORMS,
	CONTROL_PATH,
	CONTROL_WIDTH,
	DESKTOP,
	EMULATION_PROBE,
	FIXTURES,
	FOCUS_RING,
	FORCED_DOC,
	GOLDEN_ROLES,
	LINK_CODE_FRAGMENT,
	MORE_ALIGN,
	MORE_AT,
	MORE_READ,
	MORE_GAP,
	NO_SCRIPT,
	NO_SCRIPT_SUFFIX,
	ONE_ROW_WIDTH,
	PARKED_SHOWN,
	PARKED_WIDE,
	PHONE_CONTROL_JS,
	PHONE_CONTROL_PATH,
	PHONE_CONTROL_WIDTH,
	PHONE_MAX,
	PIN_FILE,
	PROBE_WIDTH,
	RUN_ID_LENGTH,
	Refusal,
	SHELL_WIDTHS,
	SIGN_IN,
	THEME_HIDDEN_READ,
	VIEWPORT,
	WIDTH_PENDING,
	barSource,
	barVerdict,
	cftUrl,
	checkNoScript,
	chromeChoice,
	clipsOf,
	controlCss,
	controlDoc,
	controlHtml,
	controlVerdict,
	describe,
	emulationProblems,
	findChrome,
	goldenName,
	goldenProblems,
	goldenUrl,
	heightProblems,
	hostPlatform,
	injectTheme,
	inkOf,
	intersect,
	liveReadProblems,
	liveStateProblems,
	liveStatesOf,
	loadModules,
	longRunId,
	longestName,
	missingGoldens,
	moreSource,
	moreVerdict,
	nameProblems,
	navCut,
	noScriptRun,
	noScriptVerdict,
	oneRowProblems,
	parkedCounts,
	parkedReadProblems,
	parseArgs,
	partOf,
	phoneControlCss,
	phoneControlDoc,
	phoneControlHtml,
	pinProblems,
	pinUrl,
	planRuns,
	planShellRuns,
	ratchetVerdict,
	readGoldens,
	readWidthProblems,
	readsNote,
	runCheck,
	runVerdict,
	sha256Hex,
	shellContexts,
	shellDocs,
	shellMetrics,
	shellRunVerdict,
	shellVerdict,
	shownBox,
	signInProblems,
	summarize,
	themeHead,
	versionCheck,
	widthVerdict,
	zipVerdict,
} from "../../.github/scripts/console-width-check.mjs";
import { TOKEN_NAME_RE } from "../src/console-tokens.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #737: the console's phone-width, top-bar and CSP check. Chrome runs only in the workflow step (and on a
// maintainer's machine); these are the parts that decide, on constructed input, the glue from the Chrome lookup to the
// exit code with the browser faked, the pin file the step downloads by, and the workflow step itself, run with its
// tools stubbed.

const repo = fileURLToPath(new URL("../../", import.meta.url));
const at = (path) => import(new URL(`../../${path}`, import.meta.url).href);

test("arguments: the flags, a value that is never another flag, and --verify-zip and --check-pin alone", () => {
	const none = { require: false, shots: null, verifyZip: null, checkPin: false, platform: null };
	assert.deepEqual(parseArgs([]), none);
	assert.deepEqual(parseArgs(["--require", "--shots", "out"]), { ...none, require: true, shots: "out" });
	assert.deepEqual(parseArgs(["--verify-zip", "c.zip", "--platform", "linux64"]), { ...none, verifyZip: "c.zip", platform: "linux64" });
	assert.deepEqual(parseArgs(["--check-pin"]), { ...none, checkPin: true });
	assert.deepEqual(parseArgs(["--check-pin", "--platform", "mac-arm64"]), { ...none, checkPin: true, platform: "mac-arm64" });
	assert.deepEqual(parseArgs(["-h"]), { help: true });
	assert.equal(parseArgs(["--shots"]).error, "--shots takes a value");
	assert.equal(parseArgs(["--shots", "--require"]).error, "--shots takes a value", "a flag is never taken as the directory");
	assert.equal(parseArgs(["--shots", ""]).error, "--shots takes a value");
	assert.equal(parseArgs(["--wide"]).error, "unexpected argument: --wide");
	assert.equal(parseArgs(["--verify-zip", "c.zip", "--require"]).error, "--verify-zip runs alone");
	assert.equal(parseArgs(["--verify-zip", "c.zip", "--check-pin"]).error, "--verify-zip runs alone");
	assert.equal(parseArgs(["--check-pin", "--require"]).error, "--check-pin runs alone");
	assert.equal(parseArgs(["--check-pin", "--shots", "out"]).error, "--check-pin runs alone");
	assert.equal(parseArgs(["--platform", "linux64"]).error, "--platform goes with --verify-zip or --check-pin");
	assert.match(parseArgs(["--verify-zip", "c.zip", "--platform", "win64"]).error, /--platform is one of linux64, mac-arm64/);
});

test("the pin file is an exact Stable build whose urls are derived from its version, with a sha256 per platform", () => {
	const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
	assert.deepEqual(pinProblems(pin), [], "the committed pin");
	assert.deepEqual(Object.keys(pin.downloads), [...CFT_PLATFORMS]);
	const bad = (edit) => {
		const copy = structuredClone(pin);
		edit(copy);
		return pinProblems(copy);
	};
	assert.match(bad((p) => (p.version = "155"))[0], /not an exact Chrome version/);
	assert.match(bad((p) => (p.channel = "Beta"))[0], /not Stable/);
	assert.match(bad((p) => (p.downloads.linux64.url = cftUrl("155.0.8059.40", "linux64")))[0], /downloads\.linux64\.url is not https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//, "a url for another version is refused, so the hash cannot belong to a build the version does not name");
	assert.match(bad((p) => (p.downloads["mac-arm64"].sha256 = p.downloads["mac-arm64"].sha256.toUpperCase()))[0], /mac-arm64\.sha256 is not 64 lowercase hex/);
	assert.match(bad((p) => delete p.downloads.linux64)[0], /downloads are \["mac-arm64"\]/);
	assert.deepEqual(pinProblems(null), ["the pin is not a JSON object"]);
	assert.equal(cftUrl("1.2.3.4", "linux64"), "https://storage.googleapis.com/chrome-for-testing-public/1.2.3.4/linux64/chrome-linux64.zip");
});

test("--check-pin: the url the workflow downloads is derived from a pin that holds, never read off the file", () => {
	const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
	for (const platform of CFT_PLATFORMS) assert.deepEqual(pinUrl(pin, platform), { url: cftUrl(pin.version, platform) });
	const elsewhere = structuredClone(pin);
	elsewhere.downloads.linux64.url = "https://example.com/chrome-linux64.zip";
	assert.match(pinUrl(elsewhere, "linux64").error, /^\.github\/chrome-for-testing\.json: downloads\.linux64\.url is not https:\/\/storage\.googleapis\.com\//, "a url pointed elsewhere stops the step before any download");
	const noHash = structuredClone(pin);
	delete noHash.downloads["mac-arm64"].sha256;
	assert.match(pinUrl(noHash, "linux64").error, /mac-arm64\.sha256 is not 64 lowercase hex/, "any problem in the pin refuses every platform");
	assert.match(pinUrl(pin, "win64").error, /the pin has no win64 download \(it pins linux64, mac-arm64\)/);
});

test("a download runs only when its sha256 is the pin's for that platform, every character of it", () => {
	const bytes = Buffer.from("not really a zip");
	const got = sha256Hex(bytes);
	const pin = { version: "1.2.3.4", downloads: { linux64: { sha256: got }, "mac-arm64": { sha256: "0".repeat(64) } } };
	assert.deepEqual(zipVerdict({ got, platform: "linux64", pin }), { ok: true, want: got, got, problem: null });
	const wrong = zipVerdict({ got, platform: "mac-arm64", pin });
	assert.equal(wrong.ok, false);
	assert.match(wrong.problem, new RegExp(`sha256 ${got} is not the pinned 0{64} \\(Chrome for Testing 1\\.2\\.3\\.4 mac-arm64\\): refusing to run an unverified browser`));
	const last = got.slice(0, 63) + (got[63] === "0" ? "1" : "0");
	assert.equal(zipVerdict({ got: last, platform: "linux64", pin }).ok, false, "a hash that differs in its last character alone is another build");
	assert.equal(zipVerdict({ got: got.slice(0, 63), platform: "linux64", pin }).ok, false, "and so is one character short");
	assert.equal(zipVerdict({ got, platform: "linux-arm64", pin }).problem, "the pin has no linux-arm64 download");
	assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "the FIPS 180-2 test vector");
	assert.equal(hostPlatform("linux", "x64"), "linux64");
	assert.equal(hostPlatform("darwin", "arm64"), "mac-arm64");
	assert.equal(hostPlatform("darwin", "x64"), null, "an Intel Mac has no pinned build");
	assert.equal(hostPlatform("linux", "arm64"), null);
});

test("Chrome is CHROME, then google-chrome or chromium on PATH, then the macOS app; a CHROME that cannot run is an error, never a skip", () => {
	const none = () => null;
	const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	assert.deepEqual(findChrome({ env: { CHROME: "/opt/cft/chrome" }, onPath: none, executable: (p) => p === "/opt/cft/chrome" }), { path: "/opt/cft/chrome", from: "CHROME" });
	assert.deepEqual(findChrome({ env: { CHROME: "/opt/cft/chrome" }, onPath: () => "/usr/bin/google-chrome", executable: () => false }), { error: "CHROME is /opt/cft/chrome, which is not an executable file" });
	let asked = null;
	const onPath = (names, path) => ((asked = { names, path }), "/usr/bin/chromium");
	assert.deepEqual(findChrome({ env: { PATH: "/usr/bin" }, onPath, executable: () => true }), { path: "/usr/bin/chromium", from: "PATH" });
	assert.deepEqual(asked, { names: ["google-chrome", "chromium"], path: "/usr/bin" });
	assert.deepEqual(findChrome({ env: {}, onPath: none, executable: (p) => p === mac }), { path: mac, from: "the macOS app" });
	assert.deepEqual(findChrome({ env: {}, onPath: none, executable: () => false }), { path: null });
});

test("no Chrome skips without --require and refuses with it; a CHROME that cannot run refuses either way", () => {
	assert.deepEqual(chromeChoice({ path: "/opt/chrome", from: "CHROME" }, true), { path: "/opt/chrome" });
	assert.deepEqual(chromeChoice({ path: null }, false), { skip: "console-width-check: skipped, no Chrome found (set CHROME to run it)" });
	assert.match(chromeChoice({ path: null }, true).refusal, /no Chrome found .*and --require is set/);
	assert.deepEqual(chromeChoice({ error: "CHROME is /x, which is not an executable file" }, false), { refusal: "CHROME is /x, which is not an executable file" });
});

test("the Chrome that ran: the pinned build passes, another fails in CI and is a note elsewhere", () => {
	const pin = { version: "155.0.8059.39" };
	assert.deepEqual(versionCheck({ product: "HeadlessChrome/155.0.8059.39", pin, ci: true }), {});
	assert.deepEqual(versionCheck({ product: "HeadlessChrome/156.0.1.2", pin, ci: true }), { failure: "this is Chrome 156.0.1.2, not the pinned Chrome for Testing 155.0.8059.39: CI must measure with the pinned build" });
	assert.deepEqual(versionCheck({ product: "HeadlessChrome/156.0.1.2", pin, ci: false }), { note: "this is Chrome 156.0.1.2, not the pinned Chrome for Testing 155.0.8059.39; CI is the authority on width" });
	assert.match(versionCheck({ product: "Chromium", pin, ci: true }).failure, /^this is Chrome Chromium, not the pinned/, "a product with no version is not the pin");
	assert.match(versionCheck({ product: "HeadlessChrome/155.0.8059.39x", pin, ci: true }).failure, /^this is Chrome HeadlessChrome\/155\.0\.8059\.39x, not the pinned/, "the version runs to the end of the product: a pinned prefix is not the pin");
	assert.ok(versionCheck({ product: "HeadlessChrome/155.0.8059.391", pin, ci: true }).failure, "nor is a longer build number");
});

// A measured element as the page's collector reports it.
const el = (tag, left, right, extra = {}) => ({ tag, id: "", cls: "", inside: "", rect: { left, top: 0, right, bottom: 20 }, up: -1, text: false, font: "", scrollers: [], ...extra });
const scroller = (tag, left, right, overflowX = "auto") => ({ tag, id: "", cls: "scroll", overflowX, rect: { left, top: 0, right, bottom: 20 } });

test("width: a page fits when nothing scrolls the viewport and every element past the edge sits in a scroll box that fits", () => {
	assert.equal(widthVerdict({ scrollWidth: 375, elements: [] }).ok, true);
	const inBox = widthVerdict({ scrollWidth: 375, elements: [el("table", 16, 900, { scrollers: [scroller("div", 16, 359)] })] });
	assert.equal(inBox.ok, true, "a wide table in a fitting scroll box is the sanctioned shape");
	assert.equal(widthVerdict({ scrollWidth: 375, elements: [el("table", 16, 900, { scrollers: [scroller("div", 16, 359, "scroll")] })] }).ok, true);
	assert.equal(widthVerdict({ scrollWidth: 375, elements: [el("td", 16, 375.4)] }).ok, true, "half a pixel of rounding is not overflow");
	assert.equal(widthVerdict({ scrollWidth: 375, elements: [el("td", 16, 375.6)] }).ok, false);
	assert.equal(widthVerdict({ scrollWidth: 1024, elements: [el("td", 16, 1000)] }, 1024).ok, true, "the edge is the width asked for");
	assert.equal(widthVerdict({ scrollWidth: 1025, elements: [] }, 1024).ok, false);
});

test("width: what does not excuse an element past the edge", () => {
	const past = (scrollers, scrollWidth = 375) => widthVerdict({ scrollWidth, elements: [el("table", 16, 900, { scrollers })] });
	assert.equal(past([]).ok, false, "no scroll box at all");
	assert.equal(past([scroller("div", 16, 900)]).ok, false, "a scroll box that is itself past the edge");
	assert.equal(past([scroller("div", -40, 359)]).ok, false, "a scroll box that starts left of the viewport does not fit either");
	assert.equal(past([scroller("div", 16, 359, "hidden")]).ok, false, "overflow hidden clips the content, it does not offer it");
	assert.equal(past([scroller("div", 16, 359, "clip")]).ok, false);
	assert.equal(past([scroller("body", 0, 375)]).ok, false, "body's overflow scrolls the viewport, which is the failure");
	assert.equal(past([scroller("html", 0, 375)]).ok, false);
	assert.equal(past([scroller("body", 0, 375), scroller("div", 16, 359)]).ok, true, "any fitting scroll box below body excuses");
	const wide = widthVerdict({ scrollWidth: 951, elements: [] });
	assert.deepEqual([wide.ok, wide.wide, wide.offenders, wide.roots], [false, true, 0, []], "a page wider than the viewport fails even when no element box is to blame");
});

test("width: the report leads with the widest root offender and resolves the font of text inside it", () => {
	const elements = [
		el("section", 0, 420, { id: "p-runs" }),
		el("table", 0, 420, { up: 0, cls: "grid", inside: "p-runs" }),
		el("td", 300, 420, { up: 1, text: true, font: "system-ui", inside: "p-runs" }),
		el("svg", 31, 951, { inside: "p-insights" }),
		el("text", 500, 600, { up: 3, text: true, inside: "p-insights" }),
		el("pre", 0, 380),
	];
	const v = widthVerdict({ scrollWidth: 951, elements });
	assert.equal(v.ok, false);
	assert.equal(v.offenders, 6);
	assert.deepEqual(v.roots.map((r) => r.i), [3, 0, 5], "roots only (no offending ancestor), widest first");
	assert.equal(v.fontAt, 4, "the first text-bearing offender inside the widest root");
	assert.equal(describe(v.roots[0]), "<svg> in #p-insights");
	assert.equal(describe(v.roots[1]), '<section id="p-runs">');
	assert.equal(describe({ tag: "table", id: "", cls: "grid", inside: "p-runs" }), '<table class="grid"> in #p-runs');
	const bare = widthVerdict({ scrollWidth: 400, elements: [el("div", 0, 400), el("hr", 0, 400, { up: 0 })] });
	assert.equal(bare.fontAt, 0, "with no text inside the widest root, the root itself is named");
	const many = widthVerdict({ scrollWidth: 999, elements: Array.from({ length: 8 }, (_, i) => el("p", 0, 400 + i)) });
	assert.equal(many.roots.length, 5, "at most five roots are reported");
	assert.equal(many.roots[0].i, 7);
	const excusedParent = widthVerdict({ scrollWidth: 375, elements: [el("table", 16, 900, { scrollers: [scroller("div", 16, 359)] }), el("td", 600, 900, { up: 0, scrollers: [scroller("div", 16, 359)] })] });
	assert.deepEqual([excusedParent.ok, excusedParent.offenders], [true, 0], "what a fitting scroll box holds is excused all the way down");
});

// The emulation probe's answer for a phone's window and a desktop's.
const PHONE = Object.freeze({ dpr: VIEWPORT.scale, mobile: true, probed: PROBE_WIDTH });
const desk = (width) => ({ dpr: DESKTOP.scale, mobile: false, probed: width });

test("the window's emulation is read back from the page, not trusted from the call that set it", () => {
	assert.deepEqual(emulationProblems(PHONE, true), []);
	assert.deepEqual(emulationProblems(desk(1024), false), []);
	assert.deepEqual(emulationProblems(desk(375), true), ["the window was meant to be a phone's, but DevTools did not emulate a phone (a viewport meta asking for 1234 px laid the page out 375 px wide)", "the device scale is 1, not 2"], "a 375 px window drawn as a desktop's");
	assert.deepEqual(emulationProblems(PHONE, false), ["the window was meant to be a desktop's, but DevTools emulated a phone (a viewport meta asking for 1234 px laid the page out 1234 px wide)", "the device scale is 2, not 1"]);
	assert.deepEqual(emulationProblems({ ...PHONE, dpr: 1 }, true), ["the device scale is 1, not 2"]);
	assert.deepEqual(emulationProblems({ dpr: 2, mobile: null, probed: null }, true), ["the page has no viewport meta, so the emulation probe could not tell a phone's window from a desktop's"]);
	assert.deepEqual(emulationProblems(null, true), ["the emulation probe never ran, so whether the window was a phone's is unknown"]);
	assert.ok(!SHELL_WIDTHS.includes(PROBE_WIDTH), "the probe asks for a width no window of the sweep has");
});

test("one golden run: a CSP violation, a probe that never ran and the wrong --canvas each fail it; page errors are notes", () => {
	const measured = { scrollWidth: 375, clientWidth: 375, elements: [] };
	const base = { csp: [], errors: [], canvas: " #EDEEEC ", want: "#edeeec", expect: "light", measured, emulation: PHONE };
	const clean = runVerdict(base);
	assert.deepEqual([clean.failures, clean.notes, clean.width.ok], [[], [], true], "the computed value is compared trimmed and in lower case");
	const violation = { directive: "style-src-attr", blocked: "inline", source: "http://127.0.0.1/x", line: 3, sample: "color:red" };
	assert.deepEqual(runVerdict({ ...base, csp: [violation] }).failures, ['CSP violation: style-src-attr refused inline (http://127.0.0.1/x:3) "color:red"']);
	assert.deepEqual(runVerdict({ ...base, csp: [{ directive: "script-src-elem", blocked: "", source: "", line: 0, sample: "" }] }).failures, ["CSP violation: script-src-elem refused an inline resource"]);
	assert.deepEqual(runVerdict({ ...base, csp: null }).failures, ["the CSP probe never ran, so no violation could have been seen"]);
	assert.deepEqual(runVerdict({ ...base, canvas: "#000000" }).failures, ['--canvas is "#000000", not the light theme\'s #edeeec']);
	assert.deepEqual(runVerdict({ ...base, canvas: "" }).failures, ["--canvas is unset, not the light theme's #edeeec"]);
	const noisy = runVerdict({ ...base, errors: ["boom"], settled: false, measured: { ...measured, clientWidth: 980 } });
	assert.deepEqual(noisy.failures, []);
	assert.deepEqual(noisy.notes, ["the page did not settle within 1.5 s (fonts or frames); measured anyway", "page error: boom", "the layout viewport is 980 px, not 375"]);
	assert.equal(runVerdict({ ...base, measured: { ...measured, scrollWidth: 400 } }).width.ok, false);
	assert.deepEqual(runVerdict({ ...base, emulation: desk(375) }).failures, emulationProblems(desk(375), true), "a golden is always a phone's window");
});

// A part of the top bar as the page reports it: a box, the boxes that clip it, and its name.
const box = (left, right, top = 0, bottom = 48) => ({ left, top, right, bottom });
const part = (label, rect, clips = [], extra = {}) => ({ tag: "a", id: "", cls: "", label, rect, clips, ...extra });

test("boxes: what two boxes share, and what of a part an overflow box lets show", () => {
	assert.deepEqual(intersect(box(0, 100), box(50, 150)), box(50, 100));
	assert.equal(intersect(box(0, 100), box(100, 150)), null, "touching edges share nothing");
	assert.equal(intersect(box(0, 100), box(0, 100, 48, 96)), null, "one above the other share nothing");
	assert.deepEqual(shownBox(part("Fleet", box(300, 400), [box(0, 350)])), box(300, 350), "cut by the row it scrolls in");
	assert.equal(shownBox(part("Audit", box(400, 450), [box(0, 350)])), null, "scrolled out of its row");
	assert.equal(shownBox(part("hidden", box(0, 0, 0, 0))), null, "a hidden button has no box");
	assert.deepEqual(shownBox(part("x", box(10, 20), [box(0, 100), box(15, 100)])), box(15, 20), "every clipping ancestor cuts it");
});

/**
 * A measure as the page's collector reports it (`nodes`, one `snap`, `roles`), from a tree of `[tag, attrs,
 * ...children]`, `attrs` the node's `id`, `cls`, `rect`, `position`, `overflow` (both axes), `label` and `role`.
 */
function measure(tree) {
	const nodes = [];
	const snap = [];
	const roles = { top: -1, nav: -1, end: -1, brand: -1, theme: -1, name: -1, roleWord: -1, more: -1, summary: -1, menu: -1 };
	const walk = ([tag, a = {}, ...kids], parent) => {
		const i = nodes.length;
		nodes.push({ tag, id: a.id ?? "", cls: a.cls ?? "", parent });
		snap.push({ cls: a.cls ?? "", rect: a.rect ?? box(0, 0, 0, 0), position: a.position ?? "static", overflowX: a.overflow ?? "visible", overflowY: a.overflow ?? "visible", label: a.label ?? "" });
		if (a.role) roles[a.role] = i;
		for (const k of kids) walk(k, i);
	};
	walk(tree, -1);
	return { nodes, snap, roles };
}

test("clips: each containing block up a box's chain whose overflow is not visible, an absolute box escaping what lies between it and its own", () => {
	const tree = (navPosition) => ["div", { cls: "page", rect: box(0, 1000, 0, 200), overflow: "hidden" },
		["header", { cls: "top", rect: box(10, 990, 10, 70), position: "relative", role: "top" },
			["nav", { cls: "pillnav", rect: box(100, 600, 10, 70), overflow: "auto", position: navPosition, role: "nav" },
				["a", { rect: box(500, 700, 14, 62) }],
				["details", { cls: "more", rect: box(560, 608, 14, 62) }, ["summary", { rect: box(560, 608, 14, 62) }], ["div", { rect: box(430, 610, 68, 120), position: "absolute" }]]],
			["div", { cls: "pinned", rect: box(0, 10, 0, 10), position: "fixed" }],
			["div", { cls: "outer", rect: box(0, 50, 0, 50), position: "absolute", overflow: "hidden" }, ["span", { rect: box(0, 90, 0, 10), position: "absolute" }]]]];
	const m = measure(tree("static"));
	const at = (i) => clipsOf(m.nodes, m.snap, i);
	assert.deepEqual(at(3), [box(100, 600, 10, 70), box(0, 1000, 0, 200)], "a pill: its scrolling row, then the page around the bar");
	assert.deepEqual(at(5), [box(100, 600, 10, 70), box(0, 1000, 0, 200)], "the summary inside More: the same");
	assert.deepEqual(at(6), [box(0, 1000, 0, 200)], "the list, positioned against the bar, escapes the scrolling row between them, not a box around the bar");
	assert.deepEqual(at(7), [], "a fixed box escapes them all");
	assert.deepEqual(at(9), [box(0, 50, 0, 50), box(0, 1000, 0, 200)], "an absolute box inside an absolute one: cut by its own containing block, then that one's");
	assert.deepEqual(at(0), [], "nothing above the bar's outermost ancestor clips: <body> and <html> scroll the viewport");
	const positioned = measure(tree("relative"));
	assert.deepEqual(clipsOf(positioned.nodes, positioned.snap, 6), [box(100, 600, 10, 70), box(0, 1000, 0, 200)], "a positioned scrolling row is the list's containing block, and clips it");
	assert.deepEqual(partOf(m.nodes, m.snap, 3), { tag: "a", id: "", cls: "", label: "", rect: box(500, 700, 14, 62), clips: at(3) });
	assert.equal(partOf(m.nodes, m.snap, -1), null, "a part the page does not draw");
	assert.equal(partOf(m.nodes, m.snap, m.nodes.length), null);
});

test("the metrics: the navigation's and the end's own children are the parts, read by read, with the bar's height, the name and the open menu", () => {
	const tree = (height, liveCls, menu) => ["div", { cls: "page", rect: box(0, 800, 0, 300) },
		["header", { cls: "top", rect: box(16, 784, 16, 16 + height), position: "relative", role: "top" },
			["a", { cls: "brandpill", rect: box(16, 150, 16, 64), label: "pi-dispatch", role: "brand" }],
			["nav", { cls: "pillnav", rect: box(16, 784, 72, 120), role: "nav" },
				["a", { rect: box(16, 120, 72, 120), label: "Overview" }, ["span", { cls: "count", rect: box(90, 110, 80, 100), label: "3" }]],
				["details", { cls: "more", rect: box(126, 174, 72, 120), label: "More", role: "more" },
					["summary", { rect: box(126, 174, 72, 120), label: "More: Audit", role: "summary" }],
					["div", { rect: menu, position: "absolute", label: "Audit", role: "menu" }]]],
			["div", { cls: "top__end", rect: box(500, 784, 16, 64), role: "end" },
				["span", { id: "live-status", cls: liveCls, rect: box(500, 600, 16, 64), label: "Live" }],
				["span", { cls: "who", rect: box(610, 784, 16, 64), label: "ops" }, ["span", {}, ["b", { rect: box(620, 700, 20, 40), overflow: "hidden", role: "name" }]]]]]];
	const shut = box(0, 0, 0, 0);
	const a = measure(tree(48, "live", shut));
	const b = measure(tree(108, "live live--retry", shut));
	const name = { text: "ops", title: "ops, Operator", scrollWidth: 80, clientWidth: 80, textOverflow: "ellipsis", overflowX: "hidden" };
	const bar = { nodes: a.nodes, roles: a.roles, reads: [{ live: "Live", theme: "shown", parked: "128", parkedText: "128 unanswered", scrollWidth: 800, snap: a.snap }, { live: "Reconnecting", theme: "shown", parked: "", parkedText: "", scrollWidth: 812, snap: b.snap }], name, roleWord: null, parkedWidened: true, width: 800, height: 900 };
	const open = measure(tree(48, "live", box(-6, 174, 126, 166)));
	const m = shellMetrics({ bar, more: { opened: true, cutFirst: true, nodes: open.nodes, roles: open.roles, snap: open.snap, width: 800, height: 900 } });
	assert.deepEqual(m.bars.map((r) => [r.live, r.theme, r.parked, r.scrollWidth, r.height]), [["Live", "shown", "128", 800, 48], ["Reconnecting", "shown", "", 812, 108]], "the bar's own height and the page's width, read by read, with what the read varied");
	assert.equal(m.widened, true);
	assert.deepEqual(m.bars.map((r) => r.parkedText), ["128 unanswered", ""], "the Parked panel's text as each read found it");
	assert.deepEqual(m.bars[0].nav.map((p) => p.label), ["Overview", "More"], "the navigation's own children: not the count inside a pill, not the summary inside More");
	assert.deepEqual(m.bars[0].end.map((p) => p.label), ["Live", "ops"], "the end cluster's own children");
	assert.deepEqual([m.bars[0].end[0].cls, m.bars[1].end[0].cls], ["live", "live live--retry"], "each read is its own");
	assert.equal(m.bars[0].brand.label, "pi-dispatch");
	assert.deepEqual(m.name, { ...name, part: partOf(a.nodes, a.snap, a.roles.name) });
	assert.equal(m.roleWord, null, "a bar that draws no role word");
	assert.deepEqual([m.more.opened, m.more.cutFirst, m.more.summary.label, m.more.menu.rect, m.more.menu.clips, m.more.width, m.more.height], [true, true, "More: Audit", box(-6, 174, 126, 166), [], 800, 900]);
	const role = { text: "Operator", title: "ops, Operator", scrollWidth: 60, clientWidth: 60, textOverflow: "ellipsis", overflowX: "hidden" };
	const withRole = measure(["header", { cls: "top", rect: box(0, 800, 0, 48), role: "top" }, ["small", { rect: box(600, 660, 30, 44), role: "roleWord" }]]);
	assert.deepEqual(shellMetrics({ bar: { nodes: withRole.nodes, roles: withRole.roles, reads: [{ live: null, theme: null, snap: withRole.snap }], name: null, roleWord: role } }).roleWord, { ...role, part: partOf(withRole.nodes, withRole.snap, withRole.roles.roleWord) }, "the role word's measure, with its part");
	const bare = measure(["header", { cls: "top", rect: box(0, 800, 0, 48), role: "top" }]);
	const lone = shellMetrics({ bar: { nodes: bare.nodes, roles: bare.roles, reads: [{ live: null, theme: null, snap: bare.snap }], name: null } });
	assert.deepEqual([lone.bars[0].nav, lone.bars[0].end, lone.bars[0].brand, lone.bars[0].parked, lone.bars[0].parkedText, lone.bars[0].scrollWidth, lone.name, lone.widened, lone.more], [null, null, null, null, null, null, null, null, null], "a bar without a navigation, an end or a count has none, which barVerdict names");
	assert.deepEqual(shellMetrics({}), { bars: null, name: null, roleWord: null, widened: null, more: null }, "a page with no bar");
	assert.deepEqual(shellMetrics({ more: { opened: false, nodes: null, width: 375, height: 812 } }).more, { opened: false, cutFirst: null, summary: null, menu: null, width: 375, height: 812 });
});

test("what a part shows is its box and all it draws: a word spilling out of a fixed 16 px live pill meets the theme button", () => {
	// A phone's end: the 16 px live pill (left 300) and the theme button 6 px after it; the word is its child.
	const end = (word, pillOverflow = "visible") => measure(["header", { cls: "top", rect: box(0, 375, 0, 120), position: "relative", role: "top" },
		["a", { cls: "brandpill", rect: box(16, 150, 16, 64), role: "brand" }],
		["nav", { cls: "pillnav", rect: box(0, 375, 72, 120), overflow: "auto", role: "nav" }],
		["div", { cls: "top__end", rect: box(290, 375, 16, 64), role: "end" },
			["span", { id: "live-status", cls: "live live--retry", rect: box(300, 316, 32, 48), overflow: pillOverflow, label: "Reconnecting" }, ["span", { rect: word }]],
			["button", { cls: "roundbtn", rect: box(322, 362, 20, 60), label: "Theme" }]]]);
	const verdict = (m) => barVerdict(shellMetrics({ bar: { nodes: m.nodes, roles: m.roles, reads: [{ live: "Reconnecting", theme: "shown", snap: m.snap }], name: null } }).bars[0], { width: 375 });
	const spilled = end(box(272, 344, 32, 48));
	assert.deepEqual(inkOf(spilled.nodes, spilled.snap, 4), box(272, 344, 32, 48), "the pill's own 16 px box and its 72 px word, as one");
	assert.deepEqual(verdict(spilled).overlaps.map((o) => [o.a.label, o.b.label, o.x, o.y]), [["Reconnecting", "Theme", 22, 16]], "the word runs 22 px over the button while the pill's own box stays clear of it");
	assert.deepEqual(verdict(end(box(272, 344, 32, 48), "hidden")).overlaps, [], "a pill that clips its word draws no more than its box");
	assert.deepEqual(verdict(end(box(299, 300, 31, 32))).overlaps, [], "a visually hidden word (1 px, margin -1 px) draws nothing that meets anything");
	assert.deepEqual(verdict(end(box(0, 0, 0, 0))).overlaps, [], "and one not drawn at all");
});

test("the top bar: every pair of its parts apart, a navigation pill against the brand and the end, and the end's parts against each other", () => {
	const row = box(200, 700);
	const nav = [part("Overview", box(200, 320), [row]), part("Runs", box(326, 430), [row]), part("Configuration", box(600, 760), [row])];
	const end = [part("Live", box(640, 720), [], { tag: "span", id: "live-status", cls: "live" }), part("Sign out", box(730, 778), [], { tag: "button", id: "logout", cls: "roundbtn" })];
	const v = barVerdict({ live: "Live", nav, end, brand: part("pi-dispatch", box(16, 190), [], { cls: "brandpill" }) });
	assert.equal(v.ok, false);
	assert.deepEqual(v.overlaps.map((o) => [o.kind, o.a.label, o.b.label, o.x, o.y]), [["nav", "Configuration", "Live", 60, 48]], "cut at the row's right edge (700), the pill meets the live pill only, by 60 px");
	const unclipped = barVerdict({ live: null, nav: nav.map((p) => ({ ...p, clips: [] })), end, brand: null });
	assert.deepEqual(unclipped.overlaps.map((o) => [o.a.label, o.b.label, o.x]), [["Configuration", "Live", 80], ["Configuration", "Sign out", 30]], "a row that does not clip lets the pill run on under both");
	assert.equal(barVerdict({ nav: [part("a", box(0, 100))], end: [part("b", box(100.4, 200))], brand: null }).ok, true, "touching is not overlapping");
	assert.equal(barVerdict({ nav: [part("a", box(0, 100.4))], end: [part("b", box(100, 200))], brand: null }).ok, true, "under half a pixel is rounding");
	assert.equal(barVerdict({ nav: [part("a", box(0, 101))], end: [part("b", box(100, 200))], brand: null }).ok, false);
	assert.equal(barVerdict({ nav: [part("a", box(0, 120, 0, 48))], end: [part("b", box(100, 200, 56, 96))], brand: null }).ok, true, "a second row is not an overlap");
	assert.equal(barVerdict({ nav: [part("a", box(0, 120))], end: [part("hidden", box(0, 0, 0, 0))], brand: null }).ok, true, "a part that draws nothing overlaps nothing");
	assert.deepEqual(barVerdict({ nav: [part("a", box(0, 120))], end: [], brand: part("brand", box(100, 200)) }).overlaps.map((o) => o.b.label), ["brand"], "the brand pill counts too");
	const crowded = barVerdict({ nav: [], end: [part("chip", box(400, 530), [], { tag: "span", cls: "chip" }), part("who", box(510, 640), [], { tag: "span", cls: "who" }), part("Sign out", box(640, 688))], brand: part("brand", box(0, 410)) });
	assert.deepEqual(crowded.overlaps.map((o) => [o.kind, o.pair, o.a.label, o.b.label, o.x]), [["bar", "o0 o1", "brand", "chip", 10], ["bar", "o1 o2", "chip", "who", 20]], "the brand and each part of the end against every other: a read-only chip under the name is an overlap too");
	assert.deepEqual(barVerdict({ nav: null, end: null, brand: null }).problems, ["the top bar has no .pillnav", "the top bar has no .top__end"]);
});

test("above a phone's width every navigation pill shows whole with its focus ring; on a phone a pill its row scrolls away is no failure", () => {
	assert.equal(FOCUS_RING, 4);
	const row = box(100, 700, 0, 56);
	const pill = (label, left, right) => part(label, box(left, right, 4, 52), [row]);
	assert.equal(navCut(pill("Runs", 200, 300), 1024), null, "inside its row with room for the ring");
	assert.deepEqual(navCut(pill("Fleet", 720, 800), 1024), { shown: null, ring: box(716, 804, 0, 56) }, "scrolled out of its row");
	assert.deepEqual(navCut(pill("Spend", 650, 750), 1024), { shown: box(646, 700, 0, 56), ring: box(646, 754, 0, 56) }, "cut by its row's edge");
	assert.deepEqual(navCut(part("Overview", box(104, 200, 4, 52), [box(104, 700, 0, 56)]), 1024), { shown: box(104, 204, 0, 56), ring: box(100, 204, 0, 56) }, "a box with no room for the ring: the reader tabbing to it sees a broken ring");
	assert.deepEqual(navCut(part("Audit", box(990, 1030, 4, 52)), 1024), { shown: box(986, 1024, 0, 56), ring: box(986, 1034, 0, 56) }, "the window's side cuts too");
	assert.equal(navCut(part("Audit", box(990, 1020.4, 4, 52)), 1024.5), null, "within half a pixel");
	assert.deepEqual(navCut(part("Audit", box(1030, 1080, 4, 52)), 1024), { shown: null, ring: box(1026, 1084, 0, 56) }, "past the window: none of it shows");
	assert.deepEqual(navCut(part("gone", box(0, 0, 0, 0)), 1024), { shown: null, ring: null }, "a pill not drawn cannot be reached either");
	const bar = { live: "Live", nav: [pill("Runs", 200, 300), pill("Fleet", 720, 800)], end: [], brand: null };
	assert.deepEqual(barVerdict(bar, { width: 1024 }).hidden.map((h) => [h.index, h.part.label, h.shown]), [[1, "Fleet", null]]);
	assert.equal(barVerdict(bar, { width: PHONE_MAX + 1 }).ok, false);
	assert.deepEqual(barVerdict(bar, { width: PHONE_MAX }).hidden, [], "at and below the phone breakpoint the navigation scrolls in its own row");
	assert.equal(PHONE_MAX, 760);
});

test("the bar holds its height across the live words and the theme button, and a jump is told once where it is largest", () => {
	const read = (live, theme, height) => ({ live, theme, height });
	const words = ["Not live", "Live", "Reconnecting", "Signed out"];
	assert.deepEqual(heightProblems(words.flatMap((w) => [read(w, "shown", 116), read(w, "hidden", 116)])), []);
	assert.deepEqual(heightProblems([read("Live", "shown", 116), read("Reconnecting", "shown", 176), read("Live", "hidden", 116), read("Reconnecting", "hidden", 116)]), [
		"the top bar is 176.0 px tall with the live pill reading Reconnecting and 116.0 px with it reading Live (theme button shown): it jumps when the live word changes",
		"the top bar is 176.0 px tall with the theme button shown and 116.0 px with it hidden (live pill reading Reconnecting): it jumps when the script reveals the button",
	]);
	assert.deepEqual(heightProblems([read("Live", "shown", 116), read("Reconnecting", "shown", 136), read("Live", "hidden", 56), read("Reconnecting", "hidden", 116)])[0], "the top bar is 116.0 px tall with the live pill reading Reconnecting and 56.0 px with it reading Live (theme button hidden): it jumps when the live word changes", "the largest jump, here with the button hidden");
	assert.deepEqual(heightProblems([read("Live", null, 56), read("Reconnecting", null, 116)]), ["the top bar is 116.0 px tall with the live pill reading Reconnecting and 56.0 px with it reading Live: it jumps when the live word changes"], "a page with no theme button");
	assert.deepEqual(heightProblems([read(null, "shown", 116), read(null, "hidden", 56)]), ["the top bar is 116.0 px tall with the theme button shown and 56.0 px with it hidden: it jumps when the script reveals the button"], "a page with no live pill holds still too");
	assert.deepEqual(heightProblems([read("Live", null, 56), read("Not live", null, 56.4)]), [], "half a pixel is rounding");
	assert.deepEqual(heightProblems([read("Live", null, 56)]), []);
	// The Parked count is the third thing the script changes: each jump is judged with the other two held.
	const counted = (live, theme, parked, height) => ({ live, theme, parked, height });
	const still = ["128", "", "12,345"].flatMap((p) => words.flatMap((w) => [counted(w, "shown", p, 116), counted(w, "hidden", p, 116)]));
	assert.deepEqual(heightProblems(still), [], "nothing moves: no sentence");
	const grown = still.map((b) => (b.parked === "12,345" ? { ...b, height: 170 } : b));
	assert.deepEqual(heightProblems(grown), ["the top bar is 170.0 px tall with the Parked count at 12,345 and 116.0 px with the Parked count at 128 (live pill reading Not live, theme button shown): it jumps when the Parked count changes"], "a count that gains digits and wraps the navigation");
	const emptied = still.map((b) => (b.parked === "" ? { ...b, height: 112 } : b));
	assert.deepEqual(heightProblems(emptied), ["the top bar is 116.0 px tall with the Parked count at 128 and 112.0 px with no Parked count (live pill reading Not live, theme button shown): it jumps when the Parked count changes"]);
	const onePhone = [counted("Not live", "shown", "128", 144), counted("Live", "shown", "128", 92), counted("Not live", "hidden", "128", 144), counted("Live", "hidden", "128", 92)];
	assert.deepEqual(heightProblems(onePhone), ["the top bar is 144.0 px tall with the live pill reading Not live and 92.0 px with it reading Live (theme button shown, the Parked count at 128): it jumps when the live word changes"], "round 3's phone: the server's Not live a row taller than Live");
	const across = [counted("Live", "shown", "128", 116), counted("Live", "hidden", "128", 116), counted("Live", "shown", "", 116), counted("Live", "hidden", "", 176)];
	assert.deepEqual(heightProblems(across), [
		"the top bar is 116.0 px tall with the theme button shown and 176.0 px with it hidden (live pill reading Live, no Parked count): it jumps when the script reveals the button",
		"the top bar is 176.0 px tall with no Parked count and 116.0 px with the Parked count at 128 (live pill reading Live, theme button hidden): it jumps when the Parked count changes",
	], "a jump judged along each thing with the others held: the theme button's shown first, whichever is taller");
});

test("every read of the bar: the page's width in each, every live word read, no two words alike on a phone, one row from 1440 px", () => {
	const words = ["Not live", "Live", "Reconnecting", "Signed out"];
	const reads = ["shown", "hidden"].flatMap((theme) => words.map((live) => ({ live, theme, parked: "128", scrollWidth: 375 })));
	assert.deepEqual(readWidthProblems(reads, 375), [], "the page fits in every read");
	const wider = reads.map((b) => (b.live === "Reconnecting" && b.theme === "shown" ? { ...b, scrollWidth: 391 } : b));
	assert.deepEqual(readWidthProblems(wider, 375), ["the page is 391 px wide at a 375 px viewport (theme button shown, live pill: Reconnecting): it scrolls sideways"], "the width rule's collector saw the page once; a word widens it after");
	assert.deepEqual(readWidthProblems(reads.map((b) => ({ ...b, scrollWidth: 380 })), 375), ["the page is 380 px wide at a 375 px viewport in every read of the bar: it scrolls sideways"]);
	assert.deepEqual(readWidthProblems([{ live: null, theme: null, parked: null, scrollWidth: null }], 375), [], "a read that took no width judges none");
	const states = words.map((word) => ({ cls: "live", word }));
	assert.deepEqual(liveReadProblems(reads, states), []);
	assert.deepEqual(liveReadProblems(reads.filter((b) => b.live !== "Signed out"), states), ["the bar was never read with the live pill reading Signed out, so no rule was held there"], "a read that skips the last word holds nothing there");
	assert.deepEqual(liveReadProblems([{ live: null, theme: "shown" }], states), [], "a page with no live pill has no word to read");
	const counted = ["128", "", "12,345"].map((parked) => ({ live: "Live", theme: "shown", parked }));
	assert.deepEqual(parkedReadProblems(counted), []);
	assert.deepEqual(parkedReadProblems(counted.slice(0, 2)), ["the bar was never read with the Parked count at 12,345, so no rule was held there"], "a read that never widened the count");
	assert.deepEqual(parkedReadProblems([counted[0]]), ["the bar was never read with no Parked count, the Parked count at 12,345, so no rule was held there"]);
	assert.deepEqual(parkedReadProblems([{ live: "Live", theme: "shown", parked: null }]), [], "a page with no count panel has no count to vary");
	// What the panel showed decides (a swap that wrote the drawn count back passed every run before).
	const seen = (parked, parkedText) => ({ live: "Live", theme: "shown", parked, parkedText });
	assert.deepEqual(parkedReadProblems([seen("128", "128 unanswered"), seen("", ""), seen("12,345", "12,345 unanswered")]), [], "each read's panel showed its count");
	assert.deepEqual(parkedReadProblems([seen("128", "128"), seen("", ""), seen("12,345", "128"), seen("12,345", "128")]), [
		'the bar was read as the Parked count at 12,345 while its Parked panel read "128" (and 1 more reads like it), so no rule was held at that count',
		"the bar was never read with the Parked count at 12,345, so no rule was held there",
	], "a wide read whose panel still showed the drawn count is no wide read");
	assert.deepEqual(parkedReadProblems([seen("128", "128"), seen("", "128"), seen("12,345", "12,345")]), [
		'the bar was read as no Parked count while its Parked panel read "128", so no rule was held at that count',
		"the bar was never read with no Parked count, so no rule was held there",
	], "an emptied read whose panel kept its count");
	assert.deepEqual(parkedReadProblems([seen("128", "  "), seen("", " "), seen("12,345", null)]), ['the bar was read as the Parked count at 128 while its Parked panel read "  ", so no rule was held at that count', "the bar was never read with the Parked count at 128, so no rule was held there"], "white space is no count; a read with no text recorded is taken at its label");
	const table = [{ cls: "live live--off", word: "Not live" }, { cls: "live", word: "Live" }, { cls: "live live--off", word: "Signed out" }];
	assert.deepEqual(liveStateProblems(table), ["the live pill draws Not live and Signed out with the same classes (live live--off), so a phone, which shows the state's glyph alone, cannot tell them apart"], "the first commit's table, which drew Signed out with Not live's classes");
	// One row: every part that shows meets the pi-dispatch pill's row.
	const brand = part("pi-dispatch", box(16, 180, 16, 64), [], { cls: "brandpill" });
	const row = (navTop) => ({ live: "Live", theme: "shown", parked: "128", nav: [part("Overview", box(200, 320, navTop, navTop + 48)), part("Runs", box(326, 430, navTop, navTop + 48))], end: [part("Live", box(1100, 1200, 16, 64), [], { tag: "span", id: "live-status", cls: "live" })], brand });
	assert.equal(ONE_ROW_WIDTH, 1440);
	assert.deepEqual(oneRowProblems([row(16)], { width: 1440 }), [], "the Shell card's row");
	assert.deepEqual(oneRowProblems([row(76)], { width: 1440 }), ['the top bar is not one row at 1440 px, as the Shell card draws it from 1440 px: <a> "Overview" is off the pi-dispatch pill\'s row']);
	assert.deepEqual(oneRowProblems([row(76)], { width: 1600 }).length, 1, "and wider");
	assert.deepEqual(oneRowProblems([row(76)], { width: 1439 }), [], "below it two rows are the layout");
	assert.deepEqual(oneRowProblems([row(76)], { width: 1440, readOnly: true }), [], "a read-only console's end holds the chip too: its one row starts later");
	assert.deepEqual(oneRowProblems([row(16), { ...row(76), live: "Reconnecting" }], { width: 1440 }), ['the top bar is not one row at 1440 px, as the Shell card draws it from 1440 px: <a> "Overview" is off the pi-dispatch pill\'s row (live pill: Reconnecting)'], "told once, with the reads it was seen in");
	assert.deepEqual(oneRowProblems([{ ...row(16), brand: null }], { width: 1440 }), ["the top bar shows no pi-dispatch pill to hold its one row to"]);
	assert.deepEqual(oneRowProblems([{ ...row(16), nav: [part("hidden", box(0, 0, 0, 0))] }], { width: 1440 }), [], "a part that draws nothing is on no row");
});

test("the signed-in name: cut off only with an ellipsis and itself whole as its title, and the longest one always cut", () => {
	const shown = part("ops", box(600, 700, 20, 36));
	const full = "m".repeat(32);
	const name = (extra = {}) => ({ text: full, title: full, scrollWidth: 385, clientWidth: 160, textOverflow: "ellipsis", overflowX: "hidden", part: shown, ...extra });
	assert.deepEqual(nameProblems(name(), { mustCut: true }), []);
	assert.deepEqual(nameProblems(name({ textOverflow: "clip" })), ["the signed-in name is cut off without an ellipsis (text-overflow: clip, overflow-x: hidden)"]);
	assert.deepEqual(nameProblems(name({ overflowX: "visible" })), ["the signed-in name is cut off without an ellipsis (text-overflow: ellipsis, overflow-x: visible)"], "an ellipsis needs an overflow that clips");
	assert.deepEqual(nameProblems(name({ title: null })), ["the signed-in name is cut off and has no title holding it whole"]);
	assert.deepEqual(nameProblems(name({ title: "mmm" })), ['the signed-in name is cut off and its title "mmm" does not hold it']);
	assert.deepEqual(nameProblems(name({ title: `${full}, Operator` }), { mustCut: true }), [], "the who block's title, the name and the role, holds the name");
	assert.deepEqual(nameProblems(name({ scrollWidth: 160, title: null }), { mustCut: true }), ["the longest name a token can have (32 characters) is not cut off: its 160 px of text fit its box, so the name's width has no cap"]);
	assert.deepEqual(nameProblems({ text: "ops", title: null, scrollWidth: 30, clientWidth: 30, textOverflow: "clip", overflowX: "visible", part: shown }), [], "a name that fits needs neither");
	assert.deepEqual(nameProblems(name({ title: null, part: part("ops", box(0, 0, 0, 0)) }), { mustCut: true }), [], "a phone hides the name: nothing to judge");
	assert.deepEqual(nameProblems(null, { mustCut: true }), []);
	// The role word, round 3's DejaVu find: cut with no title at 1440 px.
	const role = (extra = {}) => ({ text: "Operator", title: "ops, Operator", scrollWidth: 58, clientWidth: 41, textOverflow: "ellipsis", overflowX: "hidden", part: part("Operator", box(600, 641, 36, 50)), ...extra });
	assert.deepEqual(nameProblems(role(), { what: "role" }), [], "cut, with an ellipsis, and the title a reader gets there holds it");
	assert.deepEqual(nameProblems(role({ title: null }), { what: "role" }), ["the signed-in role is cut off and has no title holding it whole"]);
	assert.deepEqual(nameProblems(role({ title: "ops" }), { what: "role" }), ['the signed-in role is cut off and its title "ops" does not hold it'], "a title of the name alone does not tell the role");
	assert.deepEqual(nameProblems(role({ textOverflow: "clip" }), { what: "role" }), ["the signed-in role is cut off without an ellipsis (text-overflow: clip, overflow-x: hidden)"]);
	assert.deepEqual(nameProblems(role({ scrollWidth: 41 }), { what: "role", mustCut: false }), [], "a role that fits");
});

test("More: opened by a click, shown whole, inside the viewport, off its own button and under it", () => {
	assert.deepEqual([MORE_ALIGN, ...MORE_GAP], [1, 4, 8]);
	const summary = part("More: Audit", box(700, 748, 116, 156), [], { tag: "summary" });
	const open = (menu, extra = {}) => moreVerdict({ opened: true, summary, menu, width: 800, height: 900, ...extra });
	const under = box(568, 748, 162, 214);
	assert.deepEqual(moreVerdict(null), { ok: true, problems: [] }, "a viewer has no More");
	assert.deepEqual(open(part("Audit", under)), { ok: true, problems: [] }, "right edges aligned, 6 px below its button, inside the window");
	assert.deepEqual(open(part("Audit", under), { opened: false }), { ok: false, problems: ["a click on More did not open its menu"] }, "a shut menu has nothing else to judge");
	assert.deepEqual(open(null, { opened: false }).problems, ["a click on More did not open its menu"], "and its list, not drawn, is not also told as showing nothing");
	assert.deepEqual(open(part("Audit", box(568, 748, 112, 164))).problems, ["the open More menu covers its own button by 48.0 px x 40.0 px", "the open More menu starts 44.0 px above its button's bottom, not 4 to 8 px below it"]);
	// The window's edges, with the button gone, so they alone are judged.
	const alone = (menu) => open(menu, { summary: null }).problems;
	assert.deepEqual(alone(part("Audit", box(700, 880, 162, 214))), ["the open More menu ends 80.0 px past the right edge (at 880.0 px of 800)"]);
	assert.deepEqual(alone(part("Audit", box(-20, 160, 162, 214))), ["the open More menu starts 20.0 px left of the viewport"]);
	assert.deepEqual(alone(part("Audit", box(568, 748, 880, 932))), ["the open More menu ends 32.0 px below the viewport"]);
	assert.deepEqual(alone(part("Audit", box(568, 748, -10, 42))), ["the open More menu starts 10.0 px above the viewport"]);
	assert.deepEqual(alone(part("Audit", box(100, 280, 300, 352))), [], "a button that is gone can be neither covered nor opened under");
	// Cut by an overflow box, on any side.
	assert.deepEqual(open(part("Audit", under, [box(0, 700, 116, 156)])).problems, ["the open More menu shows nothing"], "clipped away entirely by the navigation's row");
	assert.deepEqual(open(part("Audit", under, [box(0, 700, 0, 900)])).problems, ["the open More menu is cut off at its right by an overflow box around it"]);
	assert.deepEqual(open(part("Audit", under, [box(0, 800, 0, 200)])).problems, ["the open More menu is cut off at its bottom by an overflow box around it"], "a list run past the bottom of a box around it");
	assert.deepEqual(open(part("Audit", under, [box(600, 800, 170, 900)])).problems, ["the open More menu is cut off at its left, top by an overflow box around it"]);
	assert.deepEqual(open(null).problems, ["the open More menu shows nothing"]);
	// Under its button.
	assert.deepEqual(open(part("Audit", box(544, 724, 162, 214))).problems, ["the open More menu's right edge is 24.0 px left of its button's (it opens under its button, right edges aligned)"]);
	assert.deepEqual(open(part("Audit", box(570, 750, 162, 214))).problems, ["the open More menu's right edge is 2.0 px right of its button's (it opens under its button, right edges aligned)"]);
	assert.deepEqual(open(part("Audit", box(569, 749, 162, 214))).problems, [], "within a pixel");
	assert.deepEqual(open(part("Audit", box(568, 748, 159, 211))).problems, ["the open More menu starts 3.0 px below its button's bottom, not 4 to 8 px below it"]);
	assert.deepEqual(open(part("Audit", box(568, 748, 165, 217))).problems, ["the open More menu starts 9.0 px below its button's bottom, not 4 to 8 px below it"]);
	assert.deepEqual([open(part("Audit", box(568, 748, 160, 212))).ok, open(part("Audit", box(568, 748, 164, 216))).ok], [true, true], "4 and 8 px are inside the rule");
	// Opening it brings its button whole into view, focus ring included: right after the click it is never cut.
	const away = part("More", box(700, 748, 116, 156), [box(0, 600, 0, 900)], { tag: "summary" });
	assert.deepEqual(open(part("Audit", box(380, 560, 162, 214)), { summary: away }).problems, ["the More menu opened with its button out of view"], "round 3's phone: a click left the button out of the row");
	const halfCut = part("More", box(580, 620, 116, 156), [box(0, 600, 0, 900)], { tag: "summary" });
	assert.deepEqual(open(part("Audit", box(440, 620, 162, 214)), { summary: halfCut }).problems, ["the More menu opened with its button cut off: 24.0 x 48.0 px of its 48.0 x 48.0 px show, focus ring included"], "where the button is cut the list is still held under the button's own box");
	const ringCut = part("More", box(550, 598, 116, 156), [box(0, 600, 0, 900)], { tag: "summary" });
	assert.deepEqual(open(part("Audit", box(418, 598, 162, 214)), { summary: ringCut }).problems, ["the More menu opened with its button cut off: 54.0 x 48.0 px of its 56.0 x 48.0 px show, focus ring included"], "its focus ring counts: 2 px of room is not the 4 px the ring reaches");
	assert.deepEqual(open(part("Audit", box(414, 594, 162, 214)), { summary: part("More", box(546, 594, 116, 156), [box(0, 600, 0, 900)], { tag: "summary" }) }).problems, [], "a button whole with its ring, inside its row");
});

test("a problem seen in some reads only says in which", () => {
	const words = ["Not live", "Live", "Reconnecting", "Signed out"];
	const all = ["shown", "hidden"].flatMap((theme) => words.map((live) => ({ live, theme })));
	assert.equal(readsNote(all, all), "");
	assert.equal(readsNote(all.filter((b) => b.theme === "shown"), all), " (theme button shown)");
	assert.equal(readsNote(all.filter((b) => b.live === "Reconnecting"), all), " (live pill: Reconnecting)", "with every theme button state: the word alone says it");
	assert.equal(readsNote([all[1], all[2]], all), " (theme button shown, live pill: Live, Reconnecting)");
	assert.equal(readsNote([...all.slice(0, 4), all[6]], all), " (theme button shown; theme button hidden, live pill: Reconnecting)");
	const plain = words.map((live) => ({ live, theme: null }));
	assert.equal(readsNote(plain.slice(1, 3), plain), " (live pill: Live, Reconnecting)", "a page with no theme button");
	const still = [{ live: null, theme: "shown" }, { live: null, theme: "hidden" }];
	assert.equal(readsNote([still[0]], still), " (theme button shown)", "a page with no live pill");
	// The Parked count is a third thing a read varies.
	const counted = ["128", "", "12,345"].flatMap((parked) => all.map((b) => ({ ...b, parked })));
	assert.equal(readsNote(counted.filter((b) => b.parked === "12,345"), counted), " (the Parked count at 12,345)");
	assert.equal(readsNote(counted.filter((b) => b.parked === "" && b.theme === "hidden"), counted), " (theme button hidden, no Parked count)");
	assert.equal(readsNote(counted.filter((b) => b.parked !== "128" && b.live === "Live"), counted), " (no Parked count, the Parked count at 12,345, live pill: Live)");
	assert.equal(readsNote(counted.filter((b) => (b.parked === "12,345" && b.theme === "shown") || (b.parked === "" && b.live === "Live" && b.theme === "hidden")), counted), " (theme button hidden, no Parked count, live pill: Live; theme button shown, the Parked count at 12,345)", "not every combination of what it was seen with: each theme button state and count told");
});

// A shell run's metrics as `shellMetrics` returns them, and the emulation probe's answer for a desktop window.
const metricsOf = (bars, extra = {}) => ({ bars, name: null, more: null, ...extra });

test("one shell run: the CSP, the emulation, the width rule at the window's width, each pair once, every pill whole, a steady bar, the name and More", () => {
	const nav = (right) => [part("Configuration", box(600, right), [])];
	const end = (word, left) => [part(word, box(left, 720), [], { tag: "span", id: "live-status", cls: "live" }), part("Sign out", box(730, 778), [], { tag: "button", id: "logout", cls: "roundbtn" })];
	const bar = (live, navRight, endLeft, extra = {}) => ({ live, theme: null, height: 56, nav: nav(navRight), end: end(live, endLeft), brand: null, ...extra });
	const bars = [bar("Live", 700, 660), bar("Reconnecting", 700, 610), bar("Not live", 600.2, 630)];
	const measured = { scrollWidth: 800, clientWidth: 800, elements: [] };
	const base = { width: 800, csp: [], measured, emulation: desk(800) };
	const v = shellVerdict({ ...base, metrics: metricsOf(bars) });
	assert.deepEqual(v.failures, ['the navigation\'s <a> "Configuration" overlaps <span id="live-status" class="live"> "Reconnecting" by 90.0 x 48.0 px (live pill: Live, Reconnecting)'], "one line for the pair, named as it was at its widest, with the words it overlapped under");
	assert.deepEqual(v.overlaps, [{ a: '<a> "Configuration"', b: '<span id="live-status" class="live"> "Reconnecting"', x: 90, y: 48 }]);
	const tall = [{ ...bar("Reconnecting", 700, 680), end: [part("Reconnecting", box(680, 720, 0, 48), [], { tag: "span", id: "live-status", cls: "live live--retry" })] }, { ...bar("Live", 700, 650), end: [part("Live", box(650, 720, 0, 20), [], { tag: "span", id: "live-status", cls: "live" })] }];
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(tall) }).overlaps, [{ a: '<a> "Configuration"', b: '<span id="live-status" class="live"> "Live"', x: 50, y: 48 }], "x where the overlap was widest, y the largest seen");
	const fits = [bar("Live", 640, 660)];
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits) }), { failures: [], notes: [], overlaps: [] });
	const wide = shellVerdict({ ...base, measured: { scrollWidth: 988, clientWidth: 800, elements: [el("details", 937.6, 987.6, { cls: "more" })] }, metrics: metricsOf(fits) });
	assert.deepEqual(wide.failures, ["the page is 988 px wide at a 800 px viewport", '<details class="more"> ends at 987.6 px (left 937.6), outside any scroll box that fits']);
	const zoomed = shellVerdict({ width: 375, csp: [], measured: { scrollWidth: 2332, clientWidth: 2332, elements: [] }, emulation: PHONE, metrics: metricsOf(fits) });
	assert.deepEqual(zoomed.failures, ["the page is 2332 px wide at a 375 px viewport", "no element's box ends past the edge: text running out of its box (a word that cannot wrap), a margin, a pseudo-element or a transform widens the page"], "the edge is the window's, even where a phone's viewport zoomed out with the page");
	assert.deepEqual(zoomed.notes, ["the layout viewport is 2332 px, not 375"]);
	assert.deepEqual(shellVerdict({ ...base, csp: [{ directive: "img-src", blocked: "https://x.example/a.png", source: "", line: 0, sample: "" }], metrics: metricsOf(fits) }).failures, ["CSP violation: img-src refused https://x.example/a.png"]);
	assert.deepEqual(shellVerdict({ ...base, emulation: PHONE, metrics: metricsOf(fits) }).failures, emulationProblems(PHONE, false), "an 800 px window emulated as a phone's");
	assert.deepEqual(shellVerdict({ ...base, width: 375, measured: { scrollWidth: 375, clientWidth: 375, elements: [] }, metrics: metricsOf(fits) }).failures, emulationProblems(desk(800), true), "a 375 px run is a phone's by default");
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf([]) }).failures, ["the page has no top bar (header.top)"]);
	assert.deepEqual(shellVerdict({ ...base, metrics: { bars: null, name: null, more: null } }).failures, ["the page has no top bar (header.top)"]);
	// Every pill whole above a phone's width, each told once where least of it showed.
	const cut = [bar("Live", 640, 660, { nav: [part("Spend", box(500, 600), []), part("Audit", box(760, 820), [])], end: [] }), bar("Reconnecting", 640, 660, { nav: [part("Spend", box(500, 600), []), part("Audit", box(810, 850), [])], end: [] })];
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(cut) }).failures, ['the navigation\'s <a> "Audit" is hidden: none of it shows'], "past the window in one read, cut in the other: told where none of it showed");
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(cut.slice(0, 1)) }).failures, ['the navigation\'s <a> "Audit" is cut off: 44.0 x 56.0 px of its 68.0 x 56.0 px show, focus ring included']);
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf([cut[0], bar("Reconnecting", 640, 660, { end: [] })]) }).failures, ['the navigation\'s <a> "Audit" is cut off: 44.0 x 56.0 px of its 68.0 x 56.0 px show, focus ring included (live pill: Live)']);
	// The height at every width, a phone's too (round 3: the server's Not live a row taller than Live on a phone).
	const jumpy = [bar("Live", 640, 660), bar("Reconnecting", 640, 660, { height: 116 })];
	const jumped = "the top bar is 116.0 px tall with the live pill reading Reconnecting and 56.0 px with it reading Live: it jumps when the live word changes";
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(jumpy) }).failures, [jumped]);
	assert.deepEqual(shellVerdict({ width: 375, csp: [], measured: { scrollWidth: 375, clientWidth: 375, elements: [] }, emulation: PHONE, metrics: metricsOf(jumpy) }).failures, [jumped], "a phone's bar may not move either");
	// Every live word read, the page's width in each read, and one row from 1440 px unless read-only.
	const states = ["Live", "Reconnecting", "Signed out"].map((word) => ({ cls: "live", word }));
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits), liveStates: states }).failures, ["the bar was never read with the live pill reading Reconnecting, Signed out, so no rule was held there"]);
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf([{ ...fits[0], scrollWidth: 830 }]) }).failures, ["the page is 830 px wide at a 800 px viewport in every read of the bar: it scrolls sideways"]);
	assert.deepEqual(shellVerdict({ ...base, measured: { scrollWidth: 830, clientWidth: 800, elements: [] }, metrics: metricsOf([{ ...fits[0], scrollWidth: 830 }]) }).failures, ["the page is 830 px wide at a 800 px viewport", "no element's box ends past the edge: text running out of its box (a word that cannot wrap), a margin, a pseudo-element or a transform widens the page"], "where the page was wide as the script left it, the width rule says so once");
	const twoRows = [{ ...fits[0], brand: part("pi-dispatch", box(16, 180, 0, 48)), nav: [part("Configuration", box(600, 640, 56, 104), [])] }];
	const at1440 = { ...base, width: 1440, measured: { scrollWidth: 1440, clientWidth: 1440, elements: [] }, emulation: desk(1440) };
	assert.deepEqual(shellVerdict({ ...at1440, metrics: metricsOf(twoRows) }).failures, ['the top bar is not one row at 1440 px, as the Shell card draws it from 1440 px: <a> "Configuration" is off the pi-dispatch pill\'s row']);
	assert.deepEqual(shellVerdict({ ...at1440, metrics: metricsOf(twoRows), readOnly: true }).failures, [], "a read-only console's one row starts at a wider window");
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits, { widened: false }) }).failures, ["the Parked count could not be widened: its panel never read 128, so the bar was not read with 12,345"]);
	// The name, and More.
	const longName = { text: "m".repeat(32), title: null, scrollWidth: 160, clientWidth: 160, textOverflow: "ellipsis", overflowX: "hidden", part: part("m", box(600, 760, 20, 36)) };
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits, { name: longName }), longest: true }).failures, nameProblems(longName, { mustCut: true }));
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits, { name: longName }) }).failures, [], "only the longest name must be cut");
	const cutRole = { text: "Operator", title: null, scrollWidth: 58, clientWidth: 41, textOverflow: "ellipsis", overflowX: "hidden", part: part("Operator", box(600, 641, 36, 50)) };
	assert.deepEqual(shellVerdict({ ...base, metrics: metricsOf(fits, { roleWord: cutRole }) }).failures, ["the signed-in role is cut off and has no title holding it whole"], "the role word is held to the same rule");
	const notCut = shellVerdict({ width: 375, csp: [], measured: { scrollWidth: 375, clientWidth: 375, elements: [] }, emulation: PHONE, metrics: metricsOf(fits, { more: { opened: true, cutFirst: false, summary: part("More", box(319, 359, 116, 156)), menu: part("Audit", box(179, 359, 162, 214)), width: 375, height: 812 } }) });
	assert.deepEqual([notCut.failures, notCut.notes], [[], ["More's button could not be cut at the navigation's edge before the click (the row does not scroll that far), so the click found it whole"]], "a row too short to cut the button: said, not failed");
	const covered = shellVerdict({ width: 375, csp: [], measured: { scrollWidth: 375, clientWidth: 375, elements: [] }, emulation: PHONE, metrics: metricsOf(fits, { more: { opened: true, summary: part("More", box(319, 359, 116, 156)), menu: part("Audit", box(179, 359, 162, 214)), width: 375, height: 812 } }) });
	assert.deepEqual(covered.failures, []);
	const misplaced = shellVerdict({ width: 375, csp: [], measured: { scrollWidth: 375, clientWidth: 375, elements: [] }, emulation: PHONE, metrics: metricsOf(fits, { more: { opened: true, summary: part("More", box(319, 359, 116, 156)), menu: part("Audit", box(179, 359, 112, 164)), width: 375, height: 812 } }) });
	assert.deepEqual(misplaced.failures, ["the open More menu covers its own button by 40.0 px x 40.0 px", "the open More menu starts 44.0 px above its button's bottom, not 4 to 8 px below it"]);
	const many = [{ live: null, theme: null, height: 56, nav: Array.from({ length: 10 }, (_, i) => part(`p${i}`, box(i * 10 + 4, 500))), end: [part("who", box(0, 600))], brand: null }];
	const crowded = shellVerdict({ ...base, metrics: metricsOf(many) }).failures;
	assert.equal(crowded.length, 9, "eight overlaps, widest first, then how many more");
	assert.equal(crowded[8], "2 more overlaps in the top bar");
	assert.match(crowded[0], /"p0" overlaps .* by 496\.0 x 48\.0 px$/);
});

test("a shell run's glue: the window it asked for, its doc's longest name, and the page's raw measure through shellMetrics", () => {
	const longest = { width: 1024, mobile: false, doc: { longest: true } };
	const bare = measure(["header", { cls: "top", rect: box(0, 1000, 0, 56), role: "top" }, ["nav", { cls: "pillnav", rect: box(0, 600, 0, 56), role: "nav" }], ["div", { cls: "top__end", rect: box(600, 1000, 0, 56), role: "end" }, ["span", { cls: "who", rect: box(800, 1000, 0, 56) }, ["b", { rect: box(810, 990, 20, 36), role: "name" }]]]]);
	const name = { text: "m".repeat(32), title: null, scrollWidth: 180, clientWidth: 180, textOverflow: "ellipsis", overflowX: "hidden" };
	const got = { csp: [], errors: [], measured: { scrollWidth: 1024, clientWidth: 1024, elements: [] }, bar: { nodes: bare.nodes, roles: bare.roles, reads: [{ live: null, theme: null, snap: bare.snap }], name }, more: null, emulation: desk(1024), settled: true };
	assert.deepEqual(shellRunVerdict(longest, got).failures, ["the longest name a token can have (32 characters) is not cut off: its 180 px of text fit its box, so the name's width has no cap"]);
	assert.deepEqual(shellRunVerdict({ ...longest, doc: { longest: false } }, got).failures, []);
	assert.deepEqual(shellRunVerdict({ ...longest, mobile: true }, got).failures.slice(0, 2), emulationProblems(desk(1024), true), "the run's own mobile flag, not one guessed from its width");
	assert.deepEqual(shellRunVerdict(longest, { ...got, bar: null }).failures, ["the page has no top bar (header.top)"]);
	// The live words it must have read, handed in by the run, and the doc's read-only console.
	const read = { ...got, bar: { ...got.bar, reads: [{ live: "Live", theme: null, snap: bare.snap }], name: null } };
	const plain = { ...longest, doc: { longest: false } };
	assert.deepEqual(shellRunVerdict(plain, read, [{ cls: "live", word: "Live" }, { cls: "live live--off live--out", word: "Signed out" }]).failures, ["the bar was never read with the live pill reading Signed out, so no rule was held there"], "the words come from the run, not from what the page chose to read");
	const wide = { ...plain, width: 1440, doc: { longest: false, readOnly: false } };
	const atWide = { ...read, measured: { scrollWidth: 1440, clientWidth: 1440, elements: [] }, emulation: desk(1440) };
	assert.match(shellRunVerdict(wide, atWide).failures.join("\n"), /the top bar shows no pi-dispatch pill to hold its one row to/, "one row is judged for a console that is not read-only");
	assert.deepEqual(shellRunVerdict({ ...wide, doc: { longest: false, readOnly: true } }, atWide).failures, [], "and not for a read-only one, by the doc's flag");
});

test("the run without page scripts: More opened by a real click, placed under its button by CSS alone", () => {
	assert.deepEqual(NO_SCRIPT, { doc: "shell.operator.overview", width: 1024 });
	assert.ok(NO_SCRIPT.width > PHONE_MAX, "above a phone, where the CSS alone places the list");
	const at = measure(["header", { cls: "top", rect: box(0, 1024, 0, 120), position: "relative", role: "top" },
		["nav", { cls: "pillnav", rect: box(16, 1008, 64, 112), role: "nav" },
			["details", { cls: "more", rect: box(700, 748, 64, 112), position: "relative", role: "more" },
				["summary", { rect: box(700, 748, 64, 112), label: "More: Audit", role: "summary" }],
				["div", { rect: box(568, 748, 118, 170), position: "absolute", label: "Audit", role: "menu" }]]]]);
	const more = { opened: true, cutFirst: null, nodes: at.nodes, roles: at.roles, snap: at.snap, width: 1024, height: 900 };
	const measured = { scrollWidth: 1024, clientWidth: 1024, elements: [] };
	const off = { width: 1024, measured, more, emulation: desk(1024), themeHidden: true };
	assert.deepEqual(noScriptVerdict(off), { failures: [], notes: [] });
	const placedByScript = { ...more, snap: at.snap.map((s, i) => (i === at.roles.menu ? { ...s, rect: box(844, 1024, 118, 170) } : s)) };
	assert.deepEqual(noScriptVerdict({ ...off, more: placedByScript }).failures, ["the open More menu's right edge is 276.0 px right of its button's (it opens under its button, right edges aligned)"], "a list the script would have moved, left where the bar's own box puts it");
	assert.deepEqual(noScriptVerdict({ ...off, more: { ...more, opened: false } }).failures, ["a click on More did not open its menu"]);
	assert.deepEqual(noScriptVerdict({ ...off, more: null }).failures, ["the page has no More menu to open without its script"]);
	assert.deepEqual(noScriptVerdict({ ...off, emulation: PHONE }).failures, emulationProblems(PHONE, false), "a desktop's window");
	// The proof the run was made with scripts off (the same run with scripts on passed before): the
	// script reveals the theme button on load, so a button still hidden is a page whose script never ran.
	assert.deepEqual(noScriptVerdict({ ...off, themeHidden: false }).failures, ["the theme button was shown, so the page's script ran: this run must be made with page scripts off (Emulation.setScriptExecutionDisabled)"], "a page whose script ran, however well its More was placed");
	assert.deepEqual(noScriptVerdict({ ...off, themeHidden: null }).failures, ["the page has no theme button ([data-theme-toggle]), so nothing shows its script stayed off"]);
	assert.deepEqual(noScriptVerdict({ ...off, themeHidden: undefined }).failures, noScriptVerdict({ ...off, themeHidden: null }).failures, "a read never made proves nothing either");
});

test("the ratchet: a pending page may overflow, a pending page that fits fails, and an entry must name a page", () => {
	assert.ok(Object.isFrozen(WIDTH_PENDING));
	const pages = ["overview", "insights", "login"];
	const clean = ratchetVerdict({ pending: [], widthFailed: new Map(), pages });
	assert.deepEqual([clean.failures, clean.notes, [...clean.exempt]], [[], [], []]);
	const still = ratchetVerdict({ pending: ["insights"], widthFailed: new Map([["insights", 8]]), pages });
	assert.deepEqual(still.failures, []);
	assert.deepEqual(still.notes, ["insights is in WIDTH_PENDING: 8 of its runs still overflow"]);
	assert.ok(still.exempt.has("insights"));
	const fixed = ratchetVerdict({ pending: ["insights"], widthFailed: new Map(), pages });
	assert.deepEqual(fixed.failures, [`insights now fits at ${VIEWPORT.width} px in every run: remove it from WIDTH_PENDING (the list only shrinks)`]);
	assert.deepEqual(ratchetVerdict({ pending: ["spend"], widthFailed: new Map(), pages }).failures, ["WIDTH_PENDING lists spend, which is not a page this check loads"]);
	assert.deepEqual(ratchetVerdict({ pending: ["insights", "insights"], widthFailed: new Map([["insights", 1]]), pages }).failures, ["WIDTH_PENDING lists insights twice"]);
	assert.ok(!ratchetVerdict({ pending: ["insights"], widthFailed: new Map([["overview", 2], ["insights", 1]]), pages }).exempt.has("overview"), "only a listed page is exempt");
});

test("goldens: named <shot>.<role>.html, and a page with none for a role is a problem before any browser runs", () => {
	assert.deepEqual(goldenName("runs-filtered.operator.html"), { shot: "runs-filtered", role: "operator" });
	assert.equal(goldenName("runs.admin.html"), null);
	assert.equal(goldenName("Runs.viewer.html"), null);
	assert.equal(goldenName("runs.viewer.htm"), null);
	// A page nobody is signed in to (a sign-in page, an error page drawn without a session) is the anonymous role's.
	assert.deepEqual(GOLDEN_ROLES, ["operator", "viewer", "anonymous"]);
	assert.deepEqual(goldenName("login.anonymous.html"), { shot: "login", role: "anonymous" });
	assert.deepEqual(goldenName("error-421.anonymous.html"), { shot: "error-421", role: "anonymous" });
	assert.deepEqual(goldenName("login-ended-idle.anonymous.html"), { shot: "login-ended-idle", role: "anonymous" }, "a panel golden's name too");
	for (const bad of ["login.anon.html", "login.signed-out.html", "login.anonymous.operator.html", "login.Anonymous.html"]) assert.equal(goldenName(bad), null, bad);
	const files = ["overview.operator.html", "overview.viewer.html", "audit.operator.html", "runs-filtered.viewer.html"];
	assert.deepEqual(missingGoldens(files, ["overview", "audit", "runs"]), ["no golden audit.viewer.html for the page audit", "no golden runs.operator.html for the page runs", "no golden runs.viewer.html for the page runs"]);
	assert.deepEqual(missingGoldens(files, ["overview"]), []);
	const top = { docs: files.map((file) => ({ file })), problems: ["x.html is not named <shot>.<role>.html"] };
	assert.deepEqual(goldenProblems({ top, panels: { docs: [], problems: ["panels/y.html has no <body data-page>"] }, pageNames: ["overview", "audit"] }), [
		"x.html is not named <shot>.<role>.html",
		"panels/y.html has no <body data-page>",
		"no golden audit.viewer.html for the page audit",
		"no golden login.anonymous.html for the sign-in page /login (one of the pages harness's static shots)",
		"no golden login-code.anonymous.html for the sign-in page /login/code (one of the pages harness's static shots)",
	]);
	// The sign-in pages are required by name: each its own golden, of its own page.
	const signIn = [{ file: "login.anonymous.html", page: "login" }, { file: "login-code.anonymous.html", page: "login-code" }];
	assert.deepEqual(signInProblems(signIn), []);
	assert.deepEqual(signInProblems([signIn[0], { file: "login-code.anonymous.html", page: "login" }]), ['login-code.anonymous.html draws the page login, not the sign-in page /login/code (data-page="login-code")']);
	assert.deepEqual(signInProblems([{ file: "panels/login.anonymous.html", page: "login" }, signIn[1]]), ["no golden login.anonymous.html for the sign-in page /login (one of the pages harness's static shots)"], "a panel golden is not the page's golden");
	// The one-time link page is loaded with a code, so it stays in the state its golden drew; every other page as it is.
	assert.match(LINK_CODE_FRAGMENT, /^#[A-Za-z0-9_-]{20,}$/);
	assert.equal(goldenUrl({ page: "login-code", path: "/fixtures/login-code.anonymous.html" }), `/fixtures/login-code.anonymous.html${LINK_CODE_FRAGMENT}`);
	assert.equal(goldenUrl({ page: "login-code", path: "/fixtures/panels/login-code-used.anonymous.html" }), `/fixtures/panels/login-code-used.anonymous.html${LINK_CODE_FRAGMENT}`);
	assert.equal(goldenUrl({ page: "login", path: "/fixtures/login.anonymous.html" }), "/fixtures/login.anonymous.html");
	assert.equal(goldenUrl({ page: "login-code", path: "/fixtures/x.html" }, "/forced/dark/x.html"), `/forced/dark/x.html${LINK_CODE_FRAGMENT}`, "a forced run's path, fragment and all");
});

test("the sign-in pages measured are every sign-in page the console serves, each by its anonymous golden", async () => {
	const shell = await at("admin/src/console/shell.mjs");
	const { ROUTES } = await at("admin/src/console/server.mjs");
	const signInRoutes = ROUTES.filter((r) => r.method === "GET" && r.auth === "none" && /^\/login(?:\/|$)/.test(r.path)).map((r) => r.path).sort();
	assert.deepEqual(SIGN_IN.map(([, path]) => path).sort(), signInRoutes, "every GET /login route");
	// Every page shell.mjs draws outside PAGES is one of them, and draws the data-page its golden is held to.
	const pageFns = Object.keys(shell).filter((k) => /Page$/.test(k) && typeof shell[k] === "function").sort();
	const drawn = pageFns.map((fn) => /<body\b[^>]*\sdata-page="([^"]*)"/.exec(String(shell[fn]({})))?.[1] ?? null).sort();
	assert.deepEqual(SIGN_IN.map(([page]) => page).sort(), drawn, `the pages ${pageFns.join(" and ")} draw`);
	for (const [page, , file] of SIGN_IN) assert.equal(file, `${page}.anonymous.html`, "named as the harness names a static shot");
	// And the goldens hold them, as the run reads them.
	const top = readGoldens(FIXTURES, "");
	assert.deepEqual(signInProblems(top.docs), [], "the pages harness's static shots are in the goldens");
});

test("forced themes carry exactly the head page() draws for the theme: data-theme and the color-scheme meta", async () => {
	const { page, html } = await at("admin/src/console/html.mjs");
	const drawn = (theme) => String(page({ title: "t", name: "overview", body: html`<p>x</p>`, theme }));
	const heads = { system: themeHead(drawn(null)), light: themeHead(drawn("light")), dark: themeHead(drawn("dark")) };
	assert.deepEqual(heads.system, { htmlTag: '<html lang="en">', schemeMeta: '<meta name="color-scheme" content="light dark">' });
	for (const theme of ["light", "dark"]) {
		assert.equal(injectTheme(drawn(null), heads.system, heads[theme]), drawn(theme), `a golden forced ${theme} is byte for byte the page the cookie gets`);
		assert.match(heads[theme].htmlTag, new RegExp(`data-theme="${theme}"`));
		assert.equal(heads[theme].schemeMeta, `<meta name="color-scheme" content="${theme}">`);
	}
	assert.throws(() => injectTheme(drawn("dark"), heads.system, heads.light), /holds <html lang="en"> 0 times, not once/, "a golden already drawn in a theme is refused");
	assert.throws(() => injectTheme(drawn(null).replace('<meta name="color-scheme" content="light dark">', ""), heads.system, heads.dark), /color-scheme" content="light dark"> 0 times/);
	assert.throws(() => themeHead("<p>fragment</p>"), /0 <html> tags, not one/);
	assert.throws(() => themeHead('<html lang="en"><meta name="color-scheme" content="dark"><meta name="color-scheme" content="dark">'), /2 color-scheme metas, not one/);
	const docs = [{ id: FORCED_DOC }, { id: "login" }];
	const runs = planRuns(docs);
	assert.equal(runs.length, docs.length * 2 + 2);
	assert.deepEqual(runs.filter((r) => r.forced).map((r) => [r.doc.id, r.emulated, r.forced, r.expect, r.label]), [[FORCED_DOC, "light", "dark", "dark", "forced-dark"], [FORCED_DOC, "dark", "light", "light", "forced-light"]]);
	assert.ok(runs.filter((r) => !r.forced).every((r) => r.expect === r.emulated));
	assert.equal(new Set(runs.map((r) => r.key)).size, runs.length, "every run has its own key");
	assert.throws(() => planRuns([{ id: "login" }]), /no golden overview\.operator\.html/);
});

test("the shell sweep signs in as an operator, a viewer, a read-only console and the longest name the token rule takes", () => {
	const longest = longestName(TOKEN_NAME_RE);
	assert.equal(longest, "m".repeat(32), "TOKEN_NAME_RE takes 32 characters");
	assert.ok(TOKEN_NAME_RE.test(longest) && !TOKEN_NAME_RE.test(`${longest}m`));
	assert.equal(longestName(/^[a-z]{1,5}$/, "w"), "wwwww");
	assert.throws(() => longestName(/^[a-z]+$/), /takes 256 characters: no longest name/, "a rule with no bound has no longest name");
	assert.throws(() => longestName(/^[0-9]+$/), /takes no name/);
	const contexts = shellContexts(TOKEN_NAME_RE);
	assert.deepEqual(contexts.map((c) => [c.id, c.session.role, c.readOnly, c.longest]), [["operator", "operator", false, false], ["viewer", "viewer", false, false], ["read-only", "operator", true, false], ["longest-name", "operator", true, true]], "the longest name is the one whose name must be cut off");
	assert.equal(contexts[3].session.name, longest);
	for (const c of contexts) assert.ok(TOKEN_NAME_RE.test(c.session.name), `${c.id} signs in with a name a token can have`);
	assert.deepEqual([...SHELL_WIDTHS], [320, 375, 761, 800, 940, 1024, 1180, 1280, 1440, 1600], "the narrowest phone, the usual one, the desktop widths the reviews measured the bar failing at, and the layout's tightest places");
	assert.ok(SHELL_WIDTHS.includes(VIEWPORT.width), "the phone is one of them");
	assert.ok(SHELL_WIDTHS.includes(CONTROL_WIDTH) && CONTROL_WIDTH > PHONE_MAX, "the first control is drawn at a desktop width the sweep loads, where its nine rules apply");
	assert.ok(SHELL_WIDTHS.includes(PHONE_CONTROL_WIDTH) && PHONE_CONTROL_WIDTH <= VIEWPORT.width, "the phone's control at a phone width the sweep loads, emulated as a phone");
	assert.ok(SHELL_WIDTHS.includes(NO_SCRIPT.width));
});

test("the sweep's widths and the one-row width are the top bar's own breakpoints", async () => {
	const { TOP_BAR } = await at("admin/src/console/page-css.mjs");
	assert.equal(PHONE_MAX, TOP_BAR.phoneMax, "the phone breakpoint the check judges by is the bar's");
	assert.equal(ONE_ROW_WIDTH, TOP_BAR.oneRowMin, "one row for a console that is not read-only from the bar's own threshold, the Shell card's 1440");
	for (const [what, width] of [["the first width above a phone", TOP_BAR.phoneMax + 1], ["the first two-row width with the navigation unbroken", TOP_BAR.navBreakMax + 1], ["the first one-row width", TOP_BAR.oneRowMin], ["a read-only console's first one-row width", TOP_BAR.oneRowReadOnlyMin]]) {
		assert.ok(SHELL_WIDTHS.includes(width), `${what}, ${width} px, is loaded: a moved breakpoint moves the sweep`);
	}
});

test("the bar's numbers are the bundle's: its phone breakpoint and its focus ring", async () => {
	const { PULSE_CSS } = await at("admin/src/console/pulse-css.mjs");
	assert.deepEqual([...new Set(PULSE_CSS.match(/@media \(max-width: \d+px\)/g))], [`@media (max-width: ${PHONE_MAX}px)`], "one phone breakpoint, and it is PHONE_MAX");
	const ring = /(?:^|\})\s*:focus-visible \{ outline: (\d+)px solid [^;]+; outline-offset: (\d+)px; \}/.exec(PULSE_CSS);
	assert.ok(ring, "bundle.css draws the focus ring on :focus-visible");
	assert.equal(Number(ring[1]) + Number(ring[2]), FOCUS_RING, "FOCUS_RING is the outline and its offset");
});

test("the shell sweep's run page is titled with a 120-character id the run page accepts, and each page meets each width", async () => {
	const { parsePageQuery } = await at("admin/src/console/pages.mjs");
	const accepts = (id) => parsePageQuery("run", new URLSearchParams({ id })).query?.id === id;
	const id = longRunId(accepts);
	assert.equal(id.length, RUN_ID_LENGTH);
	assert.equal(RUN_ID_LENGTH, 120);
	assert.match(id, /^[a-z0-9]+$/, "no hyphen, dot or colon a browser could break at");
	assert.throws(() => longRunId(() => false), /refuses a 120-character run id/);
	const drawn = [];
	const docs = await shellDocs({ pageNames: ["overview", "run"], contexts: shellContexts(TOKEN_NAME_RE).filter((c) => c.id === "operator" || c.id === "longest-name"), runId: id, draw: async (name, ctx) => (drawn.push([name, ctx]), { status: 200, html: { toString: () => `<body data-page="${name}">` } }) });
	assert.deepEqual(docs.map((d) => [d.id, d.path, d.page, d.role, d.longest, d.readOnly]), [["shell.operator.overview", "/shell/operator/overview", "overview", "operator", false, false], ["shell.operator.run", "/shell/operator/run", "run", "operator", false, false], ["shell.longest-name.overview", "/shell/longest-name/overview", "overview", "longest-name", true, true], ["shell.longest-name.run", "/shell/longest-name/run", "run", "longest-name", true, true]]);
	assert.equal(docs[1].html, '<body data-page="run">');
	assert.deepEqual(drawn[1][1], { session: { name: "ops", role: "operator" }, readOnly: false, data: { parkedCount: PARKED_SHOWN }, query: { id }, theme: null });
	assert.deepEqual(drawn[0][1].query, {}, "only the run page names a run");
	const runs = planShellRuns(docs);
	assert.equal(runs.length, docs.length * SHELL_WIDTHS.length);
	assert.deepEqual(runs.filter((r) => r.mobile).map((r) => r.width), [320, 375, 320, 375, 320, 375, 320, 375], "a phone's emulation at a phone's widths alone");
	assert.ok(runs.filter((r) => !r.mobile).every((r) => r.width > VIEWPORT.width));
	assert.equal(new Set(runs.map((r) => r.key)).size, runs.length);
	assert.deepEqual(parkedCounts(), { drawn: "128", wide: "12,345" }, "the count drawn and the one swapped in, grouped as the kit draws a count");
	assert.equal(String(PARKED_WIDE).length, 5);
	const { count } = await at("admin/src/console/kit.mjs");
	assert.match(String(count(PARKED_SHOWN, "parked")), new RegExp(`>${parkedCounts().drawn}<`), "the kit draws the sweep's count as the read looks for it");
	assert.match(String(count(PARKED_WIDE, "parked")), new RegExp(`>${parkedCounts().wide}<`), "and the wide one as it swaps it in");
});

// ---- the negative control ---------------------------------------------------------------------------------------

/** The live states the bar is read with, from the shell's own table, and its Reconnecting one. */
async function shellLive() {
	const { LIVE_STATES } = await at("admin/src/console/shell.mjs");
	return { states: liveStatesOf(LIVE_STATES), retry: LIVE_STATES.retry };
}

/**
 * The control's measure as Chrome reports it, worked out from the coordinates `controlCss` sets (its docblock lists
 * them): the bar read at each live word with the theme button shown and hidden, the name, and More opened.
 */
function controlMeasure(states, retry) {
	const tree = ({ word, cls, hidden, menu }) => {
		const height = 48 + (cls === retry.cls ? 60 : 0) + (hidden ? 24 : 0);
		const pill = (label, left, right) => ["a", { rect: box(left, right, 12, 60), position: "absolute", overflow: "hidden", label }];
		const end = (left, right) => box(left, right, 12, 60);
		return ["div", { cls: "page", rect: box(0, 1024, 0, 324) },
			["header", { cls: "top", rect: box(12, 1012, 12, 12 + height), position: "relative", role: "top" },
				["a", { cls: "brandpill", rect: end(12, 132), position: "absolute", overflow: "hidden", label: "pi-dispatch", role: "brand" }],
				["nav", { cls: "pillnav", rect: box(138, 642, 8, 128), position: "absolute", overflow: "hidden", role: "nav" },
					pill("Overview", 142, 232),
					pill("Runs", 238, 328),
					["details", { cls: "more", rect: end(334, 382), position: "absolute", label: "More", role: "more" },
						["summary", { rect: end(334, 382), overflow: "hidden", label: "More: Audit", role: "summary" }],
						["div", { rect: menu ? box(198, 358, 66, 146) : box(0, 0, 0, 0), position: "absolute", label: "Audit", role: "menu" }, ["a", {}]]],
					pill("Parked", 388, 478),
					pill("Spend", 484, 584),
					pill("Fleet", 662, 752)],
				["div", { cls: "top__end", rect: end(662, 1012), position: "absolute", role: "end" },
					["span", { id: "live-status", cls, rect: end(524, 624), position: "absolute", overflow: "hidden", label: word }, ["span", {}]],
					["button", { cls: "roundbtn", rect: hidden ? box(0, 0, 0, 0) : end(662, 710), position: "absolute", overflow: "hidden", label: "Theme", role: "theme" }],
					["span", { cls: "chip", rect: end(718, 848), position: "absolute", overflow: "hidden", label: "Read-only console" }],
					["span", { cls: "who", rect: end(828, 958), position: "absolute", overflow: "hidden", label: "m".repeat(32) }, ["span", {}, ["b", { rect: box(828, 928, 12, 28), overflow: "hidden", role: "name" }]]],
					["button", { id: "logout", cls: "roundbtn", rect: end(964, 1012), position: "absolute", overflow: "hidden", label: "Sign out" }]]]];
	};
	const first = measure(tree({ word: states[0].word, cls: states[0].cls, hidden: false, menu: false }));
	const reads = [false, true].flatMap((hidden) => states.map((s) => ({ live: s.word, theme: hidden ? "hidden" : "shown", snap: measure(tree({ word: s.word, cls: s.cls, hidden, menu: false })).snap })));
	const open = measure(tree({ word: states[0].word, cls: states[0].cls, hidden: false, menu: true }));
	return {
		bar: { nodes: first.nodes, roles: first.roles, reads, name: { text: "m".repeat(32), title: null, scrollWidth: 385, clientWidth: 100, textOverflow: "clip", overflowX: "hidden" }, width: 1024, height: 900 },
		more: { opened: true, nodes: open.nodes, roles: open.roles, snap: open.snap, width: 1024, height: 900 },
	};
}

test("the negative control: its geometry, judged by the same rules, is exactly what it is built to fail with, once each", async () => {
	const { states, retry } = await shellLive();
	const doc = controlDoc(states, retry);
	const measured = { scrollWidth: CONTROL_WIDTH, clientWidth: CONTROL_WIDTH, elements: [] };
	const v = shellVerdict({ width: CONTROL_WIDTH, mobile: false, csp: [], measured, metrics: shellMetrics(controlMeasure(states, retry)), emulation: desk(CONTROL_WIDTH), longest: doc.longest });
	assert.deepEqual(v.failures, doc.expected, "a 60 px overlap under the navigation, one in the end, a hidden pill, two jumps, a bare cut name, a cut and misplaced More");
	assert.equal(doc.expected.length, 9);
	assert.ok(doc.expected.some((line) => line.includes(retry.word)), "the jump is Reconnecting's");
	assert.equal(doc.path, CONTROL_PATH);
	assert.equal(CONTROL_WIDTH, 1024);
	// Each rule the control is built to break, weakened, leaves its sentence out: the control cannot pass a blind check.
	const blind = [
		["the live words never set", (m) => ({ ...m, bar: { ...m.bar, reads: m.bar.reads.filter((r) => r.live === states[0].word) } }), /reading Reconnecting/],
		["only the first pill read", (m) => ({ ...m, bar: { ...m.bar, nodes: m.bar.nodes.map((n, i) => (i > 4 && n.parent === m.bar.roles.nav ? { ...n, parent: -1 } : n)) } }), /"Fleet" is hidden|"Spend" overlaps/],
		["no clip read", (m) => ({ bar: { ...m.bar, reads: m.bar.reads.map((r) => ({ ...r, snap: r.snap.map((s) => ({ ...s, overflowX: "visible", overflowY: "visible" })) })) }, more: { ...m.more, snap: m.more.snap.map((s) => ({ ...s, overflowX: "visible", overflowY: "visible" })) } }), /cut off at its bottom/],
		["the theme button never hidden", (m) => ({ ...m, bar: { ...m.bar, reads: m.bar.reads.filter((r) => r.theme === "shown") } }), /reveals the button/],
	];
	for (const [what, weaken, lost] of blind) {
		const got = shellVerdict({ width: CONTROL_WIDTH, mobile: false, csp: [], measured, metrics: shellMetrics(weaken(controlMeasure(states, retry))), emulation: desk(CONTROL_WIDTH), longest: true }).failures;
		const verdict = controlVerdict({ got, want: doc.expected });
		assert.equal(verdict.ok, false, what);
		assert.ok(verdict.problems.some((p) => lost.test(p)), `${what}: ${verdict.problems.join(" | ")}`);
	}
});

test("the negative control's page and stylesheet: its own, under the CSP, keyed to the shell's Reconnecting classes", async () => {
	const { states, retry } = await shellLive();
	const doc = controlDoc(states, retry);
	assert.match(doc.html, /^<!doctype html>/);
	assert.match(doc.html, new RegExp(`<link rel="stylesheet" href="${CONTROL_PATH}\\.css">`), "its stylesheet is a file this check serves, which style-src 'self' allows");
	assert.doesNotMatch(doc.html, /<style|<script|\sstyle=|\son[a-z]+=/i, "no inline style or script for the CSP to refuse");
	assert.match(doc.html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, "the emulation probe has a viewport meta to change");
	assert.match(doc.html, new RegExp(`<span id="live-status" class="${states[0].cls}"><span data-live-word>${states[0].word}</span></span>`));
	assert.equal(controlHtml(states[0]), doc.html);
	assert.equal(controlCss(retry.cls), doc.css);
	assert.ok(doc.css.includes(`.top:has(#live-status.${retry.cls.split(" ").join(".")}){padding-bottom:60px}`), "Reconnecting's own classes make the bar 60 px taller");
	assert.doesNotMatch(doc.css, /url\(|@import/);
	assert.throws(() => controlCss("live <b>"), /are not plain class names/);
	assert.throws(() => controlCss(""), /are not plain class names/);
	assert.throws(() => controlDoc(states, { cls: "live live--gone", word: "Gone" }), /Reconnecting one among them/);
	assert.throws(() => controlDoc([retry], retry), /a live state besides Reconnecting/);
});

/**
 * The phone control's measure as Chrome reports it, worked out from the coordinates `phoneControlCss` sets (its
 * docblock lists them): the bar read at each live word with the theme button shown and hidden, with each Parked count
 * (emptied, the bar is 20 px taller and the page 432 px wide), and More after the click, which its own script shut
 * again (`open` describes a check whose click found the button whole instead).
 */
function phoneControlMeasure(states, key, { open = false } = {}) {
	const tree = ({ cls, hidden, scrolled, menu, parked = "128" }) => {
		const height = 104 + (cls === key.cls ? 40 : 0) + (parked === "" ? 20 : 0);
		const at = (left) => left + 12 - scrolled;
		const pill = (label, left) => ["a", { rect: box(at(left), at(left) + 90, 68, 116), position: "absolute", overflow: "hidden", label }];
		const row1 = (left, right) => box(left, right, 12, 60);
		return ["div", { cls: "page", rect: box(0, 375, 0, 300) },
			["header", { cls: "top", rect: box(12, 363, 12, 12 + height), position: "relative", role: "top" },
				["a", { cls: "brandpill", rect: row1(12, 112), position: "absolute", overflow: "hidden", label: "pi-dispatch", role: "brand" }],
				["nav", { cls: "pillnav", rect: box(12, 363, 68, 116), position: "absolute", overflow: "auto", role: "nav" },
					pill("Overview", 0), pill("Runs", 96), pill("Parked", 192), pill("Fleet", 288), pill("Spend", 384), pill("Config", 480),
					["details", { cls: "more", rect: box(at(576), at(624), 68, 116), position: "absolute", label: "M", role: "more" },
						["summary", { rect: box(at(576), at(624), 68, 116), overflow: "hidden", label: "More: Audit", role: "summary" }],
						["div", { rect: menu ? box(at(464), at(624), 122, 202) : box(0, 0, 0, 0), position: "absolute", label: "Audit", role: "menu" }]]],
				["div", { cls: "top__end", rect: row1(122, 363), position: "absolute", role: "end" },
					["span", { id: "live-status", cls, rect: row1(122, 222), position: "absolute", overflow: "hidden", label: "word" }, ["span", {}]],
					["button", { cls: "roundbtn", rect: hidden ? box(0, 0, 0, 0) : row1(230, 278), position: "absolute", overflow: "hidden", label: "Theme", role: "theme" }],
					["button", { id: "logout", cls: "roundbtn", rect: row1(315, 363), position: "absolute", overflow: "hidden", label: "Sign out" }]]]];
	};
	const first = measure(tree({ cls: states[0].cls, hidden: false, scrolled: 0, menu: false }));
	const reads = ["128", "", "12,345"].flatMap((parked) => [false, true].flatMap((hidden) => states.map((s) => ({ live: s.word, theme: hidden ? "hidden" : "shown", parked, scrollWidth: parked === "" ? 432 : 375, snap: measure(tree({ cls: s.cls, hidden, scrolled: 0, menu: false, parked })).snap }))));
	// The check cut the button in half at the row's right edge (scrolled 249 of 273); a check that scrolled it into view
	// first (273) clicked a whole button, the script left the menu open, and the list sat under it.
	const after = measure(tree({ cls: states[0].cls, hidden: false, scrolled: open ? 273 : 249, menu: open }));
	return {
		bar: { nodes: first.nodes, roles: first.roles, reads, name: null, roleWord: null, parkedWidened: true, width: 375, height: 812 },
		more: { opened: open, cutFirst: !open, nodes: after.nodes, roles: after.roles, snap: after.snap, width: 375, height: 812 },
	};
}

test("the phone's negative control: its geometry, judged by the same rules at 375 px as a phone, is exactly its four sentences", async () => {
	const { states } = await shellLive();
	const doc = phoneControlDoc(states);
	const key = states.at(-1);
	assert.equal(key.word, "Signed out", "the shell's last live word, whose classes are its own");
	const measured = { scrollWidth: PHONE_CONTROL_WIDTH, clientWidth: PHONE_CONTROL_WIDTH, elements: [] };
	const judge = (m) => shellVerdict({ width: PHONE_CONTROL_WIDTH, mobile: true, csp: [], measured, metrics: shellMetrics(m), emulation: PHONE, liveStates: states }).failures;
	assert.deepEqual(judge(phoneControlMeasure(states, key)), doc.expected, "a page wide only while its count is emptied, a jump with the last live word and one with the count emptied, and a More its own script shut");
	assert.equal(doc.expected.length, 4);
	assert.deepEqual([doc.path, doc.width, doc.mobile, PHONE_CONTROL_PATH, PHONE_CONTROL_WIDTH], ["/control/phone", 375, true, "/control/phone", 375]);
	// Each of its two rules, weakened, loses its sentence.
	const blind = [
		["the last live word never read", (m) => ({ ...m, bar: { ...m.bar, reads: m.bar.reads.filter((r) => r.live !== key.word) } }), /reading Signed out/],
		["the count never varied", (m) => ({ ...m, bar: { ...m.bar, reads: m.bar.reads.filter((r) => r.parked === "128").map((r) => ({ ...r, parked: null })) } }), /no Parked count/],
		["the page's width read once, as drawn", (m) => ({ ...m, bar: { ...m.bar, reads: m.bar.reads.map((r) => ({ ...r, scrollWidth: 375 })) } }), /432 px wide/],
		["the button scrolled into view before the click", () => phoneControlMeasure(states, key, { open: true }), /did not open its menu/],
	];
	for (const [what, weaken, lost] of blind) {
		const verdict = controlVerdict({ name: doc.name, got: judge(weaken(phoneControlMeasure(states, key))), want: doc.expected });
		assert.equal(verdict.ok, false, what);
		assert.ok(verdict.problems.some((p) => lost.test(p)), `${what}: ${verdict.problems.join(" | ")}`);
	}
	// A table where the last word shares its classes: the jump keys off the last word that has its own.
	const shared = [{ cls: "live live--off", word: "Not live" }, { cls: "live", word: "Live" }, { cls: "live live--retry", word: "Reconnecting" }, { cls: "live live--off", word: "Signed out" }];
	assert.match(phoneControlDoc(shared).expected[1], /reading Reconnecting and 104\.0 px with it reading Not live/);
	assert.ok(phoneControlDoc(shared).css.includes('.top:has(#live-status[class="live live--retry"]){padding-bottom:40px}'));
	assert.throws(() => phoneControlDoc([{ cls: "live", word: "Live" }]), /a live state after the first whose classes are its own/);
});

test("the phone's negative control: its page, stylesheet and script are its own, under the CSP, and the script shuts a cut More", async () => {
	const { states } = await shellLive();
	const doc = phoneControlDoc(states);
	assert.equal(doc.html, phoneControlHtml(states[0]));
	assert.equal(doc.css, phoneControlCss(states.at(-1).cls));
	assert.equal(doc.js, PHONE_CONTROL_JS);
	assert.match(doc.html, /^<!doctype html>/);
	assert.match(doc.html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, "the emulation probe has a viewport meta to change");
	assert.match(doc.html, new RegExp(`<link rel="stylesheet" href="${PHONE_CONTROL_PATH}\\.css"><script src="${PHONE_CONTROL_PATH}\\.js" defer></script>`), "its own files, which script-src and style-src 'self' allow");
	assert.doesNotMatch(doc.html.replace(`<script src="${PHONE_CONTROL_PATH}.js" defer></script>`, ""), /<style|<script|\sstyle=|\son[a-z]+=/i, "no inline style or script for the CSP to refuse");
	assert.ok(doc.css.includes(`.top:has(#live-status[class="${states.at(-1).cls}"]){padding-bottom:40px}`), "the last word's exact classes make the bar 40 px taller");
	assert.ok(doc.css.includes(".top:has(#p-nav-parked:empty){padding-top:20px}") && doc.css.includes("body:has(#p-nav-parked:empty) main{width:420px}"), "an emptied count makes it 20 px taller and the page 432 px wide");
	assert.match(doc.html, new RegExp(`<span id="p-nav-parked" data-panel><span class="count">${parkedCounts().drawn}</span></span>`), "a count the read finds drawn and can widen");
	assert.doesNotMatch(doc.css, /url\(|@import/);
	assert.throws(() => phoneControlCss('live"]{x}'), /not plain class names/);
	// The script, run against a stubbed page: More opened with its button cut shuts itself; opened whole it stays open.
	const run = (buttonRight) => {
		let toggle = null;
		const more = { open: false, addEventListener: (type, fn) => type === "toggle" && (toggle = fn), querySelector: () => ({ getBoundingClientRect: () => ({ left: buttonRight - 48, right: buttonRight }) }) };
		const nav = { getBoundingClientRect: () => ({ left: 12, right: 363 }) };
		runInNewContext(PHONE_CONTROL_JS, { document: { querySelector: (s) => (s === "details.more" ? more : s === "nav.pillnav" ? nav : null) } });
		more.open = true;
		toggle();
		return more.open;
	};
	assert.equal(run(387), false, "cut at the row's right edge: shut in the task that opened it");
	assert.equal(run(363), true, "whole: left open");
	assert.equal(run(364), false, "a pixel past the edge is cut");
});

test("the negative control's verdict: every sentence it was built for, nothing else, in its order; a control that never ran fails", () => {
	const want = ["a", "b", "c"];
	assert.deepEqual(controlVerdict({ got: ["a", "b", "c"], want }), { ok: true, problems: [] });
	assert.deepEqual(controlVerdict({ got: ["a", "c"], want }).problems, ["the negative control was not failed with: b"]);
	assert.deepEqual(controlVerdict({ got: ["a", "b", "c", "d"], want }).problems, ["the negative control failed with what it was not built for: d"]);
	assert.deepEqual(controlVerdict({ got: ["c", "b", "a"], want }).problems, ['the negative control\'s failures came in another order or count: ["c","b","a"]']);
	assert.deepEqual(controlVerdict({ got: ["a", "b", "c", "c"], want }).ok, false);
	assert.deepEqual(controlVerdict({ name: "the phone's negative control", got: ["a"], want: ["b"] }).problems, ["the phone's negative control was not failed with: b", "the phone's negative control failed with what it was not built for: a"], "each control named in its own sentences");
	assert.deepEqual(controlVerdict(null).problems, ["the negative control (a top bar built to break nine of the bar's rules) never ran, so a measure blind to what it breaks would pass every page"]);
	assert.deepEqual(controlVerdict({ name: "the phone's negative control", what: "a phone's bar", got: null, want }).problems, ["the phone's negative control (a phone's bar) never ran, so a measure blind to what it breaks would pass every page"]);
});

/**
 * A page for `barSource` to read, as small as its collector allows: the bar's elements with fixed boxes, the live pill
 * with its word, the theme button, who is signed in, and the Parked count panel holding `<span class="count">128</span>`.
 * Elements answer only the selectors the collector asks (an unknown one throws, so a collector that starts asking for
 * more says so here). `scrollWidth` is the page's: 375, or 400 while the Parked panel is empty.
 */
function barPage() {
	class Text {
		constructor(value) {
			this.nodeType = 3;
			this.nodeValue = value;
			this.parentElement = null;
		}
		get textContent() {
			return this.nodeValue;
		}
		cloneNode() {
			return new Text(this.nodeValue);
		}
	}
	class El {
		constructor(tag, attrs = {}, kids = []) {
			this.nodeType = 1;
			this.tagName = tag.toUpperCase();
			this.attrs = { ...attrs };
			this.childNodes = [];
			this.parentElement = null;
			this.rect = { left: 0, top: 0, right: 0, bottom: 0 };
			this.scrollWidth = 0;
			this.clientWidth = 0;
			this.append(...kids);
		}
		get id() {
			return this.attrs.id ?? "";
		}
		getAttribute(n) {
			return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null;
		}
		hasAttribute(n) {
			return Object.hasOwn(this.attrs, n);
		}
		get className() {
			return this.attrs.class ?? "";
		}
		set className(v) {
			this.attrs.class = String(v);
		}
		get hidden() {
			return Object.hasOwn(this.attrs, "hidden");
		}
		set hidden(v) {
			if (v) this.attrs.hidden = "";
			else delete this.attrs.hidden;
		}
		get textContent() {
			return this.childNodes.map((n) => n.textContent).join("");
		}
		set textContent(v) {
			this.replaceChildren(new Text(String(v)));
		}
		get innerText() {
			return this.textContent;
		}
		append(...nodes) {
			for (const n of nodes) {
				const moved = n instanceof Fragment ? [...n.childNodes] : [n];
				if (n instanceof Fragment) n.childNodes = [];
				for (const m of moved) {
					m.parentElement?.childNodes.splice(m.parentElement.childNodes.indexOf(m), 1);
					m.parentElement = this;
					this.childNodes.push(m);
				}
			}
		}
		replaceChildren(...nodes) {
			for (const n of this.childNodes) n.parentElement = null;
			this.childNodes = [];
			this.append(...nodes);
		}
		cloneNode(deep) {
			const c = new El(this.tagName.toLowerCase(), this.attrs);
			if (deep) c.append(...this.childNodes.map((n) => n.cloneNode(true)));
			return c;
		}
		*all() {
			for (const n of this.childNodes) {
				if (n.nodeType !== 1) continue;
				yield n;
				yield* n.all();
			}
		}
		contains(n) {
			for (let a = n; a; a = a.parentElement) if (a === this) return true;
			return false;
		}
		closest(sel) {
			for (let a = this; a; a = a.parentElement) if (sel === ".who" && a.className.split(" ").includes("who")) return a;
			return null;
		}
		querySelectorAll(sel) {
			if (sel !== "*") throw new Error(`the stub answers querySelectorAll("*") only, not ${sel}`);
			return [...this.all()];
		}
		querySelector(sel) {
			const pick = picks.get(this)?.[sel];
			if (pick === undefined) throw new Error(`the stub does not answer ${sel} on <${this.tagName.toLowerCase()}>`);
			return pick;
		}
		getBoundingClientRect() {
			return this.rect;
		}
	}
	class Fragment extends El {
		constructor() {
			super("#fragment");
		}
	}
	const word = new El("span", { "data-live-word": "" }, [new Text("Not live")]);
	const pill = new El("span", { id: "live-status", class: "live live--off", role: "status" }, [word]);
	const theme = new El("button", { class: "roundbtn", "data-theme-toggle": "", hidden: "" });
	const nameB = new El("b", {}, [new Text("ops")]);
	const roleWord = new El("small", {}, [new Text("Operator")]);
	const who = new El("span", { class: "who", title: "ops, Operator" }, [new El("span", {}, [nameB, roleWord])]);
	const end = new El("div", { class: "top__end" }, [pill, theme, who]);
	const panel = new El("span", { id: "p-nav-parked", "data-panel": "" }, [new El("span", { class: "count" }, [new Text("128")])]);
	const nav = new El("nav", { class: "pillnav" }, [new El("a", { href: "/" }, [new Text("Overview")]), new El("a", { href: "/parked" }, [new Text("Parked"), panel])]);
	const brand = new El("a", { class: "brandpill", href: "/" }, [new Text("pi-dispatch")]);
	const top = new El("header", { class: "top" }, [brand, nav, end]);
	const body = new El("body", {}, [new El("div", { class: "page" }, [top])]);
	const picks = new Map([
		[top, { ".pillnav": nav, ".top__end": end, ".brandpill": brand, "[data-theme-toggle]": theme, ".who b": nameB, ".who small": roleWord, "details.more": null, "details.more > summary": null, "details.more > :not(summary)": null, "#p-nav-parked": panel }],
		[pill, { "[data-live-word]": word }],
	]);
	[...top.all()].forEach((el, i) => (el.rect = { left: i * 10, top: 0, right: i * 10 + 8, bottom: 48 }));
	top.rect = { left: 0, top: 0, right: 375, bottom: 120 };
	const html = new El("html", {}, [body]);
	Object.defineProperty(html, "clientWidth", { value: 375 });
	Object.defineProperty(html, "clientHeight", { value: 812 });
	const scrolling = { get scrollWidth() { return panel.textContent === "" ? 400 : 375; } };
	const document = {
		body,
		documentElement: html,
		scrollingElement: scrolling,
		querySelector: (sel) => (sel === "header.top" ? top : null),
		getElementById: (id) => ({ "live-status": pill })[id] ?? null,
		createDocumentFragment: () => new Fragment(),
		createTreeWalker: (root, what) => {
			assert.equal(what, 4, "text nodes only");
			const texts = [];
			const walk = (n) => (n.nodeType === 3 ? texts.push(n) : n.childNodes.forEach(walk));
			walk(root);
			let i = 0;
			return { nextNode: () => texts[i++] ?? null };
		},
	};
	const getComputedStyle = () => ({ position: "static", overflowX: "visible", overflowY: "visible", textOverflow: "ellipsis" });
	return { ctx: { document, getComputedStyle, NodeFilter: { SHOW_TEXT: 4 } }, pill, word, theme, panel };
}

test("the bar's reads, run against a stubbed page: every live word, theme state and Parked count, each read's real panel text, and the page put back", () => {
	const states = [{ cls: "live live--off", word: "Not live" }, { cls: "live", word: "Live" }, { cls: "live live--retry", word: "Reconnecting" }, { cls: "live live--off live--out", word: "Signed out" }];
	const page = barPage();
	const kids = [...page.panel.childNodes];
	const got = JSON.parse(JSON.stringify(runInNewContext(barSource(states, parkedCounts()), page.ctx)));
	assert.equal(got.reads.length, 3 * 2 * 4, "each Parked count, then each theme state, then each live word");
	assert.deepEqual([...new Set(got.reads.map((r) => r.parked))], ["128", "", "12,345"], "the count as drawn, emptied, and five digits long (the wide one is read)");
	assert.deepEqual([...new Set(got.reads.map((r) => r.theme))], ["shown", "hidden"], "the theme button shown, then hidden");
	assert.deepEqual([...new Set(got.reads.map((r) => r.live))], states.map((s) => s.word));
	for (const r of got.reads) assert.equal(r.parkedText, r.parked, `the panel's own text in the read with ${JSON.stringify(r.parked)}: what it showed, read back`);
	assert.equal(got.parkedWidened, true, "set from the panel's text after the swap");
	assert.deepEqual([...new Set(got.reads.map((r) => r.scrollWidth))], [375, 400], "the page's width read in each read: wider only while the count is emptied");
	const at = (id) => got.nodes.findIndex((n) => n.id === id);
	assert.deepEqual(got.nodes.slice(0, 3).map((n) => [n.tag, n.cls, n.parent]), [["div", "page", -1], ["header", "top", 0], ["a", "brandpill", 1]], "the bar's ancestors below <body>, then the bar and all it holds");
	for (const r of got.reads) assert.equal(r.snap[at("live-status")].label, r.live, "each read's snapshot taken with its own live word in");
	assert.equal(got.reads[0].snap[at("live-status")].cls, "live live--off");
	// Everything put back: the page is as the server drew it, the panel's own nodes included.
	assert.deepEqual([page.pill.className, page.word.textContent, page.theme.hidden], ["live live--off", "Not live", true]);
	assert.ok(page.panel.childNodes.length === kids.length && page.panel.childNodes.every((n, i) => n === kids[i]), "the drawn count's own nodes, not copies");
	// Through the verdicts: nothing to say about a bar read in every state.
	const m = shellMetrics({ bar: got });
	assert.equal(m.widened, true);
	assert.deepEqual(parkedReadProblems(m.bars), []);
	// A swap that writes the drawn count back. The widened flag and the reads both come from the panel's text, so
	// both say it.
	const blind = barSource(states, parkedCounts()).replace("t.nodeValue.split(DRAWN).join(WIDE)", "t.nodeValue.split(DRAWN).join(DRAWN)");
	assert.notEqual(blind, barSource(states, parkedCounts()), "the broken copy is made");
	const f07 = JSON.parse(JSON.stringify(runInNewContext(blind, barPage().ctx)));
	assert.equal(f07.parkedWidened, false);
	assert.deepEqual(parkedReadProblems(shellMetrics({ bar: f07 }).bars), [
		'the bar was read as the Parked count at 12,345 while its Parked panel read "128" (and 7 more reads like it), so no rule was held at that count',
		"the bar was never read with the Parked count at 12,345, so no rule was held there",
	]);
	// The wide count never read.
	const short = barSource(states, parkedCounts()).replace('const parkeds = panel ? [DRAWN, "", WIDE] : [null];', 'const parkeds = panel ? [DRAWN, ""] : [null];');
	assert.notEqual(short, barSource(states, parkedCounts()));
	const g05b = JSON.parse(JSON.stringify(runInNewContext(short, barPage().ctx)));
	assert.deepEqual(parkedReadProblems(shellMetrics({ bar: g05b }).bars), ["the bar was never read with the Parked count at 12,345, so no rule was held there"]);
});

test("More's click, run against a stubbed page: on a phone the button is cut in half at the row's edge, nothing holds focus, and it is never scrolled into view", async () => {
	// A phone's row (12 to 363) scrolling 624 px of pills, More's 48 px button last; it has no scrollIntoView, so a check
	// that called one would throw here.
	const page = () => {
		const log = [];
		const nav = { scrollWidth: 624, clientWidth: 351, at: 0, getBoundingClientRect: () => ({ left: 12, right: 363 }) };
		Object.defineProperty(nav, "scrollLeft", { get: () => nav.at, set: (v) => (nav.at = Math.max(0, Math.min(v, nav.scrollWidth - nav.clientWidth))) });
		const summary = { getBoundingClientRect: () => ({ left: 588 - nav.at, right: 636 - nav.at, top: 68, bottom: 116, width: 48 }), click: () => { log.push(["click", summary.getBoundingClientRect().left, document.activeElement === null]); details.open = !details.open; } };
		const details = { open: false, closest: (s) => (s === "nav" ? nav : null), querySelector: (s) => (s === "summary" ? summary : null) };
		const document = { activeElement: { blur: () => { log.push(["blur"]); document.activeElement = null; } }, documentElement: { clientWidth: 375, clientHeight: 812 }, querySelector: (s) => (s === "header.top details.more" ? details : null) };
		const ctx = { document, setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
		return { ctx, log, nav };
	};
	const phone = page();
	const got = JSON.parse(JSON.stringify(await runInNewContext(moreSource(true), phone.ctx)));
	assert.equal(phone.nav.scrollLeft, 249, "scrolled to its end (273), then back by half the button: its left half shows at the row's right edge");
	assert.deepEqual(phone.log, [["blur"], ["click", 339, true], ["click", 339, true]], "focus dropped, then a bare click on the cut button (339 to 387 in a row ending at 363), and one more to shut it after the measure");
	assert.deepEqual([got.opened, got.cutFirst], [true, true]);
	const desk = page();
	const flat = JSON.parse(JSON.stringify(await runInNewContext(moreSource(false), desk.ctx)));
	assert.deepEqual([desk.nav.scrollLeft, desk.log.map(([what]) => what), flat.cutFirst], [0, ["click", "click"], null], "above a phone a plain click: the row never scrolls there");
});

test("the emulation probe, run against a stubbed page each way: a phone's window honours the viewport meta, a desktop's keeps its width", () => {
	// A page whose layout viewport follows the meta only when `honours` (a phone's emulation does, a desktop's does not).
	const page = ({ width, inner = width, dpr, honours, meta = true }) => {
		let content = "width=device-width, initial-scale=1";
		const tag = { getAttribute: () => content, setAttribute: (_, v) => (content = v) };
		const documentElement = { get clientWidth() {
			const asked = /^width=(\d+)$/.exec(content);
			return honours && asked ? Number(asked[1]) : width;
		} };
		const ctx = { document: { documentElement, querySelector: (s) => (meta && s === 'meta[name="viewport"]' ? tag : null) }, window: { devicePixelRatio: dpr, innerWidth: inner } };
		const got = runInNewContext(EMULATION_PROBE, ctx);
		return { got: JSON.parse(JSON.stringify(got)), restored: content };
	};
	const phone = page({ width: 414, dpr: 2, honours: true });
	assert.deepEqual(phone.got, { dpr: 2, mobile: true, probed: PROBE_WIDTH }, "a phone's emulation at 414 px, wider than 375: the meta is what answers, not the window's width");
	assert.equal(phone.restored, "width=device-width, initial-scale=1", "the meta is put back");
	assert.deepEqual(page({ width: 375, dpr: 1, honours: false }).got, { dpr: 1, mobile: false, probed: 375 }, "a 375 px window drawn as a desktop's: narrow, and still no phone");
	assert.deepEqual(page({ width: 1024, dpr: 1, honours: false }).got, { dpr: 1, mobile: false, probed: 1024 });
	assert.deepEqual(page({ width: 375, dpr: 3, honours: true }).got.dpr, 3, "the device scale is the page's own, never inferred from its width");
	assert.deepEqual(page({ width: 375, dpr: 2, honours: true, meta: false }).got, { dpr: 2, mobile: null, probed: null });
	assert.deepEqual(emulationProblems(page({ width: 375, dpr: 1, honours: false }).got, true), ["the window was meant to be a phone's, but DevTools did not emulate a phone (a viewport meta asking for 1234 px laid the page out 375 px wide)", "the device scale is 1, not 2"], "round 3's WC09: a phone run drawn as a desktop's, caught by what the page reports");
});

test("the theme button's read, run against stubbed pages: hidden is true, shown is false, a page with none is null (the no-script run's proof)", () => {
	// The page's own `hidden`, read from the one element the selector names: `noScriptVerdict` takes a true as the sign
	// that the page's script never ran. A read that answered true for any button (which
	// once survived every test) would call a run made with scripts on a run without them.
	const read = (button) => runInNewContext(THEME_HIDDEN_READ, { document: { querySelector: (s) => (s === "[data-theme-toggle]" ? button : null) } });
	assert.equal(read({ hidden: true }), true, "drawn hidden and still hidden after load: the script did not run");
	assert.equal(read({ hidden: false }), false, "revealed: the script ran");
	assert.equal(read(null), null, "a page that draws no theme button says nothing either way");
	// `hidden` is the page's property, a boolean: a value that is merely truthy is not a hidden button.
	assert.equal(read({ hidden: "hidden" }), false);
});

// A golden run's result and a shell run's, as the browser half returns them.
const goldenResult = (page, extra = {}) => ({ run: { key: `${page}.operator light`, label: "light", doc: { id: `${page}.operator`, file: `${page}.operator.html`, path: `/fixtures/${page}.operator.html`, page, role: "operator" } }, failures: [], notes: [], width: { ok: true }, ...extra });
const shellResult = (page, width, failures = []) => ({ run: { key: `shell.operator.${page} ${width}`, width, doc: { id: `shell.operator.${page}`, path: `/shell/operator/${page}`, page, role: "operator" } }, failures, notes: [] });
// The run without page scripts' result, as `checkPages` adds it last.
const noScriptResult = (failures = []) => ({ run: { key: `shell.operator.overview ${NO_SCRIPT.width} no script`, width: NO_SCRIPT.width, doc: { id: `shell.operator.overview${NO_SCRIPT_SUFFIX}`, path: "/shell/operator/overview", page: "overview", role: "operator, no JavaScript" } }, failures, notes: [] });

test("the summary: any failed run, a setup problem or the wrong Chrome in CI makes the exit code 1", () => {
	const pin = { version: "155.0.8059.39" };
	const product = "HeadlessChrome/155.0.8059.39";
	const control = { name: "the negative control", what: "a bar", width: 1024, got: ["a 60 px overlap"], want: ["a 60 px overlap"], notes: [] };
	const phone = { name: "the phone's negative control", what: "a phone's bar", width: 375, got: ["a jump", "a shut More"], want: ["a jump", "a shut More"], notes: [] };
	const sweep = SHELL_WIDTHS.map((w) => shellResult("overview", w));
	const base = { product, pin, ci: true, results: [goldenResult("overview")], shell: [...sweep, noScriptResult()], controls: [control, phone], pages: ["overview"], seconds: "1.0" };
	const clean = summarize(base);
	assert.equal(clean.code, 0);
	assert.deepEqual(clean.lines, ["ok    the negative control at 1024 px failed as it was built to (1 problem)", "ok    the phone's negative control at 375 px failed as it was built to (2 problems)", "ok    overview.operator.html (page overview, operator, light)", "ok    shell /shell/operator/overview (page overview, operator) at 320, 375, 761, 800, 940, 1024, 1180, 1280, 1440, 1600 px", "ok    shell /shell/operator/overview (page overview, operator, no JavaScript) at 1024 px", "1 runs over 1 pages and 11 shell runs over 2 pages, 0 failed, 0 other problems, in 1.0 s"]);
	// A check that never made the run without page scripts held the CSS-alone rule nowhere.
	const noBare = summarize({ ...base, shell: sweep });
	assert.equal(noBare.code, 1, "every page passing is no proof without it");
	assert.ok(noBare.lines.includes("::error::the run without page scripts never ran, so nothing held More's list under its button by CSS alone"));
	assert.deepEqual(noBare.failures, ["the run without page scripts never ran, so nothing held More's list under its button by CSS alone"]);
	const failedBare = summarize({ ...base, shell: [...sweep, noScriptResult(["the theme button was shown, so the page's script ran: this run must be made with page scripts off (Emulation.setScriptExecutionDisabled)"])] });
	assert.deepEqual([failedBare.code, failedBare.failedRuns, failedBare.failures], [1, 1, []], "a run made with scripts on is a failed run, not a missing one");
	const blind = summarize({ ...base, controls: [{ ...control, got: [] }, phone] });
	assert.equal(blind.code, 1, "a control that passed means the measure is blind: every page's pass is worthless");
	assert.ok(blind.lines.includes("::error::the negative control was not failed with: a 60 px overlap"));
	const phoneBlind = summarize({ ...base, controls: [control, { ...phone, got: ["a jump"] }] });
	assert.equal(phoneBlind.code, 1, "either control alone fails the run");
	assert.ok(phoneBlind.lines.includes("::error::the phone's negative control was not failed with: a shut More"));
	const never = summarize({ ...base, controls: [control, { ...phone, got: null }] });
	assert.equal(never.code, 1);
	assert.ok(never.lines.includes("::error::the phone's negative control (a phone's bar) never ran, so a measure blind to what it breaks would pass every page"));
	assert.equal(summarize({ ...base, controls: [] }).code, 1, "no control at all is no proof at all");
	assert.ok(summarize({ ...base, controls: [{ ...control, notes: ["page error: boom"] }, phone] }).lines.includes("      note: the negative control: page error: boom"));
	const golden = summarize({ ...base, results: [goldenResult("overview", { failures: ["CSP violation: img-src refused x"] })] });
	assert.equal(golden.code, 1);
	assert.ok(golden.lines.includes("::error::overview.operator.html (page overview, operator, light): CSP violation: img-src refused x"));
	const tooWide = summarize({ ...base, results: [goldenResult("overview", { width: { ok: false, width: 375, scrollWidth: 400, wide: true, offenders: 0, roots: [] } })] });
	assert.equal(tooWide.code, 1);
	assert.ok(tooWide.lines.includes("::error::overview.operator.html (page overview, operator, light): the page is 400 px wide at a 375 px viewport"));
	const bar = summarize({ ...base, shell: [shellResult("overview", 375), shellResult("overview", 1024, ["the navigation's <a> \"Spend\" overlaps <span class=\"who\"> by 91.3 x 48.0 px"])] });
	assert.equal(bar.code, 1);
	assert.equal(bar.failedRuns, 1);
	assert.ok(bar.lines.includes("FAIL  shell /shell/operator/overview (page overview, operator) at 1024 px"));
	assert.ok(bar.lines.includes('::error::shell /shell/operator/overview (page overview, operator) at 1024 px: the navigation\'s <a> "Spend" overlaps <span class="who"> by 91.3 x 48.0 px'));
	const setup = summarize({ ...base, setup: ["no golden audit.viewer.html for the page audit"] });
	assert.equal(setup.code, 1);
	assert.ok(setup.lines.includes("::error::no golden audit.viewer.html for the page audit"));
	const other = summarize({ ...base, product: "HeadlessChrome/156.0.1.2" });
	assert.equal(other.code, 1, "CI must measure with the pinned build");
	assert.ok(other.lines.includes("::error::this is Chrome 156.0.1.2, not the pinned Chrome for Testing 155.0.8059.39: CI must measure with the pinned build"));
	const local = summarize({ ...base, product: "HeadlessChrome/156.0.1.2", ci: false });
	assert.equal(local.code, 0, "anywhere else it is a note");
	assert.ok(local.lines.includes("note: this is Chrome 156.0.1.2, not the pinned Chrome for Testing 155.0.8059.39; CI is the authority on width"));
	const pending = summarize({ ...base, pending: ["overview"], results: [goldenResult("overview", { width: { ok: false, scrollWidth: 400 } })] });
	assert.equal(pending.code, 0, "a WIDTH_PENDING page's width failure is tolerated");
	assert.ok(pending.lines.includes("ok    overview.operator.html (page overview, operator, light), 400 px wide (WIDTH_PENDING)"));
	assert.equal(summarize({ ...base, pending: ["overview"] }).code, 1, "and once it fits, the ratchet fails the run");
});

// The repository's modules, loaded once and on first use (no top-level await: temp-dir.mjs says why): the glue below
// runs against the real page table, shell, pin and goldens.
let loaded = null;
const repoModules = () => (loaded ??= loadModules());

/**
 * `runCheck` with the browser faked: every golden and shell run passes (the run without scripts too, planned by
 * `noScriptRun` as `checkPages` plans it) and each control fails exactly as built, unless `controlFailures` (by control
 * id) says what it failed with, or null for one that never ran, and `noScript` says what the run without scripts
 * failed with (null: it never ran), so what fails is the glue's own.
 */
async function fakeRun({ require = true, find = () => ({ path: "/opt/chrome" }), fixtures = FIXTURES, product = null, ci = true, controlFailures = {}, noScript = [], edit = (m) => m } = {}) {
	const modules = edit(await repoModules());
	product ??= `HeadlessChrome/${modules.pin.version}`;
	const lines = [];
	let handed = null;
	const check = async (args) => {
		handed = args;
		const results = planRuns(args.docs).map((run) => ({ run, failures: [], notes: [], width: { ok: true } }));
		const shell = planShellRuns(args.shellDocs).map((run) => ({ run, failures: [], notes: [] }));
		const bare = noScriptRun(args.shellDocs);
		if (bare && noScript !== null) shell.push({ run: bare, failures: noScript, notes: [] });
		const controls = args.controls.flatMap((c) => {
			const failures = controlFailures[c.id] === undefined ? c.expected : controlFailures[c.id];
			return failures === null ? [] : [{ run: { key: c.id }, failures, notes: [] }];
		});
		return { product, results, shell, controls };
	};
	const code = await runCheck({ require }, { find, modules, fixtures, check, ci, log: (line) => lines.push(line), started: 0 });
	return { code, lines, handed };
}

test("the glue: no Chrome refuses under --require and skips without it, before anything is drawn", async () => {
	await assert.rejects(fakeRun({ find: () => ({ path: null }) }), (err) => err instanceof Refusal && /--require is set/.test(err.message));
	await assert.rejects(fakeRun({ find: () => ({ error: "CHROME is /x, which is not an executable file" }), require: false }), /CHROME is \/x/);
	const skipped = await fakeRun({ find: () => ({ path: null }), require: false });
	assert.deepEqual([skipped.code, skipped.lines, skipped.handed], [0, ["console-width-check: skipped, no Chrome found (set CHROME to run it)"], null]);
});

test("the glue: every golden (the sign-in pages' and the panel goldens among them) and the whole shell sweep reach the browser, and a clean run exits 0", async () => {
	const { code, lines, handed } = await fakeRun();
	assert.equal(code, 0, lines.filter((l) => l.startsWith("::error::")).join("\n"));
	const listed = (dir, prefix = "") => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".html")).sort().map((f) => `${prefix}${f}`) : []);
	const goldens = [...listed(FIXTURES), ...listed(join(FIXTURES, "panels"), "panels/")];
	assert.deepEqual(handed.docs.map((d) => d.file), goldens, "every golden, top level then panels, and nothing the check drew itself");
	for (const [page, path, file] of SIGN_IN) assert.equal(handed.docs.find((d) => d.file === file)?.page, page, `${path} is measured by its golden`);
	assert.ok(handed.docs.every((d) => d.path === `/fixtures/${d.file}`), "each served under its own name");
	const pageNames = Object.keys((await repoModules()).pages.PAGES);
	assert.equal(handed.shellDocs.length, pageNames.length * 4, "every page for each of the four sign-ins");
	assert.deepEqual([...new Set(handed.shellDocs.map((d) => d.role))], ["operator", "viewer", "read-only", "longest-name"]);
	const run = handed.shellDocs.find((d) => d.id === "shell.longest-name.run");
	assert.match(run.html, new RegExp(`<h1>Run [a-z0-9]{${RUN_ID_LENGTH}}</h1>`), "the run page's title holds the long id");
	assert.match(run.html, /Read-only console/);
	assert.match(run.html, new RegExp(`<b\\b[^>]*>m{32}</b>`), "the top bar names the longest name");
	assert.match(handed.shellDocs.find((d) => d.id === "shell.operator.overview").html, new RegExp(`id="p-nav-parked" data-panel><span class="count[^<]*(?:<span[^>]*>)?${PARKED_SHOWN}<`), "the Parked pill carries its count");
	assert.doesNotMatch(handed.shellDocs.find((d) => d.id === "shell.viewer.overview").html, /details class="more"/, "a viewer has no More");
	assert.deepEqual(handed.liveStates.map((s) => s.word), ["Not live", "Live", "Reconnecting", "Signed out"], "each distinct live word, once");
	assert.equal(handed.heads.dark.schemeMeta, '<meta name="color-scheme" content="dark">');
	assert.equal(handed.chrome, "/opt/chrome");
	const { states, retry } = await shellLive();
	assert.deepEqual(handed.controls, [controlDoc(states, retry), phoneControlDoc(states)], "both negative controls, keyed to the shell's live states, reach the browser");
	assert.deepEqual(lines.slice(0, 2), ["ok    the negative control at 1024 px failed as it was built to (9 problems)", "ok    the phone's negative control at 375 px failed as it was built to (4 problems)"]);
	assert.ok(lines.includes("ok    shell /shell/operator/overview (page overview, operator, no JavaScript) at 1024 px"), "the run without scripts has its own line");
	assert.deepEqual(noScriptRun(handed.shellDocs), { key: `shell.operator.overview ${NO_SCRIPT.width} no script`, doc: { ...handed.shellDocs.find((d) => d.id === NO_SCRIPT.doc), id: `shell.operator.overview${NO_SCRIPT_SUFFIX}`, role: "operator, no JavaScript" }, width: NO_SCRIPT.width, mobile: false }, "the operator's overview at 1024 px, as a desktop, under an id of its own");
	assert.equal(lines.at(-1).replace(/in [\d.]+ s$/, "in s"), `${planRuns(handed.docs).length} runs over ${handed.docs.length} pages and ${handed.shellDocs.length * SHELL_WIDTHS.length + 1} shell runs over ${handed.shellDocs.length + 1} pages, 0 failed, 0 other problems, in s`);
});

test("the glue: a page with no golden, CI on another Chrome, or two live words drawn alike fails the run", async () => {
	const fixtures = tempDir("pd-width-goldens-");
	for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith(".html") && f !== "audit.viewer.html")) copyFileSync(join(FIXTURES, f), join(fixtures, f));
	const missing = await fakeRun({ fixtures });
	assert.equal(missing.code, 1);
	assert.ok(missing.lines.includes("::error::no golden audit.viewer.html for the page audit"));
	const other = await fakeRun({ product: "HeadlessChrome/1.2.3.4" });
	assert.equal(other.code, 1);
	assert.ok(other.lines.some((l) => /^::error::this is Chrome 1\.2\.3\.4, not the pinned .*CI must measure with the pinned build$/.test(l)));
	assert.equal((await fakeRun({ product: "HeadlessChrome/1.2.3.4", ci: false })).code, 0);
	// A live table that draws Signed out with Not live's classes (the first commit's did), which a phone's glyph cannot tell apart.
	const alike = await fakeRun({ edit: (m) => ({ ...m, shell: { ...m.shell, LIVE_STATES: { ...m.shell.LIVE_STATES, out: { ...m.shell.LIVE_STATES.out, cls: m.shell.LIVE_STATES.off.cls } } } }) });
	assert.equal(alike.code, 1);
	assert.ok(alike.lines.includes("::error::the live pill draws Not live and Signed out with the same classes (live live--off), so a phone, which shows the state's glyph alone, cannot tell them apart"));
});

test("the glue: a negative control not failed exactly as it was built, or not run at all, fails a run whose every page passed", async () => {
	const { states, retry } = await shellLive();
	const { expected } = controlDoc(states, retry);
	const blind = await fakeRun({ controlFailures: { control: expected.slice(1) } });
	assert.equal(blind.code, 1);
	assert.ok(blind.lines.includes(`::error::the negative control was not failed with: ${expected[0]}`));
	const seeing = await fakeRun({ controlFailures: { control: [...expected, "the open More menu shows nothing"] } });
	assert.equal(seeing.code, 1, "a measure that sees what is not there fails too");
	assert.ok(seeing.lines.includes("::error::the negative control failed with what it was not built for: the open More menu shows nothing"));
	const never = await fakeRun({ controlFailures: { control: null } });
	assert.equal(never.code, 1);
	assert.match(never.lines.at(-1), /, 0 failed, 1 other problems, in [\d.]+ s$/);
	const phone = phoneControlDoc(states);
	const easy = await fakeRun({ controlFailures: { "control-phone": phone.expected.slice(0, 1) } });
	assert.equal(easy.code, 1, "the phone's control, its More opened by an easy click, fails a run whose every page passed");
	assert.ok(easy.lines.includes("::error::the phone's negative control was not failed with: a click on More did not open its menu"));
	const phoneNever = await fakeRun({ controlFailures: { "control-phone": null } });
	assert.ok(phoneNever.lines.includes(`::error::the phone's negative control (${phone.what}) never ran, so a measure blind to what it breaks would pass every page`));
});

test("the glue: the run without page scripts never made, or made with its scripts on, fails a run whose every page passed", async () => {
	const never = await fakeRun({ noScript: null });
	assert.equal(never.code, 1);
	assert.ok(never.lines.includes("::error::the run without page scripts never ran, so nothing held More's list under its button by CSS alone"));
	assert.match(never.lines.at(-1), /, 0 failed, 1 other problems, in [\d.]+ s$/);
	const on = noScriptVerdict({ width: NO_SCRIPT.width, measured: { scrollWidth: NO_SCRIPT.width, clientWidth: NO_SCRIPT.width, elements: [] }, more: null, emulation: desk(NO_SCRIPT.width), themeHidden: false }).failures;
	const scripted = await fakeRun({ noScript: on });
	assert.equal(scripted.code, 1);
	assert.ok(scripted.lines.includes("FAIL  shell /shell/operator/overview (page overview, operator, no JavaScript) at 1024 px"));
	assert.ok(scripted.lines.includes(`::error::shell /shell/operator/overview (page overview, operator, no JavaScript) at 1024 px: ${on[0]}`));
	// A sweep with no operator overview has no run to make: a setup problem before anything is measured.
	const bare = await fakeRun({ edit: (m) => ({ ...m, pages: { ...m.pages, renderPage: (name, ctx) => m.pages.renderPage(name, ctx), PAGES: Object.fromEntries(Object.entries(m.pages.PAGES).filter(([k]) => k !== "overview")) } }) });
	assert.ok(bare.lines.includes(`::error::the shell sweep has no ${NO_SCRIPT.doc} to load without its script`));
});

/**
 * `checkNoScript` against a stubbed browser, which plays the page: its script reveals the theme button on load unless
 * `Emulation.setScriptExecutionDisabled` came first, and a real click on More's centre opens it. What it was sent, in
 * order, is `sent`.
 */
function noScriptBrowser() {
	const sent = [];
	let scriptsOff = false;
	let loaded = false;
	let opened = false;
	const at = measure(["header", { cls: "top", rect: box(0, 1024, 0, 120), position: "relative", role: "top" },
		["nav", { cls: "pillnav", rect: box(16, 1008, 64, 112), role: "nav" },
			["details", { cls: "more", rect: box(700, 748, 64, 112), position: "relative", role: "more" },
				["summary", { rect: box(700, 748, 64, 112), label: "More: Audit", role: "summary" }],
				["div", { rect: box(568, 748, 118, 170), position: "absolute", label: "Audit", role: "menu" }]]]]);
	const evaluate = (expression) => {
		if (expression === THEME_HIDDEN_READ) return !loaded || scriptsOff;
		if (expression === MORE_AT) return { x: 724, y: 88 };
		if (expression === MORE_READ) return { opened, cutFirst: null, nodes: at.nodes, roles: at.roles, snap: at.snap, width: 1024, height: 900 };
		if (expression === EMULATION_PROBE) return desk(1024);
		if (expression.includes("__pdWidthKeep")) return { scrollWidth: 1024, clientWidth: 1024, elements: [] };
		throw new Error(`the stub cannot evaluate ${expression.slice(0, 60)}`);
	};
	const t = {
		sessionId: "s1",
		send: async (method, params = {}) => {
			sent.push(method === "Runtime.evaluate" ? `evaluate ${params.expression === THEME_HIDDEN_READ ? "theme" : params.expression === MORE_AT ? "more-at" : params.expression === MORE_READ ? "more-read" : params.expression === EMULATION_PROBE ? "emulation" : "measure"}` : method);
			if (method === "Emulation.setScriptExecutionDisabled") scriptsOff = params.value === true;
			if (method === "Page.navigate") {
				loaded = true;
				return {};
			}
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && params.x === 724 && params.y === 88) opened = true;
			if (method === "Runtime.evaluate") return { result: { value: evaluate(params.expression) } };
			return {};
		},
		close: async () => {},
	};
	return { sent, browser: { openTarget: async () => t, event: () => Promise.resolve({}) } };
}

test("the run without page scripts, against a stubbed browser: scripts off before the page loads, the theme button read, then More clicked", async () => {
	const run = { key: "shell.operator.overview 1024 no script", doc: { id: `shell.operator.overview${NO_SCRIPT_SUFFIX}` }, width: NO_SCRIPT.width, mobile: false };
	const { sent, browser } = noScriptBrowser();
	const got = await checkNoScript({ browser, run, url: "http://127.0.0.1:1/shell/operator/overview", clockMs: 0 });
	assert.deepEqual([got.failures, got.notes], [[], []], "a page whose script never ran, its More placed by CSS alone");
	assert.ok(sent.indexOf("Emulation.setScriptExecutionDisabled") >= 0 && sent.indexOf("Emulation.setScriptExecutionDisabled") < sent.indexOf("Page.navigate"), "scripts are off before the page is loaded");
	assert.deepEqual(sent.filter((m) => m.startsWith("evaluate") || m === "Input.dispatchMouseEvent"), ["evaluate theme", "evaluate measure", "evaluate more-at", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "evaluate more-read", "evaluate emulation"], "the theme button read before anything is clicked");
	// The same run with the scripts left on: the stub's page script reveals the button, and the run says so.
	const { browser: scripted } = noScriptBrowser();
	const on = await checkNoScript({ browser: { ...scripted, openTarget: async () => {
		const t = await scripted.openTarget();
		return { ...t, send: (method, params) => (method === "Emulation.setScriptExecutionDisabled" ? Promise.resolve({}) : t.send(method, params)) };
	} }, run, url: "http://127.0.0.1:1/shell/operator/overview", clockMs: 0 });
	assert.deepEqual(on.failures, ["the theme button was shown, so the page's script ran: this run must be made with page scripts off (Emulation.setScriptExecutionDisabled)"]);
});

test("--check-pin through the real entry point: a pin that does not hold exits 1 with nothing on stdout, so the step downloads nothing", () => {
	const dir = tempDir("pd-width-pin-");
	const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
	const run = (content) => {
		const file = join(dir, "pin.json");
		writeFileSync(file, JSON.stringify(content));
		return spawnSync(process.execPath, [join(repo, ".github/scripts/console-width-check.mjs"), "--check-pin", "--platform", "linux64"], { encoding: "utf8", env: { ...process.env, CONSOLE_WIDTH_PIN: file } });
	};
	const good = run(pin);
	assert.equal(good.status, 0, good.stderr);
	assert.equal(good.stdout, `${cftUrl(pin.version, "linux64")}\n`, "the url alone, derived from the version");
	const elsewhere = structuredClone(pin);
	elsewhere.downloads.linux64.url = "https://example.com/chrome-linux64.zip";
	const bad = run(elsewhere);
	assert.equal(bad.status, 1);
	assert.equal(bad.stdout, "", "nothing the workflow could download from");
	assert.match(bad.stderr, /^::error::console-width-check: \.github\/chrome-for-testing\.json: downloads\.linux64\.url is not https:\/\/storage\.googleapis\.com\//m);
	const broken = run({ version: "155" });
	assert.equal(broken.status, 1);
	assert.equal(broken.stdout, "");
});

test("chrome-pipe's frozen clock is the one render-images always injected: no-argument Date and Date.now fixed, the rest untouched", () => {
	const T = 1_760_000_000_000;
	const source = frozenDateSource(T);
	assert.equal(source, `(() => { const T = ${T}; const R = Date; class D extends R { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } } globalThis.Date = D; })();`);
	const ctx = {};
	runInNewContext(source, ctx);
	// Read back as JSON: an array from the other realm has the other realm's prototype, which deepEqual tells apart.
	assert.deepEqual(JSON.parse(runInNewContext("JSON.stringify([Date.now(), new Date().getTime(), new Date(0).getTime(), Date.UTC(1970, 0, 2)])", ctx)), [T, T, 0, 86_400_000]);
	assert.throws(() => frozenDateSource(1.5), TypeError);
	assert.throws(() => frozenDateSource("0); alert(1"), TypeError, "nothing but an integer is ever written into the page's script");
});

// ---- the workflow step ------------------------------------------------------------------------------------------

const WORKFLOW = readFileSync(join(repo, ".github/workflows/pi-upgrade-check.yml"), "utf8");
/** A small count as the workflow's prose writes it. */
const WORDS = Object.freeze(["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"]);
/** The widths as a sentence lists them: "a, b and c". */
const listed = (ns) => (ns.length < 2 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
const PHONE_WIDTHS = SHELL_WIDTHS.filter((w) => w <= VIEWPORT.width);
const DESKTOP_WIDTHS = SHELL_WIDTHS.filter((w) => w > VIEWPORT.width);
// Derived, so a width added to the sweep cannot leave the step's name counting the old ones.
const STEP_NAME = `"The console under its CSP at ${WORDS[PHONE_WIDTHS.length]} phone widths and ${WORDS[DESKTOP_WIDTHS.length]} desktop widths (issue #737)"`;

/** The lines of job `name` in a workflow (two-space keys under `jobs:`), up to the next job. */
function jobLines(workflow, name) {
	const lines = workflow.split("\n");
	const at = lines.indexOf(`  ${name}:`);
	assert.ok(at >= 0, `no job ${name}`);
	const end = lines.findIndex((line, i) => i > at && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line));
	return lines.slice(at, end < 0 ? lines.length : end);
}

/** A step of `lines` (a job's) found by `match` on its first line: its keys and its dedented `run:` block. */
function step(lines, match) {
	const at = lines.findIndex((line) => /^ {6}- /.test(line) && match(line));
	assert.ok(at >= 0, "the step is in the job");
	const end = lines.findIndex((line, i) => i > at && /^ {6}- /.test(line));
	const body = lines.slice(at, end < 0 ? lines.length : end);
	const key = (k) => body.map((line) => new RegExp(`^ {6}(?:- | {2})${k}: (.*)$`).exec(line)?.[1]).find((v) => v !== undefined) ?? null;
	// Every key of the step, in order: the ones at its own indent, as `- key:` or `  key:`.
	const keys = body.flatMap((line) => /^ {6}(?:- | {2})([a-z][a-z-]*):/.exec(line)?.[1] ?? []);
	const runAt = body.findIndex((line) => /^ {8}run: \|$/.test(line));
	const run = runAt < 0 ? null : body.slice(runAt + 1).filter((line) => line.startsWith("          ") || line.trim() === "").map((line) => line.slice(10)).join("\n").trimEnd();
	return { index: at, key, keys, run };
}

test("the workflow: the width step is in the required contract-tests job, after the install it needs, red-proof and bounded", () => {
	const job = jobLines(WORKFLOW, "contract-tests");
	assert.equal(job[1], "    name: pinned assumptions still hold (offline, no API key)", "the job whose name is the required context");
	const install = step(job, (line) => line.includes("- id: install"));
	assert.equal(install.key("run"), "npm ci --no-audit --no-fund", "`id: install` is the npm ci step");
	const width = step(job, (line) => line === `      - name: ${STEP_NAME}`);
	assert.ok(width.index > install.index, "after the install");
	assert.equal(width.key("if"), "(success() || failure()) && steps.install.outcome == 'success'", "runs after a red suite, never without node_modules");
	assert.equal(width.key("timeout-minutes"), "10");
	assert.deepEqual(width.keys, ["name", "if", "timeout-minutes", "run"], "nothing else on the step: no env (a CONSOLE_WIDTH_PIN there would check CI against another pin) and no continue-on-error (a red that blocks nothing)");
	assert.ok(!job.some((line) => /^\s*continue-on-error:/.test(line)), "no step of the required job, nor the job, may go red without failing it");
	assert.ok(!job.some((line) => /^ {4}if:/.test(line)), "the required job has no job-level `if:`: a skipped required job reports as passed");
	assert.doesNotMatch(WORKFLOW, /CONSOLE_WIDTH_PIN/, "the pin file's override is the worker test's alone");
	const cmds = width.run.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
	const where = (re) => cmds.findIndex((line) => re.test(line));
	const pinAt = where(/node \.github\/scripts\/console-width-check\.mjs --check-pin --platform linux64\)"$/);
	const curlAt = where(/^curl /);
	const verifyAt = where(/node \.github\/scripts\/console-width-check\.mjs --verify-zip "\$zip" --platform linux64$/);
	const unzipAt = where(/^unzip /);
	const runAt = where(/^CHROME="\$RUNNER_TEMP\/cft\/chrome-linux64\/chrome" node \.github\/scripts\/console-width-check\.mjs --require$/);
	assert.ok(pinAt >= 0 && curlAt > pinAt, "the pin is checked before anything is downloaded");
	assert.equal(cmds[curlAt], `curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 -o "$zip" "$url"`, "https only, redirects included, from the url the check printed");
	assert.ok(verifyAt > curlAt && unzipAt > verifyAt, "the zip is checked against its sha256 before it is unzipped");
	assert.ok(runAt > unzipAt, "and the check runs last, with --require so a missing Chrome is red");
	assert.equal(cmds.length, 6, `nothing else runs in the step: ${JSON.stringify(cmds)}`);
});

test("what the workflow's comment, the docs and the specs say the check does is what it does: its widths and each control's count", async () => {
	const { states, retry } = await shellLive();
	const [desk, phone] = [controlDoc(states, retry).expected.length, phoneControlDoc(states).expected.length];
	const prose = (text) => text.replace(/\s+/g, " ");
	const comment = prose(jobLines(WORKFLOW, "contract-tests").filter((line) => /^\s*#/.test(line)).map((line) => line.replace(/^\s*#\s?/, "")).join(" "));
	assert.ok(comment.includes(`at ${listed(PHONE_WIDTHS)} px as a phone and at ${listed(DESKTOP_WIDTHS)} px`), "the workflow's comment names the sweep's widths");
	assert.ok(comment.includes(`must fail with exactly their ${WORDS[desk]} and ${WORDS[phone]} problems`), "and each control's count");
	assert.ok(comment.includes(`blind to one of those ${WORDS[desk + phone]} cannot pass`), "and what the two prove together, no more");
	const read = (path) => prose(readFileSync(join(repo, path), "utf8"));
	const docs = read("docs/console.md");
	assert.ok(docs.includes(`at ${listed(PHONE_WIDTHS)} pixels as a phone and at ${listed(DESKTOP_WIDTHS)}`), "docs/console.md names the sweep's widths");
	assert.ok(docs.includes(`one built to break ${WORDS[desk]} of its rules`) && docs.includes(`a phone's bar built to break ${WORDS[phone]}`), "and each control's count");
	assert.ok(read("SECURITY.md").includes(`at ${WORDS[PHONE_WIDTHS.length]} phone widths and ${WORDS[DESKTOP_WIDTHS.length]} desktop widths`), "SECURITY.md counts them");
	for (const spec of ["specs/design.md", "specs/requirements.md"]) {
		const text = read(spec);
		assert.ok(text.includes(listed(DESKTOP_WIDTHS)) && text.includes(`${WORDS[desk]} sentences`) && text.includes(`${WORDS[phone]} sentences`), `${spec} names the desktop widths and each control's sentences`);
	}
});

test("the workflow: run as GitHub runs it, a bad pin stops it before curl and a bad zip before unzip", () => {
	const job = jobLines(WORKFLOW, "contract-tests");
	const { run } = step(job, (line) => line === `      - name: ${STEP_NAME}`);
	const dir = tempDir("pd-width-step-");
	const log = join(dir, "calls.log");
	const stub = (name, body) => {
		writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "$LOG"\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	};
	stub("node", 'case "$*" in *--check-pin*) [ "$FAIL" = pin ] && exit 1; echo https://storage.googleapis.com/x/chrome-linux64.zip;; *--verify-zip*) [ "$FAIL" = zip ] && exit 1;; *--require*) echo "CHROME=$CHROME" >> "$LOG";; esac; exit 0');
	stub("curl", "exit 0");
	stub("unzip", "exit 0");
	const calls = (fail) => {
		writeFileSync(log, "");
		// GitHub's own invocation of a `run:` step on Linux.
		const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], { cwd: dir, encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, LOG: log, FAIL: fail } });
		return { status: r.status, calls: readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" ")) };
	};
	const ok = calls("");
	assert.equal(ok.status, 0);
	assert.deepEqual(ok.calls, ["node .github/scripts/console-width-check.mjs", "curl -fsSL", "node .github/scripts/console-width-check.mjs", "unzip -q", "node .github/scripts/console-width-check.mjs", `CHROME=${dir}/cft/chrome-linux64/chrome`]);
	assert.match(readFileSync(log, "utf8"), /^curl .* -o \S+\/chrome-linux64\.zip https:\/\/storage\.googleapis\.com\/x\/chrome-linux64\.zip$/m, "curl fetches the url --check-pin printed");
	const badPin = calls("pin");
	assert.notEqual(badPin.status, 0);
	assert.deepEqual(badPin.calls, ["node .github/scripts/console-width-check.mjs"], "nothing is downloaded from a pin that does not hold");
	const badZip = calls("zip");
	assert.notEqual(badZip.status, 0);
	assert.deepEqual(badZip.calls, ["node .github/scripts/console-width-check.mjs", "curl -fsSL", "node .github/scripts/console-width-check.mjs"], "nothing is unzipped or run from a zip that is not the pin's");
});
