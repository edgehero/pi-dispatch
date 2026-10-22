import { existsSync } from "node:fs";
import { DEFAULT_BACKEND, PODMAN_BACKEND, UNATTRIBUTED_BACKEND, parseBackendFloor, parseBackendList } from "./backends.mjs";
import { buildDockerRunArgs, buildPodmanRunArgs } from "./docker-run.mjs";
import { sandboxDeadline } from "./sandbox-store.mjs";

/**
 * sandbox-policy.mjs -- which retained runs a sandbox may reopen, decided from the manifest and an environment alone
 * (issue #710, INT-SANDBOX-CONTRACT): the launcher table, the venue policy, and the refusals `resolveSandbox` makes
 * before anything is spawned.
 *
 * A LEAF on purpose. These are pure functions over a manifest, and sandbox.mjs, which opens the shell, imports the
 * container env builder, whose graph carries the model provider SDKs; the operator console asks the same questions on
 * every run page and must not bundle those to do it (3.1 MB against 6.9 MB). sandbox.mjs re-exports every name here
 * unchanged, so the CLI, the panel and the worker read one definition, and admin/test/console-bundle.test.mjs holds this file's
 * import graph free of the provider SDKs.
 */

/**
 * The venues a sandbox opens on, and how each one spells its container (issue #429): the CLI every spawn for that
 * venue goes through, and the job argv builder the session's argv is built by. Keyed by the venue name the manifest
 * records, so a run is reopened ONLY in the runtime that ran it: a podman run under docker would reproduce none of it
 * (another store, no keep-id, another uid map), and the reverse is as wrong.
 *
 * A TABLE rather than a `bin` read off the backend bundles, and that alternative was the obvious one: the bundles are
 * built by the worker at boot, and the CLI and the admin panel never build them (they would construct a
 * `runContainer`, a reaper and a `podman info` reader to open a shell). What the sandbox needs from a venue is two
 * facts, and both are the same values the bundles are built with (`bin: "podman"` and `buildPodmanRunArgs` in
 * `makePodmanBackend`); `sandbox.test.mjs` pins the pairing. A venue not in this table has no sandbox, by
 * construction: nothing here can reopen a run under a runtime it did not run in.
 *
 * Not "any venue declaring `remote: false`": a future non-remote venue on a third runtime would pass that and be
 * reopened under one of these two. Such a venue must add its own row, deliberately.
 */
export const SANDBOX_LAUNCHERS = Object.freeze({
	[DEFAULT_BACKEND]: Object.freeze({ bin: "docker", build: buildDockerRunArgs }),
	[PODMAN_BACKEND]: Object.freeze({ bin: "podman", build: buildPodmanRunArgs }),
});

/** The launcher for `venue`, or null. `Object.hasOwn`, so `"toString"` is not a venue. */
export function sandboxLauncher(venue) {
	return typeof venue === "string" && Object.hasOwn(SANDBOX_LAUNCHERS, venue) ? SANDBOX_LAUNCHERS[venue] : null;
}

/**
 * The blessed venues a sandbox can open on, in `PI_BACKENDS` order: the venues this host both runs and has a launcher
 * for. The retention reaper asks each one which sandboxes are open, and `--list` draws its RUNNING column from them.
 */
export function sandboxVenues(blessed) {
	return (Array.isArray(blessed) ? blessed : []).filter((venue) => sandboxLauncher(venue) !== null);
}

/**
 * `{ blessed, backendFloor }` as a sandbox opened from `env` sees them, through the worker's own two parsers. For the
 * admin panel, which deliberately never calls `loadConfig`; the CLI has the parsed config already. THROWS on a
 * malformed `PI_BACKENDS` or `PI_BACKEND_FLOOR`, exactly as the worker refuses to boot on one: a typo must never read
 * as "podman is not blessed" (a refusal an operator then chases in the wrong place) or as "no floor" (a podman sandbox
 * opened without the observations the deployment asks for). Read from THIS process's environment and never a
 * deployment's `.env`, which `OQ-038` records for the panel.
 */
export function sandboxVenuePolicy(env) {
	return { blessed: parseBackendList(env?.PI_BACKENDS), backendFloor: parseBackendFloor(env?.PI_BACKEND_FLOOR) };
}

/**
 * Whether a retained run can be re-opened HERE, judged by the venue it ran in (issue #277). `null` when it
 * can, else `{ refused, message }`. Exported for the admin panel, which asks before advertising the key.
 *
 * WHY THIS IS PER JOB. A sandbox opens a shell on THIS host, in the runtime the job ran in, against the job's retained
 * directory, so it can reproduce only a run whose container was built here. The check used to be deployment-wide
 * (refuse every sandbox when any blessed venue was remote) because the command takes a job id and could not learn its
 * venue; the manifest now records it, and the answer belongs to the job.
 *
 * HELD MEANS A VENUE THIS FILE HAS A LAUNCHER FOR (`SANDBOX_LAUNCHERS`: `local` through the docker CLI, `podman`
 * through this account's rootless podman), AND ONE `blessed` NAMES (issue #429). `blessed` is `PI_BACKENDS` as the
 * CALLER's process reads it: the CLI's `loadConfig`, the panel's own environment (`sandboxVenuePolicy`). A shell whose
 * `PI_BACKENDS` does not bless a venue has said it does not run that runtime, so reopening a run there would spawn a CLI
 * that environment took out of service. It is NOT what keeps an open shell's directory from the retention reaper, and
 * an earlier version of this comment said it was: the opener's `PI_BACKENDS` and the worker's routinely differ
 * (`OQ-038`), so the reaper asks the runtime each retained run records instead, whatever either blesses
 * (`makeSandboxRuntimeWatch`). It defaults to `local` alone, which is what `PI_BACKENDS` unset means, so a caller from
 * before issue #429 refuses and admits exactly as it did.
 *
 * Not "any venue declaring `remote: false`": a future non-remote venue on a third runtime would pass that and be
 * reopened under one of these two, reproducing a run from a runtime it never ran in. Such a venue must add its own
 * launcher row, deliberately.
 *
 * A MANIFEST WITH NO `backend` KEY predates venue attribution and ran on `local` (`UNATTRIBUTED_BACKEND`).
 * A key that is PRESENT but not a name is refused: `typeof` first, because the table's `backendFor(null)`
 * returns `local`, and a null stamp means the venue was never known, not that it was local.
 */
export function sandboxVenueRefusal({ jobId, manifest, blessed = [DEFAULT_BACKEND] }) {
	const venue = sandboxVenueOf(manifest);
	if (typeof venue !== "string" || venue === "") {
		return { refused: "venue-unreachable", message: `the manifest for ${jobId} names no backend, so this host cannot tell whether the run happened here` };
	}
	const launcher = sandboxLauncher(venue);
	const held = Array.isArray(blessed) && blessed.includes(venue);
	if (launcher && held) return null;
	if (launcher) {
		// A venue this file CAN open, on a host (as this process reads it) that does not bless it. The fix is an
		// environment, and it is named with where it is read: the CLI and the panel read `PI_BACKENDS` from the process
		// they run in, never from a deployment's `.env`, and "set it where you run this" is the whole remedy.
		return {
			refused: "venue-unreachable",
			message: `${jobId} ran on the ${JSON.stringify(venue)} backend, which PI_BACKENDS in this process's environment does not bless (it reads ${JSON.stringify((Array.isArray(blessed) ? blessed : []).join(","))}), so no sandbox opens on it here: a sandbox opens only on a venue this host blesses, through that venue's own CLI (${launcher.bin}). Set PI_BACKENDS where you run this as the worker's is set; it is read from this environment, not from the deployment's .env.`,
		};
	}
	return {
		refused: "venue-unreachable",
		// Names BOTH sides (issue #354): the venue that ran it, and the venues a sandbox opens through. "Not on this host's
		// docker daemon" was true only while every venue but `local` was elsewhere.
		message: `${jobId} ran on the ${JSON.stringify(venue)} backend, and a sandbox opens a shell only through a venue it has a launcher for on this host (${Object.entries(SANDBOX_LAUNCHERS).map(([name, l]) => `${JSON.stringify(name)} through the ${l.bin} CLI`).join(", ")}) against the retained directory, so it cannot reproduce that run. Open it on the venue that ran it.`,
	};
}

/** The venue a retained manifest records: its `backend` key when present (whatever it holds), else `UNATTRIBUTED_BACKEND`. */
export function sandboxVenueOf(manifest) {
	return Object.hasOwn(manifest ?? {}, "backend") ? manifest.backend : UNATTRIBUTED_BACKEND;
}

/**
 * The refusals `resolveSandbox` decides from the MANIFEST ALONE, in the order an operator should read
 * them. Not every manifest-only refusal on the `b` path: `decideSandboxJobUser` can refuse a run from
 * `manifest.jobUser` too, and it stays where it is for two MEASURED reasons rather than the vaguer "it
 * would change what the CLI refuses and when" this comment used to give (issue #367, item 5).
 *
 * IT IS NOT MANIFEST-ONLY. It returns `{ user: null, home: null }` on `darwin` and `win32` before it ever
 * reads the stamp, so the SAME malformed `jobUser` refuses everywhere else and does not refuse on macOS or
 * Windows. Measured across twelve platform strings: the split is darwin and win32 against every other
 * value, linux, the BSDs, sunos, aix and the empty string alike, which is wider than "linux" and is why
 * this says it that way. Folding it in would make this function's answer, and therefore whether the panel
 * advertises `b` at all, depend on the operator's own OS for an identical run. Every other refusal here is
 * a property of the run, and that is the whole of the argument.
 *
 * NOT because it is async, which is true of the function and is NOT a reason about this refusal: measured,
 * `job-user-stamp-invalid` is reached with zero calls to the endpoint resolver, the daemon-facts reader
 * and the image preflight, on every platform and every malformed shape. It is decided from the manifest
 * before any await that does work. A well-formed stamp does reach the daemon, which is why this function
 * stays async and out of a predicate called on every left and right between runs, but that is a cost of
 * moving the WHOLE function, not of the refusal #367 item 5 is about.
 *
 * Extracted (issue #337) because the admin panel needs the same answer before it advertises `b`, and the
 * alternative is the shape this file's own `openSandbox` docblock warns about: "Two callers assembling
 * the same session from parts is how one of them drops a part." The panel had exactly that, checking the
 * venue and not the other two, so a run whose manifest names no image was offered the key, given two
 * lines of detail about the session it would get, and refused the moment the key was pressed.
 *
 * SYNCHRONOUS AND MANIFEST-ONLY is the boundary, not an accident of what fitted. The panel reads this
 * inside a key handler, once per record; anything needing docker (a proxy that is not running, a sandbox
 * already up) stays in `openSandbox` where it belongs and is `OQ-038`'s residual for the panel.
 *
 * The VENUE comes first, and that ordering is #277's: for a run from another venue the image and the
 * workspace are symptoms, and the first refusal an operator reads should be the cause. A workspace that
 * happens to exist at the same path on this host would otherwise pass and silently reproduce the wrong
 * run.
 */
export function sandboxSyncRefusal({ jobId, manifest, fileExists = existsSync, blessed }) {
	const venue = sandboxVenueRefusal({ jobId, manifest, blessed });
	if (venue) return venue;
	if (!manifest?.image) {
		return { refused: "no-image", message: `the manifest for ${jobId} names no image, so the sandbox cannot reproduce the run` };
	}
	if (!manifest?.workspace || !fileExists(manifest.workspace)) {
		// The common cause for a local run: the operator's folder moved or was deleted. Naming the path is
		// the whole diagnosis, so name it.
		return { refused: "workspace-gone", message: `the workspace for ${jobId} is no longer at ${manifest.workspace} — a local folder that moved cannot be re-opened` };
	}
	return null;
}

/**
 * How close to its deadline a run may be and still open without `--pin` (issue #446): five minutes.
 *
 * WHY A MARGIN AND NOT THE DEADLINE ITSELF. The sweep holds a run whose sandbox a runtime reports open, but an open is
 * not in any `ps` until its container starts, and the opener spends that stretch on its own runtime asks (the running
 * check, the job user, the image, the network), each bounded in seconds. A sweep whose `ps` came before the container
 * and whose clock (`at`, read after its asks) is past the deadline would still delete the directory under the new
 * shell: window 1 of #446, reproduced. A run whose deadline is more than this far away cannot be past it by the time a
 * pass that missed the container decides, so the refusal closes that window with room to spare; inside it, `--pin`
 * writes a new deadline FIRST, which the sweep's own re-reads honour.
 */
export const SANDBOX_OPEN_GRACE_MS = 5 * 60 * 1000;

/**
 * The refusal of a run past its deadline, or within `SANDBOX_OPEN_GRACE_MS` of it, unless the open pins it first
 * (issue #446). `null` when the run may open.
 *
 * The deadline is `sandboxDeadline`'s, the sweep's own rule (the pin; else the earlier of the `retainUntil` the worker
 * wrote and `createdAt` plus THIS opener's window), so an opener whose own PI_SANDBOX_RETENTION_HOURS is larger than
 * the worker's is refused by the worker's deadline, not admitted by its own. The one case it cannot see, a worker
 * whose window was lowered after the run was retained, is the post-launch look's (`openSandbox`).
 * Shared by `resolveSandbox` and the admin panel's `readSandboxInfo`, which must not advertise `b` for a run the key
 * press would refuse; the panel has no pin, so its refusal is this one and it names the CLI command.
 */
export function sandboxWindowRefusal({ jobId, manifest, retentionHours, at, pin = false }) {
	if (pin) return null;
	const { until } = sandboxDeadline(manifest, retentionHours);
	const fix = `open it with \`pi-dispatch sandbox ${jobId} --pin\`, which extends its retention before anything starts`;
	if (until === null) {
		return { refused: "past-window", message: `the retained workspace for ${jobId} records no creation time, so the retention sweep deletes it on its next pass; ${fix}` };
	}
	if (until - at > SANDBOX_OPEN_GRACE_MS) return null;
	const when = new Date(until).toISOString();
	const where = until <= at ? `is past its retention window (it closed at ${when})` : `is within ${Math.round(SANDBOX_OPEN_GRACE_MS / 60000)} minutes of the end of its retention window (${when})`;
	return {
		refused: "past-window",
		message: `the retained workspace for ${jobId} ${where}, so the retention sweep may delete it under the shell; ${fix}`,
	};
}
