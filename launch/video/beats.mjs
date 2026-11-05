#!/usr/bin/env node
/**
 * The tempo and beats of a track, measured from its sound. The edit is cut to this, not to what the track was asked for:
 * Google documents BPM as a prompt hint only, and a shot table timed to the hint would drift off the music.
 *
 *   node launch/video/beats.mjs <track> [--out beats.json] [--start-beat N] [--allow-drift]
 *
 * No dependency: ffmpeg decodes, and `measureBeats` is a pure function over samples, so a test feeds it clicks. A track
 * whose beat wanders is refused rather than cut to, since every cut after the wander would land off the music.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOP = 256;
const WINDOW = 1024;
/** How far a window's beat may stray from the grid, peak to peak, in seconds. About one frame at 24 per second either way. */
export const MAX_DRIFT_SECONDS = 0.08;

/** Half-wave rectified change in log energy per hop, less its local mean, so a loud section does not outvote a quiet one. */
export function onsetEnvelope(samples, rate) {
	const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP));
	const logEnergy = new Float64Array(frames);
	for (let f = 0; f < frames; f++) {
		let energy = 0;
		for (let i = 0; i < WINDOW; i++) energy += samples[f * HOP + i] ** 2;
		logEnergy[f] = Math.log(1e-6 + energy / WINDOW);
	}
	const flux = new Float64Array(frames);
	for (let f = 1; f < frames; f++) flux[f] = Math.max(0, logEnergy[f] - logEnergy[f - 1]);
	const reach = Math.round((0.25 * rate) / HOP);
	const out = new Float64Array(frames);
	let sum = 0;
	for (let f = 0; f < frames; f++) {
		sum += flux[f];
		if (f > 2 * reach) sum -= flux[f - 2 * reach - 1];
		const held = Math.min(f, 2 * reach) + 1;
		const centre = f - Math.min(f, reach);
		out[centre] = Math.max(0, flux[centre] - sum / held);
	}
	return out;
}

function interpolate(values, position) {
	const low = Math.floor(position);
	if (low < 0 || low + 1 >= values.length) return 0;
	const part = position - low;
	return values[low] * (1 - part) + values[low + 1] * part;
}

/**
 * The tempo whose multiples best fit the envelope's autocorrelation. Several multiples are summed for resolution, and a
 * weight toward `prefer` settles the octave question (a track at 124 is also a perfectly good 62), since nothing in the
 * signal alone can.
 */
function bestPeriod(envelope, framesPerSecond, { min = 70, max = 180, prefer = 124 } = {}) {
	const longest = Math.ceil((8 * 60 * framesPerSecond) / min) + 2;
	const auto = new Float64Array(longest);
	for (let lag = 1; lag < longest; lag++) {
		let sum = 0;
		for (let i = 0; i + lag < envelope.length; i++) sum += envelope[i] * envelope[i + lag];
		auto[lag] = sum / Math.max(1, envelope.length - lag);
	}
	let best = { score: -Infinity, bpm: prefer };
	for (let bpm = min; bpm <= max; bpm += 0.05) {
		const lag = (60 * framesPerSecond) / bpm;
		let score = 0;
		for (let k = 1; k <= 8; k++) score += interpolate(auto, k * lag);
		const octaves = Math.log2(bpm / prefer);
		score *= Math.exp(-(octaves * octaves) / (2 * 0.5 * 0.5));
		if (score > best.score) best = { score, bpm };
	}
	return (60 * framesPerSecond) / best.bpm;
}

/** The offset within one period whose grid lands on the most onset, over the frames from `from` to `to`. */
function bestPhase(envelope, period, from = 0, to = envelope.length) {
	let best = { score: -Infinity, offset: 0 };
	for (let offset = 0; offset < period; offset += 0.25) {
		let score = 0;
		for (let position = from + offset; position < to; position += period) score += interpolate(envelope, position);
		if (score > best.score) best = { score, offset: from + offset };
	}
	return best.offset;
}

/**
 * Autocorrelation peaks sit on whole frames, so it leans toward a tempo with a whole number of frames per beat: a track at
 * 140 read as 139.7, which over a minute slides the last cut by more than a frame. The whole grid's fit has no such lean,
 * because its beats fall all over the frames, so the final answer is the nearby period the most onset lands on.
 */
function refinePeriod(envelope, start) {
	let best = { score: -Infinity, period: start };
	for (let period = start * 0.99; period <= start * 1.01; period += start * 0.0002) {
		const offset = bestPhase(envelope, period);
		let score = 0;
		for (let position = offset; position < envelope.length; position += period) score += interpolate(envelope, position);
		if (score > best.score) best = { score, period };
	}
	return best.period;
}

/** `{ bpm, duration, beats, drift, steady, barEnergy }` for mono samples. */
export function measureBeats(samples, rate, { prefer = 124 } = {}) {
	const envelope = onsetEnvelope(samples, rate);
	const framesPerSecond = rate / HOP;
	const period = refinePeriod(envelope, bestPeriod(envelope, framesPerSecond, { prefer }));
	const offset = bestPhase(envelope, period);

	// Is one grid true of the whole track? Each eight bar window's own best phase, against the grid's.
	const windowFrames = period * 32;
	const strays = [];
	for (let from = 0; from + windowFrames <= envelope.length; from += windowFrames) {
		const local = bestPhase(envelope, period, from, from + windowFrames);
		let stray = (local - offset) % period;
		if (stray > period / 2) stray -= period;
		if (stray < -period / 2) stray += period;
		strays.push(stray / framesPerSecond);
	}
	const drift = strays.length ? Math.max(...strays) - Math.min(...strays) : 0;

	const seconds = samples.length / rate;
	const beatSeconds = period / framesPerSecond;
	// A rise in energy shows when new samples enter a window, at its end, so a frame's onset is at its window's end. Timing
	// by its start put every beat about 50 ms early, which is a cut one or two frames ahead of the music.
	let first = (offset + WINDOW / HOP) / framesPerSecond;
	// A beat in the very first window has nothing before it to rise from, so the grid is walked back to it. A film that
	// started a beat late would have every section one beat off its music.
	while (first - beatSeconds > -0.06) first -= beatSeconds;
	first = Math.max(0, first);
	const beats = [];
	for (let t = first; t < seconds; t += beatSeconds) beats.push(Math.round(t * 10000) / 10000);

	// Loudness per four beat bar, which is where a track's sections show, for placing the film's start against them.
	const barEnergy = [];
	for (let b = 0; b + 4 < beats.length; b += 4) {
		const start = Math.floor(beats[b] * rate);
		const end = Math.floor(beats[b + 4] * rate);
		let sum = 0;
		for (let i = start; i < end; i++) sum += samples[i] ** 2;
		barEnergy.push(Math.round(Math.sqrt(sum / Math.max(1, end - start)) * 1000) / 1000);
	}
	return { bpm: Math.round((60 / beatSeconds) * 100) / 100, duration: Math.round(seconds * 1000) / 1000, beats, drift: Math.round(drift * 10000) / 10000, steady: drift <= MAX_DRIFT_SECONDS, barEnergy };
}

/** Mono samples at 22,050 per second, through ffmpeg. A track it cannot read is named, rather than measured as silence. */
export function decodeTrack(path, rate = 22050) {
	const done = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { maxBuffer: 1024 ** 3 });
	if (done.error) throw new Error(`could not start ffmpeg to read ${path}: ${done.error.message}`);
	if (done.status !== 0) throw new Error(`ffmpeg could not read ${path}: ${done.stderr.toString("utf8").trim().slice(0, 300)}`);
	const bytes = done.stdout;
	return { samples: new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)), rate };
}

async function main(argv) {
	const [path, ...rest] = argv;
	if (!path) throw new Error("usage: beats.mjs <track> [--out beats.json] [--start-beat N] [--allow-drift]");
	const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
	const { samples, rate } = decodeTrack(path);
	const measured = measureBeats(samples, rate);
	console.log(`${path}: ${measured.bpm} BPM, ${measured.duration} s, ${measured.beats.length} beats, drift ${measured.drift} s`);
	console.log(`loudness per bar: ${measured.barEnergy.join(" ")}`);
	if (!measured.steady && !rest.includes("--allow-drift")) throw new Error(`the beat wanders by ${measured.drift} s, more than ${MAX_DRIFT_SECONDS} s: refusing to cut to it. Pick another take, or pass --allow-drift to look at it anyway.`);
	const startBeat = Number(flag("--start-beat") ?? 0);
	if (!Number.isInteger(startBeat) || startBeat < 0 || startBeat >= measured.beats.length) throw new Error(`--start-beat must be a beat of this track, 0 to ${measured.beats.length - 1}`);
	const out = flag("--out");
	if (out) writeFileSync(out, `${JSON.stringify({ track: path.split("/").pop(), ...measured, startBeat, beats: measured.beats.slice(startBeat) }, null, "\t")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`beats: ${error.message}`);
		process.exit(1);
	});
}
