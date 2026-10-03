/**
 * The child preload (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). The runner adds `--import=<this file>` to
 * NODE_OPTIONS (openChildLedger in usage-meter.mjs), so this runs first in EVERY Node process the job starts: npm,
 * the agent's own scripts, and any pi child. It decides whether the process is a pi session and, if so, starts the
 * child's own meter, which reports through a ledger file the parent folds.
 *
 * AN ES MODULE, LOADED WITH --import. A load hook registered from a `--require` preload breaks every Node child that
 * then uses asynchronous loader hooks (`module.register`, `--loader`: ts-node/esm, tsx, yarn PnP, import-in-the-middle)
 * with `loadSync is not a function`, measured on 22.19, 22.23 and 23.5; registered from `--import` they coexist. The
 * price: a Node older than 18.19 refuses `--import` in NODE_OPTIONS and does not start at all (a named residual; an
 * agent that installs such a Node in a job must drop NODE_OPTIONS for it).
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
 *   1. A pi SESSION ENTRY, or a nested runner (below): the realpath of argv[1] is one of the pinned pi's five session entries (the bundle CLI, which
 *      is the package bin, the bundle's cli-runtime.js it loads, the unbundled dist/cli.js, and the two rpc entries).
 *      The preload writes the `starting` stub ledger, inserts `-e <child-meter.ts>` FIRST in the arguments (so the
 *      meter loads before every other extension and before any `--`, after which arguments are messages), and hands
 *      usage-meter.mjs over on globalThis. A CLI whose first argument is one of pi's subcommands gets no `-e`: pi
 *      dispatches those on args[0], and an `-e` in front turns `pi list` into a chat turn (measured). It gets a ledger
 *      written `done` with zeros instead, so the parent's detector, which reads only `pi` off its command line once
 *      setupCli ran, finds a ledger for its pid. `--version` and
 *      `--export` exit before any extension loads, so the meter never starts; an exit handler marks such a stub `done`
 *      (zeros) rather than leave it `starting` for good. Every other flag is injected like any run (measured).
 *      A NESTED RUNNER takes this route too (child-route.mjs nestedRunnerKind: argv[1] is this image's run-job.mjs and
 *      PI_DISPATCH_RUNNER_PID is another process's): it runs as the pi CLI, so it gets the CLI's stub and `-e`, and no
 *      library hook. With the hook as well, the runner's own import of pi would start a second, lazy install of the
 *      meter before the extension's (one meter per process is the rule), and a nested runner that never calls would
 *      leave its stub `starting` for good.
 *   2. ANY OTHER Node process (or worker thread), where `module.registerHooks` exists: a RESOLVE hook. Its fast path is
 *      one substring test of the resolved URL. A resolve hook, not a load hook: a load hook, even one that only passes
 *      through, breaks `node --import tsx` (measured on 22.19 and 23.5: tsx's own load chain then fails validation),
 *      and a resolve hook coexists with tsx, `module.register` and `--loader`. Two things it acts on:
 *      - pi's unbundled `dist/core/model-runtime.js`, in any copy of pi, matched on the resolved URL's PATH (a `?query`
 *        or `#hash` cannot dodge it). A process that loads it runs pi as a library (pi-subagents' background runner
 *        does, measured). Every import of it resolves instead to a small wrapper module (wrapperSource): the wrapper
 *        imports the real module (one instance, under a marker query), re-exports all of it, imports the compat copy
 *        of pi-ai and the provider catalog that module's own package resolves, and usage-meter.mjs, and hands them and
 *        the class to the library handler before any importer runs. The handler starts the meter on that class, and
 *        the ledger is written when the first call is about to go out (a process that never calls leaves no file). A
 *        `model-runtime.js` that no longer declares the class, or whose pi-ai cannot be resolved with `./compat` and
 *        `./providers/all`, is handed over with no class, and the process records itself unmetered (the floor), never
 *        a broken import.
 *      - any file under the PINNED pi's `dist/bundle/`. The bundle defines its own ModelRuntime in a hashed chunk the
 *        hook cannot name, and a process that imports the bundle by path (its index exports `main`) runs a full session
 *        no `-e` reached. It cannot be metered, so it says so: one `metered: false` ledger. Never in a worker thread:
 *        a metered pi CLI runs its image resize and codemode workers from bundle chunks, and the preload runs again in
 *        each of them, where argv[1] is still the entry the main thread already metered.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { CHILD_METER_PATH, injectChildMeter, ledgerDirProblem, nestedRunnerKind, PI_ENTRIES, PI_SUBCOMMANDS } from "./child-route.mjs";

export { CHILD_METER_PATH, injectChildMeter, PI_ENTRIES, PI_SUBCOMMANDS };

/** usage-meter.mjs CHILD_METER_HANDOFF, spelled again because this file does not load that one up front. A test holds them equal. */
const HANDOFF = Symbol.for("pi-dispatch.child-meter");

/** The flags with which pi exits before it loads any extension: the meter never starts, and nothing is spent. */
const EXITS_BEFORE_EXTENSIONS = Object.freeze(["--version", "-v", "--export"]);

const ENTRY_BASENAMES = new Set(PI_ENTRIES.map((entry) => basename(entry.path)));

/** The module the library hook watches for, in any copy of pi-coding-agent. */
export const MODEL_RUNTIME_SUFFIX = "/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
/** The hook's fast path: a module whose URL does not contain this is passed through untouched. */
const PI_DIST_MARK = "/pi-coding-agent/dist/";

/** The line of the pinned model-runtime.js the wrapper relies on: the class it hands over. */
const MODEL_RUNTIME_CLASS = /^export class ModelRuntime \{/m;
/** The query the wrapper imports the real model-runtime.js under, so resolving it again is not wrapped again. */
const REAL_MARK = "pi-dispatch-real=1";

const HERE = dirname(fileURLToPath(import.meta.url));
export const USAGE_METER_PATH = join(HERE, "usage-meter.mjs");
export const USAGE_METER_URL = pathToFileURL(USAGE_METER_PATH).href;

let packageDirCache;
/**
 * The pinned pi package root, found the way Node would resolve it from this file (the image's /app/node_modules), by
 * realpath. A walk rather than require.resolve: the package exports only an `import` condition.
 */
function defaultPackageDir() {
	if (packageDirCache !== undefined) return packageDirCache;
	for (let dir = HERE; ; dir = dirname(dir)) {
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

/** Whether pi's own arguments (before any `--`) carry a flag that exits before extensions load. */
export function exitsBeforeExtensions(args) {
	const end = args.indexOf("--");
	return (end === -1 ? args : args.slice(0, end)).some((arg) => EXITS_BEFORE_EXTENSIONS.includes(arg));
}

/** A module URL without its query and hash. */
function urlPath(url) {
	const cut = url.search(/[?#]/);
	return cut === -1 ? url : url.slice(0, cut);
}

/**
 * The wrapper module every import of model-runtime.js resolves to. Absolute URLs only (it is a data: module). The real
 * module is imported once, under REAL_MARK, and fully evaluated before the wrapper's body hands its class over, which is
 * before any importer of the wrapper runs. With `compatUrl` or `providersUrl` null the class is not handed over.
 */
export function wrapperSource({ realUrl, compatUrl, providersUrl, usageMeterUrl = USAGE_METER_URL }) {
	const handoff = 'globalThis[Symbol.for("pi-dispatch.child-meter")]?.library?.';
	const lines = [
		`import * as __piDispatchReal from ${JSON.stringify(realUrl)};`,
		`import * as __piDispatchUsageMeter from ${JSON.stringify(usageMeterUrl)};`,
		`export * from ${JSON.stringify(realUrl)};`,
	];
	if (compatUrl === null || providersUrl === null) {
		lines.push(`${handoff}({ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter });`);
	} else {
		lines.push(`import * as __piDispatchCompat from ${JSON.stringify(compatUrl)};`, `import * as __piDispatchProviders from ${JSON.stringify(providersUrl)};`);
		lines.push(`${handoff}({ ModelRuntime: __piDispatchReal.ModelRuntime, compat: __piDispatchCompat, providers: __piDispatchProviders, meter: __piDispatchUsageMeter });`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * The resolve hook, built over its collaborators so a test can drive it. Every resolution whose URL does not name a
 * pi-coding-agent dist file passes straight through.
 */
export function makeLibraryResolveHook({ packageDir = defaultPackageDir, onBundle = () => {}, readSource = (url) => readFileSync(new URL(url), "utf8") } = {}) {
	let bundlePrefix;
	return function libraryResolveHook(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		const url = result?.url;
		if (typeof url !== "string" || !url.includes(PI_DIST_MARK)) return result;
		try {
			const path = urlPath(url);
			if (path.endsWith(MODEL_RUNTIME_SUFFIX)) {
				if (url.includes(REAL_MARK)) return result;
				const realUrl = `${url}${url.includes("?") ? "&" : "?"}${REAL_MARK}`;
				let compatUrl = null;
				let providersUrl = null;
				try {
					if (MODEL_RUNTIME_CLASS.test(readSource(path))) {
						compatUrl = nextResolve("@earendil-works/pi-ai/compat", { ...context, parentURL: path }).url;
						providersUrl = nextResolve("@earendil-works/pi-ai/providers/all", { ...context, parentURL: path }).url;
					}
				} catch {
					compatUrl = null;
					providersUrl = null;
				}
				return { url: `data:text/javascript,${encodeURIComponent(wrapperSource({ realUrl, compatUrl, providersUrl }))}`, format: "module", shortCircuit: true };
			}
			if (bundlePrefix === undefined) bundlePrefix = `${packageDir()}${sep}dist${sep}bundle${sep}`;
			if (path.startsWith("file:") && fileURLToPath(path).startsWith(bundlePrefix)) onBundle();
		} catch {
			// Resolved as pi shipped it.
		}
		return result;
	};
}

/**
 * Write the `starting` stub for this process's ledger, once. Not into a directory the nested runner would refuse
 * (ledgerDirProblem: a link, not a directory, not writable): a nested runner exits 2 on such a directory before its
 * meter starts, and a stub written through a link would stay `starting` for good in whatever the link names.
 */
function writeStub(state, meter, ledgerState = "starting") {
	if (state.stubbed) return;
	state.stubbed = true;
	if (ledgerDirProblem(state.dir) !== null) return;
	try {
		meter.writeFileAtomic({ dir: state.dir, name: state.name, text: JSON.stringify(meter.childLedger({ state: ledgerState })) });
	} catch {
		// No stub: the parent's detector sees a pi process with no ledger, which is the unmetered case.
	}
}

/**
 * The preload's work, with everything it touches injected so a test can drive it. Returns what it did:
 * "none" (no ledger directory), "subcommand", "entry" (route 1) or "library" (route 2, the hook registered or not).
 */
export async function preload({
	env = process.env,
	argv = process.argv,
	pid = process.pid,
	global = globalThis,
	packageDir = defaultPackageDir,
	realpath = realpathSync,
	registerHooks = nodeModule.registerHooks,
	isMain = isMainThread,
	loadMeter = () => import(USAGE_METER_URL),
	onExit = (listener) => process.on("exit", listener),
} = {}) {
	// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment and inherited, never by the worker.
	const dir = env.PI_DISPATCH_CHILD_LEDGER;
	if (typeof dir !== "string" || dir === "") return "none";
	// A nested runner (child-route.mjs) takes a pi CLI's route: it is about to run as one.
	const kind = entryKind(argv[1], { packageDir, realpath }) ?? nestedRunnerKind(argv[1], { env, pid, realpath });
	if (kind !== null) {
		const quick = exitsBeforeExtensions(argv.slice(2));
		const subcommand = !injectChildMeter(argv, kind);
		const state = (global[HANDOFF] ??= { dir });
		try {
			state.meter ??= await loadMeter();
			state.name ??= state.meter.childLedgerName(pid);
			// A subcommand loads no extension and calls no model, but it is a pi process: once setupCli has set its title
			// its command line reads `pi` and nothing more, so the parent's detector cannot tell `pi list` from a session.
			// Its ledger is written `done` with zeros at once, so the detector finds a ledger for its pid (issue #500 part E).
			if (subcommand) {
				writeStub(state, state.meter, "done");
				return "subcommand";
			}
			writeStub(state, state.meter);
			// `--version` and `--export` exit before the meter can start, having spent nothing: their stub ends `done`.
			if (quick) {
				onExit(() => {
					try {
						if (state.child === undefined && ledgerDirProblem(dir) === null) state.meter.writeFileAtomic({ dir, name: state.name, text: JSON.stringify(state.meter.childLedger({ state: "done" })) });
					} catch {
						// The stub stays `starting`.
					}
				});
			}
		} catch {
			// child-meter.ts imports usage-meter.mjs itself when the handoff is empty.
		}
		return subcommand ? "subcommand" : "entry";
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
		// Not in a worker thread: a metered pi CLI's own workers (image resize, codemode) run from bundle chunks.
		if (state.bundle || !isMain) return;
		state.bundle = true;
		queueMicrotask(async () => {
			try {
				const meter = (state.meter ??= await loadMeter());
				state.name ??= meter.childLedgerName(pid);
				void meter.startChildMeter({ ModelRuntime: null, compat: null, env, dir, name: state.name, state });
			} catch {
				// Nothing written: the parent's detector is what sees this process.
			}
		});
	};
	if (typeof registerHooks !== "function") return "library";
	try {
		registerHooks({ resolve: makeLibraryResolveHook({ packageDir, onBundle }) });
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
