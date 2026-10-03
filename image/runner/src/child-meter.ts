/**
 * The child meter (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): a pi extension the child preload puts
 * first on a pi child's command line (`-e`). It starts the child's own meter (usage-meter.mjs startChildMeter) at
 * extension load, before any other extension's factory and before any session exists, so a call an extension makes
 * while it loads is already metered and judged.
 *
 * WHY THESE THREE IMPORTS, AND WHY BARE. pi loads an extension through its own loader, which maps these specifiers to
 * the copies the CHILD runs: in a child started from the bundle (the package bin) they are the bundle's own
 * ModelRuntime and pi-ai, which no file on disk exports; in a child started from dist/cli.js they are that package's.
 * So the class wrapped here is the class the child's sessions dispatch through, and the compat copy is the one whose
 * stream factory answers a braked call. Never import the class from pi's dist/index.js by path: in a bundled child that
 * is a second copy no session uses, and wrapping it counts nothing while reporting success. session_start checks the
 * session's own runtime against the install and records the child unmetered when it is not covered.
 *
 * WHY `.ts`. The file is plain JavaScript; the extension is what makes pi's loader TRANSFORM it, and only a transformed
 * module gets the mapping above. A `.mjs` or `.js` extension is imported natively first, and when its bare specifiers
 * resolve from where it sits they bind whatever copies Node finds there. Measured at 0.99.1 in this repository's tree:
 * from image/runner/src a `.mjs` meter got the hoisted pi-ai (no compat registry, so no brake) and, in a bundled child,
 * dist/index.js's ModelRuntime (not the bundle's, so nothing counted); the same file as `.ts` got the child's own copies
 * in both CLIs. In the image the hoisted pi-ai is absent and the native import would fail over to the transform, which
 * is correct only by that accident.
 *
 * usage-meter.mjs is NOT imported here statically: pi's loader would load it as one more extension module. The
 * preload hands over its own native import of it on globalThis, and this file imports it natively only when no
 * preload ran (the same module either way).
 */
import * as piAi from "@earendil-works/pi-ai";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** usage-meter.mjs CHILD_METER_HANDOFF (a test holds them equal). */
const HANDOFF = Symbol.for("pi-dispatch.child-meter");

export default async function childMeter(pi) {
	// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment and inherited, never by the worker.
	const dir = process.env.PI_DISPATCH_CHILD_LEDGER;
	if (typeof dir !== "string" || dir === "") return;
	const state = (globalThis[HANDOFF] ??= { dir });
	let child = null;
	try {
		state.meter ??= await import(new URL("./usage-meter.mjs", import.meta.url).href);
		state.name ??= state.meter.childLedgerName(process.pid);
		let fallbackModels = null;
		try {
			fallbackModels = piAiProviders.builtinModels?.() ?? null;
		} catch {
			// The compat half then sends a builtin model's legacy call to the registry entry; the runtime half is whole.
		}
		child = await state.meter.startChildMeter({ ModelRuntime, compat: { module: piAi, fallbackModels }, env: process.env, dir, name: state.name, state });
	} catch {
		// startChildMeter never throws; an import that failed leaves the preload's stub, which the parent counts.
	}
	// Every session, not only the first: a new, resumed or forked session may come with a runtime of its own.
	pi.on("session_start", (_event, ctx) => {
		try {
			child?.verify(ctx?.modelRegistry?.runtime);
		} catch {
			// verify() never throws; nothing here may fail a session start.
		}
	});
}
