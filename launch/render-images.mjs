#!/usr/bin/env node
/**
 * Render the README's panel images from the shipped code over one canned deployment (`launch/fixture-deployment.mjs`).
 *
 *   node launch/render-images.mjs           docs/images/dispatch-dashboard.svg and dispatch-hosts.svg
 *   node launch/render-images.mjs --png     the same, plus their .png copies and docs/images/insights-view.png
 *
 *   --out <dir>   write there instead of docs/images
 *   --url <url>   use this Valkey instead of starting one; its database must be empty, and is emptied again at the end
 *
 * WHAT RUNS. A temporary `valkey-server` (or `redis-server`, whichever is on PATH) on a free port of 127.0.0.1, with no
 * persistence and its files in a temporary directory, removed with everything else when the script ends. The fixture
 * writes the deployment's files there and seeds the server through the worker's own writers. The images are then drawn
 * by the real code: `makeDashboard` with the real `createDashboardDeps` against the seeded server, rendered at width 80
 * (the LIST, and the HOSTS view after `u`, whose 7 days come from the real `readCapacity`), and drawn as framed SVGs by
 * `launch/transcript-svg.mjs`. With `--png`, the insights page is written by the real `insightsCommand` (no browser
 * opened) and shot in headless Chrome at 1240 px and device scale 2, full page, and the two SVGs are rasterised for the
 * npm page, which cannot show an SVG from raw.githubusercontent.com. Chrome is never needed without `--png`.
 *
 * Only the queue's live state is canned (its counts, its workers, the active job and the failed one): a running fleet is
 * the only thing that produces them. The fixture says which values those are.
 *
 * NO NETWORK, NO SPEND, NOTHING OF THIS MACHINE. The environment is emptied before any project module loads, so no forge
 * or provider key, no deployment pointer and no home directory of the operator is read; every child process (the
 * server, git, Chrome) gets an environment of its own; nothing is fetched (no npx, no registry, no CDN), and Chrome's
 * host resolver maps every name to nothing. Every id is synthetic.
 *
 * DETERMINISTIC. `Date` is frozen at the fixture's instant for every reader, and the time zone is UTC, so two runs
 * write byte-identical SVGs (`admin/test/render-images.test.mjs` holds that). Each SVG is checked against the
 * renderer's lines before it is written: the same rows, and every framed row 80 columns. The PNGs are Chrome's
 * rendering and are not held to bytes.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findOnPath } from "./server-binary.mjs";
import { NOW, QUEUE_STATE, WORKERS, FAILED, RUNNING, LOCAL_HOST, seedDeployment, writeDeployment } from "./fixture-deployment.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** The panel's frame width in the images, and the column count each SVG is drawn at. */
const WIDTH = 80;
/** The longest any one DevTools step (a call, or the page's load) may take before the run fails. */
const CDP_STEP_MS = 30_000;
/** The longest the first command to a `--url` Valkey may take before the run fails. */
const URL_CONNECT_MS = 3_000;
/** The terminal images' rasterising scale: 680 px wide becomes 1700, sharp at the 820 px the npm page shows on a 2x screen. */
const SVG_PNG_SCALE = 2.5;

// ---- arguments and the machine's two binaries, read BEFORE the environment is emptied ------------------------------
const USAGE = `usage: node launch/render-images.mjs [--png] [--out <dir>] [--url <redis://host:port/db>]
  --png    also write the PNGs (needs Google Chrome; set CHROME to its executable where it is not
           ${MAC_CHROME})
  --out    the directory to write to (default docs/images)
  --url    an existing, empty Valkey database to seed instead of starting valkey-server or redis-server
           from PATH; it is emptied again at the end`;

/** The options, or `{ help }`, or `{ error }` (a sentence for the operator, never a stack). */
function parseArgs(argv) {
	const opts = { png: false, out: join(REPO, "docs", "images"), url: null };
	// A value is the next argument unless that is missing or is itself a flag, so `--out --png` is an error rather
	// than a directory named --png.
	const value = (i, flag) => {
		const v = argv[i + 1];
		if (v === undefined || v === "" || v.startsWith("--")) return { error: `${flag} takes a value` };
		return { v };
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") return { help: true };
		if (a === "--png") opts.png = true;
		else if (a === "--out" || a === "--url") {
			const got = value(i, a);
			if (got.error) return got;
			opts[a.slice(2)] = got.v;
			i++;
		} else return { error: `unexpected argument: ${a}` };
	}
	if (opts.url !== null && !/^rediss?:\/\/[^/\s]/.test(opts.url)) return { error: "--url takes a redis:// or rediss:// URL" };
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	console.log(USAGE);
	process.exit(0);
}
if (opts.error) {
	console.error(`render-images: ${opts.error}\n${USAGE}`);
	process.exit(2);
}
const serverBin = opts.url ? null : findOnPath(["valkey-server", "redis-server"]);
if (!opts.url && !serverBin) {
	console.error("render-images: needs valkey-server or redis-server on PATH (brew install valkey, apt install valkey-server), or --url to an empty database");
	process.exit(2);
}
// The output directory, made (or found) before anything starts, so a path that cannot be one is a refusal, not a stack.
try {
	mkdirSync(opts.out, { recursive: true });
	accessSync(opts.out, constants.W_OK);
} catch (err) {
	console.error(`render-images: --out ${opts.out} is not a directory this account can write (${err?.code ?? err?.message ?? err})`);
	process.exit(2);
}
const chrome = process.env.CHROME || MAC_CHROME;
const gitPath = process.env.PATH ?? "";
if (opts.png) {
	try {
		accessSync(chrome, constants.X_OK);
	} catch {
		console.error(`render-images: --png needs Google Chrome (looked for ${chrome}; set CHROME to its executable)`);
		process.exit(2);
	}
}

// One temporary directory for the whole run: the deployment, the server's files, Chrome's profile and temp files.
const work = mkdtempSync(join(tmpdir(), "pi-dispatch-images-"));
/** The child processes still running (the server, Chrome), killed by `cleanup` whatever ends the run. */
const children = new Set();
let cleaned = false;
const cleanup = () => {
	if (cleaned) return;
	cleaned = true;
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	chromeSingletonCleanup();
	rmSync(work, { recursive: true, force: true });
};
process.on("exit", cleanup);
/**
 * Chrome on macOS keeps its singleton socket in the user's own temp directory (NSTemporaryDirectory, which TMPDIR does
 * not move), linked from the profile as `SingletonSocket`, and leaves that `com.google.Chrome.*` directory behind. It
 * is removed here through the profile's link, and only a directory of that name.
 */
let chromeSingletonDir = null;
/** Remember the singleton directory while Chrome runs (it removes the link, not the directory, when it exits). */
function noteChromeSingleton() {
	try {
		const dir = dirname(readlinkSync(join(work, "chrome", "SingletonSocket")));
		if (/\/com\.google\.Chrome\.[A-Za-z0-9]+$/.test(dir)) chromeSingletonDir = dir;
	} catch {
		// no link (another platform, or not made yet)
	}
}
function chromeSingletonCleanup() {
	if (chromeSingletonDir) rmSync(chromeSingletonDir, { recursive: true, force: true });
}
// An interrupt leaves no server and no directory behind: 128 plus the signal's number, as a shell reports it.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
	process.on(signal, () => {
		console.error(`render-images: ${signal}, stopping`);
		cleanup();
		process.exit(code);
	});
}
/** A failure the operator can act on (a missing binary, a database that is not usable): one line, exit 2. */
class Refusal extends Error {}

// THE ENVIRONMENT, EMPTIED. What the project's modules read from it from here on is the fixture's deployment alone.
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, { TZ: "UTC", HOME: join(work, "home"), PI_CODING_AGENT_DIR: join(work, "agent") });
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

// THE CLOCK, FROZEN, before any project module loads: every reader of `Date` sees the fixture's instant.
const RealDate = Date;
class FrozenDate extends RealDate {
	constructor(...a) {
		if (a.length === 0) super(NOW);
		else super(...a);
	}
	static now() {
		return NOW;
	}
}
globalThis.Date = FrozenDate;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the server ----------------------------------------------------------------------------------------------------
async function freePort() {
	const srv = createServer();
	await new Promise((resolve, reject) => srv.once("error", reject).listen(0, "127.0.0.1", resolve));
	const { port } = srv.address();
	await new Promise((resolve) => srv.close(resolve));
	return port;
}

function ping(port) {
	return new Promise((resolve) => {
		const sock = connect({ host: "127.0.0.1", port }, () => sock.write("PING\r\n"));
		sock.setTimeout(500, () => (sock.destroy(), resolve(false)));
		sock.once("error", () => resolve(false));
		sock.once("data", (d) => (sock.destroy(), resolve(String(d).startsWith("+PONG"))));
	});
}

async function startServer(bin) {
	const dir = join(work, "server");
	mkdirSync(dir);
	const port = await freePort();
	const child = spawn(bin, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir], { env: {}, stdio: ["ignore", "ignore", "pipe"] });
	children.add(child);
	child.once("exit", () => children.delete(child));
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const exited = new Promise((resolve) => child.once("exit", resolve));
	for (let i = 0; i < 200; i++) {
		if (child.exitCode !== null) throw new Error(`${bin} exited (${child.exitCode}): ${stderr.trim()}`);
		if (await ping(port)) {
			return {
				url: `redis://127.0.0.1:${port}`,
				async stop() {
					child.kill("SIGTERM");
					await Promise.race([exited, sleep(5000)]);
				},
			};
		}
		await sleep(50);
	}
	child.kill("SIGKILL");
	throw new Error(`${bin} did not answer on 127.0.0.1:${port}`);
}

// ---- the panel ----------------------------------------------------------------------------------------------------
// The colours the README images use, by pi theme colour name, as truecolor SGR: the renderer draws what pi's theme would.
const PALETTE = {
	border: [48, 54, 61],
	accent: [88, 166, 255],
	success: [63, 185, 80],
	dim: [110, 118, 129],
	muted: [139, 148, 158],
	text: [201, 209, 217],
	warning: [214, 165, 49],
	error: [248, 81, 73],
	syntaxType: [57, 197, 207],
	syntaxKeyword: [210, 168, 255],
	syntaxFunction: [188, 140, 255],
	syntaxString: [165, 214, 255],
};
const THEME = {
	fg: (c, t) => {
		if (!PALETTE[c]) throw new Error(`no palette colour for theme name ${c}`);
		return `\x1b[38;2;${PALETTE[c].join(";")}m${t}\x1b[39m`;
	},
	bg: (_c, t) => t,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
	italic: (t) => t,
	underline: (t) => t,
	inverse: (t) => t,
	strikethrough: (t) => t,
};

/**
 * A queue for `createDashboardDeps`: the real one for the cron schedulers (BullMQ's own list), the canned live state for
 * the rest, by queue name.
 */
function cannedQueues(W) {
	const opened = [];
	const fn = (connection, { name = W.queue.QUEUE } = {}) => {
		const real = name === W.queue.QUEUE ? W.queue.makeQueue(connection) : null;
		if (real) opened.push(real);
		const host = name.includes("@") ? name.slice(name.indexOf("@") + 1) : null;
		const oldest = host && RUNNING[host]?.length ? [...RUNNING[host]].sort((a, b) => a.at - b.at)[0].id : null;
		return {
			name,
			async isPaused() {
				return false;
			},
			async getJobCounts() {
				return { ...(QUEUE_STATE[name]?.counts ?? { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }) };
			},
			async getWorkers() {
				return WORKERS.map((w) => ({ name: w }));
			},
			getJobSchedulers: (...a) => (real ? real.getJobSchedulers(...a) : Promise.resolve([])),
			async getActive() {
				return oldest ? [{ id: oldest }] : [];
			},
			async getFailed() {
				return name === W.queue.QUEUE ? [{ ...FAILED }] : [];
			},
			async pause() {},
			async resume() {},
			async close() {},
		};
	};
	return { fn, close: () => Promise.all(opened.map((q) => q.close())) };
}

/** Wait, by count of turns rather than by the clock, until `ok(lines)` holds. */
async function settle(comp, ok, what) {
	for (let i = 0; i < 400; i++) {
		const lines = comp.render(WIDTH);
		if (ok(lines.map(strip))) return lines;
		await sleep(25);
	}
	throw new Error(`the panel never showed ${what}:\n${comp.render(WIDTH).map(strip).join("\n")}`);
}
const strip = (l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

async function renderPanel({ url, env, W, RM }) {
	const piRequire = (await import("node:module")).createRequire(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const jiti = piRequire("jiti").createJiti(import.meta.url);
	const { makeDashboard, createDashboardDeps } = await jiti.import(join(REPO, "admin", "src", "dashboard.ts"));
	const paths = RM.resolvePaths(env);
	const queues = cannedQueues(W);
	const base = createDashboardDeps(paths, { makeQueueFn: queues.fn, dollarEnvFn: () => ({}), nowFn: () => NOW });
	const comp = makeDashboard({
		paths,
		done() {},
		tui: { requestRender() {} },
		theme: THEME,
		intervalMs: 2 ** 31 - 1,
		deps: {
			...base,
			now: () => NOW,
			// index.ts's own wiring of the HOSTS view: the report `pi-dispatch capacity` and `dispatch_capacity` print.
			capacityInfo: ({ window = "7d" } = {}) => RM.readCapacity({ url, env, window }),
			terminalRows: () => null,
		},
	});
	try {
		const list = await settle(comp, (ls) => ls.some((l) => /RUNS/.test(l)) && ls.some((l) => /gh-/.test(l)), "its runs");
		comp.handleInput("u");
		const hosts = await settle(comp, (ls) => ls.some((l) => /hosts · \d+ live/.test(l)) && !ls.some((l) => /reading the last 7 days/.test(l)), "the HOSTS view with its 7 days");
		return { list, hosts };
	} finally {
		await comp.dispose();
		await queues.close();
	}
}

/** The SVG for `lines`, after checking it holds them: the same rows, each framed row `WIDTH` columns. */
function terminalSvg(lines, title, { renderTranscript, svgRows, columnsOf }) {
	const plain = lines.map(strip);
	const wide = plain.filter((l) => /^[┌│├└]/.test(l) && columnsOf(l) !== WIDTH);
	if (wide.length > 0) throw new Error(`${title}: ${wide.length} framed rows are not ${WIDTH} columns:\n${wide.join("\n")}`);
	const svg = renderTranscript(lines.join("\n"), { cols: WIDTH, title, dashRefs: true });
	const rows = svgRows(svg);
	if (rows.length !== plain.length || rows.some((r, i) => r !== plain[i])) throw new Error(`${title}: the SVG's text is not the renderer's lines`);
	return svg;
}

// ---- Chrome, over its DevTools pipe ------------------------------------------------------------------------------
/**
 * A headless Chrome driven over `--remote-debugging-pipe` (the DevTools protocol on fds 3 and 4, NUL-terminated JSON):
 * no browser library, no port, and nothing it loads can reach the network (`--host-resolver-rules`).
 */
async function openChrome() {
	const profile = join(work, "chrome");
	mkdirSync(profile);
	const args = [
		"--headless=new",
		"--remote-debugging-pipe",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--hide-scrollbars",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-default-apps",
		"--host-resolver-rules=MAP * ~NOTFOUND",
		`--user-data-dir=${profile}`,
		"about:blank",
	];
	// TMPDIR inside the work directory, so no `com.google.Chrome.*` directory is left in the system's temp directory.
	const chromeTmp = join(work, "chrome-tmp");
	mkdirSync(chromeTmp);
	const child = spawn(chrome, args, { env: { HOME: process.env.HOME, TMPDIR: chromeTmp }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
	children.add(child);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const toChrome = child.stdio[3];
	const fromChrome = child.stdio[4];
	const pending = new Map();
	const waiters = [];
	// Once Chrome has gone (it exited, crashed, or closed its pipe) every call still waiting fails, and every later
	// one fails at once: without this a dead browser left the script waiting forever.
	let gone = null;
	const fail = (why) => {
		if (gone) return;
		gone = new Refusal(`Chrome ${why}`);
		for (const p of pending.values()) p.reject(gone);
		pending.clear();
		for (const w of waiters.splice(0)) w.reject(gone);
	};
	child.once("exit", (code, signal) => (children.delete(child), fail(`exited (${signal ?? code})`)));
	child.once("error", (err) => fail(`could not start (${err?.message ?? err})`));
	fromChrome.once("close", () => fail("closed its DevTools pipe"));
	fromChrome.on("error", () => fail("closed its DevTools pipe"));
	toChrome.on("error", () => fail("closed its DevTools pipe"));
	let buf = "";
	fromChrome.on("data", (d) => {
		buf += d.toString("utf8");
		for (let i; (i = buf.indexOf("\0")) >= 0; ) {
			const msg = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			if (msg.id !== undefined && pending.has(msg.id)) {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
				else p.resolve(msg.result);
			} else {
				for (const w of [...waiters]) if (w.match(msg)) waiters.splice(waiters.indexOf(w), 1), w.resolve(msg);
			}
		}
	});
	let next = 0;
	/** One DevTools call, answered within `CDP_STEP_MS` or failed. */
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			if (gone) return reject(gone);
			const id = ++next;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Refusal(`Chrome did not answer ${method} within ${CDP_STEP_MS / 1000} s`));
			}, CDP_STEP_MS);
			const done = (fn) => (v) => (clearTimeout(timer), fn(v));
			pending.set(id, { resolve: done(resolve), reject: done(reject), method });
			toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	/** The first event `match` accepts, within `CDP_STEP_MS` or failed. */
	const event = (match, what) =>
		new Promise((resolve, reject) => {
			if (gone) return reject(gone);
			const timer = setTimeout(() => {
				const i = waiters.indexOf(w);
				if (i >= 0) waiters.splice(i, 1);
				reject(new Refusal(`Chrome sent no ${what} within ${CDP_STEP_MS / 1000} s`));
			}, CDP_STEP_MS);
			const w = { match, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) };
			waiters.push(w);
		});
	return {
		/**
		 * Load `url` in a `width` px viewport at `scale`, with the page's clock fixed at `clockMs` when given, and write a
		 * PNG of `height` px, or of the whole page.
		 */
		async shoot({ url, out, width, height = 900, scale, fullPage = false, clockMs = null }) {
			const { targetId } = await send("Target.createTarget", { url: "about:blank" });
			noteChromeSingleton();
			const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
			const s = (method, params) => send(method, params, sessionId);
			await s("Page.enable");
			const metrics = (h) => s("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: scale, mobile: false });
			await metrics(height);
			if (clockMs !== null) {
				// The page's "generated N ago" reads the BROWSER's clock: fixed one minute after the page was generated.
				await s("Page.addScriptToEvaluateOnNewDocument", {
					source: `(() => { const T = ${clockMs}; const R = Date; class D extends R { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } } globalThis.Date = D; })();`,
				});
			}
			const loaded = event((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId, "load event");
			await s("Page.navigate", { url });
			await loaded;
			await sleep(500); // fonts and the charts' first layout
			let h = height;
			if (fullPage) {
				const m = await s("Page.getLayoutMetrics");
				h = Math.ceil(m.cssContentSize.height);
				await metrics(h);
				await sleep(200);
			}
			const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
			writeFileSync(out, Buffer.from(data, "base64"));
			await send("Target.closeTarget", { targetId });
		},
		async close() {
			await send("Browser.close").catch(() => {});
			await Promise.race([exited, sleep(5000)]);
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}

/** The insights page, as `/dispatch insights 30d --no-open` writes it, captured rather than written to the graph dir. */
async function insightsPage({ env, RM }) {
	const piRequire = (await import("node:module")).createRequire(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const jiti = piRequire("jiti").createJiti(import.meta.url);
	const mod = await jiti.import(join(REPO, "admin", "src", "index.ts"));
	let html = null;
	const notes = [];
	await mod.insightsCommand(RM.resolvePaths(env), ["insights", "30d", "--no-open"], (m, level) => notes.push([level, m]), {
		fs: { mkdirSync() {}, writeFileSync: (_p, data) => (html = data), renameSync() {} },
		openBrowser() {},
		env: {},
		platform: "linux",
		now: () => NOW,
	});
	if (html === null) throw new Error(`insights wrote no page: ${JSON.stringify(notes)}`);
	return html;
}

// ---- main ---------------------------------------------------------------------------------------------------------
async function main() {
	const W = {
		connection: await import("../worker/src/connection.mjs"),
		queue: await import("../worker/src/queue.mjs"),
		runHistory: await import("../worker/src/run-history.mjs"),
		runMirror: await import("../worker/src/run-mirror.mjs"),
		hostRegistry: await import("../worker/src/host-registry.mjs"),
		liveJobs: await import("../worker/src/live-jobs.mjs"),
		budget: await import("../worker/src/budget.mjs"),
		scopedLimits: await import("../worker/src/scoped-limits.mjs"),
		allocation: await import("../worker/src/allocation.mjs"),
		waitState: await import("../worker/src/wait-state.mjs"),
		dollarBudget: await import("../worker/src/dollar-budget.mjs"),
	};
	const RM = await import("../admin/src/read-model.mjs");
	const DW = await import("../admin/src/dollar-windows.mjs");
	const { columnsOf } = await import("../admin/src/panel.mjs");
	const { renderTranscript, svgRows } = await import("./transcript-svg.mjs");
	const version = JSON.parse(readFileSync(join(REPO, "worker", "package.json"), "utf8")).version;

	const server = opts.url ? null : await startServer(serverBin);
	const url = opts.url ?? server.url;
	let admin;
	try {
		W.connection.parseConnection(url, { failFast: true });
		admin = W.connection.makeRedisClient(url);
	} catch (err) {
		throw new Refusal(`--url is not a usable Valkey URL (${err?.message ?? err})`);
	}
	admin.on?.("error", () => {});
	// Set once the database is known to have been empty, so a refused --url is never emptied.
	let seeded = false;
	try {
		// Bounded: this client queues a command while it cannot connect rather than failing it, so a dead --url would
		// otherwise wait forever.
		let timer;
		const size = await Promise.race([admin.dbsize(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Refusal(`no answer from ${opts.url ? "--url" : "the server"} within ${URL_CONNECT_MS / 1000} s`)), URL_CONNECT_MS)))]).finally(() => clearTimeout(timer));
		if (size !== 0) throw new Refusal(`the database at --url holds ${size} keys: the fixture needs an empty one`);
		seeded = true;
		process.env.PATH = gitPath; // only git reads it (the --png topology's two repositories), and only while they are made
		const deployment = join(work, "deployment");
		const paths = writeDeployment(deployment, { git: opts.png });
		delete process.env.PATH;
		const env = {
			VALKEY_URL: url,
			PI_WORKER_NAME: LOCAL_HOST,
			PI_LOG_RETENTION_DAYS: "30",
			PI_LOGS_DIR: paths.logs,
			PI_SETTINGS_FILE: paths.settings,
			PI_TRIGGERS_FILE: paths.triggers,
			PI_PAUSE_WINDOWS_FILE: paths.pause,
			PI_SCOPED_LIMITS_FILE: paths.limits,
			PI_PROJECTS_FILE: paths.projects,
			PI_ENVELOPE_FILE: paths.envelope,
			PI_SUBSCRIPTIONS_FILE: paths.subs,
			PI_GRAPH_DIR: paths.graph,
		};
		Object.assign(process.env, env);
		await seedDeployment({ url, paths, mods: { W, RM, DW, version } });

		const { list, hosts } = await renderPanel({ url, env, W, RM });
		const helpers = { renderTranscript, svgRows, columnsOf };
		const images = [
			["dispatch-dashboard", terminalSvg(list, "pi · /dispatch dashboard (live overlay)", helpers)],
			["dispatch-hosts", terminalSvg(hosts, "pi · /dispatch hosts (u)", helpers)],
		];
		mkdirSync(opts.out, { recursive: true });
		for (const [name, svg] of images) writeFileSync(join(opts.out, `${name}.svg`), svg);

		if (opts.png) {
			const html = await insightsPage({ env, RM });
			const page = join(work, "insights.html");
			writeFileSync(page, html);
			const browser = await openChrome();
			try {
				await browser.shoot({ url: pathToFileURL(page).href, out: join(opts.out, "insights-view.png"), width: 1240, scale: 2, fullPage: true, clockMs: NOW + 60_000 });
				for (const [name, svg] of images) {
					const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg);
					await browser.shoot({ url: pathToFileURL(join(opts.out, `${name}.svg`)).href, out: join(opts.out, `${name}.png`), width: Number(w), height: Number(h), scale: SVG_PNG_SCALE });
				}
			} finally {
				await browser.close();
			}
		}
		for (const [name] of images) console.log(join(opts.out, `${name}.svg`));
		if (opts.png) for (const name of ["dispatch-dashboard", "dispatch-hosts", "insights-view"]) console.log(join(opts.out, `${name}.png`));
	} finally {
		if (opts.url && seeded) await admin.flushdb().catch(() => {});
		admin.disconnect();
		await server?.stop();
	}
}

try {
	await main();
	cleanup();
	process.exit(0);
} catch (err) {
	console.error(`render-images: ${err instanceof Refusal ? err.message : (err?.stack ?? err)}`);
	cleanup();
	process.exit(err instanceof Refusal ? 2 : 1);
}
