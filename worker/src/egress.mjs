import { spawn } from "node:child_process";
import { makeDetachGate } from "./netns-keeper.mjs";

/**
 * REQ-EGRESS-ALLOWLIST. The shipped egress policy: what a job container may talk to, expressed in the
 * worker's own `docker run` argv rather than in a host firewall this process cannot see.
 *
 * This module imports nothing but `node:child_process` and the two leaves under the detach gate (`netns-keeper.mjs`,
 * `daemon-facts.mjs`, which import nothing else of this project's) -- deliberately, and for `image-preflight.mjs`'s
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
 *     Hence a hostname allowlist and no address rule that allows anything, which is the mechanism OQ-004's
 *     close condition actually names (the proxy's one address rule only denies this host's loopback and
 *     link-local addresses, issue #428).
 *     BUT THAT WAS MEASURED WITHOUT PI LOADED (issue #427). pi depends on npm `undici` (8.5.0 at the 0.80.7
 *     pin where this was measured, 8.10.2 at the 0.99.1 pin, where loading pi was re-measured to drop the
 *     env proxy the same way), whose load replaces the global dispatcher the flag installs with one that
 *     ignores the proxy variables, so in the runner the provider call went direct and every egress-armed job died at its first
 *     turn. The runner now re-installs an env-proxy dispatcher after loading pi
 *     (image/runner/src/env-proxy.mjs), and doctor's canary takes that same path instead of a plain fetch.
 */

/**
 * Is the egress policy armed for this environment? An opt-OUT: ON unless explicitly "0".
 *
 * THE PARSE LIVES HERE, not in config.mjs, and that is the point. The worker reads it through `loadConfig`,
 * but `doctor` and `up` read the environment directly -- and a second copy of this three-line rule is a
 * second place for the default to be wrong. It was: while this was `=== "1"` in three files, flipping the
 * default in one of them left doctor silently reporting nothing about a policy that was on.
 *
 * Strict, matching PI_GLOBAL_ALLOW_EXTENSIONS exactly, including its polarity: unset, "" and "1" all mean
 * ON; only "0" turns it off; ANY other value throws. A typo must never silently produce the OPEN posture
 * while an operator believes they are bounded -- they would then be worse off than one who knows they have
 * no policy, because the belief displaces the credential bound that is actually holding.
 *
 * Throws a plain Error; config.mjs re-tags it as a config error so the CLI prints it cleanly. This module
 * imports nothing but node:child_process (see the header), so it does not reach for that tagger itself.
 */
export function egressArmed(env) {
	const raw = env?.PI_EGRESS;
	if (raw === undefined || raw === "" || raw === "1") return true;
	if (raw === "0") return false;
	throw new Error(`PI_EGRESS must be exactly "0" (off) or "1"/unset (on); got ${JSON.stringify(raw)}`);
}

/**
 * The long-lived proxy component, started by `deploy/docker-compose.yml`'s `egress` profile (or by
 * `pi-dispatch up`, which mirrors it). One per host, not one per job: it is the only thing on the job's
 * network with a route out, and it is where the allowlist lives.
 */
export const DEFAULT_EGRESS_PROXY = "pi-dispatch-egress-proxy";

/**
 * The proxy container this deployment names, from env: `PI_EGRESS_PROXY`, else the default. `||` rather than
 * `??`, so an empty string falls back. The worker's config, `doctor` and the admin panel's sandbox all read it
 * through here, so they cannot disagree about what a given environment means -- though each reads its OWN
 * environment: the worker's comes from the deployment's .env, the panel's from wherever pi was started.
 */
export function egressProxyName(env) {
	return env?.PI_EGRESS_PROXY || DEFAULT_EGRESS_PROXY;
}

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
 * It also inherits the namespace split for free. The boot reaper narrows with `--filter name=pi-job-`, which
 * docker matches as a SUBSTRING, and then decides on the name itself with `isJobNamespace` -- the filter is
 * not the namespace, and since issue #357 it never was. Either way `pi-job-<id>-net` is swept and
 * `pi-sandbox-<id>-net` is not, which is exactly the rule the container names already follow and for the
 * same reason: a worker restart must not tear the network out from under a shell an operator is sitting in.
 * A test pins both.
 */
export const NETWORK_SUFFIX = "-net";

export function networkNameFor(containerName) {
	return `${containerName}${NETWORK_SUFFIX}`;
}

/**
 * `pi-dispatch doctor`'s canary objects: one throwaway network per doctor PROCESS, and one probe container per
 * direction on it. NAMED HERE rather than spelled inline in `doctor.mjs`, because after issue #350 the name has
 * three consumers in that module -- the create, the teardown, and the anchored regex of the dead-pid sweep --
 * and one outside it, `INT-EGRESS-POLICY-CONTRACT`'s object table.
 *
 * Both stay OUTSIDE `pi-job-` and `pi-sandbox-`, for the reason `NETWORK_SUFFIX` above already gives: those
 * sweeps claim a PREFIX (the boot reaper's is `isJobNamespace`), and their `--filter` is wider still, so a
 * canary name that fell inside either would be swept by a reaper that knows nothing about doctor.
 */
export const EGRESS_CANARY_NET_PREFIX = "pi-dispatch-egress-doctor-";
export const EGRESS_CANARY_PROBE_PREFIX = "pi-dispatch-egress-probe-";

/** The canary network for one doctor process. */
export function egressCanaryNetwork(pid) {
	return `${EGRESS_CANARY_NET_PREFIX}${pid}`;
}

/** One canary probe container, per direction and per doctor process. */
export function egressCanaryProbe(slug, pid) {
	return `${EGRESS_CANARY_PROBE_PREFIX}${slug}-${pid}`;
}

/**
 * The probe containers doctor runs per declared model endpoint (issue #503), on the same canary network. UNDER the
 * canary's probe prefix on purpose: every line and page that tells an operator what a leftover probe looks like
 * (`pi-dispatch-egress-probe-...`) stays true, and the dead-pid sweep matches these by an anchored pattern of its own.
 */
export const EGRESS_ENDPOINT_PROBE_PREFIX = `${EGRESS_CANARY_PROBE_PREFIX}endpoint-`;

/** One endpoint probe container: per probe, per endpoint id (`[a-z0-9-]{1,32}`, the parser's rule) and per doctor process. */
export function egressEndpointProbe(slug, id, pid) {
	return `${EGRESS_ENDPOINT_PROBE_PREFIX}${slug}-${id}-${pid}`;
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
 * The gate gets `Status` ("running"), not `Health`. A healthcheck is advisory and can flap; a money gate that refuses
 * on a flapping signal silently drops real work, and one that retries on it burns the second budget slot
 * this whole requirement exists to save. `doctor` reports health, where a human is reading.
 *
 * The gate deliberately does NOT probe reachability. It cannot: the job's network does not exist yet, and
 * the only credential-free way to prove the provider is reachable is an unauthenticated request to a third
 * party, which is not a thing to do before every job on every deployment. `doctor` does it once, when
 * asked. What is left unproven is stated where an operator reads it rather than implied away.
 */
/** The proxy states that refuse a job (gate round 3's simple rule, beside `makeEgressPreflight`). */
// `created` among them (round-cap re-review): a container created and never started stays so until someone acts
// (measured on Docker Engine 29.8.1: a create that failed its mount stayed `created`, ExitCode 127).
export const STOPPED_PROXY_STATES = new Set(["paused", "exited", "dead", "created"]);

export function makeEgressPreflight({ proxy = DEFAULT_EGRESS_PROXY, armed = false, spawnFn = spawn, bin = "docker" } = {}) {
	// Issue #354: `bin` is the venue's CLI, for both probes, so the proxy is looked for where the job will run.
	return async function egressPreflight() {
		if (!armed) return { ok: true };
		// `.State.Status` "running" (issue #453): measured on Docker Engine 29.8.1, a paused and a restarting container both
		// read `.State.Running` true, and neither carries a job's traffic; the status word tells them apart.
		const probe = await runDocker(spawnFn, ["inspect", "--format={{.State.Status}}", proxy], true, bin);
		if (probe.code === 0) {
			const status = probe.stdout.trim();
			// THE SIMPLE RULE (issue #453, gate round 3 and the re-review): only `running` admits; `paused`, `exited`, `dead`
			// and `created` are a stopped proxy, which stays so until someone acts, so the job is refused; EVERY other word
			// (restarting, stopping, removing, initialized, podman's `stopped` between restarts, one no runtime prints yet)
			// is an infra retry with the state in its words. BullMQ gives a job two attempts, so that is one retry, then
			// the job fails: a retry buys a moment, not a wait.
			if (status === "running") return { ok: true, proxy };
			if (STOPPED_PROXY_STATES.has(status)) return { proxyStopped: proxy };
			return { unavailable: proxy, state: /^[a-z]{1,20}$/.test(status) ? status : "unreported" };
		}
		if ((await runDocker(spawnFn, ["info"], false, bin)).code === 0) return { proxyMissing: proxy };
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
export async function createJobNetwork(spawnFn, { network, proxy = DEFAULT_EGRESS_PROXY, bin = "docker" }) {
	// `bin` (issue #354) is the venue's CLI: the network, the proxy's attachment and the container that joins it must all
	// live in ONE runtime, or the job's `--network=` names a network its daemon has never heard of.
	return createJobNetworkWith(spawnRunner(spawnFn, bin), { network, proxy, bin });
}

/**
 * `createJobNetwork` over ANY docker runner, `(args) => Promise<{ code }>` (issue #344). The job path's spawn and
 * `doctor --live`'s bounded runner are two runners, and a probe that built its networks with a second copy of this
 * sequence would be reading back a network no job gets. Never throws: a runner that throws is a failed step.
 */
export async function createJobNetworkWith(docker, { network, proxy = DEFAULT_EGRESS_PROXY, bin = "docker" }) {
	if ((await runWith(docker, ["network", "create", "--internal", network]))?.code !== 0) return false;
	if ((await runWith(docker, ["network", "connect", network, proxy]))?.code !== 0) {
		// Roll back rather than leave a network the proxy cannot serve: a half-built policy that admits a
		// job is worse than one that refuses it. The connect FAILED, so the proxy is not on it: nothing running is
		// detached, and the gate asks nothing (issue #452).
		await removeJobNetworkWith(docker, { network, proxy, bin, proxyRunning: false });
		return false;
	}
	return true;
}

/**
 * Whether a network by this name exists. `false` when docker says no or cannot be asked; callers use it only
 * to explain a failure they already have, never to decide to remove anything.
 */
export async function networkExists(spawnFn, network, { bin = "docker" } = {}) {
	return (await runDocker(spawnFn, ["network", "inspect", network], false, bin)).code === 0;
}

/**
 * Detach the proxy and remove the network. Best-effort and never throws: it runs in a `finally`, after the
 * container has exited (or when a network has just been built for a container that will not start), and a
 * failure here must not change the outcome. What it leaves behind if it fails is a network, which the boot
 * reaper tries to remove for a job (any name under the `pi-job-` prefix since issue #360, not only the
 * `<container>-net` one this builds, detaching what is attached first since issue #357) and never for a sandbox
 * (`pi-sandbox-`); a sandbox's next open of the same run refuses and names it for removal.
 */
export async function removeJobNetwork(spawnFn, { network, proxy = DEFAULT_EGRESS_PROXY, bin = "docker", gate = null, readRuntime = null, onRefused = null }) {
	// `readRuntime` (issue #452, gate round 4): the runtime the job or session was ADMITTED on, so a teardown does not read
	// it again. A fresh `docker info` at every teardown that timed out, failed or answered `ServerErrors` read as
	// `runtime-unreadable` on Docker Engine, where no keeper exists, and left the job's network behind every time
	// (measured); a pool of leaked networks ends in every egress job failing.
	const runner = spawnRunner(spawnFn, bin);
	return removeJobNetworkWith(runner, { network, proxy, bin, gate: gate ?? makeDetachGate(runner, { bin, ...(readRuntime ? { readRuntime } : {}) }), ...(onRefused ? { onRefused } : {}) });
}

/**
 * `removeJobNetwork` over any docker runner (issue #344). Detaches ONLY the proxy, then `network rm` without `-f`, so a
 * network something else is still attached to stays, rather than being pulled out from under it. Resolves whether
 * the network is gone.
 *
 * Through the detach gate (issue #452, gate round 3), as every detach is: on a rootless Podman 4.x whose rootless
 * network keeper does not hold, the proxy is NOT detached and the network is left whole (its `rm` would refuse with the
 * proxy on it anyway), for the boot reaper to remove once the keeper holds. A job or a session is not started there in
 * the first place (the podman venue's egress preflight and the sandbox opener refuse; `local` refuses every rootless
 * daemon), so this is the case of a keeper that died mid-run, where leaving the network is the only safe teardown.
 * `proxyRunning: false` (the create's rollback, whose connect failed) asks nothing.
 */
export async function removeJobNetworkWith(docker, { network, proxy = DEFAULT_EGRESS_PROXY, bin = "docker", gate = makeDetachGate(docker, { bin }), proxyRunning = true, onRefused = null }) {
	const { blocked } = await detachEndpoints(docker, { network, endpoints: [proxy], running: proxyRunning ? [proxy] : [], gate });
	if (blocked) {
		// SAID, never silent (issue #452, gate round 4): a network left here is a network the caller must name.
		if (typeof onRefused === "function") onRefused(blocked);
		return false;
	}
	return (await runWith(docker, ["network", "rm", network]))?.code === 0;
}

/**
 * THE ONE PLACE A CONTAINER IS DETACHED FROM A NETWORK in `worker/src` (issue #452, gate round 3). Every teardown and
 * every sweep reaches `network disconnect` through here, so the rule that makes a detach safe on a rootless Podman 4.x
 * (`makeDetachGate`, in `netns-keeper.mjs`) cannot be forgotten by a caller: it is asked first, with whether anything
 * RUNNING is among `endpoints` (`running`, the caller's knowledge; everything, when it does not say), and a refusal
 * detaches NOTHING. `{ blocked, detached }`: `blocked` is the gate's token or `null`; `detached` holds only the
 * endpoints whose disconnect exited 0, since it is printed and logged and a list of attempts would name something
 * still attached as removed.
 */
export async function detachEndpoints(docker, { network, endpoints, running = endpoints, gate }) {
	if (typeof gate !== "function") throw new Error("detachEndpoints: a detach gate is required (makeDetachGate)");
	const blocked = await gate({ running: endpoints.some((e) => running.includes(e)) });
	if (blocked) return { blocked, detached: [] };
	const detached = [];
	for (const endpoint of endpoints) {
		if ((await runWith(docker, ["network", "disconnect", "-f", network, endpoint]))?.code === 0) detached.push(endpoint);
	}
	return { blocked: null, detached };
}

/**
 * "The daemon says this network is not there", in BOTH daemons' words for a NETWORK (measured: Docker
 * `network X not found`, Podman `unable to find network with name or ID X: network not found`). The CLI's own
 * `context not found` must NOT match -- that is about the CLI, not the network -- and neither may an inspect
 * that timed out or a daemon that could not be reached. `code === null` is NO ANSWER and therefore never absence.
 *
 * ONE COPY, because this classifies ANOTHER TOOL'S PROSE across two runtimes. The rule was earned over three
 * review rounds in `live-probes.mjs` (issue #344), and a second copy is the one nobody updates when a third
 * runtime words it differently. That is this file's own argument for owning the proxy name and the network
 * suffix: a rename that lands in the producer and not in the reaper is the failure mode.
 *
 * Measured 2026-09-21 on docker 27.4.0: `network inspect` and `network rm` word a missing network
 * IDENTICALLY, and with `--format` the wording is on STDERR with stdout empty. So a caller must hand in a
 * runner that captures BOTH streams; `runDocker` below captures neither by default.
 */
export function networkAbsentInDaemonWords(result) {
	// A NUMBER that is not zero, or nothing. `code === null` is a timeout or a launch failure, and a result
	// with no `code` at all is a runner that answered something this rule cannot read: both are NO ANSWER,
	// and no answer is never absence.
	if (typeof result?.code !== "number" || result.code === 0) return false;
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	// Podman's `network disconnect` of a container NOT on an EXISTING network ends in the same `network not found`
	// (exit 125, measured on 5.8.1: `... is not connected to network X: network not found`). The network is there; the
	// membership is not. Read as absence, a caller would skip the `rm` of a network that still exists, or report one
	// gone that is not, so that wording is excluded before the match, wherever it appears in the output.
	if (/is not connected to network/i.test(text)) return false;
	return /network (?:\S+ )?not found/i.test(text);
}

/**
 * The container states a daemon's own member list shows for a network: `docker network inspect`'s `.Containers`
 * lists a member in these and in no other (measured, docker 27.4.0), and so does Podman 5.8.1's (issue #452,
 * measured: `running` and `paused` listed, `exited` and `created` not). `backend-local.mjs` re-exports it under
 * the same name for the boot reaper's second question, which asks about the states OUTSIDE this set.
 *
 * An ALLOWLIST rather than a denylist, following `sandbox.mjs`: an unknown state -- a Podman rendering nothing
 * here has measured, or one docker adds later -- is outside it, which keeps a network rather than losing it.
 * `restarting` is NOT here, even though it can appear: whether a flapping container is in `.Containers` depends
 * on which instant the sweep asks in, and a rule that changes answer between two runs is not a rule a sweep can
 * act on.
 */
export const ENDPOINT_LISTED_STATES = new Set(["running", "paused"]);

/**
 * The endpoint NAMES attached to a network, as `{ ok, names, absent }`, plus `parked` on Podman (below).
 *
 * TWO READS, ONE PER RUNTIME, and `bin` picks which (issue #452). On docker it is `network inspect --format
 * {{json .Containers}}`, byte for byte what it always was. On Podman that template does not work across the
 * versions this project runs: 5.8.1 renders the member map (with a lowercase `name`, measured under issue #354),
 * but 4.9.3 renders no member list at all -- its inspect JSON has no such key, and the template exits 125 with
 * `can't evaluate field Containers in type interface {}` for EVERY existing network, empty or not (measured on
 * Ubuntu 24.04). Read that way, every leftover network on 4.9 was unreadable forever, and all four sweeps that
 * share this reader passed over it. So on Podman the members come from `ps -a --filter network=<net> --format
 * {{.Names}}\t{{.State}}`, which both versions answer identically (measured on 4.9.3 and 5.8.1: exit 0, one
 * `name<TAB>state` line per member in every state; the filter matches a network by its whole NAME only, never a
 * name prefix, and by its full id or any prefix of that id, which a sweep never passes since it names networks).
 *
 * THAT READ CANNOT SAY "NOT THERE", which is why Podman's path has a second step: `ps` over a network that does
 * not exist answers exit 0 and empty on both versions (measured), exactly like an empty network, and every
 * caller treats empty as licence to remove. `network exists` then decides it, as its exit code (0 there, 1 not
 * there, measured on both); anything else is no answer and the read is unreadable. The network is asked about
 * AFTER its members, so an `absent` is the freshest fact this function has.
 *
 * WHAT `names` MEANS IS THE SAME ON BOTH RUNTIMES: the members the daemon lists, in `ENDPOINT_LISTED_STATES`.
 * That is what every caller was written against (docker's `.Containers`, and Podman 5.8.1's, which lists the
 * same two states), and keeping it is what keeps each caller's own guard meaning what it says. What Podman
 * adds is `parked`: the members in every OTHER state, in the order `ps` gave them. Docker's read cannot see
 * those at all and carries no `parked` key, so no docker caller's input changed. Podman is where they matter,
 * because its `network rm` without `-f` refuses while a member in ANY state remains (measured on 4.9.3 and
 * 5.8.1, each with a lone member in each of the four states running, paused, exited and created, and with all
 * four together), where docker's refuses only for a listed one. A caller
 * that must see a stopped member to act correctly reads `parked`; the others can ignore it and get what they
 * always got.
 *
 * FAIL CLOSED, on both paths. A member with no readable name makes the whole answer UNREADABLE (`ok: false`),
 * never "nothing attached", because every caller treats an empty list as licence to detach and remove, and a
 * member this parser cannot name is still a member. On Podman that is any non-empty `ps` line that is not
 * exactly a runtime-legal name, a tab and a lowercase state word.
 *
 * WHAT "ATTACHED" MEANS on docker, measured end to end on docker 27.4.0 rather than assumed. `.Containers` lists
 * RUNNING endpoints only. A running member is listed and `network rm` fails "has active endpoints"; the SAME
 * member stopped is absent from this map AND the `rm` succeeds. So for those two states "listed" and "holds the
 * network" agree, and a stopped container is not something a docker sweep needs to reason about.
 *
 * CORRECTED under issue #337: that agreement does NOT extend to a container in `created` state, and the
 * earlier version of this comment generalised it to "listed and holds the network agree" full stop, which is
 * false. Measured: a container created on a network but never started is absent from this map, absent from
 * `docker ps`, and the `network rm` SUCCEEDS -- after which `docker start` fails with "network not found" and
 * the container can never run. So the docker daemon is a backstop for a RUNNING endpoint and for nothing else,
 * and a sweep that cares about a container being launched right now has to ask `docker ps -a --filter
 * status=created` rather than infer it from here. On Podman the backstop covers every state (above).
 *
 * `local` THROUGH `podman-docker` ON PODMAN 4.9 (issue #452, gate round 1). Podman's `docker` emulation is a
 * script that runs `podman` itself, so `bin` says docker while the answer is 4.9's: the same exit 125 and
 * `can't evaluate field Containers`, for every existing network (measured on 4.9.3; on 5.8.1 the emulation
 * renders the member map). That exact wording, and nothing else, sends the docker path to the Podman read
 * through the SAME runner, which the emulation answers as Podman does (measured on 4.9.3 and 5.8.1). Its
 * presence step is a plain `network inspect <net>` read by `networkAbsentInDaemonWords` rather than `network
 * exists`, because the real docker CLI has no such verb and exits 1 with its usage text (measured, docker
 * 27.4.0 and 29.7.2), which would read as absent. The real docker CLI against Podman's Docker API never takes
 * this branch: the API renders `.Containers` with `Name` (measured against 4.9.3's and 5.8.1's services).
 */
export async function networkEndpoints(docker, network, { bin = "docker" } = {}) {
	// HALF-PROTECTED, and the half is worth naming (issue #360, item 6). `runWith` turns a runner that THROWS
	// into `{ code: null }`, so a throwing runner reads here as an unreadable network and every caller's guard
	// stays cautious. The `disconnect` and `rm` in `removeNetworkOrSay` go through the same wrapper, but the
	// callers' OWN steps around them do not, and neither does the `network ls` that produced the candidate
	// list: on the boot reaper that one is the throwing `exec` deliberately, so a daemon that dies mid-pass
	// still answers `{ reaped: false }`. Unreachable with the production runners, which are all non-throwing
	// by construction; stated so a future injected runner is not assumed to be.
	if (bin === "podman") return podmanNetworkMembers(docker, network);
	const inspected = await runWith(docker, ["network", "inspect", "--format", "{{json .Containers}}", network]);
	if (inspected?.code !== 0) {
		if (/can't evaluate field Containers/.test(`${inspected?.stdout ?? ""}${inspected?.stderr ?? ""}`)) return podmanNetworkMembers(docker, network, { presence: "inspect" });
		return { ok: false, names: [], absent: networkAbsentInDaemonWords(inspected) };
	}
	try {
		const parsed = JSON.parse(String(inspected.stdout ?? "").trim() || "{}");
		// FAIL CLOSED on anything that is not an object: a runtime rendering `.Containers` as `null` would
		// otherwise read as "no endpoints", which makes every caller's guard vacuous rather than cautious.
		if (parsed === null || typeof parsed !== "object") return { ok: false, names: [], absent: false };
		const names = [];
		for (const c of Object.values(parsed)) {
			// `Name` first, the docker key, then Podman 5.x's `name`, kept although Podman no longer takes this path:
			// the reader is exported, and a caller handing it a Podman rendering still gets a name, not a refusal.
			const name = [c?.Name, c?.name].find((v) => typeof v === "string" && v !== "");
			if (name === undefined) return { ok: false, names: [], absent: false };
			names.push(name);
		}
		return { ok: true, absent: false, names };
	} catch {
		return { ok: false, names: [], absent: false };
	}
}

/** A container name as both runtimes accept one (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`, docker's and Podman's, measured). */
const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * `networkEndpoints` on Podman: `ps -a --filter network=`, then whether the network is there (issue #452, see there):
 * `network exists` for the podman CLI, a plain `network inspect` for Podman reached as `docker` (`presence: "inspect"`).
 */
async function podmanNetworkMembers(podman, network, { presence = "exists" } = {}) {
	const unreadable = { ok: false, names: [], absent: false };
	const listed = await runWith(podman, ["ps", "-a", "--filter", `network=${network}`, "--format", "{{.Names}}\t{{.State}}"]);
	if (listed?.code !== 0) return unreadable;
	const names = [];
	const parked = [];
	for (const raw of String(listed.stdout ?? "").split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		// EXACTLY two fields. Podman writes its warnings to stderr, so anything else on stdout is a rendering this
		// parser was not measured against, and a member it cannot name is still a member.
		const fields = line.split("\t");
		if (fields.length !== 2) return unreadable;
		const [name, state] = fields.map((f) => f.trim());
		if (!RUNTIME_NAME.test(name) || !/^[a-z]+$/.test(state)) return unreadable;
		(ENDPOINT_LISTED_STATES.has(state) ? names : parked).push(name);
	}
	// Only now: `ps` answers the same for an empty network and a missing one. 0 is there, 1 is not (measured on
	// 4.9.3 and 5.8.1); 125, a timeout or a launch failure is no answer, and no answer is never absence.
	if (presence === "inspect") {
		const inspected = await runWith(podman, ["network", "inspect", network]);
		if (networkAbsentInDaemonWords(inspected)) return { ok: false, names: [], absent: true };
		if (inspected?.code !== 0) return unreadable;
		return { ok: true, absent: false, names, parked };
	}
	const exists = await runWith(podman, ["network", "exists", network]);
	if (exists?.code === 1) return { ok: false, names: [], absent: true };
	if (exists?.code !== 0) return unreadable;
	return { ok: true, absent: false, names, parked };
}

/**
 * Detach what the CALLER names, then `network rm` WITHOUT `-f`, and SAY what happened rather than return a
 * boolean a caller can drop: `{ removed, absent, detached, command }`.
 *
 * A SIBLING of `removeJobNetworkWith`, deliberately NOT its replacement and not built on top of it, and the
 * direction matters both ways. Building this on that one would force-detach the proxy BEFORE anything
 * inspected the endpoint list, which is exactly the harm a sweep's guard exists to prevent. Building that one
 * on this would add an inspect to the job's own teardown path, which `worker/test/egress.test.mjs`'s "removeJobNetwork detaches before removing" pins
 * as exactly two calls. So the job path keeps its two-call shape and the sweeps get their own primitive.
 *
 * `detach` is an EXPLICIT list because every caller decides it differently: the boot reaper detaches what it
 * saw and nothing while a job container is still on the network, `doctor`'s canary detaches its own proxy,
 * and a sandbox sweep leaves a session alone. A helper whose parameters ARE the decision would hide it.
 *
 * `command` is the one an operator would type, and it is the ONLY string a caller may print: the CLI's own
 * error text is never surfaced, because a docker error can repeat a `DOCKER_HOST` with credentials in it
 * (issue #339).
 */
export async function removeNetworkOrSay(docker, { network, detach = [], running = detach, stillClear = async () => true, bin = "docker", gate = makeDetachGate(docker, { bin }) }) {
	// `stillClear` is the OTHER kind of parameter, and naming the difference is what keeps `detach` explicit.
	// `detach` names WHICH endpoints go, which every caller decides differently, so a default there would hide
	// a decision. `stillClear` decides NOTHING about the target: it is the caller's own guard, re-asked
	// immediately before each destructive verb, and `false` STOPS this function rather than changing what it
	// would have removed. It exists because the guard that protects a sandbox mid-launch is a `docker ps -a`
	// this module cannot phrase -- the filter and the id are the caller's -- and because the interval between
	// that guard and the `rm` was two commands wide and grew by one per endpoint (issue #363).
	//
	// It defaults to a no-op, so four of the five callers are byte-identical and the one that opts in does so
	// by name, and that default is also what makes those four callers SAFE rather than merely unchanged: an
	// aborted pass returns `command: null`, and three of them would render that into "could not be removed:
	// null" if they ever saw the shape (the boot reaper is the exception: it logs a fixed reason token and
	// never reads `command` at all). A caller that opts in MUST branch on `aborted` before it reads
	// `command`. `sandbox.mjs` does; nothing else can reach it.
	//
	// WHY THE OTHER FOUR PASS NOTHING: `backend-local.mjs`'s boot reaper and `doctor.mjs`'s two canary calls
	// touch objects whose owner is already gone or whose pid is DEAD, where nothing can be mid-launch, and
	// `live-probes.mjs`'s peer sweep is best effort behind a flag an operator typed. Only the sandbox sweep
	// has an owner who may be alive.
	//
	// WHAT THE SECOND ASK COSTS, and why the abort below puts back what it took. The guard before the DETACH is
	// where it already was; what is new is the one before the `rm`, which used to sit k+1 commands out. That
	// leaves a window the previous shape did not have: the detach can succeed and the guard then refuse, and a
	// network whose proxy has been disconnected is a session with silently dead egress, where the old shape
	// gave a loud `docker run` failure. Silent is the worse of the two, so anything detached on an aborted pass
	// is reconnected.
	if (!(await stillClear())) return { removed: false, absent: false, detached: [], command: null, aborted: true };
	// Through the ONE detach helper (issue #452, gate round 3): a gate that refuses leaves the network whole and says so as
	// `blocked`, which each caller turns into its own line. `running` names which of `detach` are running (the caller's
	// member read), so a stopped proxy is detached with nothing asked.
	const { blocked, detached } = await detachEndpoints(docker, { network, endpoints: detach, running, gate });
	if (blocked) return { removed: false, absent: false, detached: [], command: null, blocked };
	// AGAIN, immediately before the verb that kills a launch. This is what removes the SCALING: with k
	// endpoints the `rm` used to be k+1 commands after the only guard, and it is now always one. Asked only
	// when there is something to re-ask ABOUT: with nothing detached, nothing has happened since the first ask
	// and a second identical `docker ps -a` back to back would be a round trip that answers itself.
	if (detached.length > 0 && !(await stillClear())) {
		// PUT BACK WHAT WAS TAKEN. Reported separately from `detached`, which means "removed from this network
		// by this pass": an endpoint that was detached and then restored was not, and a caller printing
		// `detached` must not name it. A reconnect that fails is named too, because that endpoint IS now off a
		// network someone may be using and nothing else will put it back.
		const restored = [];
		const lost = [];
		for (const endpoint of detached) {
			if ((await runWith(docker, ["network", "connect", network, endpoint]))?.code === 0) restored.push(endpoint);
			else lost.push(endpoint);
		}
		return { removed: false, absent: false, detached: [], restored, lost, command: null, aborted: true };
	}
	if ((await runWith(docker, ["network", "rm", network]))?.code === 0) return { removed: true, absent: false, detached, command: null };
	// Silent ONLY when the daemon says it is not there. Anything else -- a timeout, an unreachable daemon, a
	// race that attached something between the inspect and the rm -- is said, with the command.
	const inspected = await runWith(docker, ["network", "inspect", network]);
	if (networkAbsentInDaemonWords(inspected)) return { removed: true, absent: true, detached, command: null };
	// `bin` (issue #354) only spells the command an operator is told to type; the runner is the caller's, already bound.
	return { removed: false, absent: false, detached, command: `${bin} network rm ${network}` };
}

/**
 * The spawn-based runner the job path and the sandbox use: `runDocker` for the network verbs, as before, and a CAPTURING,
 * BOUNDED spawn when the detach gate reads the runtime with its own `{ timeoutMs, maxBuffer }` (a `podman info` body is
 * tens of KiB, past `runDocker`'s 4 KiB, and a teardown in a `finally` must not hang on a wedged daemon).
 */
function spawnRunner(spawnFn, bin) {
	return (args, opts) => (opts ? runCapture(spawnFn, args, bin, opts) : runDocker(spawnFn, args, false, bin));
}

function runCapture(spawnFn, args, bin, { timeoutMs, maxBuffer }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				child.kill?.("SIGKILL");
			} catch {
				// already gone
			}
			finish({ code: null, stdout: "" });
		}, timeoutMs);
		child.stdout?.setEncoding?.("utf8");
		child.stdout?.on?.("data", (chunk) => {
			if (stdout.length < maxBuffer) stdout += chunk;
		});
		child.on?.("error", () => finish({ code: null, stdout: "" }));
		child.on?.("close", (code) => finish({ code, stdout }));
	});
}

/** One step through a caller's runner, as `{ code: null }` when it throws. */
async function runWith(docker, args) {
	try {
		return await docker(args);
	} catch {
		return { code: null, stdout: "" };
	}
}

/**
 * A spawned docker command's `{ code, stdout }`; `code` is `null` when it could not be launched at all.
 * `null !== 0` falls through to the same branch a non-zero exit does, which is what we want: no docker
 * binary is no answer. Same shape as image-preflight.mjs's own runDocker and doctor's runCmd, so all
 * three agree on what "present" means.
 */
function runDocker(spawnFn, args, capture = false, bin = "docker") {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(bin, args, { stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
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
