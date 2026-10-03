import { settleBeforeCleanup } from "./temp-dir.mjs";

/**
 * Make every ModelRuntime refresh in this test process one the file's cleanup waits for.
 *
 * At the 0.99.1 pin, `registerProvider`, `registerVirtualModel` and their siblings start a refresh they never await
 * (model-runtime.js, `void this.refresh(...)`), and a refresh reads credentials, which writes `auth.json` into the
 * runtime's agent dir. When that agent dir is a `tempDir()`, a refresh that lands after the file's cleanup recreates
 * the directory, and the CI leftover check names it (seen intermittently for the #544 overlay test). Patching the
 * prototype once covers every runtime the file builds, an extension's own included (same module instance), without
 * changing the options the runner passes. Idempotent.
 */
export function trackPiRefreshes(ModelRuntime) {
	const proto = ModelRuntime?.prototype;
	if (!proto || proto[TRACKED]) return;
	const refresh = proto.refresh;
	proto.refresh = function trackedRefresh(...args) {
		return settleBeforeCleanup(refresh.apply(this, args));
	};
	proto[TRACKED] = true;
}

const TRACKED = Symbol.for("pi-dispatch.test.refreshes-tracked");
