/**
 * netns-keeper.mjs -- the rootless network keeper (issue #458) and the network detach gate (issue #452).
 *
 * A LEAF above `daemon-facts.mjs` only, so `egress.mjs` can route every detach through `makeDetachGate` without a
 * cycle (`podman-stack.mjs`, where these first lived, imports `egress.mjs`, and re-exports all of them).
 */

import { DAEMON_FACTS_ARGS, DAEMON_FACTS_TIMEOUT_MS, PODMAN_INFO_ARGS, parseDaemonFacts, parsePodmanInfo } from "./daemon-facts.mjs";

/**
 * The rootless network keeper's container and network name (issue #458). One idle container on an `--internal`,
 * DNS-disabled network of its own, so this account's shared rootless network helper always has a running bridge member.
 * On Podman 4.9, `podman network disconnect` of the proxy from a job's network tears that helper down under the running
 * proxy whenever no other bridge container runs (v4.9.3 libpod/networking_linux.go counts the disconnecting container as
 * the caller and cleans up at one), and every later egress job then gets 503 until the proxy restarts: measured, and
 * gone with the keeper running (deploy/pi-dispatch-netns-keeper.container has the rest).
 *
 * Outside every prefix a pi-dispatch sweep removes, by a test: a sweep that took it would bring the defect back with
 * nothing said, and a `network rm -f` of its network leaves its unit failed until restarted (measured).
 */
export const NETNS_KEEPER = "pi-dispatch-netns-keeper";

/**
 * How the keeper is read, everywhere it is read (doctor, `up`, the worker's egress preflight): its state, its network
 * MODE and the networks it is on, in one `podman inspect`. Running is not enough (issue #463 gate, measured on 4.9.3):
 * a container of this name on `--network none`, `slirp4netns`, `pasta` or `host` runs and holds nothing open, since only
 * a running member of a BRIDGE network keeps the rootless helper alive. What 4.9.3 printed for each, with this format:
 * `running|bridge|pi-dispatch-netns-keeper,` (the shipped unit), `running|none|none,`, `running|slirp4netns|`,
 * `running|pasta|`, `running|host|host,`, `paused|bridge|pi-dispatch-netns-keeper,`, and exit 125 for no container.
 */
export const NETNS_KEEPER_FORMAT = "--format={{.State.Status}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}|{{.State.StartedAt.UnixMilli}}";

/** When a container started, in epoch milliseconds (`{{.State.StartedAt.UnixMilli}}`, measured on 4.9.3). */
export const STARTED_AT_FORMAT = "--format={{.State.StartedAt.UnixMilli}}";

/**
 * How long the keeper must have been running to count (PR #463 round 2, measured on 4.9.3): a keeper killed every
 * 0.5 s read as running on its bridge in 57 of 224 back-to-back reads, so a crash loop could pass a single read.
 * Restart=always brings a killed keeper back in about 1.25 s, so a keeper in such a loop never reaches this age.
 */
export const NETNS_KEEPER_MIN_AGE_MS = 3_000;

/**
 * How much later than the proxy the keeper may have started and still count (PR #463 round 2). A keeper that started
 * AFTER the proxy was down while the proxy ran, and a job teardown in that gap cuts the proxy's route out for good
 * (measured: a kill and a teardown right after it, then the keeper back and holding, and the proxy still had no route
 * out until IT restarted). Nothing outside shows that damage, so the order is the only evidence there is. The grace is
 * for a start of both together, and no wider (PR #463 round 3): measured on 4.9.3, the keeper started 4 to 52 ms from the
 * proxy in three `service install`s, 17 to 50 ms in three boot-like starts (the user manager restarted), and 63 ms in
 * an `up --yes`. 15 s is two orders of magnitude over that, and it bounds the one window the rule cannot see: a keeper
 * death AND a teardown both within 15 s of a joint start (it was a minute, and a review measured that window used).
 */
export const NETNS_KEEPER_AFTER_PROXY_GRACE_MS = 15_000;

/**
 * A YOUNG KEEPER IS WAITED OUT, NOT FAILED (issue #476). When the stack starts together (a `service install`, a boot
 * with linger) the worker reads the keeper under a second after it started (measured 0.5 to 0.8 s on 4.9.3), so the
 * age rule above failed every such start: a boot warning with a remedy that restarts the keeper after the proxy, and a
 * queued job that spent an attempt. A keeper that is running on its own bridge holds the helper open now; the age rule
 * is there to catch a keeper that keeps dying, which a wait tells apart. So a keeper whose only fault is its age, and
 * that did not start out of order against the proxy, is `young`: the boot waits until it is `NETNS_KEEPER_MIN_AGE_MS`
 * old plus this margin and judges once more, and a job is moved to the delayed set for as long, without an attempt.
 */
export const NETNS_KEEPER_YOUNG_MARGIN_MS = 1_000;

/**
 * How long one job may be held on a young keeper (issue #476). A keeper that stays up needs one wait (at most the
 * minimum age plus the margin, 4 s); a crash loop (Restart=always, RestartSec=1s) is young at every start, and would
 * hold a job for ever. So the hold ends at the first sign of a loop (a new start, or no keeper, while the job waited)
 * and in any case after this bound, with its own reason, `netns-keeper-crash-loop`.
 */
export const NETNS_KEEPER_YOUNG_HOLD_MAX_MS = 30_000;

/** The wait a young keeper needs, from its age: until it is old enough, plus the margin, never less than the margin. */
export function netnsKeeperYoungWaitMs(ageMs) {
	// A start read in the future (or no age at all) counts as age 0: the whole minimum, and no more.
	const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
	return Math.max(0, NETNS_KEEPER_MIN_AGE_MS - age) + NETNS_KEEPER_YOUNG_MARGIN_MS;
}

/**
 * The sentence for a keeper that kept restarting while a job waited for it (issue #476). `was`: the start the job first
 * waited on; `now`: the start read now, or `null` when no running keeper was read; `problem`: what the read now found,
 * in words that follow the keeper's name, when it found no running keeper; `heldMs`: how long the job had waited.
 */
export function netnsKeeperCrashLoopSentence({ was, now = null, problem = null, heldMs, remedy }) {
	const at = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "an unread time");
	const seen = now === null ? `and ${Math.round(heldMs / 100) / 10} s later it ${problem ?? "was not running"}` : now === was ? `and ${Math.round(heldMs / 100) / 10} s later it still read as younger than ${NETNS_KEEPER_MIN_AGE_MS / 1000} s` : `and started again at ${at(now)}`;
	return `the rootless network keeper ${NETNS_KEEPER} keeps restarting (a crash loop): a job waited for the one started at ${at(was)} to have run ${NETNS_KEEPER_MIN_AGE_MS / 1000} s, ${seen}, so it holds nothing open for long, and on Podman 4.x a job network's teardown in a gap would cut the egress proxy's route out (issue #458), so this job is retried rather than started. To fix it, find why it exits (journalctl --user -u ${NETNS_KEEPER}.service -n 50), then ${remedy ?? `start it as the worker's account: systemctl --user restart ${NETNS_KEEPER}.service`}`;
}

/**
 * Judge one read of `podman inspect NETNS_KEEPER_FORMAT NETNS_KEEPER` (`{ code, stdout }`, stdout alone). Returns
 * `{ holds, exists, running, restartProxy, problem }`: `holds` only when the keeper is running, in bridge mode, and
 * attached to its own network, the one shape measured to keep the helper alive; `problem` says, in words that follow
 * the keeper's name, what is wrong otherwise. A container that also sits on other networks still holds (it is a bridge
 * member); only the shipped unit's shape is required, not its exact network list.
 *
 * With `now` (a clock, milliseconds) it also has to have been running for NETNS_KEEPER_MIN_AGE_MS; with
 * `proxyStartedMs` it must not have started more than NETNS_KEEPER_AFTER_PROXY_GRACE_MS after the proxy, and one that
 * did is `restartProxy`: the remedy is then the PROXY's restart, not the keeper's. `up` passes neither: it asks only
 * whether a keeper is there to leave alone. doctor and the worker's preflight pass both.
 *
 * A keeper whose ONLY fault is its age (running on its own bridge, not started out of order) also carries `young`,
 * `{ startedMs, ageMs, waitMs }` (issue #476): it is still not held here, and doctor still says so, but the worker's
 * boot, its per-job preflight and the sandbox opener wait `waitMs` for it rather than fail on it.
 */
export function judgeNetnsKeeper({ code, stdout }, { now = null, proxyStartedMs = null } = {}) {
	// `thenRestartProxy` (PR #463 round 3): a keeper that does not hold under a proxy already up longer than the grace will,
	// once started, have started after it, and the order rule will then ask for the proxy's restart; so the fix says both
	// steps now rather than one per retry.
	const late = now !== null && Number.isFinite(proxyStartedMs) && now - proxyStartedMs > NETNS_KEEPER_AFTER_PROXY_GRACE_MS;
	const no = (fields) => ({ holds: false, exists: true, running: true, restartProxy: false, thenRestartProxy: late && fields.restartProxy !== true, ...fields });
	if (code !== 0) return no({ exists: false, running: false, problem: "is not under this account's Podman" });
	const [status = "", mode = "", nets = "", started = ""] = String(stdout ?? "").trim().split("|");
	const networks = nets.split(",").filter(Boolean);
	if (status !== "running") return no({ running: false, problem: `is ${status || "not running"} under this account's Podman` });
	if (mode !== "bridge") return no({ problem: `is running on the ${mode || "unreported"} network mode, not on its ${NETNS_KEEPER} bridge network, so it holds nothing open` });
	if (!networks.includes(NETNS_KEEPER)) return no({ problem: `is running but not attached to its ${NETNS_KEEPER} bridge network (it is on ${networks.join(", ") || "none"}), which is not the keeper this project ships` });
	if (now !== null) {
		const startedMs = /^\d+$/.test(started) ? Number(started) : null;
		if (startedMs === null) return no({ problem: "is running, but when it started could not be read, so whether it has stayed up is not known" });
		const age = now - startedMs;
		const outOfOrder = Number.isFinite(proxyStartedMs) && startedMs > proxyStartedMs + NETNS_KEEPER_AFTER_PROXY_GRACE_MS;
		if (age < NETNS_KEEPER_MIN_AGE_MS) {
			// `young` (issue #476): only when age is the whole fault. One started out of order against the proxy is not
			// waited out, since waiting cannot make its start earlier; its words stay what they were.
			return no({
				problem: `has been running for only ${Math.max(0, Math.round(age / 100) / 10)} s, and a keeper that keeps dying reads as running for a moment at a time; it counts once it has run for ${NETNS_KEEPER_MIN_AGE_MS / 1000} s`,
				...(outOfOrder ? {} : { young: { startedMs, ageMs: age, waitMs: netnsKeeperYoungWaitMs(age) } }),
			});
		}
		if (outOfOrder) {
			return no({ restartProxy: true, problem: `started ${Math.round((startedMs - proxyStartedMs) / 1000)} s after the egress proxy did, so it was down while the proxy ran, and a job teardown in that gap would have cut the proxy's route out for good, which nothing can see from outside` });
		}
	}
	return { holds: true, exists: true, running: true, restartProxy: false, problem: null };
}

/**
 * Whether this Podman needs the keeper to keep the proxy's route out (issue #458): every 4.x, and a version that cannot
 * be read, since the defect is silent and an unread version is not evidence of 5.x. Only doctor's severity reads it;
 * the installer installs the keeper on every version, where on 5.x it is one idle container (measured harmless on 5.8.1).
 */
export function podmanNeedsNetnsKeeper(version) {
	const major = /^(\d+)\./.exec(String(version ?? "").trim())?.[1];
	return major === undefined || Number(major) < 5;
}

/**
 * The keeper read a DETACH asks (issue #452, gate round 2): its state, its network mode and the networks it is on, and
 * NOT when it started. `NETNS_KEEPER_FORMAT`'s `{{.State.StartedAt.UnixMilli}}` is Podman's own template and is for the
 * age and order rules, which admit a JOB across time; a detach is safe exactly when the keeper holds at that instant.
 * Measured identical through `podman`, through `podman-docker` and through the real docker CLI against the account's
 * Podman API socket, on 4.9.3 and 5.8.1: `running|bridge|pi-dispatch-netns-keeper,`.
 */
export const NETNS_KEEPER_NOW_FORMAT = "--format={{.State.Status}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}";

/**
 * THE DETACH GATE (issue #452, gate round 3): the one rule every detach of a container from a network goes through, on
 * every venue and for every caller -- a job's and a sandbox's teardown, the boot reaper, the sandbox sweep, doctor's
 * canary and its sweep, the live probes' peers and their sweep. `egress.mjs`'s `detachEndpoints` is the only code in
 * `worker/src` that issues `network disconnect`, and it asks this first.
 *
 * WHY ONE RULE. On a rootless Podman 4.x, disconnecting a RUNNING container while no other container runs on a bridge
 * network tears the account's rootless network namespace down under the running egress proxy (issue #458), and the
 * proxy then has no route out until it restarts. That is the same whoever disconnects it and through whichever CLI:
 * `podman`, Podman's `podman-docker` emulation answering as `docker`, or the real docker CLI on Podman's API socket
 * (all three measured on 4.9.3). Round 2 guarded some callers; the review then found three more that were not. So the
 * decision moved from the callers into the helper they all share.
 *
 * `gate({ running })`: `null` when the detach may go ahead, else a reason token. Only `running: true` asks anything: a
 * stopped container is not in the rootless namespace, so detaching one is not the trigger. Otherwise ONE runtime read and,
 * where it matters, ONE keeper read, MEMOISED for the gate's lifetime, which is one pass of its caller (one boot reap, one
 * sweep, one doctor run, one job's teardown), an unanswered read included: a CLI that hangs costs one bound per pass, not
 * one per network (the review measured three leftovers taking 90 s). Both reads go through the caller's runner with this
 * module's bound (`DETACH_GATE_READ_TIMEOUT_MS`, `DETACH_GATE_READ_MAX_BUFFER`, the facts readers' own).
 *
 * The runtime read is the one that venue already trusts: `podman info --format json` through `parsePodmanInfo` for the
 * `podman` CLI, and `docker info --format={{json .}}` through `parseDaemonFacts` for `docker`, which recognises Podman on
 * both routes (Podman's own shape from the emulation, Docker's shape with Podman's `ProductLicense` from the API).
 * Docker Engine, rootful Podman (no rootless namespace) and Podman 5.x are let through with no keeper read. A rootless
 * Podman 4.x, or a runtime the read could not identify, needs the keeper to hold AT THAT INSTANT (`judgeNetnsKeeper`
 * without the clock: running, bridge mode, on its own network): `keeper-not-holding`, or `runtime-unreadable`.
 */
export const DETACH_GATE_READ_TIMEOUT_MS = DAEMON_FACTS_TIMEOUT_MS;
export const DETACH_GATE_READ_MAX_BUFFER = 1024 * 1024;

export function makeDetachGate(run, { bin = "docker", readRuntime = null } = {}) {
	let decided = null;
	const opts = { timeoutMs: DETACH_GATE_READ_TIMEOUT_MS, maxBuffer: DETACH_GATE_READ_MAX_BUFFER };
	const ask = async (args) => {
		try {
			return await run(args, opts);
		} catch {
			return { code: null, stdout: "" };
		}
	};
	async function decide() {
		let runtime = null;
		// `readRuntime`: a caller that has ALREADY read the runtime this pass (doctor's one `docker info`, which its job-user
		// section reads too) hands that read in, `async () => { podman, rootless, version } | null`, so a pass still asks the
		// daemon once. Otherwise the gate reads it itself, with its own bound.
		// `undefined` from it (issue #452, gate round 4) means "I have no answer of my own": the gate then reads it itself,
		// as with no `readRuntime`. `null` is an answer, that the runtime could not be read.
		let handed;
		if (typeof readRuntime === "function") {
			try {
				handed = await readRuntime();
			} catch {
				handed = null;
			}
		}
		runtime = handed === undefined ? await readItself() : handed;
		if (runtime && (runtime.podman !== true || runtime.rootless === false || !podmanNeedsNetnsKeeper(runtime.version))) return null;
		const keeper = await ask(["inspect", NETNS_KEEPER_NOW_FORMAT, NETNS_KEEPER]);
		if (judgeNetnsKeeper({ code: keeper?.code ?? null, stdout: keeper?.stdout ?? "" }).holds) return null;
		return runtime ? "keeper-not-holding" : "runtime-unreadable";
	}
	async function readItself() {
		const read = await ask(bin === "podman" ? PODMAN_INFO_ARGS : DAEMON_FACTS_ARGS);
		let runtime = null;
		if (read?.code === 0) {
			if (bin === "podman") {
				const info = parsePodmanInfo(read.stdout);
				if (info) runtime = { podman: true, rootless: info.rootless, version: info.version };
			} else {
				const facts = parseDaemonFacts(read.stdout)?.facts;
				if (facts) runtime = { podman: facts.podman === true, rootless: facts.rootless, version: facts.serverVersion ?? null };
			}
		}
		return runtime;
	}
	return async function gate({ running = true } = {}) {
		if (running !== true) return null;
		decided ??= decide();
		return decided;
	};
}

/** A `makeDaemonFactsReader` answer as the gate's runtime, or `null` when the daemon did not say. */
export function runtimeFromFacts(answer) {
	if (answer?.answered !== true || !answer.facts) return null;
	return { podman: answer.facts.podman === true, rootless: answer.facts.rootless, version: answer.facts.serverVersion ?? null };
}

/** The gate's token as the clause a line puts after "because". */
export function detachBlockedSentence(token, bin = "docker") {
	return token === "runtime-unreadable"
		? `this shell's ${bin} CLI could not say which container runtime it reaches and the rootless network keeper ${NETNS_KEEPER} does not hold, and on a rootless Podman 4.x detaching the running egress proxy from a network cuts its route out (issue #458)`
		: `the rootless network keeper ${NETNS_KEEPER} does not hold under the rootless Podman 4.x this shell's ${bin} CLI reaches, where detaching the running egress proxy from a network cuts its route out (issue #458)`;
}
