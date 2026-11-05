/**
 * The film's real screens: the console's committed goldens, served with its own stylesheet, script and headers, in its
 * dark theme, moved a frame at a time by `screen-motion.js` and saved as images the film plays like a clip.
 *
 * Why the goldens and not a running console: they are the console's real markup over one sample deployment, they need no
 * store and no sign-in, and a frame is the same on every render. A screencast of a live page would be none of those.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openChrome } from "../chrome-pipe.mjs";
import { goldenKey, servePages, transcriptFrames } from "../console-render.mjs";
import { NOW } from "../fixture-deployment.mjs";
import { FPS, SHOTS, timeline } from "./shots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOTION = join(HERE, "screen-motion.js");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Which golden each screen is. `transcript` names the run whose stream gets its canned entries. */
export const SCREENS = Object.freeze({
	overview: { golden: "overview.operator" },
	steer: { golden: "panels/run-live-armed.operator" },
	question: { golden: "panels/run-parked-question.operator", transcript: "gh-2f6a" },
	zero: { golden: "zero-touch.operator" },
	machines: { golden: "fleet.operator" },
	models: { golden: "panels/models-populated.operator" },
	rules: { golden: "triggers.operator" },
});

/** The console's desktop layout, at the film's width. */
const LAYOUT = { width: 1440, height: 810 };

/** Each screen's time on screen, from the shot table and the measured beats. */
export function screenSpans(beats) {
	const period = (beats.at(-1) - beats[0]) / (beats.length - 1);
	const timed = timeline(beats).shots;
	const spans = [];
	for (const shot of SHOTS) {
		const time = timed.find((t) => t.id === shot.id);
		for (const screen of shot.screens ?? []) spans.push({ name: screen.name, shot: shot.id, from: screen.from, to: screen.to, seconds: ((screen.to - screen.from) * (time.end - time.start)) / shot.beats, period });
	}
	return spans;
}

/** Renders whatever is not already on disk, and returns `{ name: { pattern, frames } }`. */
export async function renderScreens({ build, beats, draft, work, children, chrome = process.env.CHROME ?? MAC_CHROME, log = () => {} }) {
	const motion = readFileSync(MOTION, "utf8");
	const scale = (draft ? 960 : 1920) / LAYOUT.width;
	const spans = screenSpans(beats);
	const widthCheck = await import("../../.github/scripts/console-width-check.mjs");
	const docs = [widthCheck.readGoldens(widthCheck.FIXTURES, ""), widthCheck.readGoldens(join(widthCheck.FIXTURES, "panels"), "panels/")].flatMap((read) => read.docs);
	const byKey = new Map(docs.map((doc) => [goldenKey(doc), doc]));
	const out = {};
	const todo = [];
	for (const span of spans) {
		const screen = SCREENS[span.name];
		const doc = byKey.get(screen?.golden);
		if (!doc) throw new Error(`the screen ${span.name} has no golden ${screen?.golden}`);
		const hash = createHash("sha256").update(JSON.stringify({ motion, html: doc.html, scale, seconds: span.seconds, period: span.period, span: [span.from, span.to] })).digest("hex").slice(0, 12);
		const dir = join(resolve(build), "screens", `${span.name}-${hash}`);
		const count = Math.ceil(span.seconds * FPS) + 1;
		out[span.name] = { pattern: `${pathToFileURL(dir).href}/%04d.jpg`, frames: count };
		if (!existsSync(dir) || readdirSync(dir).length < count) todo.push({ span, screen, doc, dir, count });
	}
	if (!todo.length) return out;

	const m = await widthCheck.loadModules();
	const { transcriptEntryHtml } = await import("../../admin/src/console/transcript.mjs");
	const frames = new Map(todo.filter((job) => job.screen.transcript).map((job) => [job.screen.transcript, transcriptFrames(transcriptEntryHtml, job.screen.transcript)]));
	const server = await servePages({ docs, css: m.CONSOLE_CSS, script: m.CONSOLE_SCRIPT, applyHeaders: m.applySecurityHeaders, frames });
	const home = join(work, "screens");
	mkdirSync(join(home, "home"), { recursive: true });
	const browser = await openChrome({ chrome, work: home, children, stepMs: 60_000, env: { HOME: join(home, "home") }, extraArgs: widthCheck.chromeLaunchArgs(), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" });
	try {
		for (const { span, screen, doc, dir, count } of todo) {
			mkdirSync(dir, { recursive: true });
			const page = await widthCheck.openPage({
				browser,
				key: span.name,
				url: `${server.origin}${widthCheck.goldenUrl(doc)}`,
				metrics: { width: LAYOUT.width, height: LAYOUT.height, deviceScaleFactor: scale, mobile: false },
				emulated: "dark",
				clockMs: NOW + 60_000,
			});
			try {
				if (screen.transcript) await page.evaluate(`new Promise((done) => { const look = () => (document.querySelector("[data-run-question] *, [data-transcript] .tx__entry") || performance.now() > 5000 ? done() : setTimeout(look, 50)); look(); })`, true);
				await page.evaluate(motion);
				await page.evaluate(`window.filmScreen.setup(${JSON.stringify(span.name)})`);
				for (let frame = 0; frame < count; frame++) {
					await page.evaluate(`window.filmScreen.seek(${(frame / FPS) / span.period})`);
					const { data } = await page.t.send("Page.captureScreenshot", { format: "jpeg", quality: draft ? 88 : 95 });
					writeFileSync(join(dir, `${String(frame + 1).padStart(4, "0")}.jpg`), Buffer.from(data, "base64"));
				}
				log(`screen ${span.name}: ${count} frames`);
			} finally {
				await page.t.close().catch(() => {});
			}
		}
	} finally {
		await browser.close().catch(() => {});
		await server.close();
	}
	return out;
}
