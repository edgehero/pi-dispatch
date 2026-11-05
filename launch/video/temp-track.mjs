#!/usr/bin/env node
/**
 * A placeholder track, synthesised here, so the animatic can be judged for its rhythm without a key and without paying.
 * It follows the shot table's sections at the target tempo. It is a guide for the edit and never the film's music.
 *
 *   node launch/video/temp-track.mjs <out.wav>
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SHOTS, TEMPO_TARGET, TAIL_SECONDS, totalBeats } from "./shots.mjs";

const RATE = 44100;

/** Mono samples in -1..1. Pure, and the same every run, because its noise is seeded. */
export function synthesise({ bpm = TEMPO_TARGET, shots = SHOTS } = {}) {
	const beat = 60 / bpm;
	const total = totalBeats(shots);
	const seconds = total * beat + TAIL_SECONDS;
	const out = new Float32Array(Math.ceil(seconds * RATE));
	const startOf = new Map();
	let at = 0;
	for (const shot of shots) {
		startOf.set(shot.id, at);
		at += shot.beats;
	}
	const drop = startOf.get("burst");
	const fall = startOf.get("morning");
	const end = startOf.get("end");
	const arp = startOf.get("always");

	let seed = 12345;
	const noise = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2147483648 - 1;
	};
	const add = (start, length, gain, sample) => {
		const first = Math.floor(start * RATE);
		const count = Math.floor(length * RATE);
		for (let i = 0; i < count && first + i < out.length; i++) out[first + i] += gain * sample(i / RATE);
	};
	const pluck = (start, freq, gain, decay = 7) => add(start, 1.2, gain, (t) => Math.exp(-t * decay) * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t)));
	const kick = (start, gain) => add(start, 0.32, gain, (t) => Math.exp(-t * 11) * Math.sin(2 * Math.PI * (48 * t + (90 * (1 - Math.exp(-t * 34))) / 34)));
	const hat = (start, gain) => add(start, 0.06, gain, (t) => Math.exp(-t * 80) * noise());

	const scale = [110, 130.81, 146.83, 164.81, 196, 220];
	for (let b = 0; b < total; b++) {
		const t = b * beat;
		const bar = Math.floor(b / 4);
		if (b < drop - 2) add(t, 0.03, 0.05, (s) => Math.exp(-s * 200) * noise());
		if (b % 4 === 0 && (b < drop || b >= fall)) pluck(t, scale[bar % 3] * 2, b >= fall ? 0.26 : 0.3, 4);
		if (b >= drop && b < fall) {
			kick(t, 0.9);
			hat(t + beat / 2, 0.22);
			const root = scale[[0, 0, 3, 2][bar % 4]] / 2;
			for (const eighth of [0, 0.5]) add(t + eighth * beat, beat * 0.45, 0.28, (s) => Math.exp(-s * 5) * Math.sin(2 * Math.PI * root * s));
			if (b >= arp) hat(t + beat / 4, 0.06);
		}
		if (b >= arp && b < fall) for (let s = 0; s < 4; s++) pluck(t + (s * beat) / 4, scale[(b * 3 + s * 2) % scale.length] * 4, 0.1, 14);
	}

	// A low drone that rises through the tension, and a noise riser that stops one bar short of the drop.
	const riseFrom = (drop - 12) * beat;
	const riseTo = (drop - 2) * beat;
	add(0, seconds, 1, (t) => {
		const swell = t < riseFrom ? 0.07 : t < drop * beat ? 0.07 + (0.12 * (t - riseFrom)) / (drop * beat - riseFrom) : t < fall * beat ? 0.05 : Math.max(0, 0.09 * (1 - (t - fall * beat) / (seconds - fall * beat)));
		return swell * (Math.sin(2 * Math.PI * 55 * t) + 0.5 * Math.sin(2 * Math.PI * 82.5 * t));
	});
	let low = 0;
	add(riseFrom, riseTo - riseFrom, 1, (t) => {
		const part = t / (riseTo - riseFrom);
		low += (noise() - low) * (0.02 + 0.5 * part * part);
		return 0.35 * part * low;
	});

	// One last chord on the final beat, ringing out.
	for (const freq of [110, 164.81, 220, 261.63, 329.63]) add((end + 7) * beat, Math.min(3, seconds - (end + 7) * beat), 0.14, (t) => Math.exp(-t * 1.6) * Math.sin(2 * Math.PI * freq * t));
	if (end) kick((end + 7) * beat, 0.6);

	let peak = 0;
	for (const sample of out) peak = Math.max(peak, Math.abs(sample));
	for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.89;
	return { samples: out, rate: RATE };
}

/** A 16 bit mono WAV. */
export function wavBytes(samples, rate) {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
	const head = Buffer.alloc(44);
	head.write("RIFF", 0);
	head.writeUInt32LE(36 + data.length, 4);
	head.write("WAVEfmt ", 8);
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20);
	head.writeUInt16LE(1, 22);
	head.writeUInt32LE(rate, 24);
	head.writeUInt32LE(rate * 2, 28);
	head.writeUInt16LE(2, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36);
	head.writeUInt32LE(data.length, 40);
	return Buffer.concat([head, data]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const out = process.argv[2];
	if (!out) {
		console.error("usage: temp-track.mjs <out.wav>");
		process.exit(1);
	}
	const { samples, rate } = synthesise();
	writeFileSync(out, wavBytes(samples, rate));
	console.log(`${out}: ${(samples.length / rate).toFixed(2)} s, a placeholder, not the film's music`);
}
