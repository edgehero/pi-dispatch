import { createRequire } from "node:module";

/**
 * Issue #427: put the egress proxy back under the runner's provider call after pi has taken it away.
 *
 * With egress armed the worker gives the job `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY=1`
 * (worker/src/egress.mjs), and the last one makes Node install an `EnvHttpProxyAgent` as the global dispatcher that
 * `fetch`, and so both provider SDKs, send through. Loading pi undoes that. pi 0.80.7 depends on npm `undici`
 * 8.5.0, whose module load replaces the shared global dispatcher (`Symbol.for("undici.globalDispatcher.1")`) with
 * its own wrapper around a plain Agent, and that one ignores the proxy variables. Measured on the job image (Node
 * 22.23.1) on an `--internal` network: a plain `fetch` reached the provider through the proxy (401 in 279 ms), and
 * the same `fetch` after `import("@earendil-works/pi-coding-agent")` went direct and died on `ENOTFOUND` in 11 ms.
 * Every egress-armed job ended at its first turn with `Connection error.`, on every venue.
 *
 * pi's own CLI repairs it with `configureHttpDispatcher()` (dist/core/http-dispatcher.js), but the runner starts pi
 * through `createAgentSession`, not the CLI, and that function is not exported (`exports` names only `.` and
 * `./rpc-entry`). So the runner does the same repair itself, with two deliberate differences:
 *
 *   - It uses the `undici` copy pi resolves, not one of its own. A second copy would be a second version to keep in
 *     step, and the dispatcher it installs is read through the shared symbol whichever copy wrote it.
 *   - It does not call `undici.install()`, which replaces the global `fetch` as well. pi does that because Node 26's
 *     bundled fetch mishandles compressed bodies through npm undici's dispatcher; the image runs Node 22, and without
 *     it the provider was reached through the proxy all the same (measured, with and without).
 *
 * Only when `NODE_USE_ENV_PROXY` is "1", which is exactly what the worker emits: with no policy armed nothing is
 * installed, and the job keeps whatever dispatcher pi gave it, as it always has.
 */

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The `undici` pi itself loads, resolved from pi's own package rather than from the runner's. */
export function loadPiUndici(resolve = (specifier) => import.meta.resolve(specifier)) {
	return createRequire(resolve(PI_PACKAGE))("undici");
}

/**
 * Install an env-proxy dispatcher when the job was given one. Returns whether it did. Call it after pi is loaded and
 * before the first provider call; `EnvHttpProxyAgent` reads the proxy variables itself, at construction.
 */
export function restoreEnvProxyDispatcher({ env = process.env, loadUndici = loadPiUndici } = {}) {
	// env-internal NODE_USE_ENV_PROXY: set on the container by the worker whenever egress is armed (egressEnv), never by
	// an operator, and refused in PI_FORWARD_ENV while the policy is armed.
	if (env.NODE_USE_ENV_PROXY !== "1") return false;
	const undici = loadUndici();
	undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
	return true;
}

/**
 * The runner's own path to its first provider call, for a probe that must take it rather than a plain `fetch`: doctor's
 * egress canary. A plain `fetch` never loads pi, so it stayed green through issue #427 while every job failed.
 */
export async function loadPiThenRestore(options) {
	await import(PI_PACKAGE);
	return restoreEnvProxyDispatcher(options);
}
