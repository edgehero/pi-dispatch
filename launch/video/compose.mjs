#!/usr/bin/env node
/**
 * Renders the film: Chrome draws each frame, ffmpeg joins them to the track. The same approach as `render-images.mjs
 * --explain`: seek to a frame's moment and screenshot it, so the result does not depend on how busy the machine is.
 * The difference is that `film.js` is a pure function of time, and frames go to ffmpeg rather than `encodeApng`.
 *
 *   node launch/video/compose.mjs --beats beats.json --track track.wav --out film.mp4 [--build dir] [--draft]
 *   node launch/video/compose.mjs --beats beats.json --stills 3,24.5,41 --out-dir frames/ [--draft]
 *
 * `--draft` is half size and a quick encode. Generated pictures come from `picks.json` in the build folder, `{ name: file }`,
 * chosen at a checkpoint; a picture not picked yet draws as a labelled panel. A clip is first extracted to images, because
 * seeking a `<video>` in a paused page is not frame accurate.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openChrome } from "../chrome-pipe.mjs";
import { iconBody } from "../explainers.mjs";
import { renderScreens } from "./screens.mjs";
import { ASSETS, DOUBLINGS, FPS, HEIGHT, MIN_TYPE, RELEASE_FALLBACK, SHOTS, timeline, TYPE, withRelease, WIDTH } from "./shots.mjs";
import { soundDesign, stereoWavBytes } from "./sound.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const tokens = JSON.parse(readFileSync(join(REPO, "design", "system", "tokens.json"), "utf8"));
const colours = Object.fromEntries(tokens.color.tokens.map((token) => [token.name, token.value]));

function iconUrl(name, colour) {
	const body = iconBody(name);
	if (!body) throw new Error(`no icon ${name} in the design system's sprite`);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="240" height="240" color="${colour}">${body}</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Clip frames on disk, once per clip, and the picks as the page sees them. */
function assetsFor(build, { draft }) {
	const picksPath = [join(build, "picks.json"), join(HERE, "picks.json")].find((path) => existsSync(path));
	const picks = picksPath ? JSON.parse(readFileSync(picksPath, "utf8")) : {};
	const out = {};
	for (const [name, file] of Object.entries(picks)) {
		const known = ASSETS.find((asset) => asset.name === name);
		if (!known) throw new Error(`picks.json names ${name}, which shots.mjs does not have`);
		const source = join(build, file);
		if (!existsSync(source)) throw new Error(`picks.json: ${file} is not in ${build}`);
		// By the file and not the table: a clip not paid for yet can stand in as its opening still.
		if (/\.(png|jpe?g|webp)$/i.test(file)) {
			out[name] = { kind: "still", url: pathToFileURL(source).href };
			continue;
		}
		// By the file and not the picture's name: a retake of a clip must not play the frames of the take it replaced, which it did.
		const dir = join(build, "frames", `${file.split("/").pop().replace(/\.[^.]+$/, "")}-${draft ? "draft" : "full"}`);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			const done = spawnSync("ffmpeg", ["-v", "error", "-i", source, "-vf", `fps=${FPS},scale=${draft ? WIDTH / 2 : WIDTH}:-2`, "-q:v", "3", join(dir, "%04d.jpg")]);
			if (done.status !== 0) throw new Error(`ffmpeg could not extract ${file}: ${done.stderr.toString("utf8").slice(0, 300)}`);
		}
		out[name] = { kind: "clip", pattern: `${pathToFileURL(dir).href}/%04d.jpg`, frames: readdirSync(dir).length };
	}
	return out;
}

/** `window.FILM`: everything the page draws from. */
export function filmData({ beats, assets = {}, screens = {}, release = RELEASE_FALLBACK }) {
	const origin = beats[0];
	const timed = timeline(beats);
	const filled = withRelease(SHOTS, release);
	const icons = { box: "running-ink", spend: "ok-ink", done: "parked-ink", refused: "refused-ink", pr: "running-ink" };
	return {
		width: WIDTH,
		height: HEIGHT,
		fps: FPS,
		minType: MIN_TYPE,
		type: { ...TYPE },
		duration: timed.duration,
		doublings: [...DOUBLINGS],
		beats: beats.map((beat) => beat - origin),
		shots: timed.shots.map((time) => ({ ...filled.find((shot) => shot.id === time.id), ...time })),
		colours,
		sans: tokens.type.families.sans,
		mono: tokens.type.families.mono,
		icons: Object.fromEntries(Object.entries(icons).map(([name, token]) => [`icon-${name}`, iconUrl(name, colours[token].dark)])),
		assets,
		screens,
		release,
	};
}

/** The release's name, from a file git ignores, so the film can say it while this repository does not. */
function releaseFor(build) {
	const path = join(build, "release.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : RELEASE_FALLBACK;
}

const stamp = (seconds) => {
	const ms = Math.round(seconds * 1000);
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** The film's words as captions, from the same table as the picture. Beats count from the film's start, as the page does. */
export function captionsFor(data) {
	const period = (data.beats.at(-1) - data.beats[0]) / (data.beats.length - 1);
	const atBeat = (beat) => data.beats[Math.floor(beat)] + (beat - Math.floor(beat)) * period;
	const lines = data.shots.flatMap((shot) => shot.phrases.map((phrase) => ({
		from: atBeat(shot.startBeat + phrase.at),
		to: Math.min(data.duration, atBeat(shot.startBeat + Math.min(phrase.until, shot.beats))),
		words: phrase.words,
	})));
	return `${lines.map((line, i) => `${i + 1}\n${stamp(line.from)} --> ${stamp(line.to)}\n${line.words}\n`).join("\n")}`;
}

function parse(argv) {
	const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
	return {
		beats: flag("--beats") ?? join(HERE, "beats.json"),
		track: flag("--track"),
		out: flag("--out"),
		outDir: flag("--out-dir"),
		stills: flag("--stills")?.split(",").map(Number) ?? null,
		from: Number(flag("--from") ?? 0),
		to: flag("--to") === null ? null : Number(flag("--to")),
		build: resolve(flag("--build") ?? join(HERE, "build")),
		draft: argv.includes("--draft"),
	};
}

async function main(argv) {
	const opts = parse(argv);
	if (!existsSync(opts.beats)) throw new Error(`no beats at ${opts.beats}: run beats.mjs on the track first`);
	const measured = JSON.parse(readFileSync(opts.beats, "utf8"));
	mkdirSync(opts.build, { recursive: true });
	const page = join(opts.build, "page");
	mkdirSync(page, { recursive: true });
	const work = mkdtempSync(join(tmpdir(), "pi-film-"));
	const children = new Set();
	const origin0 = measured.beats[0];
	const screens = await renderScreens({ build: opts.build, beats: measured.beats.map((beat) => beat - origin0), draft: opts.draft, work, children, log: console.log });
	const data = filmData({ beats: measured.beats, assets: assetsFor(opts.build, { draft: opts.draft }), screens, release: releaseFor(opts.build) });
	writeFileSync(join(page, "film-data.js"), `window.FILM = ${JSON.stringify(data)};\n`);
	copyFileSync(join(HERE, "film.html"), join(page, "film.html"));
	copyFileSync(join(HERE, "film.js"), join(page, "film.js"));

	const browser = await openChrome({ chrome: process.env.CHROME ?? MAC_CHROME, work, children, stepMs: 120_000, env: { HOME: process.env.HOME }, captureStderr: true });
	let failed = null;
	try {
		const { sessionId, send, close } = await browser.openTarget();
		const problems = [];
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: opts.draft ? 0.5 : 1, mobile: false });
		const loaded = browser.event((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId, "load event");
		await send("Page.navigate", { url: pathToFileURL(join(page, "film.html")).href });
		await loaded;
		const seek = async (seconds) => {
			const answer = await send("Runtime.evaluate", { expression: `window.seek(${seconds})`, awaitPromise: true, returnByValue: true });
			if (answer.exceptionDetails) throw new Error(`at ${seconds.toFixed(2)} s: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
		};
		const shoot = async (format) => {
			const { data: picture } = await send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 92 } : {}), clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
			return Buffer.from(picture, "base64");
		};

		if (opts.stills) {
			const dir = resolve(opts.outDir ?? join(opts.build, "stills"));
			mkdirSync(dir, { recursive: true });
			for (const seconds of opts.stills) {
				await seek(seconds);
				const file = join(dir, `t${seconds.toFixed(2).padStart(5, "0")}.png`);
				writeFileSync(file, await shoot("png"));
				console.log(file);
			}
		} else {
			if (!opts.out) throw new Error("--out is required, or --stills");
			const end = opts.to ?? data.duration;
			const firstFrame = Math.round(opts.from * FPS);
			const lastFrame = Math.round(end * FPS);
			const format = opts.draft ? "jpeg" : "png";
			const origin = measured.beats[0];
			// The colour settings are spelled out because a player guesses without them, and sage paper is exactly the colour a
			// wrong guess shows up on. Full range JPEG frames would otherwise be tagged yuvj420p, which not everything plays.
			const soundPath = join(opts.build, "sound.wav");
			writeFileSync(soundPath, stereoWavBytes(soundDesign({ beats: measured.beats.map((beat) => beat - origin) })));
			// 48 kHz, said twice, because loudnorm resamples upward and AAC at 96 kHz is silent in some players, which it was.
			const audio = opts.track
				? ["-ss", String(origin + opts.from), "-i", opts.track, "-ss", String(opts.from), "-i", soundPath, "-filter_complex", "[1:a]volume=0.8[music];[2:a]volume=1[sound];[music][sound]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[mix]", "-map", "0:v", "-map", "[mix]", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest"]
				: [];
			const encoder = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", format === "jpeg" ? "mjpeg" : "png", "-i", "pipe:0", ...audio, "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", opts.draft ? "veryfast" : "slow", "-crf", opts.draft ? "24" : "16", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", resolve(opts.out)], { stdio: ["pipe", "inherit", "inherit"] });
			const encoded = new Promise((done, fail) => {
				encoder.once("exit", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
				encoder.once("error", fail);
			});
			const started = Date.now();
			for (let frame = firstFrame; frame < lastFrame; frame++) {
				await seek(frame / FPS);
				const picture = await shoot(format);
				if (!encoder.stdin.write(picture)) await new Promise((drained) => encoder.stdin.once("drain", drained));
				if ((frame - firstFrame) % (FPS * 5) === 0) console.log(`${(frame / FPS).toFixed(1)} s of ${(end).toFixed(1)}, ${((Date.now() - started) / 1000).toFixed(0)} s so far`);
			}
			encoder.stdin.end();
			await encoded;
			console.log(resolve(opts.out));
			const captions = captionsFor(data);
			writeFileSync(resolve(opts.out).replace(/\.mp4$/, ".srt"), captions);
		}
		if (problems.length) console.error(problems.join("\n"));
		await close();
	} catch (error) {
		failed = error;
	} finally {
		await browser.close().catch(() => {});
		for (const child of children) child.kill("SIGKILL");
		rmSync(work, { recursive: true, force: true });
	}
	if (failed) throw failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`compose: ${error.message}`);
		process.exit(1);
	});
}
