/**
 * The film, drawn in the console's own design system, dark. One canvas, and `seek(t)` draws the frame at second `t` as a pure
 * function of `t`: no timer, no running animation, nothing kept between frames but images already decoded. That is what
 * lets `compose.mjs` render a frame whenever it likes and get the same picture, however busy the machine is.
 *
 * Every colour is a token, and shapes follow `design/system/README.md`: flat cards on the canvas, pills for everything
 * pressable, sentence case, and a glyph and a word for every state. All words come from `shots.mjs` through `window.FILM`, so
 * what the test reads is what is on screen. A generated picture not paid for yet draws as a labelled panel.
 */
(() => {
	"use strict";
	const F = window.FILM;
	const W = F.width;
	const H = F.height;
	const T = F.type;
	const canvas = document.getElementById("film");
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(W * dpr);
	canvas.height = Math.round(H * dpr);
	canvas.style.width = `${W}px`;
	canvas.style.height = `${H}px`;
	const g = canvas.getContext("2d", { alpha: false });

	const dark = (name) => F.colours[name].dark;
	const CANVAS = dark("canvas");
	const SURFACE = dark("surface");
	const SURFACE_3 = dark("surface-3");
	const INK = dark("ink");
	const MUTED = dark("ink-muted");
	const FAINT = dark("ink-faint");
	const PRIMARY = dark("primary");
	const ON_PRIMARY = dark("on-primary");
	const DOT_OFF = dark("dot-off");
	const RUN = dark("running");

	/** The design's sizes, at the film's width. A 26 px card radius in a 1440 layout is 35 here. */
	const R_CARD = 35;
	const EDGE = 32;
	const TOP = 124;
	const LEFT = 64;

	const cl = (x) => Math.max(0, Math.min(1, x));
	const out3 = (x) => 1 - (1 - cl(x)) ** 3;
	const inOut = (x) => {
		const q = cl(x);
		return q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2;
	};
	const hit = (b, at, length = 0.5) => (b < at ? 0 : Math.max(0, 1 - (b - at) / length));
	const rng = (seed) => {
		let s = (seed * 2654435761) >>> 0;
		return () => {
			s = (s + 0x6d2b79f5) >>> 0;
			let t = s;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};

	const period = (F.beats[F.beats.length - 1] - F.beats[0]) / (F.beats.length - 1);
	function beatAt(t) {
		const beats = F.beats;
		if (t <= 0) return t / period;
		let hi = beats.length - 1;
		if (t >= beats[hi]) return hi + (t - beats[hi]) / period;
		let lo = 0;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (beats[mid] <= t) lo = mid;
			else hi = mid;
		}
		return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
	}

	/* ---------------------------------------- images ---------------------------------------- */

	const images = new Map();
	const load = (url) => {
		if (!images.has(url)) {
			const img = new Image();
			img.src = url;
			images.set(url, img.decode().then(() => img));
		}
		return images.get(url);
	};
	const ready = new Map();
	const named = (name) => ready.get(name);
	window.filmReady = (async () => {
		const wanted = { ...F.icons };
		for (const [name, asset] of Object.entries(F.assets)) if (asset.kind === "still") wanted[name] = asset.url;
		await Promise.all(Object.entries(wanted).map(async ([name, url]) => ready.set(name, await load(url))));
	})();

	/** The frame of a clip at `seconds`, held at its last frame rather than run off the end. */
	const clipUrl = (asset, seconds) => asset.pattern.replace("%04d", String(Math.max(1, Math.min(asset.frames, Math.floor(seconds * F.fps) + 1))).padStart(4, "0"));

	/* ---------------------------------------- type ---------------------------------------- */

	function font(size, weight, family) {
		g.font = `${weight} ${size}px ${family}`;
	}
	const trackOf = (size, family) => (family === F.sans ? -size * 0.02 : 0);
	function wordsWidth(words, size, weight, family) {
		font(size, weight, family);
		g.letterSpacing = `${trackOf(size, family)}px`;
		const width = g.measureText(words).width;
		g.letterSpacing = "0px";
		return width;
	}

	/** The one way meaning reaches the screen, so the floor is enforced where it can bite: a smaller size stops the render. */
	function say(words, x, y, { size = T.big, weight = 800, family = F.sans, fill = INK, align = "left", outline = null } = {}) {
		if (size < F.minType) throw new Error(`"${words}" is ${size} px, under the floor of ${F.minType}`);
		font(size, weight, family);
		g.letterSpacing = `${trackOf(size, family)}px`;
		g.textAlign = align;
		g.textBaseline = "alphabetic";
		if (outline) {
			g.lineJoin = "round";
			g.lineWidth = size * 0.2;
			g.strokeStyle = outline;
			g.strokeText(words, x, y);
		}
		g.fillStyle = fill;
		g.fillText(words, x, y);
		g.letterSpacing = "0px";
		g.textAlign = "left";
	}

	/** Small type the words already carry: the shell and a card's own furniture. It repeats, so it may sit under the floor. */
	function small(words, x, y, { size = 34, weight = 600, family = F.sans, fill = INK, align = "left" } = {}) {
		font(size, weight, family);
		g.letterSpacing = `${trackOf(size, family)}px`;
		g.textAlign = align;
		g.textBaseline = "alphabetic";
		g.fillStyle = fill;
		g.fillText(words, x, y);
		g.letterSpacing = "0px";
		g.textAlign = "left";
	}

	/**
	 * A phrase from the table, each word rising out of its own line on the beat. Wraps at `max`, and returns the y under its
	 * last line. Nothing is drawn before its beat or after its `until`.
	 */
	function phrase(c, index, x, y, { size = T.big, weight = 800, family = F.sans, fill = INK, max = W - x - 60, stagger = 0.2, lead = 1.08, outline = null } = {}) {
		const p = c.shot.phrases[index];
		if (c.b < p.at || c.b >= p.until) return y;
		const space = wordsWidth(" ", size, weight, family) + size * 0.03;
		const lines = [[]];
		let used = 0;
		for (const word of p.words.split(" ")) {
			const width = wordsWidth(word, size, weight, family);
			if (used + width > max && lines[lines.length - 1].length) {
				lines.push([]);
				used = 0;
			}
			lines[lines.length - 1].push({ word, width });
			used += width + space;
		}
		let count = 0;
		lines.forEach((line, row) => {
			let at = x;
			const base = y + row * size * lead;
			for (const { word, width } of line) {
				const q = out3((c.b - p.at - count * stagger) / 0.45);
				count += 1;
				if (q > 0) {
					g.save();
					g.beginPath();
					g.rect(at - size * 0.2, base - size * 1.02, width + size * 0.4, size * 1.36);
					g.clip();
					say(word, at, base + (1 - q) * size * 1.3, { size, weight, family, fill, outline });
					g.restore();
				}
				at += width + space;
			}
		});
		return y + lines.length * size * lead;
	}

	/* ---------------------------------------- the design system's parts ---------------------------------------- */

	function round(x, y, w, h, r, fill, { stroke = null, width = 2, alpha = 1 } = {}) {
		g.save();
		g.globalAlpha *= alpha;
		g.beginPath();
		g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
		if (fill) {
			g.fillStyle = fill;
			g.fill();
		}
		if (stroke) {
			g.strokeStyle = stroke;
			g.lineWidth = width;
			g.stroke();
		}
		g.restore();
	}
	const card = (x, y, w, h, fill = SURFACE, options) => round(x, y, w, h, R_CARD, fill, options);

	function icon(name, x, y, size) {
		const before = g.globalAlpha;
		g.drawImage(named(name), x - size / 2, y - size / 2, size, size);
		g.globalAlpha = before;
	}

	/** The design's icon tile: a tinted rounded square holding one glyph. */
	function tile(x, y, size, iconName, tint) {
		round(x, y, size, size, size * 0.26, tint);
		icon(iconName, x + size / 2, y + size / 2, size * 0.58);
	}

	/** A status chip: a tint and a word. Where it stands alone it carries a glyph too, because colour is never the only cue. */
	function chip(x, y, words, tone, { size = 34, h = 62 } = {}) {
		const width = wordsWidth(words, size, 600, F.sans);
		const pad = 26;
		round(x, y, pad * 2 + width, h, h / 2, dark(`${tone}-tint`));
		small(words, x + pad, y + h * 0.68, { size, fill: dark(`${tone}-ink`) });
		return pad * 2 + width;
	}

	/** The three stages as the console's nav pills, with its white active pill, and nothing else on the row. */
	const STAGES = ["In the loop", "Near the loop", "Out of the loop"];
	function stages(c, { y = 34, slide = null } = {}) {
		const h = 72;
		const size = 32;
		const widths = STAGES.map((stage) => wordsWidth(stage, size, 600, F.sans) + 56);
		let x = (W - widths.reduce((sum, width) => sum + width + 10, -10)) / 2;
		const spots = STAGES.map((stage, i) => {
			const spot = { stage, x, width: widths[i] };
			x += widths[i] + 10;
			return spot;
		});
		for (const spot of spots) round(spot.x, y, spot.width, h, h / 2, SURFACE);
		const now = spots.find((spot) => spot.stage === c.shot.stage);
		const before = spots.find((spot) => spot.stage === c.previous?.stage) ?? now;
		const q = slide ?? inOut(c.b / 0.8);
		round(before.x + (now.x - before.x) * q, y, before.width + (now.width - before.width) * q, h, h / 2, PRIMARY);
		for (const spot of spots) small(spot.stage, spot.x + 28, y + h * 0.65, { size, fill: (spot === now && q > 0.5) || (spot === before && q <= 0.5) ? ON_PRIMARY : MUTED });
	}

	/* ---------------------------------------- panels ---------------------------------------- */

	const SLOT_TONES = {
		"night-sky": ["#0a1526", "#02040a"],
		timelapse: ["#34506f", "#090f19"],
		"wax-cap": ["#6d4f22", "#1c130a"],
		"dark-hive": ["#10183a", "#3d150a"],
		"keeper-frame": ["#b4a27c", "#465040"],
	};

	function cover(image, x, y, w, h, zoom = 1) {
		const iw = image.naturalWidth;
		const ih = image.naturalHeight;
		const scale = Math.max(w / iw, h / ih) * zoom;
		const sw = w / scale;
		const sh = h / scale;
		g.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
	}

	/** A generated picture, or the labelled panel that stands in for it until it is paid for. */
	function slot(c, name, x, y, w, h, { zoom = 1, r = 0, alpha = 1 } = {}) {
		g.save();
		g.globalAlpha = alpha;
		g.beginPath();
		g.roundRect(x, y, w, h, r);
		g.clip();
		const asset = F.assets[name];
		if (asset) {
			const image = asset.kind === "still" ? named(name) : c.clipImages.get(name);
			if (image) cover(image, x, y, w, h, zoom);
		} else {
			const [top, bottom] = SLOT_TONES[name] ?? [SURFACE_3, SURFACE];
			const fade = g.createLinearGradient(0, y, 0, y + h);
			fade.addColorStop(0, top);
			fade.addColorStop(1, bottom);
			g.fillStyle = fade;
			g.fillRect(x, y, w, h);
			small(`generated: ${name}`, x + 30, y + 150, { size: 26, weight: 400, family: F.mono, fill: "rgba(255,255,255,.7)" });
		}
		g.restore();
	}

	/** A real console page at this moment of its motion, full frame. */
	function screen(c) {
		g.fillStyle = CANVAS;
		g.fillRect(0, 0, W, H);
		if (c.screenImage) g.drawImage(c.screenImage, 0, 0, W, H);
	}

	/** The band a real screen's words sit in. */
	function band(height = 188, soft = 70) {
		if (soft > 0) {
			const fade = g.createLinearGradient(0, H - height - soft, 0, H - height);
			fade.addColorStop(0, "rgba(0,0,0,0)");
			fade.addColorStop(1, "rgba(0,0,0,1)");
			g.fillStyle = fade;
			g.fillRect(0, H - height - soft, W, soft);
		}
		g.fillStyle = "#000";
		g.fillRect(0, H - height, W, height);
	}

	function ground() {
		g.fillStyle = CANVAS;
		g.fillRect(-20, -20, W + 40, H + 40);
	}

	/* ---------------------------------------- the swarm ---------------------------------------- */

	/**
	 * One agent becoming a swarm, drawn and never generated, so every doubling lands on its beat and the count it shows is the
	 * count it draws. A pure function of the film's beat: each agent has a fixed place on a slowly turning sphere, and is born
	 * out of its parent, which it leaves over part of a beat. Agents are a heap: `i` has the parent `i >> 1`.
	 */
	const SWARM_MAX = 6000;
	const DOUBLINGS = F.doublings;
	const DROP = F.shots[0].beats;
	const COLLAPSE = DROP - 4;
	const seeds = (() => {
		const random = rng(11);
		const out = new Float32Array((SWARM_MAX + 2) * 3);
		for (let i = 0; i < out.length; i++) out[i] = random();
		return out;
	})();
	const generationsAt = (beat) => {
		let whole = 0;
		for (const at of DOUBLINGS) if (beat >= at) whole += 1;
		return whole;
	};
	/** The doublings so far as a smooth number, each one snapping most of the way in on its beat. */
	function growth(beat) {
		const whole = generationsAt(beat);
		const next = DOUBLINGS[whole];
		const last = whole ? DOUBLINGS[whole - 1] : 0;
		return whole + (next === undefined ? 0 : out3((beat - last) / Math.max(0.2, next - last)) - 1);
	}
	const bornAt = (i) => (i <= 1 ? -1 : (DOUBLINGS[Math.floor(Math.log2(i)) - 1] ?? Number.POSITIVE_INFINITY));

	function swarmShape(beat) {
		const grown = growth(beat);
		let radius = 0.34 * grown;
		let spin = 0;
		if (beat >= DROP) radius = 7 * (0.02 + 0.98 * out3((beat - DROP) / 0.9)) * (1 + 0.004 * (beat - DROP));
		else if (beat >= COLLAPSE) {
			// It falls in on itself in the near silence, slowly and then all at once.
			const fall = cl((beat - COLLAPSE) / (DROP - COLLAPSE));
			radius *= 1 - fall ** 2.4 * 0.992;
			spin = fall ** 3 * 5;
		}
		const camera = beat >= DROP ? 8.6 + 0.02 * (beat - DROP) : beat >= COLLAPSE ? mix(2.2 + 0.72 * grown, 3.6, inOut((beat - COLLAPSE) / (DROP - COLLAPSE))) : 2.2 + 0.72 * grown;
		const rise = beat >= DROP ? -36 : -150 * inOut((beat - (DROP - 14)) / 10) * (1 - inOut((beat - COLLAPSE) / 4));
		return { radius, spin, camera, cx: W / 2, cy: H / 2 + rise };
	}
	const mix = (from, to, q) => from + (to - from) * q;

	const held = { x: 0, y: 0, z: 0 };
	/**
	 * An agent's place. Its direction comes from its own random numbers and not from its index: both angles as functions of the
	 * index put every agent on one curve, which drew as a white ribbon. The sines fold the cloud slowly, as a murmuration folds.
	 */
	function agentAt(i, beat, shape, out) {
		const u = seeds[i * 3];
		const v = seeds[i * 3 + 1];
		const w = seeds[i * 3 + 2];
		const up = 1 - 2 * u;
		const around = Math.sqrt(Math.max(0, 1 - up * up));
		const turn = v * 6.28318 + beat * (0.04 + 0.05 * w) + shape.spin;
		const reach = shape.radius * Math.cbrt(w);
		const x = around * Math.cos(turn);
		const y = up;
		const z = around * Math.sin(turn);
		const t = beat * 0.11;
		const fold = 0.34 * Math.sin(2.1 * y + t) + 0.22 * Math.sin(3.7 * z - t * 1.3);
		const lift = 0.3 * Math.sin(1.9 * x + t * 0.8) + 0.16 * Math.sin(4.3 * x + 2.2 * z + t);
		out.x = (x + fold) * reach * 1.5;
		out.y = (y * 0.58 + lift) * reach;
		out.z = (z + 0.3 * Math.sin(2.7 * x - t)) * reach;
		const born = bornAt(i);
		if (i > 1 && beat < born + 0.6) {
			const parent = { x: 0, y: 0, z: 0 };
			agentAt(i >> 1, beat, shape, parent);
			const q = out3((beat - born) / 0.6);
			out.x = mix(parent.x, out.x, q);
			out.y = mix(parent.y, out.y, q);
			out.z = mix(parent.z, out.z, q);
		}
	}

	const orb = (() => {
		const size = 128;
		const sprite = document.createElement("canvas");
		sprite.width = size;
		sprite.height = size;
		const s = sprite.getContext("2d");
		const glow = s.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		glow.addColorStop(0, INK);
		glow.addColorStop(0.1, INK);
		glow.addColorStop(0.24, RUN);
		glow.addColorStop(0.5, `${RUN}44`);
		glow.addColorStop(1, `${RUN}00`);
		s.fillStyle = glow;
		s.fillRect(0, 0, size, size);
		return sprite;
	})();

	/** `place(beat)` overrides where the swarm is and how far it spreads, for sending it somewhere: `{ cx, cy, radius }`. */
	function drawSwarm(beat, { alpha = 1, streaks = false, place = null } = {}) {
		const shapeAt = (at) => (place ? { ...swarmShape(at), ...place(at) } : swarmShape(at));
		const shape = shapeAt(beat);
		const before = streaks ? shapeAt(beat - 0.08) : null;
		const live = Math.min(SWARM_MAX, 2 ** generationsAt(beat));
		const focal = 1150;
		const few = cl(1 - growth(beat) / 7);
		g.save();
		g.globalCompositeOperation = "lighter";
		g.strokeStyle = RUN;
		for (let i = 1; i <= live; i++) {
			agentAt(i, beat, shape, held);
			const depth = held.z + shape.camera;
			if (depth < 0.35) continue;
			const scale = focal / depth;
			const x = shape.cx + held.x * scale;
			const y = shape.cy + held.y * scale;
			// A few agents are big glowing bodies. Thousands are fine lights, or the frame burns out to white.
			const size = (0.012 + 0.014 * seeds[i * 3 + 2]) * scale * (1 + 11 * few);
			if (x < -size * 3 || x > W + size * 3 || y < -size * 3 || y > H + size * 3) continue;
			const near = cl(depth / (shape.camera * 0.45));
			const far = cl(1.6 - depth / (shape.camera * 1.5));
			const a = alpha * far * (0.42 + 0.58 * near) * (0.42 + 0.58 * few);
			if (streaks && i % 2 === 0) {
				agentAt(i, beat - 0.08, before, held);
				const was = focal / Math.max(0.35, held.z + before.camera);
				g.globalAlpha = a * 0.5;
				g.lineWidth = Math.max(1, size * 0.16);
				g.beginPath();
				g.moveTo(before.cx + held.x * was, before.cy + held.y * was);
				g.lineTo(x, y);
				g.stroke();
			}
			g.globalAlpha = a;
			if (size < 2.4) {
				g.fillStyle = RUN;
				g.fillRect(x - size / 2, y - size / 2, Math.max(1.2, size), Math.max(1.2, size));
			} else g.drawImage(orb, x - size * 2, y - size * 2, size * 4, size * 4);
		}
		g.restore();
	}

	/** Grain, a vignette and letterbox bars: what makes a frame read as film. */
	const grain = (() => {
		const tile = document.createElement("canvas");
		tile.width = 256;
		tile.height = 256;
		const t = tile.getContext("2d");
		const random = rng(21);
		for (let y = 0; y < 256; y++) {
			for (let x = 0; x < 256; x++) {
				const v = Math.floor(random() * 255);
				t.fillStyle = `rgb(${v},${v},${v})`;
				t.fillRect(x, y, 1, 1);
			}
		}
		return tile;
	})();
	const BARS = 108;
	function filmLook(frame, bars = BARS) {
		const random = rng(frame + 3);
		const vignette = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.72);
		vignette.addColorStop(0, "rgba(0,0,0,0)");
		vignette.addColorStop(1, "rgba(0,0,0,.72)");
		g.fillStyle = vignette;
		g.fillRect(0, 0, W, H);
		g.save();
		g.globalCompositeOperation = "overlay";
		g.globalAlpha = 0.09;
		const dx = Math.floor(random() * 256);
		const dy = Math.floor(random() * 256);
		g.translate(-dx, -dy);
		g.fillStyle = g.createPattern(grain, "repeat");
		g.fillRect(0, 0, W + 256, H + 256);
		g.restore();
		g.fillStyle = "#000";
		g.fillRect(0, 0, W, bars);
		g.fillRect(0, H - bars, W, bars);
	}

	/** A title card's words: centred, quiet, fading in and out, because a film's titles do not jump. */
	function title(c, index, y, { size = T.line, weight = 500, fade = 0.9 } = {}) {
		const p = c.shot.phrases[index];
		if (c.b < p.at || c.b >= p.until) return;
		g.save();
		g.globalAlpha = cl((c.b - p.at) / fade) * cl((p.until - c.b) / fade);
		say(p.words, W / 2, y, { size, weight, align: "center" });
		g.restore();
	}

	/* ---------------------------------------- the shots ---------------------------------------- */

	const DRAW = {
		open(c) {
			ground();
			const beat = c.b;
			// The world appears as the camera pulls back, so the scale of the swarm has something to be measured against.
			const world = inOut((beat - (DROP - 14)) / 6) * (1 - 0.6 * inOut((beat - COLLAPSE) / 3));
			if (world > 0) slot(c, "night-sky", 0, 0, W, H, { zoom: mix(1.22, 1.02, inOut((beat - (DROP - 14)) / 10)), alpha: world });
			// The first agent's heartbeat, on every beat until it splits.
			const pulse = beat < DOUBLINGS[0] ? hit(beat, Math.floor(beat), 0.7) : 0;
			g.save();
			g.globalCompositeOperation = "lighter";
			g.globalAlpha = 0.32 * pulse + 0.1 * hit(beat, DOUBLINGS[Math.max(0, generationsAt(beat) - 1)], 0.5);
			g.drawImage(orb, W / 2 - 320, H / 2 - 320, 640, 640);
			g.restore();
			drawSwarm(beat, { alpha: cl(beat / 1.2) });
			// The last moment before the drop: everything is one blinding point.
			const held0 = cl((beat - (DROP - 1)) / 1);
			if (held0 > 0) {
				g.save();
				g.globalCompositeOperation = "lighter";
				g.globalAlpha = held0;
				const size = 160 + held0 ** 3 * 1300;
				g.drawImage(orb, W / 2 - size / 2, H / 2 - size / 2, size, size);
				g.restore();
			}
			filmLook(c.frame);
			title(c, 0, H - 170);
			const whole = generationsAt(beat);
			if (beat >= DOUBLINGS[0] && beat < COLLAPSE) {
				const n = 2 ** whole;
				const words = n <= 128 ? String(n) : "Many";
				const pop = hit(beat, DOUBLINGS[whole - 1], 0.4);
				// To the left, because the hive the camera pulls back to reveal stands in the middle of the frame.
				g.save();
				g.translate(LEFT + 40, H - 170);
				g.scale(1 + pop * 0.12, 1 + pop * 0.12);
				say(words, 0, 0, { size: T.big, weight: 700 });
				g.restore();
				small("Agents", LEFT + 40, H - 290, { size: 34, weight: 500, fill: MUTED });
			}
		},

		burst(c) {
			ground();
			const beat = c.beat;
			slot(c, "night-sky", 0, 0, W, H, { alpha: 0.32 });
			const shake = hit(c.b, 0, 0.8) * 22;
			const random = rng(c.frame + 7);
			g.save();
			g.translate((random() - 0.5) * shake, (random() - 0.5) * shake);
			drawSwarm(beat, { alpha: 1 - 0.35 * inOut((c.b - 1.5) / 3), streaks: c.b < 1.6 });
			g.restore();
			filmLook(c.frame);
			// A pool of dark behind the name, so it stands in front of the swarm rather than among it.
			const pool = g.createRadialGradient(W / 2, 470, 60, W / 2, 470, 860);
			pool.addColorStop(0, "rgba(0,0,0,.55)");
			pool.addColorStop(1, "rgba(0,0,0,0)");
			g.fillStyle = pool;
			g.fillRect(0, 0, W, H);
			const slam = hit(c.b, 0, 0.6);
			g.save();
			g.translate(W / 2, 520);
			g.scale(1 + slam * 0.22, 1 + slam * 0.22);
			say(c.shot.phrases[0].words, 0, 0, { size: T.title, align: "center" });
			g.restore();
			title(c, 1, 650, { size: T.line, fade: 0.5 });
			const rows = [[2, "icon-box", dark("running-tint")], [3, "icon-spend", dark("ok-tint")], [4, "icon-done", dark("parked-tint")]];
			const w = 520;
			const gap = 22;
			const left = (W - (w * 3 + gap * 2)) / 2;
			rows.forEach(([index, iconName, tint], i) => {
				const p = c.shot.phrases[index];
				if (c.b < p.at) return;
				const q = out3((c.b - p.at) / 0.4);
				const x = left + i * (w + gap);
				const y = 712;
				g.save();
				g.globalAlpha = q;
				g.translate(0, (1 - q) * 40);
				card(x, y, w, 196);
				tile(x + 30, y + 46, 104, iconName, tint);
				say(p.words, x + 158, y + 120, { size: T.chip + 2 });
				g.restore();
			});
		},

		always(c) {
			ground();
			const clip = (name) => F.assets[name]?.kind === "clip";
			if (c.b < 6) {
				slot(c, "timelapse", 0, 0, W, H, { zoom: 1.02 + c.b * 0.004 });
				// A still standing in for the time-lapse goes through one day and night in the grade, so the idea can be judged.
				if (!clip("timelapse")) {
					g.fillStyle = `rgba(2,5,14,${0.9 * (1 - Math.cos((c.b / 6) * Math.PI * 2)) * 0.5})`;
					g.fillRect(0, 0, W, H);
				}
				drawSwarm(c.beat, { alpha: 0.2 + 0.8 * (1 - Math.cos((c.b / 6) * Math.PI * 2)) * 0.5 });
			} else {
				slot(c, "dark-hive", 0, 0, W, H, { zoom: 1 + (c.b - 6) * 0.012 });
			}
			const shade = g.createLinearGradient(0, H * 0.42, 0, H * 0.86);
			shade.addColorStop(0, "rgba(0,0,0,0)");
			shade.addColorStop(1, "rgba(0,0,0,.9)");
			g.fillStyle = shade;
			g.fillRect(0, 0, W, H);
			filmLook(c.frame);
			phrase(c, 0, LEFT, 760, { size: T.big });
			phrase(c, 1, LEFT, 880, { size: T.big });
		},

		turn(c) {
			ground();
			// The swarm, and the one person trying to watch it. Then the thing that does.
			drawSwarm(c.beat, { alpha: 0.75 });
			const pool = g.createRadialGradient(W / 2, 460, 30, W / 2, 460, 620);
			pool.addColorStop(0, "rgba(0,0,0,.85)");
			pool.addColorStop(1, "rgba(0,0,0,0)");
			g.fillStyle = pool;
			g.fillRect(0, 0, W, H);
			const turnAt = c.shot.phrases[1].at;
			const manages = c.b >= turnAt;
			const who = manages ? "pi-dispatch" : "You";
			const width = wordsWidth(who, T.chip, 700, F.sans) + 70;
			const pop = hit(c.b, manages ? turnAt : 0, 0.5) * 0.06;
			g.save();
			g.translate(W / 2, 458);
			g.scale(1 + pop, 1 + pop);
			round(-width / 2, -48, width, 96, 48, PRIMARY);
			say(who, 0, 18, { size: T.chip, weight: 700, fill: ON_PRIMARY, align: "center" });
			g.restore();
			stages(c, { slide: 1 });
			const p = c.shot.phrases[manages ? 1 : 0];
			g.save();
			g.globalAlpha = cl((c.b - p.at) / 0.4);
			say(p.words, W / 2, 800, { size: T.big, align: "center", outline: "rgba(0,0,0,.6)" });
			g.restore();
		},

		machines(c) {
			screen(c);
			band();
			phrase(c, 0, LEFT, H - 60, { size: T.big, stagger: 0.2 });
		},

		models(c) {
			screen(c);
			band();
			phrase(c, 0, LEFT, H - 60, { size: T.big, stagger: 0.2 });
		},

		rules(c) {
			screen(c);
			band();
			phrase(c, 0, LEFT, H - 60, { size: T.big, stagger: 0.2 });
		},

		box(c) {
			ground();
			slot(c, "wax-cap", 0, 0, W, H, { zoom: 1 + c.p * 0.08 });
			filmLook(c.frame);
			phrase(c, 0, LEFT, H - 140, { size: T.big, stagger: 0.1, outline: "rgba(0,0,0,.5)" });
		},

		limits(c) {
			ground();
			stages(c);
			phrase(c, 0, LEFT + 24, 340, { size: T.line, max: 800 });
			phrase(c, 1, LEFT + 24, 560, { size: T.line, max: 800 });
			phrase(c, 2, LEFT + 24, 680, { size: T.line, max: 800 });

			// The caps' one rule, from the design system: ok under the soft hold, attention from it, failed at the cap.
			const spent = 25 * inOut(c.b / 2);
			const share = spent / 25;
			const tone = share >= 1 ? "failed" : share >= 0.8 ? "attention" : "ok";
			const x = 1010;
			const w = W - x - LEFT - 24;
			const y = 230;
			card(x, y, w, 590);
			small("Spend today", x + 48, y + 82, { size: 40, weight: 650 });
			const words = share >= 1 ? "At cap" : share >= 0.8 ? "Soft hold" : `${Math.round(share * 100)}% of cap`;
			chip(x + w - wordsWidth(words, 34, 600, F.sans) - 96, y + 40, words, tone);
			const money = `$${spent.toFixed(2)}`;
			small(money, x + 48, y + 240, { size: 120, weight: 800 });
			round(x + 48, y + 300, w - 96, 28, 14, DOT_OFF);
			if (share > 0.02) round(x + 48, y + 300, (w - 96) * share, 28, 14, dark(tone));
			if (c.b >= 2.2) {
				const q = out3((c.b - 2.2) / 0.5);
				g.save();
				g.globalAlpha = q;
				g.translate(0, (1 - q) * 24);
				tile(x + 48, y + 394, 130, "icon-refused", dark("refused-tint"));
				say("Refused", x + 206, y + 480, { size: T.chip + 18, fill: dark("refused-ink") });
				g.restore();
			}
		},

		asks(c) {
			screen(c);
			band();
			phrase(c, 0, LEFT, H - 60, { size: T.line });
			phrase(c, 1, LEFT + 320, H - 60, { size: T.line });
		},

		number(c) {
			screen(c);
			band(236);
			phrase(c, 0, LEFT, H - 136, { size: T.line });
			phrase(c, 1, LEFT, H - 44, { size: T.line, max: 1400 });
		},

		page(c) {
			screen(c);
			// The fade under the words lifts as the overview pulls back (beats 5.5 to 7.5), or it would dim the bottom of the whole page.
			band(188, c.b < 10 ? 70 * (1 - inOut((c.b - 5.5) / 2)) : 70);
			phrase(c, 0, LEFT, H - 60, { size: T.line, stagger: 0.14 });
		},

		morning(c) {
			ground();
			if (c.b < 4) {
				slot(c, "keeper-frame", 0, 0, W, H, { zoom: 1.02 + c.p * 0.05 });
				const shade = g.createLinearGradient(0, H * 0.45, 0, H);
				shade.addColorStop(0, "rgba(0,0,0,0)");
				shade.addColorStop(1, "rgba(0,0,0,.72)");
				g.fillStyle = shade;
				g.fillRect(0, 0, W, H);
				filmLook(c.frame);
				phrase(c, 0, LEFT, H - 140, { size: T.big, max: 1500 });
				return;
			}
			stages(c, { slide: 1 });
			const x = 1230;
			const w = W - x - EDGE - 60;
			card(x, TOP + 120, w, 620);
			const size = 260 * (1 + hit(c.b, 4, 0.8) * 0.08);
			tile(x + (w - size) / 2, TOP + 180 - (size - 260) / 2, size, "icon-pr", dark("running-tint"));
			say("Proposed", x + w / 2, TOP + 560, { size: T.chip + 8, weight: 700, align: "center" });
			say("change", x + w / 2, TOP + 630, { size: T.chip + 8, weight: 700, align: "center" });
			phrase(c, 1, LEFT, 500, { size: T.huge, max: 1120, stagger: 0.4 });
		},

		end(c) {
			ground();
			// The whole swarm flies into the logo, which lights as it lands, and then slowly grows out again behind the words.
			const y = 430;
			const logo = { x: LEFT + 66, y: y - 50 };
			const land = 1.2;
			const start = c.shot.startBeat;
			const inward = (beat) => {
				const q = inOut((beat - start) / land);
				return { cx: mix(W / 2, logo.x, q), cy: mix(H / 2 - 36, logo.y, q), radius: 7 * (1 - q) ** 1.5 + 0.02 };
			};
			const outward = (beat) => {
				const q = out3((beat - start - land - 0.4) / 6);
				return { cx: mix(logo.x, W * 0.62, q), cy: mix(logo.y, H / 2, q), radius: 7 * q + 0.02 };
			};
			if (c.b < land) drawSwarm(c.beat, { alpha: 0.95, streaks: c.b > 0.25, place: inward });
			else drawSwarm(c.beat, { alpha: 0.42, place: outward });
			// Dark behind the words, once there are words, so the flight itself is not dimmed.
			const pool = g.createLinearGradient(0, 0, W, 0);
			const dim = cl((c.b - land) / 0.6);
			pool.addColorStop(0, `rgba(0,0,0,${0.82 * dim})`);
			pool.addColorStop(0.7, `rgba(0,0,0,${0.2 * dim})`);
			pool.addColorStop(1, "rgba(0,0,0,0)");
			g.fillStyle = pool;
			g.fillRect(0, 0, W, H);
			// The flash as it lands, on the logo and nowhere else.
			const flash = hit(c.b, land, 1);
			if (flash > 0) {
				g.save();
				g.globalCompositeOperation = "lighter";
				g.globalAlpha = flash;
				const size = 240 + (1 - flash) * 700;
				g.drawImage(orb, logo.x - size / 2, logo.y - size / 2, size, size);
				g.restore();
			}
			filmLook(c.frame);
			if (c.b < land) return;
			const q = out3((c.b - land) / 0.4);
			g.fillStyle = PRIMARY;
			g.beginPath();
			g.arc(logo.x, logo.y, 66 * q, 0, Math.PI * 2);
			g.fill();
			if (q > 0.6) say("pi", logo.x, y - 24, { size: T.chip + 12, weight: 700, fill: ON_PRIMARY, align: "center" });
			phrase(c, 0, LEFT + 160, y, { size: T.huge, stagger: 0 });
			const tagIn = out3((c.b - land - 0.5) / 0.4);
			if (tagIn > 0) {
				const tag = `${c.release.version} ${c.release.name}`;
				const at = LEFT + 160 + wordsWidth(c.shot.phrases[0].words, T.huge, 800, F.sans) + 30;
				g.save();
				g.globalAlpha = tagIn;
				g.translate((1 - tagIn) * -24, 0);
				round(at, y - 92, wordsWidth(tag, T.chip, 800, F.sans) + 70, 96, 48, PRIMARY);
				say(tag, at + 35, y - 25, { size: T.chip, weight: 800, fill: ON_PRIMARY });
				g.restore();
			}
			phrase(c, 1, LEFT, y + 124, { size: T.line - 10, stagger: 0.1 });
			phrase(c, 2, LEFT, y + 216, { size: T.chip + 8, weight: 500, fill: MUTED, stagger: 0.1 });
			phrase(c, 3, LEFT, y + 316, { size: T.chip, weight: 500, family: F.mono, stagger: 0 });
		},
	};

	/* ---------------------------------------- the clock ---------------------------------------- */

	const shots = F.shots;

	function shotAt(t) {
		for (let i = shots.length - 1; i >= 0; i--) if (t >= shots[i].start) return i;
		return 0;
	}

	async function draw(t) {
		const frame = Math.round(t * F.fps);
		const beat = beatAt(t);
		const i = shotAt(t);
		const shot = shots[i];
		const b = beat - shot.startBeat;
		const clipImages = new Map();
		for (const media of shot.media ?? []) {
			const asset = F.assets[media.asset];
			if (asset?.kind !== "clip" || b < media.from || b >= media.to) continue;
			clipImages.set(media.asset, await load(clipUrl(asset, (media.start ?? 0) + (b - media.from) * period * (media.rate ?? 1))));
		}
		let screenImage = null;
		for (const held of shot.screens ?? []) {
			if (b < held.from || b >= held.to) continue;
			screenImage = await load(clipUrl(F.screens[held.name], (b - held.from) * period));
		}
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.globalAlpha = 1;
		const c = { t, frame, b, beat, shot, previous: shots[i - 1], p: (t - shot.start) / (shot.end - shot.start), seconds: t - shot.start, clipImages, screenImage, release: F.release };
		if (shot.punch) {
			const kick = hit(b, Math.floor(b), 0.45) * 0.01;
			g.translate(W / 2, H / 2);
			g.scale(1 + kick, 1 + kick);
			g.translate(-W / 2, -H / 2);
		}
		DRAW[shot.id](c);
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	window.seek = async (t) => {
		await window.filmReady;
		await draw(t);
		return true;
	};
})();
