/**
 * The operator console as images: a golden in a real browser, at a width and in a theme (`render-images.mjs --console`).
 *
 * The goldens are the input, not a second rendering. They are already the console's own pages, with every state a person
 * can reach, held byte for byte by the tests, so an image shows exactly what they pin. So nothing here needs Valkey. The
 * width check's page loader is reused rather than a second one written, and its server is not moved, since it is tangled
 * with a required check's bookkeeping: the few lines serving a golden here have nothing to record.
 *
 * NO NETWORK. Chrome's resolver maps every name to nothing but the loopback address serving these pages, and the pages
 * load nothing else. They are served with the console's own security headers, so an image is the page under its real CSP.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { CONSOLE_PICKS, CONSOLE_TRANSCRIPT } from "./console-picks.mjs";
import { openChrome } from "./chrome-pipe.mjs";

export const CONSOLE_WIDTHS = Object.freeze([1440, 375]);
export const CONSOLE_THEMES = Object.freeze(["light", "dark"]);
/** Browsers at once for a full matrix, each loading its pages one at a time, as the width check's lanes do. */
const LANES = 3;
const STEP_MS = 30_000;
const PHONE_MAX = 760;

/** A golden's key, as the ledgers write it: `overview.operator`, `panels/confirm-done.operator`. */
export const goldenKey = (doc) => doc.file.replace(/\.html$/, "");

/** Every golden at every width and theme: `{ key, width, theme, file }`, one image each. */
export function matrixOf(keys) {
	return keys.flatMap((key) => CONSOLE_WIDTHS.flatMap((width) => CONSOLE_THEMES.map((theme) => ({ key, width, theme, file: `${key.replaceAll("/", "-")}.${width}.${theme}.png` }))));
}

/** The committed images: `{ key, width, theme, file, ... }`, one per pick. */
export function picksPlan(picks = CONSOLE_PICKS) {
	return picks.map(({ name, golden, ...rest }) => ({ width: 1440, theme: "light", scale: 1.5, ...rest, key: golden, file: `${name}.png` }));
}

/** The canned transcript as the stream's frames, each drawn by the console's own `transcriptEntryHtml`. */
function transcriptFrames(transcriptEntryHtml) {
	return CONSOLE_TRANSCRIPT.map((entry) => `id: ${entry.id}\nevent: entry\ndata: ${JSON.stringify({ html: String(transcriptEntryHtml(entry)) })}\n\n`).join("");
}

/** The golden pages over http, with the console's headers; the stream holds open, and for `frames` first sends them. */
function servePages({ docs, css, script, applyHeaders, frames }) {
	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	const held = new Set();
	const server = createServer((req, res) => {
		applyHeaders(res);
		const url = new URL(req.url, "http://127.0.0.1");
		const doc = byPath.get(url.pathname);
		if (doc) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc.html);
		else if (url.pathname === "/static/console.css") res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(css);
		else if (url.pathname === "/static/console.js") res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(script);
		else if (url.pathname === "/api/whoami") res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end("{}");
		else if (url.pathname === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
			res.flushHeaders();
			if (url.searchParams.get("page") === "run" && frames.has(url.searchParams.get("id"))) res.write(frames.get(url.searchParams.get("id")));
			held.add(res);
			req.on("close", () => held.delete(res));
		} else res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
	});
	return new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve({
		origin: `http://127.0.0.1:${server.address().port}`,
		close: () => { for (const res of held) res.destroy(); return new Promise((done) => server.close(done)); },
	})));
}

/** What to capture on the loaded page: one element's box, the top `height` px, or the whole page. */
async function clipOf(page, shot) {
	if (shot.selector) {
		const box = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(shot.selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
		if (!box || !box.width || !box.height) throw new Error(`${shot.file}: ${shot.selector} is not on ${shot.key}, or draws nothing`);
		return { ...box, scale: 1 };
	}
	const { cssContentSize } = await page.t.send("Page.getLayoutMetrics");
	const whole = Math.ceil(cssContentSize.height);
	return { x: 0, y: 0, width: shot.width, height: shot.height ? Math.min(shot.height, whole) : whole, scale: 1 };
}

/**
 * Render `shots` to `out` in as many browsers as the list warrants. Returns the files written. A golden a shot names that
 * does not exist throws before any browser opens, so a stale pick cannot quietly render fewer images.
 */
export async function renderConsole({ chrome, shots, out, work, children, Refusal, widthCheck, clockMs, log = () => {} }) {
	const m = await widthCheck.loadModules();
	const docs = [widthCheck.readGoldens(widthCheck.FIXTURES, ""), widthCheck.readGoldens(join(widthCheck.FIXTURES, "panels"), "panels/")].flatMap((read) => read.docs);
	const byKey = new Map(docs.map((doc) => [goldenKey(doc), doc]));
	for (const shot of shots) if (!byKey.has(shot.key)) throw new Refusal(`${shot.file}: no golden ${shot.key} (admin/test/fixtures/console/${shot.key}.html)`);
	const { transcriptEntryHtml } = await import("../admin/src/console/transcript.mjs");
	const frames = new Map(shots.filter((shot) => shot.transcript).map((shot) => [shot.transcript, transcriptFrames(transcriptEntryHtml)]));
	mkdirSync(out, { recursive: true });
	const server = await servePages({ docs, css: m.CONSOLE_CSS, script: m.CONSOLE_SCRIPT, applyHeaders: m.applySecurityHeaders, frames });
	const queue = [...shots];
	const written = [];
	const lane = async (id) => {
		const laneWork = join(work, `console-${id}`);
		mkdirSync(join(laneWork, "home"), { recursive: true });
		const browser = await openChrome({ chrome, work: laneWork, children, Refusal, stepMs: STEP_MS, env: { HOME: join(laneWork, "home") }, extraArgs: widthCheck.chromeLaunchArgs(), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" });
		try {
			for (let shot = queue.shift(); shot; shot = queue.shift()) {
				const doc = byKey.get(shot.key);
				const page = await widthCheck.openPage({
					browser,
					key: shot.file,
					url: `${server.origin}${widthCheck.goldenUrl(doc)}`,
					metrics: { width: shot.width, height: 900, deviceScaleFactor: shot.scale ?? (shot.width <= PHONE_MAX ? 2 : 1), mobile: shot.width <= PHONE_MAX },
					emulated: shot.theme,
					clockMs,
				});
				try {
					// The stream's entries arrive after the page settles, and the status says when the last one landed.
					if (shot.transcript) await page.evaluate(`new Promise((done) => { const look = () => (document.querySelectorAll("[data-transcript] .tx__entry").length >= ${CONSOLE_TRANSCRIPT.length} || performance.now() > 5000 ? done() : setTimeout(look, 50)); look(); })`, true);
					const clip = await clipOf(page, shot);
					const { data } = await page.t.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
					writeFileSync(join(out, shot.file), Buffer.from(data, "base64"));
					written.push(join(out, shot.file));
					log(`${written.length}/${shots.length} ${shot.file}`);
				} finally {
					await page.t.close().catch(() => {});
				}
			}
		} finally {
			await browser.close();
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(LANES, Math.ceil(shots.length / 20) || 1) }, (_, i) => lane(i + 1)));
	} finally {
		await server.close();
	}
	return written;
}
