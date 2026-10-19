/**
 * Where a job's files sit inside the container (issue #683, INT-CONTAINER-JOB-INPUTS): one closed choice, never a path.
 *
 * Two layouts exist. `mounts` is every venue that binds the job's directories into the container (`local`, `podman`):
 * `/job`, `/workspace`, `/session`, `/outbox`, `/inbox` and `/opt/pi-global`, exactly the paths every runner before this
 * file used. `sandbox` is a venue that COPIES them (`openshell`): its runtime uploads and downloads only beneath the
 * image's WORKDIR, which this image sets to `/sandbox`, so every path the worker hands over or reads back sits under it.
 *
 * WHY A NAME AND NOT A ROOT PATH. The variable reaches the runner through the job's environment, and the worker refuses
 * it as a forwarded or secret name (worker/src/reserved-env.mjs), so only the worker sets it. A root path would still be
 * a free string the runner must then trust for every read it makes, including the prompt and the MCP config; a name
 * maps to a table baked into the image, so the worst a wrong value can do is be refused (`parseRunnerEnv`).
 *
 * An unknown value falls back to `mounts` HERE, so a module that reads a path at import time always has one, and is
 * refused by `parseRunnerEnv` before the job reads anything: a runner that silently used the wrong tree would read no
 * prompt and fail as a worker bug, or worse, read a stale one.
 *
 * `inbox` is null in the sandbox layout: a copying venue has no read-only mount to steer through, so its messages come
 * as frames on stdin (issue #686, steer-frames.mjs). `parseRunnerEnv` refuses PI_STEER there without that channel
 * rather than poll a directory nothing writes.
 *
 * The worker carries the same table (worker/src/job-layout.mjs), held identical to this one by a test, because the
 * worker and this file are in different places and neither can import the other at run time.
 */
export const LAYOUT_ENV = "PI_JOB_LAYOUT";

export const LAYOUTS = Object.freeze({
	mounts: Object.freeze({ job: "/job", workspace: "/workspace", session: "/session", outbox: "/outbox", inbox: "/inbox", global: "/opt/pi-global" }),
	sandbox: Object.freeze({ job: "/sandbox/job", workspace: "/sandbox/workspace", session: "/sandbox/session", outbox: "/sandbox/outbox", inbox: null, global: "/sandbox/pi-global" }),
});

export const DEFAULT_LAYOUT = "mounts";

/** The layout name `env` asks for, or null when it names none this table holds. Unset or empty is the default. */
export function layoutName(env) {
	// env-internal PI_JOB_LAYOUT: set by the worker on the container's closed env map, refused as a forwarded name.
	const raw = env === undefined || env === null ? undefined : env.PI_JOB_LAYOUT;
	if (raw === undefined || raw === "") return DEFAULT_LAYOUT;
	return Object.hasOwn(LAYOUTS, raw) ? raw : null;
}

/** This process's layout, read once: the paths below are module constants, and a job's environment does not change. */
export const LAYOUT = LAYOUTS[layoutName(process.env) ?? DEFAULT_LAYOUT];
