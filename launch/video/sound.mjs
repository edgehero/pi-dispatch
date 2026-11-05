/**
 * The film's sound design, drawn in code like its pictures, so every hit lands on the frame it belongs to and a retimed shot takes
 * its sound along. The music is the track; this is what the picture does: a heartbeat under the first agent, a ping for each
 * doubling, the rush as the swarm falls in on itself, the explosion on the drop, night under the time-lapse, and clicks for the
 * screens. A pure function of the beats, with seeded noise, so two renders match.
 */
import { DOUBLINGS, SHOTS, TAIL_SECONDS, totalBeats } from "./shots.mjs";

export const SOUND_RATE = 48000;

export function soundDesign({ beats, shots = SHOTS, rate = SOUND_RATE, tail = TAIL_SECONDS }) {
	const total = totalBeats(shots);
	const origin = beats[0];
	const period = (beats.at(-1) - origin) / (beats.length - 1);
	const at = (beat) => {
		if (beat <= 0) return beat * period;
		const whole = Math.floor(beat);
		if (whole + 1 >= beats.length) return beats.at(-1) - origin + (beat - beats.length + 1) * period;
		return beats[whole] - origin + (beat - whole) * (beats[whole + 1] - beats[whole]);
	};
	const seconds = at(total) + tail;
	const length = Math.ceil(seconds * rate);
	const left = new Float32Array(length);
	const right = new Float32Array(length);
	const startOf = new Map();
	let running = 0;
	for (const shot of shots) {
		startOf.set(shot.id, running);
		running += shot.beats;
	}

	let seed = 271828;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const noise = () => random() * 2 - 1;

	/** Adds `sample(t, p)` from a second, for a length, panned from -1 to 1. `p` runs 0 to 1 over the length. */
	function add(start, span, gain, sample, pan = 0) {
		const first = Math.max(0, Math.floor(start * rate));
		const count = Math.floor(span * rate);
		const toLeft = gain * Math.cos(((pan + 1) * Math.PI) / 4);
		const toRight = gain * Math.sin(((pan + 1) * Math.PI) / 4);
		for (let i = 0; i < count && first + i < length; i++) {
			const value = sample(i / rate, i / count);
			left[first + i] += toLeft * value;
			right[first + i] += toRight * value;
		}
	}
	const tone = (freq) => (t) => Math.sin(2 * Math.PI * freq * t);
	/** A sound's own shape: a quick rise so it does not click, then an exponential fall. */
	const env = (t, fall, rise = 0.004) => Math.min(1, t / rise) * Math.exp(-t * fall);

	const thump = (start, gain, freq = 52) => add(start, 0.5, gain, (t) => env(t, 9, 0.008) * Math.sin(2 * Math.PI * (freq * t + (28 * (1 - Math.exp(-t * 22))) / 22)));
	const tick = (start, gain, pan = 0, freq = 1500) => add(start, 0.09, gain, (t) => env(t, 70, 0.001) * (Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(2 * Math.PI * freq * 2.03 * t)), pan);
	const key = (start, gain) => {
		const pan = random() * 0.5 - 0.25;
		add(start, 0.05, gain, (t) => env(t, 170, 0.0005) * noise(), pan);
		add(start, 0.04, gain * 0.6, (t) => env(t, 120, 0.001) * Math.sin(2 * Math.PI * (900 + 300 * random()) * t), pan);
	};
	/** Filtered noise that follows a shape, for wind, rushes and tails. `bright` is the one-pole filter's reach, 0 to 1, over time. */
	function wash(start, span, gain, shape, bright = () => 0.2, pan = 0) {
		let low = 0;
		add(start, span, gain, (t, p) => {
			low += (noise() - low) * bright(p);
			return low * shape(p, t);
		}, pan);
	}

	// The first agent's heartbeat, until it splits.
	for (let beat = 0; beat < DOUBLINGS[0]; beat++) {
		thump(at(beat), 0.55);
		thump(at(beat) + 0.17, 0.3, 44);
	}

	// A ping for each doubling, climbing. As the count grows each one brings more small lights with it, spread across the stereo field.
	DOUBLINGS.forEach((beat, generation) => {
		const start = at(beat);
		const freq = 196 * 2 ** (generation / 5);
		add(start, 1, 0.26, (t) => env(t, 5) * (tone(freq)(t) + 0.4 * tone(freq * 2)(t)), generation % 2 ? 0.3 : -0.3);
		const lights = Math.min(70, 2 ** generation);
		const span = (DOUBLINGS[generation + 1] ?? beat + 1) - beat;
		for (let i = 0; i < lights; i++) tick(at(beat + random() * span), 0.05 + 0.05 / Math.sqrt(lights), random() * 1.6 - 0.8, 1800 + random() * 3600);
	});

	// The swarm's hum grows with it, then rushes inward through the near silence, and stops dead just before the drop.
	const drop = startOf.get("burst");
	wash(at(DOUBLINGS[4]), at(drop - 4) - at(DOUBLINGS[4]), 0.5, (p) => p ** 1.6, (p) => 0.05 + 0.2 * p, -0.15);
	wash(at(DOUBLINGS[4]), at(drop - 4) - at(DOUBLINGS[4]), 0.5, (p) => p ** 1.6, (p) => 0.05 + 0.2 * p, 0.15);
	wash(at(drop - 4), at(drop) - at(drop - 4) - 0.05, 0.75, (p) => p ** 3, (p) => 0.04 + 0.7 * p ** 2);

	// The explosion: a sub falling away, a burst of air, and a long tail.
	const boom = at(drop);
	add(boom, 3.2, 1.05, (t) => env(t, 1.4, 0.003) * Math.sin(2 * Math.PI * (34 * t + (70 * (1 - Math.exp(-t * 9))) / 9)));
	wash(boom, 1.8, 0.9, (p, t) => env(t, 3.2, 0.002), (p) => 0.75 - 0.6 * p, -0.25);
	wash(boom, 1.8, 0.9, (p, t) => env(t, 3.2, 0.002), (p) => 0.75 - 0.6 * p, 0.25);
	wash(boom, 5, 0.3, (p) => (1 - p) ** 2, () => 0.08, -0.5);
	wash(boom, 5, 0.3, (p) => (1 - p) ** 2, () => 0.08, 0.5);
	// The three lines under the name land with a soft knock each.
	for (const phrase of shots.find((shot) => shot.id === "burst").phrases.slice(2)) thump(at(drop + phrase.at), 0.32, 88);

	// A whole day going by: a rush as the time-lapse starts, wind, and crickets while it is night.
	const always = startOf.get("always");
	wash(at(always), at(always + 6) - at(always), 0.28, (p) => Math.sin(Math.PI * p), (p) => 0.05 + 0.12 * Math.sin(Math.PI * p));
	const nightFrom = at(always + 1.8);
	const nightTo = at(always + 4.2);
	for (let t = nightFrom; t < nightTo; t += 0.15) add(t, 0.06, 0.03, (s) => env(s, 30, 0.004) * tone(4400 + 200 * Math.sin(t * 9))(s), Math.sin(t * 4) * 0.5);
	thump(at(always + 6), 0.4, 70);

	// The product arrives: the person's pill, then the tool's.
	const turn = startOf.get("turn");
	tick(at(turn), 0.2, 0, 880);
	thump(at(turn), 0.3, 110);
	tick(at(turn + 4), 0.26, 0, 1320);
	thump(at(turn + 4), 0.4, 130);

	// A click as each row of the real cards lands, at the beats `screen-motion.js` brings it in.
	for (let i = 0; i < 3; i++) tick(at(startOf.get("machines") + 0.3 + i * 0.7), 0.14);
	for (let i = 0; i < 2; i++) tick(at(startOf.get("models") + 0.4 + i), 0.14);
	for (let i = 0; i < 3; i++) tick(at(startOf.get("rules") + i * 0.9), 0.14);

	// Wax closing over the cell, then the seal.
	const box = startOf.get("box");
	wash(at(box), at(box + 3.5) - at(box), 0.2, (p) => p, () => 0.04);
	thump(at(box + 3.4), 0.55, 62);

	// The meter climbing, and the job turned away.
	const limits = startOf.get("limits");
	add(at(limits), at(limits + 2) - at(limits), 0.09, (t, p) => Math.sin(2 * Math.PI * (280 + 340 * p) * t) * p);
	thump(at(limits + 2.2), 0.65, 66);
	tick(at(limits + 2.2), 0.14, 0, 420);

	// Typing, at the rate the screens type: the answer, then the steer.
	const asks = startOf.get("asks");
	for (let i = 0; i < 39; i++) key(at(asks + 3 + i / 15), 0.1);
	const page = startOf.get("page");
	for (let i = 0; i < 51; i++) key(at(page + 3.2 + i / 23), 0.1);
	tick(at(page + 3 + 2.5), 0.18);

	// The one row under the marker, ringing once.
	const number = startOf.get("number");
	add(at(number + 5), 1.6, 0.14, (t) => env(t, 3) * (tone(880)(t) + 0.5 * tone(1320)(t)));

	// Dawn: a few birds, then one warm chord as the words about deciding land, where the music falls away.
	const morning = startOf.get("morning");
	for (let i = 0; i < 7; i++) {
		const start = at(morning + i * 0.5 + random() * 0.2);
		const base = 2600 + random() * 1400;
		add(start, 0.16, 0.035, (t, p) => env(t, 12, 0.01) * Math.sin(2 * Math.PI * (base * t + 500 * Math.sin(p * 9) * t)), random() * 1.2 - 0.6);
	}
	for (const freq of [110, 164.81, 220, 329.63]) add(at(morning + 4), 3.4, 0.09, (t) => Math.min(1, t / 0.08) * Math.exp(-t * 1.1) * tone(freq)(t));

	// The name on the last card.
	for (const freq of [220, 329.63, 440, 659.25]) add(at(startOf.get("end")), 2.6, 0.05, (t) => env(t, 1.6, 0.01) * tone(freq)(t));

	return { left, right, rate, seconds };
}

/** A 16 bit stereo WAV, peak limited so a pile of hits cannot clip. */
export function stereoWavBytes({ left, right, rate }) {
	let peak = 0;
	for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
	const scale = peak > 0.98 ? 0.98 / peak : 1;
	const data = Buffer.alloc(left.length * 4);
	for (let i = 0; i < left.length; i++) {
		data.writeInt16LE(Math.round(left[i] * scale * 32767), i * 4);
		data.writeInt16LE(Math.round(right[i] * scale * 32767), i * 4 + 2);
	}
	const head = Buffer.alloc(44);
	head.write("RIFF", 0);
	head.writeUInt32LE(36 + data.length, 4);
	head.write("WAVEfmt ", 8);
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20);
	head.writeUInt16LE(2, 22);
	head.writeUInt32LE(rate, 24);
	head.writeUInt32LE(rate * 4, 28);
	head.writeUInt16LE(4, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36);
	head.writeUInt32LE(data.length, 40);
	return Buffer.concat([head, data]);
}
