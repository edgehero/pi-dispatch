#!/usr/bin/env node
/**
 * Render a captured terminal transcript as the framed SVG the READMEs show (docs/images/cli-*.svg).
 *
 *   node launch/transcript-svg.mjs --title "~/pi-work · pi-dispatch up --yes" --prompt "$ pi-dispatch up --yes" \
 *     [--cols 118 | --fit] [--fold-doctor] < up.txt > docs/images/cli-up.svg
 *
 * Input is the command's output as it printed it (ANSI SGR colours are kept, every other escape is dropped).
 * Long lines are hard-wrapped at --cols characters, as a terminal of that width would show them; --fit sizes
 * the window to the longest line instead of wrapping (cli-init.svg). --fold-doctor replaces the check lines
 * doctor prints inside `up` with one dim line that counts them, so the up image stays readable; the full
 * report is cli-doctor.svg. Nothing here reads the clock or the host, so the same input gives the same bytes.
 *
 * Capturing the input is the part that cannot live in a script: run the real command in a throwaway folder,
 * then replace every machine-specific value (paths, uids, container ids) before rendering. launch/demo.md
 * lists the scenario each image shows.
 */
import { readFileSync } from "node:fs";

const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const FG = "#c9d1d9";
const PROMPT = "rgb(88,166,255)";
const DIM = "rgb(110,118,129)";
// GitHub's dark terminal palette, normal then bright, indexed by SGR 30-37 and 90-97.
const PALETTE = [
	"rgb(72,79,88)", "rgb(255,123,114)", "rgb(63,185,80)", "rgb(210,153,34)", "rgb(88,166,255)", "rgb(188,140,255)", "rgb(57,197,207)", "rgb(177,186,196)",
	"rgb(110,118,129)", "rgb(255,161,152)", "rgb(86,211,100)", "rgb(227,179,65)", "rgb(121,192,255)", "rgb(210,168,255)", "rgb(86,212,221)", "rgb(255,255,255)",
];
const CHAR_W = 8;
const LINE_H = 19;

function parseArgs(argv) {
	const opts = { cols: 118, fit: false, foldDoctor: false, title: "", prompt: "", input: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--cols") opts.cols = Number(argv[++i]);
		else if (a === "--fit") opts.fit = true;
		else if (a === "--fold-doctor") opts.foldDoctor = true;
		else if (a === "--title") opts.title = argv[++i];
		else if (a === "--prompt") opts.prompt = argv[++i];
		else if (opts.input === null) opts.input = a;
		else throw new Error(`unexpected argument: ${a}`);
	}
	if (!Number.isInteger(opts.cols) || opts.cols < 20) throw new Error("--cols takes a whole number of at least 20");
	return opts;
}

/** One line of text into runs of `{ text, color, bold }`, following SGR state across lines. */
function toRuns(line, state) {
	const runs = [];
	let i = 0;
	let buf = "";
	const flush = () => {
		if (buf) runs.push({ text: buf, color: state.dim && state.color === null ? DIM : (state.color ?? FG), bold: state.bold });
		buf = "";
	};
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(line.slice(i));
			if (m === null) { i++; continue; }
			i += m[0].length;
			if (m[2] !== "m") continue;
			flush();
			const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
			for (let k = 0; k < codes.length; k++) {
				const c = codes[k];
				if (c === 0) Object.assign(state, { color: null, bold: false, dim: false });
				else if (c === 1) state.bold = true;
				else if (c === 2) state.dim = true;
				else if (c === 22) Object.assign(state, { bold: false, dim: false });
				else if (c === 39) state.color = null;
				else if (c >= 30 && c <= 37) state.color = PALETTE[c - 30];
				else if (c >= 90 && c <= 97) state.color = PALETTE[c - 90 + 8];
				else if (c === 38 && codes[k + 1] === 2) { state.color = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`; k += 4; }
				else if (c === 38 && codes[k + 1] === 5) k += 2;
			}
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i));
		i += ch.length;
		if (ch === "\t") buf += "    ";
		else if (ch >= " ") buf += ch;
	}
	flush();
	return runs;
}

/** Hard-wrap a line's runs at `cols` code points. */
function wrapRuns(runs, cols) {
	const rows = [[]];
	let used = 0;
	for (const run of runs) {
		let rest = [...run.text];
		while (rest.length > 0) {
			if (used === cols) { rows.push([]); used = 0; }
			const take = rest.slice(0, cols - used);
			rows[rows.length - 1].push({ ...run, text: take.join("") });
			used += take.length;
			rest = rest.slice(take.length);
		}
	}
	return rows;
}

const plain = (line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/**
 * Fold the checks doctor prints inside `up`: every line from the one after "doctor:" up to the blank line before
 * the verdict becomes one counted dim line. A check is a line that starts with a mark; its indented fix lines go
 * with it.
 */
function foldDoctor(lines) {
	const start = lines.findIndex((l) => plain(l) === "doctor:");
	if (start === -1) throw new Error("--fold-doctor: no \"doctor:\" line in the input");
	let end = start + 1;
	while (end < lines.length && plain(lines[end]) !== "") end++;
	const body = lines.slice(start + 1, end).map(plain);
	const count = (mark) => body.filter((l) => l.startsWith(`${mark} `)).length;
	const ok = count("✓");
	const warn = count("⚠");
	const fail = count("✗");
	const total = ok + warn + fail;
	const says = (n, mark) => (n === 0 ? `no ${mark}` : `${n} ${mark}`);
	const folded = `\x1b[2m  … ${total} doctor checks folded here: ${says(ok, "✓")}, ${says(warn, "⚠")}, ${says(fail, "✗")} (the full report is what \`pi-dispatch doctor\` prints) …\x1b[0m`;
	return [...lines.slice(0, start + 1), folded, ...lines.slice(end)];
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * `dashRefs` writes the dash punctuation characters (U+2010 to U+2015) as character references: the picture is the
 * same, and the file holds none of the raw characters the repository keeps out of its added lines. The panel draws a
 * pause window's range with one (`launch/render-images.mjs`).
 */
const escapeDashes = (s) => s.replace(/[\u{2010}-\u{2015}]/gu, (c) => `&#x${c.codePointAt(0).toString(16)};`);

/** Each text row of an SVG this module drew, as plain text: the check that an image holds exactly the lines it was given. */
export function svgRows(svg) {
	const unescape = (s) => s.replace(/&#x([0-9a-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	return [...svg.matchAll(/<text x="16" y="\d+"[^>]*>(.*?)<\/text>/g)].map((m) => unescape(m[1].replace(/<[^>]+>/g, "")));
}

export function renderTranscript(text, { cols = 118, fit = false, foldDoctor: fold = false, title = "", prompt = "", dashRefs = false } = {}) {
	const esc = dashRefs ? (s) => escapeDashes(escapeXml(s)) : escapeXml;
	let lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	if (fold) lines = foldDoctor(lines);
	const state = { color: null, bold: false, dim: false };
	const logical = lines.map((l) => toRuns(l, state));
	if (prompt) logical.unshift([{ text: prompt, color: PROMPT, bold: false }]);
	const width = fit ? Math.max(...logical.map((runs) => [...runs.map((r) => r.text).join("")].length)) : cols;
	const rows = logical.flatMap((runs) => (runs.length === 0 ? [[]] : wrapRuns(runs, width)));
	const w = width * CHAR_W + 40;
	const h = 48 + LINE_H * rows.length;
	const out = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">`,
		`  <rect width="${w}" height="${h}" rx="10" fill="#0d1117" stroke="#30363d"/>`,
		`  <rect width="${w}" height="34" rx="10" fill="#161b22"/>`,
		`  <rect y="24" width="${w}" height="10" fill="#161b22"/>`,
		`  <circle cx="20" cy="17" r="6" fill="#ff5f57"/>`,
		`  <circle cx="42" cy="17" r="6" fill="#febc2e"/>`,
		`  <circle cx="64" cy="17" r="6" fill="#28c840"/>`,
		`  <text x="${w / 2}" y="21" text-anchor="middle" fill="#8b949e" font-size="12" font-family="${FONT}">${esc(title)}</text>`,
	];
	rows.forEach((row, i) => {
		const spans = row.map((r) => `<tspan fill="${r.color}"${r.bold ? ` font-weight="bold"` : ""}>${esc(r.text)}</tspan>`).join("");
		out.push(`  <text x="16" y="${47 + LINE_H * i}" xml:space="preserve" font-size="13" font-family="${FONT}">${spans}</text>`);
	});
	out.push("</svg>");
	return `${out.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const opts = parseArgs(process.argv.slice(2));
	const text = readFileSync(opts.input ?? 0, "utf8");
	process.stdout.write(renderTranscript(text, opts));
}
