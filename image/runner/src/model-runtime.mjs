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
 * (import-pi refuses a literal key there).
 */
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

export function createJobModelRuntime({ ModelRuntime, agentDir, modelsPath }) {
	return ModelRuntime.create(jobModelRuntimeOptions({ agentDir, modelsPath }));
}
