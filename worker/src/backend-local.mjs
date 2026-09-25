/**
 * THE `local` BACKEND: the Docker daemon on this worker's own host (issue #227).
 *
 * `backends.mjs` says WHAT each backend guarantees; this module is the first thing that has to be true.
 * It bundles the functions that actually build and run a container into one value, so that "a backend" is
 * a thing the worker holds rather than a shape spread across four `deps` keys nobody names together.
 *
 * WHY THE TABLE DOES NOT HOLD A `make()`. The obvious design is one entry per backend carrying its own
 * factory, and it cannot work here: `backends.mjs` imports NOTHING on purpose, because `doctor`, the config
 * loader and the receiver all have to read a declaration without pulling the Docker implementation into
 * their graph. A `make()` in the table is an import edge from the leaf to every adapter, which is the leaf
 * property gone. So the table declares and this module implements, and the two are joined by NAME -- the
 * same split `forges.mjs` uses against the forge hosts.
 *
 * FIVE FUNCTIONS, and the last two arrived late on purpose. `stopContainer` was a one-line literal inside
 * `index.mjs`'s `createWorker` and unreachable from `startWorker`; `reap` lived in `start.mjs` and returns a
 * TRI-STATE that `makeScopeClaimSweeper` gates a money decision on. Neither could move without its reasoning
 * moving too, so an earlier slice declared `abortable` in the table, named both as deferred, and REFUSED a
 * bundle that tried to supply them -- because an adapter author who passes `stopContainer` and has it
 * silently dropped believes a runaway job can be stopped through their backend when the abort path still
 * calls docker directly. That refusal is now gone because the seam is real.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubCredentials } from "./redact.mjs";
import { BACKENDS, DEFAULT_BACKEND, DOCKER_NEVER_STARTED_EXITS } from "./backends.mjs";
import { DEFAULT_EGRESS_PROXY, networkEndpoints, removeNetworkOrSay } from "./egress.mjs";
import { isDeterminateFsCode } from "./transient.mjs";

const execDocker = promisify(execFile);

/**
 * `pi-job-` -- the container-name namespace, and a LOAD-BEARING string rather than a prefix chosen for
 * readability. TWO sweeps match it as a SUBSTRING, both at boot in `start.mjs`: the container reaper's
 * `docker ps` filter and the network reaper's `docker network ls` filter. They share the NAME rule
 * (`isJobNamespace`) and deliberately not the STATE question -- see `reapNetwork` for why one lists running
 * containers and the other asks about members in any state. The sandbox tooling is the
 * counterpart rather than a third sweep -- it names itself `pi-sandbox-` precisely to stay OUTSIDE this
 * namespace, so a worker restart cannot tear down the shell an operator is sitting in, and it reaps its own
 * by job id rather than by name.
 *
 * Exported and imported rather than re-typed at each site for the reason `CONTAINER_GLOBAL_PI_DIR` is: the
 * namespace and the filters that sweep it are ONE fact, and two literals in two modules is how a rename
 * lands in the producer and not in the reaper, leaving every crashed worker's containers behind forever with
 * both test suites green.
 */
export const JOB_NAME_PREFIX = "pi-job-";

/**
 * The container states `docker network inspect` lists in `.Containers`, and therefore the ones the daemon
 * itself guards: with one attached, `network rm` fails "has active endpoints" (measured, docker 27.4.0).
 *
 * An ALLOWLIST rather than a denylist, following `sandbox.mjs`: an unknown state -- a Podman rendering
 * nothing here has measured, or one docker adds later -- keeps the network rather than losing it. The cost
 * of being wrong that way is a leftover network and a line naming it; the cost of the other way is a
 * container that can never start again.
 *
 * `paused` is here because it is listed and the `rm` refuses while it is there. `restarting` is NOT, even
 * though it can appear: whether a flapping container is in `.Containers` depends on which instant the sweep
 * asks in, and a rule that changes answer between two runs is not a rule a sweep can act on.
 */
export const ENDPOINT_LISTED_STATES = new Set(["running", "paused"]);

/**
 * `pi-job-<jobId>`. The name a running job answers to, for `docker stop` on the 30-minute timeout, for the
 * per-job egress network derived from it, and for the reaper's filter.
 *
 * Sanitised to the runtimes' own name rule, `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (docker's `RestrictedNameChars`, and
 * Podman's, measured), every other character becoming `_`, as `sanitizeJobId` does for file names. It said here that
 * BullMQ ids are already that shape, and a cron job's is not: the job scheduler mints `repeat:<schedulerId>:<millis>`,
 * so `pi-job-repeat:...` was refused at create (exit 125, measured on Podman 5.8.1) and so was its `-net` network, and
 * every cron job ended `container-never-started` before it ever ran (issue #435). The prefix supplies the first
 * character. Deterministic, because every path that must find the container again (the timeout's stop, the cancel,
 * the network, the log sink) asks this function for the name rather than deriving it. Not injective: `repeat:a:1`
 * and a literal `repeat_a_1` share a name. BullMQ ids are unique per queue and no producer here mints an id with `_`
 * where a scheduler id has `:`, so it is a residual rather than a collision anything reaches.
 */
export function jobContainerName(jobId) {
	return `${JOB_NAME_PREFIX}${String(jobId).replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * Bundle the local backend's already-built functions into one checked value.
 *
 * Takes them BUILT rather than building them from config, because each is constructed in `start.mjs` from a
 * different slice of the deployment and behind its own injectable factory that the wiring tests drive. This
 * function's job is not to own that construction; it is to be the one place that says these functions
 * together are a backend, and to REFUSE a bundle that is missing one.
 *
 * The refusal is worth having and worth not overselling. It catches a bundle assembled with a key MISSING or
 * not callable, which is a wiring mistake that would otherwise surface as an unhelpful `undefined is not a
 * function` deep inside a paid job. It proves ARITY AND NOTHING ELSE: `makeEgressPreflight({ armed: false })`
 * returns a function that answers `{ ok: true }` and spawns nothing, so a bundle can pass this check with a
 * gate that does no gating. `backend-conformance.mjs` does not close that either: it never invokes
 * `imagePreflight` or `egressPreflight`, so a stubbed gate remains exactly what neither check can see. What
 * the harness does verify is listed in its own header, and what it cannot is listed beside it.
 */
/** The functions a bundle carries today. Deferred members are refused BY NAME below, never ignored. */
export const BACKEND_FUNCTIONS = ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap"];

/**
 * Members `makeLocalBackend` SETS rather than takes. An adapter written elsewhere supplies them itself; the
 * local bundle knows its own, so passing them here is refused as an unknown member like any other.
 */
export const BACKEND_PROVIDED = ["name", "declares", "namePrefix", "containerName", "neverStartedExits", "binds"];

/**
 * Non-function members every bundle must also carry. Separate from the list above because the completeness
 * check tests callability, and these are values -- but they are just as required: `neverStartedExits` gates
 * a budget REFUND, so a bundle that omitted it would keep the slot and let BullMQ retry, burning a second
 * one per never-started job. That is the exact bug the explicit `case 125/126/127` was added to fix,
 * reachable again by an adapter simply not setting a property.
 */
export const BACKEND_VALUES = ["neverStartedExits"];

export function makeLocalBackend(parts = {}) {
	const { runContainer, imagePreflight, egressPreflight, stopContainer, reap } = parts ?? {};
	const missing = Object.entries({ runContainer, imagePreflight, egressPreflight, stopContainer, reap })
		.filter(([, fn]) => typeof fn !== "function")
		.map(([k]) => k);
	if (missing.length > 0) {
		throw new Error(`backend "${DEFAULT_BACKEND}": cannot build a backend missing ${missing.join(", ")}`);
	}

	// An unknown key is REFUSED rather than dropped, and the two this slice defers are named as deferred.
	// An adapter author who supplies `stopContainer` has read the issue and reasonably expects it to be
	// wired; silently ignoring it would leave them believing a runaway job can be stopped through their
	// backend while the abort path still goes straight to the local docker CLI. That is the believed-in
	// control again, arriving through a dropped argument.
	for (const key of Object.keys(parts ?? {})) {
		if (BACKEND_FUNCTIONS.includes(key) || BACKEND_VALUES.includes(key)) continue;
		throw new Error(`backend "${DEFAULT_BACKEND}": unknown bundle member ${JSON.stringify(key)} (this factory takes ${BACKEND_FUNCTIONS.join(", ")} and sets ${BACKEND_PROVIDED.join(", ")} itself)`);
	}

	return {
		name: DEFAULT_BACKEND,
		// The declaration is READ from the table, never re-typed here. An adapter that stated its own
		// guarantees inline could drift from what `doctor` prints and what the boot refusal checks, and an
		// operator would then be told one thing by the thing that decides and another by the thing that ran.
		// This is the SAME object the table holds, and that is safe only because the table is deeply FROZEN:
		// an unfrozen alias would let any holder of a bundle rewrite what `doctor`, the boot refusal and the
		// receiver are all told about this backend, process-wide and invisibly, while the source still read
		// `enforced`. A defensive copy would hide such a mutation rather than prevent it.
		declares: BACKENDS[DEFAULT_BACKEND].declares,
		namePrefix: JOB_NAME_PREFIX,
		containerName: jobContainerName,
		runContainer,
		imagePreflight,
		egressPreflight,
		stopContainer,
		reap,
		// The integers this runtime uses for "the runner never ran". The processor asks the BACKEND rather
		// than assuming docker's triple, because those numbers collide with the runner's own exit channel.
		neverStartedExits: LOCAL_NEVER_STARTED_EXITS,
		// This runtime BIND-MOUNTS, so `/job`'s read-only is the kernel's. The conformance harness abstains
		// rather than passing when a bundle does not say, because a copy downgrades that to a convention.
		binds: true,
	};
}

/**
 * The exit codes that mean THE RUNNER NEVER RAN, as this runtime spells them.
 *
 * Docker's own convention, and defined in `backends.mjs` rather than here so the processor can default to
 * it without importing this module. Re-exported under the local backend's name because that is what the
 * bundle carries and what an adapter author reads.
 */
export const LOCAL_NEVER_STARTED_EXITS = DOCKER_NEVER_STARTED_EXITS;

/**
 * `docker stop` on the job's container name, fired by the abort (the 30-minute timeout or a shutdown).
 *
 * MOVED HERE from `index.mjs`'s `createWorker`, where it was a one-line literal inside the processor's
 * construction and could not be reached from `startWorker` at all. That is why `abortable` was declared in
 * the table two slices before this function existed: a second backend could have passed every other check
 * with no way to stop a runaway container, and nothing in the table would have moved.
 *
 * `-t 5` is SIGTERM then SIGKILL after five seconds. The runner exits, `docker run` returns, and
 * `runContainer`'s promise resolves -- so the abort's effect reaches the processor through the container's
 * own exit rather than through this call's return value, which is why nothing awaits it.
 *
 * `INT-RUNNER-EXIT-CODE-PROTOCOL` is what makes this transferable: the discriminator is the abort FLAG the
 * processor already holds, not the exit code, because a worker SIGKILL and a kernel OOM both surface as
 * 137. An adapter implements "stop this job" however its runtime spells it and the classification is
 * unchanged.
 */
export function makeStopContainer({ exec = execDocker, bin = "docker" } = {}) {
	// Issue #354: `bin` is the venue's CLI. A stop sent to a runtime other than the one that runs the job answers "no such
	// container" while the job runs on, which is the unstoppable runaway this function exists to rule out.
	return async function stopContainer(name) {
		return exec(bin, ["stop", "-t", "5", name]);
	};
}

/**
 * What the CLI resolved, as a phrase that is never EMPTY. Four call sites interpolate an endpoint into a
 * sentence of the form "resolves <this>, which is not shown to be on this host", and a context can carry no
 * host at all: `docker context create X --docker host=` is accepted by docker 27.4.0 (exit 0, "Successfully
 * created context"), and `context inspect` then renders the Host as `""`. `classifyDockerEndpoint("")`
 * answers `{ local: false, display: "" }`, which is the right answer to its own question, and every one of
 * those sites then printed "resolves , which is not shown to be on this host" at an operator.
 *
 * A PHRASE rather than a fallback value, so no caller can mistake what it returns for something to hand to
 * docker. WHITESPACE counts as empty: `docker context create` refuses a blank host, but `context inspect`,
 * which is the command doctor actually runs, does NOT re-validate what the context store already holds, so
 * the read path can return one.
 *
 * ANYTHING NOT PLAINLY PRINTABLE IS QUOTED AND ESCAPED, never removed, and the difference is the whole of
 * this function's second job. `displayEndpoint` returns a host with no `@` VERBATIM -- it withholds
 * credentials and was never a sanitiser -- so whatever a context store holds reaches a line an operator
 * reads, and an erase-line plus a carriage return wipes the warning and rewrites it from column 0.
 *
 * A first attempt STRIPPED those bytes, and stripping is the wrong rule in both directions, measured on
 * docker 27.4.0. It FORGES: `docker context create` accepts a C1 byte, so a stored
 * `tcp://127.0.0.1<U+0085>:2375` is correctly classified NOT local (the parser percent-encodes it into the
 * hostname) and then printed as a clean loopback address, giving a sentence that contradicts itself and a
 * value that survives copy, paste and grep as something the operator never configured. And it CORRUPTS: a
 * unix socket really can live at a path containing one (created, resolved and dialled on this host), and
 * stripping renames it to a path that does not exist -- while `job-user.mjs`, `sandbox.mjs` and
 * `runtime-observations.mjs` go on reading the UNSTRIPPED value as a real filesystem path, so doctor would
 * name one file and the system use another.
 *
 * So: printable ASCII (U+0020 to U+007E) passes through untouched, and anything else is rendered as a
 * quoted, fully escaped string, which one `JSON.parse` turns back into what was stored. Nothing is deleted,
 * which is the property that matters, and it disarms the whole class at once rather than one codepoint
 * range of it, so a right-to-left override, a zero-width joiner and a line separator are as visible as an
 * ESC. U+007F is on the escaped side of the boundary with the C1 block, which is why the range ends at 7E.
 *
 * TWO LIMITS, stated because "lossless" on its own would overstate them. The mapping is not INJECTIVE: a
 * stored value whose printable text happens to be a quoted escape sequence renders byte-identically to the
 * escaped form of the value it describes, so an operator cannot tell whose quotes they are. Reachable only
 * through the unvalidated read path, since `context create` refuses a quote-wrapped host. And a value that
 * is only WHITESPACE, control whitespace such as a lone carriage return or tab included, is reported as
 * empty rather than escaped: `trim()` decides that, and it is a deliberate simplification rather than an
 * oversight, because an endpoint of one tab is empty in every way an operator cares about. The earlier
 * comment here also claimed docker's URL parser kept control bytes out, having measured `context create`
 * and `DOCKER_HOST`: both are WRITE paths, the read path does not re-validate, and C1 is accepted on the
 * write path anyway, so the claim was wrong on its own terms as well as measured on the wrong command.
 *
 * RESIDUAL, named rather than closed: a stored endpoint whose value IS the literal text "an empty endpoint"
 * is indistinguishable from the empty case. `docker context create` refuses it (no scheme), and it costs one
 * sentence misread.
 */
export function endpointShown(endpoint) {
	const shown = String(endpoint?.endpoint ?? "");
	if (shown.trim() === "") return "an empty endpoint";
	if (shown.length <= ENDPOINT_SHOWN_MAX && /^[\x20-\x7e]+$/.test(shown)) return shown;
	return boundedShown(shown);
}

/**
 * The same escaping, always quoted, for a value that is not an endpoint: a context NAME.
 *
 * `JSON.stringify` was what printed those, and it escapes C0 and stops: a C1 CSI byte, a right-to-left
 * override and a zero-width joiner all reached the terminal through it. This is the same class the endpoint
 * itself is held to, so the two halves of `resolves context X to Y` cannot be protected differently.
 *
 * It must agree with `JSON.stringify` on the ordinary cases, because existing pins read that shape:
 * `""` for the empty string, and `null`/`undefined` rendered as themselves.
 */
export function quotedShown(value) {
	if (value === null || value === undefined) return String(value);
	const shown = String(value);
	// The CAP IS ON THE RENDERED TEXT, quotes included, which the fast path got wrong: 300 printable
	// characters render as 302, and a value of 300 quote characters as 602. A 300-character context name is
	// creatable (`docker context create` accepts one, measured), so this was reachable.
	const quoted = JSON.stringify(shown);
	if (quoted.length <= ENDPOINT_SHOWN_MAX && /^[\x20-\x7e]*$/.test(shown)) return quoted;
	return boundedShown(shown);
}

/**
 * 300 characters of RENDERED text, and the number is a literal rather than a computation.
 *
 * A DNS name is at most 253 bytes plus a scheme and a port, and a unix socket path is capped at 104 bytes on
 * macOS and 108 on Linux, so no PRINTABLE endpoint a daemon can actually have reaches this. A 104-byte
 * socket path made entirely of C1 bytes renders to about 321 characters and IS cut, which is the honest
 * statement of the bound: it cuts escaped text, not real endpoints.
 */
export const ENDPOINT_SHOWN_MAX = 300;

/**
 * Escape, then cut -- and the ORDER is the opposite of `SCRUBBED_MAX`'s, deliberately.
 *
 * Cutting first and escaping after can land the cut inside a `\u00e9` and produce text no `JSON.parse` will
 * read. Escaping first and cutting after can do the same. So this walks CODE POINTS, escapes each one, and
 * stops BEFORE the rendered text would pass the cap -- the quoted part is therefore always parseable and
 * always a PREFIX of the input, which is the property an operator needs when they compare it to what they
 * configured.
 *
 * Per code point, not per UTF-16 unit: iterating units cuts between surrogates and emits a lone one (1,537
 * of them in a 50k-case fuzz of the version this replaced). And each escape is built from `JSON.stringify`
 * of the whole code point rather than `codePointAt(0).toString(16)`, which emits `\u1f600`-shaped text for
 * an astral character -- that parses as `\u1f60` followed by a literal `0`, so the result was not a prefix
 * of anything (16,916 fuzz failures).
 */
function boundedShown(value) {
	let out = "";
	let kept = 0;
	let cut = false;
	const points = [...value];
	for (const point of points) {
		const piece = /^[\x20-\x7e]$/.test(point) ? (point === '"' || point === "\\" ? `\\${point}` : point) : escapedPoint(point);
		// +2 for the quotes this will be wrapped in. Stop BEFORE passing the cap, never after.
		if (out.length + piece.length + 2 > ENDPOINT_SHOWN_MAX) {
			cut = true;
			break;
		}
		out += piece;
		kept += 1;
	}
	// The count outside the quotes, so the quoted part stays exactly what `JSON.parse` will take.
	return cut ? `"${out}" (first ${kept} of ${points.length} characters)` : `"${out}"`;
}

function escapedPoint(point) {
	// PER UTF-16 UNIT, which is what `\uXXXX` means. Escaping the CODE POINT instead emits `\u1f600` for an
	// astral character -- five hex digits, which `JSON.parse` reads as `\u1f60` followed by a literal `0`, so
	// the result is not the value and not a prefix of it (16,916 failures in a 50,000-case fuzz). Both halves
	// of a surrogate pair are always emitted together, because the caller walks whole code points, so this
	// can never leave a lone surrogate behind.
	// JSON's OWN SHORT ESCAPES for the five it has (`\b \t \n \f \r`), because the claim this renderer makes
	// is that an under-cap value renders byte-identically to what `JSON.stringify` produced before the bound
	// existed -- and `\u0009` for a tab is not that. Everything else is escaped per UTF-16 unit below.
	const SHORT = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
	let out = "";
	for (let i = 0; i < point.length; i++) {
		const unit = point.charCodeAt(i);
		out += SHORT[point[i]] ?? (unit >= 0x20 && unit <= 0x7e ? point[i] : `\\u${unit.toString(16).padStart(4, "0")}`);
	}
	return out;
}

/**
 * Is this name one THIS project claims? ONE answer for both halves of the boot reaper, which is the whole
 * point of it being a function rather than two tests (issue #360, item 7).
 *
 * It is the bare prefix, and it is NOT an accident that it does not require `-net` of a network. The two
 * halves used to disagree: the container half was this `startsWith` and the network half was
 * `^pi-job-.*-net$`, so an operator's `pi-job-runner_default` had its CONTAINER reaped and its NETWORK left
 * standing. Two answers to "what is ours" is the defect; which answer to keep is the decision, and the
 * container half cannot be the one that moves. After a crash nothing distinguishes our `pi-job-<id>` from
 * any other name under the prefix, and a charset rule does not separate them either. `jobContainerName` maps a
 * job id onto `[A-Za-z0-9._-]` (since issue #435, when a cron id's `:` was found to be refused by the runtime), so
 * `runner_default` and `runner-db-1` are both shapes a real job's name can take. There is no stricter rule
 * available that is also TRUE, so the halves agree by widening the network one.
 *
 * WHAT THAT COSTS, stated rather than buried in a test diff: a network called `pi-job-mine-net-backup`, or
 * `pi-job-runner_default`, is now removed by the boot reaper. Their CONTAINERS always were. `SECURITY.md`
 * states "the `pi-job-*` namespace the boot reaper clears" as a deliberate claim, so this makes the code
 * agree with the claim rather than extending it -- but the objects are an operator's, so it is named in the
 * commit, in `SECURITY.md` and in the spec, not only here.
 *
 * The prefix is still only half the rule at the call sites. `docker`'s `--filter name=` is a SUBSTRING match
 * (measured on 27.4.0: `my-pi-job-notes` comes back from `--filter name=pi-job-`), so the filter is the cheap
 * server-side narrowing and this anchored test is the namespace decision. A name that merely CONTAINS the
 * prefix is not ours and never was.
 *
 * Not a constant called `_SHAPE`: a name that says "shape" while holding a prefix test is a name that lies,
 * and the previous one did.
 *
 * The `typeof` guard is UNREACHABLE from both production call sites, and saying so is the point rather than
 * claiming a coverage it does not have: the container listing is `stdout.split("\n").map(trim)`, and
 * `networkEndpoints` already coerces every endpoint with `String(c?.Name ?? "")` before returning, so
 * neither can hand this a non-string. It is here because this is EXPORTED, and a predicate that throws on a
 * value it should simply answer `false` to is a trap for the next caller -- inside `makeReaper` that throw
 * reaches the outer catch and answers `{ reaped: false }`, which is a money decision. Measured: dropping the
 * guard is caught by the unit table below and by no call-site test.
 *
 * `SANDBOX_NETWORK_SHAPE` is the sibling that must NOT be loosened the same way, and the difference is what
 * the name is FOR rather than taste: it carries a capture group and the sandbox sweep parses the session id
 * back out of it to key against the directories it kept. A predicate cannot answer that question, so the
 * sandbox's full shape is load-bearing where this one's was only a filter.
 */
export function isJobNamespace(name) {
	return typeof name === "string" && name.startsWith(JOB_NAME_PREFIX);
}

/**
 * Boot-time reaper: clear stray `pi-job-*` containers a previous worker crash left behind.
 *
 * MOVED HERE from `start.mjs` (issue #227). It belongs to the backend because the containers it sweeps are
 * that backend's, and a second backend's crashed containers are unreachable by this one's `docker ps`.
 *
 * THE TRI-STATE IS THE POINT and moved with it: `{ reaped: true }` means this host has ESTABLISHED that it
 * holds no job containers, `{ reaped: false }` means it could not establish that. `makeScopeClaimSweeper`
 * gates a money decision on the difference -- it may only delete a scope claim naming this host once the
 * host has proven it holds nothing -- so returning `[]` or `true` on a failed enumeration would free slots
 * for containers that may still be running and let another host start more alongside them. That is a spend
 * overrun rather than a tidy-up, which is why the catch below returns false rather than swallowing.
 */
export function makeReaper({ log, exec = execDocker, bin = "docker" }) {
	// Issue #354: every spawn below names `bin`, the venue's CLI, so a podman venue's reaper enumerates, removes and
	// sweeps in the store its jobs actually ran in. A mixed pass (listing under one binary, removing under another) would
	// report `reaped: true` for a host whose containers it never saw, and the scope-claim sweep spends on that answer.
	// The SAME injected `exec`, as a NON-THROWING `{ code, stdout, stderr }` step. Two things fall out and both
	// are load-bearing. It is the shape `networkEndpoints` and `removeNetworkOrSay` need -- the "not found" rule
	// reads both streams, and with `--format` the daemon puts that wording on stderr with stdout empty (measured
	// on docker 27.4.0). And because it cannot throw, the PER-NETWORK calls cannot reach the outer catch, so the
	// work this slice adds cannot flip the tri-state a scope claim is spent on.
	//
	// The `network ls` itself deliberately stays on the throwing `exec`, so a daemon that dies between the `ps`
	// and the listing still answers `{ reaped: false }`. That is the pre-existing behaviour and it is the
	// conservative direction: this host cannot claim it holds nothing while it could not finish looking.
	const step = async (args) => {
		try {
			const { stdout, stderr } = await exec(bin, args);
			return { code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
		} catch (err) {
			// `promisify(execFile)` rejects with the exit code on `.code` and what the CLI printed on
			// `.stdout`/`.stderr`. Both streams are MATCHED against and NEITHER is ever logged (issue #339).
			return { code: typeof err?.code === "number" ? err.code : null, stdout: String(err?.stdout ?? ""), stderr: String(err?.stderr ?? "") };
		}
	};

	/**
	 * One leftover network. The old body was a bare `network rm` in a `try {} catch {}` whose comment said an
	 * in-use network "belongs to something else" -- and on the path this sweep exists for, it does not: the
	 * worker died mid-job, its container is reaped three lines above, and the only thing still holding the
	 * network is this worker's OWN long-lived egress proxy, which nothing detached when the process died. So
	 * the network survived every later boot, silently, because the failure had nowhere to go (issue #357).
	 *
	 * DETACH WHAT IS ATTACHED, never a proxy named from configuration. That needs no `env` seam here, and it
	 * is right where a configured name would be wrong: a network left before a `PI_EGRESS_PROXY` change holds
	 * the OLD proxy, and on a deployment with the policy off it holds nothing at all. Inspecting is also the
	 * only way to see the one case that must be left alone.
	 *
	 * THE ONE THING THIS MUST NOT TOUCH is a network a `pi-job-` container is still on. Detaching there would
	 * sever a live job's only route out: it keeps running, spends its slot and dies at its first turn, which is
	 * strictly worse than the network it would have cleaned up. It should be unreachable -- the container loop
	 * `rm -f`'d every one of them, and a failure there throws to the outer catch -- so the ways in are a
	 * container started between the `ps` and this inspect, or the two-workers-per-daemon configuration
	 * `DES-CONCURRENCY-3` already calls catastrophic and unsupported. Where it is seen, it is left alone and
	 * said.
	 *
	 * WHAT IT CANNOT SEE IS NOW ASKED FOR SEPARATELY (issue #379, item 1). `.Containers` lists RUNNING
	 * endpoints, so a member that is `created` or `exited` was invisible to it AND to the container half's
	 * `docker ps` -- and the `rm` succeeded, leaving a container that can never start again (`docker start`
	 * answers `network <id> not found`, measured on 27.4.0 for both states). A second ask, `ps -a --filter
	 * network=`, closes that: any member outside `ENDPOINT_LISTED_STATES` keeps the network and is named.
	 *
	 * The two halves still ask DIFFERENT questions, deliberately. This one only declines to remove something,
	 * which costs a leftover network and a line. The container half `rm -f`s what it finds, so widening it
	 * the same way would destroy an operator's stopped container and a crashed job's forensic one.
	 */
	async function reapNetwork(network) {
		const { ok, names, absent } = await networkEndpoints(step, network);
		// Gone between the `ls` and now. Nothing was left behind, so there is nothing to say: the ONE silence
		// this sweep allows, and only in the daemon's own words for a network.
		if (absent) return;
		if (!ok) return log("network_not_reaped", { network, reason: "unreadable" });
		if (names.some(isJobNamespace)) return log("network_not_reaped", { network, reason: "job-container-attached" });
		// THE OTHER HALF OF THE SAME QUESTION (issue #379, item 1). `.Containers` above lists RUNNING
		// endpoints, which is what the daemon guards: with one of those attached the `rm` fails by itself.
		// It lists nothing for a member that is `created` or `exited`, and the `rm` then SUCCEEDS -- after
		// which that member can never start again, because it holds a network id the daemon no longer has.
		// Measured on docker 27.4.0 for BOTH states: `docker start` answers `network <id> not found`.
		//
		// So this half asks about a member in ANY state, and the container half deliberately does not. The
		// container half stays `docker ps`, running-only, because widening it to `ps -a` would `rm -f` an
		// operator's stopped container and a crashed job's forensic one, which `design.md` refuses; this half
		// only DECLINES to remove something, which costs a leftover network and a line saying so.
		const members = await step(["ps", "-a", "--filter", `network=${network}`, "--format", "{{.Names}}\t{{.State}}"]);
		if (members.code !== 0) return log("network_not_reaped", { network, reason: "containers-unreadable" });
		// AN ALLOWLIST, following `sandbox.mjs`: the states named here are the ones the daemon itself lists in
		// `.Containers`, so the detach-or-leave logic below already handles them. Anything else -- `created`,
		// `exited`, `dead`, a Podman state nothing here has measured -- keeps the network. `paused` is on this
		// side because it IS listed and the `rm` refuses while it is there (measured); `restarting` is not,
		// because whether it appears is a matter of which instant the sweep asks in.
		// A NAME AND A STATE, both of them the daemon's own vocabulary. A line without a tab is not a member --
		// docker writes warnings and deprecation notices to stdout, and reading one as a container name put
		// free text into a log field this file's own closed-token rule forbids, and kept the network forever
		// on the strength of it. A name that is not a docker name is not a member either (docker refuses
		// anything outside `[a-zA-Z0-9][a-zA-Z0-9_.-]*`).
		const parked = members.stdout
			.split("\n")
			.map((l) => l.split("\t"))
			.filter(([name, state]) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(name ?? "").trim()) && state !== undefined && !ENDPOINT_LISTED_STATES.has(String(state).trim()))
			.map(([name]) => name.trim());
		// THE PROXY IS NOT A REASON TO KEEP THE NETWORK, and leaving it out is what keeps this sweep able to do
		// its job. `reapNetwork` exists for exactly one shape: the worker died mid-job, its container is reaped
		// three lines above, and the only thing still holding the network is this worker's OWN long-lived
		// egress proxy. If that proxy is STOPPED at reap time -- an operator who turned the policy off, a host
		// that rebooted -- then treating it as a member to protect leaves every leftover job network standing
		// forever, logged once per boot, with nothing else in the project that would ever remove them.
		//
		// Detaching a stopped container is measured to work (`network disconnect -f`, exit 0 on docker 27.4.0),
		// and it costs that container nothing it can use: the network it is being detached from is a dead job's
		// network, which is not one the proxy needs to start. What the rule protects is a container that would
		// be BROKEN by the removal, which is any other member.
		const attached = parked.filter((name) => name !== DEFAULT_EGRESS_PROXY);
		// BOUNDED, because this goes into a log line. Five hundred stopped members produced a single
		// 18,000-character record, in the same change that bounded the endpoint line for the same reason.
		if (attached.length > 0) return log("network_not_reaped", { network, reason: "container-attached-not-running", containers: attached.slice(0, 5), more: attached.length > 5 ? attached.length - 5 : 0 });
		// The parked proxy is detached too: it is attached to this network and `.Containers` does not list it,
		// so without naming it here the `rm` would fail "has active endpoints" on a member nothing detached.
		const outcome = await removeNetworkOrSay(step, { network, detach: [...names, ...parked.filter((name) => name === DEFAULT_EGRESS_PROXY)], bin });
		if (outcome.absent) return;
		// `detached` is named rather than counted: one of them may be something this worker never attached.
		if (outcome.removed) return log("reaped_network", { network, detached: outcome.detached });
		log("network_not_reaped", { network, reason: "rm-failed", detached: outcome.detached });
	}

	return async function reap() {
		try {
			const { stdout } = await exec(bin, ["ps", "--filter", `name=${JOB_NAME_PREFIX}`, "--format", "{{.Names}}"]);
			// ANCHORED, because `--filter name=` is a SUBSTRING match: it also returns an operator's own
			// `my-pi-job-notes`, which this sweep would then `rm -f`. Measured on docker 27.4.0 by creating
			// exactly that name and watching it come back in the listing. The filter stays as the cheap
			// server-side narrowing; the namespace decision is made here, on the name, where a test can pin it.
			const names = stdout
				.split("\n")
				.map((n) => n.trim())
				.filter(isJobNamespace);
			for (const name of names) {
				await exec(bin, ["rm", "-f", name]);
				log("reaped_container", { name });
			}
			// REQ-EGRESS-ALLOWLIST: the per-job networks those containers were on. Swept AFTER the containers,
			// because a network with a member still attached cannot be removed -- and swept by the SAME
			// `pi-job-` filter, so the namespace rule that keeps an operator's live sandbox safe from the
			// container reaper keeps their sandbox NETWORK safe too. The filter is the cheap narrowing only:
			// the namespace decision is `isJobNamespace`, asked below and by the container loop above.
			//
			// A crashed worker is the case this exists for: `runContainer`'s own finally removes the network
			// on every ordinary path, so anything still here outlived a process that did not get to run it.
			const { stdout: nets } = await exec(bin, ["network", "ls", "--filter", `name=${JOB_NAME_PREFIX}`, "--format", "{{.Name}}"]);
			// Same substring hazard, and worse here: this sweep DETACHES before it removes, so a foreign
			// network that merely contains `pi-job-` would have its endpoints stripped. THE SAME PREDICATE as
			// the container loop above, which is the fix for #360 item 7: this used to be an anchored
			// `^pi-job-.*-net$`, so the two loops gave different answers to "what is ours" and a network under
			// the prefix without the suffix outlived the container it belonged to. See `isJobNamespace`.
			for (const net of nets.split("\n").map((n) => n.trim()).filter(isJobNamespace)) await reapNetwork(net);
			// Whether the enumeration HAPPENED, which the scope-claim sweep depends on: it may only delete a
			// claim naming this host once this host has actually established that it holds no containers.
			return { reaped: true };
		} catch (err) {
			// The `docker ps` is inside this try, so this path CANNOT establish that this host holds no
			// containers -- whether it failed before listing anything or after reaping some and then losing
			// the daemon. Either way the claim "I hold nothing" is unproven, and sweeping on it would free
			// slots for containers that may STILL BE RUNNING, letting another host start more alongside
			// them: a money overrun rather than a tidy-up. Conservative in the only safe direction.
			// SCRUBBED, because this is the one line in this file that carries the CLI's own words: `step` above
			// matches both streams and logs neither, but `promisify(execFile)` puts them on the Error's own
			// message, and a docker error repeats an unparseable DOCKER_HOST with its credentials (issue #339).
			log("reaper_skipped", { reason: scrubCredentials(err?.message) });
			return { reaped: false };
		}
	};
}

/**
 * WHERE THE DOCKER CLI WILL SEND A CONTAINER, AND WHETHER THAT IS THIS HOST (issue #278).
 *
 * `credentialTransit` is the property that the provider key and the per-job forge token reach the container
 * without crossing a network this deployment does not own. For `local` they ride the worker's own `docker run`
 * argv as `-e NAME=VALUE`, so the question is which daemon that CLI talks to -- and the CLI decides it from
 * `DOCKER_HOST`, else `DOCKER_CONTEXT`, else the config file's `currentContext`, with its own normalisation
 * (`DOCKER_HOST=bogus` becomes `tcp://bogus:2375`). Checking `DOCKER_HOST` alone misses both other sources, and
 * this very machine resolves through a context. So the CLI is ASKED, never re-implemented: `DES-WORKER-ON-HOST`
 * already rejected reimplementing docker's path translation, and a second copy of its context precedence would
 * be the same failure one layer over. `docker context inspect` answers from local config in milliseconds and
 * never contacts a daemon.
 *
 * The format is NARROW on purpose -- the context's name and the docker endpoint's host, each JSON-quoted -- and
 * never `{{json .}}`, which carries TLS material paths and storage locations nobody asked for. (`job-user.mjs`'s
 * `docker info` read is the one exception, and says why there: it parses the body in memory, keeps a handful of
 * facts and drops the rest, and a narrow template turns a field one runtime lacks into a template error
 * indistinguishable from no daemon.)
 */
export const DOCKER_ENDPOINT_ARGS = Object.freeze(["context", "inspect", "--format={{json .Name}}|{{json .Endpoints.docker.Host}}"]);

/**
 * `{ context, host }` from the CLI's output, or `null`. Both runners hand over stdout alone, and docker 27.4 puts
 * nothing on stdout but the answer (its warnings and errors go to stderr, which neither runner reads). The scan still runs from the LAST line
 * and credits only a line that parses whole, so a notice a plugin or a later CLI prints ahead of the answer is
 * never read as it.
 */
export function parseDockerEndpoint(output) {
	const lines = String(output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const at = lines[i].indexOf("|");
		if (at <= 0) continue;
		try {
			const context = JSON.parse(lines[i].slice(0, at));
			const host = JSON.parse(lines[i].slice(at + 1));
			if (typeof context === "string" && typeof host === "string") return { context, host };
		} catch {
			// not this line
		}
	}
	return null;
}

/** 127.0.0.0/8 as a literal dotted quad, and nothing that merely starts with "127." (`127.0.0.1.nip.io` resolves anywhere). */
function isLoopbackV4(hostname) {
	// No leading zeros. Go's parser (which the docker CLI dials with) refuses `127.0.0.09` as an address, so it is
	// a NAME: looked up by the resolver, and sent through HTTP_PROXY when one is set -- measured, with the job's
	// `-e` values in the proxied request. Only the canonical dotted quad is an address the CLI will not proxy.
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/**
 * Is this endpoint on this host, judged by its FORM? `{ local, display }`, where `display` is the endpoint with
 * the endpoint reduced or withheld so that no part of a credential in it can be logged or printed. Never an
 * EDIT of the value: see `displayEndpoint`.
 *
 * LOCAL only when it can be shown local, the polarity this codebase uses wherever a thing that cannot be shown
 * to be on gets no credit:
 *   - `unix://` -- a socket on this machine's filesystem (Docker Desktop's and colima's VMs included: they are
 *     this machine's own runtime, not a network the deployment does not own).
 *   - `npipe:` with the `.` host -- `npipe:////./pipe/docker_engine`. A named pipe on another host is SMB, and
 *     the CLI accepts one. Parsed by hand: `new URL` puts the `.` in the path with an empty host.
 *   - `tcp://` to exactly `localhost`, a canonical literal `127.0.0.0/8` address (no leading zeros) or `[::1]`.
 * NOT local: `ssh://` (including `ssh://localhost` -- `~/.ssh/config` can send that anywhere), `tcp://` to any
 * other name or address, any other scheme, and nothing at all.
 *
 * WHAT THIS CANNOT SEE, and says so: a unix socket or a loopback port can be a tunnel (`ssh -L`, socat) to
 * another machine, and `localhost` is whatever this host's resolver says it is. The form is local and the daemon
 * is not. That residual is named in the declaration's comment rather than claimed away.
 */
export function classifyDockerEndpoint(host) {
	if (typeof host !== "string" || host === "") return { local: false, display: "" };
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(host)?.[1]?.toLowerCase();
	const display = displayEndpoint(host, scheme);
	if (scheme === "unix") return { local: true, display };
	if (scheme === "npipe") {
		// `\\.\pipe\name` is this machine's pipe namespace; `\\.\UNC\host\...` is the same `.` prefix
		// reaching another host over SMB, so the segment after `.` must be `pipe` too, and no later segment may
		// be `.` or `..`, which Windows resolves in a `\\.\` path and could climb back out of `pipe` with. Split on
		// both separators, because the CLI passes a backslash through and Windows reads it as one.
		const [server, namespace, ...rest] = host.slice("npipe:".length).replace(/^[\\/]+/, "").split(/[\\/]/);
		return { local: server === "." && String(namespace).toLowerCase() === "pipe" && rest.length > 0 && !rest.some((seg) => seg === "." || seg === ".." || seg === ""), display };
	}
	if (scheme === "tcp") {
		let hostname;
		try {
			hostname = new URL(host).hostname;
		} catch {
			return { local: false, display };
		}
		return { local: hostname === "localhost" || hostname === "[::1]" || isLoopbackV4(hostname), display };
	}
	return { local: false, display };
}

/** Everything between `scheme://` and the first `/`, `?` or `#`; `null` when the value does not start `scheme://`. */
function rawAuthority(host, scheme) {
	if (!scheme || host.slice(0, scheme.length + 3).toLowerCase() !== `${scheme}://`) return null;
	const rest = host.slice(scheme.length + 3);
	const end = rest.search(/[/?#]/);
	return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The endpoint as it may be logged and printed. Never an EDIT of it: passed through whole, reduced to a host, or
 * withheld. Editing is what kept failing, because a password may itself hold `@`, `/`, `?` or `#`, so any rule that
 * splits the string and keeps a part can keep part of a password.
 *
 * THE RULE IS ONE FACT ABOUT URLs: userinfo ends at an `@`. So if the whole value holds exactly ONE `@` and that `@`
 * lies inside the raw authority, then under every parse the userinfo is a prefix of what precedes it, and everything
 * after it -- which is all that is shown -- is host and port. A password containing `@`, `/`, `?` or `#` either adds a
 * second `@` or pushes the only one outside the authority, and both are withheld.
 *
 * `new URL` IS THE DEFECT THIS REPLACES (issue #340), not a helper it uses. It computes an authority of its own and
 * takes the LAST `@` in it, so `ssh://bob:@secret/word@remote` parsed with host `secret` and `ssh://bob:4455?qzx@remote`
 * with host `bob:4455`: part of a password, displayed. A 2,000,000-value fuzz over hostile password bodies leaks
 * 639,930 times under that rule and zero under this one.
 *
 * `unix` and `npipe` are PATHS, where `@` is an ordinary filename character, and three call sites read this display
 * form AS that path (`job-user.mjs`, `sandbox.mjs`, `runtime-observations.mjs`). They pass through whole when they have
 * no authority at all, which every real socket path does. One WITH an authority is a userinfo position on a URL no
 * socket needs, and is withheld -- the previous rule cut at the last `@` of a hand-split authority, so
 * `unix://bob:p/w@/x.sock` displayed VERBATIM and `unix://bob@/var/run/docker.sock` displayed an INVENTED path that
 * `job-user.mjs` then stat'ed. If the withheld token's shape ever loses its `scheme://` prefix, `podmanOnThisHost`
 * changes answer with it.
 *
 * `\` is deliberately NOT an authority terminator: Go's `url.Parse`, which the docker CLI uses, ends an authority at
 * the first `/` only, so `unix://\\srv\x@y` is userinfo to it and must be withheld rather than read as an empty
 * authority and passed through. Adding it to the set makes `npipe://\\host\pipe:pw@x` display its
 * password, measured, and there is a test for that rather than only this sentence.
 *
 * Taking the FIRST `@` of the authority rather than the last is equivalent while the one-`@` guard below
 * stands, since there is then only one. It is written as `indexOf` because that is the rule being
 * expressed; remove the guard and the difference between them is the entire defect this replaced.
 *
 * WHAT IS GIVEN UP, stated rather than glossed: a password in `DOCKER_HOST` no longer makes the display say so, since
 * `tcp://bob:pw@127.0.0.1:2375` now shows its host like any other. Accepted because neither docker's tcp transport nor
 * ssh takes a password from a URL, so it is inert junk in an operator's environment rather than a credential this
 * worker puts on a wire. The old comment claimed the CLI refuses to dial every withheld form, and that was false twice:
 * `tcp://bob:hunter2@127.0.0.1:P` dials, and `ssh://bob@[fe80::1%25en0]:22` dials (`URL` rejects IPv6 zone ids; the CLI
 * runs `ssh -- fe80::1%en0`). Both now show their host, which is the fact an operator needs.
 */
function displayEndpoint(host, scheme) {
	if (!host.includes("@")) return host;
	const authority = rawAuthority(host, scheme);
	// The scheme is named only when the value really starts `scheme://`: in `bob:pw@host` the "scheme" is a username.
	const withheld = `${authority === null ? "" : `${scheme}://`}(credentials not shown)`;
	if (scheme === "unix" || scheme === "npipe") return authority === "" ? host : withheld;
	if (authority === null || !authority.includes("@")) return withheld;
	if (host.indexOf("@") !== host.lastIndexOf("@")) return withheld;
	return `${scheme}://${authority.slice(authority.indexOf("@") + 1)}`;
}

/**
 * Why a resolve failed, as `{ reason, transient }`. A fixed token, never the CLI's stderr, which is not read at
 * all: a missing context's message carries the operator's home path, and a `DOCKER_HOST` it cannot parse is
 * repeated in it, credentials included.
 *
 * Classified on what Node supplies as values, per `DES-TRANSIENT-VERSUS-DETERMINATE-IS-ONE-RULE`:
 *   - the SPAWN errno through `transient.mjs`'s allow-list (no docker binary is determinate; a spawn out of
 *     processes or descriptors, or refused with `EACCES`, is not);
 *   - the timer's kill is a `timeout`, and a death by any other signal is named by it; both are transient;
 *   - a NON-ZERO EXIT is determinate. It is the CLI's own answer, and on docker 27.4 most measured are
 *     configuration refusals that answer the same until the operator changes something: a context that does not
 *     exist, a `DOCKER_HOST` it cannot parse, a context file it cannot parse. Some are not -- `permission denied`
 *     on the context store, a CLI starved of file descriptors -- and telling them apart would need a table of
 *     another tool's stderr prose, the shape that entry rejects for `gh auth token` on exactly this argument. So
 *     the residual is named instead: under a floor such a passing failure exits 2 at boot, and per job it
 *     refuses with the fixed comment as `backend-floor-unobserved` rather than retrying;
 *   - output that does not parse on a clean exit is determinate.
 */
export function classifyEndpointFailure({ error = null, code = null } = {}) {
	if (error?.timedOut || error?.killed) return { reason: "timeout", transient: true };
	if (typeof error?.signal === "string") return { reason: `signal-${error.signal.toLowerCase()}`, transient: true };
	if (error?.code === "ENOENT") return { reason: "docker-not-found", transient: false };
	if (typeof error?.code === "string") return { reason: `spawn-${error.code.toLowerCase()}`, transient: !isDeterminateFsCode(error.code) };
	if (typeof error?.code === "number" && error.code !== 0) return { reason: `exit-${error.code}`, transient: false };
	if (typeof code === "number" && code !== 0) return { reason: `exit-${code}`, transient: false };
	if (error) return { reason: "spawn-failed", transient: true };
	return { reason: "unparseable", transient: false };
}

/**
 * Run the CLI bounded, as `{ code, stdout, error }`. `execFile`'s own `timeout` is NOT the bound: it sends a
 * signal and then still waits for the child's `close`, so a CLI wedged on a dead socket never settles
 * (`retention-sweep.mjs` records the same). A separate timer settles the promise regardless, kills with
 * SIGKILL and destroys the pipes. REF'D, because at boot nothing else may be holding the event loop.
 */
export function execDockerBounded(args, { timeoutMs = 5000, execFileFn = execFile, maxBuffer = 64 * 1024, bin = "docker" } = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let child = null;
		let timer = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => {
			try {
				child?.kill?.("SIGKILL");
				child?.stdout?.destroy?.();
				child?.stderr?.destroy?.();
			} catch {
				// already gone
			}
			finish({ code: null, stdout: "", error: { timedOut: true } });
		}, timeoutMs);
		try {
			// No `env`: the endpoint that matters is the one the job's own `docker run` will use, and that spawn
			// inherits this process's environment. Passing an env here would ask about a different CLI.
			child = execFileFn(bin, [...args], { killSignal: "SIGKILL", maxBuffer }, (err, stdout) => {
				finish({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout ?? ""), error: err ?? null });
			});
		} catch (err) {
			finish({ code: null, stdout: "", error: err });
		}
	});
}

/**
 * The resolver: `async () => ({ local, context, endpoint, reason, transient })`. `local` is `true`, `false`, or
 * `null` when the CLI did not answer; `endpoint` is the display form; `reason` and `transient` are set only when
 * `local` is `null`. `run(args)` is the seam, returning `{ code, stdout, error }`.
 */
export function makeDockerEndpointResolver({ run = (args) => execDockerBounded(args) } = {}) {
	return async function resolveDockerEndpoint() {
		let result;
		try {
			result = await run(DOCKER_ENDPOINT_ARGS);
		} catch (err) {
			result = { code: null, stdout: "", error: err };
		}
		const parsed = result?.error || result?.code !== 0 ? null : parseDockerEndpoint(result.stdout);
		if (!parsed) {
			const { reason, transient } = classifyEndpointFailure({ error: result?.error ?? null, code: result?.code ?? null });
			return { local: null, context: null, endpoint: null, reason, transient };
		}
		const { local, display } = classifyDockerEndpoint(parsed.host);
		return { local, context: parsed.context, endpoint: display, reason: null, transient: false };
	};
}
