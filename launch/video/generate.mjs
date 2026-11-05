#!/usr/bin/env node
/**
 * Paying OpenRouter for the film's pictures and music, behind the same rule the product holds itself to: the gate that
 * costs nothing runs before the call that costs something.
 *
 *   OPENROUTER_API_KEY=op://... op run -- node launch/video/generate.mjs still specimen-bee --model <id> [--build dir]
 *   ... generate.mjs clip dark-hive --model <id> --resolution 1080p [--first still.png] [--last still.png]
 *   ... generate.mjs track --model google/lyria-3-pro-preview --take 1
 *   node launch/video/generate.mjs spend
 *
 * Why the gate is local, as well as a credit limit on the key: OpenRouter's video page does not say a video's spend counts
 * against a key's limit, so the limit is the last line and not the only one.
 *
 * A call reserves its estimate in `ledger.json` before it is sent, and settles to the `usage.cost` the answer reports. A
 * video is a job that takes minutes, so its id is written down as soon as it is made: a crash then resumes the job it
 * already paid for, rather than paying again. A call whose request hashes to one already made returns that file and
 * sends nothing. An answer with no cost in it keeps its estimate, marked as one, so the total can only be overstated.
 *
 * The key and the signed video links are never logged and never written: OpenRouter's page warns about those links too.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASSETS, NO_WORDS, TRACK_PROMPT } from "./shots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://openrouter.ai/api/v1";
/**
 * The plan said $60 and the key's own limit is $50, but the account behind it held about $41 when work began. The cap sits
 * under that, so the gate stops a call before OpenRouter would fail one halfway through a paid video job.
 */
export const CAP_DOLLARS = 40;
export const LEDGER = join(HERE, "ledger.json");

/**
 * Worst-case dollars per second of video without sound, from `GET /api/v1/videos/models` on 2026-11-04. Only an estimate
 * for the gate, since the real cost comes back in each answer. A model not listed is refused rather than guessed at.
 */
export const VIDEO_DOLLARS_PER_SECOND = Object.freeze({
	"google/veo-3.1-fast": 0.1,
	"kwaivgi/kling-v3.0-pro": 0.112,
	"google/veo-3.1": 0.2,
	"black-forest-labs/flux-3-video": 0.29,
});
/** These answer 400 to a seed, found by asking. The seed stays in the cache key, so a retake is still a deliberate change. */
export const UNSEEDED_IMAGE_MODELS = new Set(["black-forest-labs/flux-3-image"]);
/** These say `seed: false` in GET /videos/models. */
export const UNSEEDED_VIDEO_MODELS = new Set(["black-forest-labs/flux-3-video", "kwaivgi/kling-v3.0-pro"]);
/** My estimate from per-token prices, on the high side, until real answers show better. */
export const STILL_DOLLARS = 0.25;
export const TRACK_DOLLARS = 0.08;

export class Refusal extends Error {}

/**
 * One run at a time. Two runs at once read the same ledger and each writes back its own copy, so one loses the other's entries
 * and a paid call goes unrecorded, which happened once. The lock names its holder, so one left by a crash can be taken over.
 */
export function takeLock(path, { pid = process.pid, isAlive = (other) => {
	try {
		process.kill(other, 0);
		return true;
	} catch {
		return false;
	}
} } = {}) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(pid), { flag: "wx" });
			return () => rmSync(path, { force: true });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const holder = Number(readFileSync(path, "utf8"));
			if (isAlive(holder)) throw new Refusal(`another generate.mjs is running (pid ${holder}). Run these one at a time: running them together loses ledger entries.`);
			rmSync(path, { force: true });
		}
	}
	throw new Refusal(`could not take the ledger's lock at ${path}`);
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

export function emptyLedger() {
	return { cap: CAP_DOLLARS, entries: [] };
}

/** What the ledger holds as spent: settled costs, and the estimates of calls still out. */
export function spentOf(ledger) {
	return Math.round(ledger.entries.reduce((sum, entry) => sum + (entry.cost ?? entry.estimate), 0) * 10000) / 10000;
}

/**
 * The client. Every outside thing is a seam, so a test runs it with no network, no key and no clock.
 * `fetch`, `sleep` and `now` are injected; `ledgerPath` and `build` are where it writes.
 */
export function makeClient({ key, fetch: send = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, ledgerPath = LEDGER, build, pollMs = 30_000, maxPolls = 60 }) {
	const readLedger = () => (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : emptyLedger());
	const writeLedger = (ledger) => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);
	const cacheDir = join(build, "generated");
	mkdirSync(cacheDir, { recursive: true });

	const authorised = () => {
		if (!key) throw new Refusal("OPENROUTER_API_KEY is not set. Run this through `op run`, with a dedicated key that has a credit limit.");
		return { authorization: `Bearer ${key}` };
	};

	/** The free refusals, in order: is it already paid for, is there a key, would it pass the cap. Nothing is sent before these. */
	function gate(request, estimate) {
		const hash = sha(JSON.stringify(request));
		const ledger = readLedger();
		const entry = ledger.entries.find((e) => e.hash === hash);
		if (entry?.file && existsSync(join(build, entry.file))) return { done: entry, hash, ledger };
		if (entry?.jobId) return { resume: entry, hash, ledger, headers: authorised() };
		// Reserved and never settled: it may have been charged, so sending it again could pay twice without anyone choosing to.
		if (entry) throw new Refusal(`${entry.name} was sent before and never came back. Check OpenRouter's activity page, then remove its entry from ledger.json to try again.`);
		const headers = authorised();
		const after = Math.round((spentOf(ledger) + estimate) * 10000) / 10000;
		if (after > ledger.cap) throw new Refusal(`this call could cost $${estimate.toFixed(2)}, which would take the ledger to $${after.toFixed(2)}, past its cap of $${ledger.cap}. Nothing was sent. Raising the cap is the owner's call.`);
		return { hash, ledger, headers };
	}

	function reserve(ledger, fields) {
		const entry = { at: new Date(now()).toISOString(), ...fields };
		ledger.entries.push(entry);
		writeLedger(ledger);
		return entry;
	}

	function settle(entry, cost, file) {
		const ledger = readLedger();
		const held = ledger.entries.find((e) => e.hash === entry.hash);
		if (typeof cost === "number") held.cost = cost;
		else held.costIs = "estimate";
		if (file) held.file = file;
		delete held.jobId;
		writeLedger(ledger);
		return held;
	}

	function forget(entry) {
		const ledger = readLedger();
		ledger.entries = ledger.entries.filter((e) => e.hash !== entry.hash);
		writeLedger(ledger);
	}

	async function refuseUnlessOk(answer, what) {
		if (answer.ok) return;
		// The body names the reason, and holds nothing of ours but the prompt.
		const body = await answer.text().catch(() => "");
		throw new Error(`${what}: HTTP ${answer.status} ${body.slice(0, 300)}`);
	}

	return {
		readLedger,

		/** One image, from `POST /images`, which answers at once and bills only what succeeds. */
		async still({ name, model, prompt, aspect, seed, references = [], resolution = "2K" }) {
			const request = { kind: "still", model, prompt, aspect, seed, resolution, references: references.map((r) => sha(r)) };
			const gated = gate(request, STILL_DOLLARS);
			if (gated.done) return gated.done;
			const entry = reserve(gated.ledger, { hash: gated.hash, kind: "still", name, model, seed, estimate: STILL_DOLLARS });
			let answer;
			try {
				answer = await send(`${API}/images`, { method: "POST", headers: { ...gated.headers, "content-type": "application/json" }, body: JSON.stringify({ model, prompt, aspect_ratio: aspect, resolution, ...(UNSEEDED_IMAGE_MODELS.has(model) ? {} : { seed }), ...(references.length ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) } : {}) }) });
				await refuseUnlessOk(answer, `still ${name}`);
			} catch (error) {
				// OpenRouter's image page: a failed generation is not billed.
				forget(entry);
				throw error;
			}
			const body = await answer.json();
			const image = body.data?.[0];
			if (!image?.b64_json) throw new Error(`still ${name}: the answer held no image, and its estimate stays in the ledger`);
			const extension = (image.media_type ?? "image/png").split("/")[1].replace("jpeg", "jpg");
			const file = join("generated", `${name}-${gated.hash.slice(0, 10)}.${extension}`);
			writeFileSync(join(build, file), Buffer.from(image.b64_json, "base64"));
			return settle(entry, body.usage?.cost, file);
		},

		/** A few seconds of video: make the job, write its id down, wait, download. */
		async clip({ name, model, prompt, aspect, seed, seconds, resolution = "1080p", first = null, last = null }) {
			const perSecond = VIDEO_DOLLARS_PER_SECOND[model];
			if (perSecond === undefined) throw new Refusal(`${model} has no price in VIDEO_DOLLARS_PER_SECOND, so the gate cannot judge it. Read its price from GET /videos/models and add it.`);
			const request = { kind: "clip", model, prompt, aspect, seed, seconds, resolution, first: first && sha(first), last: last && sha(last) };
			const gated = gate(request, seconds * perSecond);
			if (gated.done) return gated.done;
			let entry = gated.resume;
			if (!entry) {
				entry = reserve(gated.ledger, { hash: gated.hash, kind: "clip", name, model, seed, seconds, estimate: seconds * perSecond });
				const frames = [first && { type: "image_url", image_url: { url: first }, frame_type: "first_frame" }, last && { type: "image_url", image_url: { url: last }, frame_type: "last_frame" }].filter(Boolean);
				let job;
				try {
					const made = await send(`${API}/videos`, { method: "POST", headers: { ...gated.headers, "content-type": "application/json" }, body: JSON.stringify({ model, prompt, aspect_ratio: aspect, duration: seconds, resolution, ...(UNSEEDED_VIDEO_MODELS.has(model) ? {} : { seed }), generate_audio: false, ...(frames.length ? { frame_images: frames } : {}) }) });
					await refuseUnlessOk(made, `clip ${name}`);
					job = await made.json();
				} catch (error) {
					// Refused before a job existed, so nothing is running and nothing is owed.
					forget(entry);
					throw error;
				}
				if (!job.id) throw new Error(`clip ${name}: the answer named no job, and its estimate stays in the ledger`);
				const ledger = readLedger();
				entry = ledger.entries.find((e) => e.hash === entry.hash);
				entry.jobId = job.id;
				writeLedger(ledger);
			}
			for (let poll = 0; poll < maxPolls; poll++) {
				const answer = await send(`${API}/videos/${entry.jobId}`, { headers: gated.headers ?? authorised() });
				await refuseUnlessOk(answer, `clip ${name}, polling`);
				const job = await answer.json();
				if (job.status === "completed") {
					const video = await send(`${API}/videos/${entry.jobId}/content?index=0`, { headers: gated.headers ?? authorised() });
					await refuseUnlessOk(video, `clip ${name}, download`);
					const file = join("generated", `${name}-${gated.hash.slice(0, 10)}.mp4`);
					writeFileSync(join(build, file), Buffer.from(await video.arrayBuffer()));
					return settle(entry, job.usage?.cost, file);
				}
				if (job.status === "failed") {
					settle(entry, job.usage?.cost ?? 0, null);
					throw new Error(`clip ${name}: the job failed: ${String(job.error ?? "no reason given").slice(0, 300)}`);
				}
				await sleep(pollMs);
			}
			throw new Error(`clip ${name}: job still not done after ${maxPolls} polls. Its id is in the ledger, so running this again resumes it.`);
		},

		/**
		 * A music track. OpenRouter's model page documents only generic chat fields for this model, and its audio guide says
		 * audio output needs streaming and names speech voices, so this first call is the test of whether it works at all.
		 * An answer with no audio in it says what shape it had, by field names only.
		 */
		async track({ model, prompt = TRACK_PROMPT, take = 1 }) {
			const request = { kind: "track", model, prompt, take };
			const gated = gate(request, TRACK_DOLLARS);
			if (gated.done) return gated.done;
			const name = `track-${take}`;
			const entry = reserve(gated.ledger, { hash: gated.hash, kind: "track", name, model, estimate: TRACK_DOLLARS });
			const answer = await send(`${API}/chat/completions`, { method: "POST", headers: { ...gated.headers, "content-type": "application/json" }, body: JSON.stringify({ model, modalities: ["text", "audio"], stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: `${prompt} Take ${take}.` }] }) });
			await refuseUnlessOk(answer, `track ${take}`);
			const { audio, format, cost, shapes } = parseAudioStream(await answer.text());
			if (!audio.length) throw new Error(`track ${take}: no audio came back. The stream's fields were: ${[...shapes].join(", ") || "none"}. Its estimate stays in the ledger.`);
			const file = join("generated", `${name}-${gated.hash.slice(0, 10)}.${format}`);
			writeFileSync(join(build, file), Buffer.from(audio.join(""), "base64"));
			return settle(entry, cost, file);
		},
	};
}

/** The base64 audio, its format, its cost and the field names seen, from a chat completion's server-sent events. */
export function parseAudioStream(text) {
	const audio = [];
	const shapes = new Set();
	let format = "mp3";
	let cost;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		let event;
		try {
			event = JSON.parse(line.slice(6));
		} catch {
			continue;
		}
		if (typeof event.usage?.cost === "number") cost = event.usage.cost;
		const delta = event.choices?.[0]?.delta ?? event.choices?.[0]?.message ?? {};
		for (const field of Object.keys(delta)) shapes.add(field);
		const piece = delta.audio?.data ?? delta.audio?.b64_json;
		if (typeof piece === "string") audio.push(piece);
		if (typeof delta.audio?.format === "string") format = delta.audio.format;
	}
	return { audio, format, cost, shapes };
}

const asDataUrl = (path) => `data:image/${/\.jpe?g$/i.test(path) ? "jpeg" : "png"};base64,${readFileSync(path).toString("base64")}`;

async function main(argv) {
	const [kind, ...rest] = argv;
	const flag = (name, fallback = null) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
	const build = flag("--build", join(HERE, "build"));
	mkdirSync(build, { recursive: true });
	const client = makeClient({ key: process.env.OPENROUTER_API_KEY, build });
	if (kind !== "spend") {
		const release = takeLock(`${LEDGER}.lock`);
		process.once("exit", release);
	}
	if (kind === "spend") {
		const ledger = client.readLedger();
		console.log(`$${spentOf(ledger).toFixed(2)} of $${ledger.cap}, ${ledger.entries.length} calls`);
		for (const entry of ledger.entries) console.log(`  ${(entry.cost ?? entry.estimate).toFixed(4)}${entry.cost === undefined ? " (estimate)" : ""}  ${entry.kind}  ${entry.name}  ${entry.model}`);
		return;
	}
	const model = flag("--model");
	if (!model) throw new Refusal("--model is required: the model is chosen at a checkpoint, never defaulted");
	let entry;
	if (kind === "track") entry = await client.track({ model, take: Number(flag("--take", 1)) });
	else {
		const asset = ASSETS.find((a) => a.name === rest[0] && a.kind === kind);
		if (!asset) throw new Refusal(`no ${kind} named ${rest[0]} in shots.mjs`);
		const prompt = `${asset.prompt} ${NO_WORDS}`;
		if (kind === "still") {
			const references = flag("--reference") ? [asDataUrl(flag("--reference"))] : [];
			entry = await client.still({ name: `${asset.name}--${model.replaceAll("/", "_")}`, model, prompt, aspect: asset.aspect, seed: asset.seed, references, resolution: flag("--resolution", "2K") });
		} else {
			entry = await client.clip({ name: `${asset.name}--${model.replaceAll("/", "_")}`, model, prompt, aspect: asset.aspect, seed: asset.seed, seconds: Number(flag("--seconds", asset.seconds)), resolution: flag("--resolution", "1080p"), first: flag("--first") && asDataUrl(flag("--first")), last: flag("--last") && asDataUrl(flag("--last")) });
		}
	}
	console.log(`${entry.file ?? "no file"}  $${(entry.cost ?? entry.estimate).toFixed(4)}${entry.cost === undefined ? " (estimate)" : ""}`);
	console.log(`ledger: $${spentOf(client.readLedger()).toFixed(2)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`generate: ${error.message}`);
		process.exit(1);
	});
}
