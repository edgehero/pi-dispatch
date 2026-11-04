/**
 * An animated PNG from PNG frames, in plain Node: Chrome's screenshots go in, and one file comes out that GitHub and the
 * npm page both play. Nothing to install beyond what `render-images.mjs` already needs, and a GIF would band the tints.
 *
 * WHY IT IS SMALL ENOUGH TO COMMIT. A picture barely changes from one frame to the next, so each frame after the first
 * stores only the box around what changed, with the unchanged pixels inside that box made fully transparent. It is drawn
 * over the previous frame (blend "over", dispose "none"), so those pixels show what was already there, and a run of them
 * compresses to almost nothing. A frame that changed nothing lengthens the frame before it instead of being stored. And
 * the whole loop shares one palette, which is a third of the size again.
 *
 * ONE LIMIT, AND THESE PICTURES DO NOT MEET IT. Drawing "over" cannot turn a pixel see-through again, so a pixel that goes
 * from painted to clear would stay painted. The only see-through pixels here are the corners outside the page, which never
 * change.
 */
import { deflateSync, inflateSync, crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
	const name = Buffer.from(type, "latin1");
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
	return Buffer.concat([head, name, data, tail]);
}

/** A PNG's pixels as RGBA, row after row. Only what Chrome writes: 8 bit RGB or RGBA, not interlaced. */
export function decodePng(file) {
	if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("apng: not a PNG");
	let at = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const parts = [];
	while (at < file.length) {
		const length = file.readUInt32BE(at);
		const type = file.toString("latin1", at + 4, at + 8);
		const data = file.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2) || data[12] !== 0) throw new Error(`apng: a PNG this reader does not take (depth ${data[8]}, colour ${data[9]}, interlace ${data[12]})`);
			channels = data[9] === 6 ? 4 : 3;
		} else if (type === "IDAT") parts.push(data);
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(parts));
	const stride = width * channels;
	const rows = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const from = y * (stride + 1) + 1;
		const to = y * stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? rows[to + x - channels] : 0;
			const up = y > 0 ? rows[to + x - stride] : 0;
			const corner = y > 0 && x >= channels ? rows[to + x - stride - channels] : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - corner;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - corner);
				predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
			}
			rows[to + x] = (raw[from + x] + predicted) & 0xff;
		}
	}
	if (channels === 4) return { width, height, rgba: rows };
	const rgba = Buffer.alloc(width * height * 4, 0xff);
	for (let i = 0; i < width * height; i++) rows.copy(rgba, i * 4, i * 3, i * 3 + 3);
	return { width, height, rgba };
}

/**
 * One palette for the whole loop. A flat picture holds a few dozen real colours and the soft edges between them, so the
 * commonest colours are kept exact and the rest are grouped by median cut. Colour by colour a soft edge may move by a
 * shade nobody can see; the file comes out about a third of the size, and a colour flickering by one step between frames
 * stops counting as a change. Index 0 is reserved for "nothing here".
 */
function buildPalette(frames, size = 256) {
	const counts = new Map();
	for (const { rgba } of frames) {
		for (let i = 0; i < rgba.length; i += 4) {
			const colour = rgba.readUInt32BE(i);
			if ((colour & 0xff) === 0) continue;
			counts.set(colour, (counts.get(colour) ?? 0) + 1);
		}
	}
	const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const room = size - 1;
	if (byCount.length <= room) return [0, ...byCount.map(([colour]) => colour)];
	const exact = byCount.slice(0, 96).map(([colour]) => colour);
	const channel = (colour, c) => (colour >>> (24 - c * 8)) & 0xff;
	const groups = [byCount.slice(96)];
	while (groups.length < room - exact.length) {
		let widest = -1;
		let widestChannel = 0;
		let widestRange = 0;
		for (const [at, group] of groups.entries()) {
			if (group.length < 2) continue;
			for (let c = 0; c < 4; c++) {
				let low = 255;
				let high = 0;
				for (const [colour] of group) {
					const v = channel(colour, c);
					if (v < low) low = v;
					if (v > high) high = v;
				}
				if (high - low > widestRange) {
					widestRange = high - low;
					widest = at;
					widestChannel = c;
				}
			}
		}
		if (widest < 0) break;
		const group = groups[widest].sort((a, b) => channel(a[0], widestChannel) - channel(b[0], widestChannel) || a[0] - b[0]);
		const half = group.reduce((sum, [, count]) => sum + count, 0) / 2;
		let seen = 0;
		let cut = 1;
		for (; cut < group.length - 1; cut++) {
			seen += group[cut - 1][1];
			if (seen >= half) break;
		}
		groups.splice(widest, 1, group.slice(0, cut), group.slice(cut));
	}
	const means = groups.filter((group) => group.length > 0).map((group) => {
		const total = group.reduce((sum, [, count]) => sum + count, 0);
		const mean = [0, 1, 2, 3].map((c) => Math.round(group.reduce((sum, [colour, count]) => sum + channel(colour, c) * count, 0) / total));
		return ((mean[0] << 24) | (mean[1] << 16) | (mean[2] << 8) | mean[3]) >>> 0;
	});
	return [0, ...exact, ...means];
}

/** Every frame's pixels as indexes into the palette, each colour matched once. */
function indexFrames(frames, palette) {
	const split = palette.map((colour) => [(colour >>> 24) & 0xff, (colour >>> 16) & 0xff, (colour >>> 8) & 0xff, colour & 0xff]);
	const known = new Map();
	const nearest = (colour) => {
		const hit = known.get(colour);
		if (hit !== undefined) return hit;
		const r = (colour >>> 24) & 0xff;
		const g = (colour >>> 16) & 0xff;
		const b = (colour >>> 8) & 0xff;
		const a = colour & 0xff;
		let best = 1;
		let bestDistance = Infinity;
		for (let i = 1; i < split.length; i++) {
			const [pr, pg, pb, pa] = split[i];
			const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2 + 2 * (a - pa) ** 2;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = i;
			}
		}
		known.set(colour, best);
		return best;
	};
	return frames.map(({ rgba }) => {
		const out = Buffer.alloc(rgba.length / 4);
		for (let i = 0; i < out.length; i++) {
			const colour = rgba.readUInt32BE(i * 4);
			out[i] = (colour & 0xff) === 0 ? 0 : nearest(colour);
		}
		return out;
	});
}

/** Rows of palette indexes. No filter: on indexes a filter's arithmetic means nothing, and it only hides the runs. */
function compress(indexes, width, height) {
	const out = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) indexes.copy(out, y * (width + 1) + 1, y * width, (y + 1) * width);
	return deflateSync(out, { level: 9, memLevel: 9 });
}

/** The box around what differs from the previous frame, or null when nothing does. */
function changedBox(previous, current, width, height) {
	let left = width;
	let right = -1;
	let top = height;
	let bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (previous[y * width + x] !== current[y * width + x]) {
				if (x < left) left = x;
				if (x > right) right = x;
				if (y < top) top = y;
				if (y > bottom) bottom = y;
			}
		}
	}
	return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function frameControl(sequence, box, delayFrames, fps, { blendOver }) {
	const data = Buffer.alloc(26);
	data.writeUInt32BE(sequence, 0);
	data.writeUInt32BE(box.width, 4);
	data.writeUInt32BE(box.height, 8);
	data.writeUInt32BE(box.left, 12);
	data.writeUInt32BE(box.top, 16);
	data.writeUInt16BE(delayFrames, 20);
	data.writeUInt16BE(fps, 22);
	data[24] = 0; // dispose: leave it, so the next frame draws over this one
	data[25] = blendOver ? 1 : 0;
	return chunk("fcTL", data);
}

/** Frames, as PNG files, in order, to one animated PNG that loops for ever. The first frame is the plain PNG a non-animating reader sees. */
export function encodeApng(pngs, { fps }) {
	if (pngs.length === 0) throw new Error("apng: no frames");
	const frames = pngs.map(decodePng);
	const { width, height } = frames[0];
	if (frames.some((frame) => frame.width !== width || frame.height !== height)) throw new Error("apng: frames of different sizes");
	const palette = buildPalette(frames);
	const indexed = indexFrames(frames, palette);
	// Each stored frame, and how many frames of the loop it stands for.
	const stored = [{ index: 0, box: { left: 0, top: 0, width, height }, delay: 1 }];
	for (let i = 1; i < indexed.length; i++) {
		const box = changedBox(indexed[i - 1], indexed[i], width, height);
		if (box === null) stored[stored.length - 1].delay += 1;
		else stored.push({ index: i, box, delay: 1 });
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 3;
	const plte = Buffer.alloc(palette.length * 3);
	const trns = Buffer.alloc(palette.length);
	palette.forEach((colour, i) => {
		plte[i * 3] = (colour >>> 24) & 0xff;
		plte[i * 3 + 1] = (colour >>> 16) & 0xff;
		plte[i * 3 + 2] = (colour >>> 8) & 0xff;
		trns[i] = colour & 0xff;
	});
	const control = Buffer.alloc(8);
	control.writeUInt32BE(stored.length, 0);
	control.writeUInt32BE(0, 4); // 0: for ever
	const parts = [SIGNATURE, chunk("IHDR", header), chunk("acTL", control), chunk("PLTE", plte), chunk("tRNS", trns)];
	let sequence = 0;
	for (const [at, frame] of stored.entries()) {
		parts.push(frameControl(sequence++, frame.box, frame.delay, fps, { blendOver: at !== 0 }));
		const pixels = indexed[frame.index];
		if (at === 0) {
			parts.push(chunk("IDAT", compress(pixels, width, height)));
			continue;
		}
		const previous = indexed[frame.index - 1];
		const { left, top, width: w, height: h } = frame.box;
		const patch = Buffer.alloc(w * h); // all index 0: nothing here, so "over" keeps what is there
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const from = (top + y) * width + left + x;
				if (pixels[from] !== previous[from]) patch[y * w + x] = pixels[from];
			}
		}
		const data = compress(patch, w, h);
		const sequenced = Buffer.alloc(data.length + 4);
		sequenced.writeUInt32BE(sequence++, 0);
		data.copy(sequenced, 4);
		parts.push(chunk("fdAT", sequenced));
	}
	parts.push(chunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
}
