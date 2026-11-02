/**
 * Each host applying what a person asked for (issue #796, `DES-PACKAGE-UPDATES-PREPARED-NOT-APPLIED`).
 *
 * A desired row per package, and each host moves to the newest generation. Never a copied request: those expire, and a queued Adopt followed by an Undo could
 * replay stale. A host that was offline reads only the newest row when it returns, so an Adopt it never saw and the Undo of it become nothing at all.
 *
 * Determinate outcomes are a state on the host's row. A lock held by a peer or a registry that cannot be reached is no state: the host stays pending and tries again.
 */
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { isSubscriptionAdapter } from "./updates-subscription-adapters.mjs";
import { EXACT_VERSION_RE, PACKAGES_SUBDIR, parsePackagesFile, readStageManifest, stagedDirName } from "./packages.mjs";
import { PackageStageError, SERVICE_NPM_TIMEOUT_MS, UNDO_DIR, pruneStagedTrees, serviceNpmEnv, stagePackageTree, stagedStem, treeDigest, withStageLock, writeStageManifest } from "./package-stage.mjs";
import { compareVersions, readApplied, readDesired, writeApplied } from "./updates.mjs";

export { isSubscriptionAdapter };

const writable = (fs, path) => {
	try {
		fs.accessSync(path, nodeFs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * The file's text with one package's entry set or removed, temp and rename. Other entries and their fields stay as they were, so an Adopt of one package
 * and a later Undo of another do not disturb each other: restoring whole-file text would have undone everything since.
 */
function writePackagesEntry({ fs, path, name, entry }) {
	const text = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
	const doc = text === null ? { packages: [] } : JSON.parse(text);
	const rows = Array.isArray(doc.packages) ? doc.packages : [];
	const at = rows.findIndex((row) => row?.name === name);
	if (entry === null && at >= 0) rows.splice(at, 1);
	else if (entry !== null && at >= 0) rows[at] = entry;
	else if (entry !== null) rows.push(entry);
	doc.packages = rows;
	const next = `${JSON.stringify(doc, null, 2)}\n`;
	parsePackagesFile(next, path); // what is about to be written must be a file the stager would take
	const temp = `${path}.${process.pid}.tmp`;
	fs.writeFileSync(temp, next);
	fs.renameSync(temp, path);
}

/** The file's current entry for a package, or `null`. Throws when the file does not parse: the caller reads that as unusable. */
function readPackagesEntry({ fs, path, name }) {
	if (!fs.existsSync(path)) return null;
	const text = fs.readFileSync(path, "utf8");
	parsePackagesFile(text, path);
	const rows = JSON.parse(text).packages ?? [];
	return rows.find((row) => row?.name === name) ?? null;
}

const undoPath = (packagesRoot, name) => join(packagesRoot, UNDO_DIR, `${stagedDirName(name)}.json`);

function readUndo(fs, packagesRoot, name) {
	try {
		return JSON.parse(fs.readFileSync(undoPath(packagesRoot, name), "utf8"));
	} catch {
		return null;
	}
}

function replaceManifestEntry(manifest, name, entry) {
	return { stagedAt: new Date().toISOString(), packages: manifest.packages.map((row) => (row.name === name ? entry : row)) };
}

const npmBinFor = (platform) => (platform === "win32" ? "npm.cmd" : "npm");

/** Apply one desired row on this host. Returns the row to publish; throws `PackageStageError("infra")` to stay pending. */
export async function applyDesired({ desired, env, cwd, fs = nodeFs, exec, now = Date.now, out = () => {}, platform = process.platform, globalPiDir = env.PI_GLOBAL_PI_DIR }) {
	const row = (state, fields = {}) => ({ v: 1, generation: desired.generation, state, at: now(), version: null, reason: null, digest: null, ...fields });
	const refuse = (reason, version = null) => row("cannot-adopt", { reason, version });
	// A host that never took the Adopt being undone has nothing to take back, whichever else is true of it, and that includes having no overlay at all.
	if (!globalPiDir || !fs.existsSync(globalPiDir)) return desired.op === "undo" ? row("no-change") : refuse("no-overlay");
	const packagesRoot = join(globalPiDir, PACKAGES_SUBDIR);
	const manifest = readStageManifest({ globalPiDir, readFile: (p, e) => fs.readFileSync(p, e), fileExists: (p) => fs.existsSync(p) });
	const current = manifest?.packages.find((p) => p.name === desired.name) ?? null;
	const undo = desired.op === "undo" ? readUndo(fs, packagesRoot, desired.name) : null;
	if (desired.op === "undo" && undo?.generation !== desired.undoOf) return row("no-change", { version: current?.version ?? null });
	if (!current) return refuse("not-staged-here");
	if (!writable(fs, packagesRoot)) return refuse("overlay-read-only", current.version);
	if (desired.op === "adopt" && isSubscriptionAdapter(desired.name)) return refuse("adapter", current.version);
	// Never to an older version. A person may have moved past this row with `import-pi` since, and a host may read it again for any number of reasons (a new host, a lost applied key),
	// with nobody looking: "nothing updates by itself" has to hold for a downgrade too. Going back is what Undo is for.
	if (desired.op === "adopt" && compareVersions(current.version, desired.version) >= 0) return row("no-change", { version: current.version });
	if (!EXACT_VERSION_RE.test(desired.version)) return refuse("stage-refused", current.version);
	const packagesFile = env.PI_PACKAGES_FILE ?? join(cwd, "pi-packages.json");
	try {
		readPackagesEntry({ fs, path: packagesFile, name: desired.name });
		// The file is replaced by temp and rename, so what has to be writable is its directory, whether or not the file itself is.
		if (!writable(fs, dirname(packagesFile)) || (fs.existsSync(packagesFile) && !writable(fs, packagesFile))) throw new Error("not writable");
	} catch {
		return refuse("packages-file-unusable", current.version);
	}

	return await withStageLock({ fs, packagesRoot, now, holder: "updates-reconcile" }, async ({ stillHeld }) => {
		const committing = () => { if (!stillHeld()) throw new PackageStageError("infra", "another stage took over this overlay's lock"); };
		// Read again under the lock: a peer on a shared home may have applied this very row while we waited. It shares this manifest, and doing it twice
		// would lose the record of what to undo.
		const fresh = readStageManifest({ globalPiDir, readFile: (p, e) => fs.readFileSync(p, e), fileExists: (p) => fs.existsSync(p) });
		const here = fresh?.packages.find((p) => p.name === desired.name) ?? null;
		if (!here) return refuse("not-staged-here");
		const stageOptions = { fs, exec, out, packagesRoot, npmBin: npmBinFor(platform), platform, timeoutMs: SERVICE_NPM_TIMEOUT_MS, env: serviceNpmEnv(env) };
		const stageIt = async (entry) => {
			try {
				return { ...(await stagePackageTree({ ...stageOptions, entry })) };
			} catch (error) {
				if (error instanceof PackageStageError && error.kind === "not-found") return { refused: "version-not-found" };
				if (error instanceof PackageStageError && error.kind === "policy") return { refused: "stage-refused" };
				throw error instanceof PackageStageError ? error : new PackageStageError("infra", "the stage could not finish");
			}
		};

		if (desired.op === "undo") {
			const prior = undo.manifestEntry;
			let dir = prior.dir;
			// The old tree is kept for a week, and flipping back to it is what makes Undo instant. Past that it is staged again, at the exact version.
			if (!fs.existsSync(join(packagesRoot, dir))) {
				const staged = await stageIt({ name: prior.name, version: prior.version, dir: stagedStem(prior.dir) });
				if (staged.refused) return refuse(staged.refused, here.version);
				dir = staged.dir;
			}
			const manifest2 = replaceManifestEntry(fresh, desired.name, { ...prior, dir });
			committing();
			writePackagesEntry({ fs, path: packagesFile, name: desired.name, entry: undo.fileEntry });
			writeStageManifest({ fs, packagesRoot, manifest: manifest2 });
			fs.rmSync(undoPath(packagesRoot, desired.name), { force: true });
			pruneStagedTrees({ fs, packagesRoot, manifest: manifest2, now });
			return row("undone", { version: prior.version, digest: await treeDigest(join(packagesRoot, dir), { fs }) });
		}

		if (compareVersions(here.version, desired.version) >= 0) return row("no-change", { version: here.version });
		const staged = await stageIt({ name: desired.name, version: desired.version, dir: stagedStem(here.dir) });
		if (staged.refused) return refuse(staged.refused, here.version);
		const removeUnnamed = () => { try { fs.rmSync(join(packagesRoot, staged.dir), { recursive: true, force: true }); } catch { /* the prune's, later */ } };
		try {
			const digest = await treeDigest(join(packagesRoot, staged.dir), { fs });
			// Read under the lock, and kept if a previous attempt at this very generation already recorded it: that attempt may have written the pin before its manifest failed, and reading
			// the file now would record the adopted pin as what came before it, so that Undo restored the wrong thing.
			const earlier = readUndo(fs, packagesRoot, desired.name);
			const priorEntry = earlier?.generation === desired.generation ? earlier.fileEntry : readPackagesEntry({ fs, path: packagesFile, name: desired.name });
			const priorManifest = earlier?.generation === desired.generation ? earlier.manifestEntry : here;
			committing();
			// The undo record first, the pin second and the manifest last, so a crash leaves at worst a pin the next stage honours, and jobs still on the old set.
			fs.mkdirSync(join(packagesRoot, UNDO_DIR), { recursive: true });
			fs.writeFileSync(undoPath(packagesRoot, desired.name), `${JSON.stringify({ generation: desired.generation, manifestEntry: priorManifest, fileEntry: priorEntry })}\n`);
			writePackagesEntry({ fs, path: packagesFile, name: desired.name, entry: { ...(priorEntry ?? { name: desired.name }), version: desired.version } });
			const manifest2 = replaceManifestEntry(fresh, desired.name, { ...here, version: desired.version, dir: staged.dir });
			writeStageManifest({ fs, packagesRoot, manifest: manifest2 });
			pruneStagedTrees({ fs, packagesRoot, manifest: manifest2, now });
			return row("adopted", { version: desired.version, digest });
		} catch (error) {
			// Nothing names this tree yet, and each retry would leave one more.
			removeUnnamed();
			throw error instanceof PackageStageError ? error : new PackageStageError("infra", "the stage could not commit");
		}
	});
}

/** One pass on this host: every row newer than what it applied, oldest first, one failure not stopping the rest. Returns a count of what happened, names only. */
export async function reconcileUpdates({ redis, host, env, cwd, fs = nodeFs, exec, now = Date.now, log = () => {}, platform = process.platform }) {
	const desired = await readDesired(redis);
	const applied = desired === null ? null : await readApplied(redis, host);
	if (!desired || !applied) return { unreachable: true };
	const done = { applied: 0, pending: 0 };
	for (const row of desired) {
		if ((applied[row.name]?.generation ?? 0) >= row.generation) continue;
		try {
			const result = await applyDesired({ desired: row, env, cwd, fs, exec, now, platform });
			await writeApplied(redis, host, row.name, result);
			done.applied += 1;
			log("updates_applied", { package: row.name, generation: row.generation, state: result.state, reason: result.reason });
		} catch (error) {
			done.pending += 1;
			log("updates_pending", { package: row.name, generation: row.generation, kind: error instanceof PackageStageError ? error.kind : "infra" });
		}
	}
	return done;
}
