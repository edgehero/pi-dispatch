/**
 * The one minute film, as one table: what is on screen, for how many beats, in which words, and which generated pictures
 * it asks for. Importable without Chrome or a key, so `admin/test/video.test.mjs` can hold the words to the same rules as
 * the README and its pictures. `compose.mjs` draws from it, and `generate.mjs` pays for what it names.
 *
 * Time is counted in beats, never seconds, because the edit is cut to a track and a track's tempo is measured, not
 * chosen: Google documents BPM as a prompt hint only. A shot says how many beats it lasts, and `timeline()` turns that
 * into seconds from the beats `beats.mjs` measured.
 *
 * The metaphor is in the pictures and the product is in the words. Nothing here says bee.
 */

export const FPS = 24;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const BEATS_PER_BAR = 4;
export const MAX_SECONDS = 60;
/** What a track is asked for, and what the chosen take measured: 31 bars at 125 BPM is 59.5 s. */
export const TEMPO_TARGET = 125;
export const TAIL_SECONDS = 0.35;
/** A viewer reads about this fast with music on. A slower phrase can stay longer, a faster one is not read at all. */
export const MAX_WORDS_PER_SECOND = 3;
/**
 * Type that carries meaning, on the 1920 canvas. GitHub on a phone shows a video about 358 px wide, so 48 px becomes
 * about 9 px, the same floor the README's pictures hold. Tiny source text and code boxes are texture and say nothing a
 * viewer needs, so they are exempt.
 */
export const MIN_TYPE = 48;
export const TYPE = Object.freeze({ title: 400, huge: 148, big: 112, line: 84, chip: 56, tick: 48 });

/** The film's one running element: the three stages as the console's own nav pills. They are the README's stages. */
const IN = "In the loop";
const NEAR = "Near the loop";
const OUT = "Out of the loop";

/**
 * `phrases`: the words, from beat `at` until beat `until`, both counted from the shot's start.
 * `media`: a generated picture on screen from beat `from` until beat `to`, a clip played at `rate` times its speed and from `start` seconds if given.
 * Everything else is drawn.
 * `screens`: a real console page, dark and moving, from beat `from` until beat `to` (`screens.mjs` renders it). `real` says
 * so. The frames carry no "Sample data." line, at the owner's request: the README's caption says it instead.
 * `cinema`: full bleed, letterboxed, with no console shell: the film's own world rather than the product's.
 * `punch`: the whole frame takes each kick. `glitches`: `[beat, beats long, amount]`, one flash of datamosh each.
 * `{name}` and `{version}` are the release's, filled in at render from `release.json` in the build folder, so
 * the release's name is in the film and not in this repository.
 */
export const SHOTS = Object.freeze([
	{
		// The cold open, and all of the track's intro. One light in the dark, doubling on the beat while the camera pulls back and
		// the world appears around it. It falls in on itself in the track's near-silent bar, so the drop is the explosion.
		id: "open",
		cinema: true,
		beats: 24,
		stage: IN,
		phrases: [{ words: "One AI coding agent.", at: 0, until: 4 }],
		media: [{ asset: "night-sky", from: 10, to: 24 }],
	},
	{
		// The drop lands on the release's name, and the next line says what it is: an update to this product, in plain words. Then
		// what makes a swarm safe to run, and the rest of the film proves those three lines in order.
		id: "burst",
		cinema: true,
		punch: true,
		beats: 12,
		stage: NEAR,
		phrases: [
			{ words: "{name}", at: 0, until: 12 },
			{ words: "The new pi-dispatch {version} update.", at: 2, until: 12 },
			{ words: "In a box.", at: 6, until: 12 },
			{ words: "On a budget.", at: 8, until: 12 },
			{ words: "You decide.", at: 10, until: 12 },
		],
		media: [{ asset: "night-sky", from: 0, to: 12, start: 7.9 }],
	},
	{
		id: "always",
		cinema: true,
		beats: 8,
		phrases: [
			{ words: "A whole swarm.", at: 0, until: 8 },
			{ words: "Working 24/7.", at: 3, until: 8 },
		],
		media: [
			{ asset: "timelapse", from: 0, to: 6, rate: 2 },
			{ asset: "dark-hive", from: 6, to: 8 },
		],
	},
	{
		// The turn from the spectacle to the product: what this is, in the fewest words.
		id: "turn",
		beats: 7,
		stage: IN,
		phrases: [
			{ words: "You can't watch them all.", at: 0, until: 3.5 },
			{ words: "pi-dispatch manages it all.", at: 3.5, until: 7 },
		],
	},
	{
		id: "machines",
		beats: 4,
		real: true,
		screens: [{ name: "machines", from: 0, to: 4 }],
		phrases: [{ words: "All your machines.", at: 0, until: 4 }],
	},
	{
		id: "models",
		beats: 4,
		real: true,
		screens: [{ name: "models", from: 0, to: 4 }],
		phrases: [{ words: "All your models.", at: 0, until: 4 }],
	},
	{
		id: "rules",
		beats: 4,
		real: true,
		screens: [{ name: "rules", from: 0, to: 4 }],
		phrases: [{ words: "All set by you.", at: 0, until: 4 }],
	},
	{
		id: "box",
		punch: true,
		beats: 4,
		phrases: [{ words: "Each job, its own box.", at: 0, until: 4 }],
		media: [{ asset: "wax-cap", from: 0, to: 4, rate: 3 }],
	},
	{
		id: "limits",
		punch: true,
		beats: 5,
		stage: NEAR,
		phrases: [
			{ words: "Over a spending limit?", at: 0, until: 5 },
			{ words: "It does not start.", at: 1.5, until: 5 },
			{ words: "No AI cost.", at: 2.8, until: 5 },
		],
	},
	{
		id: "asks",
		beats: 6,
		real: true,
		screens: [{ name: "question", from: 0, to: 6 }],
		phrases: [
			{ words: "Stuck?", at: 0, until: 6 },
			{ words: "It stops and asks you.", at: 1.5, until: 6 },
		],
	},
	{
		id: "number",
		beats: 7,
		real: true,
		screens: [{ name: "zero", from: 0, to: 7 }],
		phrases: [
			// Zero touch's rate is a guide and not a trigger, so nothing here says the number moves you.
			{ words: "How often it needs you.", at: 0, until: 7 },
			{ words: "You choose when to step back.", at: 2.8, until: 7 },
		],
	},
	{
		// The whole overview page, the one screen the film does not trim, so what it looks after is clear before the morning.
		id: "page",
		beats: 15,
		real: true,
		screens: [
			{ name: "overview", from: 0, to: 10 },
			{ name: "steer", from: 10, to: 15 },
		],
		phrases: [{ words: "Watch and steer from one page.", at: 0, until: 15 }],
	},
	{
		id: "morning",
		beats: 8,
		stage: OUT,
		phrases: [
			{ words: "Morning. The work is waiting.", at: 0, until: 4 },
			{ words: "You decide what ships.", at: 4, until: 8 },
		],
		media: [{ asset: "keeper-frame", from: 0, to: 4 }],
	},
	{
		id: "end",
		cinema: true,
		beats: 8,
		stage: OUT,
		phrases: [
			{ words: "pi-dispatch", at: 1.2, until: 12 },
			{ words: "Manage your swarm of pi coding agents.", at: 2, until: 12 },
			{ words: "Open source. Your machines, your models.", at: 3.5, until: 12 },
			{ words: "github.com/edgehero/pi-dispatch", at: 5, until: 12 },
		],
	},
]);

/**
 * The film's beats each doubling of the swarm lands on: on the bar, then the beat, then the half beat, because an explosion
 * accelerates. The picture and the sound both read this.
 */
export const DOUBLINGS = Object.freeze([4, 6, 8, 10, 11, 12, 13, 14, 15, 15.5, 16, 16.5, 17, 17.5, 18]);

/** What fills the table's placeholders when the build folder has no `release.json`: the version, and no name. */
export const RELEASE_FALLBACK = Object.freeze({ version: "5.0", name: "5.0" });

/** The table with its placeholders filled. A placeholder nobody knows stops here, rather than reaching the screen. */
export function withRelease(shots = SHOTS, release = RELEASE_FALLBACK) {
	const fill = (words) => words.replace(/\{([a-z]+)\}/g, (whole, key) => {
		if (typeof release[key] !== "string") throw new Error(`shots.mjs asks for ${whole}, which release.json does not have`);
		return release[key];
	});
	return shots.map((shot) => ({ ...shot, phrases: shot.phrases.map((phrase) => ({ ...phrase, words: fill(phrase.words) })) }));
}

/** Every generated picture says this, because models garble words and an invented screen would misrepresent the product. */
export const NO_WORDS = "No text, no letters, no numbers, no logos, no watermarks, no captions, no user interface, no faces.";

/** The look, in words: the reference itself is never sent to a model. */
const FILMIC = "Cinematic film still, shot on anamorphic lenses, natural light, deep blacks, restrained colour, fine film grain, shallow depth of field.";

/**
 * The pictures to pay for. A `still` is one image, and with `frameFor` it opens that clip, so the look holds between them. A
 * `clip` is a few seconds of video with no sound, because the track is ours. `seed` is here so a retake is a deliberate change
 * to this table, which also changes its cache key. The swarm itself is never generated: it is drawn, so its count is exact.
 */
export const ASSETS = Object.freeze([
	{ name: "meadow-night", kind: "still", frameFor: "night-sky", aspect: "16:9", seed: 31, prompt: `A vast moonlit meadow at night, seen from very far away. One small wooden beehive stands alone in the grass in the lower third of the frame. Above it an enormous dark blue night sky full of stars fills most of the picture, with faint mist low on the ground. Very low light. ${FILMIC}` },
	{ name: "meadow-day", kind: "still", frameFor: "timelapse", aspect: "16:9", seed: 32, prompt: `The same kind of vast meadow in late golden afternoon, seen from very far away. One small wooden beehive stands alone in the grass in the lower third of the frame, under a huge sky with high thin clouds. ${FILMIC}` },
	{ name: "wax-macro", kind: "still", frameFor: "wax-cap", aspect: "16:9", seed: 33, prompt: `Extreme macro of one open hexagonal honeycomb cell in pale natural wax, warm light glowing through the wax from behind, surrounding cells falling away into darkness. ${FILMIC}` },
	{ name: "dark-comb-infrared", kind: "still", frameFor: "dark-hive", aspect: "16:9", seed: 34, prompt: "Inside a dark beehive, extreme macro of honeycomb in false colour infrared film, coral orange comb against deep navy shadow, hard edges, high contrast, abstract, fine film grain." },
	{ name: "keeper-dawn", kind: "still", frameFor: "keeper-frame", aspect: "16:9", seed: 36, prompt: `First light of dawn in a misty meadow. A gloved hand holds a wooden frame of golden honeycomb lifted out of an open hive, close up on the hand and the frame only, nothing visible beyond the wrist, warm sun flaring behind. Every cell of the honeycomb is sharp and in focus across the whole frame. ${FILMIC}` },
	{ name: "night-sky", kind: "clip", aspect: "16:9", seconds: 8, seed: 41, prompt: `A locked off wide shot of a moonlit meadow at night with one small wooden beehive in the lower third. Stars slowly wheel across the huge sky, mist drifts low over the grass, nothing else moves, no people. ${FILMIC}` },
	{ name: "timelapse", kind: "clip", aspect: "16:9", seconds: 6, seed: 42, prompt: `A locked off time-lapse of a whole day over a meadow with one small wooden beehive in the lower third. The sun crosses and sets, the sky turns to deep night with wheeling stars and a moon, then dawn breaks, all in one continuous fast shot, clouds racing, no people. ${FILMIC}` },
	{ name: "wax-cap", kind: "clip", aspect: "16:9", seconds: 6, seed: 43, prompt: `Extreme macro of one hexagonal honeycomb cell. Pale wax slowly closes across the opening until it is sealed, warm light glowing through it from behind. Very slow and smooth, no insects visible. ${FILMIC}` },
	{ name: "dark-hive", kind: "clip", aspect: "16:9", seconds: 6, seed: 44, prompt: "Inside a dark beehive, false colour infrared film, coral orange comb against deep navy shadow, many small dark silhouettes moving busily across the comb at a distance, slow push in, abstract, high contrast, fine film grain." },
	{ name: "keeper-frame", kind: "clip", aspect: "16:9", seconds: 6, seed: 46, prompt: `First light of dawn in a misty meadow. A gloved hand slowly lifts a wooden frame of golden honeycomb out of an open hive, close up on the hand and the frame only, nothing visible beyond the wrist, warm sun flaring behind, slow camera drift. The honeycomb stays sharp and in focus across the whole frame. ${FILMIC}` },
]);

/** `m:ss` at the target tempo, for a beat of the film. */
function clock(beats) {
	const seconds = Math.round((beats * 60) / TEMPO_TARGET);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What is asked of a track, its sections read from the shots above, so a retimed shot cannot leave the music behind. */
export function trackPrompt(shots) {
	const at = (id) => {
		let beats = 0;
		for (const shot of shots) {
			if (shot.id === id) return beats;
			beats += shot.beats;
		}
		throw new Error(`no shot ${id}`);
	};
	const drop = at("burst");
	const fall = at("morning") + 4;
	return `Instrumental only, no vocals. Electronic, warm and precise, cinematic, like a film trailer scored by a minimal techno producer. Exactly ${TEMPO_TARGET} BPM, steady, 60 seconds. [0:00 - ${clock(drop - 4)}] A build: one soft plucked note on each bar, a low drone, a tick on each beat, layers doubling and rising. [${clock(drop - 4)} - ${clock(drop)}] One bar of near silence. [${clock(drop)} - ${clock(fall)}] The drop: a huge four on the floor kick, a round bass, crisp off beat hats, growing, with fast plucked arpeggios from ${clock(at("always"))}. [${clock(fall)} - ${clock(at("end"))}] Everything falls away: only a warm pad and the plucked note. [${clock(at("end"))} - 0:58] One last full chord that rings out to silence by 1:00.`;
}
export const TRACK_PROMPT = trackPrompt(SHOTS);

export const totalBeats = (shots = SHOTS) => shots.reduce((sum, shot) => sum + shot.beats, 0);

/** Each word's count, for the reading rate. */
export const wordCount = (words) => words.trim().split(/\s+/).length;

/**
 * Seconds for every shot, from the beats a track was measured to have, with beat 0 as the film's start. Throws when the
 * track is too short for the table, because a film that silently ran out of beats would cut anywhere.
 */
export function timeline(beats, { shots = SHOTS, tail = TAIL_SECONDS } = {}) {
	const total = totalBeats(shots);
	if (beats.length <= total) throw new Error(`the track has ${beats.length} beats and the film needs ${total + 1}`);
	const origin = beats[0];
	let beat = 0;
	const timed = shots.map((shot) => {
		const startBeat = beat;
		beat += shot.beats;
		return { id: shot.id, startBeat, endBeat: beat, start: beats[startBeat] - origin, end: beats[beat] - origin };
	});
	return { shots: timed, duration: beats[total] - origin + tail };
}

/** The even grid a shot table is checked against before any track exists. */
export function evenBeats(bpm = TEMPO_TARGET, count = totalBeats() + 1) {
	return Array.from({ length: count }, (_, i) => (i * 60) / bpm);
}

/** Seconds of generated video on screen, the plan's "about 20 of 60". Stills do not count. */
export function generatedVideoSeconds(bpm = TEMPO_TARGET, shots = SHOTS, assets = ASSETS) {
	const clips = new Set(assets.filter((asset) => asset.kind === "clip").map((asset) => asset.name));
	const beats = shots.flatMap((shot) => (shot.media ?? []).filter((media) => clips.has(media.asset)).map((media) => media.to - media.from));
	return (beats.reduce((sum, n) => sum + n, 0) * 60) / bpm;
}
