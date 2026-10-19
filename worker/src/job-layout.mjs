/**
 * The worker's copy of the container's file layouts (issue #683, INT-CONTAINER-JOB-INPUTS): `mounts` for a venue that
 * binds the job's directories (`local`, `podman`), `sandbox` for one that copies them under the image's WORKDIR
 * (`openshell`). The runner reads the same table (image/runner/src/layout.mjs) by the name the worker writes into
 * PI_JOB_LAYOUT; the two files live on different hosts at run time, so the copy is forced, and
 * `worker/test/job-layout.test.mjs` holds them identical. CHANGE BOTH, IN THE SAME COMMIT.
 *
 * The `mounts` row is exactly container-spec.mjs's mount targets, which predate this file; that test pins them too, so
 * a binding venue's argv is byte-identical to one built before the table existed.
 */
export const LAYOUTS = Object.freeze({
	mounts: Object.freeze({ job: "/job", workspace: "/workspace", session: "/session", outbox: "/outbox", inbox: "/inbox", global: "/opt/pi-global" }),
	sandbox: Object.freeze({ job: "/sandbox/job", workspace: "/sandbox/workspace", session: "/sandbox/session", outbox: "/sandbox/outbox", inbox: null, global: "/sandbox/pi-global" }),
});

export const DEFAULT_LAYOUT = "mounts";

/** The layout `name` names, refusing one the table does not hold: a spec built on a guessed tree reads nothing. */
export function layoutFor(name = DEFAULT_LAYOUT) {
	if (typeof name !== "string" || !Object.hasOwn(LAYOUTS, name)) throw new Error(`unknown job layout ${JSON.stringify(name)} (known: ${Object.keys(LAYOUTS).join(", ")})`);
	return LAYOUTS[name];
}
