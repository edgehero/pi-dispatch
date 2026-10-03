/**
 * The child preload (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). The runner adds `--import=<this file>` to
 * NODE_OPTIONS (openChildLedger in usage-meter.mjs), so this runs first in EVERY Node process the job starts: npm,
 * the agent's own scripts, and any pi child. It decides whether the process is a pi session and, if so, starts the
 * child's own meter, which reports through a ledger file the parent folds.
 *
 * TOTAL. It never throws and never waits on anything but a local import: a preload that throws kills the Node child
 * it runs in, so every step below is caught, and a failure leaves the child unmetered (which the parent's detector
 * counts) rather than broken. For the same reason it imports no pi module at its top level, and no named export of
 * `node:module`: `registerHooks` is newer than some Node 22 releases, and a static named import of a missing export
 * is a SyntaxError that would kill every Node child.
 *
 * Without PI_DISPATCH_CHILD_LEDGER it does nothing at all, so a process outside a job (or a child whose spawner
 * cleared the environment) runs exactly as it would without it.
 *
 * Two routes, decided once per process:
 *   1. A pi SESSION ENTRY: the realpath of argv[1] is one of the pinned pi's four entries (the bundle CLI, which is the
 *      package bin, the unbundled dist/cli.js, and the two rpc entries). The preload writes the `starting` stub ledger,
 *      inserts `-e <child-meter.ts>` FIRST in the arguments (so the meter loads before every other extension and
 *      before any `--`, after which arguments are messages), and hands usage-meter.mjs over on globalThis. A CLI whose
 *      first argument is one of pi's subcommands gets nothing: pi dispatches those on args[0], and an `-e` in front
 *      turns `pi list` into a chat turn (measured). Flags such as `--version`, `--help`, `--list-models` and `--export`
 *      are injected like any other run: measured, each still does what it says with the meter loaded, and none of them
 *      sends a model call. One that exits before extensions load (`--version`, `--export`) leaves its stub `starting`.
 *   2. ANY OTHER Node process: a load hook (module.registerHooks) watches for pi's unbundled
 *      `dist/core/model-runtime.js`. A process that loads it runs pi as a library (pi-subagents' background runner
 *      does, measured) and never runs the CLI, so it has no `-e`. The hook appends three lines to that module: it
 *      imports the compat copy of pi-ai that module's own package resolves, imports usage-meter.mjs, and hands both and
 *      the class to the library handler below once the class exists. The handler writes the stub and starts the meter
 *      on that class, synchronously, before the module's importer can make a call. A model-runtime.js whose source no
 *      longer carries the two lines the hook relies on is handed over with no class, and the child records itself
 *      unmetered: the floor, not a broken import. Not registered in a pi entry process: route 1 covers it, and the
 *      bundle does not load this file anyway.
 */
import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** usage-meter.mjs CHILD_METER_HANDOFF, spelled again because this file must not import that one at its top. A test holds them equal. */
const HANDOFF = Symbol.for("pi-dispatch.child-meter");

/** The pi subcommands, dispatched on args[0] before any option is parsed (pinned in pinned-api.test.mjs). */
export const PI_SUBCOMMANDS = Object.freeze(["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"]);

/** The four files that run a full pi session, relative to the pi package root, and how each reads its arguments. */
export const PI_ENTRIES = Object.freeze([
	Object.freeze({ path: "dist/bundle/cli.js", kind: "cli" }),
	Object.freeze({ path: "dist/cli.js", kind: "cli" }),
	// The rpc entries prepend `--mode rpc` themselves, so no subcommand can follow: every argument list is a session.
	Object.freeze({ path: "dist/bundle/rpc-entry.js", kind: "rpc" }),
	Object.freeze({ path: "dist/rpc-entry.js", kind: "rpc" }),
]);
const ENTRY_BASENAMES = new Set(PI_ENTRIES.map((entry) => basename(entry.path)));

/** The module the library hook watches for, in any copy of pi-coding-agent. */
export const MODEL_RUNTIME_SUFFIX = "/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";

/** The two lines of the pinned model-runtime.js the appended code relies on: the class, and the catalog import. */
const MODEL_RUNTIME_CLASS = /^export class ModelRuntime \{/m;
const MODEL_RUNTIME_CATALOG = 'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";';

export const CHILD_METER_PATH = fileURLToPath(new URL("./child-meter.ts", import.meta.url));
export const USAGE_METER_URL = new URL("./usage-meter.mjs", import.meta.url).href;

/** The pinned pi package root, resolved from this file's own position (the image's /app/node_modules). */
function defaultPackageDir() {
	return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

/**
 * Which pi entry `argv1` runs: "cli", "rpc", or null. By realpath, so `/app/node_modules/.bin/pi` (a symlink to the
 * bundle) is the bundle. One realpath for every Node child; the package root is resolved only when the file's name is
 * an entry's.
 */
export function entryKind(argv1, { packageDir = defaultPackageDir, realpath = realpathSync } = {}) {
	if (typeof argv1 !== "string" || argv1 === "") return null;
	let real;
	try {
		real = realpath(argv1);
	} catch {
		return null;
	}
	if (!ENTRY_BASENAMES.has(basename(real))) return null;
	let root;
	try {
		root = packageDir();
	} catch {
		return null;
	}
	for (const entry of PI_ENTRIES) {
		try {
			if (realpath(join(root, entry.path)) === real) return entry.kind;
		} catch {
			// An entry this pin does not ship is not one argv1 can be.
		}
	}
	return null;
}

/**
 * Insert `-e <meterPath>` first in a pi entry's arguments (argv[2] on), in place. False, and argv untouched, for a CLI
 * whose first argument is a subcommand. First, not last and not before the first `--`: everything after `--` is a
 * message, and in front of the spawner's own `-e`s is what loads the meter before them (measured in both CLIs).
 */
export function injectChildMeter(argv, kind, meterPath = CHILD_METER_PATH) {
	if (kind === "cli" && PI_SUBCOMMANDS.includes(argv[2])) return false;
	argv.splice(2, 0, "-e", meterPath);
	return true;
}

/**
 * The library hook's rewrite of model-runtime.js: the source with three lines appended. ESM hoists the two imports, and
 * the call runs once the module body has defined the class. The compat specifier resolves from model-runtime.js
 * itself, so it is that package's own pi-ai: the copy pi hands its extensions and builds its streams with.
 */
export function patchModelRuntime(source, usageMeterUrl = USAGE_METER_URL) {
	const handoff = 'globalThis[Symbol.for("pi-dispatch.child-meter")]?.library?.';
	const meter = `import * as __piDispatchUsageMeter from ${JSON.stringify(usageMeterUrl)};`;
	if (!MODEL_RUNTIME_CLASS.test(source) || !source.includes(MODEL_RUNTIME_CATALOG)) {
		return `${source}\n;${meter}\n${handoff}({ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter });\n`;
	}
	return `${source}\n;import * as __piDispatchCompat from "@earendil-works/pi-ai/compat";\n${meter}\n${handoff}({ ModelRuntime, compat: __piDispatchCompat, providers: builtinProviderCatalog, meter: __piDispatchUsageMeter });\n`;
}

/** The load hook: model-runtime.js rewritten, every other module untouched and not even looked at past its URL. */
export function libraryLoadHook(url, context, nextLoad) {
	if (typeof url !== "string" || !url.endsWith(MODEL_RUNTIME_SUFFIX)) return nextLoad(url, context);
	const result = nextLoad(url, context);
	try {
		if (result?.format !== "module" || result.source === null || result.source === undefined) return result;
		const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
		return { ...result, source: patchModelRuntime(source) };
	} catch {
		return result;
	}
}

/** Write the `starting` stub for this process's ledger, once. */
function writeStub(state, meter) {
	if (state.stubbed) return;
	state.stubbed = true;
	try {
		meter.writeFileAtomic({ dir: state.dir, name: state.name, text: JSON.stringify(meter.childLedger({ state: "starting" })) });
	} catch {
		// No stub: the parent's detector sees a pi process with no ledger, which is the unmetered case.
	}
}

/**
 * The preload's work, with everything it touches injected so a test can drive it. Returns what it did: "none" (no
 * ledger directory), "subcommand", "entry" (route 1) or "library" (route 2, the hook registered or not).
 */
export async function preload({
	env = process.env,
	argv = process.argv,
	pid = process.pid,
	global = globalThis,
	packageDir = defaultPackageDir,
	realpath = realpathSync,
	registerHooks = nodeModule.registerHooks,
	importMeter = () => import(USAGE_METER_URL),
} = {}) {
	// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment and inherited, never by the worker.
	const dir = env.PI_DISPATCH_CHILD_LEDGER;
	if (typeof dir !== "string" || dir === "") return "none";
	const kind = entryKind(argv[1], { packageDir, realpath });
	if (kind !== null) {
		if (!injectChildMeter(argv, kind)) return "subcommand";
		const state = (global[HANDOFF] ??= { dir });
		try {
			state.meter ??= await importMeter();
			state.name ??= state.meter.childLedgerName(pid);
			writeStub(state, state.meter);
		} catch {
			// child-meter.ts imports usage-meter.mjs itself when the handoff is empty.
		}
		return "entry";
	}
	const state = (global[HANDOFF] ??= { dir });
	state.library = ({ ModelRuntime, compat, providers, meter }) => {
		try {
			state.meter ??= meter;
			state.name ??= meter.childLedgerName(pid);
			writeStub(state, meter);
			let fallbackModels = null;
			try {
				fallbackModels = providers?.builtinModels?.() ?? null;
			} catch {
				// The compat half then sends a builtin model's legacy call to the registry entry; the runtime half is whole.
			}
			// Not awaited: the install itself runs synchronously before the first await (an injected compat copy is never
			// resolved), so the class is wrapped before this returns into the module that defined it.
			void meter.startChildMeter({ ModelRuntime: typeof ModelRuntime === "function" ? ModelRuntime : null, compat: compat ? { module: compat, fallbackModels } : null, env, dir, name: state.name, state });
		} catch {
			// The stub stays `starting`, which the parent's detector reads as unmetered past its grace.
		}
	};
	if (typeof registerHooks !== "function") return "library";
	try {
		registerHooks({ load: libraryLoadHook });
	} catch {
		// An older Node: a library-mode child is then seen by the parent's detector only.
	}
	return "library";
}

try {
	await preload();
} catch {
	// Total: nothing here may end the process it runs in.
}
