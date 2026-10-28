/**
 * A headless Chrome driven over `--remote-debugging-pipe` (the DevTools protocol on fds 3 and 4, NUL-terminated JSON):
 * no browser library, no port, and nothing it loads can reach the network (`--host-resolver-rules`). Lifted out of
 * `launch/render-images.mjs` (issue #737) so `.github/scripts/console-width-check.mjs` drives the same browser the same
 * way; render-images calls it with the arguments it always used, so its run is unchanged.
 *
 * The caller owns the lifetime: `work` is a directory it removes, `children` the set of processes its own cleanup kills
 * whatever ends the run (a crash, a signal), and `Refusal` the error class it reports as an operator-actionable line.
 * Nothing here registers a process handler, because a driver that did would fight its caller's.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The source of a script that fixes the page's `Date` at `ms` (given to `Page.addScriptToEvaluateOnNewDocument`), so
 * a page that says "generated N ago" reads the same on every run. `new Date(x)` and `Date.UTC` still work; only the
 * clock is fixed. The page's timers are not touched: freezing them is virtual time, which the width check must not use
 * while a stub holds a fetch open.
 */
export function frozenDateSource(ms) {
	if (!Number.isSafeInteger(ms)) throw new TypeError("frozenDateSource() takes an integer instant in milliseconds");
	return `(() => { const T = ${ms}; const R = Date; class D extends R { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } } globalThis.Date = D; })();`;
}

/**
 * Start Chrome with its profile in `<work>/chrome` and its temp files in `<work>/chrome-tmp` (so no
 * `com.google.Chrome.*` directory is left in the system's temp directory), and return the driver:
 *
 *   send(method, params, sessionId, ms)   one DevTools call, answered within `ms` (default `stepMs`) or failed
 *   event(match, what, ms)                the first message `match` accepts, within `ms` or failed
 *   openTarget()                          a new blank tab attached in flat mode: `{ targetId, sessionId, send, close }`
 *   removeSingleton()                     see below; synchronous, safe in an exit handler
 *   close()                               `Browser.close`, then SIGKILL after 5 s
 *
 * `env` is the child's whole environment besides TMPDIR (render-images passes only HOME). `extraArgs` go before the
 * start URL. `resolverRules` is Chrome's `--host-resolver-rules`: by default every name maps to nothing, and Chrome
 * applies the rules to an IP literal too, so a caller serving pages on loopback must `EXCLUDE` that address. With `captureStderr`, the last 4 KB of Chrome's stderr are kept and quoted when it dies, which is how a
 * sandbox that cannot start says so; without it, stderr is ignored as render-images always had it.
 */
export async function openChrome({ chrome, work, children, Refusal = Error, stepMs = 30_000, env = {}, extraArgs = [], captureStderr = false, resolverRules = "MAP * ~NOTFOUND" }) {
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
		`--host-resolver-rules=${resolverRules}`,
		`--user-data-dir=${profile}`,
		...extraArgs,
		"about:blank",
	];
	const chromeTmp = join(work, "chrome-tmp");
	mkdirSync(chromeTmp);
	const child = spawn(chrome, args, { env: { ...env, TMPDIR: chromeTmp }, stdio: ["ignore", "ignore", captureStderr ? "pipe" : "ignore", "pipe", "pipe"] });
	children.add(child);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	let stderr = "";
	if (captureStderr) child.stderr.on("data", (d) => (stderr = (stderr + d.toString("utf8")).slice(-4096)));
	const toChrome = child.stdio[3];
	const fromChrome = child.stdio[4];
	const pending = new Map();
	const waiters = [];
	// Once Chrome has gone (it exited, crashed, or closed its pipe) every call still waiting fails, and every later
	// one fails at once: without this a dead browser left the script waiting forever.
	let gone = null;
	const fail = (why) => {
		if (gone) return;
		const said = captureStderr && stderr.trim() ? `: ${stderr.trim().split("\n").slice(-6).join(" | ")}` : "";
		gone = new Refusal(`Chrome ${why}${said}`);
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
	const send = (method, params = {}, sessionId, ms = stepMs) =>
		new Promise((resolve, reject) => {
			if (gone) return reject(gone);
			const id = ++next;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Refusal(`Chrome did not answer ${method} within ${ms / 1000} s`));
			}, ms);
			const done = (fn) => (v) => (clearTimeout(timer), fn(v));
			pending.set(id, { resolve: done(resolve), reject: done(reject), method });
			toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	const event = (match, what, ms = stepMs) =>
		new Promise((resolve, reject) => {
			if (gone) return reject(gone);
			const timer = setTimeout(() => {
				const i = waiters.indexOf(w);
				if (i >= 0) waiters.splice(i, 1);
				reject(new Refusal(`Chrome sent no ${what} within ${ms / 1000} s`));
			}, ms);
			const w = { match, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) };
			waiters.push(w);
		});
	// Chrome on macOS keeps its singleton socket in the user's own temp directory (NSTemporaryDirectory, which TMPDIR
	// does not move), linked from the profile as `SingletonSocket`, and leaves that `com.google.Chrome.*` directory
	// behind. It is noted while Chrome runs (Chrome removes the link, not the directory, when it exits) and removed
	// through that note, and only a directory of that name.
	let singletonDir = null;
	const noteSingleton = () => {
		try {
			const dir = dirname(readlinkSync(join(profile, "SingletonSocket")));
			if (/\/com\.google\.Chrome\.[A-Za-z0-9]+$/.test(dir)) singletonDir = dir;
		} catch {
			// no link (another platform, or not made yet)
		}
	};
	return {
		send,
		event,
		async openTarget() {
			const { targetId } = await send("Target.createTarget", { url: "about:blank" });
			noteSingleton();
			const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
			return {
				targetId,
				sessionId,
				send: (method, params, ms) => send(method, params, sessionId, ms),
				close: () => send("Target.closeTarget", { targetId }),
			};
		},
		removeSingleton() {
			if (singletonDir) rmSync(singletonDir, { recursive: true, force: true });
		},
		async close() {
			await send("Browser.close").catch(() => {});
			await Promise.race([exited, sleep(5000)]);
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}
