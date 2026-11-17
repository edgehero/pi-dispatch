import { createHash } from "node:crypto";
import { DEFAULT_JOB_SIZE } from "./job-size.mjs";
import { containerIdOf, liveFixture, liveNames, liveProbeRunArgs, sweepStaleContainers, sweepStaleFixtures } from "./live-probes.mjs";

export const DISPLAY_CAPABILITY = "display";
export const DISPLAY_PROBE_TIMEOUT_MS = 60_000;
export const DISPLAY_SCREENSHOT_MAX = 1024 * 1024;
export const DISPLAY_REASONS = Object.freeze(["display-start-failed", "probe-missing", "browser-start-failed", "page-check-failed", "screenshot-invalid", "screenshot-blank", "text-not-rendered", "probe-timeout"]);

/** The image validates decoded pixels; the host also verifies it received exactly the PNG that was measured. */
export function displayResult(result, readScreenshot) {
	if (result?.ended === "timeout") return { ok: false, reason: "probe-timeout" };
	if (typeof result?.stdout !== "string" || result.stdout.length > 2048) return { ok: false, reason: "probe-result-invalid" };
	let value;
	try { value = JSON.parse(result.stdout); } catch { return { ok: false, reason: result?.code === 127 || result?.code === 126 ? "probe-missing" : "probe-result-invalid" }; }
	if (value?.v !== 1 || typeof value.ok !== "boolean") return { ok: false, reason: "probe-result-invalid" };
	if (!value.ok && DISPLAY_REASONS.includes(value.reason) && result.code !== 0) return { ok: false, reason: value.reason };
	if (result.code !== 0 || !value.ok || value.reason !== "rendered" || value.width !== 800 || value.height !== 600 || !/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) return { ok: false, reason: "probe-result-invalid" };
	try {
		const bytes = readScreenshot();
		if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > DISPLAY_SCREENSHOT_MAX || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== 800 || bytes.readUInt32BE(20) !== 600 || createHash("sha256").update(bytes).digest("hex") !== value.sha256) return { ok: false, reason: "screenshot-invalid" };
		const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
		return { ok: true, reason: "rendered", memoryPeak: count(value.memoryPeak), pidsPeak: count(value.pidsPeak) };
	} catch { return { ok: false, reason: "screenshot-invalid" }; }
}

/** A credential-free, offline job-shaped container. All runtime and filesystem effects are injected. */
export async function runDisplayProbe({ image, buildArgs, bin, run, fs, jobsDir, pid, nonce, isAlive, resolveEndpoint, isLocal = (e) => e?.local === true, user = null, relabel = false, size = DEFAULT_JOB_SIZE, hostCpus = null, cgroupParent, startTimeoutMs = 60_000, announce = () => {}, onScreenshot = () => {}, mode = "chromium" }) {
	const notes = [];
	let root = null;
	let started = false;
	let removed = false;
	let id = null;
	const name = liveNames(pid, nonce).display;
	const step = async (args, timeoutMs = 20_000) => {
		try { return await run(args, { timeoutMs }); } catch { return { code: null, stdout: "", ended: "error" }; }
	};
	// Re-read locality just before touching fixtures or the runtime. A changed context must not redirect bind paths.
	let endpoint;
	try { endpoint = await resolveEndpoint(); } catch { endpoint = null; }
	if (!isLocal(endpoint)) return { ok: false, warn: true, reason: "venue-not-local", notes };
	announce(`starting ${name} from ${image}, size ${size.memMiB} MiB / ${size.cpuCenti / 100} CPUs, with no credentials or network; its fixture under ${jobsDir} and container are removed afterwards`);
	for (const path of sweepStaleFixtures({ jobsDir, pid, fs, isAlive })) announce(`removed stale fixture ${path}`);
	for (const container of await sweepStaleContainers({ step, pid, isAlive })) announce(`removed stale container ${container}`);
	try {
		fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
		root = fs.mkdtempSync(`${jobsDir}/${liveNames(pid, nonce).fixturePrefix}`);
		root = fs.realpathSync(root);
		const fixture = liveFixture(root);
		for (const [key, dir] of Object.entries(fixture)) fs.mkdirSync(dir, { recursive: true, ...(key === "jobDir" || key === "sessionDir" ? { mode: 0o700 } : {}) });
		// Sleep is only the container's keeper. The bounded exec starts Xvfb and the actual headed browser.
		const args = liveProbeRunArgs({ image, name, fixture, user, relabel, size, hostCpus, ...(cgroupParent !== undefined ? { cgroupParent } : {}), buildArgs, sleepSeconds: Math.ceil(DISPLAY_PROBE_TIMEOUT_MS / 1000) + 30 });
		started = true;
		const begun = await step(args, startTimeoutMs);
		id = containerIdOf(begun);
		if (begun.code !== 0 || !id) return { ok: false, warn: true, reason: "container-start-failed", notes };
		const result = await step(["exec", id, "pi-display-probe", "/workspace/display.png", mode], DISPLAY_PROBE_TIMEOUT_MS);
		// Stop every possible writer before following the artifact path on the host. A stat followed by a read
		// while image code still runs would let that code exchange the checked regular file for a symlink.
		removed = (await step(["rm", "-f", id])).code === 0;
		if (!removed) return { ok: false, warn: true, reason: "probe-cleanup-failed", notes };
		const readScreenshot = () => {
			const path = `${fixture.workspace}/display.png`;
			const stat = fs.lstatSync(path);
			if (!stat.isFile() || stat.size > DISPLAY_SCREENSHOT_MAX) throw new Error("not a bounded regular screenshot");
			return fs.readFileSync(path);
		};
		const verdict = displayResult(result, readScreenshot);
		if (verdict.ok) await onScreenshot(readScreenshot(), verdict);
		return { ...verdict, notes };
	} catch {
		return { ok: false, warn: true, reason: "probe-infrastructure-failed", notes };
	} finally {
		if (started && !removed) {
			removed = (await step(["rm", "-f", id ?? name])).code === 0;
			if (!removed) notes.push(`remove the display probe: ${bin} rm -f ${id ?? name}`);
		}
		if (root !== null && (!started || removed)) {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { notes.push(`remove the display fixture ${root}`); }
		}
		else if (root !== null) notes.push(`display fixture retained until its container is gone: ${root}`);
	}
}
