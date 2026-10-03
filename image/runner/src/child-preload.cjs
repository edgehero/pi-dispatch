/**
 * The child preload (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). The runner adds `--require=<this file>` to
 * NODE_OPTIONS (openChildLedger in usage-meter.mjs), so this runs first in EVERY Node process the job starts: npm,
 * the agent's own scripts, and any pi child. It decides whether the process is a pi session and, if so, starts the
 * child's own meter, which reports through a ledger file the parent folds.
 *
 * COMMONJS, LOADED WITH --require. Every Node accepts `--require` in NODE_OPTIONS; Node older than 18.18 refuses
 * `--import` there and would not start at all, so an ESM preload broke a job's legacy Node (measured on 16.20). All of
 * the work below is synchronous anyway.
 *
 * TOTAL. It never throws and never waits on anything: a preload that throws kills the Node child it runs in, so every
 * step below is caught, and a failure leaves the child unmetered (which the parent's detector counts) rather than
 * broken. It loads no pi module, and usage-meter.mjs only in a process that is a pi session. `registerHooks` is read
 * off `node:module` and called only where it exists.
 *
 * Without PI_DISPATCH_CHILD_LEDGER it does nothing at all, so a process outside a job (or a child whose spawner
 * cleared the environment) runs exactly as it would without it.
 *
 * Two routes, decided once per process:
 *   1. A pi SESSION ENTRY: the realpath of argv[1] is one of the pinned pi's five session entries (the bundle CLI, which
 *      is the package bin, the bundle's cli-runtime.js it loads, the unbundled dist/cli.js, and the two rpc entries).
 *      The preload writes the `starting` stub ledger, inserts `-e <child-meter.ts>` FIRST in the arguments (so the
 *      meter loads before every other extension and before any `--`, after which arguments are messages), and hands
 *      usage-meter.mjs over on globalThis. A CLI whose first argument is one of pi's subcommands gets nothing: pi
 *      dispatches those on args[0], and an `-e` in front turns `pi list` into a chat turn (measured). `--version` and
 *      `--export` exit before any extension loads, so the meter never starts; an exit handler marks such a stub `done`
 *      (zeros) rather than leave it `starting` for good. Every other flag is injected like any run (measured).
 *   2. ANY OTHER Node process, where `module.registerHooks` exists: a load hook. Its fast path is one substring test of
 *      the module URL, so a CommonJS-heavy tool pays for the hook and nothing more. Two things it acts on:
 *      - pi's unbundled `dist/core/model-runtime.js`, in any copy of pi, matched on the URL's PATH (a `?query` or
 *        `#hash` cannot dodge it). A process that loads it runs pi as a library (pi-subagents' background runner does,
 *        measured). The hook appends three lines: an import of the compat copy of pi-ai that module's own package
 *        resolves, an import of usage-meter.mjs, and a call that hands both and the class to the library handler. The
 *        handler starts the meter on that class synchronously, and the ledger is written when the first call is about
 *        to go out (a process that never calls leaves no file). A `model-runtime.js` whose source no longer carries
 *        the two lines the rewrite names, or whose pi-ai has no `./compat` export, is not patched with that import: it
 *        is handed over with no class, and the process records itself unmetered (the floor), never a broken import.
 *      - any file under the PINNED pi's `dist/bundle/`. The bundle defines its own ModelRuntime in a hashed chunk the
 *        hook cannot name, and a process that imports the bundle by path (its index exports `main`) runs a full session
 *        no `-e` reached. It cannot be metered, so it says so: one `metered: false` ledger.
 */
"use strict";

const { existsSync, readFileSync, realpathSync } = require("node:fs");
const nodeModule = require("node:module");
const { basename, dirname, join, sep } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

/** usage-meter.mjs CHILD_METER_HANDOFF, spelled again because this file does not load that one up front. A test holds them equal. */
const HANDOFF = Symbol.for("pi-dispatch.child-meter");

/** The pi subcommands, dispatched on args[0] before any option is parsed (pinned in pinned-api.test.mjs). */
const PI_SUBCOMMANDS = Object.freeze(["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"]);

/** The flags with which pi exits before it loads any extension: the meter never starts, and nothing is spent. */
const EXITS_BEFORE_EXTENSIONS = Object.freeze(["--version", "-v", "--export"]);

/** The files that run a full pi session, relative to the pi package root, and how each reads its arguments. */
const PI_ENTRIES = Object.freeze([
	Object.freeze({ path: "dist/bundle/cli.js", kind: "cli" }),
	// cli.js only loads this one, where setupCli and main live; run directly it is the same CLI.
	Object.freeze({ path: "dist/bundle/cli-runtime.js", kind: "cli" }),
	Object.freeze({ path: "dist/cli.js", kind: "cli" }),
	// The rpc entries prepend `--mode rpc` themselves, so no subcommand can follow: every argument list is a session.
	Object.freeze({ path: "dist/bundle/rpc-entry.js", kind: "rpc" }),
	Object.freeze({ path: "dist/rpc-entry.js", kind: "rpc" }),
]);
const ENTRY_BASENAMES = new Set(PI_ENTRIES.map((entry) => basename(entry.path)));

/** The module the library hook watches for, in any copy of pi-coding-agent. */
const MODEL_RUNTIME_SUFFIX = "/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
/** The hook's fast path: a module whose URL does not contain this is passed through untouched. */
const PI_DIST_MARK = "/pi-coding-agent/dist/";

/** The two lines of the pinned model-runtime.js the appended code relies on: the class, and the catalog import. */
const MODEL_RUNTIME_CLASS = /^export class ModelRuntime \{/m;
const MODEL_RUNTIME_CATALOG = 'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";';

const CHILD_METER_PATH = join(__dirname, "child-meter.ts");
const USAGE_METER_PATH = join(__dirname, "usage-meter.mjs");
const USAGE_METER_URL = pathToFileURL(USAGE_METER_PATH).href;

let packageDirCache;
/**
 * The pinned pi package root, found the way Node would resolve it from this file (the image's /app/node_modules), by
 * realpath. A walk rather than require.resolve: the package exports only an `import` condition.
 */
function defaultPackageDir() {
	if (packageDirCache !== undefined) return packageDirCache;
	for (let dir = __dirname; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		if (existsSync(join(candidate, "package.json"))) return (packageDirCache = realpathSync(candidate));
		if (dirname(dir) === dir) throw new Error("pi-coding-agent not found");
	}
}

/**
 * Which pi entry `argv1` runs: "cli", "rpc", or null. By realpath, so `/app/node_modules/.bin/pi` (a symlink to the
 * bundle) is the bundle. One realpath for every Node child; the package root is resolved only when the file's name is
 * an entry's.
 */
function entryKind(argv1, { packageDir = defaultPackageDir, realpath = realpathSync } = {}) {
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
function injectChildMeter(argv, kind, meterPath = CHILD_METER_PATH) {
	if (kind === "cli" && PI_SUBCOMMANDS.includes(argv[2])) return false;
	argv.splice(2, 0, "-e", meterPath);
	return true;
}

/** Whether pi's own arguments (before any `--`) carry a flag that exits before extensions load. */
function exitsBeforeExtensions(args) {
	const end = args.indexOf("--");
	return (end === -1 ? args : args.slice(0, end)).some((arg) => EXITS_BEFORE_EXTENSIONS.includes(arg));
}

/** A module URL without its query and hash. */
function urlPath(url) {
	const cut = url.search(/[?#]/);
	return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Whether `@earendil-works/pi-ai` as resolved from `url` exports `./compat`, the one import the rewrite adds that is not
 * this repository's own file. False when it cannot be told (no module.findPackageJSON, an unreadable package.json):
 * the rewrite then hands over no class, because an import that fails to link would kill the process.
 */
function compatResolvesFrom(url, { findPackageJSON = nodeModule.findPackageJSON, read = (path) => readFileSync(path, "utf8") } = {}) {
	try {
		if (typeof findPackageJSON !== "function") return false;
		const manifest = findPackageJSON("@earendil-works/pi-ai", url);
		if (typeof manifest !== "string") return false;
		const exportsMap = JSON.parse(read(manifest))?.exports;
		return exportsMap !== null && typeof exportsMap === "object" && Object.hasOwn(exportsMap, "./compat");
	} catch {
		return false;
	}
}

/**
 * The library hook's rewrite of model-runtime.js: the source with three lines appended. ESM hoists the two imports, and
 * the call runs once the module body has defined the class. The compat specifier resolves from model-runtime.js
 * itself, so it is that package's own pi-ai: the copy pi hands its extensions and builds its streams with. With
 * `compat` false, or a source that does not carry the two lines, the class is not handed over.
 */
function patchModelRuntime(source, { compat = true, usageMeterUrl = USAGE_METER_URL } = {}) {
	const handoff = 'globalThis[Symbol.for("pi-dispatch.child-meter")]?.library?.';
	const meter = `import * as __piDispatchUsageMeter from ${JSON.stringify(usageMeterUrl)};`;
	if (!compat || !MODEL_RUNTIME_CLASS.test(source) || !source.includes(MODEL_RUNTIME_CATALOG)) {
		return `${source}\n;${meter}\n${handoff}({ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter });\n`;
	}
	return `${source}\n;import * as __piDispatchCompat from "@earendil-works/pi-ai/compat";\n${meter}\n${handoff}({ ModelRuntime, compat: __piDispatchCompat, providers: builtinProviderCatalog, meter: __piDispatchUsageMeter });\n`;
}

/**
 * The load hook, built over its collaborators so a test can drive it. Every module whose URL does not name a
 * pi-coding-agent dist file passes straight through.
 */
function makeLibraryLoadHook({ packageDir = defaultPackageDir, onBundle = () => {}, compatResolves = compatResolvesFrom } = {}) {
	let bundlePrefix;
	return function libraryLoadHook(url, context, nextLoad) {
		if (typeof url !== "string" || !url.includes(PI_DIST_MARK)) return nextLoad(url, context);
		const result = nextLoad(url, context);
		try {
			const path = urlPath(url);
			if (path.endsWith(MODEL_RUNTIME_SUFFIX)) {
				if (result?.format !== "module" || result.source === null || result.source === undefined) return result;
				const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
				return { ...result, source: patchModelRuntime(source, { compat: compatResolves(url) }) };
			}
			if (bundlePrefix === undefined) bundlePrefix = `${packageDir()}${sep}dist${sep}bundle${sep}`;
			if (path.startsWith("file:") && fileURLToPath(path).startsWith(bundlePrefix)) onBundle();
		} catch {
			// The module as pi shipped it.
		}
		return result;
	};
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
 * The preload's work, with everything it touches injected so a test can drive it. Synchronous. Returns what it did:
 * "none" (no ledger directory), "subcommand", "entry" (route 1) or "library" (route 2, the hook registered or not).
 */
function preload({
	env = process.env,
	argv = process.argv,
	pid = process.pid,
	global = globalThis,
	packageDir = defaultPackageDir,
	realpath = realpathSync,
	registerHooks = nodeModule.registerHooks,
	loadMeter = () => require(USAGE_METER_PATH),
	onExit = (listener) => process.on("exit", listener),
} = {}) {
	// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment and inherited, never by the worker.
	const dir = env.PI_DISPATCH_CHILD_LEDGER;
	if (typeof dir !== "string" || dir === "") return "none";
	const kind = entryKind(argv[1], { packageDir, realpath });
	if (kind !== null) {
		const quick = exitsBeforeExtensions(argv.slice(2));
		if (!injectChildMeter(argv, kind)) return "subcommand";
		const state = (global[HANDOFF] ??= { dir });
		try {
			// An ES module loaded with require: usage-meter.mjs has no top-level await. A Node too old for that cannot run pi either.
			state.meter ??= loadMeter();
			state.name ??= state.meter.childLedgerName(pid);
			writeStub(state, state.meter);
			// `--version` and `--export` exit before the meter can start, having spent nothing: their stub ends `done`.
			if (quick) {
				onExit(() => {
					try {
						if (state.child === undefined) state.meter.writeFileAtomic({ dir, name: state.name, text: JSON.stringify(state.meter.childLedger({ state: "done" })) });
					} catch {
						// The stub stays `starting`.
					}
				});
			}
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
			let fallbackModels = null;
			try {
				fallbackModels = providers?.builtinModels?.() ?? null;
			} catch {
				// The compat half then sends a builtin model's legacy call to the registry entry; the runtime half is whole.
			}
			// Not awaited: the install itself runs synchronously before the first await (an injected compat copy is never
			// resolved), so the class is wrapped before this returns into the module that defined it. Lazy: the file is
			// written when the first call is about to go out.
			void meter.startChildMeter({ ModelRuntime: typeof ModelRuntime === "function" ? ModelRuntime : null, compat: compat ? { module: compat, fallbackModels } : null, env, dir, name: state.name, lazy: true, state });
		} catch {
			// Nothing written: the parent's detector is what sees this process.
		}
	};
	// The bundle loaded by path in a process no `-e` reached: unmeterable, said once, after the module that loaded it.
	const onBundle = () => {
		if (state.bundle) return;
		state.bundle = true;
		queueMicrotask(() => {
			try {
				const meter = (state.meter ??= loadMeter());
				state.name ??= meter.childLedgerName(pid);
				void meter.startChildMeter({ ModelRuntime: null, compat: null, env, dir, name: state.name, state });
			} catch {
				// Nothing written: the parent's detector is what sees this process.
			}
		});
	};
	if (typeof registerHooks !== "function") return "library";
	try {
		registerHooks({ load: makeLibraryLoadHook({ packageDir, onBundle }) });
	} catch {
		// An older Node: a library-mode child is then seen by the parent's detector only.
	}
	return "library";
}

module.exports = {
	CHILD_METER_PATH,
	compatResolvesFrom,
	entryKind,
	exitsBeforeExtensions,
	injectChildMeter,
	makeLibraryLoadHook,
	MODEL_RUNTIME_SUFFIX,
	patchModelRuntime,
	PI_ENTRIES,
	PI_SUBCOMMANDS,
	preload,
	USAGE_METER_PATH,
	USAGE_METER_URL,
};

try {
	preload();
} catch {
	// Total: nothing here may end the process it runs in.
}
