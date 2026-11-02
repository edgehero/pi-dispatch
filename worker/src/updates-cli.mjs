/**
 * `pi-dispatch updates look|reconcile`: what the worker runs as a child (issue #796). A person may run them too, to see them work on a host, and they do the same thing.
 * Exit 0 ran, 1 could not reach what it needed, 2 was asked for something else. Names only on stdout.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { piVersionOf, resolvePiBinary } from "./chat-fork.mjs";
import { piAiVersion } from "./pricing.mjs";
import { workerName } from "./config.mjs";
import { boundedJson, buildLook, hostPiFacts } from "./updates-look.mjs";
import { reconcileUpdates } from "./updates-reconcile.mjs";
import { publishLook } from "./updates.mjs";

const defaultExec = promisify(execFile);

/** Doctor's own one-shot client: connected before the first command, bounded, and always dropped. */
async function defaultWithClient(url, fn) {
	const { withDoctorClient } = await import("./doctor.mjs");
	return await withDoctorClient(url, fn);
}

export async function runUpdatesCli(argv, { env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), withClient = defaultWithClient, exec = defaultExec, look = null } = {}) {
	const [what, ...rest] = argv;
	if (!["look", "reconcile"].includes(what) || rest.length > 0) {
		err("usage: pi-dispatch updates look|reconcile\n");
		return 2;
	}
	if (!env.VALKEY_URL) {
		err("pi-dispatch updates: VALKEY_URL is not set\n");
		return 1;
	}
	if (what === "look" && env.PI_UPDATES_LOOK !== "1") {
		err("pi-dispatch updates look: the look is off until PI_UPDATES_LOOK=1\n");
		return 2;
	}
	const host = workerName(env);
	try {
		return await withClient(env.VALKEY_URL, async (redis) => {
			if (what === "look") {
				const proxyUrl = env.PI_UPDATES_PROXY || null;
				const tested = piAiVersion();
				const record = await (look ?? buildLook)({
					env, host, pinned: tested, get: (url) => boundedJson(url, { proxyUrl }),
					hostPi: async () => hostPiFacts({ tested, resolvePi: () => resolvePiBinary({ env }), versionOf: (path) => piVersionOf(path, { env }) }),
				});
				await publishLook(redis, record);
				out(`updates look: published for ${host}\n`);
				return 0;
			}
			const done = await reconcileUpdates({ redis, host, env, cwd, exec, log: (event, fields) => out(`${JSON.stringify({ event, ...fields })}\n`) });
			if (done.unreachable) {
				err("pi-dispatch updates reconcile: Valkey did not answer\n");
				return 1;
			}
			return 0;
		});
	} catch (error) {
		err(`pi-dispatch updates ${what}: ${error?.code ?? "failed"}\n`);
		return 1;
	}
}
