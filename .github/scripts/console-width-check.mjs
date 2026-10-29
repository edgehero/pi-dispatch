#!/usr/bin/env node
/**
 * The operator console at phone width, its top bar from phone to wide desktop, under its real Content-Security-Policy,
 * in a real browser (issue #737).
 *
 *   node .github/scripts/console-width-check.mjs [--require] [--shots <dir>]
 *   node .github/scripts/console-width-check.mjs --verify-zip <file> [--platform linux64|mac-arm64]
 *   node .github/scripts/console-width-check.mjs --check-pin [--platform linux64|mac-arm64]
 *
 * WHAT IT LOADS. Every golden page (`admin/test/fixtures/console/<shot>.<role>.html`, the role `operator`, `viewer`
 * or `anonymous` for a page nobody is signed in to: the sign-in pages and the error pages, the pages harness's
 * `STATIC_SHOTS`, the two sign-in pages required by name, `SIGN_IN`), every panel golden
 * (`fixtures/console/panels/<state>.<role>.html`: the states the fixture deployment cannot reach, drawn from canned
 * views), the shell sweep's pages and the two negative controls (both below), served over plain http on 127.0.0.1 by
 * a small server of its own with `applySecurityHeaders` on EVERY response, so a page that needs an inline script, an
 * inline style or a resource from elsewhere is refused by the browser exactly as the console would refuse it. The
 * stylesheet and the script are the modules' own (`CONSOLE_CSS`, `CONSOLE_SCRIPT`), and the script RUNS: its event
 * streams (`/api/events`, `/api/transcript`) and a one-time link page's post (`POST /login/code`, the page loaded with
 * a code, `LINK_CODE_FRAGMENT`) are held open and answer nothing, so every page stays in the state its golden drew,
 * and `/api/whoami` answers `{}`. Any other request is a failure, because a page asking for something this server
 * does not serve is a page measured without it.
 *
 * WHAT IT CHECKS ON THE GOLDENS, per page, role and theme (light and dark through `prefers-color-scheme`, plus one page
 * forced each way against the opposite system theme, with `data-theme` on `<html>` and the `color-scheme` meta exactly
 * as `html.mjs` `page()` draws them for that theme, which is what the theme cookie gets), at 375x812, `mobile: true`:
 *   - no `securitypolicyviolation` (listeners installed before any page script, read back after load);
 *   - `document.scrollingElement.scrollWidth <= 375`, and every element whose box ends past the right edge sits inside
 *     an ancestor with computed `overflow-x: auto|scroll` whose own box fits (`<body>` and `<html>` excuse nothing:
 *     their overflow scrolls the viewport, which is the failure);
 *   - the computed `--canvas` is the token's value for the theme the page should show (`colorOf`, pulse-tokens.mjs);
 *   - Fleet Active progress, its phase bars and labels stay inside their cell and clear of the action, with no clipped progress container;
 *   - every `PAGES` name has a golden for each role;
 *   - the window is a phone's: the emulation is read back from the page (`EMULATION_PROBE`), since nothing that SETS
 *     it can say whether DevTools applied it.
 * A width failure names the page, role, theme, the outermost offending elements (widest first) and the platform font
 * Chrome resolved for text inside the widest, because CI is the authority and Linux's fonts are wider than macOS's.
 *
 * THE SHELL SWEEP. A golden is one role at one width; the top bar is what changes with the window, the role, a
 * read-only console and the name signed in. So every `PAGES` page is also drawn by `pages.mjs` `renderPage` (the real
 * code, with empty page data: the bar is the subject, and a page whose data could not be read is a page people see)
 * for each of `shellContexts` (an operator, a viewer, an operator on a read-only console, and the longest name the
 * token rule allows on a read-only console: the most the bar ever holds), with the Parked pill carrying a count and
 * the run page titled with a 120-character id, and loaded at each of `SHELL_WIDTHS` (as a phone at 375 and below, as a
 * desktop above, the emulation read back as for a golden). The script changes the bar after the page is drawn (the
 * live word, the revealed theme button, the Parked count the stream swaps), so the bar is read in every combination of
 * them (`barSource`): each live word, with the theme button shown and then hidden, with the Parked count as drawn,
 * emptied and five digits long. Each run fails on:
 *   - a CSP violation, or the width rule above against the window's width, and a page that scrolls sideways in any read
 *     of the bar (its `scrollWidth`, read with each);
 *   - any two parts of the bar whose shown boxes (each part's own box and everything drawn inside it, each cut by the
 *     overflow boxes around it: `inkOf`) meet: a navigation item
 *     against the brand pill and each part of the bar's end (the live pill, the theme button, the read-only chip, who is
 *     signed in, Sign out), and those against each other (`barVerdict`, the overlap in px);
 *   - above `PHONE_MAX`, where the navigation must never scroll, a navigation item that does not show whole with its
 *     focus ring (`navCut`);
 *   - at EVERY width, phones included, a bar whose height changes with the live word, the theme button or the Parked
 *     count (`heightProblems`): any of them moves the whole page under the reader, on a phone's first load too;
 *   - a bar never read with one of the live words or Parked counts (`liveReadProblems`, `parkedReadProblems`), a
 *     Parked count the read could not widen, and two live words drawn with the same classes, which a phone's glyph
 *     cannot tell apart (`liveStateProblems`, before any run);
 *   - from `ONE_ROW_WIDTH` (1440, the Shell card's own width) a bar of a console that is not read-only that is not one
 *     row (`oneRowProblems`);
 *   - a signed-in name or role word cut off without an ellipsis or without the title a reader sees there holding it
 *     whole, and the longest name not cut off at all (`nameProblems`);
 *   - where there is a More menu: a click on its button that does not open it, a button the opened menu leaves cut off
 *     (focus ring included), or a list that is cut off, leaves the viewport, covers its button, or, where the button
 *     shows, does not open under it: right edges within 1 px and its top 4 to 8 px below the button (`moreVerdict`). On
 *     a phone the click is the hard one: the navigation is scrolled until More's button is cut in half at the row's
 *     edge, nothing holds focus, and the button gets a bare `click()` (an assistive technology's activation, or
 *     Safari's), never scrolled into view by the check first (`moreSource`).
 * One more run loads `NO_SCRIPT` (the operator's overview at 1024 px) with page scripts off, opens More with a real
 * mouse click, and fails unless the list opens under its button by CSS alone (`noScriptVerdict`). It proves its
 * scripts WERE off: the theme button, which the script reveals as the page loads, must still be `hidden` (a run whose
 * script ran would measure the script's placement and call it the CSS's); and a check that never made the run fails
 * ("the run without page scripts never ran", `summarize`).
 * The page reports only boxes, computed `position` and `overflow`, and which element is which part (`COLLECT`);
 * what clips what and every rule is decided in `shellMetrics` and the verdicts, which the worker test drives on
 * constructed input. Chrome runs with `--hide-scrollbars` (chrome-pipe.mjs), so a width here is the page's whole
 * layout width, scrollbar or not.
 *
 * THE NEGATIVE CONTROLS, loaded first in every run (`controlDoc`, `phoneControlDoc`, `controlVerdict`): two synthetic
 * top bars of fixed px boxes, each failed with exactly the sentences it was built for, or the run fails. The first, at
 * 1024 px, breaks nine named rules once each: a 60 px overlap under the navigation and a 20 px one inside the end, a
 * hidden pill, a jump with the live word and one with the theme button, a name cut off without an ellipsis and without
 * a title, and a More list cut off and opened away from its button. The second, at 375 px as a phone, fails four
 * sentences: its bar jumps with the LAST live word (so a read that skips a word loses it) and with its Parked count
 * emptied (so a read that never varies the count loses it), its page scrolls sideways only while the count is emptied
 * (so a width read once loses it), and its More closes itself when opened with its button cut, as round 3's phone bar
 * did (so a check that scrolls the button into view before the click loses it). A measure gone blind to one of those
 * thirteen (the words never set or one skipped, a clip never read, only the first pill read, a phone's height never
 * compared, the count never varied, the width read once, the hard click made easy) would pass every page in silence,
 * and against the controls it cannot. They prove only those thirteen: the other rules above are held by the worker
 * test on constructed input.
 *
 * `WIDTH_PENDING` is a ratchet over the goldens: a page listed there may still overflow (its CSP and theme checks still
 * apply), and a listed page that FITS fails the run, so the list can only shrink. The shell sweep has none: the bar is
 * every page's.
 *
 * DETERMINISM, because this runs as a step of a required check and must not go red on a tree nobody touched (issue
 * #284's class): Chrome for Testing at the exact version `.github/chrome-for-testing.json` pins, the pin itself checked
 * before anything is downloaded (`--check-pin`, which prints the url derived from the pinned version) and the zip
 * against its sha256 before it is unzipped (`--verify-zip`); time zone UTC, locale en-US and the page's clock fixed one
 * minute after the fixture's instant, over the DevTools protocol; one tab at a time (the held streams would otherwise
 * run into Chrome's six connections per origin); a deadline per navigation and per run, so a wait that never ends fails
 * the step instead of holding the job. No virtual time: pausing it while a stub holds a fetch open never resumes.
 *
 * NO CHROME (none at `CHROME`, `google-chrome` or `chromium` on PATH, or the macOS app): exit 0 "skipped", or exit 1
 * with `--require`, which CI passes. `--shots <dir>` also writes a full-page PNG per golden run and a window-sized one
 * per shell run (the PR's screenshots).
 *
 * The same build CI uses, locally on an Apple silicon Mac: download the url `--check-pin --platform mac-arm64` prints,
 * check it with `--verify-zip <zip> --platform mac-arm64`, unzip it outside the repository, and run with
 * CHROME=".../chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing".
 */
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frozenDateSource, openChrome } from "../../launch/chrome-pipe.mjs";
import { findOnPath } from "../../launch/server-binary.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES = join(REPO, "admin", "test", "fixtures", "console");
/**
 * The Chrome for Testing pin. `CONSOLE_WIDTH_PIN` names another file for a test only (the worker test runs `--check-pin`
 * on a broken pin through the real entry point, which a constant path could not reach); CI never sets it, and whatever
 * file is read, the url printed is still derived from its version and its whole content checked first.
 */
export const PIN_FILE = process.env.CONSOLE_WIDTH_PIN || join(REPO, ".github", "chrome-for-testing.json");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The phone the console must fit: an iPhone-sized viewport in CSS pixels, drawn at device scale 2. */
export const VIEWPORT = Object.freeze({ width: 375, height: 812, scale: 2 });
/** The window the shell sweep's desktop widths are drawn in: its height and scale (its width is the sweep's). */
export const DESKTOP = Object.freeze({ height: 900, scale: 1 });
/**
 * The widths the shell is loaded at: the narrowest phone the console supports and the usual one (both emulated as a
 * phone), then the desktop range the reviews measured the top bar failing in, at the window sizes people use: from
 * 761 to about 1315 px its pills ran under its end cluster (and up to 1440 on a read-only console), and once the
 * navigation scrolled at every width it hid pills there and jumped 60 px in content-dependent bands (1180 is inside
 * one). 1440 is the Shell card's own width, one row for an operator. And the layout's tightest places, where a bar
 * that is short of room shows it first: 761, the first width above a phone; 940, the first two-row width whose
 * navigation is not broken after its fourth pill; 1600, the first one-row width of a read-only console. The worker test
 * holds these to `page-css.mjs` `TOP_BAR`, so a moved breakpoint moves the sweep.
 */
export const SHELL_WIDTHS = Object.freeze([320, 375, 761, 800, 940, 1024, 1180, 1280, 1440, 1600]);
/**
 * From this width the top bar of a console that is not read-only is one row (the pi-dispatch pill, the navigation, the
 * rest), as the Shell card draws it at its own 1440 px (`oneRowProblems`).
 */
export const ONE_ROW_WIDTH = 1440;
/**
 * The bundle's phone breakpoint (`@media (max-width: 760px)`, pinned by the test): at and below it the navigation is a
 * row of its own that scrolls inside itself; above it every pill must show whole, and the bar must not change height.
 */
export const PHONE_MAX = 760;
/** How far a focused pill's ring reaches outside it: bundle.css's `:focus-visible` outline (2 px) plus its offset (2 px). */
export const FOCUS_RING = 4;
/** More's list opens under its button: right edges within `MORE_ALIGN` px, its top `MORE_GAP` px below the button. */
export const MORE_ALIGN = 1;
export const MORE_GAP = Object.freeze([4, 8]);
/**
 * The width the emulation probe's viewport meta asks for: none of the sweep's, so only a window emulated as a phone
 * (`mobile: true`, which honours the meta) lays the page out at it.
 */
export const PROBE_WIDTH = 1234;
/** Where the first negative control is served, and the window it is loaded in (a desktop one, where its nine rules apply). */
export const CONTROL_PATH = "/control/top-bar";
export const CONTROL_WIDTH = 1024;
/** Where the phone's negative control is served (its page, `.css` and `.js`), and its window, emulated as a phone. */
export const PHONE_CONTROL_PATH = "/control/phone";
export const PHONE_CONTROL_WIDTH = 375;
/**
 * The run made with page scripts off (`Emulation.setScriptExecutionDisabled`): above a phone the More list opens under
 * its button by CSS alone, so it must without the script too. The operator's overview, at a two-row width.
 */
export const NO_SCRIPT = Object.freeze({ doc: "shell.operator.overview", width: 1024 });
/** The run page's id in the shell sweep: one unbroken token, long enough to be wider than any window unless it wraps. */
export const RUN_ID_LENGTH = 120;
/** The Parked pill's count in the shell sweep: three digits, so the pill is drawn with its widest usual bubble. */
export const PARKED_SHOWN = 128;
/**
 * The Parked count the bar is also read with, swapped in where the drawn one stood (the stream swaps that panel on a
 * live page): five digits, wider than any queue the console has met, so a count that grows cannot move the bar.
 */
export const PARKED_WIDE = 12_345;
/** How the kit draws a count (`kit.mjs` `count`, grouped in en-US), so the read can find the drawn one and widen it. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");
/** Sub-pixel slack on "past the edge", "fits" and "overlaps": a box ending at 375.4 is layout rounding, not overflow. */
export const EDGE_SLACK = 0.5;
/**
 * Pages (a `data-page` name) whose WIDTH failures are known and tolerated until their own page PR fixes them. A ratchet:
 * a listed page that fits fails the run, so an entry is removed the day it is no longer needed. Empty is the goal.
 */
export const WIDTH_PENDING = Object.freeze([]);
/** The roles every `PAGES` page has a golden for. */
export const ROLES = Object.freeze(["operator", "viewer"]);
/**
 * The roles a golden may be drawn for: those, and `anonymous` for a page nobody is signed in to (a sign-in page, an
 * error page drawn without a session), as the pages harness names its static shots.
 */
export const GOLDEN_ROLES = Object.freeze([...ROLES, "anonymous"]);
export const THEMES = Object.freeze(["light", "dark"]);
/** The golden each forced theme is tried on (a theme cookie's page, against the opposite system theme). */
export const FORCED_DOC = "overview.operator";
/**
 * The sign-in pages and the golden each is measured by: `[data-page, path, golden file]`, two of the pages harness's
 * static shots, drawn by `shell.mjs` with nobody signed in. Both were measured from the first width check on (drawn
 * here, then), so a golden missing for one is a setup problem, never a page quietly left out. The worker test holds
 * this to `server.mjs`'s `ROUTES` (every GET sign-in route) and to the shell's page functions, so a new sign-in page
 * cannot go unmeasured either.
 */
export const SIGN_IN = Object.freeze([Object.freeze(["login", "/login", "login.anonymous.html"]), Object.freeze(["login-code", "/login/code", "login-code.anonymous.html"])]);
/**
 * The fragment a one-time link page (`data-page="login-code"`) is loaded with: a code, so the script takes it out of
 * the history and posts it, which this check's server holds open, unanswered, as it holds the event streams. The page
 * then stays in the state the server drew (signing in, a used link, no code), the state its golden pins. Loaded with
 * no fragment, every link page would be measured as the script's "no code" state, whatever its golden drew.
 */
export const LINK_CODE_FRAGMENT = `#${"k".repeat(43)}`;

/** The url a golden run loads its doc at: its path, and for a one-time link page the code fragment (`LINK_CODE_FRAGMENT`). */
export function goldenUrl(doc, path = doc.path) {
	return doc.page === "login-code" ? `${path}${LINK_CODE_FRAGMENT}` : path;
}

/** Chrome for Testing's platforms this repository pins: linux64 for CI, mac-arm64 for a maintainer's machine. */
export const CFT_PLATFORMS = Object.freeze(["linux64", "mac-arm64"]);
/** The longest one navigation (the request, the page's load event) may take. */
export const NAV_MS = 20_000;
/** The longest any other DevTools call may take. */
const STEP_MS = 20_000;
/** The longest the whole run may take; the workflow step's own `timeout-minutes` is the backstop above this. */
export const RUN_MS = 6 * 60_000;

const USAGE = `usage: node .github/scripts/console-width-check.mjs [--require] [--shots <dir>]
       node .github/scripts/console-width-check.mjs --verify-zip <file> [--platform ${CFT_PLATFORMS.join("|")}]
       node .github/scripts/console-width-check.mjs --check-pin [--platform ${CFT_PLATFORMS.join("|")}]
  --require     fail (exit 1) when no Chrome is found, instead of skipping
  --shots       also write a PNG of every page, role and theme, and of every shell run, into <dir>
  --verify-zip  check a downloaded Chrome for Testing zip against .github/chrome-for-testing.json's sha256
  --check-pin   check .github/chrome-for-testing.json and print the platform's download url, derived from its version
                (for both, the platform defaults to this machine's)
  Chrome: CHROME, else google-chrome or chromium on PATH, else ${MAC_CHROME}`;

/** A failure the operator can act on (no browser, a dead browser, a wait that never ended): one line, exit 1. */
export class Refusal extends Error {}

// ---- the pure parts (worker/test/console-width-check.test.mjs) ---------------------------------------------------

/** The options, or `{ help }`, or `{ error }` (a sentence for the operator, never a stack). */
export function parseArgs(argv) {
	const opts = { require: false, shots: null, verifyZip: null, checkPin: false, platform: null };
	const value = (i, flag) => {
		const v = argv[i + 1];
		if (v === undefined || v === "" || v.startsWith("--")) return { error: `${flag} takes a value` };
		return { v };
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") return { help: true };
		if (a === "--require") opts.require = true;
		else if (a === "--check-pin") opts.checkPin = true;
		else if (a === "--shots" || a === "--verify-zip" || a === "--platform") {
			const got = value(i, a);
			if (got.error) return got;
			opts[{ "--shots": "shots", "--verify-zip": "verifyZip", "--platform": "platform" }[a]] = got.v;
			i++;
		} else return { error: `unexpected argument: ${a}` };
	}
	const measuring = opts.require || opts.shots !== null;
	if (opts.verifyZip !== null && (measuring || opts.checkPin)) return { error: "--verify-zip runs alone" };
	if (opts.checkPin && measuring) return { error: "--check-pin runs alone" };
	if (opts.platform !== null && opts.verifyZip === null && !opts.checkPin) return { error: "--platform goes with --verify-zip or --check-pin" };
	if (opts.platform !== null && !CFT_PLATFORMS.includes(opts.platform)) return { error: `--platform is one of ${CFT_PLATFORMS.join(", ")}` };
	return opts;
}

/** Chrome for Testing's download url for `version` on `platform`: derived, so the pin file's copy is checked, not trusted. */
export function cftUrl(version, platform) {
	return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
}

/** What is wrong with a pin file's contents, as sentences; empty when it can be used. */
export function pinProblems(pin) {
	const out = [];
	if (!pin || typeof pin !== "object") return ["the pin is not a JSON object"];
	if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(pin.version)) out.push(`version ${JSON.stringify(pin.version)} is not an exact Chrome version (four numbers)`);
	if (pin.channel !== "Stable") out.push(`channel ${JSON.stringify(pin.channel)} is not Stable`);
	if (typeof pin.released !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pin.released)) out.push(`released ${JSON.stringify(pin.released)} is not a date (YYYY-MM-DD)`);
	const platforms = Object.keys(pin.downloads ?? {});
	if (platforms.join(",") !== CFT_PLATFORMS.join(",")) out.push(`downloads are ${JSON.stringify(platforms)}, not ${JSON.stringify(CFT_PLATFORMS)}`);
	for (const platform of CFT_PLATFORMS) {
		const d = pin.downloads?.[platform];
		if (!d) continue;
		if (out.length === 0 && d.url !== cftUrl(pin.version, platform)) out.push(`downloads.${platform}.url is not ${cftUrl(pin.version, platform)}`);
		if (typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256)) out.push(`downloads.${platform}.sha256 is not 64 lowercase hex digits`);
	}
	return out;
}

/**
 * What `--check-pin` prints: `{ url }`, the download for `platform` derived from the pin's version once the whole pin
 * holds (`pinProblems`), or `{ error }`. The workflow downloads from this url, never from a field it read itself, so a
 * pin that names a build its version does not, or holds no usable hash, stops the step before anything is fetched.
 */
export function pinUrl(pin, platform) {
	if (!CFT_PLATFORMS.includes(platform)) return { error: `the pin has no ${platform} download (it pins ${CFT_PLATFORMS.join(", ")})` };
	const problems = pinProblems(pin);
	if (problems.length > 0) return { error: `.github/chrome-for-testing.json: ${problems.join("; ")}` };
	return { url: cftUrl(pin.version, platform) };
}

/** This machine's Chrome for Testing platform, or null where none is pinned. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
	if (platform === "linux" && arch === "x64") return "linux64";
	if (platform === "darwin" && arch === "arm64") return "mac-arm64";
	return null;
}

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a download whose sha256 is `got` is the pin's build for `platform`: `{ ok, want, got, problem }`. */
export function zipVerdict({ got, platform, pin }) {
	const want = pin?.downloads?.[platform]?.sha256 ?? null;
	if (want === null) return { ok: false, want, got, problem: `the pin has no ${platform} download` };
	if (got !== want) return { ok: false, want, got, problem: `sha256 ${got} is not the pinned ${want} (Chrome for Testing ${pin.version} ${platform}): refusing to run an unverified browser` };
	return { ok: true, want, got, problem: null };
}

/**
 * Where Chrome is: `{ path, from }`, `{ path: null }` when there is none, or `{ error }` when CHROME names something
 * that cannot run (a stated binary that is missing is a mistake to report, never a reason to skip quietly).
 */
export function findChrome({ env = process.env, onPath = findOnPath, executable = isExecutable } = {}) {
	if (env.CHROME) return executable(env.CHROME) ? { path: env.CHROME, from: "CHROME" } : { error: `CHROME is ${env.CHROME}, which is not an executable file` };
	const found = onPath(["google-chrome", "chromium"], env.PATH ?? "");
	if (found) return { path: found, from: "PATH" };
	if (executable(MAC_CHROME)) return { path: MAC_CHROME, from: "the macOS app" };
	return { path: null };
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** What `findChrome`'s answer means for a run: `{ path }`, `{ skip }` (a line to print, exit 0) or `{ refusal }`. */
export function chromeChoice(found, require) {
	if (found.error) return { refusal: found.error };
	if (found.path) return { path: found.path };
	if (require) return { refusal: "no Chrome found (CHROME, google-chrome or chromium on PATH, or the macOS app), and --require is set" };
	return { skip: "console-width-check: skipped, no Chrome found (set CHROME to run it)" };
}

/**
 * The Chrome that ran against the pin (`product` is `Browser.getVersion`'s, "HeadlessChrome/155.0.8059.39"): `{}` when
 * it is the pinned build; else a `failure` in CI, which must measure with that build, and a `note` anywhere else.
 */
export function versionCheck({ product, pin, ci }) {
	const version = /\/([\d.]+)$/.exec(String(product ?? ""))?.[1] ?? null;
	if (version === pin.version) return {};
	const said = `this is Chrome ${version ?? product}, not the pinned Chrome for Testing ${pin.version}`;
	return ci ? { failure: `${said}: CI must measure with the pinned build` } : { note: `${said}; CI is the authority on width` };
}

/** How a golden is named: `<shot>.<role>.html`, its role one of `GOLDEN_ROLES`. */
const GOLDEN_NAME_RE = new RegExp(`^([a-z0-9][a-z0-9-]*)\\.(${GOLDEN_ROLES.join("|")})\\.html$`);

/** A golden's file name as `{ shot, role }`, or null when it is not `<shot>.<role>.html` for one of `GOLDEN_ROLES`. */
export function goldenName(file) {
	const m = GOLDEN_NAME_RE.exec(file);
	return m ? { shot: m[1], role: m[2] } : null;
}

/** The `PAGES` names some role has no golden for, as sentences. */
export function missingGoldens(files, pageNames, roles = ROLES) {
	const have = new Set(files);
	const out = [];
	for (const name of pageNames) for (const role of roles) if (!have.has(`${name}.${role}.html`)) out.push(`no golden ${name}.${role}.html for the page ${name}`);
	return out;
}

/**
 * The sign-in pages (`SIGN_IN`) the top-level goldens (`docs`, `readGoldens`') hold no golden for, or a golden of
 * another page for, as sentences.
 */
export function signInProblems(docs) {
	const out = [];
	for (const [page, path, file] of SIGN_IN) {
		const doc = docs.find((d) => d.file === file);
		if (!doc) out.push(`no golden ${file} for the sign-in page ${path} (one of the pages harness's static shots)`);
		else if (doc.page !== page) out.push(`${file} draws the page ${doc.page}, not the sign-in page ${path} (data-page="${page}")`);
	}
	return out;
}

/**
 * Everything wrong with the goldens before a browser is opened: what reading them found, a page with none for a role,
 * and a sign-in page with none.
 */
export function goldenProblems({ top, panels, pageNames }) {
	return [...top.problems, ...panels.problems, ...missingGoldens(top.docs.map((d) => d.file), pageNames), ...signInProblems(top.docs)];
}

/**
 * The two places a theme lives in a page's head, as `page()` drew them: the `<html ...>` tag (its `data-theme`) and the
 * `<meta name="color-scheme">`. Read off a page `html.mjs` rendered, so a forced run carries exactly what the console
 * sends for that theme. Throws when the page has not exactly one of each.
 */
export function themeHead(pageHtml) {
	const tags = String(pageHtml).match(/<html\b[^>]*>/g) ?? [];
	const metas = String(pageHtml).match(/<meta name="color-scheme" content="[^"]*">/g) ?? [];
	if (tags.length !== 1) throw new Error(`a page has ${tags.length} <html> tags, not one`);
	if (metas.length !== 1) throw new Error(`a page has ${metas.length} color-scheme metas, not one`);
	return { htmlTag: tags[0], schemeMeta: metas[0] };
}

/**
 * `html` (a golden, drawn with no theme choice: `from` is `themeHead` of such a page) redrawn as the theme `to` is, its
 * `<html>` tag and its `color-scheme` meta replaced. Throws unless the golden holds each of `from`'s exactly once, so a
 * golden drawn some other way is refused rather than half forced.
 */
export function injectTheme(html, from, to) {
	let out = String(html);
	for (const key of ["htmlTag", "schemeMeta"]) {
		const n = out.split(from[key]).length - 1;
		if (n !== 1) throw new Error(`the page holds ${from[key]} ${n} times, not once, so the theme cannot be forced on it`);
		out = out.replace(from[key], () => to[key]);
	}
	return out;
}

/**
 * The runs for `docs` (each `{ id }`): every doc in each system theme, and `FORCED_DOC` once forced each way against
 * the opposite system theme. `expect` is the theme whose `--canvas` the page must show.
 */
export function planRuns(docs) {
	const runs = [];
	for (const doc of docs) for (const theme of THEMES) runs.push({ key: `${doc.id} ${theme}`, doc, emulated: theme, forced: null, expect: theme, label: theme });
	const forced = docs.find((d) => d.id === FORCED_DOC);
	if (!forced) throw new Error(`no golden ${FORCED_DOC}.html to try the forced themes on`);
	for (const [system, theme] of [["light", "dark"], ["dark", "light"]]) runs.push({ key: `${forced.id} forced ${theme} (system ${system})`, doc: forced, emulated: system, forced: theme, expect: theme, label: `forced-${theme}` });
	return runs;
}

/**
 * The longest name `rule` (the console token rule, `TOKEN_NAME_RE`) accepts, of `letter` repeated: derived, so the
 * sweep grows with the rule. Throws when the rule takes none, or takes every length up to `cap` (it has no bound to
 * measure).
 */
export function longestName(rule, letter = "m", cap = 256) {
	let longest = 0;
	for (let n = 1; n <= cap; n++) if (rule.test(letter.repeat(n))) longest = n;
	if (longest === 0) throw new Error(`the name rule ${rule} takes no name of ${JSON.stringify(letter)}s`);
	if (longest === cap) throw new Error(`the name rule ${rule} takes ${cap} characters: no longest name to draw`);
	return letter.repeat(longest);
}

/**
 * Who the shell sweep signs in as (see the header); `nameRule` is `TOKEN_NAME_RE`. `longest` marks the one whose name
 * must be cut off with an ellipsis wherever the bar shows it (`nameProblems`).
 */
export function shellContexts(nameRule) {
	const longest = longestName(nameRule);
	return Object.freeze([
		Object.freeze({ id: "operator", session: Object.freeze({ name: "ops", role: "operator" }), readOnly: false, longest: false }),
		Object.freeze({ id: "viewer", session: Object.freeze({ name: "viewer", role: "viewer" }), readOnly: false, longest: false }),
		Object.freeze({ id: "read-only", session: Object.freeze({ name: "ops", role: "operator" }), readOnly: true, longest: false }),
		Object.freeze({ id: "longest-name", session: Object.freeze({ name: longest, role: "operator" }), readOnly: true, longest: true }),
	]);
}

/**
 * A run id `RUN_ID_LENGTH` characters long with no break opportunity in it (letters and digits only), or a throw when
 * `accepts` (the run page's own query rule) refuses it: an id the page would refuse never reaches its title.
 */
export function longRunId(accepts, length = RUN_ID_LENGTH) {
	const id = `gh${"0123456789abcdef".repeat(Math.ceil(length / 16))}`.slice(0, length);
	if (!accepts(id)) throw new Error(`the run page refuses a ${length}-character run id, so the sweep cannot title a page with one`);
	return id;
}

/**
 * The shell sweep's docs: every page of `pageNames` for every context, drawn by `draw(name, ctx)` (`renderPage`'s
 * `{ html }`) with the page data empty but for the Parked count, and the run page's query naming `runId`.
 */
export async function shellDocs({ pageNames, contexts, runId, draw }) {
	const docs = [];
	for (const c of contexts) {
		for (const name of pageNames) {
			const ctx = { session: { ...c.session }, readOnly: c.readOnly, data: { parkedCount: PARKED_SHOWN }, query: name === "run" ? { id: runId } : {}, theme: null };
			docs.push({ id: `shell.${c.id}.${name}`, file: null, path: `/shell/${c.id}/${name}`, page: name, role: c.id, longest: c.longest === true, readOnly: c.readOnly === true, html: String((await draw(name, ctx)).html) });
		}
	}
	return docs;
}

/**
 * The Parked counts the bar is read with, as the kit draws them: `drawn`, the sweep's `PARKED_SHOWN` (what the page
 * holds), and `wide`, `PARKED_WIDE`, swapped in for it.
 */
export function parkedCounts(shown = PARKED_SHOWN, wide = PARKED_WIDE) {
	return { drawn: COUNT_FORMAT.format(shown), wide: COUNT_FORMAT.format(wide) };
}

/** `shell.mjs` `LIVE_STATES` as the bar is read with it: each distinct `{ cls, word }` once, in the table's order. */
export function liveStatesOf(table) {
	return [...new Map(Object.values(table).map((s) => [`${s.cls} ${s.word}`, { cls: s.cls, word: s.word }])).values()];
}

/**
 * Two live words drawn with the same classes, as sentences: on a phone the pill shows its state's glyph alone, chosen by
 * its classes (the word is kept for a screen reader), so two words that share them look alike there.
 */
export function liveStateProblems(states) {
	const out = [];
	for (const [i, s] of states.entries()) {
		const twin = states.slice(i + 1).find((o) => o.cls === s.cls);
		if (twin) out.push(`the live pill draws ${s.word} and ${twin.word} with the same classes (${s.cls}), so a phone, which shows the state's glyph alone, cannot tell them apart`);
	}
	return out;
}

/** The shell sweep's runs: each doc at each width, `mobile` (a phone's emulation) at a phone's widths only. */
export function planShellRuns(docs, widths = SHELL_WIDTHS) {
	const runs = [];
	for (const doc of docs) for (const width of widths) runs.push({ key: `${doc.id} ${width}`, doc, width, mobile: width <= VIEWPORT.width });
	return runs;
}

/** What the run without page scripts' doc id ends with: `summarize` looks for a result under it. */
export const NO_SCRIPT_SUFFIX = ".no-script";

/**
 * The run made with page scripts off (`NO_SCRIPT`, `checkNoScript`), from the shell sweep's docs: its doc at
 * `NO_SCRIPT.width` as a desktop, under an id of its own (`NO_SCRIPT_SUFFIX`), or null when the sweep holds no such
 * doc (a setup problem `runCheck` reports). `checkPages` and the worker test's faked browser both plan it here.
 */
export function noScriptRun(sweep) {
	const bare = sweep.find((d) => d.id === NO_SCRIPT.doc);
	if (!bare) return null;
	return { key: `${bare.id} ${NO_SCRIPT.width} no script`, doc: { ...bare, id: `${bare.id}${NO_SCRIPT_SUFFIX}`, role: `${bare.role}, no JavaScript` }, width: NO_SCRIPT.width, mobile: false };
}

/**
 * The width rule over what the page measured: `scrollWidth` (the scrolling element's) and `elements`, every element
 * whose box ends past `width` in document order, each `{ tag, id, cls, inside, rect, up, text, font, scrollers }`:
 * `inside` the id of its nearest ancestor that has one, `up` the index of its nearest ancestor in the same list (or
 * -1), `text` whether it holds text of its own, `scrollers` its ancestors below `<body>` whose computed `overflow-x` is
 * auto or scroll, with their boxes.
 *
 * An element is an offender unless one of its scrollers fits the viewport. The report names the ROOTS (offenders with
 * no offending ancestor: where a `min-width: 0` or a scroll box belongs), widest first, and `fontAt`, the first
 * offender holding text inside the widest root, whose platform font is worth resolving.
 */
export function widthVerdict({ scrollWidth, elements }, width = VIEWPORT.width, slack = EDGE_SLACK) {
	const fits = (r) => r.left >= -slack && r.right <= width + slack;
	// `<body>` and `<html>` never excuse: their overflow propagates to the viewport, and a scrolling viewport is the
	// failure itself. The page's collector stops below `<body>`; this repeats it so the rule holds on any input.
	const excused = (e) => (e.scrollers ?? []).some((s) => (s.overflowX === "auto" || s.overflowX === "scroll") && s.tag !== "body" && s.tag !== "html" && fits(s.rect));
	const past = elements.map((e) => e.rect.right > width + slack && !excused(e));
	const offenders = elements.map((e, i) => ({ e, i })).filter(({ i }) => past[i]);
	// Widest first, ties in document order: the widest root is the one that sets the page's width, so it leads.
	const roots = offenders.filter(({ e }) => !(e.up >= 0 && past[e.up])).sort((a, b) => b.e.rect.right - a.e.rect.right || a.i - b.i);
	const under = (i, root) => {
		for (let j = i; j >= 0; j = elements[j].up) if (j === root) return true;
		return false;
	};
	let fontAt = null;
	if (roots.length > 0) fontAt = offenders.find(({ e, i }) => e.text && under(i, roots[0].i))?.i ?? roots[0].i;
	return {
		ok: scrollWidth <= width && offenders.length === 0,
		width,
		scrollWidth,
		wide: scrollWidth > width,
		offenders: offenders.length,
		roots: roots.slice(0, 5).map(({ e, i }) => ({ i, tag: e.tag, id: e.id, cls: e.cls, inside: e.inside ?? "", rect: e.rect })),
		fontAt,
	};
}

/** The box two boxes share, or null when they share none (touching edges share none). */
export function intersect(a, b) {
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.right, b.right);
	const bottom = Math.min(a.bottom, b.bottom);
	return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/**
 * What of a measured part (`{ rect, clips }`) is on screen: its box cut by each box that clips it (`clips`: its
 * ancestors whose overflow is not visible, from its containing block up), or null when nothing of it shows (a hidden
 * button, a pill scrolled out of its row).
 */
export function shownBox(part) {
	let box = part.rect;
	if (!(box.right > box.left && box.bottom > box.top)) return null;
	for (const clip of part.clips ?? []) {
		box = intersect(box, clip);
		if (!box) return null;
	}
	return box;
}

/** A measured part as a reader finds it in the bar: its tag and class, and its label or text. */
export function partName(p) {
	return `${describe(p)}${p.label ? ` "${p.label}"` : ""}`;
}

const px = (n) => `${n.toFixed(1)} px`;

/**
 * The boxes that clip node `i` of a measure: every containing block up its chain whose overflow is not visible.
 * `nodes` (each `{ parent }`, the index of its parent, -1 at `<body>`) and `snap` (each `{ cls, rect, position,
 * overflowX, overflowY, label }`, as one read found it) are the page's collector's, in the same order. A box's containing block is its parent, for an
 * absolutely positioned one its nearest positioned ancestor (so a list positioned against the whole bar escapes the
 * scrolling navigation between them, and is still cut by an overflow box around the bar), and a fixed one has none
 * here. `<body>` and `<html>` clip nothing: their overflow scrolls the viewport. A transform or `contain`, which also
 * make a containing block, is not modelled: the bar uses neither.
 */
export function clipsOf(nodes, snap, i) {
	const out = [];
	for (let at = i; ; ) {
		const { position } = snap[at];
		if (position === "fixed") return out;
		let block = nodes[at].parent;
		if (position === "absolute") while (block >= 0 && snap[block].position === "static") block = nodes[block].parent;
		if (block < 0) return out;
		if (snap[block].overflowX !== "visible" || snap[block].overflowY !== "visible") out.push(snap[block].rect);
		at = block;
	}
}

/** Node `i` of a measure as a part: its name and class and label as read, its box and what clips it; null for none. */
export function partOf(nodes, snap, i) {
	if (!(Number.isInteger(i) && i >= 0 && i < nodes.length)) return null;
	const { tag, id } = nodes[i];
	return { tag, id, cls: snap[i].cls ?? nodes[i].cls, label: snap[i].label, rect: snap[i].rect, clips: clipsOf(nodes, snap, i) };
}

/**
 * What node `i` draws, as one box: the union of its own shown box and the shown box of everything inside it, each cut
 * by what clips it (`shownBox`, `clipsOf`), or null when nothing of it shows. A part's own box is not all a reader
 * sees of it: text that cannot fit a fixed box spills out of it unless something clips it (a phone's 16 px live pill
 * showing its word again would run over the theme button with its own box clear of it).
 */
export function inkOf(nodes, snap, i) {
	let ink = null;
	const inside = (j) => {
		for (let at = j; at >= 0; at = nodes[at].parent) if (at === i) return true;
		return false;
	};
	for (let j = i; j < nodes.length; j++) {
		if (j !== i && !inside(j)) continue;
		const box = shownBox({ rect: snap[j].rect, clips: clipsOf(nodes, snap, j) });
		if (!box) continue;
		ink = ink === null ? box : { left: Math.min(ink.left, box.left), top: Math.min(ink.top, box.top), right: Math.max(ink.right, box.right), bottom: Math.max(ink.bottom, box.bottom) };
	}
	return ink;
}

/**
 * The page's collectors' answers (`bar`, `barSource`'s, and `more`, `moreSource`'s; null where the page drew no bar,
 * or no More) as the verdicts read them. Here, not in the page, so every rule over what was measured is tested on
 * constructed input: the page only reports each element of the bar and its ancestors (its box, `position` and
 * `overflow`), and which element is which part. Returns `{ bars, name, roleWord, widened, more }`: `bars`, one per read
 * (null without a bar), each `{ live, theme, parked, parkedText, scrollWidth, height, nav, end, brand }` (the read's
 * live word, theme button state and Parked count, null where the page has no such thing, and the Parked panel's text
 * as the read found it, null where none was recorded; the page's `scrollWidth` in that read;
 * the navigation's children and the end cluster's children as parts, null when the bar has no such group, and the
 * brand pill); `name` and `roleWord`, the signed-in name's and role word's measures with their parts (null when the bar
 * draws none); `widened`, whether the read could put the wide Parked count in (null where it had none to widen);
 * `more`, `{ opened, cutFirst, summary, menu, width, height }`.
 */
export function shellMetrics({ bar = null, more = null } = {}) {
	let bars = null;
	let name = null;
	let roleWord = null;
	if (bar) {
		const { nodes, roles } = bar;
		const kids = (p) => (p >= 0 ? nodes.flatMap((n, i) => (n.parent === p ? [i] : [])) : null);
		const navKids = kids(roles.nav);
		const endKids = kids(roles.end);
		bars = bar.reads.map((r) => {
			const t = r.snap[roles.top].rect;
			const part = (i) => {
				const p = partOf(nodes, r.snap, i);
				return p && { ...p, ink: inkOf(nodes, r.snap, i) };
			};
			const parts = (list) => (list === null ? null : list.map(part));
			return { live: r.live, theme: r.theme, parked: r.parked ?? null, parkedText: r.parkedText ?? null, scrollWidth: r.scrollWidth ?? null, height: t.bottom - t.top, nav: parts(navKids), end: parts(endKids), brand: part(roles.brand) };
		});
		if (bar.name && bar.reads.length > 0) name = { ...bar.name, part: partOf(nodes, bar.reads[0].snap, roles.name) };
		if (bar.roleWord && bar.reads.length > 0) roleWord = { ...bar.roleWord, part: partOf(nodes, bar.reads[0].snap, roles.roleWord) };
	}
	const m = more && { opened: more.opened, cutFirst: more.cutFirst ?? null, summary: more.nodes ? partOf(more.nodes, more.snap, more.roles.summary) : null, menu: more.nodes ? partOf(more.nodes, more.snap, more.roles.menu) : null, width: more.width, height: more.height };
	return { bars, name, roleWord, widened: bar?.parkedWidened ?? null, more: m };
}

/**
 * How a navigation pill fails to show whole above `PHONE_MAX` (`width` the window's): null when the pill and its
 * focus ring (`FOCUS_RING` px around it) are inside every box that clips it and the window's sides, else `{ shown,
 * ring }`, `shown` the part of the ring a reader sees (null when nothing of the pill shows, or it has no box: a pill
 * not drawn is a pill nobody can reach either).
 */
export function navCut(part, width, slack = EDGE_SLACK) {
	const r = part.rect;
	if (!(r.right > r.left && r.bottom > r.top)) return { shown: null, ring: null };
	const ring = { left: r.left - FOCUS_RING, top: r.top - FOCUS_RING, right: r.right + FOCUS_RING, bottom: r.bottom + FOCUS_RING };
	const shown = shownBox({ rect: ring, clips: [...(part.clips ?? []), { left: 0, top: -Infinity, right: width, bottom: Infinity }] });
	if (shown && ["left", "top", "right", "bottom"].every((side) => Math.abs(shown[side] - ring[side]) <= slack)) return null;
	return { shown: shown && intersect(shown, r) ? shown : null, ring };
}

/**
 * The top bar's rule over one read (`{ live, theme, nav, end, brand }`, a `shellMetrics` bar): no two of its parts'
 * shown boxes (a part's `ink`, its box and all it draws, where `shellMetrics` built one) meet by more than `slack` px
 * each way, a navigation item against the brand pill and every part of the end
 * cluster (`kind` "nav"), and the brand pill and the end's parts against each other (`kind` "bar": the live pill, the
 * theme button, the read-only chip, the name and Sign out); and above `PHONE_MAX`, where the navigation must never be a
 * scroll box, every navigation item shows whole with its focus ring (`hidden`, by `navCut`). On a phone a pill the
 * navigation scrolls out of its row is cut by the row's own box, so it neither overlaps nor fails.
 */
export function barVerdict(bar, { width = 0, slack = EDGE_SLACK } = {}) {
	const problems = [];
	if (!bar.nav) problems.push("the top bar has no .pillnav");
	if (!bar.end) problems.push("the top bar has no .top__end");
	const others = [...(bar.brand ? [bar.brand] : []), ...(bar.end ?? [])];
	const overlaps = [];
	// What a reader sees of a part: everything it draws (`ink`, `shellMetrics`'), else, for a part built without, its box.
	const seen = (p) => (p.ink !== undefined ? p.ink : shownBox(p));
	const meet = (pair, kind, a, b) => {
		const sa = seen(a);
		const sb = sa && seen(b);
		const x = sb && intersect(sa, sb);
		if (x && x.right - x.left > slack && x.bottom - x.top > slack) overlaps.push({ pair, kind, a, b, x: x.right - x.left, y: x.bottom - x.top });
	};
	for (const [ni, nav] of (bar.nav ?? []).entries()) for (const [oi, other] of others.entries()) meet(`n${ni} o${oi}`, "nav", nav, other);
	for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) meet(`o${i} o${j}`, "bar", others[i], others[j]);
	const hidden = [];
	if (width > PHONE_MAX) {
		for (const [index, part] of (bar.nav ?? []).entries()) {
			const cut = navCut(part, width, slack);
			if (cut) hidden.push({ index, part, ...cut });
		}
	}
	return { ok: problems.length === 0 && overlaps.length === 0 && hidden.length === 0, problems, overlaps, hidden };
}

/** What a read of the bar varies, in the order `barSource` nests them (outermost last): each is null where a page has none. */
const READ_DIMS = Object.freeze(["live", "theme", "parked"]);

/** A read's Parked count in a sentence: `parked` is the count's text, "" for none drawn. */
const parkedSaid = (parked) => (parked === "" ? "no Parked count" : `the Parked count at ${parked}`);

/** The other states of a read (`b`) than `except`'s, as a parenthesis for a sentence about that one; "" when it has none. */
function readContext(b, except) {
	const said = [];
	if (except !== "live" && b.live !== null && b.live !== undefined) said.push(`live pill reading ${b.live}`);
	if (except !== "theme" && b.theme !== null && b.theme !== undefined) said.push(`theme button ${b.theme}`);
	if (except !== "parked" && b.parked !== null && b.parked !== undefined) said.push(parkedSaid(b.parked));
	return said.length === 0 ? "" : ` (${said.join(", ")})`;
}

/**
 * The largest change of height along `dim` among `bars` that agree on every other read dimension: `{ hi, lo }` (the
 * first tallest and the first shortest of that group), or null when no group changes by more than `slack`.
 */
function largestJump(bars, dim, slack) {
	const groups = new Map();
	for (const b of bars) {
		const key = JSON.stringify(READ_DIMS.filter((d) => d !== dim).map((d) => b[d] ?? null));
		groups.set(key, [...(groups.get(key) ?? []), b]);
	}
	let best = null;
	for (const group of groups.values()) {
		const hi = group.reduce((m, b) => (b.height > m.height ? b : m));
		const lo = group.reduce((m, b) => (b.height < m.height ? b : m));
		if (hi.height - lo.height > slack && (best === null || hi.height - lo.height > best.hi.height - best.lo.height)) best = { hi, lo };
	}
	return best;
}

/**
 * The bar's height across the reads of one window (`bars`, each `{ live, theme, parked, height }`), as failure sentences,
 * at every width: it may not change with the live pill's word, with the theme button shown or hidden, nor with the
 * Parked count, each with everything else held, since the script changes all three after the page is drawn (the word
 * on the first load too: the server draws Not live, the stream makes it Live) and a bar that changes height moves the
 * whole page under the reader. Each is told once, where its jump is largest.
 */
export function heightProblems(bars, slack = EDGE_SLACK) {
	const out = [];
	const word = largestJump(bars, "live", slack);
	if (word) out.push(`the top bar is ${px(word.hi.height)} tall with the live pill reading ${word.hi.live} and ${px(word.lo.height)} with it reading ${word.lo.live}${readContext(word.hi, "live")}: it jumps when the live word changes`);
	const theme = largestJump(bars, "theme", slack);
	if (theme) {
		const [shown, hidden] = theme.hi.theme === "shown" ? [theme.hi, theme.lo] : [theme.lo, theme.hi];
		out.push(`the top bar is ${px(shown.height)} tall with the theme button shown and ${px(hidden.height)} with it hidden${readContext(shown, "theme")}: it jumps when the script reveals the button`);
	}
	const parked = largestJump(bars, "parked", slack);
	if (parked) out.push(`the top bar is ${px(parked.hi.height)} tall with ${parkedSaid(parked.hi.parked)} and ${px(parked.lo.height)} with ${parkedSaid(parked.lo.parked)}${readContext(parked.hi, "parked")}: it jumps when the Parked count changes`);
	return out;
}

/**
 * The page's width in each read of the bar (`bars`' `scrollWidth`) against the window's `width`, as one sentence where
 * any read scrolls sideways (the widest named): the width rule's collector reads the page once, as the script left it,
 * and a live word, the theme button or a count can widen it after.
 */
export function readWidthProblems(bars, width) {
	const wide = bars.filter((b) => typeof b.scrollWidth === "number" && b.scrollWidth > width);
	if (wide.length === 0) return [];
	const widest = wide.reduce((m, b) => (b.scrollWidth > m.scrollWidth ? b : m));
	return [`the page is ${widest.scrollWidth} px wide at a ${width} px viewport${readsNote(wide, bars) || " in every read of the bar"}: it scrolls sideways`];
}

/**
 * Whether the bar was read with every live word (`states`, LIVE_STATES' distinct ones): a read that skips one holds
 * none of the rules there. A page with no live pill is read with none, which is no failure.
 */
export function liveReadProblems(bars, states) {
	const read = new Set(bars.map((b) => b.live).filter((w) => w !== null && w !== undefined));
	if (read.size === 0) return [];
	const missing = states.map((s) => s.word).filter((w) => !read.has(w));
	return missing.length === 0 ? [] : [`the bar was never read with the live pill reading ${missing.join(", ")}, so no rule was held there`];
}

/**
 * Whether a bar with a Parked count was read with each of `counts`' (`parkedCounts`): as drawn, emptied and wide. A
 * page with no count panel is read with none, which is no failure. A read counts for the count its panel SHOWED
 * (`parkedText`, `barSource`'s read-back: the count in its text, or no text for none), not the one it was labelled
 * with: a read whose panel showed something else is told apart, and is no read with its label's count. A read with no
 * text recorded (a constructed one) is taken at its label.
 */
export function parkedReadProblems(bars, counts = parkedCounts()) {
	const labelled = bars.filter((b) => b.parked !== null && b.parked !== undefined);
	if (labelled.length === 0) return [];
	const showed = (b) => b.parkedText === null || b.parkedText === undefined || (b.parked === "" ? b.parkedText.trim() === "" : b.parkedText.includes(b.parked));
	const out = [];
	const wrong = labelled.filter((b) => !showed(b));
	if (wrong.length > 0) out.push(`the bar was read as ${parkedSaid(wrong[0].parked)} while its Parked panel read ${JSON.stringify(wrong[0].parkedText)}${wrong.length > 1 ? ` (and ${wrong.length - 1} more reads like it)` : ""}, so no rule was held at that count`);
	const read = new Set(labelled.filter(showed).map((b) => b.parked));
	const missing = [counts.drawn, "", counts.wide].filter((p) => !read.has(p));
	if (missing.length > 0) out.push(`the bar was never read with ${missing.map(parkedSaid).join(", ")}, so no rule was held there`);
	return out;
}

/**
 * The one-row rule (`bars`, `shellMetrics`'; `width` the window's, `readOnly` the console's): from `ONE_ROW_WIDTH` a
 * console that is not read-only draws the pi-dispatch pill, the navigation and the rest on one row, as the Shell card
 * does at its own width, so every part that shows meets the pi-dispatch pill's row. Told once, at the first part off it.
 */
export function oneRowProblems(bars, { width, readOnly = false, slack = EDGE_SLACK } = {}) {
	if (readOnly || width < ONE_ROW_WIDTH) return [];
	const off = [];
	for (const bar of bars) {
		const brand = bar.brand ? shownBox(bar.brand) : null;
		const part = brand ? [...(bar.nav ?? []), ...(bar.end ?? [])].find((p) => {
			const s = shownBox(p);
			return s && !(s.top < brand.bottom - slack && s.bottom > brand.top + slack);
		}) : null;
		if (!brand || part) off.push({ bar, part });
	}
	if (off.length === 0) return [];
	const note = readsNote(off.map((o) => o.bar), bars);
	if (!off[0].part) return [`the top bar shows no pi-dispatch pill to hold its one row to${note}`];
	return [`the top bar is not one row at ${width} px, as the Shell card draws it from ${ONE_ROW_WIDTH} px: ${partName(off[0].part)} is off the pi-dispatch pill's row${note}`];
}

/**
 * The rule for who is signed in, over one of its two words (`measure`, `shellMetrics`' `name` or `roleWord`: `{ text,
 * title, scrollWidth, clientWidth, textOverflow, overflowX, part }`; `what` "name" or "role"), as failure sentences;
 * nothing where the bar does not show it (a phone shows the avatar alone). A word cut off must end in an ellipsis, and
 * the tooltip a reader gets there (`title`: the nearest `title` from the word up through the `.who` block, which the
 * collector reads) must hold it whole, so a reader can still learn who is signed in and as what; and the longest name a
 * token can have (`mustCut`) must be cut off, because the bar's layout is chosen for a name of bounded width and an
 * uncapped one would break it at some width the sweep does not load.
 */
export function nameProblems(measure, { mustCut = false, what = "name" } = {}) {
	if (!measure || !measure.part || !shownBox(measure.part)) return [];
	if (!(measure.scrollWidth > measure.clientWidth)) return mustCut ? [`the longest name a token can have (${String(measure.text).length} characters) is not cut off: its ${measure.scrollWidth} px of text fit its box, so the name's width has no cap`] : [];
	const out = [];
	if (measure.textOverflow !== "ellipsis" || measure.overflowX === "visible") out.push(`the signed-in ${what} is cut off without an ellipsis (text-overflow: ${measure.textOverflow}, overflow-x: ${measure.overflowX})`);
	if (measure.title === null || measure.title === undefined) out.push(`the signed-in ${what} is cut off and has no title holding it whole`);
	else if (!String(measure.title).includes(String(measure.text))) out.push(`the signed-in ${what} is cut off and its title ${JSON.stringify(measure.title)} does not hold it`);
	return out;
}

/**
 * The More menu's rule, over the measure taken right after a click on its button (`{ opened, summary, menu, width,
 * height }`, `width` and `height` the layout viewport's; null where the page has no More, a viewer's): the click opened
 * it (else nothing more is judged: a shut menu has no list to place); its button shows whole, focus ring included,
 * since opening it brings a button cut at the navigation's edge into view; its menu shows whole (no overflow box cuts
 * it), inside the viewport, covers no part of its own button, and, where the button shows, opens under it: right edges
 * within `MORE_ALIGN` px and its top `MORE_GAP` px below the button's bottom.
 */
export function moreVerdict(more, slack = EDGE_SLACK) {
	if (more === null) return { ok: true, problems: [] };
	if (!more.opened) return { ok: false, problems: ["a click on More did not open its menu"] };
	const problems = [];
	const cut = more.summary ? navCut(more.summary, more.width, slack) : null;
	if (cut) {
		const size = (b) => `${(b.right - b.left).toFixed(1)} x ${(b.bottom - b.top).toFixed(1)} px`;
		problems.push(cut.shown === null ? "the More menu opened with its button out of view" : `the More menu opened with its button cut off: ${size(cut.shown)} of its ${size(cut.ring)} show, focus ring included`);
	}
	const shown = more.menu ? shownBox(more.menu) : null;
	if (!shown) problems.push("the open More menu shows nothing");
	else {
		const r = more.menu.rect;
		const cut = ["left", "top", "right", "bottom"].filter((side) => Math.abs(shown[side] - r[side]) > slack);
		if (cut.length > 0) problems.push(`the open More menu is cut off at its ${cut.join(", ")} by an overflow box around it`);
		if (r.left < -slack) problems.push(`the open More menu starts ${px(-r.left)} left of the viewport`);
		if (r.top < -slack) problems.push(`the open More menu starts ${px(-r.top)} above the viewport`);
		if (r.right > more.width + slack) problems.push(`the open More menu ends ${px(r.right - more.width)} past the right edge (at ${px(r.right)} of ${more.width})`);
		if (r.bottom > more.height + slack) problems.push(`the open More menu ends ${px(r.bottom - more.height)} below the viewport`);
		const button = more.summary ? shownBox(more.summary) : null;
		const x = button && intersect(shown, button);
		if (x && x.right - x.left > slack && x.bottom - x.top > slack) problems.push(`the open More menu covers its own button by ${px(x.right - x.left)} x ${px(x.bottom - x.top)}`);
		if (button) {
			const s = more.summary.rect;
			const dx = r.right - s.right;
			if (Math.abs(dx) > MORE_ALIGN) problems.push(`the open More menu's right edge is ${px(Math.abs(dx))} ${dx < 0 ? "left" : "right"} of its button's (it opens under its button, right edges aligned)`);
			const gap = r.top - s.bottom;
			if (gap < MORE_GAP[0] || gap > MORE_GAP[1]) problems.push(`the open More menu starts ${gap < 0 ? `${px(-gap)} above` : `${px(gap)} below`} its button's bottom, not ${MORE_GAP[0]} to ${MORE_GAP[1]} px below it`);
		}
	}
	return { ok: problems.length === 0, problems };
}

/**
 * Whether the window was what the run asked DevTools for (`emulation`, the probe's `{ dpr, mobile, probed }`; `mobile`
 * the run's), as failure sentences: a phone's emulation honours a viewport meta and a desktop's ignores it, so the probe
 * reads which one the browser applied instead of trusting the call that set it. A probe that never ran is a failure.
 */
export function emulationProblems(emulation, mobile) {
	if (!emulation) return ["the emulation probe never ran, so whether the window was a phone's is unknown"];
	const out = [];
	if (emulation.mobile === null) out.push("the page has no viewport meta, so the emulation probe could not tell a phone's window from a desktop's");
	else if (emulation.mobile !== mobile) out.push(`the window was meant to be ${mobile ? "a phone's" : "a desktop's"}, but DevTools ${mobile ? "did not emulate" : "emulated"} a phone (a viewport meta asking for ${PROBE_WIDTH} px laid the page out ${emulation.probed} px wide)`);
	const scale = mobile ? VIEWPORT.scale : DESKTOP.scale;
	if (emulation.dpr !== scale) out.push(`the device scale is ${emulation.dpr}, not ${scale}`);
	return out;
}

/** The CSP probe's read-back as failure sentences: none seen is none; a probe that never ran is a failure itself. */
function cspFailures(csp) {
	if (csp === null || csp === undefined) return ["the CSP probe never ran, so no violation could have been seen"];
	return csp.map((v) => `CSP violation: ${v.directive} refused ${v.blocked || "an inline resource"}${v.source ? ` (${v.source}:${v.line})` : ""}${v.sample ? ` "${v.sample}"` : ""}`);
}

/** Progress and every drawn phase must fit its cell and leave the action clear, even when the viewport itself fits. */
export function activeProgressProblems(rows = [], slack = EDGE_SLACK) {
	const problems = [];
	for (const row of rows) for (const part of row.parts ?? []) {
		const r = part.rect;
		const c = row.cell;
		if (r.left < c.left - slack || r.right > c.right + slack || r.top < c.top - slack || r.bottom > c.bottom + slack) problems.push(`Fleet Active row ${row.row}: ${part.name} leaves its progress cell`);
		if (part.clipped) problems.push(`Fleet Active row ${row.row}: ${part.name} clips its progress content`);
		const a = row.action;
		if (a && Math.min(r.right, a.right) - Math.max(r.left, a.left) > slack && Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top) > slack) problems.push(`Fleet Active row ${row.row}: ${part.name} overlaps its action`);
	}
	return [...new Set(problems)];
}

/**
 * One golden run's verdict over what the page reported: `csp` (the probe's violations, null when it never ran),
 * `errors` (uncaught page errors: notes, since the script ran into the stubs), `canvas` (the computed `--canvas`) against
 * `want` (the `expect` theme's), `measured` (the width collector's), `emulation` (the probe's: a golden's window is
 * always a phone's) and `settled`. Returns `{ failures, notes, width }`.
 */
export function runVerdict({ csp, errors = [], canvas, want, expect, measured, emulation, settled = true }) {
	const failures = [...cspFailures(csp), ...emulationProblems(emulation, true), ...activeProgressProblems(measured.activeProgress)];
	const notes = [];
	if (!settled) notes.push("the page did not settle within 1.5 s (fonts or frames); measured anyway");
	for (const e of errors) notes.push(`page error: ${e}`);
	const got = String(canvas ?? "").trim().toLowerCase();
	const wanted = String(want).toLowerCase();
	if (got !== wanted) failures.push(`--canvas is ${got ? JSON.stringify(got) : "unset"}, not the ${expect} theme's ${wanted}`);
	if (measured.clientWidth !== VIEWPORT.width) notes.push(`the layout viewport is ${measured.clientWidth} px, not ${VIEWPORT.width}`);
	return { failures, notes, width: widthVerdict(measured) };
}

/**
 * Which reads a problem was seen in (`reads`, of `all`, each `{ live, theme, parked }`), as a note for its sentence:
 * nothing when it was seen in every read. Where the reads it was seen in are every combination of some theme button
 * states, some Parked counts and some live words, the note names each of those that is not all of them; otherwise it
 * names, per theme button state and Parked count it was seen with, the live words, unless it was seen with every word
 * there. (A page with no live pill has one read per state, so it never lists a word.)
 */
export function readsNote(reads, all) {
	if (reads.length === all.length) return "";
	const valuesOf = (list, d) => [...new Set(list.map((b) => b[d] ?? null))];
	const said = { live: (v) => `live pill: ${v.join(", ")}`, theme: (v) => `theme button ${v.join(", ")}`, parked: (v) => v.map(parkedSaid).join(", ") };
	const hit = Object.fromEntries(READ_DIMS.map((d) => [d, valuesOf(reads, d)]));
	const has = (b) => reads.includes(b);
	const product = all.every((b) => has(b) === READ_DIMS.every((d) => hit[d].includes(b[d] ?? null)));
	if (product) {
		const parts = ["theme", "parked", "live"].filter((d) => hit[d].length < valuesOf(all, d).length).map((d) => said[d](hit[d]));
		return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
	}
	const groups = new Map();
	for (const b of all) {
		const key = JSON.stringify([b.theme ?? null, b.parked ?? null]);
		groups.set(key, [...(groups.get(key) ?? []), b]);
	}
	const parts = [...groups.values()].flatMap((group) => {
		const seen = group.filter(has);
		if (seen.length === 0) return [];
		const { theme = null, parked = null } = group[0];
		const where = [theme === null ? null : `theme button ${theme}`, parked === null ? null : parkedSaid(parked)].filter(Boolean);
		if (seen.length < group.length) where.push(said.live(seen.map((b) => b.live)));
		return [where.join(", ")];
	});
	return ` (${parts.join("; ")})`;
}

/**
 * One shell run's verdict: the CSP, the window's emulation (`emulation`, against `mobile`), the width rule at the
 * window's width (`measureSource` says why not `clientWidth`), and the bar from `metrics` (`shellMetrics`'): at each
 * read (each live word, with the theme button shown and hidden, with each Parked count), the page's width, its parts'
 * overlaps, each pair told once with its widest overlap (widest first), and above `PHONE_MAX` every navigation item
 * shown whole, each told once where least of it showed; at every width the bar's height unchanged across the reads;
 * every live word of `liveStates` read; from `ONE_ROW_WIDTH` one row unless `readOnly`; the signed-in name and role
 * word (`longest` for the longest name); and the More menu. Returns `{ failures, notes, overlaps }`, `overlaps` the
 * pairs as `{ a, b, x, y }` (names and px).
 */
export function shellVerdict({ width, mobile = width <= VIEWPORT.width, csp, errors = [], measured, metrics, emulation, longest = false, readOnly = false, liveStates = [], settled = true }) {
	const failures = [...cspFailures(csp), ...emulationProblems(emulation, mobile)];
	const notes = [];
	if (!settled) notes.push("the page did not settle within 1.5 s (fonts or frames); measured anyway");
	for (const e of errors) notes.push(`page error: ${e}`);
	if (measured.clientWidth !== width) notes.push(`the layout viewport is ${measured.clientWidth} px, not ${width}`);
	const w = widthVerdict(measured, width);
	if (!w.ok) failures.push(...widthLines(w));
	const bars = metrics?.bars;
	if (!Array.isArray(bars) || bars.length === 0) failures.push("the page has no top bar (header.top)");
	// The width rule above said it already where the page was wide as the script left it.
	else if (!w.wide) failures.push(...readWidthProblems(bars, width));
	const problems = new Set();
	const pairs = new Map();
	const cuts = new Map();
	const area = (b) => (b ? (b.right - b.left) * (b.bottom - b.top) : 0);
	for (const bar of bars ?? []) {
		const v = barVerdict(bar, { width });
		for (const p of v.problems) problems.add(p);
		// One pair of elements, whatever the live pill read: named as it was where the overlap was widest.
		for (const o of v.overlaps) {
			const seen = pairs.get(o.pair) ?? { kind: o.kind, a: o.a, b: o.b, x: 0, y: 0, reads: [] };
			if (o.x > seen.x) Object.assign(seen, { a: o.a, b: o.b, x: o.x });
			seen.y = Math.max(seen.y, o.y);
			seen.reads.push(bar);
			pairs.set(o.pair, seen);
		}
		// One pill, told where the least of it showed.
		for (const h of v.hidden) {
			const seen = cuts.get(h.index) ?? { ...h, reads: [] };
			if (area(h.shown) < area(seen.shown)) Object.assign(seen, { part: h.part, shown: h.shown, ring: h.ring });
			seen.reads.push(bar);
			cuts.set(h.index, seen);
		}
	}
	failures.push(...problems);
	const OVERLAPS_SHOWN = 8;
	const overlaps = [...pairs.values()].sort((a, b) => b.x - a.x);
	for (const o of overlaps.slice(0, OVERLAPS_SHOWN)) failures.push(`${o.kind === "nav" ? "the navigation's" : "the top bar's"} ${partName(o.a)} overlaps ${partName(o.b)} by ${o.x.toFixed(1)} x ${o.y.toFixed(1)} px${readsNote(o.reads, bars)}`);
	if (overlaps.length > OVERLAPS_SHOWN) failures.push(`${overlaps.length - OVERLAPS_SHOWN} more overlaps in the top bar`);
	for (const c of [...cuts.values()].sort((a, b) => a.index - b.index)) {
		const size = (b) => `${(b.right - b.left).toFixed(1)} x ${(b.bottom - b.top).toFixed(1)} px`;
		const what = c.shown === null ? "is hidden: none of it shows" : `is cut off: ${size(c.shown)} of its ${size(c.ring)} show, focus ring included`;
		failures.push(`the navigation's ${partName(c.part)} ${what}${readsNote(c.reads, bars)}`);
	}
	// At every width, a phone's too: round 3 measured a phone's bar 52 px taller while the server's Not live stood, so the
	// first load moved the page.
	if (Array.isArray(bars) && bars.length > 0) {
		failures.push(...heightProblems(bars), ...liveReadProblems(bars, liveStates), ...parkedReadProblems(bars), ...oneRowProblems(bars, { width, readOnly }));
		if (metrics?.widened === false) failures.push(`the Parked count could not be widened: its panel never read ${parkedCounts().drawn}, so the bar was not read with ${parkedCounts().wide}`);
	}
	failures.push(...nameProblems(metrics?.name ?? null, { mustCut: longest }), ...nameProblems(metrics?.roleWord ?? null, { what: "role" }));
	failures.push(...moreVerdict(metrics?.more ?? null).problems);
	if (metrics?.more?.opened !== undefined && metrics.more.cutFirst === false) notes.push("More's button could not be cut at the navigation's edge before the click (the row does not scroll that far), so the click found it whole");
	return { failures, notes, overlaps: overlaps.map((o) => ({ a: partName(o.a), b: partName(o.b), x: o.x, y: o.y })) };
}

/**
 * A shell run's verdict from what its page reported (`got`: `csp`, `errors`, `measured`, `bar`, `more`,
 * `emulation`, `settled`), the run it was (`run`: its `width`, `mobile`, and its doc's `longest` and `readOnly`) and
 * the live words the bar must have been read with (`liveStates`): the glue `checkShell` runs, kept here so a test holds
 * what it hands `shellVerdict`.
 */
export function shellRunVerdict(run, got, liveStates = []) {
	const { csp, errors, measured, bar = null, more = null, emulation, settled } = got;
	return shellVerdict({ width: run.width, mobile: run.mobile, csp, errors, measured, metrics: shellMetrics({ bar, more }), emulation, longest: run.doc.longest === true, readOnly: run.doc.readOnly === true, liveStates, settled });
}

/**
 * The run with page scripts off (`NO_SCRIPT`): the window's emulation, the width rule, and More opened by a real
 * mouse click, which the CSS alone must place under its button (`moreVerdict`). No CSP read: the probe is a script, and
 * the same page is held to the CSP with its script in the sweep. `themeHidden` is the theme button's `hidden` as the
 * page held it after load (`THEME_HIDDEN_READ`): the script reveals it on every page that can be re-themed, so only a
 * page whose script never ran still holds it hidden, and anything else means this run proved nothing about the CSS.
 * Returns `{ failures, notes }`.
 */
export function noScriptVerdict({ width, measured, more, emulation, themeHidden }) {
	const failures = [...emulationProblems(emulation, false)];
	if (themeHidden === null || themeHidden === undefined) failures.push("the page has no theme button ([data-theme-toggle]), so nothing shows its script stayed off");
	else if (themeHidden !== true) failures.push("the theme button was shown, so the page's script ran: this run must be made with page scripts off (Emulation.setScriptExecutionDisabled)");
	const notes = [];
	if (measured.clientWidth !== width) notes.push(`the layout viewport is ${measured.clientWidth} px, not ${width}`);
	const w = widthVerdict(measured, width);
	if (!w.ok) failures.push(...widthLines(w));
	if (more === null) failures.push("the page has no More menu to open without its script");
	else failures.push(...moreVerdict(shellMetrics({ more }).more).problems);
	return { failures, notes };
}

/**
 * The ratchet over the pages' width results (`widthFailed`: page name to the number of its runs that failed the width
 * rule). Returns the failures it adds (a pending page that now fits, an unknown or doubled entry) and the notes it
 * prints for a pending page still failing; `exempt` is the set whose width failures do not fail the run.
 */
export function ratchetVerdict({ pending, widthFailed, pages }) {
	const failures = [];
	const notes = [];
	const seen = new Set();
	for (const name of pending) {
		if (seen.has(name)) failures.push(`WIDTH_PENDING lists ${name} twice`);
		seen.add(name);
		if (!pages.includes(name)) failures.push(`WIDTH_PENDING lists ${name}, which is not a page this check loads`);
		else if ((widthFailed.get(name) ?? 0) === 0) failures.push(`${name} now fits at ${VIEWPORT.width} px in every run: remove it from WIDTH_PENDING (the list only shrinks)`);
		else notes.push(`${name} is in WIDTH_PENDING: ${widthFailed.get(name)} of its runs still overflow`);
	}
	return { failures, notes, exempt: seen };
}

/** One element as a reader finds it in the page: `<tag id="..." class="...">`, and the nearest id around it. */
export function describe({ tag, id, cls, inside = "" }) {
	return `<${tag}${id ? ` id="${id}"` : ""}${cls ? ` class="${cls}"` : ""}>${inside ? ` in #${inside}` : ""}`;
}

/** One line per width failure: the page's width, then each root offender with its box. */
export function widthLines(v) {
	const width = v.width ?? VIEWPORT.width;
	const out = [];
	if (v.wide) out.push(`the page is ${v.scrollWidth} px wide at a ${width} px viewport`);
	if (v.offenders === 0) out.push("no element's box ends past the edge: text running out of its box (a word that cannot wrap), a margin, a pseudo-element or a transform widens the page");
	for (const r of v.roots) out.push(`${describe(r)} ends at ${r.rect.right.toFixed(1)} px (left ${r.rect.left.toFixed(1)}), outside any scroll box that fits`);
	if (v.offenders > v.roots.length) out.push(`${v.offenders} elements past the edge in all`);
	if (v.font) out.push(`font: ${v.font}`);
	return out;
}

/**
 * THE FIRST NEGATIVE CONTROL: a top bar built to break nine named rules once each (the nine sentences of `controlDoc`'s
 * `expected`), served and measured in every run exactly as a shell page is (`checkShell`, at `CONTROL_WIDTH`), whose
 * verdict must be exactly those nine. A check whose measure has gone blind to one of them (the live words never set, a
 * clip dropped, only the first pill read, a height never compared, the menu never opened) would pass every real page
 * and say nothing; against the control it fails the run. It proves those nine and no other rule.
 * Every size is a fixed px box with its text clipped, so no font on any platform moves a number; the jump keys off the
 * Reconnecting state's own classes (`LIVE_STATES.retry`, `controlCss`), so the control follows the shell's names.
 * Coordinates in the window (page padding 12): the navigation is a box that clips (138 to 642 by 8 to 128) holding
 * Overview, Runs, More, Parked, Spend (484 to 584) and Fleet (662, outside it); the live pill (524 to 624) runs 60 px
 * under Spend; the read-only chip (718 to 848) runs 20 px under the name (828 to 958), whose text is clipped without
 * an ellipsis or a title; More's list opens 24 px left of its button's right edge and runs 18 px past the bottom of the
 * navigation's box; the bar is 48 px tall, 60 px taller while Reconnecting and 24 px taller with the theme button hidden.
 */
export function controlHtml(first) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Width check: negative control</title><link rel="stylesheet" href="${CONTROL_PATH}.css"></head>
<body data-page="control"><div class="page"><header class="top"><a class="brandpill" href="#c">pi-dispatch</a><nav class="pillnav" aria-label="Console screens"><a href="#c">Overview</a><a href="#c">Runs</a><details class="more"><summary aria-label="More: Audit">More</summary><div><a href="#c">Audit</a></div></details><a href="#c">Parked</a><a href="#c">Spend</a><a href="#c">Fleet</a></nav><div class="top__end"><span id="live-status" class="${first.cls}"><span data-live-word>${first.word}</span></span><button class="roundbtn" type="button" data-theme-toggle aria-label="Theme">T</button><span class="chip">Read-only console</span><span class="who"><span><b>${CONTROL_NAME}</b></span></span><button id="logout" class="roundbtn" type="button" aria-label="Sign out">S</button></div></header><main id="c"><h1>A top bar built to fail</h1></main></div></body></html>
`;
}

const CONTROL_NAME = "m".repeat(32);

/** The control's stylesheet (see `controlHtml`); `retryCls` is the Reconnecting state's class list, `LIVE_STATES.retry.cls`. */
export function controlCss(retryCls) {
	const classes = String(retryCls).split(" ").filter(Boolean);
	if (classes.length === 0 || !classes.every((c) => /^[a-z][a-z0-9-]*$/.test(c))) throw new Error(`the Reconnecting state's classes ${JSON.stringify(retryCls)} are not plain class names`);
	return [
		"*{box-sizing:border-box}",
		"[hidden]{display:none!important}",
		"html,body{margin:0}",
		"body{background:#fff;color:#000;font:13px/16px sans-serif}",
		".page{padding:12px}",
		".top{position:relative;box-sizing:content-box;width:1000px;height:48px}",
		`.top:has(#live-status.${classes.join(".")}){padding-bottom:60px}`,
		".top:has([data-theme-toggle][hidden]){padding-top:24px}",
		".top>*,.pillnav>*,.top__end>*{position:absolute;top:0;height:48px;margin:0;padding:0;border:0;overflow:hidden;white-space:nowrap}",
		".brandpill{left:0;width:120px}",
		".pillnav{left:126px;top:-4px;width:504px;height:120px}",
		".pillnav>*{top:4px;width:90px}",
		".pillnav>:nth-child(1){left:4px}",
		".pillnav>:nth-child(2){left:100px}",
		".pillnav>.more{left:196px;width:48px;overflow:visible}",
		".pillnav>:nth-child(4){left:250px}",
		".pillnav>:nth-child(5){left:346px;width:100px}",
		".pillnav>:nth-child(6){left:524px}",
		".more>summary{display:block;height:48px;list-style:none;overflow:hidden}",
		".more>div{position:absolute;top:54px;right:24px;width:160px;height:80px}",
		".top__end{left:650px;width:350px;overflow:visible}",
		"#live-status{left:-138px;width:100px}",
		".top__end>.roundbtn{width:48px}",
		"[data-theme-toggle]{left:0}",
		".chip{left:56px;width:130px}",
		".who{left:166px;width:130px}",
		".who b{display:block;width:100px;overflow:hidden;text-overflow:clip}",
		"#logout{left:302px}",
		"main{margin-top:200px}",
	].join("\n");
}

/**
 * The control as a doc `checkPages` serves and `checkShell` measures, and the verdict it must get: `liveStates` the
 * live pill's distinct `{ cls, word }` (the order the bar is read in), `retry` the Reconnecting one among them.
 */
export function controlDoc(liveStates, retry) {
	const first = liveStates[0];
	if (!first || !liveStates.some((s) => s.cls === retry?.cls && s.word === retry?.word)) throw new Error("the negative control needs the live states with the Reconnecting one among them");
	const steady = liveStates.find((s) => s.cls !== retry.cls);
	if (!steady) throw new Error("the negative control needs a live state besides Reconnecting");
	const expected = [
		`the navigation's <a> "Spend" overlaps <span id="live-status" class="${first.cls}"> "${first.word}" by 60.0 x 48.0 px`,
		`the top bar's <span class="chip"> "Read-only console" overlaps <span class="who"> "${CONTROL_NAME}" by 20.0 x 48.0 px`,
		`the navigation's <a> "Fleet" is hidden: none of it shows`,
		`the top bar is 108.0 px tall with the live pill reading ${retry.word} and 48.0 px with it reading ${steady.word} (theme button shown): it jumps when the live word changes`,
		`the top bar is 48.0 px tall with the theme button shown and 72.0 px with it hidden (live pill reading ${first.word}): it jumps when the script reveals the button`,
		"the signed-in name is cut off without an ellipsis (text-overflow: clip, overflow-x: hidden)",
		"the signed-in name is cut off and has no title holding it whole",
		"the open More menu is cut off at its bottom by an overflow box around it",
		"the open More menu's right edge is 24.0 px left of its button's (it opens under its button, right edges aligned)",
	];
	return { id: "control", name: "the negative control", what: "a top bar built to break nine of the bar's rules", width: CONTROL_WIDTH, mobile: false, file: null, path: CONTROL_PATH, page: "control", role: "negative control", longest: true, html: controlHtml(first), css: controlCss(retry.cls), js: null, expected };
}

/**
 * THE PHONE'S NEGATIVE CONTROL, at `PHONE_CONTROL_WIDTH` as a phone: a bar of fixed px boxes built to fail four
 * sentences, the two rules round 3 found broken on a phone while every desktop rule held and the two reads this round
 * added. Its bar is 40 px taller while the live pill reads the LAST of the live words (keyed on its exact class list,
 * `phoneControlCss`; the last whose class list no other word shares, should two share one, which `liveStateProblems`
 * fails), so the height rule must be judged on a phone and with every word read; 20 px taller, and its page 432 px
 * wide, while its Parked count is emptied, so the read must vary the count and take the page's width in each read;
 * and its own script (`PHONE_CONTROL_JS`) shuts More in the task that opened it whenever its button is not wholly
 * inside the navigation's box, as round 3's script did, so the click must come with the button cut at the row's edge,
 * never scrolled into view first. Coordinates in the window (page padding 12): the pi-dispatch pill 12 to 112 and the
 * end 122 to 363 on the first row (12 to 60), the navigation a scroll box 12 to 363 on the second (68 to 116) holding
 * six 90 px pills, the Parked count inside the third, and More (48 px) after them.
 */
export function phoneControlHtml(first) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Width check: the phone's negative control</title><link rel="stylesheet" href="${PHONE_CONTROL_PATH}.css"><script src="${PHONE_CONTROL_PATH}.js" defer></script></head>
<body data-page="control-phone"><div class="page"><header class="top"><a class="brandpill" href="#c">pi-dispatch</a><nav class="pillnav" aria-label="Console screens"><a href="#c">Overview</a><a href="#c">Runs</a><a href="#c">Parked<span id="p-nav-parked" data-panel><span class="count">${parkedCounts().drawn}</span></span></a><a href="#c">Fleet</a><a href="#c">Spend</a><a href="#c">Config</a><details class="more"><summary aria-label="More: Audit">M</summary><div><a href="#c">Audit</a></div></details></nav><div class="top__end"><span id="live-status" class="${first.cls}"><span data-live-word>${first.word}</span></span><button class="roundbtn" type="button" data-theme-toggle aria-label="Theme">T</button><button id="logout" class="roundbtn" type="button" aria-label="Sign out">S</button></div></header><main id="c"><h1>A phone's top bar built to fail</h1></main></div></body></html>
`;
}

/** The phone control's stylesheet (see `phoneControlHtml`); `keyCls` is the class list of the state its bar jumps with. */
export function phoneControlCss(keyCls) {
	if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(String(keyCls))) throw new Error(`the live state's classes ${JSON.stringify(keyCls)} are not plain class names`);
	return [
		"*{box-sizing:border-box}",
		"[hidden]{display:none!important}",
		"html,body{margin:0}",
		"body{background:#fff;color:#000;font:13px/16px sans-serif}",
		".page{padding:12px}",
		".top{position:relative;box-sizing:content-box;width:351px;height:104px}",
		`.top:has(#live-status[class="${keyCls}"]){padding-bottom:40px}`,
		".top:has(#p-nav-parked:empty){padding-top:20px}",
		"body:has(#p-nav-parked:empty) main{width:420px}",
		".top>*,.top__end>*{position:absolute;top:0;height:48px;margin:0;padding:0;border:0;overflow:hidden;white-space:nowrap}",
		".brandpill{left:0;width:100px}",
		".top__end{left:110px;width:241px;overflow:visible}",
		"#live-status{left:0;width:100px}",
		".top__end>.roundbtn{width:48px}",
		"[data-theme-toggle]{left:108px}",
		"#logout{left:193px}",
		".pillnav{left:0;top:56px;width:351px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}",
		".pillnav::-webkit-scrollbar{display:none}",
		".pillnav>*{position:absolute;top:0;width:90px;height:48px;overflow:hidden;white-space:nowrap}",
		".pillnav>:nth-child(1){left:0}",
		".pillnav>:nth-child(2){left:96px}",
		".pillnav>:nth-child(3){left:192px}",
		".pillnav>:nth-child(4){left:288px}",
		".pillnav>:nth-child(5){left:384px}",
		".pillnav>:nth-child(6){left:480px}",
		".pillnav>.more{left:576px;width:48px;overflow:visible}",
		".more>summary{display:block;height:48px;list-style:none;overflow:hidden}",
		".more>div{position:absolute;top:54px;right:0;width:160px;height:80px}",
		"main{margin-top:200px}",
	].join("\n");
}

/**
 * The phone control's script, served as its `.js` under `script-src 'self'`: when More opens with its button not wholly
 * inside the navigation's box, it shuts it again in that same task, as round 3's `placeMore` did on a phone.
 */
export const PHONE_CONTROL_JS = `"use strict";
(function () {
	var more = document.querySelector("details.more");
	var nav = document.querySelector("nav.pillnav");
	if (!more || !nav) return;
	more.addEventListener("toggle", function () {
		if (!more.open) return;
		var b = more.querySelector("summary").getBoundingClientRect();
		var n = nav.getBoundingClientRect();
		if (b.left < n.left || b.right > n.right) more.open = false;
	});
})();
`;

/**
 * The phone control as a doc, and the four sentences it must get: `liveStates` the live pill's distinct `{ cls, word }`
 * in the order the bar is read; the jump is the last state's whose class list is its own.
 */
export function phoneControlDoc(liveStates) {
	const first = liveStates[0];
	const key = [...liveStates].reverse().find((s) => liveStates.filter((o) => o.cls === s.cls).length === 1);
	if (!first || !key || key === first) throw new Error("the phone's negative control needs a live state after the first whose classes are its own");
	const { drawn } = parkedCounts();
	const expected = [
		"the page is 432 px wide at a 375 px viewport (no Parked count): it scrolls sideways",
		`the top bar is 144.0 px tall with the live pill reading ${key.word} and 104.0 px with it reading ${first.word} (theme button shown, the Parked count at ${drawn}): it jumps when the live word changes`,
		`the top bar is 124.0 px tall with no Parked count and 104.0 px with the Parked count at ${drawn} (live pill reading ${first.word}, theme button shown): it jumps when the Parked count changes`,
		"a click on More did not open its menu",
	];
	return { id: "control-phone", name: "the phone's negative control", what: "a phone's top bar built to jump with the last live word and with its Parked count emptied, to scroll sideways while it is emptied, and to shut More when it opens cut", width: PHONE_CONTROL_WIDTH, mobile: true, file: null, path: PHONE_CONTROL_PATH, page: "control-phone", role: "negative control", longest: false, html: phoneControlHtml(first), css: phoneControlCss(key.cls), js: PHONE_CONTROL_JS, expected };
}

/**
 * A control's result against what it was built to get (`got`, its run's failures, null when it never ran; `want`, its
 * doc's `expected`; `name` and `what`, its doc's): `{ ok, problems }`, every expected sentence missing and every other
 * one named, so a measure that went blind and one that sees what is not there both fail the run. A control that never
 * ran is a problem itself.
 */
export function controlVerdict(control) {
	const name = control?.name ?? "the negative control";
	if (!control || control.got === null || control.got === undefined) return { ok: false, problems: [`${name} (${control?.what ?? "a top bar built to break nine of the bar's rules"}) never ran, so a measure blind to what it breaks would pass every page`] };
	const missing = control.want.filter((w) => !control.got.includes(w));
	const extra = control.got.filter((g) => !control.want.includes(g));
	const problems = [...missing.map((w) => `${name} was not failed with: ${w}`), ...extra.map((g) => `${name} failed with what it was not built for: ${g}`)];
	if (problems.length === 0 && JSON.stringify(control.got) !== JSON.stringify(control.want)) problems.push(`${name}'s failures came in another order or count: ${JSON.stringify(control.got)}`);
	return { ok: problems.length === 0, problems };
}

/**
 * Everything the run says and its exit code, from what was checked: `setup` (problems found before the browser ran),
 * `product` and `pin` (`versionCheck`, `ci` whether this is GitHub Actions), `results` (the golden runs), `shell` (the
 * shell sweep's runs and the run without scripts, whose absence is a problem of its own: a check that skipped it would
 * pass every page with the CSS-alone rule never held), `controls` (each negative control's `{ name, what, width, got,
 * want, notes }`, `got` null when it did not run; an empty list is a problem too), `pending` (the ratchet), `pages`
 * (every page name loaded). Returns `{ lines, failedRuns, failures, code }`; nothing here prints.
 */
export function summarize({ setup = [], product, pin, ci, results, shell = [], controls = [], pending = WIDTH_PENDING, pages, seconds = "?" }) {
	const lines = [];
	const failures = [...setup];
	if (!shell.some((r) => String(r?.run?.doc?.id ?? "").endsWith(NO_SCRIPT_SUFFIX))) failures.push("the run without page scripts never ran, so nothing held More's list under its button by CSS alone");
	for (const control of controls.length === 0 ? [null] : controls) {
		const checked = controlVerdict(control);
		if (checked.ok) lines.push(`ok    ${control.name} at ${control.width} px failed as it was built to (${control.want.length} problem${control.want.length === 1 ? "" : "s"})`);
		failures.push(...checked.problems);
		for (const note of control?.notes ?? []) lines.push(`      note: ${control.name}: ${note}`);
	}
	const version = versionCheck({ product, pin, ci });
	if (version.failure) failures.push(version.failure);
	if (version.note) lines.push(`note: ${version.note}`);
	const widthFailed = new Map();
	for (const r of results) if (r.width && !r.width.ok) widthFailed.set(r.run.doc.page, (widthFailed.get(r.run.doc.page) ?? 0) + 1);
	const ratchet = ratchetVerdict({ pending, widthFailed, pages });
	failures.push(...ratchet.failures);
	let failedRuns = 0;
	for (const r of results) {
		const out = [...r.failures];
		const exempt = ratchet.exempt.has(r.run.doc.page);
		if (r.width && !r.width.ok && !exempt) out.push(...widthLines(r.width));
		const head = `${r.run.doc.file ?? r.run.doc.path} (page ${r.run.doc.page}, ${r.run.doc.role}, ${r.run.label})`;
		if (out.length === 0) {
			lines.push(`ok    ${head}${r.width && !r.width.ok ? `, ${r.width.scrollWidth} px wide (WIDTH_PENDING)` : ""}`);
		} else {
			failedRuns++;
			lines.push(`FAIL  ${head}`);
			for (const line of out) lines.push(`::error::${head}: ${line}`);
		}
		for (const note of r.notes) lines.push(`      note: ${note}`);
	}
	// The shell sweep, one line per page and context: its widths when every one held, else each failing width's lines.
	const byDoc = new Map();
	for (const r of shell) byDoc.set(r.run.doc.id, [...(byDoc.get(r.run.doc.id) ?? []), r]);
	for (const runs of byDoc.values()) {
		const doc = runs[0].run.doc;
		const head = `shell ${doc.path} (page ${doc.page}, ${doc.role})`;
		const failing = runs.filter((r) => r.failures.length > 0);
		failedRuns += failing.length;
		if (failing.length === 0) lines.push(`ok    ${head} at ${runs.map((r) => r.run.width).join(", ")} px`);
		else {
			lines.push(`FAIL  ${head} at ${failing.map((r) => r.run.width).join(", ")} px`);
			for (const r of failing) for (const line of r.failures) lines.push(`::error::${head} at ${r.run.width} px: ${line}`);
		}
		for (const r of runs) for (const note of r.notes) lines.push(`      note: ${r.run.width} px: ${note}`);
	}
	for (const note of ratchet.notes) lines.push(`note: ${note}`);
	for (const failure of failures) lines.push(`::error::${failure}`);
	lines.push(`${results.length} runs over ${new Set(results.map((r) => r.run.doc.id)).size} pages and ${shell.length} shell runs over ${byDoc.size} pages, ${failedRuns} failed, ${failures.length} other problems, in ${seconds} s`);
	return { lines, failedRuns, failures, code: failedRuns > 0 || failures.length > 0 ? 1 : 0 };
}

// ---- the page side ----------------------------------------------------------------------------------------------

/**
 * Installed before any page script (`Page.addScriptToEvaluateOnNewDocument`, which the CSP does not govern): every
 * violation of the document's policy, and every uncaught page error (printed as a note: the script ran into the stubs,
 * not necessarily a defect), kept for the read-back after load.
 */
const PROBE = `(() => {
	const seen = [];
	const errors = [];
	Object.defineProperty(window, "__pdCsp", { value: seen });
	Object.defineProperty(window, "__pdErrors", { value: errors });
	document.addEventListener("securitypolicyviolation", (e) => {
		seen.push({ directive: String(e.effectiveDirective || e.violatedDirective || ""), blocked: String(e.blockedURI || ""), source: String(e.sourceFile || ""), line: Number(e.lineNumber) || 0, sample: String(e.sample || "").slice(0, 80) });
	}, true);
	window.addEventListener("error", (e) => { errors.push(String(e.message || e.type).slice(0, 200)); });
	window.addEventListener("unhandledrejection", (e) => { errors.push("unhandled rejection: " + String(e.reason).slice(0, 200)); });
})();`;

/** Fonts loaded, two frames drawn and the script's load-time work done; bounded, since a hidden tab may skip frames. */
const SETTLE = `new Promise((resolve) => {
	const cap = setTimeout(() => resolve(false), 1500);
	document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { clearTimeout(cap); resolve(true); }, 100))));
})`;

const CSP_READ = "JSON.stringify(window.__pdCsp === undefined ? null : window.__pdCsp)";
const ERRORS_READ = "JSON.stringify(window.__pdErrors || [])";

/**
 * The collector `widthVerdict` reads (see there), keeping the elements in `window.__pdWidthKeep` for the font lookup.
 * `width` is the window's, never the page's `clientWidth`: a phone's viewport that a too-wide page zooms out widens
 * with the page (measured: a 2332 px title left nothing past a `clientWidth` edge), so the edge is the one the run set.
 */
function measureSource(width, slack) {
	return `(() => {
	const W = ${width};
	const S = ${slack};
	const se = document.scrollingElement || document.documentElement;
	const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	const name = (el) => ({ tag: el.tagName.toLowerCase(), id: el.id || "", cls: el.getAttribute("class") || "" });
	const index = new Map();
	const keep = [];
	const elements = [];
	for (const el of document.querySelectorAll("body, body *")) {
		const r = el.getBoundingClientRect();
		if (!(r.width > 0 && r.height > 0 && r.right > W + S)) continue;
		let up = -1;
		for (let a = el.parentElement; a; a = a.parentElement) if (index.has(a)) { up = index.get(a); break; }
		const scrollers = [];
		for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
			const ox = getComputedStyle(a).overflowX;
			if (ox === "auto" || ox === "scroll") scrollers.push(Object.assign(name(a), { overflowX: ox, rect: box(a.getBoundingClientRect()) }));
		}
		let text = false;
		for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim() !== "") { text = true; break; }
		index.set(el, elements.length);
		keep.push(el);
		const host = el.parentElement ? el.parentElement.closest("[id]") : null;
		elements.push(Object.assign(name(el), { rect: box(r), up, text, font: text ? getComputedStyle(el).fontFamily : "", inside: host ? host.id : "", scrollers }));
	}
	Object.defineProperty(window, "__pdWidthKeep", { value: keep, configurable: true });
	const activeProgress = [];
	for (const [i, row] of [...document.querySelectorAll("#p-active tbody tr")].entries()) {
		const progress = row.querySelector(".fl-prog");
		const cell = progress?.closest("td");
		if (!cell) continue;
		const action = row.querySelector('td[data-l="Progress"] + td .btn');
		const parts = [];
		for (const [name, selector] of [["progress", ".fl-prog"], ["phase list", ".phases"], ["phase", ".phases li"], ["phase bar", ".phases .bar"], ["phase label", ".phases .name"]]) for (const el of cell.querySelectorAll(selector)) {
			const rect = el.getBoundingClientRect();
			if (!(rect.width > 0 && rect.height > 0)) continue;
			parts.push({ name, rect: box(rect), clipped: (name === "progress" || name === "phase list") && el.scrollWidth > el.clientWidth + S });
		}
		activeProgress.push({ row: i + 1, cell: box(cell.getBoundingClientRect()), action: action ? box(action.getBoundingClientRect()) : null, parts });
	}
	return { scrollWidth: se.scrollWidth, clientWidth: document.documentElement.clientWidth, elements, activeProgress };
})()`;
}

/**
 * The page half of `shellMetrics`, shared by the bar's and More's collectors: every element of `header.top` and its
 * ancestors below `<body>`, in document order (`list`), as `nodes` (`{ tag, id, cls, parent }`, `parent` an index or
 * -1), which of them is which part (`roles`, an index or -1 each, the parts found by the selectors the shell is drawn
 * with), and `snap()`, each one's box, `position`, `overflow` and, inside the bar, its label, read now. It decides
 * nothing: what clips what and which parts are judged is `shellMetrics`', where a test can reach it. The class is read
 * with each snapshot, since the live pill's changes from read to read.
 */
const COLLECT = `
	const top = document.querySelector("header.top");
	const list = [];
	if (top) {
		for (let a = top.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) list.unshift(a);
		list.push(top, ...top.querySelectorAll("*"));
	}
	const index = new Map(list.map((el, i) => [el, i]));
	const at = (el) => (el && index.has(el) ? index.get(el) : -1);
	const one = (selector) => (top ? at(top.querySelector(selector)) : -1);
	const roles = { top: at(top), nav: one(".pillnav"), end: one(".top__end"), brand: one(".brandpill"), theme: one("[data-theme-toggle]"), name: one(".who b"), roleWord: one(".who small"), more: one("details.more"), summary: one("details.more > summary"), menu: one("details.more > :not(summary)") };
	const nodes = list.map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || "", cls: el.getAttribute("class") || "", parent: at(el.parentElement) }));
	const inBar = new Set(top ? [top, ...top.querySelectorAll("*")] : []);
	const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	const snap = () => list.map((el) => {
		const cs = getComputedStyle(el);
		const label = inBar.has(el) ? String(el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) : "";
		return { cls: el.getAttribute("class") || "", rect: box(el.getBoundingClientRect()), position: cs.position, overflowX: cs.overflowX, overflowY: cs.overflowY, label };
	});
`;

/**
 * The bar, read in every combination of what the script changes after the page is drawn: each live word (`states`,
 * LIVE_STATES' distinct class and word pairs, innermost), with the theme button shown and then hidden, with the Parked
 * count as drawn (`counts.drawn`), emptied and widened to `counts.wide` (its drawn text swapped in each text node, so
 * any markup of the count is widened alike; the stream swaps that panel on a live page). Each state is set and the bar
 * read at once, synchronously, so no page script runs in between, with the page's `scrollWidth` in that state; then
 * everything is put back, the count's own nodes included. Also the measures of the signed-in name and role word
 * (`nameProblems`), each with the tooltip a reader gets there: the nearest `title` from the word up through `.who`.
 * Returns `{ nodes, roles, reads, name, roleWord, parkedWidened, width, height }` for `shellMetrics`, or null when the
 * page has no bar.
 *
 * WHAT THE PANEL SHOWED IS READ BACK, never assumed from what was asked of it: each read keeps the panel's text as it
 * stood (`parkedText`, null where the bar has no Parked panel), and `parkedWidened` is whether the panel's text held the
 * wide count after the swap. A swap that wrote the drawn count back (which passed
 * every run before, the flag set by the find alone) leaves the wide reads labelled with a count the panel never showed, and
 * `parkedReadProblems` and the widened rule both say so. Exported for the worker test, which runs it against a stubbed
 * page.
 */
export function barSource(states, counts) {
	return `(() => {
	${COLLECT}
	if (!top) return null;
	const se = document.scrollingElement || document.documentElement;
	const pill = document.getElementById("live-status");
	const word = pill ? pill.querySelector("[data-live-word]") : null;
	const button = roles.theme >= 0 ? list[roles.theme] : null;
	const panel = top.querySelector("#p-nav-parked");
	const lives = pill && word ? ${JSON.stringify(states)} : [null];
	const themes = button ? [false, true] : [null];
	const DRAWN = ${JSON.stringify(counts.drawn)};
	const WIDE = ${JSON.stringify(counts.wide)};
	const parkeds = panel ? [DRAWN, "", WIDE] : [null];
	const kids = panel ? [...panel.childNodes] : [];
	const was = { cls: pill ? pill.className : "", word: word ? word.textContent : "", hidden: button ? button.hidden : false };
	let parkedWidened = null;
	const setCount = (c) => {
		if (c === DRAWN) panel.replaceChildren(...kids);
		else if (c === "") panel.replaceChildren();
		else {
			const copy = document.createDocumentFragment();
			copy.append(...kids.map((k) => k.cloneNode(true)));
			const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
			for (let t = walk.nextNode(); t; t = walk.nextNode()) if (t.nodeValue.includes(DRAWN)) t.nodeValue = t.nodeValue.split(DRAWN).join(WIDE);
			panel.replaceChildren(copy);
			// From the page, after the swap: what the panel now shows, not whether the swap found something to change.
			parkedWidened = panel.textContent.includes(WIDE);
		}
	};
	const reads = [];
	for (const parked of parkeds) {
		if (panel) setCount(parked);
		for (const hidden of themes) {
			if (button) button.hidden = hidden;
			for (const s of lives) {
				if (s) {
					pill.className = s.cls;
					word.textContent = s.word;
				}
				reads.push({ live: s ? s.word : null, theme: hidden === null ? null : hidden ? "hidden" : "shown", parked, parkedText: panel ? panel.textContent : null, scrollWidth: se.scrollWidth, snap: snap() });
			}
		}
	}
	if (pill && word) {
		pill.className = was.cls;
		word.textContent = was.word;
	}
	if (button) button.hidden = was.hidden;
	if (panel) panel.replaceChildren(...kids);
	const measure = (i) => {
		const el = i >= 0 ? list[i] : null;
		if (!el) return null;
		const cs = getComputedStyle(el);
		const who = el.closest(".who");
		let title = null;
		for (let a = el; a && (who ? who.contains(a) : a === el); a = a.parentElement) if (a.hasAttribute("title")) { title = a.getAttribute("title"); break; }
		return { text: el.textContent, title, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, textOverflow: cs.textOverflow, overflowX: cs.overflowX };
	};
	return { nodes, roles, reads, name: measure(roles.name), roleWord: measure(roles.roleWord), parkedWidened, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
})()`;
}

/**
 * The More menu opened and measured (`phone` for a window at most `PHONE_MAX` wide). Above a phone a plain click on its
 * button, whose row never scrolls. On a phone the hard case round 3 found: the navigation scrolled until the button is
 * cut in half at the row's right edge (as a reader's own scrolling leaves it), focus taken off whatever held it, two
 * frames so a scroll handler has run, then a bare `click()`, which moves no focus (an assistive technology's
 * activation, or Safari's), and the check never scrolls the button into view first: opening it must. Then two frames
 * (the script places the list in the frame after the click), the measure, and the menu shut again. Returns `{ opened,
 * cutFirst, nodes, roles, snap, width, height }` for `shellMetrics` (`cutFirst` whether the button was cut before the
 * click, null above a phone), or null when the bar has no More.
 */
export function moreSource(phone) {
	return `(async () => {
	const frames = () => new Promise((resolve) => { const cap = setTimeout(resolve, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(cap); resolve(); })); });
	const details = document.querySelector("header.top details.more");
	if (!details) return null;
	const button = details.querySelector("summary");
	let cutFirst = null;
	if (button) {
		const nav = ${phone ? `details.closest("nav")` : "null"};
		if (nav) {
			nav.scrollLeft = nav.scrollWidth;
			const r0 = button.getBoundingClientRect();
			const n0 = nav.getBoundingClientRect();
			nav.scrollLeft -= n0.right - r0.left - r0.width / 2;
			if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
			await frames();
			const r = button.getBoundingClientRect();
			const n = nav.getBoundingClientRect();
			cutFirst = r.left < n.left - ${EDGE_SLACK} || r.right > n.right + ${EDGE_SLACK};
		}
		button.click();
		await frames();
	}
	${COLLECT}
	const got = { opened: details.open, cutFirst, nodes, roles, snap: snap(), width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
	if (details.open && button) button.click();
	return got;
})()`;
}

/**
 * The More menu's measure on a page whose scripts are off, after a real mouse click on its button (`checkNoScript`):
 * synchronous, as no frame callback of the page's runs. Returns what `moreSource` does (`cutFirst` null), or null.
 * Exported, with `MORE_AT` and `THEME_HIDDEN_READ`, for the worker test's stubbed browser.
 */
export const MORE_READ = `(() => {
	const details = document.querySelector("header.top details.more");
	if (!details) return null;
	${COLLECT}
	return { opened: details.open, cutFirst: null, nodes, roles, snap: snap(), width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
})()`;

/** The centre of More's button in the window, for a real click (`checkNoScript`), or null when the bar has none. */
export const MORE_AT = `(() => {
	const b = document.querySelector("header.top details.more > summary");
	if (!b) return null;
	const r = b.getBoundingClientRect();
	return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
})()`;

/**
 * The theme button's `hidden` as the page holds it (`noScriptVerdict`), or null when it draws none. The server draws it
 * hidden and the script reveals it on load, so after load it is the one sign the page's script did or did not run.
 */
export const THEME_HIDDEN_READ = `(() => {
	const b = document.querySelector("[data-theme-toggle]");
	return b ? b.hidden === true : null;
})()`;

/**
 * Which emulation the window got (`emulationProblems`): the page's viewport meta asks for `PROBE_WIDTH`, the layout
 * viewport's width is read, and the meta is put back. A phone's emulation (`mobile: true`) lays the page out at that
 * width and a desktop's keeps the window's, which no call that SET the emulation can say. Synchronous, with no frame
 * waited for (measured in Chrome for Testing 155: the read follows the meta at once, both ways), and run last, after
 * every measure and screenshot. Exported for the worker test, which runs it against a stubbed page each way.
 */
export const EMULATION_PROBE = `(() => {
	const meta = document.querySelector('meta[name="viewport"]');
	if (!meta) return { dpr: window.devicePixelRatio, mobile: null, probed: null };
	const was = meta.getAttribute("content");
	meta.setAttribute("content", "width=${PROBE_WIDTH}");
	const probed = document.documentElement.clientWidth;
	meta.setAttribute("content", was);
	return { dpr: window.devicePixelRatio, mobile: probed === ${PROBE_WIDTH}, probed };
})()`;

// ---- the run ----------------------------------------------------------------------------------------------------

/**
 * Serve `docs` (each `{ id, path, html }`), `shellDocs`, the negative `controls` (`controlDoc`'s and
 * `phoneControlDoc`'s: each page, its stylesheet and its script, if any) and the console's static files with the
 * console's security headers, drive `chrome` through every run (the controls first, the run without scripts last), and
 * return the results. `heads` is `themeHead` of a page drawn with no theme (`system`) and with each theme; `liveStates`
 * the live pill's distinct `{ cls, word }`. `log` prints a line; `onOpen` is handed the browser once it runs, so the
 * caller's exit handler can remove what Chrome leaves behind.
 */
export async function checkPages({ chrome, docs, shellDocs: sweep = [], controls = [], heads, liveStates = [], css, script, applyHeaders, canvasOf, clockMs, shots, sandbox, work, children, log, onOpen }) {
	const byPath = new Map([...docs, ...sweep, ...controls].map((d) => [d.path, d]));
	const assets = new Map(controls.flatMap((c) => [[`${c.path}.css`, ["text/css", c.css]], ...(c.js ? [[`${c.path}.js`, ["text/javascript", c.js]]] : [])]));
	for (const theme of THEMES) {
		const doc = docs.find((d) => d.id === FORCED_DOC);
		if (doc) byPath.set(forcedPath(doc, theme), { ...doc, html: injectTheme(doc.html, heads.system, heads[theme]) });
	}
	const held = new Set();
	let current = null;
	const strays = [];
	const server = createServer((req, res) => {
		applyHeaders(res);
		const path = new URL(req.url, "http://127.0.0.1").pathname;
		const doc = byPath.get(path);
		if (req.method === "POST" && path === "/login/code") {
			// A one-time link page's post (`LINK_CODE_FRAGMENT`), held open like a stream: the page stays as drawn.
			held.add(res);
			req.on("close", () => held.delete(res));
			req.resume();
		} else if (req.method !== "GET") {
			strays.push({ run: current, what: `${req.method} ${path}` });
			res.writeHead(405).end();
		} else if (doc) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc.html);
		} else if (path === "/static/console.css") {
			res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(css);
		} else if (assets.has(path)) {
			const [type, body] = assets.get(path);
			res.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(body);
		} else if (path === "/static/console.js") {
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(script);
		} else if (path === "/api/events" || path === "/api/transcript") {
			// Held open with nothing sent: the page shows its live state, and nothing it draws moves under the measure.
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
			res.flushHeaders();
			held.add(res);
			req.on("close", () => held.delete(res));
		} else if (path === "/api/whoami") {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end("{}");
		} else {
			if (path !== "/favicon.ico") strays.push({ run: current, what: `GET ${path}` });
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
		}
	});
	await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	// `--use-mock-keychain`: on macOS, with HOME pointed at this run's directory, every http navigation hung (measured:
	// Page.navigate never answered, and the server never saw the request; with the flag, or with the user's own HOME, it
	// loads at once). The likely wait is Chrome's first read of its keychain key, which a file:// page (all render-images
	// loads) never needs. Other platforms ignore the flag. The resolver still maps every NAME to nothing; only the
	// loopback address this server listens on is excluded, because Chrome applies the rules to an IP literal too
	// (measured: ERR_NAME_NOT_RESOLVED without the exclusion).
	const extraArgs = ["--use-mock-keychain", ...(sandbox ? [] : ["--no-sandbox"])];
	const browser = await openChrome({ chrome, work, children, Refusal, stepMs: STEP_MS, env: { HOME: join(work, "home") }, extraArgs, captureStderr: true, resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" });
	onOpen?.(browser);
	const results = [];
	const shell = [];
	const controlResults = [];
	const after = () => {
		for (const res of held) res.destroy();
		held.clear();
		current = null;
	};
	try {
		const version = await browser.send("Browser.getVersion");
		const product = String(version.product ?? "");
		log(`Chrome ${product} (revision ${version.revision ?? "?"}) at ${chrome}${sandbox ? "" : ", --no-sandbox"}`);
		for (const control of controls) {
			const run = { key: control.id, doc: control, width: control.width, mobile: control.mobile };
			current = run.key;
			controlResults.push(await checkShell({ browser, run, url: origin + control.path, clockMs, shots, liveStates }));
			after();
		}
		for (const run of planRuns(docs)) {
			current = run.key;
			const path = run.forced ? forcedPath(run.doc, run.forced) : run.doc.path;
			results.push(await checkOne({ browser, run, url: origin + goldenUrl(run.doc, path), canvasOf, clockMs, shots }));
			after();
		}
		for (const run of planShellRuns(sweep)) {
			current = run.key;
			shell.push(await checkShell({ browser, run, url: origin + run.doc.path, clockMs, shots, liveStates }));
			after();
		}
		const run = noScriptRun(sweep);
		if (run) {
			current = run.key;
			shell.push(await checkNoScript({ browser, run, url: origin + run.doc.path, clockMs, shots }));
			after();
		}
		for (const s of strays) {
			const r = [...results, ...shell, ...controlResults].find((x) => x.run.key === s.run);
			if (r) r.failures.push(`asked for ${s.what}, which this check does not serve (teach it the route, or the page is measured without it)`);
			else log(`note: a request outside any run: ${s.what}`);
		}
		return { product, results, shell, controls: controlResults };
	} finally {
		await browser.close();
		browser.removeSingleton();
		for (const res of held) res.destroy();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

function forcedPath(doc, theme) {
	return `/forced/${theme}/${doc.id}.html`;
}

/**
 * A new tab on `url` with the run's emulation (`metrics` for `Emulation.setDeviceMetricsOverride`, `emulated` the
 * system theme), the frozen clock and the probe, loaded and settled: `{ t, evaluate, settled }`. With `noScript` the
 * page's scripts are off (`Emulation.setScriptExecutionDisabled`), which leaves DevTools' own evaluation working, and
 * it is settled by a wait instead (no frame callback of the page's runs). The caller closes `t`.
 */
async function openPage({ browser, key, url, metrics, emulated, clockMs, noScript = false }) {
	const t = await browser.openTarget();
	try {
		const evaluate = async (expression, awaitPromise = false) => {
			const r = await t.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
			if (r.exceptionDetails) throw new Refusal(`${key}: the page threw while measured (${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text})`);
			return r.result.value;
		};
		await t.send("Page.enable");
		await t.send("Page.bringToFront");
		await t.send("Emulation.setDeviceMetricsOverride", metrics);
		await t.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
		await t.send("Emulation.setLocaleOverride", { locale: "en-US" });
		await t.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: emulated }] });
		await t.send("Page.addScriptToEvaluateOnNewDocument", { source: frozenDateSource(clockMs) });
		await t.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
		if (noScript) await t.send("Emulation.setScriptExecutionDisabled", { value: true });
		const loaded = browser.event((m) => m.method === "Page.loadEventFired" && m.sessionId === t.sessionId, `load event for ${key}`, NAV_MS);
		loaded.catch(() => {}); // awaited below; a navigation that fails first must not leave it unhandled
		const nav = await t.send("Page.navigate", { url }, NAV_MS);
		if (nav.errorText) throw new Refusal(`${key}: ${url} did not load (${nav.errorText})`);
		await loaded;
		if (noScript) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { t, evaluate, settled: true };
		}
		const settled = Boolean(await evaluate(SETTLE, true));
		return { t, evaluate, settled };
	} catch (err) {
		await t.close().catch(() => {});
		throw err;
	}
}

async function checkOne({ browser, run, url, canvasOf, clockMs, shots }) {
	const metrics = { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.scale, mobile: true };
	const { t, evaluate, settled } = await openPage({ browser, key: run.key, url, metrics, emulated: run.emulated, clockMs });
	try {
		const csp = JSON.parse(await evaluate(CSP_READ));
		const errors = JSON.parse(await evaluate(ERRORS_READ));
		const canvas = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--canvas")`);
		const measured = await evaluate(measureSource(VIEWPORT.width, EDGE_SLACK));
		if (shots) {
			const m = await t.send("Page.getLayoutMetrics");
			const h = Math.ceil(m.cssContentSize.height);
			const w = Math.max(VIEWPORT.width, measured.scrollWidth);
			const { data } = await t.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
			writeFileSync(join(shots, `${run.doc.id}.${run.label}.png`), Buffer.from(data, "base64"));
		}
		const emulation = await evaluate(EMULATION_PROBE);
		const verdict = runVerdict({ csp, errors, canvas, want: canvasOf(run.expect), expect: run.expect, measured, emulation, settled });
		if (!verdict.width.ok) verdict.width.font = await platformFont(t, verdict.width.fontAt, measured.elements);
		return { run, ...verdict };
	} finally {
		await t.close().catch(() => {});
	}
}

async function checkShell({ browser, run, url, clockMs, shots, liveStates }) {
	const metrics = run.mobile
		? { width: run.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.scale, mobile: true }
		: { width: run.width, height: DESKTOP.height, deviceScaleFactor: DESKTOP.scale, mobile: false };
	const { t, evaluate, settled } = await openPage({ browser, key: run.key, url, metrics, emulated: "light", clockMs });
	try {
		const csp = JSON.parse(await evaluate(CSP_READ));
		const errors = JSON.parse(await evaluate(ERRORS_READ));
		const measured = await evaluate(measureSource(run.width, EDGE_SLACK));
		const bar = await evaluate(barSource(liveStates, parkedCounts()));
		const more = await evaluate(moreSource(run.width <= PHONE_MAX), true);
		if (shots) {
			const { data } = await t.send("Page.captureScreenshot", { format: "png" });
			writeFileSync(join(shots, `${run.doc.id}.${run.width}.png`), Buffer.from(data, "base64"));
		}
		const emulation = await evaluate(EMULATION_PROBE);
		return { run, ...shellRunVerdict(run, { csp, errors, measured, bar, more, emulation, settled }, liveStates) };
	} finally {
		await t.close().catch(() => {});
	}
}

/**
 * The run without page scripts (`NO_SCRIPT`, `noScriptVerdict`): the theme button's state read first (proof the script
 * never ran), then More opened by a real mouse click on its button's centre. `browser` is `openChrome`'s; exported for
 * the worker test, which drives it with a stubbed one.
 */
export async function checkNoScript({ browser, run, url, clockMs, shots = null }) {
	const metrics = { width: run.width, height: DESKTOP.height, deviceScaleFactor: DESKTOP.scale, mobile: false };
	const { t, evaluate } = await openPage({ browser, key: run.key, url, metrics, emulated: "light", clockMs, noScript: true });
	try {
		const themeHidden = await evaluate(THEME_HIDDEN_READ);
		const measured = await evaluate(measureSource(run.width, EDGE_SLACK));
		const at = await evaluate(MORE_AT);
		let more = null;
		if (at) {
			for (const type of ["mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
			await new Promise((resolve) => setTimeout(resolve, 200));
			more = await evaluate(MORE_READ);
		}
		if (shots) {
			const { data } = await t.send("Page.captureScreenshot", { format: "png" });
			writeFileSync(join(shots, `${run.doc.id}.${run.width}.png`), Buffer.from(data, "base64"));
		}
		const emulation = await evaluate(EMULATION_PROBE);
		return { run, ...noScriptVerdict({ width: run.width, measured, more, emulation, themeHidden }) };
	} finally {
		await t.close().catch(() => {});
	}
}

/** The platform font Chrome drew the offender's text in (`CSS.getPlatformFontsForNode`), as a phrase; never throws. */
async function platformFont(t, index, elements) {
	if (index === null) return null;
	const family = elements[index]?.font ? `font-family ${elements[index].font}` : "no text of its own";
	try {
		await t.send("DOM.enable");
		await t.send("CSS.enable");
		await t.send("DOM.getDocument", { depth: 0 });
		const r = await t.send("Runtime.evaluate", { expression: `window.__pdWidthKeep[${index}]` });
		const { nodeId } = await t.send("DOM.requestNode", { objectId: r.result.objectId });
		const { fonts } = await t.send("CSS.getPlatformFontsForNode", { nodeId });
		const drawn = fonts.map((f) => `${f.familyName} (${f.glyphCount} glyphs)`).join(", ");
		return `${describe(elements[index])} ${family}, drawn in ${drawn || "no platform font"}`;
	} catch (err) {
		return `${describe(elements[index])} ${family}, platform font unknown (${err?.message ?? err})`;
	}
}

// ---- main -------------------------------------------------------------------------------------------------------

function readPin() {
	return JSON.parse(readFileSync(PIN_FILE, "utf8"));
}

async function verifyZipMain(opts) {
	const platform = opts.platform ?? hostPlatform();
	if (!platform) throw new Refusal(`this machine (${process.platform} ${process.arch}) has no pinned Chrome for Testing build; pass --platform`);
	const pin = readPin();
	const problems = pinProblems(pin);
	if (problems.length > 0) throw new Refusal(`.github/chrome-for-testing.json: ${problems.join("; ")}`);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(opts.verifyZip)) hash.update(chunk);
	const v = zipVerdict({ got: hash.digest("hex"), platform, pin });
	if (!v.ok) throw new Refusal(`${opts.verifyZip}: ${v.problem}`);
	console.log(`OK: ${opts.verifyZip} is Chrome for Testing ${pin.version} ${platform} (sha256 ${v.got})`);
}

/** `--check-pin`: the url alone on stdout, so the workflow can download from it; everything else is a refusal. */
function checkPinMain(opts) {
	const platform = opts.platform ?? hostPlatform();
	if (!platform) throw new Refusal(`this machine (${process.platform} ${process.arch}) has no pinned Chrome for Testing build; pass --platform`);
	const got = pinUrl(readPin(), platform);
	if (got.error) throw new Refusal(got.error);
	console.log(got.url);
}

/** The goldens under `dir` as docs, and the problems found reading them. */
export function readGoldens(dir, prefix) {
	const docs = [];
	const problems = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
		const name = goldenName(file);
		if (!name) {
			problems.push(`${prefix}${file} is not named <shot>.<role>.html`);
			continue;
		}
		const html = readFileSync(join(dir, file), "utf8");
		// A panel golden that is a fragment would load in quirks mode, with no stylesheet: measured, it would say nothing.
		if (!/^<!doctype html>/i.test(html)) {
			problems.push(`${prefix}${file} is not a whole page (no <!doctype html>): the width check loads whole pages only`);
			continue;
		}
		const page = /<body\b[^>]*\sdata-page="([^"]*)"/.exec(html)?.[1] ?? null;
		if (!page) {
			problems.push(`${prefix}${file} has no <body data-page>`);
			continue;
		}
		const id = `${prefix.replace(/\/$/, ".")}${file.slice(0, -".html".length)}`;
		docs.push({ id, file: `${prefix}${file}`, path: `/fixtures/${prefix}${file}`, page, role: name.role, html });
	}
	return { docs, problems };
}

/** The repository modules the check draws and serves with, imported only when a run needs them. */
export async function loadModules() {
	const at = (path) => import(pathToFileURL(join(REPO, path)).href);
	const pages = await at("admin/src/console/pages.mjs");
	const { applySecurityHeaders } = await at("admin/src/console/headers.mjs");
	const { CONSOLE_CSS } = await at("admin/src/console/style.mjs");
	const { CONSOLE_SCRIPT } = await at("admin/src/console/script.mjs");
	const shell = await at("admin/src/console/shell.mjs");
	const htmlModule = await at("admin/src/console/html.mjs");
	const { colorOf } = await at("admin/src/console/pulse-tokens.mjs");
	const { NOW } = await at("launch/fixture-deployment.mjs");
	const { TOKEN_NAME_RE } = await at("worker/src/console-tokens.mjs");
	return { pages, applySecurityHeaders, CONSOLE_CSS, CONSOLE_SCRIPT, shell, htmlModule, colorOf, NOW, TOKEN_NAME_RE, pin: readPin() };
}

/**
 * The check from the Chrome lookup to the exit code, with its world passed in: `find` (`findChrome`'s answer),
 * `modules` (`loadModules`'), `fixtures` (the goldens' directory), `check` (`checkPages` with the browser's own
 * arguments bound), `ci`, `log` and `started`. Returns the exit code; a refusal throws.
 */
export async function runCheck(opts, { find, modules, fixtures = FIXTURES, check, ci, log, started = Date.now() }) {
	const choice = chromeChoice(find(), opts.require);
	if (choice.refusal) throw new Refusal(choice.refusal);
	if (choice.skip) {
		log(choice.skip);
		return 0;
	}
	const m = modules;
	const pageNames = Object.keys(m.pages.PAGES);
	const top = readGoldens(fixtures, "");
	const panels = existsSync(join(fixtures, "panels")) ? readGoldens(join(fixtures, "panels"), "panels/") : { docs: [], problems: [] };
	const setup = goldenProblems({ top, panels, pageNames });
	const docs = [...top.docs, ...panels.docs];
	const headOf = (theme) => themeHead(String(m.htmlModule.page({ title: "theme", name: "theme", body: m.htmlModule.html``, theme })));
	const heads = { system: headOf(null), light: headOf("light"), dark: headOf("dark") };
	const runId = longRunId((id) => m.pages.parsePageQuery("run", new URLSearchParams({ id })).query?.id === id);
	const sweep = await shellDocs({ pageNames, contexts: shellContexts(m.TOKEN_NAME_RE), runId, draw: (name, ctx) => m.pages.renderPage(name, ctx) });
	const liveStates = liveStatesOf(m.shell.LIVE_STATES);
	const controls = [controlDoc(liveStates, m.shell.LIVE_STATES.retry), phoneControlDoc(liveStates)];
	setup.push(...liveStateProblems(liveStates));
	if (noScriptRun(sweep) === null) setup.push(`the shell sweep has no ${NO_SCRIPT.doc} to load without its script`);
	const outcome = await check({
		docs,
		shellDocs: sweep,
		controls,
		heads,
		liveStates,
		css: m.CONSOLE_CSS,
		script: m.CONSOLE_SCRIPT,
		applyHeaders: m.applySecurityHeaders,
		canvasOf: (theme) => m.colorOf("canvas", theme),
		clockMs: m.NOW + 60_000,
		chrome: choice.path,
	});
	// Each control against its own run, by id: one that never ran is `got: null`, a problem of its own.
	const measuredControls = controls.map((c) => {
		const r = (outcome.controls ?? []).find((x) => x.run?.key === c.id);
		return { name: c.name, what: c.what, width: c.width, want: c.expected, got: r ? r.failures : null, notes: r?.notes ?? [] };
	});
	const s = summarize({ setup, product: outcome.product, pin: m.pin, ci, results: outcome.results, shell: outcome.shell, controls: measuredControls, pages: [...new Set(docs.map((d) => d.page))], seconds: ((Date.now() - started) / 1000).toFixed(1) });
	for (const line of s.lines) log(line);
	return s.code;
}

async function main(opts) {
	const started = Date.now();
	const modules = await loadModules();
	if (opts.shots) mkdirSync(opts.shots, { recursive: true });
	let work = null;
	const children = new Set();
	let browser = null;
	let deadline = null;
	const cleanup = () => {
		for (const child of children) {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		}
		browser?.removeSingleton();
		if (work) rmSync(work, { recursive: true, force: true });
	};
	// The sandbox, and why it is off on GitHub's runners only: ubuntu-24.04 restricts unprivileged user namespaces
	// through AppArmor, so Chrome's namespace sandbox cannot start there, and an unzipped Chrome for Testing has no
	// setuid helper to fall back on. Off is acceptable for THIS browser: it loads nothing but this repository's own
	// golden pages and modules from a server on 127.0.0.1, its host resolver maps every name to nothing, and the
	// runner it would escape to is a throwaway VM holding no secret (the job is read-only). Everywhere else it stays on.
	const ci = process.env.GITHUB_ACTIONS === "true";
	const check = async (args) => {
		work = mkdtempSync(join(tmpdir(), "pi-dispatch-width-"));
		process.on("exit", cleanup);
		for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
			process.on(signal, () => {
				console.error(`console-width-check: ${signal}, stopping`);
				cleanup();
				process.exit(code);
			});
		}
		// The run's own deadline. The per-call deadlines bound each wait; this bounds their sum, so a slow runner fails
		// the step with a sentence instead of reaching the step's timeout-minutes with none.
		deadline = setTimeout(() => {
			console.error(`::error::the console width check did not finish within ${RUN_MS / 60_000} minutes`);
			cleanup();
			process.exit(1);
		}, RUN_MS);
		return checkPages({ ...args, shots: opts.shots, sandbox: !ci, work, children, log: (line) => console.log(line), onOpen: (b) => (browser = b) });
	};
	try {
		return await runCheck(opts, { find: () => findChrome(), modules, check, ci, log: (line) => console.log(line), started });
	} finally {
		if (deadline) clearTimeout(deadline);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(USAGE);
		process.exit(0);
	}
	if (opts.error) {
		console.error(`console-width-check: ${opts.error}\n${USAGE}`);
		process.exit(2);
	}
	try {
		if (opts.verifyZip) await verifyZipMain(opts);
		else if (opts.checkPin) checkPinMain(opts);
		process.exit(opts.verifyZip || opts.checkPin ? 0 : await main(opts));
	} catch (err) {
		console.error(`::error::console-width-check: ${err instanceof Refusal ? err.message : (err?.stack ?? err)}`);
		process.exit(1);
	}
}
