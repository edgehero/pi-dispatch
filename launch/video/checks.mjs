#!/usr/bin/env node
/**
 * What a rendered film has to hold, read from the file rather than from the recipe.
 *
 *   node launch/video/checks.mjs film.mp4
 *
 * The flash check is the reason this exists: cuts on the beat and glitch hits are the look, and a large flash more than
 * three times a second is the published limit for photosensitive viewers (WCAG 2.3.1). It is a simple reading of that
 * rule, on a small grey copy of each frame, so a pass here is a good sign and not a certification.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FPS, MAX_SECONDS } from "./shots.mjs";

const GRID_W = 64;
const GRID_H = 36;
/** A change of a tenth of full brightness, the rule's own threshold, and a quarter of the frame, the rule's own area. */
const STEP = 25.5;
const AREA = 0.25;
export const MAX_FLASHES_PER_SECOND = 3;

/**
 * The most flashes in any one second. A flash is a pair of opposing changes: a large part of the frame goes brighter and
 * then darker, or the other way. A hard cut alone changes once, so a cut on the beat is not a flash, but two cuts that
 * bounce between light and dark are.
 */
export function mostFlashesPerSecond(frames, fps = FPS) {
	const moves = [];
	for (let i = 1; i < frames.length; i++) {
		let up = 0;
		let down = 0;
		for (let p = 0; p < frames[i].length; p++) {
			const change = frames[i][p] - frames[i - 1][p];
			if (change >= STEP) up += 1;
			else if (change <= -STEP) down += 1;
		}
		const size = frames[i].length;
		if (up / size >= AREA) moves.push({ frame: i, way: 1 });
		else if (down / size >= AREA) moves.push({ frame: i, way: -1 });
	}
	const flashes = [];
	for (let i = 1; i < moves.length; i++) if (moves[i].way !== moves[i - 1].way) flashes.push(moves[i].frame);
	let most = 0;
	let start = 0;
	for (let end = 0; end < flashes.length; end++) {
		while (flashes[end] - flashes[start] >= fps) start += 1;
		most = Math.max(most, end - start + 1);
	}
	return most;
}

function greyFrames(path) {
	const done = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vf", `scale=${GRID_W}:${GRID_H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1024 ** 3 });
	if (done.status !== 0) throw new Error(`ffmpeg could not read ${path}: ${done.stderr.toString("utf8").slice(0, 300)}`);
	const size = GRID_W * GRID_H;
	const frames = [];
	for (let at = 0; at + size <= done.stdout.length; at += size) frames.push(done.stdout.subarray(at, at + size));
	return frames;
}

/** The file's average level. A track that is present but silent passes every other check here. */
function meanVolume(path) {
	const done = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"], { maxBuffer: 1024 ** 3 });
	const match = done.stderr.toString("utf8").match(/mean_volume: (-?[\d.]+) dB/);
	return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

function probe(path) {
	const done = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,pix_fmt,width,height,sample_rate", "-of", "json", path]);
	if (done.status !== 0) throw new Error(`ffprobe could not read ${path}`);
	return JSON.parse(done.stdout.toString("utf8"));
}

/** `moov` before `mdat` is what lets a page start playing before the whole file has arrived. */
function isFaststart(path) {
	const done = spawnSync("ffprobe", ["-v", "trace", path], { maxBuffer: 1024 ** 3 });
	const text = done.stderr.toString("utf8");
	const moov = text.indexOf("type:'moov'");
	const mdat = text.indexOf("type:'mdat'");
	return moov >= 0 && mdat >= 0 && moov < mdat;
}

export function judge(path) {
	const info = probe(path);
	const video = info.streams.find((stream) => stream.codec_type === "video");
	const audio = info.streams.find((stream) => stream.codec_type === "audio");
	const seconds = Number(info.format.duration);
	const flashes = mostFlashesPerSecond(greyFrames(path));
	const loudness = meanVolume(path);
	return [
		[seconds <= MAX_SECONDS, `${seconds.toFixed(2)} s, at most ${MAX_SECONDS}`],
		[video?.codec_name === "h264" && video?.pix_fmt === "yuv420p", `${video?.codec_name} ${video?.pix_fmt}, must be h264 yuv420p to play everywhere`],
		[audio?.codec_name === "aac", `audio ${audio?.codec_name ?? "none"}`],
		[Number(audio?.sample_rate) <= 48000, `audio at ${Number(audio?.sample_rate) / 1000} kHz, at most 48: AAC at 96 is silent in some players`],
		[loudness >= -30, `audio averages ${loudness} dB, so a viewer can hear it`],
		[isFaststart(path), "starts playing before the whole file has arrived"],
		[flashes <= MAX_FLASHES_PER_SECOND, `at most ${flashes} large flashes in any second, limit ${MAX_FLASHES_PER_SECOND}`],
		[true, `${video?.width}x${video?.height}, ${(Number(info.format.size) / 1024 / 1024).toFixed(1)} MB`],
	];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const results = judge(process.argv[2]);
	for (const [ok, what] of results) console.log(`${ok ? "pass" : "FAIL"}  ${what}`);
	if (results.some(([ok]) => !ok)) process.exit(1);
}
