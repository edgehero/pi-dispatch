import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { launchSandbox, listRunningSandboxes, openSandbox, parsePublish, sandboxContainerName, sandboxVenueRefusal } from "./sandbox.mjs";
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
		// touch a daemon. Not used when PI_EGRESS=0.
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

	let publish;
	try {
		publish = parsePublish(values.publish ?? []);
	} catch (error) {
		return fail(err, error.message);
	}

	// #227, #277. Everything from here to the shell is `openSandbox`, shared with the admin panel: every
	// refusal (the per-job venue refusal included, which replaced a deployment-wide one this command used to
	// apply on its own), the already-running refusal, this session's egress network and its teardown. The
	// panel assembled the same session from parts and dropped the network; one function is what stops that.
	const result = await openSandbox({
		jobId,
		sandboxDir: config.sandboxDir,
		retentionHours: config.sandboxRetentionHours,
		publish,
		// env-internal TERM: the operator's own terminal type, forwarded so the sandbox shell renders the
		// way their terminal does. Nothing a deployment declares.
		term: env.TERM,
		idleSeconds: config.sandboxIdleMinutes * 60,
		egress: { armed: config.egress, proxy: config.egressProxy },
		running,
		launch,
		spawnNetwork,
		beforeLaunch: ({ resolved }) => {
			// Pin BEFORE the shell, not after: the operator asked to keep this one, and a session that ends in a
			// crashed terminal or a closed laptop lid must not be the reason the pin never landed.
			if (values.pin) {
				const pinned = pinSandbox({ sandboxDir: config.sandboxDir, jobId, pinDays: config.sandboxPinDays, now });
				if (pinned.pinned) out(`pinned ${jobId} until ${pinned.keepUntil} (${config.sandboxPinDays}d)\n`);
				else err(`warning: could not pin ${jobId}: ${pinned.reason}\n`);
			}
			out(`opening ${resolved.name} — image ${resolved.manifest.image}, workspace ${resolved.manifest.workspace}\n`);
			out("no credentials are set in this container. exit the shell to dispose of it.\n");
			if (publish.length > 0) out(`published: ${publish.filter((f) => f !== "-p").join(", ")}\n`);
		},
	});
	if (result.refused) return fail(err, result.message);
	if (result.error) return fail(err, `could not start docker: ${result.error.message}`);
	if (result.detached) out(`detached: ${sandboxContainerName(jobId)} is still running with its egress network, which is left in place after it exits -- \`docker attach ${sandboxContainerName(jobId)}\` to return\n`);
	return result.code ?? 0;
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
		// A run this host cannot re-open is still listed (it is still retained and still swept), but not as
		// time left on something re-openable (#277): the list answers "what can I open", and the venue says why not.
		const state = sandboxVenueRefusal({ jobId: row.jobId, manifest: row })
			? typeof row.backend === "string" && row.backend !== ""
				? `not here (ran on ${row.backend})`
				: "not openable (no venue recorded)"
			: live.has(sanitizeJobId(row.jobId))
				? "RUNNING"
				: remaining(row, config.sandboxRetentionHours, now());
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
