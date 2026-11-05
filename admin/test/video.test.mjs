import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { measureBeats, MAX_DRIFT_SECONDS } from "../../launch/video/beats.mjs";
import { MAX_FLASHES_PER_SECOND, mostFlashesPerSecond } from "../../launch/video/checks.mjs";
import { captionsFor, filmData } from "../../launch/video/compose.mjs";
import { SCREENS } from "../../launch/video/screens.mjs";
import { SOUND_RATE, soundDesign, stereoWavBytes } from "../../launch/video/sound.mjs";
import { CAP_DOLLARS, makeClient, parseAudioStream, Refusal, spentOf, VIDEO_DOLLARS_PER_SECOND } from "../../launch/video/generate.mjs";
import { ASSETS, BEATS_PER_BAR, evenBeats, generatedVideoSeconds, MAX_SECONDS, MAX_WORDS_PER_SECOND, MIN_TYPE, NO_WORDS, RELEASE_FALLBACK, SHOTS, TAIL_SECONDS, TEMPO_TARGET, timeline, totalBeats, TRACK_PROMPT, TYPE, withRelease, wordCount } from "../../launch/video/shots.mjs";
import { synthesise } from "../../launch/video/temp-track.mjs";
import { CLAIMS_REFUTED, TOP_HALF_BANNED } from "./helpers/plain-words.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const FILM_JS = read("launch/video/film.js");
const MOTION_JS = read("launch/video/screen-motion.js");
/** A stand-in the length of a real release's words, so the reading test measures what a viewer will read. */
const RELEASE = { version: "9.9", name: "Name" };
const secondsPerBeat = 60 / TEMPO_TARGET;
const NOW = Date.UTC(2026, 10, 5, 12);

/** One shot's drawing, out of film.js, so a claim about a shot can be held to what it draws. */
function drawingOf(id) {
  const start = FILM_JS.indexOf(`\t\t${id}(c) {`);
  assert.ok(start > 0, `film.js draws no shot ${id}`);
  return FILM_JS.slice(start, FILM_JS.indexOf("\n\t\t},", start));
}

/** Every word the film puts on screen: the phrases, the label block, and what film.js spells itself. */
function everyWord() {
  const phrases = withRelease(SHOTS, RELEASE).flatMap((shot) => shot.phrases.map((phrase) => phrase.words));
  const labels = SHOTS.map((shot) => shot.stage).filter(Boolean);
  const drawn = [...FILM_JS.matchAll(/(?:say|small)\("([^"]+)"/g)].map((match) => match[1]);
  return [...phrases, ...labels, ...drawn];
}

test("the film is at most a minute, and a whole number of bars", () => {
  const { duration } = timeline(evenBeats());
  assert.ok(duration <= MAX_SECONDS, `${duration} s`);
  assert.equal(totalBeats() % BEATS_PER_BAR, 0);
});

test("every shot is drawn, and every drawing is a shot", () => {
  const drawn = [...FILM_JS.slice(FILM_JS.indexOf("const DRAW = {")).matchAll(/^\t\t([a-z]+)\(c\) \{$/gm)].map((match) => match[1]);
  assert.deepEqual(drawn, SHOTS.map((shot) => shot.id));
});

test("the words keep the README's rules", () => {
  for (const words of everyWord()) {
    assert.doesNotMatch(words, /[–—]| - /, `a dash in "${words}"`);
    for (const banned of TOP_HALF_BANNED) assert.doesNotMatch(words, new RegExp(`\\b${banned}(?![a-z])`, "i"), `"${banned}" in "${words}"`);
    for (const refuted of CLAIMS_REFUTED) assert.doesNotMatch(words, refuted, `"${words}"`);
  }
});

test("the end card's words hold through the film's last frame", () => {
  const end = SHOTS.at(-1);
  const lastBeat = end.beats + (timeline(evenBeats()).duration - timeline(evenBeats()).shots.at(-1).end) / secondsPerBeat;
  for (const phrase of end.phrases) assert.ok(phrase.until >= lastBeat, `"${phrase.words}" leaves at beat ${phrase.until}, and the film runs to ${lastBeat.toFixed(1)}`);
});

test("the film opens on the explosion: one agent, a swarm, and the drop lands on its name", () => {
  const [open, burst, always] = SHOTS;
  assert.equal(open.id, "open");
  assert.equal(burst.id, "burst");
  assert.equal(always.id, "always");
  assert.ok(open.phrases[0].words.startsWith("One "));
  assert.ok(always.phrases.some((phrase) => phrase.words.includes("24/7")));
  assert.equal(burst.phrases[0].words, "{name}");
  assert.equal(burst.phrases[0].at, 0, "the name lands on the drop itself");
  // The doubling is drawn and not generated, so the count it shows is the count it draws. It says "Many" past what a number can
  // honestly stand for, since how many agents run depends on the machines.
  assert.match(FILM_JS, /const DOUBLINGS = F\.doublings/);
  assert.match(FILM_JS, /"Many"/);
  assert.doesNotMatch(open.phrases.map((phrase) => phrase.words).join(" "), /\d/);
});

test("the film says what it is: a tool that manages it all, across machines and models, set by you", () => {
  const words = SHOTS.flatMap((shot) => shot.phrases.map((phrase) => phrase.words));
  for (const line of ["pi-dispatch manages it all.", "All your machines.", "All your models.", "All set by you."]) assert.ok(words.includes(line), line);
  // Each of those is shown on the console's own page, not drawn.
  for (const id of ["machines", "models", "rules"]) assert.ok(SHOTS.find((shot) => shot.id === id).real, id);
});

test("the film still ends on the person deciding, whatever the label calls the dark", () => {
  const morning = SHOTS.find((shot) => shot.id === "morning");
  assert.ok(morning.phrases.some((phrase) => phrase.words === "You decide what ships."));
  assert.equal(SHOTS.at(-1).id, "end");
});

test("each phrase stays long enough to read", () => {
  for (const shot of withRelease(SHOTS, RELEASE)) {
    for (const phrase of shot.phrases) {
      // The last card holds to the film's last frame, and its table entry may run past that, so the real end is what counts.
      const lastBeat = shot.id === "end" ? shot.beats + TAIL_SECONDS / secondsPerBeat : shot.beats;
      const until = Math.min(phrase.until, lastBeat);
      const seconds = (until - phrase.at) * secondsPerBeat;
      const rate = wordCount(phrase.words) / seconds;
      assert.ok(rate <= MAX_WORDS_PER_SECOND, `"${phrase.words}" asks for ${rate.toFixed(2)} words a second`);
      assert.ok(phrase.at >= 0 && phrase.at < shot.beats, `"${phrase.words}" starts outside its shot`);
    }
  }
});

test("type that carries meaning stays legible on a phone", () => {
  for (const [name, size] of Object.entries(TYPE)) assert.ok(size >= MIN_TYPE, `${name} is ${size} px`);
  // say() is what enforces this per call, at render: a smaller size stops the film.
  assert.match(FILM_JS, /if \(size < F\.minType\) throw/);
});

test("only the shots marked real show a real screen, and no frame carries a sample data line", () => {
  for (const shot of SHOTS) {
    const drawing = drawingOf(shot.id);
    assert.equal(/\bscreen\(c\)/.test(drawing), Boolean(shot.real), `${shot.id}: its table entry and its drawing disagree about showing a real screen`);
    assert.equal(Boolean(shot.screens?.length), Boolean(shot.real), `${shot.id}: "real" and "screens" disagree`);
  }
  // The owner asked for it off the frames, where it pulled the eye on every screen. The README's caption says it instead.
  assert.doesNotMatch(FILM_JS, /sample data/i);
  assert.match(read("README.md"), /<sub>[^<]*The screens show sample data\.<\/sub>/);
});

test("every real screen is a committed golden with its own motion", () => {
  const used = new Set(SHOTS.flatMap((shot) => (shot.screens ?? []).map((screen) => screen.name)));
  assert.deepEqual([...used].sort(), Object.keys(SCREENS).sort(), "a screen is listed and never shown, or shown and not listed");
  for (const [name, screen] of Object.entries(SCREENS)) {
    assert.ok(existsSync(fileURLToPath(new URL(`../test/fixtures/console/${screen.golden}.html`, import.meta.url))), screen.golden);
    assert.match(MOTION_JS, new RegExp(`^\\t\\t${name}: \\{$`, "m"), `${name} has no motion`);
  }
  // Dark, as the owner asked for: the theme is emulated when the page opens, and light is nowhere in the renderer.
  const renderer = read("launch/video/screens.mjs");
  assert.match(renderer, /emulated: "dark"/);
  assert.doesNotMatch(renderer, /emulated: "light"/);
  // A screen's shot lasts as long as its motion is written for: nothing runs off the end of its frames.
  for (const shot of SHOTS) for (const screen of shot.screens ?? []) assert.ok(screen.from >= 0 && screen.to <= shot.beats, `${screen.name} outlasts ${shot.id}`);
});

test("the chart's line is drawn to its end, not by a dash that its stroke measures differently", () => {
  // A non-scaling stroke measures a dash on screen, and getTotalLength answers in the drawing's units: the line stopped partway.
  assert.doesNotMatch(MOTION_JS, /strokeDash/);
  assert.match(MOTION_JS, /lineUpTo\(this\.sparkPoints/);
});

test("the overview is the one screen shown whole, near the end, and it ends with all of it in view", () => {
  const start = MOTION_JS.indexOf("\t\toverview: {");
  const body = MOTION_JS.slice(start, MOTION_JS.indexOf("\n\t\t},", start));
  assert.doesNotMatch(body, /\bonly\(|\bhide\(|\btrim\(/, "nothing on the page is hidden");
  const ids = SHOTS.map((shot) => shot.id);
  const page = SHOTS.find((shot) => shot.id === "page");
  assert.ok(page.screens.some((screen) => screen.name === "overview"));
  assert.deepEqual(ids.slice(-3), ["page", "morning", "end"], "the last screen before the morning and the end card");
});

test("a real screen shows one thing: the page is hidden around it, and its small print taken out", () => {
  // Whole console pages were too much to take in during a few seconds, so each screen's motion chooses what stays. The owner asked
  // for one look at the whole overview, so that one is exempt and pinned by its own test above.
  for (const name of Object.keys(SCREENS).filter((screen) => screen !== "overview")) {
    const start = MOTION_JS.indexOf(`\t\t${name}: {`);
    assert.ok(start > 0, `${name} has no motion`);
    const body = MOTION_JS.slice(start, MOTION_JS.indexOf("\n\t\t},", start));
    assert.match(body, /\bonly\(/, `${name} shows the whole page`);
    assert.match(body, /\baim\(/, `${name} does not frame what it keeps`);
  }
});

test("the film is drawn from the design system: tokens for colour, sentence case for words", () => {
  // Placeholder tones for pictures not paid for yet are the only colours spelled out, and they sit in SLOT_TONES.
  const literals = [...FILM_JS.slice(FILM_JS.indexOf("const dark ="), FILM_JS.indexOf("const SLOT_TONES")).matchAll(/"#[0-9a-f]{6}"/gi)].map((match) => match[0]);
  assert.deepEqual(literals, []);
  for (const words of everyWord()) {
    if (words.length > 3 && !/^(pi|gh|local)\b/.test(words)) assert.doesNotMatch(words, /^[A-Z][A-Z ]+$/, `"${words}" is all caps, and the system uses sentence case`);
    assert.doesNotMatch(words, /!/, `"${words}"`);
  }
});

test("the release's name reaches the film only through its placeholder", () => {
  assert.ok(SHOTS.some((shot) => shot.phrases.some((phrase) => phrase.words === "{name}")));
  const filled = withRelease(SHOTS, RELEASE).flatMap((shot) => shot.phrases.map((phrase) => phrase.words));
  assert.ok(filled.includes("Name") && filled.includes("The new pi-dispatch 9.9 update."), "the name, then what it is");
  assert.ok(filled.every((words) => !words.includes("{")), "a placeholder reached the screen");
  assert.throws(() => withRelease([{ phrases: [{ words: "{nope}" }] }], RELEASE), /does not have/);
  assert.doesNotThrow(() => withRelease(SHOTS, RELEASE_FALLBACK), "the film still renders with no release.json");
  assert.match(read(".gitignore"), /^launch\/video\/build\/$/m);
  assert.match(FILM_JS, /c\.release\.name/);
});

test("every generated picture is asked for without words, and is on screen", () => {
  const onScreen = new Set(SHOTS.flatMap((shot) => (shot.media ?? []).map((media) => media.asset)));
  const names = new Set(ASSETS.map((asset) => asset.name));
  assert.equal(names.size, ASSETS.length);
  for (const name of onScreen) assert.ok(names.has(name), `${name} is on screen and has no prompt`);
  for (const asset of ASSETS) {
    assert.ok(onScreen.has(asset.name) || names.has(asset.frameFor), `${asset.name} would be paid for and never shown`);
    // The reference's look is described, never named or sent. Words on screen are ours, and no brand is asked for.
    assert.doesNotMatch(asset.prompt, /kimi|moonshot|anthropic|claude|github|pi-dispatch/i);
    assert.equal(Number.isInteger(asset.seed), true);
  }
  assert.match(NO_WORDS, /no text/i);
  assert.match(read("launch/video/generate.mjs"), /`\$\{asset\.prompt\} \$\{NO_WORDS\}`/);
});

test("a clip is long enough for its time on screen, in a length every model on the shortlist can make", () => {
  const clips = new Map(ASSETS.filter((asset) => asset.kind === "clip").map((asset) => [asset.name, asset]));
  for (const shot of SHOTS) {
    for (const media of shot.media ?? []) {
      const clip = clips.get(media.asset);
      // A clip with a `start` holds its last frame on purpose, so it only has to reach that far.
      if (clip && media.start === undefined) assert.ok(clip.seconds >= (media.to - media.from) * secondsPerBeat * (media.rate ?? 1), `${media.asset} is ${clip.seconds} s and on screen longer`);
    }
  }
  // Veo 3.1 makes 4, 6 or 8 s and FLUX 3 Video nothing under 5, from GET /videos/models on 2026-11-04. 6 and 8 are what they share.
  for (const clip of clips.values()) assert.ok([6, 8].includes(clip.seconds), clip.name);
});

test("the film is mostly drawn: generated video stays a minority of the minute", () => {
  const seconds = generatedVideoSeconds();
  assert.ok(seconds >= 10 && seconds <= 25, `${seconds} s of generated video`);
});

test("the track is asked for in the film's own tempo and sections, with no vocals", () => {
  assert.match(TRACK_PROMPT, new RegExp(`${TEMPO_TARGET} BPM`));
  assert.match(TRACK_PROMPT, /Instrumental only, no vocals/);
  // Derived from the table, so moving the drop moves what the track is asked for.
  const beatsBefore = (id) => SHOTS.slice(0, SHOTS.findIndex((shot) => shot.id === id)).reduce((sum, shot) => sum + shot.beats, 0);
  const second = Math.round(beatsBefore("burst") * secondsPerBeat);
  assert.ok(TRACK_PROMPT.includes(`[0:${String(second).padStart(2, "0")} - `), `the drop at ${second} s is not in the prompt`);
});

test("a shot table that outruns its track says so rather than cutting anywhere", () => {
  assert.throws(() => timeline(evenBeats(TEMPO_TARGET, 10)), /the film needs/);
  const moved = timeline(evenBeats().map((beat) => beat + 3));
  assert.equal(moved.shots[0].start, 0, "the film starts on the track's beat 0, not at its second 0");
});

/** Clicks at a tempo, with the same seedless regularity a metronome has. */
function clicks({ rate = 22050, seconds = 40, bpmAt = () => 124 } = {}) {
  const samples = new Float32Array(rate * seconds);
  for (let t = 0.1; t < seconds - 0.1; t += 60 / bpmAt(t)) {
    const at = Math.floor(t * rate);
    for (let i = 0; i < 400 && at + i < samples.length; i++) samples[at + i] += Math.exp(-i / 60) * Math.sin(i * 0.5);
  }
  return { samples, rate };
}

test("beats: a steady track is measured to its tempo", () => {
  for (const bpm of [100, 124, 140]) {
    const { samples, rate } = clicks({ bpmAt: () => bpm });
    const measured = measureBeats(samples, rate);
    assert.ok(Math.abs(measured.bpm - bpm) < 0.5, `${measured.bpm} for ${bpm}`);
    assert.equal(measured.steady, true);
    // A cut is one frame, about 42 ms: further off than that and it is seen ahead of the music.
    assert.ok(Math.abs(measured.beats[0] - 0.1) < 0.03, `first beat at ${measured.beats[0]}`);
    const last = measured.beats.at(-1);
    const nearest = 0.1 + Math.round((last - 0.1) * (bpm / 60)) * (60 / bpm);
    assert.ok(Math.abs(last - nearest) < 0.042, `the last beat is ${(last - nearest).toFixed(3)} s off, at ${bpm}`);
  }
});

test("beats: a beat at the very first second is not lost", () => {
  const rate = 22050;
  const samples = new Float32Array(rate * 30);
  for (let t = 0; t < 29.9; t += 60 / 124) {
    const at = Math.floor(t * rate);
    for (let i = 0; i < 400; i++) samples[at + i] += Math.exp(-i / 60) * Math.sin(i * 0.5);
  }
  assert.ok(measureBeats(samples, rate).beats[0] < 0.03);
});

test("beats: a track whose beat wanders is not called steady", () => {
  const { samples, rate } = clicks({ seconds: 60, bpmAt: (t) => 124 + (t > 30 ? 3 : 0) });
  const measured = measureBeats(samples, rate);
  assert.equal(measured.steady, false, `drift ${measured.drift}`);
  assert.ok(measured.drift > MAX_DRIFT_SECONDS);
});

test("the placeholder track measures as the tempo it was made at, with its drop where the table has it", () => {
  const { samples, rate } = synthesise();
  const measured = measureBeats(samples, rate);
  assert.ok(Math.abs(measured.bpm - TEMPO_TARGET) < 0.5, `${measured.bpm}`);
  assert.equal(measured.steady, true);
  assert.ok(measured.beats.length > totalBeats());
  const dropBar = SHOTS.slice(0, SHOTS.findIndex((shot) => shot.id === "burst")).reduce((sum, shot) => sum + shot.beats, 0) / BEATS_PER_BAR;
  assert.ok(measured.barEnergy[dropBar + 1] > 2 * measured.barEnergy[0], "the drop is louder than the opening");
  assert.deepEqual(synthesise().samples.slice(0, 2000), samples.slice(0, 2000), "the same every run");
});

/** Average level of one channel across a stretch of seconds. */
function levelOf(samples, from, to, rate = SOUND_RATE) {
  let sum = 0;
  const start = Math.floor(from * rate);
  const end = Math.floor(to * rate);
  for (let i = start; i < end; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / (end - start));
}

test("sound: the explosion lands on the drop, after a hush, and two renders match", () => {
  const beats = evenBeats();
  const sound = soundDesign({ beats });
  const { duration } = timeline(beats);
  assert.ok(Math.abs(sound.seconds - duration) < 0.01, `${sound.seconds} s of sound for ${duration} s of film`);
  const drop = beats[SHOTS.slice(0, 1)[0].beats];
  const justBefore = levelOf(sound.left, drop - 0.03, drop);
  const justAfter = levelOf(sound.left, drop + 0.02, drop + 0.4);
  assert.ok(justAfter > 5 * justBefore, `${justAfter} against ${justBefore}: the rush stops dead so the drop hits`);
  assert.ok(justAfter > levelOf(sound.left, 0, drop - 4), "nothing before it is as loud");
  assert.deepEqual(soundDesign({ beats }).left.slice(0, 5000), sound.left.slice(0, 5000), "the same every run");
  const bytes = stereoWavBytes(sound);
  assert.equal(bytes.toString("latin1", 0, 4), "RIFF");
  assert.equal(bytes.readUInt32LE(24), SOUND_RATE);
});

test("captions: every phrase, in order, on the film's own clock", () => {
  const data = filmData({ beats: evenBeats(), release: RELEASE });
  const captions = captionsFor(data);
  const phrases = withRelease(SHOTS, RELEASE).flatMap((shot) => shot.phrases.map((phrase) => phrase.words));
  let from = 0;
  for (const words of phrases) {
    const found = captions.indexOf(`\n${words}\n`, from);
    assert.ok(found >= 0, words);
    from = found;
  }
  assert.match(captions, /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
});

const size = 64 * 36;
const flat = (value) => new Uint8Array(size).fill(value);

test("flashes: a hard cut is not one, and bouncing between light and dark is", () => {
  const cut = [...Array(24).fill(flat(30)), ...Array(24).fill(flat(220))];
  assert.equal(mostFlashesPerSecond(cut), 0);
  const strobe = Array.from({ length: 48 }, (_, i) => flat(Math.floor(i / 2) % 2 ? 220 : 30));
  assert.ok(mostFlashesPerSecond(strobe) > MAX_FLASHES_PER_SECOND);
  const beats = Array.from({ length: 96 }, (_, i) => flat(Math.floor(i / 12) % 2 ? 220 : 30));
  assert.ok(mostFlashesPerSecond(beats) <= MAX_FLASHES_PER_SECOND, "a cut on every beat at 120 BPM stays inside the limit");
});

/** A fetch that answers from a script, and remembers what it was asked. */
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`no answer scripted for ${url}`);
    return next;
  };
  return { fetch, calls };
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const bytes = (text) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const STILL = { name: "x", model: "m", prompt: "p", aspect: "1:1", seed: 1 };
const CLIP = { name: "c", model: "google/veo-3.1", prompt: "p", aspect: "16:9", seed: 1, seconds: 6 };
const image = () => json({ data: [{ b64_json: Buffer.from("png").toString("base64") }], usage: { cost: 0.04 } });

function client(answers, options = {}) {
  const build = tempDir("video-");
  const ledgerPath = join(build, "ledger.json");
  const { fetch, calls } = fakeFetch(answers);
  const made = makeClient({ key: "sk-secret-value", fetch, sleep: async () => {}, now: () => NOW, ledgerPath, build, ...options });
  return { made, calls, ledgerPath, build };
}

test("generate: no key is refused with nothing sent", async () => {
  const { made, calls } = client([], { key: undefined });
  await assert.rejects(made.still(STILL), Refusal);
  assert.equal(calls.length, 0);
});

test("generate: a call that could pass the cap is refused with nothing sent", async () => {
  const { made, calls, ledgerPath } = client([]);
  writeFileSync(ledgerPath, JSON.stringify({ cap: CAP_DOLLARS, entries: [{ hash: "old", name: "old", estimate: 1, cost: CAP_DOLLARS - 0.1 }] }));
  await assert.rejects(made.still(STILL), /past its cap/);
  await assert.rejects(made.clip(CLIP), /past its cap/);
  assert.equal(calls.length, 0);
});

test("generate: a still settles to what the answer says it cost, and is never paid for twice", async () => {
  const { made, calls } = client([image()]);
  const first = await made.still(STILL);
  assert.equal(first.cost, 0.04);
  assert.equal(spentOf(made.readLedger()), 0.04);
  const again = await made.still(STILL);
  assert.equal(again.file, first.file);
  assert.equal(calls.length, 1, "the second call sent nothing");
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
});

test("generate: a changed seed is a new picture", async () => {
  const { made, calls } = client([image(), image()]);
  await made.still(STILL);
  await made.still({ ...STILL, seed: 2 });
  assert.equal(calls.length, 2);
});

test("generate: the key is sent as a header and written nowhere", async () => {
  const { made, calls, ledgerPath } = client([image()]);
  await made.still(STILL);
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-secret-value");
  assert.doesNotMatch(readFileSync(ledgerPath, "utf8"), /sk-secret-value/);
});

test("generate: an answer with no cost keeps its estimate, marked as one", async () => {
  const { made } = client([json({ data: [{ b64_json: "cG5n" }] })]);
  const entry = await made.still(STILL);
  assert.equal(entry.cost, undefined);
  assert.equal(entry.costIs, "estimate");
  assert.ok(spentOf(made.readLedger()) > 0);
});

test("generate: a refused still costs nothing and can be tried again", async () => {
  const { made } = client([json({ error: "no" }, 502), image()]);
  await assert.rejects(made.still(STILL), /HTTP 502/);
  assert.equal(spentOf(made.readLedger()), 0);
  assert.equal((await made.still(STILL)).cost, 0.04);
});

test("generate: a clip reserves, polls, downloads and settles", async () => {
  const { made, calls } = client([json({ id: "job1", status: "pending" }), json({ status: "in_progress" }), json({ status: "completed", usage: { cost: 1.2 } }), bytes("mp4")]);
  const entry = await made.clip(CLIP);
  assert.equal(entry.cost, 1.2);
  assert.equal(entry.jobId, undefined);
  assert.ok(entry.file.endsWith(".mp4"));
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.generate_audio, false, "the track is ours, and sound costs more");
  assert.equal(sent.duration, 6);
  assert.match(calls[3].url, /\/videos\/job1\/content\?index=0$/);
});

test("generate: a clip's job survives a crash, and the next run resumes it rather than paying again", async () => {
  const first = client([json({ id: "job1" }), json({ status: "in_progress" })], { maxPolls: 1 });
  await assert.rejects(first.made.clip(CLIP), /still not done/);
  const held = first.made.readLedger().entries[0];
  assert.equal(held.jobId, "job1");
  assert.equal(held.estimate, 6 * VIDEO_DOLLARS_PER_SECOND["google/veo-3.1"]);
  const { fetch, calls } = fakeFetch([json({ status: "completed", usage: { cost: 1 } }), bytes("mp4")]);
  const second = makeClient({ key: "k", fetch, sleep: async () => {}, now: () => NOW, ledgerPath: first.ledgerPath, build: first.build });
  assert.equal((await second.clip(CLIP)).cost, 1);
  assert.ok(calls.every((call) => !call.init.method), "no second POST");
  assert.equal(calls[0].url.endsWith("/videos/job1"), true);
});

test("generate: a call that vanished is not silently sent again", async () => {
  const { made, calls } = client([json({ data: [] })]);
  await assert.rejects(made.still(STILL), /held no image/);
  await assert.rejects(made.still(STILL), /never came back/);
  assert.equal(calls.length, 1, "the second attempt sent nothing");
});

test("generate: a failed clip job says why", async () => {
  const { made } = client([json({ id: "job1" }), json({ status: "failed", error: "safety", usage: { cost: 0 } })]);
  await assert.rejects(made.clip(CLIP), /the job failed: safety/);
  assert.equal(spentOf(made.readLedger()), 0);
});

test("generate: a model with no price is refused, not guessed at", async () => {
  const { made, calls } = client([]);
  await assert.rejects(made.clip({ ...CLIP, model: "someone/new" }), /no price/);
  assert.equal(calls.length, 0);
});

test("generate: a track's audio is joined from its stream, and an answer with none names its fields, never its values", () => {
  const piece = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n`;
  const stream = `${piece({ audio: { data: "QUJD", format: "wav" } })}${piece({ audio: { data: "REVG" } })}data: ${JSON.stringify({ choices: [], usage: { cost: 0.08 } })}\ndata: [DONE]\n`;
  const parsed = parseAudioStream(stream);
  assert.equal(parsed.audio.join(""), "QUJDREVG");
  assert.equal(parsed.format, "wav");
  assert.equal(parsed.cost, 0.08);
  const none = parseAudioStream(piece({ content: "a private sentence" }));
  assert.deepEqual([...none.shapes], ["content"]);
  assert.equal(none.audio.length, 0);
});
