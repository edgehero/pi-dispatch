import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { judgeGatewayStatus, OPENSHELL_TESTED_VERSION } from "./openshell-cli.mjs";

/**
 * `pi-dispatch doctor --openshell` (issue #683): whether this host can run the `openshell` venue, BEFORE it is
 * blessable (`NOT_YET_BLESSABLE`, until issue #684), so an operator can set the gateway up and a reviewer can read what
 * the venue would meet. Every line is a free read; nothing creates a sandbox (the conformance run,
 * `.github/scripts/openshell-conformance.mjs`, is the live half).
 *
 * The lines, each with what fixes it:
 *   - the CLI and the gateway are the tested release (`OPENSHELL_TESTED_VERSION`). EXACT, not a floor: OpenShell is
 *     0.1.x and marks the interfaces this adapter drives experimental, so a newer release is untested until the
 *     conformance run says otherwise (`OQ-047`);
 *   - the gateway is connected and on this host (`CONST-VENUE-EGRESS-LAYER`'s third condition, the same judgement the
 *     per-job check makes);
 *   - its compute driver is the engine this deployment names, Docker or Podman, the only two v1 admits;
 *   - no gateway-wide policy is in force;
 *   - that engine is Docker 28 or later, or Podman 5 or later (measured: Docker Desktop 27.4 refused every create);
 *   - this host's kernel offers Landlock, on Linux, where the gateway on this host shares it; elsewhere it cannot be
 *     read here, and Docker Desktop's LinuxKit kernel has none (measured), which is said, never passed;
 *   - the job image declares `sandboxLayout`, read on that engine, the store the gateway runs images from.
 */

/** The settings this check reads. Both read here only, until #684 wires the venue into the worker's boot. */
export const OPENSHELL_ENGINE_ENV = "PI_OPENSHELL_ENGINE";
export const OPENSHELL_GATEWAY_ENV = "PI_OPENSHELL_GATEWAY";

/** The engine floors (issue #683): OpenShell's own support matrix, and Docker 28 measured as a real one. */
export const ENGINE_FLOORS = Object.freeze({ docker: [28, 0], podman: [5, 0] });

/** `{ code, stdout, stderr }`, `code: null` when it could not run or overran. Never throws. */
export function runQuiet(bin, args, { timeoutMs = 20_000, execFileFn = execFile } = {}) {
	return new Promise((resolve) => {
		try {
			execFileFn(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
				resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			});
		} catch {
			resolve({ code: null, stdout: "", stderr: "" });
		}
	});
}

const json = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

/** `[major, minor]` of the first `x.y` in `text`, or null. */
function versionOf(text) {
	const m = /(\d+)\.(\d+)/.exec(String(text ?? ""));
	return m ? [Number(m[1]), Number(m[2])] : null;
}
const atLeast = (have, want) => have !== null && (have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]));

/**
 * The checks, as doctor's `{ ok, warn?, label, fix? }`. `run` is the seam every spawn goes through; `env` is the
 * service environment doctor resolved; `platform` and `readLsm` are the Landlock read's.
 */
export async function openshellChecks(env = {}, { run = runQuiet, platform = process.platform, readLsm = () => readFileSync("/sys/kernel/security/lsm", "utf8"), image = env.PI_JOB_IMAGE || "pi-job:latest" } = {}) {
	const checks = [];
	const engine = env.PI_OPENSHELL_ENGINE === undefined || env.PI_OPENSHELL_ENGINE === "" ? "docker" : env.PI_OPENSHELL_ENGINE;
	const gateway = env.PI_OPENSHELL_GATEWAY || null;
	checks.push({ ok: true, warn: true, label: "openshell: built but not yet blessable -- PI_BACKENDS refuses it until issue #684 ships its egress rules and credential providers; these lines say whether this host is ready" });
	if (engine !== "docker" && engine !== "podman") {
		checks.push({ ok: false, label: `openshell: ${OPENSHELL_ENGINE_ENV} names the gateway's engine`, fix: `set ${OPENSHELL_ENGINE_ENV} to docker or podman, the compute drivers v1 admits (it is ${JSON.stringify(engine)})` });
		return checks;
	}
	if (gateway !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(gateway)) {
		checks.push({ ok: false, label: `openshell: ${OPENSHELL_GATEWAY_ENV} names a registered gateway`, fix: `set ${OPENSHELL_GATEWAY_ENV} to a name \`openshell gateway list\` shows, or unset it for the CLI's active gateway` });
		return checks;
	}
	const os = (args) => run("openshell", [...(gateway ? ["--gateway", gateway] : []), ...args]);

	const cli = await os(["--version"]);
	const cliVersion = /openshell (\S+)/.exec(cli.stdout)?.[1] ?? null;
	if (cli.code !== 0 || cliVersion === null) {
		checks.push({ ok: false, label: "openshell: the CLI is installed", fix: `install OpenShell ${OPENSHELL_TESTED_VERSION} (https://github.com/NVIDIA/OpenShell/releases/tag/v${OPENSHELL_TESTED_VERSION}), the release this venue was measured on` });
		return checks;
	}
	checks.push(cliVersion === OPENSHELL_TESTED_VERSION ? { ok: true, label: `openshell: CLI ${cliVersion}, the tested release` } : { ok: false, label: `openshell: CLI ${cliVersion} is the tested release (${OPENSHELL_TESTED_VERSION})`, fix: `install OpenShell ${OPENSHELL_TESTED_VERSION}: the venue drives interfaces OpenShell marks experimental, so another release is untested until the conformance run passes on it` });

	const status = judgeGatewayStatus(json((await os(["status", "-o", "json"])).stdout));
	if (!status.connected) {
		checks.push({ ok: false, label: "openshell: the gateway answers", fix: "start the gateway (`systemctl --user start openshell-gateway`, or `brew services start openshell` on macOS) and register it on loopback: `openshell gateway add https://127.0.0.1:17670 --local`" });
		return checks;
	}
	checks.push(status.local ? { ok: true, label: "openshell: the gateway is on this host (loopback or a unix socket)" } : { ok: false, label: "openshell: the gateway is on this host", fix: "the venue holds the job's credentials in its gateway, so it runs only on one this deployment runs itself (CONST-VENUE-EGRESS-LAYER): register the local gateway on loopback" });
	checks.push(status.version === OPENSHELL_TESTED_VERSION ? { ok: true, label: `openshell: gateway ${status.version}, the tested release` } : { ok: false, label: `openshell: gateway ${status.version ?? "of unknown version"} is the tested release (${OPENSHELL_TESTED_VERSION})`, fix: `run the gateway of OpenShell ${OPENSHELL_TESTED_VERSION}` });

	const info = json((await os(["gateway", "info", "-o", "json"])).stdout);
	const drivers = Array.isArray(info?.compute_drivers) ? info.compute_drivers.map((d) => d?.name).filter((n) => typeof n === "string") : null;
	if (drivers === null) checks.push({ ok: true, warn: true, label: "openshell: the gateway's compute driver could not be read (gateway info answers an admin only)", fix: `make sure the gateway's compute_driver is ${engine}` });
	else checks.push(drivers.length === 1 && drivers[0] === engine ? { ok: true, label: `openshell: the gateway's compute driver is ${engine}` } : { ok: false, label: `openshell: the gateway's compute driver is ${engine}`, fix: `the gateway runs ${drivers.join(", ") || "no driver"}; set its compute_driver to ${engine} (OPENSHELL_COMPUTE_DRIVER=${engine}), or ${OPENSHELL_ENGINE_ENV} to the one it runs, if that is docker or podman` });

	const global = await os(["policy", "get", "--global", "-o", "json"]);
	const none = global.code !== 0 && /no global policy revision found/.test(global.stderr.replace(/[│\s]+/g, " "));
	checks.push(global.code === 0 ? { ok: false, label: "openshell: no gateway-wide policy is in force", fix: "a global policy replaces every sandbox's own, so the per-job policy the worker generates would not be the one in force: `openshell policy delete --global`" } : none ? { ok: true, label: "openshell: no gateway-wide policy is in force" } : { ok: false, label: "openshell: whether a gateway-wide policy is in force could be read", fix: "`openshell policy get --global` failed for another reason than none being set; run it and read the error" });

	const engineRead = await run(engine, engine === "docker" ? ["version", "--format", "{{.Server.Version}}"] : ["version", "--format", "{{.Version}}"]);
	const engineVersion = engineRead.code === 0 ? versionOf(engineRead.stdout) : null;
	const floor = ENGINE_FLOORS[engine];
	checks.push(atLeast(engineVersion, floor) ? { ok: true, label: `openshell: ${engine} ${engineVersion.join(".")} (${floor[0]} or later)` } : { ok: false, label: `openshell: ${engine} is ${floor[0]} or later`, fix: engineVersion === null ? `${engine} did not answer \`${engine} version\`` : `${engine} ${engineVersion.join(".")} is older than OpenShell supports (measured: Docker Desktop 27.4 refused every sandbox create); upgrade it` });

	if (platform === "linux") {
		let lsm = null;
		try {
			lsm = String(readLsm());
		} catch {
			lsm = null;
		}
		if (lsm === null) checks.push({ ok: true, warn: true, label: "openshell: Landlock could not be read (/sys/kernel/security/lsm)", fix: "OpenShell needs Landlock ABI 3 (Linux 6.2 or later); a kernel without it fails every create" });
		else checks.push(lsm.split(",").map((s) => s.trim()).includes("landlock") ? { ok: true, label: "openshell: this kernel offers Landlock" } : { ok: false, label: "openshell: this kernel offers Landlock", fix: "boot a kernel with Landlock in its LSM list (Linux 6.2 or later, `lsm=...,landlock`); the venue confines every sandbox and its job inputs with it" });
	} else {
		checks.push({ ok: true, warn: true, label: "openshell: Landlock cannot be read from this host", fix: "the gateway's engine runs in a VM whose kernel must offer Landlock ABI 3; Docker Desktop's LinuxKit kernel offers none (measured), so every create fails there" });
	}

	const labels = await run(engine, ["image", "inspect", "--format", '{{index .Config.Labels "dev.pi-dispatch.capabilities"}}', image]);
	const caps = labels.code === 0 ? labels.stdout.trim().split(",") : null;
	checks.push(caps === null ? { ok: false, label: `openshell: the job image (${image}) is in ${engine}'s store`, fix: `build or pull ${image} into ${engine}, the store the gateway runs images from` } : caps.includes("sandboxLayout") ? { ok: true, label: `openshell: the job image (${image}) declares sandboxLayout` } : { ok: false, label: `openshell: the job image (${image}) declares sandboxLayout`, fix: "use a job image built after issue #683 (ghcr.io/edgehero/pi-job:latest, or rebuild yours FROM it): its runner finds the job under /sandbox and carries pi-landlock" });
	return checks;
}
