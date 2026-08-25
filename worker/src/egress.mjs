import { spawn } from "node:child_process";

/**
 * REQ-EGRESS-ALLOWLIST. The shipped egress policy: what a job container may talk to, expressed in the
 * worker's own `docker run` argv rather than in a host firewall this process cannot see.
 *
 * This module imports nothing but `node:child_process` -- deliberately, and for `image-preflight.mjs`'s
 * exact reason. It holds a money gate: it decides whether a budget slot is spent, so its tests must run
 * everywhere, unconditionally. It also owns every NAME the policy uses, so the gate that checks the proxy,
 * the argv that joins the network and the env that points at the proxy are ONE answer by construction
 * rather than three literals that happen to agree.
 *
 * The shape, and why it is this shape rather than the one `docs/sandbox.md` documents:
 *
 *   - **One `--internal` network PER JOB**, holding exactly two endpoints: the job container and the
 *     proxy. Internal means dockerd itself drops every packet bound outside the subnet, so the boundary is
 *     the daemon's rather than a `DOCKER-USER` chain an operator maintains. Per-job rather than shared
 *     because a shared network is a shared L2 segment: at DES-CONCURRENCY-3 that is three mutually
 *     untrusting issue authors who can reach each other. Measured, because the alternative was tempting:
 *     `enable_icc=false` on a shared network would have blocked job-to-job traffic, but ICC governs ALL
 *     container-to-container traffic on that bridge and the proxy is a container, so it blocks the very
 *     path this design depends on. Per-job networks make job-to-job STRUCTURALLY impossible instead, and
 *     that is strictly stronger than today: two job containers on docker's default bridge can reach each
 *     other by IP right now (verified), so this requirement removes an adjacency rather than adding one.
 *     Measured cost: ~190ms to create and attach, ~260ms to detach and remove, against a container run of
 *     minutes.
 *
 *   - **The proxy carries EVERYTHING, including the provider call.** `docs/sandbox.md` records the
 *     opposite -- that the runner's provider traffic ignores `HTTPS_PROXY` even with `NODE_USE_ENV_PROXY=1`,
 *     so the provider needs a network-layer rule naming an address. That is refuted (issue #202): the
 *     observation was real and the cause was not pi. `@anthropic-ai/sdk` resolves `globalThis.fetch` at
 *     construction and pi-ai passes it no dispatcher, so the provider call follows whatever the process's
 *     global dispatcher is -- and the pinned image's Node 22.23.1 installs a proxy-aware one when
 *     `NODE_USE_ENV_PROXY=1` is set. What actually happened is two paragraphs above that doc's own trap:
 *     the container env is a CLOSED allowlist, and the recipe's `PI_FORWARD_ENV` line names
 *     HTTPS_PROXY/HTTP_PROXY/NO_PROXY and NOT `NODE_USE_ENV_PROXY`, so the flag was set on the host and
 *     never reached the runner. Measured against the real provider through this proxy: 401 in 269ms.
 *     Hence a hostname allowlist and no address rule anywhere, which is the mechanism OQ-004's close
 *     condition actually names.
 */

/**
 * The long-lived proxy component, started by `deploy/docker-compose.yml`'s `egress` profile (or by
 * `pi-dispatch up`, which mirrors it). One per host, not one per job: it is the only thing on the job's
 * network with a route out, and it is where the allowlist lives.
 */
export const DEFAULT_EGRESS_PROXY = "pi-dispatch-egress-proxy";

/** The port squid listens on inside its container. Never published: reachable only from a job network. */
export const EGRESS_PROXY_PORT = 3128;

/**
 * This container's own network: the container name with `-net` appended.
 *
 * DERIVED from the container name rather than rebuilt from the job id, and that is the whole point. The
 * container name already survives every id shape this project produces -- forge delivery guids, replica
 * suffixes, `local-<hex>` -- and docker's network-name grammar is the container-name grammar, so a name
 * that is legal for one is legal for the other BY CONSTRUCTION. Rebuilding it from the id would be a
 * second place for that reasoning to live and the copy that missed the next id shape would be the one
 * nobody was looking at.
 *
 * It also inherits the namespace split for free. The boot reaper filters `pi-job-` and docker matches that
 * as a SUBSTRING, so `pi-job-<id>-net` is swept and `pi-sandbox-<id>-net` is not -- which is exactly the
 * rule the container names already follow, and for the same reason: a worker restart must not tear the
 * network out from under a shell an operator is sitting in. A test pins both.
 */
export const NETWORK_SUFFIX = "-net";

export function networkNameFor(containerName) {
	return `${containerName}${NETWORK_SUFFIX}`;
}

/**
 * How a container reaches the proxy: by NAME, resolved by docker's embedded DNS on the user-defined
 * network. `docs/sandbox.md`'s recipe had to write a bare gateway IP because the DEFAULT bridge has no
 * name resolution; a user-defined network does, which is what removes the host-specific literal.
 */
export function egressProxyUrl(proxy = DEFAULT_EGRESS_PROXY) {
	return `http://${proxy}:${EGRESS_PROXY_PORT}`;
}

/**
 * The environment that points a job at the proxy, or `{}` when no policy is armed.
 *
 * `NODE_USE_ENV_PROXY` is the load-bearing one and the one the recipe omits. Without it the two proxy
 * variables steer `git`, `gh`, `npm` and Chromium and NOT the runner's own provider call, which is the
 * whole "trap" `docs/sandbox.md` records -- and behind an internal network that is not a leak but an
 * outage: every job dies at its first turn. It is emitted here, in the closed map, rather than left to
 * `PI_FORWARD_ENV`, so an operator cannot arm the policy and forget the one variable that makes it work.
 */
export function egressEnv({ proxy = DEFAULT_EGRESS_PROXY, armed }) {
	if (!armed) return {};
	const url = egressProxyUrl(proxy);
	return {
		HTTPS_PROXY: url,
		HTTP_PROXY: url,
		// Loopback only. The job has no other name it may reach directly: everything else goes to the
		// proxy, which is what makes the allowlist the single place the policy is written.
		NO_PROXY: "localhost,127.0.0.1",
		NODE_USE_ENV_PROXY: "1",
	};
}

/**
 * Build the pre-spend egress check. Resolves one of:
 *
 *   { ok: true }              -- no policy armed, or the proxy is up
 *   { proxyMissing: name }    -- the daemon answered and has no such container => POLICY, refuse
 *   { proxyStopped: name }    -- it exists and is not running                  => POLICY, refuse
 *   { unavailable: name }     -- docker itself did not answer                  => INFRA, retry
 *
 * The POLICY/INFRA split is disambiguated POSITIVELY with `docker info`, never by matching stderr, for
 * `image-preflight.mjs`'s recorded reason: the wording differs across CLI versions and platforms, and a
 * mismatch would turn a transient daemon blip into a permanent un-retried refusal. The extra probe runs
 * ONLY on the failure path, so the happy path costs exactly one spawn.
 *
 * ZERO spawns when unarmed, which is what makes a deployment without a policy pay nothing at all.
 *
 * The gate gets `Running`, not `Health`. A healthcheck is advisory and can flap; a money gate that refuses
 * on a flapping signal silently drops real work, and one that retries on it burns the second budget slot
 * this whole requirement exists to save. `doctor` reports health, where a human is reading.
 *
 * The gate deliberately does NOT probe reachability. It cannot: the job's network does not exist yet, and
 * the only credential-free way to prove the provider is reachable is an unauthenticated request to a third
 * party, which is not a thing to do before every job on every deployment. `doctor` does it once, when
 * asked. What is left unproven is stated where an operator reads it rather than implied away.
 */
export function makeEgressPreflight({ proxy = DEFAULT_EGRESS_PROXY, armed = false, spawnFn = spawn } = {}) {
	return async function egressPreflight() {
		if (!armed) return { ok: true };
		const probe = await runDocker(spawnFn, ["inspect", "--format={{.State.Running}}", proxy], true);
		if (probe.code === 0) {
			return probe.stdout.trim() === "true" ? { ok: true, proxy } : { proxyStopped: proxy };
		}
		if ((await runDocker(spawnFn, ["info"])).code === 0) return { proxyMissing: proxy };
		return { unavailable: proxy };
	};
}

/**
 * Create this job's network and attach the proxy to it. Resolves `true` on success, `false` on any
 * failure -- the caller turns that into an INFRA retry with `container-never-started`, because a network
 * that could not be created spent nothing and a retry may well succeed.
 *
 * `--internal` is the whole control and it is passed at CREATE time, so there is no window in which the
 * network exists with a route out. Nothing is read back here: the network was made by this process,
 * moments ago, with these flags. `doctor` reads back the proxy's own attachments, where an operator's
 * hand-built estate is what is being checked.
 */
export async function createJobNetwork(spawnFn, { network, proxy = DEFAULT_EGRESS_PROXY }) {
	if ((await runDocker(spawnFn, ["network", "create", "--internal", network])).code !== 0) return false;
	if ((await runDocker(spawnFn, ["network", "connect", network, proxy])).code !== 0) {
		// Roll back rather than leave a network the proxy cannot serve: a half-built policy that admits a
		// job is worse than one that refuses it.
		await removeJobNetwork(spawnFn, { network, proxy });
		return false;
	}
	return true;
}

/**
 * Detach the proxy and remove the network. Best-effort and never throws: this runs in a `finally`, after
 * the container has already exited, and a failure here must not change the job's outcome. What it leaves
 * behind if it fails is a network with no members, which the boot reaper sweeps.
 */
export async function removeJobNetwork(spawnFn, { network, proxy = DEFAULT_EGRESS_PROXY }) {
	await runDocker(spawnFn, ["network", "disconnect", "-f", network, proxy]);
	await runDocker(spawnFn, ["network", "rm", network]);
}

/**
 * A spawned docker command's `{ code, stdout }`; `code` is `null` when it could not be launched at all.
 * `null !== 0` falls through to the same branch a non-zero exit does, which is what we want: no docker
 * binary is no answer. Same shape as image-preflight.mjs's own runDocker and doctor's runCmd, so all
 * three agree on what "present" means.
 */
function runDocker(spawnFn, args, capture = false) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn("docker", args, { stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		if (capture && child.stdout) {
			child.stdout.setEncoding?.("utf8");
			// Bounded: a --format string we control produces one short line, and a runaway pipe on a money
			// gate should not become the worker's memory problem.
			child.stdout.on("data", (chunk) => {
				if (stdout.length < 4096) stdout += chunk;
			});
		}
		child.on("error", () => resolve({ code: null, stdout: "" })); // ENOENT etc. -- docker is not on PATH
		child.on("close", (code) => resolve({ code, stdout }));
	});
}
