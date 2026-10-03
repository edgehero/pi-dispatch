/**
 * pi's own model loader, from the pi-coding-agent installed beside the worker, for `doctor` (issue #502's open
 * question: can the worker's view of the overlay `models.json` disagree with pi's?).
 *
 * THE CHOICE, and why. The issue suggests running pi's loader in the job image. Doctor does run that image already,
 * for the egress canary, but a probe that mounts the operator's overlay into it needs the canary's venue, job-user and
 * SELinux handling, and every doctor run would pay a container start for it. The worker and the job image are built
 * from one lockfile, so the pi-coding-agent that a checkout of this repository installs at the workspace root after
 * `npm ci` is the pi the image carries, and doctor asks that one, in-process. Its version is named on doctor's line.
 * Where it is not installed (a worker installed on its own: the worker package depends on pi-ai only), doctor says
 * the comparison was not made rather than guessing. And only the PINNED pi counts (PR #551's review): an `npm i -g`
 * layout resolves whatever pi-coding-agent sits beside the worker, a global pi CLI of any version, so the loader
 * reports the worker's pinned pi-ai (its exact dependency; pi-ai and pi-coding-agent are released in lockstep, and a
 * test holds this pin equal to the runner's pi-coding-agent pin, which is the image's) and doctor compares nothing
 * when the pi-coding-agent version differs from it.
 *
 * Its own module because it is the one place doctor's code must touch `process.env`: pi reads `PI_OFFLINE` from the
 * process environment, and the runtime is created with it set so asking about models can never reach the network.
 * It is restored straight after.
 *
 * NOTHING ON DISK (PR #551's review, round 2). The runtime is handed an in-memory credential store and an in-memory
 * models store. With pi's file-backed defaults it wrote an `auth.json` into a temporary directory, and pi's file
 * backend creates the parent directory before it writes, so a write landing after the cleanup brought the directory
 * back (17 were found in a TMPDIR); the default models store would also have written `models-store.json` beside the
 * operator's overlay file. Neither store holds anything the question needs: composition reads the config only.
 */

import { readFileSync } from "node:fs";

/**
 * `{ version, pinned, read(path) }`, or null when pi-coding-agent cannot be resolved from here. `version` is the
 * resolved pi-coding-agent's, `pinned` the worker package's exact `@earendil-works/pi-ai` dependency. `read` answers
 * `{ loads, has(provider, id) }`: `loads` is `ModelConfig.load(path).getError() === undefined`, and `has` asks a
 * `ModelRuntime` created over the file (pi's provider composition included) for the model, with in-memory credential
 * and models stores, so nothing is read from or written to disk beyond the file itself.
 */
export async function loadPiModelLoader({ resolveEntry = (name) => import.meta.resolve(name), workerPackage = new URL("../package.json", import.meta.url) } = {}) {
	let ModelConfig;
	let ModelRuntime;
	let AuthStorage;
	let InMemoryCodingAgentModelsStore;
	let version;
	let pinned = null;
	try {
		pinned = JSON.parse(readFileSync(workerPackage, "utf8"))?.dependencies?.["@earendil-works/pi-ai"] ?? null;
	} catch {
		// No pin to compare against: doctor then says it cannot tell, rather than comparing with any pi.
	}
	try {
		const entry = resolveEntry("@earendil-works/pi-coding-agent");
		({ ModelConfig } = await import(new URL("core/model-config.js", entry).href));
		({ ModelRuntime } = await import(new URL("core/model-runtime.js", entry).href));
		({ AuthStorage } = await import(new URL("core/auth-storage.js", entry).href));
		({ InMemoryCodingAgentModelsStore } = await import(new URL("core/models-store.js", entry).href));
		version = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8")).version;
	} catch {
		return null;
	}
	return {
		version,
		pinned,
		async read(path) {
			const config = await ModelConfig.load(path);
			const loads = config.getError() === undefined;
			// env-internal PI_OFFLINE: pi's own switch, set here so asking pi about models never reaches the network.
			const offline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const runtime = await ModelRuntime.create({ modelsPath: path, credentials: AuthStorage.inMemory(), modelsStore: new InMemoryCodingAgentModelsStore(), refreshOnCreate: false });
				return { loads, has: (provider, id) => runtime.getModel(provider, id) !== undefined };
			} finally {
				if (offline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = offline;
			}
		},
	};
}
