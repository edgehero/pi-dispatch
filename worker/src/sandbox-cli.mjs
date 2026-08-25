import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { createJobNetwork, egressEnv, networkNameFor, removeJobNetwork } from "./egress.mjs";
import { buildSandboxRunArgs, launchSandbox, listRunningSandboxes, parsePublish, resolveSandbox, sandboxContainerName } from "./sandbox.mjs";
import { listSandboxes, pinSandbox } from "./sandbox-store.mjs";

/**
 * `pi-dispatch sandbox` -- re-open a finished run's sandbox as an interactive shell
 * (REQ-RESURRECTABLE-SANDBOX).
 *
 * A command module beside doctor.mjs and import-pi.mjs, with the same posture: the whole I/O surface is
 * injected so the decision paths are testable without docker, a terminal, or a disk, and every refusal
 * names what to do about it rather than only what went wrong.
 *
 * The container this launches is NOT a job container. It carries the same isolation flags and the same
 * mounts, and no credentials at all -- see sandbox.mjs, which owns that shape.
 */
export async function runSandbox(argv = [], { env = process.env, deps = {} } = {}) {
	const {
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
		running = listRunningSandboxes,
		launch = launchSandbox,
		// The docker spawn used for this session's egress network, seamed like `launch` so the tests never
		// touch a daemon. Only used when PI_EGRESS=1.
		spawnNetwork = spawn,
		now = () => Date.now(),
	} = deps;

	let values;
	let positionals;
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				list: { type: "boolean", default: false },
				publish: { type: "string", multiple: true }, // repeatable; always bound to 127.0.0.1
				pin: { type: "boolean", default: false },
			},
		}));
	} catch (error) {
		return fail(err, error.message);
	}

	const config = loadConfig(env);
	// A docker that cannot be reached costs a column, never the command: `listRunningSandboxes` throws so
	// the REAPER can tell "none" from "could not ask", and these callers only draw a marker. Asked only
	// where it is used, and never before the arguments are known good -- a typo should not shell out.
	const liveSandboxes = async () => new Set(await running().catch(() => []));

	if (values.list) {
		return renderList({ config, live: await liveSandboxes(), out, now });
	}

	const jobId = positionals[0];
	if (!jobId) return fail(err, "a job id is required — `pi-dispatch sandbox --list` shows what is still re-openable");

	// Refused BEFORE anything else that could half-succeed. `-t` against a pipe fails inside docker with
	// "the input device is not a TTY", which names neither the cause nor the fix; a sandbox is an operator
	// session by definition, so the absence of an operator is a refusal rather than a fallback.
	if (!isTty) {
		return fail(err, "`pi-dispatch sandbox` needs a terminal — it opens an interactive shell, so it cannot run from a pipe, a script without a TTY, or CI");
	}

	// `listRunningSandboxes` yields ids, already sanitized, so this compares like with like.
	if ((await liveSandboxes()).has(sanitizeJobId(jobId))) {
		return fail(err, `a sandbox for ${jobId} is already running — attach to it with \`docker attach ${sandboxContainerName(jobId)}\`, or exit it first`);
	}

	let publish;
	try {
		publish = parsePublish(values.publish ?? []);
	} catch (error) {
		return fail(err, error.message);
	}

	const resolved = resolveSandbox({
		jobId,
		sandboxDir: config.sandboxDir,
		retentionHours: config.sandboxRetentionHours,
		publish,
	});
	if (resolved.refused) return fail(err, resolved.message);

	// Pin BEFORE the shell, not after: the operator asked to keep this one, and a session that ends in a
	// crashed terminal or a closed laptop lid must not be the reason the pin never landed.
	if (values.pin) {
		const pinned = pinSandbox({ sandboxDir: config.sandboxDir, jobId, pinDays: config.sandboxPinDays, now });
		if (pinned.pinned) out(`pinned ${jobId} until ${pinned.keepUntil} (${config.sandboxPinDays}d)\n`);
		else err(`warning: could not pin ${jobId}: ${pinned.reason}\n`);
	}

	// REQ-EGRESS-ALLOWLIST: this session's own network, exactly like a job's, named off its own container
	// so the reaper's `pi-job-` filter never touches it -- a worker restart must not tear the network out
	// from under a shell an operator is sitting in.
	const network = config.egress ? networkNameFor(resolved.name) : null;
	const args = buildSandboxRunArgs({
		image: resolved.manifest.image,
		name: resolved.name,
		workspace: resolved.manifest.workspace,
		jobDir: resolved.manifest.dir,
		publish,
		term: env.TERM,
		idleSeconds: config.sandboxIdleMinutes * 60,
		network,
		egressEnv: egressEnv({ proxy: config.egressProxy, armed: config.egress }),
	});

	out(`opening ${resolved.name} — image ${resolved.manifest.image}, workspace ${resolved.manifest.workspace}\n`);
	out("no credentials are set in this container. exit the shell to dispose of it.\n");
	if (publish.length > 0) out(`published: ${publish.filter((f) => f !== "-p").join(", ")}\n`);

	// No pre-spend gate here, deliberately: that is a MONEY gate and a sandbox spends nothing. A missing
	// proxy fails at `docker run` with docker's own message, in front of an operator at a terminal, which
	// is the one place a late failure is cheap.
	if (network && !(await createJobNetwork(spawnNetwork, { network, proxy: config.egressProxy }))) {
		return fail(err, `could not create the egress network ${network} -- is the proxy running? \`docker compose -f deploy/docker-compose.yml --profile egress up -d\``);
	}
	try {
		const { code, error } = await launch({ args });
		if (error) return fail(err, `could not start docker: ${error.message}`);
		return code ?? 0;
	} finally {
		if (network) await removeJobNetwork(spawnNetwork, { network, proxy: config.egressProxy });
	}
}

/**
 * What is still re-openable, newest first, plus what is running right now.
 *
 * The running column is the honest answer to `TMOUT`'s one gap: an idle timeout does not tick while a
 * foreground command runs, so a sandbox left serving an app stays up. Making it findable is the least
 * this can do about that.
 */
function renderList({ config, live, out, now }) {
	if (config.sandboxRetentionHours === 0) {
		out("workspace retention is off (PI_SANDBOX_RETENTION_HOURS=0) — finished runs are deleted as before\n");
	}
	const rows = listSandboxes({ sandboxDir: config.sandboxDir });
	if (rows.length === 0) {
		out("no retained workspaces\n");
		return 0;
	}
	const width = Math.max(...rows.map((r) => String(r.jobId ?? "").length), 5);
	for (const row of rows) {
		const id = String(row.jobId ?? "?").padEnd(width);
		const kind = String(row.kind ?? "?").padEnd(8);
		const state = live.has(sanitizeJobId(row.jobId)) ? "RUNNING" : remaining(row, config.sandboxRetentionHours, now());
		out(`${id}  ${kind}  ${state}\n`);
	}
	return 0;
}

/** How long this one has left, from the manifest's own timestamps -- never from mtime, which a live sandbox moves. */
function remaining(row, retentionHours, at) {
	const keepUntil = Date.parse(row.keepUntil ?? "");
	if (Number.isFinite(keepUntil)) return `pinned, ${humanise(keepUntil - at)} left`;
	const createdAt = Date.parse(row.createdAt ?? "");
	if (!Number.isFinite(createdAt)) return "expired";
	return `${humanise(createdAt + retentionHours * 3600000 - at)} left`;
}

function humanise(ms) {
	if (ms <= 0) return "0h";
	const hours = Math.round(ms / 3600000);
	if (hours < 48) return `${Math.max(1, hours)}h`;
	return `${Math.round(hours / 24)}d`;
}

function fail(err, message) {
	err(`error: ${message}\n`);
	return 1;
}
