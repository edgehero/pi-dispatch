/**
 * The job's ModelRuntime (issue #509; INT-SDK-SESSION-OPTIONS), one spelling for run-job.mjs and the tests that
 * must build pi's model layer exactly as a job does.
 *
 * At the 0.99.1 pin `AuthStorage` is no longer exported and `ModelRegistry.create(auth, path)` is gone: the model and
 * credential layer is `ModelRuntime.create({...})` (dist/core/model-runtime.js:78), handed to createAgentSession as
 * `modelRuntime`. The CLASS is injected, never imported here, so this module keeps no pi import and its tests need no
 * pi install; run-job.mjs passes the one it imports from pi-coding-agent.
 *
 * Two options are set on purpose, and both close a write or a request a job has no business making:
 *
 * - `modelsStore`: a store that remembers nothing. pi's default is a FileModelsStore at `models-store.json` BESIDE
 *   modelsPath (model-runtime.js:82-85), a cache of remote model catalogs. The runner's modelsPath is the operator
 *   overlay's `/opt/pi-global/models.json` when that is mounted, which is READ-ONLY, so the default store's first
 *   write fails there (measured, EACCES, once per provider); where it does not fail it writes a cache into the
 *   agent dir that nothing reads back, because every job starts from a fresh container. The catalog a job resolves
 *   against is the pinned pi's built-in one plus the overlay's definitions, which is what CONST-PI-VERSION-PINNED
 *   wants anyway: a remote catalog refresh is exactly the kind of upstream change that should arrive with a bump.
 * - `allowModelNetwork: false`: no catalog refresh from the network at create. pi only refreshes when this is true
 *   AND `PI_OFFLINE` was unset at create (model-runtime.js:92, 95), and the runner has already forced PI_OFFLINE=1
 *   (enforceOfflineMode), so this is the second of two locks rather than the only one. Stated rather than defaulted:
 *   this repo pins upstream defaults instead of inheriting them.
 *
 * `authPath` stays `${agentDir}/auth.json`, the same file the 0.80.7 wiring passed to AuthStorage.create: the
 * credential still comes from the environment or auth.json, and the overlay models.json is definitions only
 * (import-pi refuses a literal key there). Since issue #587's gate run-job reads that file once, at start
 * (createJobModelRuntime below).
 */
import { readFileSync } from "node:fs";
import { configError } from "./outcome.mjs";
export const DISCARDING_MODELS_STORE = Object.freeze({
	async read() {
		return undefined;
	},
	async write() {},
	async delete() {},
});

export function jobModelRuntimeOptions({ agentDir, modelsPath }) {
	return { authPath: `${agentDir}/auth.json`, modelsPath, modelsStore: DISCARDING_MODELS_STORE, allowModelNetwork: false };
}

/**
 * auth.json's contents at job start, or `{}` when there is none or it cannot be read as a JSON object. The job's
 * credential comes from its environment (the worker's closed env); this file is a fallback the job image does not
 * ship, so a file that does not parse leaves the job on its env key rather than failing it.
 */
export function readAuthSnapshot(path, { readFile = readFileSync } = {}) {
	let parsed;
	try {
		parsed = JSON.parse(String(readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return {};
	}
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * pi's own AuthStorage class, from pi-coding-agent's dist by file URL (it is not exported from the package root at
 * the pin; pinned-api.test.mjs holds the path and `inMemory`). `resolve` and `load` are injected for tests. Fails
 * CLOSED (issue #587's review): a pi whose module or `AuthStorage.inMemory` cannot be had is a config error, because
 * falling back to pi's file store would let the job's own auth.json writes reach its requests again.
 */
export async function loadPiAuthStorage({ resolve = (spec) => import.meta.resolve(spec), load = (url) => import(url) } = {}) {
	let module;
	try {
		module = await load(new URL("./core/auth-storage.js", resolve("@earendil-works/pi-coding-agent")).href);
	} catch {
		module = null;
	}
	if (typeof module?.AuthStorage?.inMemory !== "function") throw configError("pi's AuthStorage.inMemory is not where the pinned pi has it (core/auth-storage.js): the job's credentials cannot be held in memory");
	return module.AuthStorage;
}

/**
 * The job's ModelRuntime. With pi's `AuthStorage` handed in (run-job.mjs always does), the credentials are the
 * auth.json contents read ONCE here, held in pi's in-memory store (issue #587's gate): pi's file store re-reads the
 * file whenever it changes, and a credential's `env` is merged into every request's options.env after the guards ran
 * (ModelRuntime.prepareRequest), so a job that wrote auth.json mid-run could pick its Azure deployment past the model
 * list, or set PI_CACHE_RETENTION past the cost bound. A refresh or login pi makes writes to memory only. Without
 * `AuthStorage` (tests that build pi's model layer on its own) pi's file store is used as before.
 */
export function createJobModelRuntime({ ModelRuntime, AuthStorage = null, agentDir, modelsPath, readFile }) {
	const options = jobModelRuntimeOptions({ agentDir, modelsPath });
	if (AuthStorage !== null) options.credentials = AuthStorage.inMemory(readAuthSnapshot(options.authPath, readFile ? { readFile } : {}));
	return ModelRuntime.create(options);
}
