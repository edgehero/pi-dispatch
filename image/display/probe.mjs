#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { withDisplay } from "./with-display.mjs";
import { PAGE, WIDTH, HEIGHT, pixelsProblem } from "./pixels.mjs";

// This capability's executable lives in an image derived from the shipped one. Resolve ITS pinned Playwright,
// never the tested repository's node_modules. The private PNG export is asserted against the installed pin.
const require = createRequire("/app/package.json");
const output = process.argv[2];
const mode = process.argv[3] ?? "chromium";
const inside = process.argv[4] === "--inside";
const say = (ok, reason, extra = {}) => console.log(JSON.stringify({ v: 1, ok, reason, ...extra }));

if (!inside) {
	const code = await withDisplay(process.execPath, [process.argv[1], output, mode, "--inside"]);
	if (code === 70) say(false, "display-start-failed");
	else if (code === 127) say(false, "probe-missing");
	process.exitCode = code;
} else {
	let browser;
	let stage = "browser-start-failed";
	const timer = setTimeout(() => { say(false, "probe-timeout"); process.exit(2); }, 40_000);
	try {
		const { chromium, _electron } = require("playwright");
		const { PNG } = require("playwright-core/lib/utilsBundle");
		let page;
		if (mode === "electron") {
			browser = await _electron.launch({ executablePath: "/opt/pi-electron/node_modules/electron/dist/electron", args: ["/app/image/display/electron.cjs"], chromiumSandbox: false, timeout: 15_000 });
			page = await browser.firstWindow({ timeout: 10_000 });
		} else if (mode === "chromium") {
			browser = await chromium.launch({ headless: false, chromiumSandbox: false, timeout: 15_000 });
			page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
		} else throw new Error("unsupported mode");
		stage = "page-check-failed";
		await page.setViewportSize({ width: WIDTH, height: HEIGHT });
		await page.setContent(PAGE);
		await page.evaluate(() => document.fonts.ready);
		await page.getByRole("button", { name: "Check rendering" }).click({ timeout: 5_000 });
		if (await page.getByRole("button").textContent() !== "Checked") throw new Error("click failed");
		stage = "screenshot-invalid";
		const bytes = await page.screenshot({ path: output, type: "png", timeout: 5_000 });
		if (bytes.length > 1024 * 1024) throw new Error("oversized screenshot");
		const problem = pixelsProblem(PNG.sync.read(bytes));
		if (problem) { say(false, problem); process.exitCode = 2; }
		else {
			const readPeak = (path) => { try { const n = Number(readFileSync(path, "utf8").trim()); return Number.isSafeInteger(n) && n >= 0 ? n : null; } catch { return null; } };
			say(true, "rendered", { width: WIDTH, height: HEIGHT, sha256: createHash("sha256").update(bytes).digest("hex"), memoryPeak: readPeak("/sys/fs/cgroup/memory.peak"), pidsPeak: readPeak("/sys/fs/cgroup/pids.peak") });
		}
	} catch {
		// Browser errors can include arbitrary page text and paths; doctor receives only the closed failure word.
		say(false, stage);
		process.exitCode = 2;
	} finally {
		await browser?.close().catch(() => {});
		clearTimeout(timer);
	}
}
